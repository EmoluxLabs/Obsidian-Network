/**
 * What the app does with each answer the platform can give to a sign-in.
 *
 * A 401 is not one thing. The platform answers 401 for a wrong password, for an unknown account, for "this account has a
 * second factor, send the code" and for "that code is wrong or already used" — and tells them apart only by `code`. An app
 * that treated every 401 as "wrong password" would send a user with the right password round in circles. This loads
 * the page's own module (real.mjs) against a minimal DOM and a routed `fetch`, presses the real SIGN IN handler, and
 * checks the request that left the page and the state it ended in, for every documented authentication error code.
 *
 * Synthetic identities only. Nothing leaves the process.
 */

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const BUNDLE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../public/js/obsidian.js');
const bundleBuilt = existsSync(BUNDLE_FILE);
if (bundleBuilt) {
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier === '/js/obsidian.js') return { url: ${JSON.stringify(pathToFileURL(BUNDLE_FILE).href)}, shortCircuit: true };
    return next(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
const opts = { skip: bundleBuilt ? false : 'run npm run build:web first' };

const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const timer = realSetInterval(fn, ms, ...rest);
  timer.unref?.();
  return timer;
};

const app = { innerHTML: '' };
const fields = new Map(); // id -> { value }
const elements = new Map([['app', app]]);
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
};
globalThis.window = globalThis;
globalThis.scrollTo = () => {};
globalThis.confirm = () => true;
globalThis.document = {
  readyState: 'complete',
  activeElement: null,
  body: { appendChild() {}, removeChild() {} },
  getElementById: (id) => fields.get(id) ?? elements.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => ({ style: {}, select() {}, remove() {} }),
  execCommand: () => true,
};

const json = (status, body) => {
  const text = JSON.stringify(body);
  return { ok: status < 400, status, text: async () => text, json: async () => body };
};

