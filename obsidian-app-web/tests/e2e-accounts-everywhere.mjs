#!/usr/bin/env node
/**
 * Live: one account system behind every site.
 *
 *   PLATFORM_URL=http://127.0.0.1:39388 APP_URL=http://127.0.0.1:39390 WALLET_URL=http://127.0.0.1:39391 \
 *   GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX  node tests/e2e-accounts-everywhere.mjs
 *
 * Needs a node, the platform, the web app and the wallet site of ONE development network, with a platform whose data
 * directory is fresh (the first account consumes the genesis invitation). Not part of `npm test`.
 *
 * Each site is driven as its own browser would drive it: its own origin, its own cookie jar, the `Origin` header a
 * browser sends. Nothing is shared between the three jars, so a sign-in on one site cannot be what makes a sign-in on
 * another work: every site must accept the credentials on its own.
 *
 *   1  an account registered on the platform signs in on the app, and the other way round
 *   2  second factor: enrolled on one site, demanded and accepted on the other
 *   3  Gmail spellings (dots, +tag, case, googlemail.com) are one account on every site
 *   4  sessions are separate (signing out of one site leaves the other signed in) and name the same account
 *   5  a recovery code spent on one site sets the password for every site; the old password dies everywhere, and every
 *      session open on any site is ended
 *   6  a wallet linked on one site is the account's wallet on the other; a second one is refused on both
 *   7  invitations issued on one site register accounts on the other; a spent invitation is spent everywhere
 *   8  the wallet site is not a door to the account API (by design it has no accounts: its vault unlocks locally)
 *   9  a foreign origin cannot sign in on the platform, and its refusal names the reason
 */
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const env = (name, fallback) => (process.env[name] ?? fallback).replace(/\/$/, '');
const PLATFORM = env('PLATFORM_URL', 'http://127.0.0.1:38788');
const APP = env('APP_URL', 'http://127.0.0.1:38790');
const WALLET = process.env.WALLET_URL ? env('WALLET_URL', '') : null;
const GENESIS = process.env.GENESIS_CODE;
if (!GENESIS) {
  console.error('set GENESIS_CODE to the genesis invitation the platform was started with');
  process.exit(2);
}

class Site {
  constructor(name, base) {
    this.name = name;
    this.base = base;
    this.cookies = new Map();
  }
  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  /** One request; a polite client waits out a "slow down" (ERR_RATE_LIMITED) answer, as the browser apps do not need to. */
  async call(method, path, body, options = {}) {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.once(method, path, body, options);
      if (result.status !== 429 || result.data?.code !== 'ERR_RATE_LIMITED' || attempt >= 6) return result;
      await new Promise((resolve) => setTimeout(resolve, ((result.data.retryAfterSeconds ?? 3) + 0.5) * 1000));
    }
  }
  async once(method, path, body, { origin = this.base } = {}) {
    const response = await fetch(this.base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(origin ? { origin } : {}),
        cookie: this.cookieHeader(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === '' || /max-age=0/i.test(line)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, data, text };
  }
  login(email, password, totp) {
    return this.call('POST', '/api/auth/login', { email, password, ...(totp ? { totp } : {}) });
  }
  me() {
    return this.call('GET', '/api/auth/me');
  }
  forgetCookies() {
    this.cookies.clear();
  }
}

const platform = new Site('platform', PLATFORM);
const app = new Site('app', APP);
const wallet = WALLET ? new Site('wallet', WALLET) : null;


/** One person's browser: a cookie jar per site, never shared. */
const browser = () => ({
  platform: new Site('platform', PLATFORM),
  app: new Site('app', APP),
  ...(WALLET ? { wallet: new Site('wallet', WALLET) } : {}),
});

const base32 = (text) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One authenticator. The server accepts the 30-second step before, at and after now, and refuses a step it has already
 * accepted, so a code is spent by use: this takes the oldest step still allowed, and waits for the clock when all
 * three are spent.
 */
class Authenticator {
  last = -1;
  constructor(secret) {
    this.secret = secret;
  }
  async code() {
    for (let waited = 0; ; waited += 1) {
      const now = Math.floor(Date.now() / 30000);
      const step = Math.max(this.last + 1, now - 1);
      if (step <= now + 1) {
        this.last = step;
        const counter = Buffer.alloc(8);
        counter.writeBigUInt64BE(BigInt(step));
        const hmac = createHmac('sha1', base32(this.secret)).update(counter).digest();
        const offset = hmac[19] & 15;
        return String((hmac.readUInt32BE(offset) & 0x7fffffff) % 1e6).padStart(6, '0');
      }
      if (waited > 70) throw new Error('the clock did not advance to a fresh authenticator step');
      await sleep(1000);
    }
  }
}

