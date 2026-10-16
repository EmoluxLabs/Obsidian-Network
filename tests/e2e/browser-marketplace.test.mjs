/**
 * The ONS Marketplace through a REAL browser (headless Chromium), against a real devnet node and the real
 * interface server: register, list, buy, make an offer and accept it, all by clicking the page's own buttons and
 * signing with a wallet vault unlocked at the browser's passphrase prompt. Chain state is checked on the node.
 *
 *   OBSIDIAN_BROWSER_DIR=/path/with/puppeteer node --test tests/e2e/browser-marketplace.test.mjs
 *
 * Optional and opt-in: skipped (never passed) when no browser is configured. Ports 49730-49788. Needs both
 * packages built.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CORE = join(ROOT, 'obsidian-core');
const IFACE = join(ROOT, 'obsidian-interface');
const NODE_ENTRY = join(CORE, 'dist', 'index.js');
const IFACE_ENTRY = join(IFACE, 'dist', 'server', 'main.js');
const RPC = 49730;
const P2P = 49731;
const UI = 49788;
const NODE_URL = `http://127.0.0.1:${RPC}`;
const UI_URL = `http://127.0.0.1:${UI}`;
const PASSPHRASE = 'a passphrase long enough for the vault';

// Optional: needs a headless Chromium that is not a dependency of this repository. Point OBSIDIAN_BROWSER_DIR at a
// directory where `npm i puppeteer-core @sparticuz/chromium` was run (and, if the system lacks the libraries, set
// OBSIDIAN_BROWSER_LIBS to a directory of them for LD_LIBRARY_PATH). Without it the test is skipped, not passed.
const BROWSER_DIR = process.env.OBSIDIAN_BROWSER_DIR || '';
let puppeteer;
let chromium;
if (BROWSER_DIR) {
  try {
    const req = createRequire(join(BROWSER_DIR, 'package.json'));
    puppeteer = req('puppeteer-core');
    chromium = req('@sparticuz/chromium');
    chromium = chromium.default ?? chromium;
    puppeteer = puppeteer.default ?? puppeteer;
  } catch {
    puppeteer = undefined;
  }
}
const skip = !puppeteer ? 'set OBSIDIAN_BROWSER_DIR to a directory with puppeteer-core and @sparticuz/chromium installed' : process.env.SKIP_E2E === '1' ? 'SKIP_E2E=1' : !existsSync(NODE_ENTRY) || !existsSync(IFACE_ENTRY) ? 'build obsidian-core and obsidian-interface first' : false;
const SCALE = (() => {
  const fromEnv = Number(process.env.OBSIDIAN_E2E_TIMEOUT_SCALE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = cpus()?.length || 1;
  return cores >= 6 ? 1 : cores >= 4 ? 2 : 3;
})();
const ms = (base) => Math.round(base * SCALE);

const children = [];
const dirs = [];
let lib; // the bundled browser code
/** The mining gate issuer of this test network (protocol 1.7.0): the chain refuses a claim without its certificate. */
let gate;
let gateCore;
let client;
const wallets = {};

function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `obsidian-eco-${label}-`));
  dirs.push(dir);
  return dir;
}

function launch(label, entry, args, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...process.env, OBSIDIAN_NODE_ONLY: '1', OBSIDIAN_KEYSTORE_PASSPHRASE: PASSPHRASE, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { label, child, log: [], code: null };
  child.stdout.on('data', (chunk) => record.log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => record.log.push(chunk.toString()));
  child.on('exit', (code) => {
    record.code = code ?? -1;
  });
  children.push(record);
  return record;
}

const tail = (record) => record.log.join('').split('\n').slice(-12).join('\n');

