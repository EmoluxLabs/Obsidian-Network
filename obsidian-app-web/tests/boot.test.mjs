/**
 * Does the app actually start?
 *
 * Every other test imports a piece. None of them imports the one file the page
 * loads, so none of them could notice that public/wallet.mjs had two functions
 * called `run` — a SyntaxError that stops a module from linking, which stops
 * real.mjs, which leaves the page quietly running the design's demo script with its
 * invented balances. Nothing logged an error anyone would see in a shipped build,
 * and a hand-written copy of every screen would still have rendered.
 *
 * This file loads real.mjs exactly as the browser does — as a module, against a
 * minimal DOM and a routed `fetch` — and asserts the observable result: it installs
 * itself, boots against the platform, and renders every screen without leaking
 * `undefined`, `NaN`, or `[object Object]` into the markup.
 *
 * There is no jsdom here on purpose: the app ships no dependencies and the test
 * suite should not be the thing that adds the first.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The page imports '/js/obsidian.js' — an absolute URL the web server answers and
// Node cannot. A resolve hook maps it to the built bundle so the page's own code,
// unmodified, can be run here. No test hook lives in production code.
const BUNDLE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../public/js/obsidian.js');
const bundleBuilt = existsSync(BUNDLE_FILE);
if (bundleBuilt) {
  const hooks = `export async function resolve(specifier, context, next) {
    if (specifier === '/js/obsidian.js') return { url: ${JSON.stringify(pathToFileURL(BUNDLE_FILE).href)}, shortCircuit: true };
    return next(specifier, context);
  }`;
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
const needsBundle = { skip: bundleBuilt ? false : 'run npm run build:web first' };

// ── a just-enough browser ────────────────────────────────────────────────────

const realSetInterval = globalThis.setInterval;
// The app polls. A poll that outlives the test keeps the process alive forever.
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
  body: { appendChild() {}, removeChild() {} },
  getElementById: (id) => elements.get(id) ?? null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => ({ style: {}, select() {}, remove() {} }),
  execCommand: () => true,
};

// ── a platform that tells the truth about a small chain ──────────────────────

const NETWORK = {
  network: {
    name: 'devnet',
    networkId: 'obsidian-devnet-1',
    chainId: 7780,
    addressHrp: 'dobs',
    displayName: 'OBS Devnet',
    isProduction: false,
  },
  protocolVersion: '1.6.1',
  genesisId: '1e7ca102f6720a7682e9a396958f2a17330dc001',
};

const STATUS = {
  height: 30,
  headHash: 'ab'.repeat(32),
  networkId: 'obsidian-devnet-1',
  chainId: 7780,
  protocolVersion: '1.6.1',
  lastBlockTimestamp: 1_791_540_204,
  finalizedHeight: 28,
  peers: 0,
  activeMiners: 0,
  supplyObs: '0.000000000000000000',
  maxSupplyObs: '21000000.000000000000000000',
};

const PARAMS = {
  protocolVersion: '1.6.1',
  mining: { claimIntervalSeconds: 14400, maxClaimsPerCycle: 6, cycleSeconds: 86400 },
  gas: { basisPoints: 2, maxGasObs: '0.010000000000000000' },
  ons: { registrationFeeObs: '0.050000000000000000', renewalFeeObs: '0.050000000000000000', termSeconds: 31536000, minLength: 3, maxLength: 63 },
};

const CONFIG = {
  network: 'devnet',
  inviteOnly: true,
  authMethod: 'GMAIL_PASSWORD_MFA',
  emailDomains: ['gmail.com'],
  passwordMinLength: 12,
  mfaRequiredForMining: true,
  recoveryCodeCount: 10,
  maxInvitesPerAccount: 5,
  accountsExist: false,
  genesisInvite: { configured: false, redeemed: false },
};

const BLOCKS = {
  blocks: [{ height: 30, hash: 'cd'.repeat(32), timestamp: 1_791_540_204, transactions: 0, miner: 'dobs1qq' }],
};

const requested = [];

function json(status, body) {
  const text = JSON.stringify(body);
  return { ok: status < 400, status, text: async () => text, json: async () => body };
}

globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  requested.push(`${init.method ?? 'GET'} ${target}`);
  if (target === '/app-config.json') {
    return json(200, { network: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', production: false, verified: true, verification: 'ok' });
  }
  if (target.startsWith('/api/auth/config')) return json(200, CONFIG);
  if (target.startsWith('/api/auth/me')) return json(401, { error: 'sign in required', code: 'ERR_UNAUTHORIZED' });
  if (target.startsWith('/api/rpc')) {
    const path = decodeURIComponent(new URL(target, 'http://x').searchParams.get('path') ?? '');
    if (path === '/block/82') return json(200, { height: 82, hash: 'ab'.repeat(32), transactions: [] });
    if (path === '/status') return json(200, STATUS);
    if (path === '/network') return json(200, NETWORK);
    if (path === '/params') return json(200, PARAMS);
    if (path.startsWith('/blocks')) return json(200, BLOCKS);
    if (path.startsWith('/mining/schedule')) return json(200, { claimIntervalSeconds: 14400 });
  }
  return json(404, { error: 'not found', code: 'ERR_NOT_FOUND' });
};

// ── load the app the way the page does ───────────────────────────────────────

let real;

before(async () => {
  real = await import('../public/real.mjs');
  // boot() is async and fire-and-forget by design: wait for its first paint.
  for (let i = 0; i < 200 && !real.state.status; i += 1) {
    await new Promise((r) => setTimeout(r, 10));
  }
});

const LEAKS = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\bnull\b(?![-\w])/];

function assertClean(html, label) {
  assert.ok(html.length > 100, `${label} rendered almost nothing`);
  for (const leak of LEAKS) {
    const hit = html.match(new RegExp(`.{0,40}${leak.source}.{0,40}`));
    assert.equal(hit, null, `${label} leaked ${leak}: …${hit?.[0]}…`);
  }
}

test('real.mjs links and installs itself over the design', () => {
  assert.equal(typeof window.render, 'function', 'window.render must be replaced');
  assert.equal(typeof window.go, 'function', 'window.go must be replaced');
  for (const name of ['claim', 'send', 'buy', 'startM', 'onsq']) {
    assert.equal(typeof window[name], 'function', `${name} must exist, as a refusal`);
  }
});

test('it boots against the platform and holds the node’s own numbers', () => {
  assert.equal(real.state.status.height, 30);
  assert.equal(real.state.network.network.addressHrp, 'dobs');
  assert.ok(requested.some((r) => r.includes('/api/auth/config')), 'asked the platform for its auth config');
  assert.ok(requested.some((r) => r.includes('status')), 'asked a node for the chain status');
});

test('no request leaves the page’s own origin', () => {
  // The browser must never learn where the platform lives, and must never call
  // localhost: every URL is relative.
  for (const entry of requested) {
    const url = entry.split(' ')[1];
    assert.match(url, /^\/(api\/|app-config\.json$)/, `${entry} is not one of this origin's own routes`);
  }
});

test('every screen renders without leaking an unset value', () => {
  const screens = ['landing', 'signup', 'signin', 'recover', 'explorer', 'ons', 'api', 'wallet', 'home', 'mine', 'menu'];
  for (const name of screens) {
    real.go(name);
    // Signed-out visitors are sent to sign-in from account screens; that screen
    // must be clean too, so whatever is on screen is what is checked.
    assertClean(app.innerHTML, `${name} (showing ${real.state.screen})`);
  }
});

test('the explorer shows the node’s height, not a number made up from the clock', () => {
  real.go('explorer');
  assert.match(app.innerHTML, /30/);
  assert.doesNotMatch(app.innerHTML, /No match in this demo/);
});

test('a screen that does not exist is a way home, never a demo screen', () => {
  real.go('node');
  assert.equal(real.state.screen, 'landing');
});

test('a signed-out visitor cannot reach an account screen', () => {
  for (const name of ['home', 'mine', 'menu']) {
    real.go(name);
    assert.equal(real.state.screen, 'signin', name);
  }
});

test('an unreachable platform is said so on screen, with no invented chain', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => json(502, { error: 'The Obsidian platform could not be reached.', code: 'ERR_PLATFORM_UNREACHABLE' });
  try {
    real.state.status = null;
    real.state.network = null;
    await real.refresh();
    real.go('explorer');
    assertClean(app.innerHTML, 'explorer with no platform');
    assert.doesNotMatch(app.innerHTML, /#\s*30\b/, 'the previous height must not linger as if current');
  } finally {
    globalThis.fetch = original;
  }
});

// ── the wallet bridge, against the same platform ─────────────────────────────

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Addresses produced by running obsidian-core's deriveWallet with each network's
// addressHrp. They are outputs of the canonical code, not recollections.
const BY_NETWORK = {
  obs: 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj',
  tobs: 'tobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rgcp8kr',
  sobs: 'sobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66ra0j5mt',
  dobs: 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0',
};

test('the context carries the node’s address prefix, and refuses to guess one', async () => {
  const wallet = await import('../public/wallet.mjs');
  const context = await wallet.getContext();
  assert.equal(context.addressHrp, 'dobs');
  assert.equal(context.chainId, 7780);

  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = decodeURIComponent(new URL(String(url), 'http://x').searchParams.get('path') ?? '');
    if (path === '/network') return json(200, { network: { chainId: 7780 }, protocolVersion: '1.6.1' });
    return original(url, init);
  };
  try {
    await assert.rejects(wallet.getContext(), /address prefix/);
  } finally {
    globalThis.fetch = original;
  }
});

test('the wallet is set up under the connected network’s prefix', needsBundle, async () => {
  const wallet = await import('../public/wallet.mjs');
  const address = await wallet.addressForPhrase(PHRASE);
  assert.equal(address, BY_NETWORK.dobs, 'a devnet node must be shown a dobs address');
});

test('a cached address is re-encoded for the connected network, without a passphrase', needsBundle, async () => {
  const wallet = await import('../public/wallet.mjs');
  localStorage.setItem('obsidian.address', BY_NETWORK.obs);

  assert.equal(await wallet.addressOnNetwork(BY_NETWORK.obs, 'dobs'), BY_NETWORK.dobs);
  assert.equal(localStorage.getItem('obsidian.address'), BY_NETWORK.dobs, 'the cache is updated, so this runs once');
  assert.equal(await wallet.addressOnNetwork(BY_NETWORK.dobs, 'obs'), BY_NETWORK.obs, 'and it round-trips');
  assert.equal(await wallet.addressOnNetwork(BY_NETWORK.obs, 'tobs'), BY_NETWORK.tobs);
  assert.equal(await wallet.addressOnNetwork(null, 'dobs'), null);
});

test('an address already under the right prefix is returned untouched', async () => {
  const wallet = await import('../public/wallet.mjs');
  assert.equal(await wallet.addressOnNetwork(BY_NETWORK.sobs, 'sobs'), BY_NETWORK.sobs);
});

test('the nonce is read from the dedicated route under the name it is sent as', async () => {
  const wallet = await import('../public/wallet.mjs');
  const original = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url, init) => {
    const path = decodeURIComponent(new URL(String(url), 'http://x').searchParams.get('path') ?? '');
    asked.push(path);
    if (path.endsWith('/next-nonce')) return json(200, { address: BY_NETWORK.dobs, nextNonce: 9, atHeight: 70 });
    // A different number from the balance route, so reading the wrong route shows.
    if (path.startsWith('/wallet/balance')) return json(200, { nonce: 4 });
    return original(url, init);
  };
  try {
    assert.equal(await wallet.getNonce(BY_NETWORK.dobs), 9);
    assert.ok(!asked.some((p) => p.startsWith('/wallet/balance')), 'the fallback must not be needed');
  } finally {
    globalThis.fetch = original;
  }
});


// ── creating a wallet ────────────────────────────────────────────────────────

function typeInto(values) {
  for (const [id, value] of Object.entries(values)) elements.set(id, { value });
}

function clearFields() {
  for (const id of [...elements.keys()]) if (id !== 'app') elements.delete(id);
}

test('a person with no wallet is offered CREATE first, and the phrase is shown only after asking', needsBundle, async () => {
  localStorage.removeItem('obsidian.vault.v1');
  localStorage.removeItem('obsidian.address');
  real.state.walletAddress = null;
  real.state.wt = 'setup';
  real.state.setup = { mode: 'create', draft: null };
  real.state.screen = 'wallet';
  real.render();
  assert.match(app.innerHTML, /CREATE NEW/);
  assert.match(app.innerHTML, /GENERATE MY RECOVERY PHRASE/);
  assert.doesNotMatch(app.innerHTML, /WORD #/, 'nothing to prove before a phrase exists');

  await window.ObsidianGeneratePhrase();
  const { words, check } = real.state.setup.draft;
  assert.equal(words.length, 24, 'a 256-bit phrase is 24 words');
  assert.equal(check.length, 3);
  assert.equal(new Set(check).size, 3, 'three different positions');
  assert.deepEqual([...check], [...check].sort((a, b) => a - b), 'asked in order');
  assert.ok(check.every((n) => n >= 1 && n <= 24));
  for (const n of check) assert.match(app.innerHTML, new RegExp(`WORD #${n}\\b`));
  assert.ok(words.every((w) => app.innerHTML.includes(`>${w}<`)), 'all 24 words are on screen');
  assert.equal(JSON.stringify([...store.entries()]).includes(words[0] + ' ' + words[1]), false, 'nothing is stored yet');
});

test('the phrase is not sealed until the words are proven, and the refusal does not say which was wrong', needsBundle, async () => {
  const { words, check } = real.state.setup.draft;
  typeInto({ cw0: words[check[0] - 1], cw1: 'wrong', cw2: words[check[2] - 1], pp: 'a long vault passphrase 42', p2: 'a long vault passphrase 42' });
  await window.ObsidianSetupWallet();
  assert.match(real.state.error, /do not match/);
  assert.doesNotMatch(real.state.error, new RegExp(`#?${check[1]}\\b`), 'it does not point at the wrong word');
  assert.equal(localStorage.getItem('obsidian.vault.v1'), null, 'nothing was sealed');
  assert.ok(real.state.setup.draft, 'the phrase is kept so the person can try again');
});

test('a short passphrase is refused even with the right words', needsBundle, async () => {
  const { words, check } = real.state.setup.draft;
  typeInto({ cw0: words[check[0] - 1], cw1: words[check[1] - 1], cw2: words[check[2] - 1], pp: 'short', p2: 'short' });
  await window.ObsidianSetupWallet();
  assert.match(real.state.error, /at least 12/);
  assert.equal(localStorage.getItem('obsidian.vault.v1'), null);
});

test('the right words and a passphrase seal exactly the phrase that was shown', needsBundle, async () => {
  const wallet = await import('../public/wallet.mjs');
  const { words, check } = real.state.setup.draft;
  const shown = words.join(' ');
  typeInto({ cw0: words[check[0] - 1].toUpperCase(), cw1: words[check[1] - 1], cw2: words[check[2] - 1], pp: 'a long vault passphrase 42', p2: 'a long vault passphrase 42' });
  await window.ObsidianSetupWallet();
  assert.equal(real.state.error, '');
  assert.match(real.state.walletAddress, /^dobs1/, 'a devnet address, from the connected network');
  assert.equal(real.state.setup.draft, null, 'the phrase is dropped from memory once sealed');
  assert.ok(localStorage.getItem('obsidian.vault.v1'), 'sealed in the platform’s vault format');
  assert.equal(JSON.stringify([...store.entries()]).includes(words[0]), false, 'the phrase is not in storage in the clear');
  assert.equal(await wallet.addressForPhrase(shown), real.state.walletAddress, 'the address belongs to the phrase that was shown');
  clearFields();
});

test('leaving the wallet screen drops a phrase that was never sealed', needsBundle, async () => {
  localStorage.removeItem('obsidian.vault.v1');
  localStorage.removeItem('obsidian.address');
  real.state.walletAddress = null;
  real.state.setup = { mode: 'create', draft: null };
  await window.ObsidianGeneratePhrase();
  assert.ok(real.state.setup.draft);
  real.go('explorer');
  assert.equal(real.state.setup.draft, null);
  real.go('wallet');
  assert.equal(real.state.wt, 'setup', 'with no wallet the Wallet screen opens on creation, not an empty Send form');
});

// ── the explorer's search ────────────────────────────────────────────────────

test('searching a pasted address is refused and never asks the node about it', async () => {
  const before = requested.length;
  await window.ObsidianSearch(BY_NETWORK.dobs);
  assert.match(real.state.error, /not searchable/);
  assert.equal(requested.slice(before).some((r) => /address|wallet/.test(r)), false);
});

test('searching a height reads that block', async () => {
  const before = requested.length;
  await window.ObsidianSearch('82');
  assert.ok(requested.slice(before).some((r) => decodeURIComponent(r).includes('/block/82')));
  assert.equal(real.state.ex.detail?.kind, 'block');
});

// ── receive shows a QR; send can scan one ────────────────────────────────────

test('RECEIVE shows the wallet’s QR code and address, and the code reads back as that address', needsBundle, async () => {
  const { decodeQr } = await import('../web/qr.mjs');
  const { modulesFromSvg, rasterise } = await import('./helpers/qr-raster.mjs');
  real.state.screen = 'wallet';
  real.state.walletAddress = BY_NETWORK.dobs;
  real.state.qr = null;
  window.ObsidianWalletTab('receive');
  for (let i = 0; i < 100 && !real.state.qr; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));

  assert.match(app.innerHTML, /id="wallet-qr"/);
  assert.match(app.innerHTML, /<svg /);
  assert.ok(app.innerHTML.includes(BY_NETWORK.dobs), 'the address is shown in text beside the code');
  assert.match(app.innerHTML, /COPY ADDRESS/);

  const svg = /<svg [\s\S]*?<\/svg>/.exec(app.innerHTML)[0];
  const image = rasterise(modulesFromSvg(svg));
  assert.equal(decodeQr(image), BY_NETWORK.dobs, 'what is on screen scans as this address');
});

test('a QR drawn for one address is never shown above another', needsBundle, () => {
  real.state.qr = { address: BY_NETWORK.obs, svg: '<svg id="stale"></svg>' };
  real.state.walletAddress = BY_NETWORK.dobs;
  real.state.wt = 'receive';
  real.render();
  assert.doesNotMatch(app.innerHTML, /id="stale"/);
});

test('SCAN WALLET QR is on the Send tab, and only there', needsBundle, () => {
  real.state.walletAddress = BY_NETWORK.dobs;
  real.state.wt = 'send';
  real.render();
  assert.match(app.innerHTML, /SCAN WALLET QR/);
  assert.match(app.innerHTML, /onclick="ObsidianScan\(\)"/);
  for (const tab of ['receive', 'setup']) {
    real.state.wt = tab;
    real.render();
    assert.doesNotMatch(app.innerHTML, /SCAN WALLET QR/, `not on the ${tab} tab`);
  }
});

test('a claim that was just submitted holds the Claim button instead of offering it again', () => {
  real.state.walletAddress = BY_NETWORK.dobs;
  real.state.mining = { eligible: true, secondsRemaining: 0 };
  real.state.miningAt = Date.now();
  real.state.screen = 'mine';

  real.state.claimSentAt = null;
  real.render();
  assert.match(app.innerHTML, /SIGN &amp; SUBMIT CLAIM|SIGN & SUBMIT CLAIM/, 'offered before a claim is sent');

  real.state.claimSentAt = Date.now();
  real.render();
  assert.match(app.innerHTML, /CLAIM SUBMITTED — WAITING FOR A BLOCK/);
  assert.doesNotMatch(app.innerHTML, /SUBMIT CLAIM/, 'no button to press a second time');

  real.state.claimSentAt = Date.now() - 120_000;
  real.render();
  assert.match(app.innerHTML, /SUBMIT CLAIM/, 'released again if no block ever took it');
  real.state.claimSentAt = null;
  real.state.mining = null;
});