let n = 0;
const say = (text) => console.log(`${String(++n).padStart(2, '0')}  ${text}`);
const ok = (result, note) => {
  assert.ok(result.status === 200 || result.status === 201, `${note}: HTTP ${result.status} ${result.text.slice(0, 240)}`);
  return result.data;
};
const refused = (result, status, code, note) => {
  assert.equal(result.status, status, `${note}: HTTP ${result.status} ${result.text.slice(0, 240)}`);
  if (code) assert.equal(result.data?.code, code, `${note}: ${result.text.slice(0, 240)}`);
};

const PASSWORD = 'correct horse battery 7 staple';
const run = Math.random().toString(36).slice(2, 8);
const mailbox = (tag) => `everywhere.${tag}.${run}`;
const addr = (tag) => `${mailbox(tag)}@gmail.com`;
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const OTHER_WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';

// ── alice: registered on the PLATFORM, second factor there, signs in on the APP ─────────────────────────────────
const alice = { email: addr('alice'), b: browser() };
{
  const registered = ok(await alice.b.platform.call('POST', '/api/auth/register', { email: alice.email, password: PASSWORD, inviteCode: GENESIS }), 'register alice on the platform');
  assert.equal(registered.recoveryCodes.length, 10);
  alice.accountId = registered.account.accountId;
  assert.equal(ok(await alice.b.platform.me(), 'platform /me after registering').account.accountId, alice.accountId);
  say('platform: account registered, ten recovery codes, signed in');

  alice.auth = new Authenticator(ok(await alice.b.platform.call('POST', '/api/auth/mfa/setup', {}), 'platform mfa setup').secret);
  const confirmed = ok(await alice.b.platform.call('POST', '/api/auth/mfa/confirm', { totp: await alice.auth.code() }), 'platform mfa confirm');
  assert.equal(confirmed.account.mfaEnabled, true);
  say('platform: second factor enrolled');

  assert.equal((await alice.b.app.me()).status, 401, 'the platform session is not an app session: the app asks for its own sign-in');
  refused(await alice.b.app.login(alice.email, PASSWORD), 401, 'ERR_MFA_REQUIRED', 'app: right password, no code');
  refused(await alice.b.app.login(alice.email, 'not the password 123'), 401, 'ERR_CREDENTIALS_INVALID', 'app: wrong password');
  const viaApp = ok(await alice.b.app.login(alice.email, PASSWORD, await alice.auth.code()), 'app sign-in with the code');
  assert.equal(viaApp.account.accountId, alice.accountId, 'the app signs into the very same account');
  assert.equal(ok(await alice.b.app.me(), 'app /me').account.email, alice.email);
  say('app: asks for the code enrolled on the platform, accepts it, same account id');

  // One account per Gmail inbox, on every site: right password under any spelling gets as far as the second factor.
  const spellings = [
    alice.email.toUpperCase(),
    `  ${alice.email}  `,
    `${mailbox('alice').replace(/\./g, '')}@gmail.com`,
    `${mailbox('alice')}+side@gmail.com`,
    alice.email.replace('@gmail.com', '@googlemail.com'),
  ];
  for (const variant of spellings) {
    for (const [name, site] of Object.entries(browser())) {
      if (name === 'wallet') continue;
      refused(await site.login(variant, PASSWORD), 401, 'ERR_MFA_REQUIRED', `${name}: ${JSON.stringify(variant)}`);
    }
  }
  // (A wrong password is one failure against the 10 an address may spend, so it is tried once per site, not per spelling.)
  refused(await browser().platform.login(spellings[2], 'not the password 123'), 401, 'ERR_CREDENTIALS_INVALID', 'platform: wrong password under another spelling');
  say('upper case, padding, dots, +tag and googlemail.com reach the one account on both sites');

  // Two invitations, issued on the platform, listed on the app.
  const first = ok(await alice.b.platform.call('POST', '/api/auth/invites', {}), 'issue an invitation on the platform').invite.code;
  const second = ok(await alice.b.platform.call('POST', '/api/auth/invites', {}), 'issue another').invite.code;
  const listed = ok(await alice.b.app.call('GET', '/api/auth/invites'), 'the app lists them').invites.map((i) => i.code);
  assert.ok(listed.includes(first) && listed.includes(second), 'both sites list the same invitations');
  alice.invites = { first, second };
  say('invitations issued on the platform are listed on the app');

  // Sessions are separate.
  ok(await alice.b.app.call('POST', '/api/auth/logout', {}), 'app sign-out');
  assert.equal((await alice.b.app.me()).status, 401, 'signed out of the app');
  assert.equal(ok(await alice.b.platform.me(), 'platform still signed in').account.accountId, alice.accountId);
  say('signing out of the app leaves the platform session alone (separate cookies, one account)');
}

