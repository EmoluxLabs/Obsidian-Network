#!/usr/bin/env node
/**
 * The SAME owner actions on the main platform's ONS page (`obsmainnet.us.ci/ons/`, served by obsidian-interface), in a real
 * browser against a real devnet, with wallets made by the platform's own wallet code: register, change address, offer,
 * withdraw, accept, recovery set / start / cancel, and the Marketplace lock. Also the treasury's earnings: the wallet that
 * made the first claim is the treasury, and when ANOTHER wallet buys a name the treasury must see the 10% share in its
 * activity on the platform wallet page. Everything is checked on the CHAIN, never by the page's wording.
 *
 *   APP_URL=http://127.0.0.1:39390 PLATFORM_URL=http://127.0.0.1:39388 GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX \
 *     node tests/e2e-browser-platform-ons.mjs
 *
 * Needs a FRESH devnet (the first mining claim on a new chain receives the one-time genesis allocation, which is what
 * pays for the name; the first account consumes the genesis invitation), the web app on that network, and a browser
 * (`npm i --no-save puppeteer-core @sparticuz/chromium`, or CHROME_PATH). Not part of `npm test`. Devnet only: it
 * refuses any other network. Nothing here touches production.
 */
import { createHmac } from 'node:crypto';
import { createRequire, register } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.APP_URL ?? 'http://127.0.0.1:38790').replace(/\/$/, '');
const PLATFORM = (process.env.PLATFORM_URL ?? 'http://127.0.0.1:38788').replace(/\/$/, '');
const GENESIS = process.env.GENESIS_CODE;
if (!GENESIS) {
  console.error('set GENESIS_CODE to the genesis invitation of the fresh devnet');
  process.exit(2);
}
const PASS = 'a long vault passphrase 42';
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
let failed = 0;
const ok = (cond, message) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${message}`);
  if (!cond) failed += 1;
};

// ── the app's own wallet code in Node, with a cookie jar (to fund the first wallet through the real account gate) ──
const bundleFile = resolve(here, '../public/js/obsidian.js');
if (!existsSync(bundleFile)) throw new Error('run `npm run build:web` first');
register(
  `data:text/javascript,${encodeURIComponent(`export async function resolve(s, c, n) {
    if (s === '/js/obsidian.js') return { url: ${JSON.stringify(pathToFileURL(bundleFile).href)}, shortCircuit: true };
    return n(s, c);
  }`)}`,
);
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
let cookies = '';
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url).startsWith('/') ? APP + url : String(url);
  const res = await realFetch(target, { ...init, headers: { ...(init.headers ?? {}), cookie: cookies } });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const name = pair.split('=')[0];
    cookies = cookies.split('; ').filter((c) => c && !c.startsWith(`${name}=`)).concat(pair).join('; ');
  }
  return res;
};
const data = await import('../public/data.mjs');
const appWallet = await import('../public/wallet.mjs');
const signing = await import('../web/signing.mjs');

const net = (await data.getNetwork()).network;
if (net.name !== 'devnet') throw new Error(`this test refuses to run on ${net.name}`);
const HRP = net.addressHrp;

const totp = (secret, at = Date.now()) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
};
const call = async (method, path, body) => {
  const res = await realFetch(APP + path, { method, headers: { 'content-type': 'application/json', cookie: cookies, origin: APP }, body: body === undefined ? undefined : JSON.stringify(body) });
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(';');
    const name = pair.split('=')[0];
    cookies = cookies.split('; ').filter((c) => c && !c.startsWith(`${name}=`)).concat(pair).join('; ');
  }
  return { status: res.status, data: await res.json().catch(() => null) };
};
const chain = async (path) => (await (await realFetch(`${APP}/api/rpc?path=${encodeURIComponent(path)}`)).json());
const nameOnChain = (name) => chain(`/names/${name}`).then((r) => (r.owner ? r : null));
async function until(what, fn, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    const value = await fn().catch(() => null);
    if (value) return value;
    await sleep(1500);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ── the platform's own wallet code (what its ONS page signs with) ──
const root = resolve(here, '..', '..');
const esbuild = createRequire(join(root, 'obsidian-interface', 'package.json'))('esbuild');
const tmp = mkdtempSync(join(tmpdir(), 'obs-plat-ons-'));
await esbuild.build({
  stdin: {
    contents: `export { Wallet } from './lib/wallet.ts';`,
    resolveDir: join(root, 'obsidian-interface/web/src'),
    sourcefile: 'entry.ts',
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  outfile: join(tmp, 'platform.mjs'),
  logLevel: 'silent',
});
const platform = await import(pathToFileURL(join(tmp, 'platform.mjs')).href);
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }));

// ── three wallets made by the platform: W1 mines first (so it IS the treasury), W2 buys the name, W3 is the other party ──
const wallets = {};
for (const label of ['w1', 'w2', 'w3']) {
  store.clear();
  const made = await platform.Wallet.create(HRP, PASS);
  const platformVault = [...store.entries()];
  const phrase = made.revealPhrase();
  store.clear();
  await appWallet.setupWallet({ phrase, passphrase: PASS });
  wallets[label] = { phrase, address: made.address, platformVault, appVault: [...store.entries()] };
}
console.log(`devnet ${net.name} (chain ${net.chainId}); platform wallets ${Object.values(wallets).map((w) => w.address.slice(0, 12)).join(', ')}…`);

// ── fund through the real gate: account, MFA, link, claim (the first claim on a new chain is the genesis allocation) ──
{
  const email = `ons.platform.${Date.now().toString(36)}@gmail.com`;
  const made = await call('POST', '/api/auth/register', { email, password: 'correct horse battery 7 staple', inviteCode: GENESIS });
  assert.equal(made.status, 200, `register: ${JSON.stringify(made.data)}`);
  const setup = await call('POST', '/api/auth/mfa/setup', {});
  const confirmed = await call('POST', '/api/auth/mfa/confirm', { totp: totp(setup.data.secret) });
  assert.equal(confirmed.status, 200, `mfa: ${JSON.stringify(confirmed.data)}`);
  store.clear();
  for (const [k, v] of wallets.w1.appVault) store.set(k, v);
  const challenge = await data.requestLinkChallenge(wallets.w1.address);
  const proof = signing.signLinkChallenge({ wallet: signing.walletFromPhrase(wallets.w1.phrase, HRP), message: challenge.message });
  await data.submitLinkProof(proof);
  const claim = await appWallet.claim(async () => PASS);
  assert.ok(claim.ok, `claim: ${claim.message}`);
  await until('the genesis allocation', async () => BigInt((await data.getBalance(wallets.w1.address)).balanceSeals) > 10n ** 18n);
  for (const to of [wallets.w2.address, wallets.w3.address]) {
    const sent = await appWallet.send({ to, amountObs: '10' }, async () => PASS);
    assert.ok(sent.ok, `fund: ${sent.message}`);
    await until(`${to.slice(0, 10)} funded`, async () => (await data.getBalance(to)).balanceSeals !== '0');
  }
  console.log('funded: W1 (the treasury) holds the genesis allocation; W2 and W3 hold 10 OBS each');
}

// ── the browser, on the PLATFORM origin ──
let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed. Run: npm i --no-save puppeteer-core @sparticuz/chromium');
  process.exit(2);
}
process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs22.x';
const chrome = process.env.CHROME_PATH ? { path: process.env.CHROME_PATH, args: ['--no-sandbox'] } : await (async () => {
  const chromium = (await import('@sparticuz/chromium')).default;
  return { path: await chromium.executablePath(), args: chromium.args };
})();
const browser = await puppeteer.launch({ executablePath: chrome.path, args: chrome.args, headless: 'shell', defaultViewport: { width: 1100, height: 1800 } });
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
let promptAnswer = PASS;
const prompts = [];
page.on('dialog', async (dialog) => {
  prompts.push(dialog.message());
  await dialog.accept(promptAnswer);
});
const words = () => page.evaluate(() => document.body.innerText);
async function waitText(pattern, what, ms = 90000) {
  const started = Date.now();
  for (;;) {
    const now = await words();
    if (new RegExp(pattern.source, 'i').test(now)) return now;
    if (Date.now() - started > ms) assert.fail(`${what}: waited for ${pattern}; the page says:\n${now.slice(0, 900)}`);
    await sleep(150);
  }
}
const present = (id) => page.evaluate((x) => Boolean(document.getElementById(x)), id);
const disabled = (id) => page.evaluate((x) => document.getElementById(x)?.disabled === true, id);
async function click(id) {
  await page.waitForSelector(`#${id}`, { timeout: 20000 });
  await page.evaluate((x) => document.getElementById(x).click(), id);
}
async function type(id, value) {
  await page.waitForSelector(`#${id}`, { timeout: 20000 });
  await page.$eval(`#${id}`, (el) => { el.value = ''; });
  if (value) await page.type(`#${id}`, value);
}
async function clickText(label) {
  const done = await page.evaluate((wanted) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === wanted && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  assert.ok(done, `an enabled button reading "${label}" is on the page`);
}
async function as(wallet, path = '/ons/') {
  await page.goto(`${PLATFORM}/robots.txt`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((entries) => { localStorage.clear(); for (const [k, v] of entries) localStorage.setItem(k, v); }, wallet.platformVault);
  await page.goto(`${PLATFORM}${path}`, { waitUntil: 'networkidle0' });
}
async function open(name) {
  await type('ons-lookup', name);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Search').click());
  await waitText(new RegExp(`${name}\\.obs`), `the result for ${name}`);
  await sleep(500); // the owner panel is drawn after the result
}
const toastGone = () => sleep(300);

const NAME = `plat${Date.now().toString(36)}`;
try {
  // ── W2 (not the treasury) registers a name through the platform page ──
  await as(wallets.w2);
  await type('ons-name', NAME);
  const treasuryBefore = BigInt((await data.getBalance(wallets.w1.address)).balanceSeals);
  await click('ons-register');
  const registered = await until('the registration', () => nameOnChain(NAME));
  ok(registered.owner === wallets.w2.address, 'W2 registered the name through the platform page (chain)');
  const share = 5n * 10n ** 15n; // 10% of the 0.05 OBS fee
  const treasuryAfter = await until('the treasury credit', async () => {
    const b = BigInt((await data.getBalance(wallets.w1.address)).balanceSeals);
    return b - treasuryBefore >= share ? b : null;
  });
  ok(treasuryAfter - treasuryBefore === share, `the treasury balance rose by exactly 10% of the fee (${share} seals)`);
  const history = await chain(`/address/${wallets.w1.address}?limit=20`);
  ok(!history.transactions.some((t) => t.kind === 'ONS_REGISTER' && t.reference === `${NAME}.obs`), 'no transaction in the treasury\'s list is the sale (the cause of the missing history)');
  ok(history.credits?.some((c) => c.kind === 'ONS_TREASURY_SHARE' && c.amount === share.toString() && c.reference === `${NAME}.obs`), 'the node lists the 10% share as a credit with the sale\'s name');

  // ── the treasury sees it on the platform wallet page ──
  await as(wallets.w1, '/wallet/');
  await type('unlock-passphrase', PASS);
  await click('unlock');
  await waitText(/Treasury earnings/, 'the platform wallet shows the treasury earnings', 30000);
  ok(/\+0\.005 OBS/.test(await words()), 'the platform wallet shows +0.005 OBS');

  // ── W2 manages the name ──
  await as(wallets.w2);
  await open(NAME);
  ok(/manage this name/i.test(await words()), 'the owner sees Manage this name');
  for (const [typed, pattern, why] of [
    ['someone@gmail.com', /not an email address/i, 'an email address'],
    [`${NAME}.obs`, /\.obs name is not accepted/i, 'a .obs name'],
    [`${HRP}1notanaddress`, /not a valid/i, 'a malformed address'],
    ['', /Enter the new address/i, 'an empty field'],
  ]) {
    const before = prompts.length;
    await type('own-update', typed);
    await click('own-update-review');
    await waitText(pattern, `refusal of ${why}`, 8000);
    ok(!(await present('owner-confirm')) && prompts.length === before, `${why} is refused before any passphrase is asked for`);
    await toastGone();
  }

  await type('own-update', wallets.w3.address);
  await click('own-update-review');
  await waitText(/Review: change of address/, 'the review');
  const reviewHtml = await page.evaluate(() => document.getElementById('ons-result').innerHTML);
  ok(reviewHtml.includes(wallets.w3.address), 'the review shows the full new address');
  ok(/Network\s*\n?\s*devnet/i.test(await words()), 'the review names the network');
  promptAnswer = 'not the right passphrase';
  await click('owner-confirm');
  await sleep(2500);
  ok((await nameOnChain(NAME)).address !== wallets.w3.address, 'a wrong passphrase changed nothing on the chain');
  // a refused passphrase returns to the name; the review is made again
  promptAnswer = PASS;
  await open(NAME);
  await type('own-update', wallets.w3.address);
  await click('own-update-review');
  await waitText(/Review: change of address/, 'the review again');
  await click('owner-confirm');
  await waitText(/Change of address on .* confirmed on the chain/, 'the change of address');
  ok((await nameOnChain(NAME)).address === wallets.w3.address && (await nameOnChain(NAME)).owner === wallets.w2.address, 'the name resolves to the new address and the owner is unchanged (chain)');

  // offer to W3, withdraw, offer again
  await open(NAME);
  await type('own-transfer', wallets.w3.address);
  await click('own-transfer-review');
  await waitText(/Review: transfer offer/, 'the offer review');
  ok(/seven days/i.test(await words()), 'the review says the offer is open for seven days');
  await click('owner-confirm');
  await until('the offer', async () => (await nameOnChain(NAME)).pendingTransfer?.to === wallets.w3.address);
  const offered = await nameOnChain(NAME);
  ok(offered.pendingTransfer?.to === wallets.w3.address && offered.owner === wallets.w2.address, 'the offer is open and W2 still owns the name (chain)');
  await open(NAME);
  ok(await present('own-withdraw'), 'the owner now sees Withdraw the offer');
  await click('own-withdraw');
  await waitText(/Review: withdrawal/, 'the withdraw review');
  await click('owner-confirm');
  await waitText(/Withdrawal of the transfer offer on .* confirmed/, 'the withdrawal');
  ok(!(await nameOnChain(NAME)).pendingTransfer, 'the offer is gone (chain)');
  await open(NAME);
  await type('own-transfer', wallets.w3.address);
  await click('own-transfer-review');
  await click('owner-confirm');
  await until('the second offer', async () => (await nameOnChain(NAME)).pendingTransfer?.to === wallets.w3.address);

  // ── W1 is the treasury and a stranger to this name ──
  await as(wallets.w1);
  await open(NAME);
  ok(!/manage this name|offered to your wallet|this wallet is the recovery address/i.test(await words()), 'a stranger is shown no owner, recipient or recovery actions');

  // ── W3 accepts ──
  await as(wallets.w3);
  await open(NAME);
  await waitText(/Offered to your wallet/, 'the recipient panel');
  await click('own-accept');
  await waitText(/Review: acceptance/, 'the accept review');
  await click('owner-confirm');
  await waitText(/Acceptance of the transfer on .* confirmed/, 'the acceptance');
  ok((await nameOnChain(NAME)).owner === wallets.w3.address, 'W3 owns the name (chain)');

  // ── recovery: W3 names W1 ──
  await open(NAME);
  await type('own-recovery', wallets.w1.address);
  await click('own-recovery-review');
  await waitText(/Review: recovery address/, 'the recovery review');
  await click('owner-confirm');
  await waitText(/Recovery address on .* confirmed/, 'the recovery address');
  ok((await nameOnChain(NAME)).recoveryAddress === wallets.w1.address, 'W1 is the recovery address (chain)');

  await as(wallets.w1);
  await open(NAME);
  await waitText(/This wallet is the recovery address/, 'the recovery panel');
  ok(!/manage this name/i.test(await words()), 'the recovery address is not shown the owner panel');
  await type('own-newowner', wallets.w1.address);
  await click('own-newowner-review');
  await waitText(/Review: recovery/, 'the start review');
  await click('owner-confirm');
  await waitText(/Recovery on .* confirmed/, 'the recovery start');
  const inFlight = await nameOnChain(NAME);
  ok(inFlight.pendingRecovery?.newAddress === wallets.w1.address && inFlight.owner === wallets.w3.address, 'a recovery is in flight and W3 still owns the name (chain)');
  await open(NAME);
  await waitText(/A recovery is in flight/, 'the recovery notice');
  ok((await present('own-finalize')) && (await disabled('own-finalize')) && /ready at/i.test(await words()), 'completing is disabled before the delay, with the time it becomes ready');

  await as(wallets.w3);
  await open(NAME);
  await waitText(/A recovery is in flight/, 'the owner is warned');
  await click('own-recovery-cancel');
  await waitText(/Review: cancellation/, 'the cancel review');
  await click('owner-confirm');
  await waitText(/Cancellation of the recovery on .* confirmed/, 'the cancellation');
  ok(!(await nameOnChain(NAME)).pendingRecovery, 'the recovery is cancelled (chain)');

  // ── the Marketplace lock ──
  await as(wallets.w3);
  await page.waitForFunction(() => /Your names/.test(document.body.innerText) && [...document.querySelectorAll('button')].some((b) => b.textContent === 'List for sale'), { timeout: 30000 });
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('tr')].find((r) => r.textContent.includes('List for sale'));
    const input = row.querySelector('input');
    input.value = '5';
  });
  await clickText('List for sale');
  await until('the listing', async () => (await nameOnChain(NAME)).marketStatus === 'LISTED');
  await open(NAME);
  const listedWords = await words();
  ok(/NAME_LISTED/.test(listedWords), 'a listed name says why its owner actions are off');
  const locked = await Promise.all(['own-update-review', 'own-transfer-review', 'own-recovery-review'].map(async (id) => (await present(id)) && (await disabled(id))));
  ok(locked.every(Boolean), 'change address, transfer and recovery are all disabled while listed');
  await as(wallets.w3);
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent === 'Remove listing'), { timeout: 30000 });
  await clickText('Remove listing');
  await until('the listing to be removed', async () => (await nameOnChain(NAME)).marketStatus !== 'LISTED');
  ok(true, 'the listing is removed (chain)');
  ok(problems.length === 0, `no script errors${problems.length ? ` (${problems[0]})` : ''}`);
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${error.message}`);
  console.log((await words().catch(() => '')).slice(0, 1400));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
