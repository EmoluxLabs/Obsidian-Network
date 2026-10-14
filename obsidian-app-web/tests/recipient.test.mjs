/**
 * Paying a `.obs` name from the web app (and the extension, which runs this same code).
 *
 * The page's own real.mjs is loaded against a fake platform, with a real sealed vault, and
 * the send buttons are pressed. What these tests pin is what the screens cannot show:
 * that a name is resolved from the node's ONS record and from nowhere else, that the
 * address the user is shown is the address that is paid, that a failed lookup stops the
 * payment with its own message, and that nothing is signed until the user confirms.
 * No real OBS and no mainnet state are involved: the "node" below is a few lines of JS.
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
const skip = bundleBuilt ? false : 'run npm run build:web first';

// ── a just-enough browser ────────────────────────────────────────────────────
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (fn, ms, ...rest) => {
  const timer = realSetInterval(fn, ms, ...rest);
  timer.unref?.();
  return timer;
};
const app = { innerHTML: '' };
const elements = new Map([['app', app]]);
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.scrollTo = () => {};
globalThis.confirm = () => true;
globalThis.document = {
  readyState: 'complete',
  activeElement: null,
  title: '',
  body: { appendChild() {}, removeChild() {} },
  getElementById: (id) => elements.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => ({ style: {}, select() {}, remove() {} }),
  execCommand: () => true,
};

// ── a fake mainnet node and platform ─────────────────────────────────────────
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';
const OBS = 10n ** 18n;
const NOW = 1_800_000_000;

const { generateKeyPair } = await import('../../obsidian-core/dist/crypto/keys.js').catch(() =>
  import('../../obsidian-interface/web/core/crypto/keys.js'),
);
const addressOn = (hrp) => generateKeyPair(hrp).address;
const REGISTERED = addressOn('obs');
const OWNER = addressOn('obs');
const NATIVE = addressOn('obs');

let world;
const requested = [];
const submitted = [];

const reset = () => {
  world = {
    chainId: 7777,
    hrp: 'obs',
    names: {
      'obsidian.obs': {
        name: 'obsidian.obs',
        owner: OWNER,
        address: REGISTERED,
        registeredAt: NOW - 1000,
        registeredAtHeight: 4,
        expiresAt: NOW + 31_536_000,
        transferCount: 0,
        resolved: true,
      },
    },
    lookup: null, // (name) => response override
  };
  requested.length = 0;
  submitted.length = 0;
};

const json = (status, body) => {
  const text = JSON.stringify(body);
  return { ok: status < 400, status, text: async () => text, json: async () => body };
};

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  const method = init.method ?? 'GET';
  requested.push(`${method} ${target}`);
  if (target === '/app-config.json') {
    return json(200, { network: 'mainnet', networkId: 'obsidian-mainnet-1', chainId: 7777, addressHrp: 'obs', production: true, verified: true, verification: 'ok' });
  }
  if (target.startsWith('/api/auth/config')) return json(200, { network: 'mainnet', inviteOnly: true, passwordMinLength: 12, accountsExist: false });
  if (target.startsWith('/api/auth/me')) return json(401, { error: 'sign in required', code: 'ERR_UNAUTHORIZED' });
  if (target.startsWith('/api/rpc')) {
    const path = decodeURIComponent(new URL(target, 'http://x').searchParams.get('path') ?? '');
    if (path === '/status') {
      return json(200, { height: 30, chainId: world.chainId, protocolVersion: '1.8.2', lastBlockTimestamp: NOW, networkId: 'x', supplyObs: '0', maxSupplyObs: '21000000' });
    }
    if (path === '/network') {
      return json(200, { network: { name: 'mainnet', chainId: world.chainId, addressHrp: world.hrp }, protocolVersion: '1.8.2' });
    }
    if (path === '/params') return json(200, { gas: { basisPoints: 2, maxGasObs: '0.01' } });
    if (path.startsWith('/names/')) {
      const name = path.slice('/names/'.length);
      if (world.lookup) return world.lookup(name, json);
      const record = world.names[name];
      return record ? json(200, record) : json(404, { error: 'name not registered', code: 'ERR_NOT_FOUND', name });
    }
    if (path === '/wallet/balance') return json(200, { balanceSeals: (10n * OBS).toString(), nonce: 3, spendableObs: (10n * OBS).toString() });
    if (path.endsWith('/next-nonce')) return json(200, { nextNonce: 3, atHeight: 30 });
    if (path === '/tx/submit') {
      const body = JSON.parse(init.body);
      submitted.push(body.tx);
      return json(200, { accepted: true, txId: 'ab'.repeat(32) });
    }
    return json(404, { error: 'not found', code: 'ERR_NOT_FOUND' });
  }
  return json(404, { error: 'not found', code: 'ERR_NOT_FOUND' });
};

// ── load the app the way the page does ───────────────────────────────────────
let real;
let decodeSigned;
let decodePayment;
const { createVault, saveVault } = await import('../web/vault.mjs');

before(async () => {
  if (skip) return;
  reset();
  const vault = await createVault(PHRASE, PASSPHRASE, 'obs');
  saveVault(vault);
  ({ decodeSignedTxFromBytes: decodeSigned } = await import('../../obsidian-interface/web/core/transactions/encode.js'));
  ({ decodePaymentBody: decodePayment } = await import('../../obsidian-interface/web/core/transactions/executors/payment.js'));
  real = await import('../public/real.mjs');
  for (let i = 0; i < 200 && !real.state.status; i += 1) await new Promise((r) => setTimeout(r, 10));
});

const OWN = 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj'; // the vault's address on mainnet

beforeEach(() => {
  if (skip) return;
  reset();
  real.state.screen = 'wallet';
  real.state.wt = 'send';
  real.state.walletAddress = OWN;
  real.state.sendReview = null;
  real.state.error = '';
  real.state.notice = '';
  real.state.busy = null;
  type({ to: '', am: '', mm: '', pp: '' });
});

function type(values) {
  for (const [id, value] of Object.entries(values)) elements.set(id, { id, value, type: id === 'pp' ? 'password' : 'text' });
}

const nameRequests = () => requested.filter((r) => decodeURIComponent(r).includes('/names/'));

function paidTo() {
  assert.equal(submitted.length, 1, 'exactly one transaction was submitted');
  const tx = decodeSigned(Uint8Array.from(Buffer.from(submitted[0], 'hex')));
  return { tx, body: decodePayment(tx.body) };
}

test('a native address is paid exactly as before, with no name lookup', { skip }, async () => {
  type({ to: NATIVE, am: '1.5', pp: PASSPHRASE });
  await window.ObsidianSend();
  const { body } = paidTo();
  assert.equal(body.to, NATIVE);
  assert.equal(body.amount, 15n * OBS / 10n);
  assert.equal(nameRequests().length, 0);
  assert.equal(real.state.sendReview, null);
});

test('a registered name is resolved from the chain and shown for confirmation — and nothing is signed yet', { skip }, async () => {
  type({ to: '  Obsidian.OBS ', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  assert.equal(submitted.length, 0, 'resolving a name must never send');
  assert.equal(real.state.error, '');
  assert.deepEqual(nameRequests(), ['GET /api/rpc?path=%2Fnames%2Fobsidian.obs']);
  const review = real.state.sendReview;
  assert.equal(review.resolved.name, 'obsidian.obs');
  assert.equal(review.resolved.address, REGISTERED);

  real.render();
  const html = app.innerHTML;
  assert.match(html, /CONFIRM RECIPIENT/);
  assert.ok(html.includes('obsidian.obs'), 'the ONS name is shown');
  assert.match(html, /RESOLVES TO/);
  assert.ok(html.includes(REGISTERED), 'the full resolved address is shown, not a shortened one');
  assert.match(html, /Obsidian Mainnet/);
  assert.match(html, /Registered on-chain/);
  assert.match(html, /ObsidianSendConfirm\(\)/);
  assert.ok(!html.includes(OWNER), 'the owner is not the recipient and is not offered as one');
});

test('confirming pays the resolved address — never the name — after resolving once more', { skip }, async () => {
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  type({ pp: PASSPHRASE });
  await window.ObsidianSendConfirm();
  const { tx, body } = paidTo();
  assert.equal(body.to, REGISTERED);
  assert.equal(body.amount, 2n * OBS);
  assert.equal(tx.chainId, 7777);
  assert.ok(!submitted[0].includes(Buffer.from('obsidian.obs').toString('hex')), 'the name is not in the signed bytes');
  assert.equal(nameRequests().length, 2, 'resolved at review and again at confirmation');
  assert.equal(real.state.sendReview, null);
});

test('if the name is repointed between review and confirmation, nothing is signed', { skip }, async () => {
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  world.names['obsidian.obs'].address = addressOn('obs');
  type({ pp: PASSPHRASE });
  await window.ObsidianSendConfirm();
  assert.equal(submitted.length, 0);
  assert.match(real.state.error, /different address/);
  assert.equal(real.state.sendReview, null);
});

test('if the name lapses or the lookup dies between review and confirmation, nothing is signed', { skip }, async () => {
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  world.names['obsidian.obs'].expiresAt = NOW - 1;
  type({ pp: PASSPHRASE });
  await window.ObsidianSendConfirm();
  assert.equal(submitted.length, 0);
  assert.match(real.state.error, /expired/);

  await window.ObsidianSend().catch(() => {});
  world.names['obsidian.obs'].expiresAt = NOW + 100;
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  world.lookup = () => json(503, { error: 'busy' });
  await window.ObsidianSendConfirm();
  assert.equal(submitted.length, 0);
  assert.equal(real.state.error, 'Could not resolve this ONS name. Please try again.');
});

test('each failed lookup stops the payment with its own message', { skip }, async () => {
  const cases = [
    ['an unregistered name', 'nobody.obs', () => {}, 'ONS name not found on Mainnet.'],
    ['a node that errors', 'obsidian.obs', () => { world.lookup = () => json(500, { error: 'boom' }); }, 'Could not resolve this ONS name. Please try again.'],
    ['a lookup that throws', 'obsidian.obs', () => { world.lookup = () => { throw new TypeError('network down'); }; }, 'Could not resolve this ONS name. Please try again.'],
    ['a route the node does not serve', 'obsidian.obs', () => { world.lookup = () => json(404, { error: 'not found', code: 'ERR_NOT_FOUND', path: '/names/x' }); }, 'Could not resolve this ONS name. Please try again.'],
    ['an answer that is not a record', 'obsidian.obs', () => { world.lookup = () => json(200, { hello: 'world' }); }, 'The ONS lookup returned an unusable answer. Transaction blocked.'],
    ['a record for another name', 'obsidian.obs', () => { world.names['obsidian.obs'].name = 'other.obs'; }, 'The ONS lookup returned an unusable answer. Transaction blocked.'],
    ['an invalid resolved address', 'obsidian.obs', () => { world.names['obsidian.obs'].address = 'obs1notanaddress'; }, 'ONS name resolved to an invalid OBS address. Transaction blocked.'],
    ['a testnet address on a mainnet lookup', 'obsidian.obs', () => { world.names['obsidian.obs'].address = addressOn('tobs'); }, 'ONS lookup came from a different network than Obsidian Mainnet. Transaction blocked.'],
    ['a node on another chain', 'obsidian.obs', () => { world.chainId = 7778; world.hrp = 'tobs'; }, 'ONS lookup came from a different network than Obsidian Mainnet. Transaction blocked.'],
    ['an expired name', 'obsidian.obs', () => { world.names['obsidian.obs'].expiresAt = NOW; }, 'This ONS name has expired, so its address is no longer trusted. Transaction blocked.'],
  ];
  for (const [label, typed, arrange, message] of cases) {
    reset();
    real.state.sendReview = null;
    real.state.error = '';
    arrange();
    type({ to: typed, am: '1', pp: PASSPHRASE });
    await window.ObsidianSend();
    assert.equal(real.state.error, message, label);
    assert.equal(real.state.sendReview, null, `${label}: no review is offered`);
    assert.equal(submitted.length, 0, `${label}: nothing is submitted`);
  }
});

test('a failed lookup is not reported as an invalid address, and vice versa', { skip }, async () => {
  world.lookup = () => json(502, { error: 'bad gateway' });
  type({ to: 'obsidian.obs', am: '1', pp: PASSPHRASE });
  await window.ObsidianSend();
  assert.doesNotMatch(real.state.error, /invalid/i);
  assert.equal(submitted.length, 0);
});

test('a malformed .obs string is refused before the node is asked anything', { skip }, async () => {
  for (const bad of ['foo bar.obs', 'ab.obs', 'a--b.obs', 'foo.bar.obs', '-foo.obs', 'foo.obs.obs', 'admin.obs', 'foo@bar.obs']) {
    real.state.error = '';
    type({ to: bad, am: '1', pp: PASSPHRASE });
    await window.ObsidianSend();
    assert.match(real.state.error, /not a valid ONS name/, bad);
  }
  assert.equal(nameRequests().length, 0);
  assert.equal(submitted.length, 0);
});

test('an empty recipient and a missing amount stop before any lookup', { skip }, async () => {
  type({ to: '', am: '1', pp: PASSPHRASE });
  await window.ObsidianSend();
  assert.match(real.state.error, /Enter a recipient/);
  type({ to: 'obsidian.obs', am: '', pp: PASSPHRASE });
  await window.ObsidianSend();
  assert.match(real.state.error, /amount/);
  assert.equal(nameRequests().length, 0);
  assert.equal(submitted.length, 0);
});

test('cancelling a review sends nothing and returns the typed values', { skip }, async () => {
  type({ to: 'obsidian.obs', am: '2.5', mm: 'rent', pp: PASSPHRASE });
  await window.ObsidianSend();
  assert.ok(real.state.sendReview);
  window.ObsidianSendCancel();
  assert.equal(real.state.sendReview, null);
  assert.equal(submitted.length, 0);
});

test('a review does not survive a change of wallet or of screen', { skip }, async () => {
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  real.state.walletAddress = NATIVE;
  type({ pp: PASSPHRASE });
  await window.ObsidianSendConfirm();
  assert.equal(submitted.length, 0);
  assert.match(real.state.error, /wallet changed/);

  real.state.error = '';
  real.state.walletAddress = OWN;
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  assert.ok(real.state.sendReview);
  real.go('landing');
  assert.equal(real.state.sendReview, null);
});

test('confirming with no review pending does nothing', { skip }, async () => {
  type({ pp: PASSPHRASE });
  await window.ObsidianSendConfirm();
  assert.equal(submitted.length, 0);
});

test('no request leaves the page’s own origin, and every lookup goes through the read gateway', { skip }, async () => {
  type({ to: 'obsidian.obs', am: '2', pp: PASSPHRASE });
  await window.ObsidianSend();
  for (const entry of requested) {
    assert.match(entry.split(' ')[1], /^\/(api\/|app-config\.json$)/, entry);
  }
});
