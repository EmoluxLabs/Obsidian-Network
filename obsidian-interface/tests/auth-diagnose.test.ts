/**
 * The read-only sign-in diagnosis (scripts/auth-diagnose.mjs).
 *
 * Runs the real script, as a child process, against a synthetic accounts file built with plain Node scrypt (nothing from
 * the code under test). The file is never modified, the answers never contain a secret, and a wrong password, a missing
 * account, a damaged hash and an MFA-enabled account are each told apart.
 */
import { spawnSync } from 'node:child_process';
import { scryptSync } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '..', 'scripts', 'auth-diagnose.mjs');
const PASSWORD = 'diag-Synthetic-Passw0rd';
const SALT = 'a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8';
const HASH = `scrypt$32768$8$1$${SALT}$${scryptSync(PASSWORD.normalize('NFKC'), Buffer.from(SALT, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }).toString('hex')}`;

const dirs: string[] = [];
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function storeWith(account: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-diag-'));
  dirs.push(dir);
  writeFileSync(
    join(dir, 'interface-accounts.json'),
    JSON.stringify({
      version: 2,
      accounts: [{ accountId: 'abcdef0123456789', email: 'Diag.Tester+x@Gmail.com', canonicalEmail: 'diagtester@gmail.com', passwordHash: HASH, mfaEnabled: false, ...account }],
      invites: [],
      sessions: [],
      genesisInvite: { hash: 'scrypt$1$1$1$00$00', redeemedBy: 'abcdef0123456789' },
    }),
    { mode: 0o600 },
  );
  return dir;
}

function run(dir: string, extra: string[], password?: string) {
  const env = { ...process.env } as Record<string, string | undefined>;
  delete env.OBSIDIAN_DIAG_PASSWORD;
  if (password !== undefined) env.OBSIDIAN_DIAG_PASSWORD = password;
  const result = spawnSync(process.execPath, [SCRIPT, '--data-dir', dir, ...extra], { encoding: 'utf8', env, timeout: 60_000 });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('auth-diagnose', () => {
  it('right password: every check passes; the file is untouched; no secret is printed', () => {
    const dir = storeWith({});
    const file = join(dir, 'interface-accounts.json');
    const before = { text: readFileSync(file, 'utf8'), mtime: statSync(file).mtimeMs, names: readdirSync(dir) };
    const { code, out } = run(dir, ['--email', ' DIAG.TESTER@googlemail.com ', '--check-password'], PASSWORD);
    expect(out).toContain('PASS  the typed password matches the stored hash');
    expect(code).toBe(0);
    expect(out).toContain('scrypt N=32768 r=8 p=1, salt 16 bytes, key 32 bytes');
    for (const secret of [PASSWORD, HASH, SALT, HASH.split('$')[5]!]) expect(out).not.toContain(secret);
    expect(out).not.toContain('Diag.Tester'); // the address is masked
    expect(readFileSync(file, 'utf8')).toBe(before.text);
    expect(statSync(file).mtimeMs).toBe(before.mtime);
    expect(readdirSync(dir)).toEqual(before.names);
  });

  it('wrong password: FAIL, exit 1, and says what to check — still no secret', () => {
    const { code, out } = run(storeWith({}), ['--email', 'diagtester@gmail.com', '--check-password'], `${PASSWORD} `);
    expect(code).toBe(1);
    expect(out).toContain('FAIL  the typed password matches the stored hash');
    expect(out).toContain('leading or trailing whitespace');
    expect(out).not.toContain(PASSWORD);
  });

  it('an address that is not Gmail, or has no account, is called out as the reason for a 401', () => {
    const dir = storeWith({});
    expect(run(dir, ['--email', 'diagtester@example.com']).out).toContain('FAIL  that address is a usable Gmail address');
    const none = run(dir, ['--email', 'someone.else@gmail.com']);
    expect(none.code).toBe(1);
    expect(none.out).toContain('FAIL  exactly one account has that canonical address');
  });

  it('a damaged hash, a missing canonicalEmail and a canonical that disagrees with the rule are each reported', () => {
    expect(run(storeWith({ passwordHash: HASH.slice(0, HASH.length - 3) }), ['--email', 'diagtester@gmail.com']).out).toContain('FAIL  the stored password hash is well formed');
    expect(run(storeWith({ canonicalEmail: undefined }), ['--email', 'diagtester@gmail.com']).out).toContain('FAIL  every account has a canonicalEmail');
    expect(run(storeWith({ canonicalEmail: 'other@gmail.com' }), ['--email', 'diagtester@gmail.com']).out).toContain('FAIL  stored canonicalEmail equals the rule');
  });

  it('MFA and lock state are reported, and an MFA account explains the 401 ERR_MFA_REQUIRED', () => {
    const mfa = run(storeWith({ mfaEnabled: true, totpSecret: 'JBSWY3DPEHPK3PXP', suspended: true }), ['--email', 'diagtester@gmail.com']);
    expect(mfa.out).toContain('ERR_MFA_REQUIRED');
    expect(mfa.out).toContain('INFO  suspended');
    expect(mfa.out).not.toContain('JBSWY3DPEHPK3PXP');
    const locked = run(storeWith({ lockedUntil: Date.now() + 120_000 }), ['--email', 'diagtester@gmail.com']);
    expect(locked.code).toBe(1);
    expect(locked.out).toContain('FAIL  account is not locked');
  });

  it('refuses a missing store, a damaged file and a password from a pipe', () => {
    const empty = mkdtempSync(join(tmpdir(), 'obsidian-diag-'));
    dirs.push(empty);
    expect(run(empty, []).code).toBe(1);
    writeFileSync(join(empty, 'interface-accounts.json'), '{not json');
    const damaged = run(empty, []);
    expect(damaged.code).toBe(1);
    expect(damaged.out).toContain('do NOT start it');
    expect(readFileSync(join(empty, 'interface-accounts.json'), 'utf8')).toBe('{not json');
    expect(readdirSync(empty)).toEqual(['interface-accounts.json']); // nothing was moved aside
    const piped = run(storeWith({}), ['--email', 'diagtester@gmail.com', '--check-password']);
    expect(piped.code).toBe(2);
  });
});