// ── bob: registered on the APP (with a platform-issued invitation), second factor there, signs in on the PLATFORM ──
const bob = { email: addr('bob'), b: browser() };
{
  const registered = ok(await bob.b.app.call('POST', '/api/auth/register', { email: bob.email, password: PASSWORD, inviteCode: alice.invites.first }), 'register bob on the app');
  bob.accountId = registered.account.accountId;
  assert.notEqual(bob.accountId, alice.accountId);
  assert.equal(registered.recoveryCodes.length, 10);
  bob.auth = new Authenticator(ok(await bob.b.app.call('POST', '/api/auth/mfa/setup', {}), 'app mfa setup').secret);
  ok(await bob.b.app.call('POST', '/api/auth/mfa/confirm', { totp: await bob.auth.code() }), 'app mfa confirm');
  say('app: account registered with the platform\u2019s invitation, second factor enrolled');

  refused(await bob.b.platform.login(bob.email, PASSWORD), 401, 'ERR_MFA_REQUIRED', 'platform: right password, no code');
  const viaPlatform = ok(await bob.b.platform.login(bob.email, PASSWORD, await bob.auth.code()), 'platform sign-in with the code');
  assert.equal(viaPlatform.account.accountId, bob.accountId);
  assert.equal(viaPlatform.account.mfaEnabled, true);
  say('platform: asks for the code enrolled on the app, accepts it, same account id');

  // A spent invitation is spent on both sites; a registered inbox is registered on both.
  const other = browser();
  const spent = await other.platform.call('POST', '/api/auth/register', { email: addr('late1'), password: PASSWORD, inviteCode: alice.invites.first });
  assert.ok(spent.status >= 400 && spent.status < 500, `a spent invitation, on the platform: HTTP ${spent.status}`);
  const spentApp = await other.app.call('POST', '/api/auth/register', { email: addr('late2'), password: PASSWORD, inviteCode: alice.invites.first });
  assert.ok(spentApp.status >= 400 && spentApp.status < 500, `a spent invitation, on the app: HTTP ${spentApp.status}`);
  assert.equal(spent.data?.code, spentApp.data?.code, 'both sites give the same answer to a spent invitation');
  refused(await other.platform.call('POST', '/api/auth/register', { email: bob.email, password: PASSWORD, inviteCode: alice.invites.second }), 409, 'ERR_EMAIL_IN_USE', 'a registered inbox, on the platform');
  refused(await other.app.call('POST', '/api/auth/register', { email: `${mailbox('bob').replace(/\./g, '')}+x@gmail.com`, password: PASSWORD, inviteCode: alice.invites.second }), 409, 'ERR_EMAIL_IN_USE', 'a registered inbox in another spelling, on the app');
  say('a spent invitation and a registered inbox are refused alike on both sites');
}

// ── carol: registered on the PLATFORM, no second factor yet: signs in on the APP, enrols there, platform follows ──
const carol = { email: addr('carol'), b: browser() };
{
  const registered = ok(await carol.b.platform.call('POST', '/api/auth/register', { email: carol.email, password: PASSWORD, inviteCode: alice.invites.second }), 'register carol on the platform');
  carol.accountId = registered.account.accountId;
  carol.recovery = registered.recoveryCodes;
  const viaApp = ok(await carol.b.app.login(carol.email, PASSWORD), 'app sign-in, no second factor yet');
  assert.equal(viaApp.account.accountId, carol.accountId);
  assert.equal(viaApp.account.mfaEnabled, false);
  say('app: signs in an account that has no second factor yet (the app then offers to enrol)');

  carol.auth = new Authenticator(ok(await carol.b.app.call('POST', '/api/auth/mfa/setup', {}), 'app mfa setup').secret);
  ok(await carol.b.app.call('POST', '/api/auth/mfa/confirm', { totp: await carol.auth.code() }), 'app mfa confirm');
  const fresh = browser();
  refused(await fresh.platform.login(carol.email, PASSWORD), 401, 'ERR_MFA_REQUIRED', 'platform: enrolled on the app, so now required here');
  say('second factor enrolled on the app is required on the platform at once');
}