async function waitFor(condition, timeout, what, record) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (record && record.code !== null) throw new Error(`${record.label} exited early (code ${record.code}) while waiting for ${what}\n${tail(record)}`);
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}${record ? `\n${tail(record)}` : ''}`);
}

const get = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
};

/**
 * The next nonce the chain expects from a wallet. Waiting is done against the node itself, not through the
 * interface: the interface rate-limits each client (as it should), and polling it every few hundred
 * milliseconds is not what a page does. The interface sees only the calls this test is about.
 */
const nonceOf = async (wallet) => (await get(`${NODE_URL}/wallet/${encodeURIComponent(wallet.address)}/next-nonce`)).body.nextNonce;

/** Wait until the chain has accepted every transaction `address` has sent so far (its nonce moved on). */
async function mined(address, afterNonce) {
  await waitFor(async () => (await get(`${NODE_URL}/wallet/${encodeURIComponent(address)}/next-nonce`)).body.nextNonce > afterNonce, ms(60_000), `a transaction from ${address.slice(0, 12)}… to be mined`);
}

/** An exact OBS decimal string (`0.050000000000000000`) as a seal count, without a float. */
function seals(obs) {
  const [whole, fraction = ''] = String(obs).split('.');
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
}

/** Run one operation, wait for it to be mined, return what it returned. */
async function done(wallet, run) {
  const before = await nonceOf(wallet);
  const result = await run();
  await mined(wallet.address, before);
  return result;
}

before(async () => {
  if (skip) return;
  // The browser's own modules, bundled for Node: the same sources scripts/build-web.mjs ships.
  const dir = scratch('bundle');
  const entry = join(dir, 'entry.ts');
  const lib_ = join(IFACE, 'web', 'src', 'lib');
  writeFileSync(
    entry,
    [
      `export { operations, gasFor } from ${JSON.stringify(join(lib_, 'operations.ts'))};`,
      `export { ObsidianClient, ChainError } from ${JSON.stringify(join(lib_, 'client.ts'))};`,
      `export { Wallet } from ${JSON.stringify(join(lib_, 'wallet.ts'))};`,
      `export { decodeOnsBody, encodeOnsBody } from ${JSON.stringify(join(IFACE, 'web', 'core', 'transactions', 'executors', 'ons.js'))};`,
      `export { decodeSignedTxFromBytes } from ${JSON.stringify(join(IFACE, 'web', 'core', 'transactions', 'encode.js'))};`,
      `export { TxType, OnsOp, MarketOp } from ${JSON.stringify(join(IFACE, 'web', 'core', 'protocol', 'types.js'))};`,
      `export { decodeMarketBody } from ${JSON.stringify(join(IFACE, 'web', 'core', 'transactions', 'executors', 'marketplace.js'))};`,
      `export { CONSENSUS_PARAMS } from ${JSON.stringify(join(IFACE, 'web', 'core', 'protocol', 'params.js'))};`,
      `export { PROTOCOL_VERSION } from ${JSON.stringify(join(IFACE, 'web', 'core', 'version.js'))};`,
      `export { parseObs } from ${JSON.stringify(join(IFACE, 'web', 'core', 'protocol', 'amount.js'))};`,
    ].join('\n'),
  );
  const { build } = createRequire(join(IFACE, 'package.json'))('esbuild');
  const outfile = join(dir, 'browser-lib.mjs');
  // The same lookup path scripts/build-web.mjs uses: the crypto libraries live with the core.
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', absWorkingDir: IFACE, nodePaths: [join(CORE, 'node_modules'), join(IFACE, 'node_modules')] });

  // The vault lives in localStorage in a browser; give Node a stand-in.
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  lib = await import(pathToFileURL(outfile).href);
  client = new lib.ObsidianClient(UI_URL);

  gateCore = {
    keys: await import(pathToFileURL(join(CORE, 'dist', 'crypto', 'keys.js')).href),
    keystore: await import(pathToFileURL(join(CORE, 'dist', 'crypto', 'keystore.js')).href),
    gate: await import(pathToFileURL(join(CORE, 'dist', 'mining', 'gate.js')).href),
  };
  gate = gateCore.keys.generateKeyPair('dobs');
  const gateKeystore = join(scratch('gate'), 'gate.keystore.json');
  gateCore.keystore.Keystore.write(gateKeystore, gate.privateKey, PASSPHRASE);

  const node = launch('node', NODE_ENTRY, ['start', '--network', 'devnet', '--data-dir', scratch('node'), '--rpc-port', String(RPC), '--p2p-port', String(P2P), '--log-level', 'warn'], CORE, { OBSIDIAN_MINING_GATE_PUBLIC_KEYS: gate.publicKey });
  await waitFor(async () => (await get(`${NODE_URL}/status`)).body.height >= 1, ms(60_000), 'the node to make a block', node);
  const ui = launch('interface', IFACE_ENTRY, ['--network', 'devnet', '--port', String(UI), '--nodes', NODE_URL, '--data-dir', scratch('ui')], IFACE, { OBSIDIAN_GATE_KEYSTORE: gateKeystore, OBSIDIAN_GATE_KEYSTORE_PASSPHRASE: PASSPHRASE });
  await waitFor(async () => (await get(`${UI_URL}/api/health`)).body.healthyNodes === 1, ms(60_000), 'the interface to see the node', ui);

  wallets.miner = await lib.Wallet.create('dobs', PASSPHRASE, 'miner');
  wallets.vaultMiner = store.get('obsidian.vault.v1');
  wallets.buyer = await lib.Wallet.create('dobs', PASSPHRASE, 'buyer');
  wallets.vaultBuyer = store.get('obsidian.vault.v1');
});

after(() => {
  for (const record of children) if (record.code === null) record.child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});


const OBS = 10n ** 18n;
let browser;
const issueDirect = async (address, claimId) => gateCore.gate.issueMiningGateCertificate(gate.privateKey, gate.publicKey, { networkId: 'obsidian-devnet-1', chainId: 7780, address, claimId }, Math.floor(Date.now() / 1000));

async function session(vault, label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1200, height: 900 });
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/401|auth\/me/.test(m.text())) problems.push(`console ${m.text()}`); });
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? PASSPHRASE : undefined));
  await page.evaluateOnNewDocument((v) => { if (!localStorage.getItem('obsidian.vault.v1')) localStorage.setItem('obsidian.vault.v1', v); }, vault);
  await page.goto(`${UI_URL}/ons/`, { waitUntil: 'networkidle0' });
  return { page, problems, label };
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText);
const lookup = async (page, name) => { await page.$eval('#ons-lookup', (e) => { e.value = ''; }); await page.type('#ons-lookup', `${name}.obs`); await page.keyboard.press('Enter'); };
const clickText = async (page, label) => { const h = await page.evaluateHandle((l) => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === l && !b.disabled), label); if (!h.asElement()) throw new Error(`no enabled button "${label}"`); await h.asElement().click(); };
const until = (what, fn) => waitFor(fn, ms(90_000), what);

test('the Marketplace through a real browser: register, list, buy, offer, accept', { skip, timeout: ms(900_000) }, async () => {
  if (process.env.OBSIDIAN_BROWSER_LIBS) process.env.LD_LIBRARY_PATH = process.env.OBSIDIAN_BROWSER_LIBS;
  browser = await puppeteer.launch({ args: [...chromium.args.filter((a) => a !== '--single-process'), '--no-sandbox'], executablePath: await chromium.executablePath(), headless: 'shell' });
  const { miner, buyer } = wallets;
  class DirectClient extends lib.ObsidianClient {
    async request(path, init) {
      const response = await fetch(`${NODE_URL}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      const payload = await response.json();
      if (!response.ok) throw new lib.ChainError(payload.error, response.status, payload.code);
      return payload;
    }
  }
  const direct = new DirectClient(NODE_URL);
  await done(miner, () => lib.operations.claim(direct, miner, issueDirect));
  await done(miner, () => lib.operations.send(client, miner, { to: buyer.address, amountObs: '500' }));
  const bal = async (w) => BigInt((await client.balance(w.address)).balanceSeals);

  const A = await session(wallets.vaultMiner, 'seller');
  const B = await session(wallets.vaultBuyer, 'buyer');
  try {
    // 1. seller registers through the page
    await lookup(A.page, 'browsershop');
    await A.page.waitForSelector('#ons-go-register');
    assert.match(await text(A.page, '#ons-result'), /AVAILABLE/);
    await A.page.click('#ons-go-register');
    await A.page.click('#ons-register');
    await until('registration to be mined', async () => (await client.marketName('browsershop')).owner === miner.address);
    // 2. seller lists
    await A.page.reload({ waitUntil: 'networkidle0' });
    await A.page.waitForSelector('#market-mine input');
    await A.page.type('#market-mine input', '25');
    await clickText(A.page, 'List for sale');
    await until('listing', async () => (await client.marketName('browsershop')).status === 'LISTED');
    // 3. buyer sees it listed and buys
    await lookup(B.page, 'browsershop');
    await B.page.waitForSelector('#market-buy');
    const shown = await text(B.page, '#ons-result');
    assert.match(shown, /25/);
    assert.match(shown, /LISTED|FOR SALE/i);
    const sellerBefore = await bal(miner);
    const buyerBefore = await bal(buyer);
    await B.page.click('#market-buy');
    await B.page.waitForSelector('#market-buy-confirm');
    assert.match(await text(B.page, '#ons-result'), /browsershop\.obs/);
    await B.page.click('#market-buy-confirm');
    await until('sale', async () => (await client.marketName('browsershop')).owner === buyer.address);
    assert.equal((await bal(miner)) - sellerBefore, 25n * OBS, 'seller receives the full price');
    assert.equal(buyerBefore - (await bal(buyer)), 25n * OBS + lib.gasFor(25n * OBS), 'buyer pays price + gas');
    // 4. seller (now a non-owner) offers; buyer accepts through the page
    await lookup(A.page, 'browsershop');
    await A.page.waitForSelector('#market-offer-amount');
    assert.match(await text(A.page, '#ons-result'), /EXPIRES\s*\n?\s*\d/i, 'an owned name shows its expiry');
    await A.page.type('#market-offer-amount', '12');
    await A.page.click('#market-offer-review');
    await A.page.waitForSelector('#market-offer-confirm');
    await A.page.click('#market-offer-confirm');
    await until('offer escrow', async () => BigInt((await client.balance(miner.address)).lockedSeals ?? '0') === 12n * OBS);
    await B.page.reload({ waitUntil: 'networkidle0' });
    await B.page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Accept'), { timeout: 30000 });
    const buyerBeforeAccept = await bal(buyer);
    await clickText(B.page, 'Accept');
    await until('accepted offer', async () => (await client.marketName('browsershop')).owner === miner.address);
    assert.equal((await bal(buyer)) - buyerBeforeAccept, 12n * OBS, 'escrow is released to the accepting owner');
    assert.equal(BigInt((await client.balance(miner.address)).lockedSeals ?? '0'), 0n, 'nothing stays locked');
    // 5. screenshots + browser problems
    await A.page.screenshot({ path: join(scratch('shot'), 'marketplace-seller.png') });
    assert.deepEqual(A.problems, [], 'seller page: no console errors');
    assert.deepEqual(B.problems, [], 'buyer page: no console errors');
  } finally {
    await browser.close();
  }
});