/** What the platform answers to the next POST /api/auth/login. */
let nextLogin = null;
/** The account the platform's cookie would resolve to; null = signed out. */
let session = null;
/** Every login body the page sent. */
const sent = [];

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target === '/app-config.json') return json(200, { network: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', production: false, verified: true, verification: 'ok' });
  if (target.startsWith('/api/auth/config')) {
    return json(200, { network: 'devnet', inviteOnly: true, authMethod: 'GMAIL_PASSWORD_MFA', emailDomains: ['gmail.com'], passwordMinLength: 12, mfaRequiredForMining: true, recoveryCodeCount: 10, maxInvitesPerAccount: 5, accountsExist: true, genesisInvite: { configured: true, redeemed: true } });
  }
  if (target === '/api/auth/login') {
    sent.push({ method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    if (typeof nextLogin === 'function') return nextLogin();
    return json(500, { error: 'unscripted', code: 'ERR_TEST' });
  }
  if (target.startsWith('/api/auth/me')) {
    return session ? json(200, { account: session }) : json(401, { error: 'sign in required', code: 'ERR_UNAUTHORIZED' });
  }
  return json(404, { error: 'not found', code: 'ERR_NOT_FOUND' });
};

let real;
before(async () => {
  if (!bundleBuilt) return;
  real = await import('../public/real.mjs');
  for (let i = 0; i < 100 && !real.state.config; i += 1) await new Promise((r) => setTimeout(r, 10));
});

function typeInto({ email = 'First.User@Gmail.com', password = 'synthetic-Passw0rd-one', totp } = {}) {
  fields.clear();
  fields.set('em', { value: email });
  fields.set('pw', { value: password });
  if (totp !== undefined) fields.set('mf', { value: totp });
}

beforeEach(() => {
  sent.length = 0;
  nextLogin = null;
  session = null;
  if (real) {
    real.state.error = '';
    real.state.mfaRequired = false;
    real.state.account = null;
    real.go('signin');
  }
});

test('the sign-in request carries the email trimmed and the password exactly as typed — no trim, no case change, no NFKC', opts, async () => {
  const typed = ' my "odd" pässwörd ｆｕｌｌ 9 '; // spaces at both ends are the user's to keep
  typeInto({ email: '  First.User@Gmail.com  ', password: typed });
  nextLogin = () => json(401, { error: 'those credentials are not valid', code: 'ERR_CREDENTIALS_INVALID' });
  await window.ObsidianSignin();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].body.email, 'First.User@Gmail.com');
  assert.equal(sent[0].body.password, typed);
  assert.equal('totp' in sent[0].body, false, 'no code is sent until one is asked for');
});

test('ERR_MFA_REQUIRED is a request for a code, not a wrong password', opts, async () => {
  typeInto();
  nextLogin = () => json(401, { error: 'an MFA code is required', code: 'ERR_MFA_REQUIRED' });
  await window.ObsidianSignin();
  assert.equal(real.state.mfaRequired, true);
  assert.match(real.state.error, /authenticator/i);
  assert.doesNotMatch(real.state.error, /credentials|password is/i);
  assert.match(app.innerHTML, /AUTHENTICATOR CODE/, 'the code field appears');
  assert.equal(real.state.screen, 'signin');
});

test('the code is sent with the second attempt, and success signs in', opts, async () => {
  typeInto();
  nextLogin = () => json(401, { error: 'an MFA code is required', code: 'ERR_MFA_REQUIRED' });
  await window.ObsidianSignin();
  typeInto({ totp: ' 123456 ' });
  const account = { accountId: 'acc_x', email: 'first.user@gmail.com', mfaEnabled: true };
  nextLogin = () => {
    session = account;
    return json(200, { account, bootstrapped: false });
  };
  await window.ObsidianSignin();
  assert.equal(sent[1].body.totp, '123456');
  assert.equal(sent[1].body.password, 'synthetic-Passw0rd-one');
  assert.equal(real.state.account?.accountId, 'acc_x');
  assert.equal(real.state.mfaRequired, false);
  assert.equal(real.state.screen, 'home');
});

test('each remaining code is explained with the platform\u2019s own words, and none is shown as something else', opts, async () => {
  const cases = [
    [401, 'ERR_CREDENTIALS_INVALID', 'those credentials are not valid'],
    [400, 'ERR_BAD_REQUEST', 'the sign-in request was empty or malformed: it must be a JSON body with an email and a password'],
    [401, 'ERR_MFA_INVALID', 'MFA rejected: that code is not valid'],
    [401, 'ERR_MFA_INVALID', 'MFA rejected: that code has already been used'],
    [429, 'ERR_TOO_MANY_ATTEMPTS', 'too many failed attempts from this address; try again later'],
    [429, 'ERR_RATE_LIMITED', 'too many requests; slow down'],
    [403, 'ERR_ACCOUNT_SUSPENDED', 'this account is suspended'],
    [403, 'ERR_ORIGIN_NOT_ALLOWED', 'this request did not come from this app'],
    [503, 'ERR_NETWORK_MISMATCH', 'this app is the mainnet app, but its platform is not on mainnet'],
  ];
  for (const [status, code, message] of cases) {
    typeInto({ totp: '123456' });
    nextLogin = () => json(status, { error: message, code });
    await window.ObsidianSignin();
    assert.equal(real.state.error, message, code);
    assert.equal(real.state.account, null, code);
    assert.equal(real.state.screen, 'signin', code);
  }
});

test('an unreachable platform, an HTML error page and a dropped connection are said as such, never as a wrong password', opts, async () => {
  typeInto();
  nextLogin = () => json(502, { error: 'the Obsidian platform could not be reached', code: 'ERR_PLATFORM_UNREACHABLE' });
  await window.ObsidianSignin();
  assert.match(real.state.error, /could not be reached/);
  assert.doesNotMatch(real.state.error, /credential|password/i);

  typeInto();
  nextLogin = async () => ({ ok: false, status: 502, text: async () => '<html>Bad gateway</html>', json: async () => { throw new Error('not json'); } });
  await window.ObsidianSignin();
  assert.match(real.state.error, /HTTP 502 from \/api\/auth\/login/);

  typeInto();
  nextLogin = async () => { throw new TypeError('fetch failed'); };
  await window.ObsidianSignin();
  assert.match(real.state.error, /fetch failed/);
  assert.equal(real.state.account, null);
});

test('with an empty field nothing is sent', opts, async () => {
  typeInto({ password: '' });
  await window.ObsidianSignin();
  assert.equal(sent.length, 0);
  assert.match(real.state.error, /email and password/i);
});