// ── a wallet linked on one site is the account's wallet on the other ────────────────────────────────────────────
{
  const { walletFromPhrase, signLinkChallenge } = await import('../web/signing.mjs');
  const config = ok(await bob.b.app.call('GET', '/api/auth/config'), 'config');
  const hrp = (await (await fetch(`${APP}/app-config.json`)).json()).addressHrp;
  void config;
  const wallet = walletFromPhrase(WORDS, hrp);
  const second = walletFromPhrase(OTHER_WORDS, hrp);
  const link = async (site, address, w) => {
    const challenge = await site.call('POST', '/api/wallet/link/challenge', { address });
    if (challenge.status !== 200) return challenge;
    if (challenge.data?.alreadyLinked) return challenge;
    return site.call('POST', '/api/wallet/link', signLinkChallenge({ wallet: w, message: challenge.data.message }));
  };
  // bob is signed in on the platform and (after the next line) on the app.
  const bobApp = new Site('app', APP);
  ok(await bobApp.login(bob.email, PASSWORD, await bob.auth.code()), 'bob signs in on the app');
  ok(await link(bobApp, wallet.address, wallet), 'link the wallet on the app');
  assert.equal(ok(await bob.b.platform.me(), 'platform /me').account.walletAddress, wallet.address, 'the platform sees the wallet linked on the app');
  assert.equal(ok(await bobApp.me(), 'app /me').account.walletAddress, wallet.address);
  refused(await bob.b.platform.call('POST', '/api/wallet/link/challenge', { address: second.address }), 409, 'ERR_WALLET_LOCKED', 'a second wallet on the platform');
  refused(await bobApp.call('POST', '/api/wallet/link/challenge', { address: second.address }), 409, 'ERR_WALLET_LOCKED', 'a second wallet on the app');
  const carolPlatform = new Site('platform', PLATFORM);
  carol.platformSession = carolPlatform;
  ok(await carolPlatform.login(carol.email, PASSWORD, await carol.auth.code()), 'carol signs in on the platform');
  const taken = await link(carolPlatform, wallet.address, wallet);
  assert.ok(taken.status >= 400 && taken.status < 500, `another account cannot link bob\u2019s wallet: HTTP ${taken.status} ${taken.text.slice(0, 200)}`);
  assert.equal(ok(await carolPlatform.me(), 'carol /me').account.walletAddress, undefined, 'carol did not get bob\u2019s wallet');
  say('a wallet linked on the app is the account\u2019s wallet on the platform; a second wallet is refused on both; nobody else can take it');
}

// ── recovery: a code spent on one site sets the password for every site ────────────────────────────────────────
{
  const NEW = 'a brand new long password 42';
  const site = new Site('app', APP);
  const recovered = ok(await site.call('POST', '/api/auth/recover', { email: carol.email, recoveryCode: carol.recovery[0], newPassword: NEW }), 'recover on the app');
  assert.equal(recovered.account.accountId, carol.accountId);
  assert.equal((await carol.platformSession.me()).status, 401, 'recovery on the app ended the session carol had open on the platform');
  refused(await site.call('POST', '/api/auth/recover', { email: carol.email, recoveryCode: carol.recovery[0], newPassword: `${NEW}x` }), 403, 'ERR_RECOVERY_INVALID', 'a spent recovery code, again');
  for (const [name, s] of Object.entries(browser())) {
    if (name === 'wallet') continue;
    refused(await s.login(carol.email, PASSWORD), 401, 'ERR_CREDENTIALS_INVALID', `${name}: the old password is dead`);
  }
  const platformSignIn = new Site('platform', PLATFORM);
  const attempt = await platformSignIn.login(carol.email, NEW);
  assert.ok(attempt.status === 200 || attempt.data?.code === 'ERR_MFA_REQUIRED', `the new password is accepted on the platform: HTTP ${attempt.status} ${attempt.text.slice(0, 200)}`);
  say(`recovery code spent on the app: the old password is dead on both sites; the new one is accepted on the platform (${attempt.status === 200 ? 'second factor was cleared by recovery' : 'second factor still required'})`);
}

// ── the wallet site has no accounts, and is not a door to the account API ──────────────────────────────────────
if (WALLET) {
  const w = new Site('wallet', WALLET);
  for (const [method, path, body] of [
    ['POST', '/api/auth/login', { email: bob.email, password: PASSWORD }],
    ['POST', '/api/auth/register', { email: addr('w'), password: PASSWORD, inviteCode: GENESIS }],
    ['GET', '/api/auth/me'],
    ['GET', '/api/auth/config'],
  ]) {
    const r = await w.call(method, path, body);
    assert.ok([403, 404].includes(r.status), `${method} ${path} on the wallet site: HTTP ${r.status}`);
  }
  assert.equal((await fetch(`${WALLET}/healthz`)).status, 200);
  const page = await fetch(`${WALLET}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>[^<]*Obsidian/i);
  say('wallet site: serves the wallet, refuses every account route (it unlocks with a local vault password, not an account)');
}

// ── a foreign origin cannot sign in on the platform ─────────────────────────────────────────────────────────────
{
  const p = new Site('platform', PLATFORM);
  const foreign = await p.call('POST', '/api/auth/login', { email: bob.email, password: PASSWORD }, { origin: 'https://evil.example' });
  assert.equal(foreign.status, 403, `a foreign origin: HTTP ${foreign.status}`);
  assert.equal(p.cookies.size, 0, 'no session for a foreign origin');
  say(`platform: a foreign Origin is refused outright (${foreign.data?.code ?? 'no code'}); the app reaches the platform only through its own proxy`);
}

console.log('e2e-accounts-everywhere: all steps passed');
