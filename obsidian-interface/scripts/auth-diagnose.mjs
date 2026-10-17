#!/usr/bin/env node
/**
 * Read-only diagnosis of "I registered, but sign-in answers 401".
 *
 *   node scripts/auth-diagnose.mjs --data-dir /var/lib/obsidian/mainnet/interface            # store health only
 *   node scripts/auth-diagnose.mjs --data-dir … --email you@gmail.com                          # one account, no secret needed
 *   node scripts/auth-diagnose.mjs --data-dir … --email you@gmail.com --check-password         # asks for the password, hidden
 *   node scripts/auth-diagnose.mjs … --build-dir /opt/obsidian/obsidian-interface/dist/server   # fingerprint the code that runs
 *
 * What it does NOT do, by construction:
 *   - It never writes. It opens the accounts file with a plain `readFileSync`; it does not load the interface's own store
 *     module, which repairs, migrates and may move a damaged file aside when it opens one.
 *   - It never touches the failed-login counters or the lock state, and it never calls the running service, so checking a
 *     password here cannot lock anybody out and cannot create a session.
 *   - It never prints a password, a hash, a salt, a TOTP secret, a recovery code, an invitation or a session token. Only
 *     yes/no answers, counts, and the public parameters of the hash (algorithm, N, r, p and byte lengths).
 *   - It never accepts a password on the command line (it would sit in shell history and `ps`). The password is typed at a
 *     hidden prompt. OBSIDIAN_DIAG_PASSWORD exists for the automated test with invented credentials; do not use it
 *     for a real account.
 *
 * Run it as the account that owns the data (`sudo -u obsidian …`). It exits 0 if every check it ran passed, 1 if one failed,
 * 2 for a usage error.
 */

import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

if (flag('help') || args.length === 0) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '').replace(/^\/\*\*?|^ \* ?/gm, ''));
  process.exit(args.length === 0 ? 2 : 0);
}

const dataDir = option('data-dir');
if (!dataDir) {
  console.error('--data-dir is required (the directory that holds interface-accounts.json)');
  process.exit(2);
}

let failures = 0;
const say = (label, value) => console.log(`${label.padEnd(64)} ${value}`);
const pass = (label, detail = '') => say(`PASS  ${label}`, detail);
const fail = (label, detail = '') => {
  failures += 1;
  say(`FAIL  ${label}`, detail);
};
const info = (label, detail = '') => say(`INFO  ${label}`, detail);

// ── the same canonical-Gmail rule the service applies (kept here so the script has no dependency on the build) ──
function canonicalGmail(input) {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (domain !== 'gmail.com' && domain !== 'googlemail.com') return null;
  if (!/^[a-z0-9]+(?:[._+-][a-z0-9]+)*$/.test(local)) return null;
  const dotless = (local.split('+', 1)[0] ?? '').replace(/\./g, '');
  if (dotless.length < 6 || dotless.length > 30) return null;
  return `${dotless}@gmail.com`;
}

const mask = (email) => (typeof email === 'string' && email.includes('@') ? `${email.slice(0, 2)}…@${email.split('@').pop()}` : '(none)');

/** Parse `scrypt$N$r$p$salt$hash` strictly. Returns the public parameters and the raw bytes, or a reason. */
function parseHash(stored) {
  if (typeof stored !== 'string' || stored.length === 0) return { reason: 'no password hash is stored' };
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { reason: `not a scrypt record (${parts.length} fields, algorithm "${String(parts[0]).slice(0, 12)}")` };
  const [, n, r, p, saltHex, hashHex] = parts;
  for (const field of [n, r, p]) if (!/^[0-9]{1,9}$/.test(field)) return { reason: 'a cost parameter is not a whole number' };
  const hex = (text) => text.length > 0 && text.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(text);
  if (!hex(saltHex)) return { reason: 'the salt is not whole hex' };
  if (!hex(hashHex)) return { reason: 'the hash is not whole hex' };
  return { n: Number(n), r: Number(r), p: Number(p), salt: Buffer.from(saltHex, 'hex'), key: Buffer.from(hashHex, 'hex') };
}

/** Independent verification (NFKC, as registration does). */
function verifyIndependently(password, parsed) {
  try {
    const derived = scryptSync(password.normalize('NFKC'), parsed.salt, parsed.key.length, {
      N: parsed.n,
      r: parsed.r,
      p: parsed.p,
      maxmem: 256 * 1024 * 1024,
    });
    return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
  } catch {
    return false;
  }
}

