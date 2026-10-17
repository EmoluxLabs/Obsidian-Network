/**
 * Registration → persistence → restart → sign-in → MFA → session, end to end, with synthetic identities only.
 *
 * Written for the v2.0.2 "registered fine, then 401 on sign-in" report. Nothing here touches a real account store, a real
 * Genesis Invitation, a real password or a real session: every test boots its own server on an ephemeral port over its own
 * temporary data directory, with its own freshly generated invitation and invented Gmail addresses ending in `-synthetic`.
 * No email is sent and nothing is consumed outside the test's own directory.
 *
 * The known-answer vectors below were produced by calling Node's `crypto.scryptSync` directly with fixed salts, NOT by the
 * code under test, so a change to the algorithm, its parameters or its password normalisation fails here instead of
 * silently locking existing accounts out.
 */

import { createHmac, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { InterfaceServer, type InterfaceConfig } from '../server/index.js';
import { AccountStore } from '../server/store.js';
import { newGenesisInvitation } from '../server/genesis-invite.js';
import {
  canonicalGmail,
  checkPasswordPolicy,
  hashSecret,
  hashSecretAsync,
  verifySecret,
  verifySecretAsync,
} from '../server/identity.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-auth-flow-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

// ── known answers, computed outside the code under test ─────────────────────
const VECTOR_ASCII = {
  password: 'Synthetic-Fixture-Pw-0',
  stored: 'scrypt$32768$8$1$00112233445566778899aabbccddeeff$25b8b1a18624fb92f01ca6a6c83db69975eec26b3b67c984642a053100c5feff',
};
const VECTOR_UNICODE = {
  // 'ｆｕｌｌｗｉｄｔｈ' is fullwidth: NFKC folds it to 'fullwidth', and the hash was made over the folded text.
  password: 'Pässwörd-ｆｕｌｌｗｉｄｔｈ-9',
  stored: 'scrypt$32768$8$1$ffeeddccbbaa99887766554433221100$08ab83cb384c83e2f833f36e775842f79202c1a90a8ce97afb6b09c6ae3e2aa6',
};

describe('password hashing: format, known answers, normalisation', () => {
  it('writes the documented scrypt$N$r$p$salt$hash format with the documented parameters', async () => {
    for (const hash of [hashSecret('Another-Synthetic-Pass-1'), await hashSecretAsync('Another-Synthetic-Pass-1')]) {
      expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    }
  });

  it('verifies hashes made by plain Node scrypt, so accounts stored by earlier builds keep working', async () => {
    for (const vector of [VECTOR_ASCII, VECTOR_UNICODE]) {
      expect(verifySecret(vector.password, vector.stored)).toBe(true);
      expect(await verifySecretAsync(vector.password, vector.stored)).toBe(true);
    }
    // And it derives the same bytes as the independent computation.
    const parts = VECTOR_ASCII.stored.split('$');
    const independent = scryptSync(VECTOR_ASCII.password, Buffer.from(parts[4]!, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    expect(independent.toString('hex')).toBe(parts[5]);
  });

  it('the sync and async implementations are interchangeable in both directions', async () => {
    const password = 'Interchangeable-Synth-2';
    expect(await verifySecretAsync(password, hashSecret(password))).toBe(true);
    expect(verifySecret(password, await hashSecretAsync(password))).toBe(true);
  });

  it('established semantics: NFKC is applied on both sides; nothing else (no trim, no case folding, no space removal)', async () => {
    // Compatibility forms fold together…
    expect(await verifySecretAsync('Pässwörd-fullwidth-9', VECTOR_UNICODE.stored)).toBe(true);
    expect(await verifySecretAsync('P\u0061\u0308sswörd-fullwidth-9', VECTOR_UNICODE.stored)).toBe(true); // decomposed ä
    // …and nothing else does.
    expect(await verifySecretAsync(` ${VECTOR_ASCII.password}`, VECTOR_ASCII.stored)).toBe(false);
    expect(await verifySecretAsync(`${VECTOR_ASCII.password} `, VECTOR_ASCII.stored)).toBe(false);
    expect(await verifySecretAsync(VECTOR_ASCII.password.toLowerCase(), VECTOR_ASCII.stored)).toBe(false);
    expect(await verifySecretAsync(VECTOR_ASCII.password.replace('-', ''), VECTOR_ASCII.stored)).toBe(false);
    expect(await verifySecretAsync('', VECTOR_ASCII.stored)).toBe(false);
  });

  it('fails closed on missing, malformed, truncated or unsupported records — and never throws', async () => {
    const good = VECTOR_ASCII.stored;
    const parts = good.split('$');
    const withHash = (hex: string) => [...parts.slice(0, 5), hex].join('$');
    const withSalt = (hex: string) => [...parts.slice(0, 4), hex, parts[5]].join('$');
    const bad: unknown[] = [
      undefined, null, '', 'scrypt', 'x$y', 'bcrypt$10$abc$def$aa$bb', `${good}$extra`,
      good.replace('scrypt$32768', 'scrypt$not-a-number'), good.replace('$8$1$', '$8.5$1$'), good.replace('$8$1$', '$-8$1$'),
      withHash(''), withSalt(''), withHash('zz'.repeat(32)), withSalt('zz'.repeat(16)),
      withHash(parts[5]!.slice(0, 63)), // odd number of hex digits
      withHash(parts[5]!.slice(0, 2)), // a one-byte "hash": accepts one wrong password in 256
      withHash(parts[5]!.slice(0, 30)), // 15 bytes, shorter than any hash this code writes
      withSalt(parts[4]!.slice(0, 14)), // 7-byte salt
      good.replace('scrypt$32768$8$1', 'scrypt$32767$8$1'), // N not a power of two
      good.replace('scrypt$32768$8$1', 'scrypt$1073741824$8$1'), // would need more memory than the cap
      good.replace('$1$0011', '$0$0011'),
    ];
    for (const stored of bad) {
      expect(verifySecret(VECTOR_ASCII.password, stored as string), String(stored)).toBe(false);
      expect(await verifySecretAsync(VECTOR_ASCII.password, stored as string), String(stored)).toBe(false);
    }
    expect(verifySecret(undefined as unknown as string, good)).toBe(false);
    expect(await verifySecretAsync(42 as unknown as string, good)).toBe(false);
  });

  it('upper-case hex in a stored record is the same record', async () => {
    const shouted = VECTOR_ASCII.stored.replace(/\$([0-9a-f]+)\$([0-9a-f]+)$/, (_m, a: string, b: string) => `$${a.toUpperCase()}$${b.toUpperCase()}`);
    expect(await verifySecretAsync(VECTOR_ASCII.password, shouted)).toBe(true);
  });
});

describe('Gmail canonicalisation: one rule for registration, sign-in and lookup', () => {
  const same: Array<[string, string]> = [
    ['John.Smith+shop@Gmail.com', 'johnsmith@gmail.com'],
    ['  johnsmith@googlemail.com  ', 'johnsmith@gmail.com'],
    ['j.o.h.n.s.m.i.t.h@gmail.com', 'johnsmith@gmail.com'],
    ['johnsmith+a+b@gmail.com', 'johnsmith@gmail.com'],
    ['JOHNSMITH@GMAIL.COM', 'johnsmith@gmail.com'],
  ];
  for (const [typed, canonical] of same) {
    it(`${JSON.stringify(typed)} is ${canonical}`, () => {
      expect(canonicalGmail(typed)?.canonical).toBe(canonical);
    });
  }
  it('refuses anything that is not a usable Gmail address, including Unicode look-alikes', () => {
    for (const typed of [
      '', ' ', 'johnsmith', 'johnsmith@', '@gmail.com', 'johnsmith@example.com', 'johnsmith@gmail.com.evil.com', 'john..smith@gmail.com',
      '.johnsmith@gmail.com', 'johnsmith.@gmail.com', 'short@gmail.com', 'johnsmith@gmaıl.com', 'jóhnsmith@gmail.com', 'john smith@gmail.com',
      'johnsmith@gmail.com\n', `${'a'.repeat(31)}@gmail.com`, 'john\u200bsmith@gmail.com', '＠gmail.com', 'johnsmith＠gmail.com',
    ]) {
      // The trailing newline is trimmed (it is whitespace), everything else is rejected outright.
      if (typed === 'johnsmith@gmail.com\n') expect(canonicalGmail(typed)?.canonical).toBe('johnsmith@gmail.com');
      else expect(canonicalGmail(typed), JSON.stringify(typed)).toBeNull();
    }
    for (const notAString of [undefined, null, 5, {}, ['johnsmith@gmail.com']]) expect(canonicalGmail(notAString as unknown as string)).toBeNull();
  });
  it('the password policy is unchanged', () => {
    expect(checkPasswordPolicy('short1').ok).toBe(false);
    expect(checkPasswordPolicy('a-long-enough-pass-9').ok).toBe(true);
    expect(checkPasswordPolicy(' leading-space-pass-9').ok).toBe(false);
    expect(checkPasswordPolicy('no-digits-in-this-one').ok).toBe(false);
    expect(checkPasswordPolicy('123456789012345').ok).toBe(false);
  });
});

// ── a server of our own ─────────────────────────────────────────────────────
interface Booted {
  origin: string;
  server: InterfaceServer;
  store: AccountStore;
  dataDir: string;
  genesisCode: string;
  close: () => Promise<void>;
}
const booted: Booted[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (booted.length) await booted.pop()!.close();
});

async function boot(options: { dataDir?: string; trustProxy?: boolean; genesis?: { code: string; hash: string } } = {}): Promise<Booted> {
  const genesis = options.genesis ?? newGenesisInvitation();
  const dataDir = options.dataDir ?? scratch();
  const siteRoot = scratch();
  const publicDir = scratch();
  const coreDir = scratch();
  mkdirSync(join(siteRoot, 'landing'), { recursive: true });
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>root</title>');
  const config: InterfaceConfig = {
    host: '127.0.0.1',
    port: 0,
    siteRoot,
    publicDir,
    coreDir,
    dataDir,
    nodeUrls: ['http://127.0.0.1:9'],
    allowedOrigins: [],
    trustOfficialDomains: false,
    maxInvitesPerAccount: 5,
    genesisInviteHash: genesis.hash,
    trustProxy: options.trustProxy ?? false,
    role: 'primary',
    logLevel: 'error',
  };
  const store = new AccountStore({ dataDir });
  store.configureGenesisInvite(genesis.hash);
  const server = new InterfaceServer({ config, store });
  const port = await server.listen();
  const created: Booted = {
    origin: `http://127.0.0.1:${port}`,
    server,
    store,
    dataDir,
    genesisCode: genesis.code,
    close: () => server.close(),
  };
  booted.push(created);
  return created;
}

const PASSWORD = 'synthetic-Passw0rd-one';
const EMAIL = 'first.synthetic.user@gmail.com';
/** What the server keys that address by: dots and tags gone. */
const CANONICAL = 'firstsyntheticuser@gmail.com';

function post(h: { origin: string }, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}
const register = (h: Booted, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(h, '/api/auth/register', { email: EMAIL, password: PASSWORD, inviteCode: h.genesisCode, ...over }, headers);
const login = (h: { origin: string }, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(h, '/api/auth/login', { email: EMAIL, password: PASSWORD, ...over }, headers);
const cookieOf = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';')[0]!;
const bodyOf = async (response: Response) => (await response.json()) as Record<string, any>;

/** An independent RFC 6238 implementation (not the server's). */
function totpAt(secret: string, offsetSteps = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).filter((byte) => byte.length === 8).map((byte) => parseInt(byte, 2)));
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Enrol MFA for the signed-in cookie; returns the TOTP secret. The confirming code is the CURRENT step. */
async function enrolMfa(h: Booted, cookie: string): Promise<string> {
  const setup = await post(h, '/api/auth/mfa/setup', {}, { cookie });
  expect(setup.status).toBe(200);
  const { secret } = (await bodyOf(setup)) as { secret: string };
  const confirmed = await post(h, '/api/auth/mfa/confirm', { totp: totpAt(secret) }, { cookie });
  expect(confirmed.status).toBe(200);
  return secret;
}

describe('registration and sign-in with the same password', () => {
  it('a registered account signs in with exactly the password it registered with, and /api/auth/me answers', async () => {
    const h = await boot();
    const created = await register(h);
    expect(created.status).toBe(200);
    const registered = await bodyOf(created);
    expect(registered.recoveryCodes).toHaveLength(10);
    expect(registered.account.passwordHash).toBeUndefined();

    const signedIn = await login(h);
    expect(signedIn.status).toBe(200);
    const me = await fetch(`${h.origin}/api/auth/me`, { headers: { cookie: cookieOf(signedIn) } });
    expect(me.status).toBe(200);
    const view = await bodyOf(me);
    expect(view.account.email).toBe(EMAIL);
    expect(view.account.accountId).toBe(registered.account.accountId);
    expect(JSON.stringify(view)).not.toMatch(/passwordHash|totpSecret|recoveryCodeHashes|canonicalEmail/);
  });

  it('the account is on disk before the registration answers, in the documented shape, readable only by its owner', async () => {
    const h = await boot();
    const created = await register(h);
    expect(created.status).toBe(200);
    // Read the file straight away: nothing may be waiting on a timer.
    const file = join(h.dataDir, 'interface-accounts.json');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<{ canonicalEmail: string; passwordHash: string; accountId: string }>; genesisInvite: { redeemedBy?: string } };
    expect(stored.accounts).toHaveLength(1);
    expect(stored.accounts[0]!.canonicalEmail).toBe(CANONICAL);
    expect(stored.accounts[0]!.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
    expect(verifySecret(PASSWORD, stored.accounts[0]!.passwordHash)).toBe(true);
    expect(stored.genesisInvite.redeemedBy).toBe(stored.accounts[0]!.accountId);
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('survives a restart: same account id, same password, same canonical identity, invitation still spent', async () => {
    const first = await boot();
    const accountId = ((await bodyOf(await register(first))).account as { accountId: string }).accountId;
    await first.close();
    booted.splice(booted.indexOf(first), 1);

    const second = await boot({ dataDir: first.dataDir, genesis: { code: first.genesisCode, hash: first.store.genesisInviteStatus().configured ? (JSON.parse(readFileSync(join(first.dataDir, 'interface-accounts.json'), 'utf8')) as { genesisInvite: { hash: string } }).genesisInvite.hash : '' } });
    const config = await bodyOf(await fetch(`${second.origin}/api/auth/config`));
    expect(config).toMatchObject({ accountsExist: true, genesisInvite: { configured: true, redeemed: true }, authMethod: 'GMAIL_PASSWORD_MFA', inviteOnly: true });

    const signedIn = await login(second);
    expect(signedIn.status).toBe(200);
    expect((await bodyOf(signedIn)).account.accountId).toBe(accountId);
    // Wrong password is still refused after the reload.
    expect((await login(second, { password: `${PASSWORD}x` })).status).toBe(401);
    // The spent invitation cannot make a second "first account".
    const again = await register(second, { email: 'second.synthetic.user@gmail.com' });
    expect(again.status).toBe(403);
    expect(second.store.accountCount).toBe(1);
  });

  it('every spelling of the same Gmail inbox is the same account on sign-in, and registers only once', async () => {
    const h = await boot();
    await register(h, { email: 'John.Smith+shop@Gmail.com' });
    for (const typed of ['johnsmith@gmail.com', ' JOHN.SMITH@googlemail.com ', 'j.ohn.smith+other@gmail.com']) {
      const response = await login(h, { email: typed });
      expect(response.status, typed).toBe(200);
    }
    // A second registration for an alias needs a real invitation; give it one from the account.
    const cookie = cookieOf(await login(h, { email: 'johnsmith@gmail.com' }));
    const invite = ((await bodyOf(await post(h, '/api/auth/invites', {}, { cookie }))).invite as { code: string }).code;
    const duplicate = await post(h, '/api/auth/register', { email: 'john.smith+another@googlemail.com', password: PASSWORD, inviteCode: invite });
    expect(duplicate.status).toBe(409);
    expect((await bodyOf(duplicate)).code).toBe('ERR_EMAIL_IN_USE');
    expect(h.store.accountCount).toBe(1);
  });

  it('Unicode passwords: the form the user typed at registration, and its NFKC equivalents, sign in; nothing else does', async () => {
    const h = await boot();
    const typed = 'Pässwörd-ｆｕｌｌｗｉｄｔｈ-9';
    expect((await register(h, { password: typed })).status).toBe(200);
    expect((await login(h, { password: typed })).status).toBe(200);
    expect((await login(h, { password: 'Pässwörd-fullwidth-9' })).status).toBe(200);
    expect((await login(h, { password: 'Passwörd-fullwidth-9' })).status).toBe(401);
  });

  it('a password with spaces inside, quotes, backslashes and emoji is stored and verified byte for byte', async () => {
    const h = await boot();
    const odd = 'my "odd" pass\\word 😀 9';
    expect((await register(h, { password: odd })).status).toBe(200);
    expect((await login(h, { password: odd })).status).toBe(200);
    expect((await login(h, { password: odd.replace('  ', ' ') + '!' })).status).toBe(401);
  });
});

describe('sign-in refusals', () => {
  it('a wrong password and an unknown account get the identical answer, and neither says which it was', async () => {
    const h = await boot();
    await register(h);
    const wrong = await login(h, { password: 'definitely-not-it-1' });
    const unknown = await login(h, { email: 'nobody.synthetic.here@gmail.com' });
    const malformed = await login(h, { email: 'not-an-email' });
    for (const response of [wrong, unknown, malformed]) expect(response.status).toBe(401);
    const bodies = await Promise.all([wrong, unknown, malformed].map((response) => response.text()));
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ error: 'those credentials are not valid', code: 'ERR_CREDENTIALS_INVALID' });
  });

  it('a request that is not a sign-in is called malformed (400), never a wrong password — and says nothing about any account', async () => {
    const h = await boot();
    await register(h);
    for (const body of [{}, { email: EMAIL }, { password: PASSWORD }, { email: 5, password: 5 }, { email: EMAIL, password: ['a'] }, { email: EMAIL, password: null }, { email: EMAIL, password: PASSWORD, totp: 123456 }, [], 'text', null]) {
      const response = await post(h, '/api/auth/login', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await bodyOf(response)).code).toBe('ERR_BAD_REQUEST');
    }
    for (const raw of ['{not json', '', '   ']) {
      const response = await fetch(`${h.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
      expect(response.status, JSON.stringify(raw)).toBe(400);
    }
    const noBody = await fetch(`${h.origin}/api/auth/login`, { method: 'POST' });
    expect(noBody.status).toBe(400);
    // The same malformed answer for a registered and an unregistered address: it is about the request, not the account.
    // (A well-formed request with an empty password is an ordinary refusal.)
    expect((await login(h, { password: '' })).status).toBe(401);
    expect((await login(h, { email: 'nobody.synthetic.here@gmail.com', password: '' })).status).toBe(401);
    expect((await login(h)).status).toBe(200);
  });

  it('an account whose stored hash is damaged is refused (not accepted, not a crash) and the damage does not spread', async () => {
    const h = await boot();
    await register(h);
    expect((await register(h, { email: 'x' })).status).toBe(400); // refused: nothing created
    const account = h.store.findByCanonicalEmail(CANONICAL)!;
    const good = account.passwordHash!;
    for (const damaged of [good.slice(0, good.length - 3), good.slice(0, good.length - 62), 'scrypt$32768$8$1$00$00', '', 'not-a-hash']) {
      account.passwordHash = damaged;
      expect((await login(h)).status, damaged).toBe(401);
    }
    account.passwordHash = good;
    expect((await login(h)).status).toBe(200);
  });

  it('a suspended account is refused with the right password, and indistinguishable from any other failure with a wrong one', async () => {
    const h = await boot();
    const registered = await bodyOf(await register(h));
    const cookie = cookieOf(await login(h));
    h.store.setSuspended(registered.account.accountId, true);
    const refused = await login(h);
    expect(refused.status).toBe(403);
    expect((await bodyOf(refused)).code).toBe('ERR_ACCOUNT_SUSPENDED');
    expect((await login(h, { password: 'wrong-password-123' })).status).toBe(401);
    // A live session is cut off too.
    expect((await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } })).status).toBe(403);
    h.store.setSuspended(registered.account.accountId, false);
    expect((await login(h)).status).toBe(200);
  });
});

describe('MFA', () => {
  it('password right, no code → ERR_MFA_REQUIRED (not a credentials error); wrong code → ERR_MFA_INVALID; right code → session; the same code again → refused', async () => {
    const h = await boot();
    const cookie = cookieOf(await register(h));
    const secret = await enrolMfa(h, cookie);

    const noCode = await login(h);
    expect(noCode.status).toBe(401);
    expect((await bodyOf(noCode)).code).toBe('ERR_MFA_REQUIRED');
    // A wrong password with MFA enabled must still look like any other wrong password.
    expect((await bodyOf(await login(h, { password: 'wrong-password-123' }))).code).toBe('ERR_CREDENTIALS_INVALID');

    const wrong = await login(h, { totp: '000000' });
    expect(wrong.status).toBe(401);
    expect((await bodyOf(wrong)).code).toBe('ERR_MFA_INVALID');

    // The enrolment used the current step; the next one is inside the ±1 window and unused.
    const next = totpAt(secret, 1);
    const ok = await login(h, { totp: next });
    expect(ok.status).toBe(200);
    expect((await fetch(`${h.origin}/api/auth/me`, { headers: { cookie: cookieOf(ok) } })).status).toBe(200);

    const replay = await login(h, { totp: next });
    expect(replay.status).toBe(401);
    expect((await bodyOf(replay)).code).toBe('ERR_MFA_INVALID');
    // The step that enrolment consumed cannot be replayed either.
    expect((await bodyOf(await login(h, { totp: totpAt(secret, 0) }))).code).toBe('ERR_MFA_INVALID');
  });

  it('codes with spaces around them are accepted; wrong-length and non-numeric codes are refused', async () => {
    const h = await boot();
    const secret = await enrolMfa(h, cookieOf(await register(h)));
    for (const bad of ['12345', '1234567', 'abcdef', '12 34 5x']) {
      expect((await bodyOf(await login(h, { totp: bad }))).code, bad).toBe('ERR_MFA_INVALID');
    }
    const code = totpAt(secret, 1);
    expect((await login(h, { totp: ` ${code.slice(0, 3)} ${code.slice(3)} ` })).status).toBe(200);
  });
});

describe('lockout: protective, scoped, and never permanent', () => {
  it('ten wrong passwords from one address shut THAT address out of THAT account, and no one else', async () => {
    const h = await boot({ trustProxy: true });
    await register(h, {}, { 'x-forwarded-for': '203.0.113.1' });
    for (let i = 0; i < 10; i += 1) {
      expect((await login(h, { password: `wrong-guess-${i}-xx` }, { 'x-forwarded-for': '198.51.100.7' })).status).toBe(401);
    }
    const blocked = await login(h, {}, { 'x-forwarded-for': '198.51.100.7' });
    expect(blocked.status).toBe(429);
    expect((await bodyOf(blocked)).code).toBe('ERR_TOO_MANY_ATTEMPTS');
    // The owner, from anywhere else, is not locked out by a stranger.
    expect((await login(h, {}, { 'x-forwarded-for': '203.0.113.1' })).status).toBe(200);
    // The block is in memory only: a restart clears it, so it cannot become a permanent lock.
    await h.close();
    booted.splice(booted.indexOf(h), 1);
    const again = await boot({ dataDir: h.dataDir, trustProxy: true, genesis: { code: h.genesisCode, hash: (JSON.parse(readFileSync(join(h.dataDir, 'interface-accounts.json'), 'utf8')) as { genesisInvite: { hash: string } }).genesisInvite.hash } });
    expect((await login(again, {}, { 'x-forwarded-for': '198.51.100.7' })).status).toBe(200);
  });

  it('an account-wide lock expires on its own and a good sign-in clears the counters', async () => {
    const h = await boot();
    await register(h);
    const account = h.store.findByCanonicalEmail(CANONICAL)!;
    account.lockedUntil = Date.now() + 60_000;
    account.failedLogins = 7;
    expect((await login(h)).status).toBe(429);
    account.lockedUntil = Date.now() - 1;
    const ok = await login(h);
    expect(ok.status).toBe(200);
    expect(account.lockedUntil).toBeUndefined();
    expect(account.failedLogins).toBe(0);
  });
});

describe('sessions and cookies', () => {
  it('the cookie is HttpOnly, SameSite=Lax, path /, two weeks; Secure exactly when the operator says TLS is terminated upstream', async () => {
    const plain = await boot();
    await register(plain);
    const header = (await login(plain)).headers.get('set-cookie') ?? '';
    expect(header).toMatch(/^obsidian_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=1209600$/);

    const behindProxy = await boot({ trustProxy: true });
    await register(behindProxy);
    expect((await login(behindProxy)).headers.get('set-cookie')).toMatch(/; HttpOnly; SameSite=Lax; Max-Age=1209600; Secure$/);
  });

  it('a session survives a clean restart (flushed on close); a logged-out one does not come back', async () => {
    const first = await boot();
    await register(first);
    const kept = cookieOf(await login(first));
    const dropped = cookieOf(await login(first));
    await post(first, '/api/auth/logout', {}, { cookie: dropped });
    const hash = (JSON.parse(readFileSync(join(first.dataDir, 'interface-accounts.json'), 'utf8')) as { genesisInvite: { hash: string } }).genesisInvite.hash;
    await first.close();
    booted.splice(booted.indexOf(first), 1);
    const second = await boot({ dataDir: first.dataDir, genesis: { code: first.genesisCode, hash } });
    expect((await fetch(`${second.origin}/api/auth/me`, { headers: { cookie: kept } })).status).toBe(200);
    expect((await fetch(`${second.origin}/api/auth/me`, { headers: { cookie: dropped } })).status).toBe(401);
  });

  it('no cookie, a made-up cookie: 401 ERR_UNAUTHORIZED', async () => {
    const h = await boot();
    for (const cookie of [undefined, 'obsidian_session=' + 'f'.repeat(64), 'obsidian_session=short']) {
      const response = await fetch(`${h.origin}/api/auth/me`, { headers: cookie ? { cookie } : {} });
      expect(response.status).toBe(401);
      expect((await bodyOf(response)).code).toBe('ERR_UNAUTHORIZED');
    }
  });
});

describe('both fronts, one platform', () => {
  it('a sign-in is judged the same with the main site\'s Origin header, with none (the app proxy drops it), and with a spoofed forwarded address', async () => {
    const h = await boot();
    await register(h);
    expect((await login(h, {}, { origin: h.origin })).status).toBe(200);
    expect((await login(h)).status).toBe(200);
    expect((await login(h, {}, { 'x-forwarded-for': '203.0.113.9' })).status).toBe(200);
    expect((await login(h, { password: 'wrong-password-123' }, { origin: h.origin })).status).toBe(401);
    // A foreign origin is refused before any credential is looked at — a different answer, never a "wrong password".
    const foreign = await login(h, {}, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
  });
});

describe('persistence and concurrency', () => {
  it('two simultaneous registrations for the same Gmail inbox: exactly one account, exactly one winner', async () => {
    const h = await boot();
    const results = await Promise.all([register(h, { email: 'Racer.One+a@gmail.com' }), register(h, { email: 'racerone+b@googlemail.com' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(h.store.accountCount).toBe(1);
  });

  it('two simultaneous registrations with different inboxes and the one Genesis Invitation: exactly one account', async () => {
    const h = await boot();
    const results = await Promise.all([register(h, { email: 'racer.alpha1@gmail.com' }), register(h, { email: 'racer.bravo2@gmail.com' })]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 403)).toHaveLength(1);
    expect(h.store.accountCount).toBe(1);
    const stored = JSON.parse(readFileSync(join(h.dataDir, 'interface-accounts.json'), 'utf8')) as { accounts: unknown[] };
    expect(stored.accounts).toHaveLength(1);
  });

  it('a failed write is a failed registration: no account in memory, no spent invitation, no way to sign in, and the invitation still works afterwards', async () => {
    const h = await boot();
    // Make the data directory unwritable the portable way (a file where the directory should be).
    const hold = `${h.dataDir}.held`;
    rmSync(h.dataDir, { recursive: true, force: true });
    writeFileSync(h.dataDir, 'not a directory');
    const failed = await register(h);
    expect(failed.status).toBe(500);
    expect(h.store.accountCount).toBe(0);
    expect(h.store.genesisInviteStatus().redeemed).toBe(false);
    expect((await login(h)).status).toBe(401);
    const config = await bodyOf(await fetch(`${h.origin}/api/auth/config`));
    expect(config.accountsExist).toBe(false);

    // The disk comes back; the same invitation registers the same inbox.
    rmSync(h.dataDir, { force: true });
    mkdirSync(h.dataDir, { recursive: true });
    void hold;
    expect((await register(h)).status).toBe(200);
    expect((await login(h)).status).toBe(200);
  });

  it('if spending the invitation cannot be written, the half-made account is taken back and the invitation is not marked spent', async () => {
    const h = await boot();
    const store = h.store as unknown as { persist: () => void };
    const real = store.persist.bind(store);
    let calls = 0;
    vi.spyOn(store, 'persist').mockImplementation(() => {
      calls += 1;
      if (calls === 2) throw new Error('disk full'); // the account write (1) passes, the invitation write (2) fails
      real();
    });
    const failed = await register(h);
    expect(failed.status).toBe(500);
    expect(h.store.accountCount).toBe(0);
    expect(h.store.genesisInviteStatus().redeemed).toBe(false);
    vi.restoreAllMocks();
    const retry = await register(h);
    expect(retry.status).toBe(200);
    expect(h.store.accountCount).toBe(1);
  });
});

describe('the secrets stay secret', () => {
  it('nothing the server answers or logs contains a password, hash, TOTP secret or recovery-code hash', async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const h = await boot();
    const answers: string[] = [];
    const created = await register(h);
    answers.push(await created.clone().text());
    const cookie = cookieOf(created);
    const setup = await post(h, '/api/auth/mfa/setup', {}, { cookie });
    const setupBody = await bodyOf(setup);
    answers.push(JSON.stringify(setupBody));
    for (const response of [await login(h), await login(h, { password: 'wrong-password-123' }), await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } })]) answers.push(await response.text());
    write.mockRestore();
    const stored = h.store.findByCanonicalEmail(CANONICAL)!;
    const everything = [...answers, ...lines].join('\n');
    expect(everything).not.toContain(PASSWORD);
    expect(everything).not.toContain(stored.passwordHash!);
    for (const hash of stored.recoveryCodeHashes ?? []) expect(everything).not.toContain(hash);
    expect(answers.slice(1).join('\n')).not.toContain('recoveryCodeHashes');
    // (the TOTP secret is, by design, in the enrolment answer to the signed-in owner and nowhere else)
    expect([answers[0], ...answers.slice(2)].join('\n')).not.toContain(setupBody.secret);
    expect(existsSync(join(h.dataDir, 'interface-accounts.json'))).toBe(true);
  });
});

describe('the main site\'s sign-in client keeps every error code and message intact', () => {
  it('session.signIn rejects with the platform\'s own message and code for each documented answer, and sends the password untouched', async () => {
    const { session } = await import('../web/src/lib/session.js');
    const real = globalThis.fetch;
    const seen: Array<{ url: string; body: any }> = [];
    const answers: Array<[number, string, string]> = [
      [401, 'ERR_CREDENTIALS_INVALID', 'those credentials are not valid'],
      [401, 'ERR_MFA_REQUIRED', 'an MFA code is required'],
      [401, 'ERR_MFA_INVALID', 'MFA rejected: that code is not valid'],
      [429, 'ERR_TOO_MANY_ATTEMPTS', 'too many failed attempts; try again later'],
      [403, 'ERR_ACCOUNT_SUSPENDED', 'this account is suspended'],
    ];
    try {
      for (const [status, code, error] of answers) {
        globalThis.fetch = (async (url: string, init: RequestInit) => {
          seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
          return new Response(JSON.stringify({ error, code }), { status, headers: { 'content-type': 'application/json' } });
        }) as typeof fetch;
        const typed = ' pässwörd ｆｕｌｌ 9 ';
        await expect(session.signIn({ email: 'first.user@gmail.com', password: typed })).rejects.toMatchObject({ message: error, code });
        expect(seen.at(-1)).toEqual({ url: '/api/auth/login', body: { email: 'first.user@gmail.com', password: typed } });
      }
    } finally {
      globalThis.fetch = real;
    }
  });
});
