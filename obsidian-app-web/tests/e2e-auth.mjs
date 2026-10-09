#!/usr/bin/env node
/**
 * Live account flow, driven through the app's own data layer (public/data.mjs).
 *
 *   APP_URL=http://127.0.0.1:38790 GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX \
 *     node tests/e2e-auth.mjs
 *
 * Needs a platform with a fresh data dir and OBSIDIAN_GENESIS_INVITE_HASH set to the
 * hash of GENESIS_CODE (the first account can only be created with it). Not part of
 * `npm test`: it consumes the genesis invitation and creates an account.
 *
 * Covers register -> MFA setup/confirm -> sign out -> MFA-required sign-in -> wrong
 * password -> sign-in with a code -> invites -> link wallet -> bad recovery code.
 */
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const APP = process.env.APP_URL ?? 'http://127.0.0.1:38790';
const CODE = process.env.GENESIS_CODE;
if (!CODE) {
  console.error('set GENESIS_CODE to the genesis invitation the platform was started with');
  process.exit(2);
}

// A cookie jar: data.mjs is browser code and relies on the browser for the session.
let jar = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const res = await realFetch(String(url).startsWith('/') ? APP + url : url, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie: jar },
  });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const name = pair.split('=')[0];
    jar = jar.split('; ').filter((c) => c && !c.startsWith(`${name}=`)).concat(pair).join('; ');
  }
  return res;
};

const d = await import('../public/data.mjs');

const base32 = (text) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const totp = (secret, at = Date.now()) => {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const hmac = createHmac('sha1', base32(secret)).update(counter).digest();
  const offset = hmac[19] & 15;
  return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
};
const rejects = async (fn, code) => {
  try {
    await fn();
  } catch (error) {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return;
  }
  assert.fail(`expected ${code}, but the call succeeded`);
};

const email = 'e2e.tester@gmail.com';
const password = 'correct horse battery 7 staple';
const address = process.env.WALLET_ADDRESS ?? 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0';

const registered = await d.register({ email, password, inviteCode: CODE });
assert.equal(registered.recoveryCodes.length, 10, 'ten recovery codes, shown once');
assert.equal((await d.me()).account.email, email, 'registering signs you in');

const mfa = await d.mfaSetup();
const confirmed = await d.mfaConfirm(totp(mfa.secret));
assert.equal(confirmed.account.mfaEnabled, true);
assert.equal(confirmed.account.miningEnabled, true, 'MFA is what enables mining');

await d.logout();
await rejects(() => d.me(), 'ERR_UNAUTHORIZED');
await rejects(() => d.login({ email, password }), 'ERR_MFA_REQUIRED');
await rejects(() => d.login({ email, password: 'wrong wrong wrong 1' }), 'ERR_CREDENTIALS_INVALID');
// The next 30-second window: the previous code was just used and must not replay.
await d.login({ email, password, totp: totp(mfa.secret, Date.now() + 30000) });

assert.equal((await d.invites()).limit, 5);
assert.match((await d.issueInvite()).invite.code, /^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
assert.equal((await d.linkWallet(address)).linked, true);
assert.equal((await d.me()).account.walletAddress, address);
await rejects(() => d.recover({ email, recoveryCode: 'XXXX-XXXX', newPassword: 'another long password 9' }), 'ERR_RECOVERY_INVALID');

console.log('e2e-auth: all steps passed');