/** Read a line without echoing it. */
async function promptHidden(question) {
  if (process.env.OBSIDIAN_DIAG_PASSWORD !== undefined) return process.env.OBSIDIAN_DIAG_PASSWORD;
  if (!process.stdin.isTTY) {
    console.error('refusing to read a password from a pipe or a file: run this in a terminal so it can be typed hidden');
    process.exit(2);
  }
  process.stdout.write(question);
  return new Promise((done) => {
    let text = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          done(text);
          return;
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f' || ch === '\b') text = text.slice(0, -1);
        else text += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

const file = join(resolve(dataDir), 'interface-accounts.json');
console.log('Obsidian interface sign-in diagnosis (read-only)\n');

// ── 1. the file ────────────────────────────────────────────────────────────
if (!existsSync(file)) {
  fail('accounts file exists', file);
  process.exit(1);
}
const stat = statSync(file);
pass('accounts file exists', `${stat.size} bytes, mode ${(stat.mode & 0o777).toString(8)}, uid ${stat.uid}`);
if (stat.mode & 0o077) fail('file is private to its owner', 'group/other can read it: chmod 600 (do this deliberately, not from this tool)');
else pass('file is private to its owner');
if (typeof process.getuid === 'function') {
  if (process.getuid() === stat.uid) pass('running as the file owner');
  else info('running as a different user than the file owner', `uid ${process.getuid()} vs ${stat.uid}; the service user is the one that matters`);
}

let store;
try {
  store = JSON.parse(readFileSync(file, 'utf8'));
  pass('file is valid JSON');
} catch {
  fail('file is valid JSON', 'the service would move it aside as .corrupt-<time> and start empty; do NOT start it until this is understood');
  process.exit(1);
}
const accounts = Array.isArray(store.accounts) ? store.accounts : [];
info('store format version', String(store.version));
info('accounts', String(accounts.length));
info('invitations issued by accounts', String(Array.isArray(store.invites) ? store.invites.length : 0));
info('genesis invitation', store.genesisInvite ? (store.genesisInvite.redeemedBy ? 'configured, redeemed' : 'configured, NOT redeemed') : 'not configured');
const failuresBeforeIdentityChecks = failures;
const canonicalSeen = new Map();
for (const account of accounts) {
  if (!account.canonicalEmail) fail('every account has a canonicalEmail', `account ${String(account.accountId).slice(0, 8)}… has none: sign-in cannot find it`);
  else canonicalSeen.set(account.canonicalEmail, (canonicalSeen.get(account.canonicalEmail) ?? 0) + 1);
}
for (const [email, count] of canonicalSeen) if (count > 1) fail('one account per canonical Gmail', `${mask(email)} appears ${count} times`);
for (const account of accounts) {
  const recomputed = canonicalGmail(account.email ?? '');
  if (account.canonicalEmail && recomputed !== account.canonicalEmail) {
    fail('stored canonicalEmail equals the rule applied to the stored email', `account ${String(account.accountId).slice(0, 8)}…: stored ${mask(account.canonicalEmail)}, rule gives ${mask(recomputed)}`);
  }
}
if (failures === failuresBeforeIdentityChecks) pass('canonical identities are unique and match the current rule');

// ── 2. the code that is running ────────────────────────────────────────────
const buildDir = option('build-dir');
let loaded;
if (buildDir) {
  const files = ['index.js', 'store.js', 'identity.js', 'main.js'];
  for (const name of files) {
    const path = join(resolve(buildDir), name);
    if (existsSync(path)) info(`sha256 ${name}`, createHash('sha256').update(readFileSync(path)).digest('hex'));
    else fail(`${name} present in build dir`, path);
  }
  try {
    loaded = await import(pathToFileURL(join(resolve(buildDir), 'identity.js')).href);
    pass('the installed identity.js loads');
  } catch (error) {
    fail('the installed identity.js loads', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }
  if (loaded) {
    // The installed verifier must agree with a plain computation on a known answer. (Invented credentials, public.)
    const vector = {
      password: 'Synthetic-Fixture-Pw-0',
      stored: 'scrypt$32768$8$1$00112233445566778899aabbccddeeff$1b1ccc00ed3309a5088738636a8b4d092ba567b9be3ba770eec87bca805a5ff9',
    };
    const ok = await loaded.verifySecretAsync(vector.password, vector.stored).catch(() => false);
    const wrong = await loaded.verifySecretAsync(`${vector.password}x`, vector.stored).catch(() => true);
    if (ok === true && wrong === false) pass('installed verifier agrees with plain scrypt on a known answer');
    else fail('installed verifier agrees with plain scrypt on a known answer', `accepts the right one: ${ok}; accepts a wrong one: ${wrong}`);
    const canon = loaded.canonicalGmail?.('John.Smith+x@Googlemail.com')?.canonical;
    if (canon === 'johnsmith@gmail.com') pass('installed canonicalisation agrees with the documented rule');
    else fail('installed canonicalisation agrees with the documented rule', `gave ${String(canon)}`);
  }
} else {
  info('installed build not inspected', 'add --build-dir /opt/obsidian/obsidian-interface/dist/server to fingerprint the code the service loads');
}

// ── 3. one account ─────────────────────────────────────────────────────────
const typed = option('email');
if (typed) {
  console.log('');
  const canonical = canonicalGmail(typed);
  if (!canonical) {
    fail('that address is a usable Gmail address', 'the service refuses it before looking anything up, which answers 401 exactly like a wrong password');
  } else {
    pass('that address is a usable Gmail address', `canonical form ${mask(canonical)}`);
    const matches = accounts.filter((account) => account.canonicalEmail === canonical);
    if (matches.length !== 1) {
      fail('exactly one account has that canonical address', `${matches.length} found; with none, sign-in answers 401 as for a wrong password`);
    } else {
      const account = matches[0];
      pass('exactly one account has that canonical address', `account ${String(account.accountId).slice(0, 8)}…, registered as ${mask(account.email)}`);
      const parsed = parseHash(account.passwordHash);
      if (parsed.reason) fail('the stored password hash is well formed', parsed.reason);
      else {
        pass('the stored password hash is well formed', `scrypt N=${parsed.n} r=${parsed.r} p=${parsed.p}, salt ${parsed.salt.length} bytes, key ${parsed.key.length} bytes`);
        if (parsed.salt.length < 8 || parsed.key.length < 16 || parsed.n < 2 || parsed.r < 1 || parsed.p < 1) {
          fail('the stored hash is one the service will accept', 'v2.0.2+patch refuses records this short or with zero costs');
        }
      }
      info('MFA enabled', String(account.mfaEnabled === true) + (account.mfaEnabled ? '  → the right password answers 401 ERR_MFA_REQUIRED until a code is sent' : ''));
      info('TOTP secret stored', String(Boolean(account.totpSecret)));
      info('last TOTP step consumed', account.totpLastStep === undefined ? 'none' : 'yes (a code from that 30-second step cannot be reused)');
      info('suspended', String(account.suspended === true));
      const lockedFor = account.lockedUntil && account.lockedUntil > Date.now() ? Math.ceil((account.lockedUntil - Date.now()) / 1000) : 0;
      if (lockedFor) fail('account is not locked', `locked for another ${lockedFor}s (answers 429, never 401)`);
      else pass('account is not locked');
      info('failed-login counter on the account', String(account.failedLogins ?? 0));
      info('recovery codes remaining', String(account.recoveryCodesRemaining ?? 0));

      if (flag('check-password') && !parsed.reason) {
        const password = await promptHidden('Password to test (hidden, never stored, never sent anywhere): ');
        const typedOk = verifyIndependently(password, parsed);
        if (typedOk) pass('the typed password matches the stored hash (independent computation)');
        else fail('the typed password matches the stored hash (independent computation)', 'it does NOT. Check: typed exactly as at registration, no extra space, keyboard layout, password-manager autofill');
        if (loaded) {
          const viaService = await loaded.verifySecretAsync(password, account.passwordHash).catch(() => false);
          if (viaService === typedOk) pass('the installed verifier gives the same answer');
          else fail('the installed verifier gives the same answer', `plain: ${typedOk}, installed: ${viaService} — the build on disk is not the code the tests describe`);
        }
        if (password !== password.trim()) info('the typed password has leading or trailing whitespace', 'registration refuses such passwords, so it cannot be the registered one');
        if (password.normalize('NFKC') !== password) info('the typed password changes under NFKC', 'both registration and sign-in fold it the same way');
      } else if (!flag('check-password')) {
        info('password not tested', 'add --check-password to test one at a hidden prompt');
      }
    }
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : '\nEvery check that ran passed.');
process.exit(failures ? 1 : 0);
