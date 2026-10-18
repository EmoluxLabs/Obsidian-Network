#!/usr/bin/env node
/**
 * ONS owner actions in a REAL browser against a real devnet: change the address a name points to, offer it to another
 * wallet, withdraw the offer, accept an offer, set a recovery address, start and cancel a recovery, and the Marketplace
 * lock. Every action is made by pressing the page's own buttons, signed with a vault unlocked by typing its passphrase,
 * and checked on the CHAIN afterwards (the page's words are never the evidence).
 *
 *   APP_URL=http://127.0.0.1:39390 GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX node tests/e2e-ons-owner.mjs
 *
 * Needs a FRESH devnet (the first mining claim on a new chain receives the one-time genesis allocation, which is what
 * pays for the name; the first account consumes the genesis invitation), the web app on that network, and a browser
 * (`npm i --no-save puppeteer-core @sparticuz/chromium`, or CHROME_PATH). Not part of `npm test`. Devnet only: it
 * refuses any other network. Nothing here touches production.
 */
import { createHmac } from 'node:crypto';
import { register } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.APP_URL ?? 'http://127.0.0.1:38790').replace(/\/$/, '');
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

// ── three wallets: W1 mines (and pays for the name), W2 receives, W3 is a stranger ──
const wallets = {};
for (const label of ['w1', 'w2', 'w3']) {
  const phrase = await appWallet.newPhrase();
  store.clear();
  await appWallet.setupWallet({ phrase, passphrase: PASS });
  wallets[label] = { phrase, address: await appWallet.addressForPhrase(phrase), vault: [...store.entries()] };
}
console.log(`devnet ${net.name} (chain ${net.chainId}); wallets ${Object.values(wallets).map((w) => w.address.slice(0, 12)).join(', ')}…`);

// ── fund W1 through the real gate: account, MFA, link, claim (the first claim on a new chain is the genesis allocation) ──
{
  const email = `ons.owner.${Date.now().toString(36)}@gmail.com`;
  const made = await call('POST', '/api/auth/register', { email, password: 'correct horse battery 7 staple', inviteCode: GENESIS });
  assert.equal(made.status, 200, `register: ${JSON.stringify(made.data)}`);
  const setup = await call('POST', '/api/auth/mfa/setup', {});
  const confirmed = await call('POST', '/api/auth/mfa/confirm', { totp: totp(setup.data.secret) });
  assert.equal(confirmed.status, 200, `mfa: ${JSON.stringify(confirmed.data)}`);
  store.clear();
  for (const [k, v] of wallets.w1.vault) store.set(k, v);
  const challenge = await data.requestLinkChallenge(wallets.w1.address);
  const proof = signing.signLinkChallenge({ wallet: signing.walletFromPhrase(wallets.w1.phrase, HRP), message: challenge.message });
  await data.submitLinkProof(proof);
  const claim = await appWallet.claim(async () => PASS);
  assert.ok(claim.ok, `claim: ${claim.message}`);
  await until('the genesis allocation', async () => BigInt((await data.getBalance(wallets.w1.address)).balanceSeals) > 10n ** 18n);
  for (const to of [wallets.w2.address, wallets.w3.address]) {
    // one transaction per account per block: wait for each to land before the next
    const sent = await appWallet.send({ to, amountObs: '10' }, async () => PASS);
    assert.ok(sent.ok, `fund: ${sent.message}`);
    await until(`${to.slice(0, 10)} funded`, async () => (await data.getBalance(to)).balanceSeals !== '0');
  }
  console.log('funded: W1 holds the genesis allocation; W2 and W3 hold 10 OBS each');
}

// ── the browser ──
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
const browser = await puppeteer.launch({ executablePath: chrome.path, args: chrome.args, headless: 'shell', defaultViewport: { width: 1000, height: 1600 } });
const page = await browser.newPage();
const problems = [];
page.on('pageerror', (error) => problems.push(error.message));
const words = () => page.evaluate(() => document.body.innerText);
const html = () => page.evaluate(() => document.getElementById('app').innerHTML);
async function waitText(pattern, what, ms = 90000) {
  const started = Date.now();
  for (;;) {
    const now = await words();
    if (pattern.test(now)) return now;
    if (Date.now() - started > ms) assert.fail(`${what}: waited for ${pattern}; the page says:\n${now.slice(0, 900)}`);
    await sleep(200);
  }
}
const buttonState = (label) =>
  page.evaluate((wanted) => {
    const b = [...document.querySelectorAll('#app button')].find((x) => x.textContent.includes(wanted));
    return b ? { found: true, disabled: b.disabled } : { found: false, disabled: false };
  }, label);
async function press(label) {
  const done = await page.evaluate((wanted) => {
    const b = [...document.querySelectorAll('#app button')].find((x) => x.textContent.includes(wanted) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, label);
  assert.ok(done, `an enabled button reading "${label}" is on the page`);
}
async function type(id, value) {
  await page.waitForSelector(`#${id}`, { timeout: 15000 });
  await page.$eval(`#${id}`, (el) => { el.value = ''; });
  await page.type(`#${id}`, value);
}
async function as(wallet) {
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate((entries) => { localStorage.clear(); for (const [k, v] of entries) localStorage.setItem(k, v); }, wallet.vault);
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await sleep(1500); // the design's splash timer moves the page to the landing screen ~0.8 s after load; wait it out
  await page.evaluate(() => window.ObsidianGo('ons'));
  await sleep(800);
}
async function open(name) {
  await type('nm', name);
  await press('SEARCH');
  await waitText(new RegExp(name, 'i'), `the result for ${name}`);
  await sleep(300);
}

const NAME = `owner${Date.now().toString(36)}`;
try {
  // ── W1 registers a name through the page ──
  await as(wallets.w1);
  await open(NAME);
  ok(/AVAILABLE/.test(await words()), 'a new name is AVAILABLE');
  await type('pp', PASS);
  await press(`REGISTER ${NAME}`);
  const registered = await until('the registration', () => nameOnChain(NAME));
  ok(registered.owner === wallets.w1.address, 'W1 registered the name (chain)');
  await open(NAME);
  ok(/MANAGE THIS NAME/.test(await words()), 'the owner sees MANAGE THIS NAME');
  ok(!/OFFERED TO YOUR WALLET/.test(await words()), 'the owner is not shown the recipient panel');

  // ── refusals before anything is signed ──
  for (const [typed, pattern, why] of [
    ['someone@gmail.com', /email address/i, 'an email address'],
    [`${NAME}.obs`, /\.obs name is not accepted/i, 'a .obs name'],
    [`${HRP}1notanaddress`, /not a valid/i, 'a malformed address'],
    ['', /Enter a wallet address/i, 'an empty field'],
  ]) {
    if (typed) await type('oaddr', typed);
    else await page.$eval('#oaddr', (el) => { el.value = ''; });
    await press('REVIEW CHANGE OF ADDRESS');
    await waitText(pattern, `refusal of ${why}`, 8000);
    ok(!/REVIEW CHANGE OF ADDRESS\s*\n\s*NAME/.test(await words()) && (await buttonState('CONFIRM AND CHANGE')).found === false, `${why} is refused at review, nothing to sign`);
  }

  // ── change address ──
  await type('oaddr', wallets.w3.address);
  await press('REVIEW CHANGE OF ADDRESS');
  await waitText(/CONFIRM AND CHANGE ADDRESS/, 'the review panel');
  const reviewHtml = await html();
  ok(reviewHtml.includes(wallets.w3.address) && reviewHtml.includes(wallets.w1.address), 'the review shows both full addresses');
  ok(/NETWORK\s*\n?\s*DEVNET/i.test(await words()), 'the review names the network');
  ok(/pays no gas|free of gas|no gas/i.test(await words()), 'the review says it is free of gas');
  await type('pp', 'not the right passphrase');
  await press('CONFIRM AND CHANGE ADDRESS');
  await waitText(/passphrase is not correct|incorrect passphrase|wrong passphrase/i, 'a wrong passphrase is refused', 20000);
  ok((await nameOnChain(NAME)).address !== wallets.w3.address, 'a wrong passphrase changed nothing on the chain');
  await type('pp', PASS);
  await press('CONFIRM AND CHANGE ADDRESS');
  await waitText(/Change of address on .* confirmed on the chain/, 'confirmation of the address change');
  ok((await nameOnChain(NAME)).address === wallets.w3.address, 'the name resolves to the new address (chain), and only then did the page say so');
  ok((await nameOnChain(NAME)).owner === wallets.w1.address, 'the owner did not change');

  // ── offer it to W2, withdraw, offer again ──
  await type('otto', wallets.w2.address);
  await press('REVIEW TRANSFER OFFER');
  await waitText(/CONFIRM AND OFFER THE NAME/, 'the transfer review');
  ok(/seven days/i.test(await words()) && /not a transfer|offer, not/i.test(await words()), 'the review explains it is an offer that must be accepted within seven days');
  await type('pp', PASS);
  await press('CONFIRM AND OFFER THE NAME');
  await waitText(/Transfer offer on .* confirmed on the chain/, 'the offer');
  const offered = await nameOnChain(NAME);
  ok(offered.pendingTransfer?.to === wallets.w2.address && offered.owner === wallets.w1.address, 'the offer is open and W1 still owns the name (chain)');
  ok(/WITHDRAW THE OFFER/.test(await words()), 'the owner now sees WITHDRAW THE OFFER');
  await press('WITHDRAW THE OFFER');
  await waitText(/CONFIRM AND WITHDRAW/, 'the withdraw review');
  await type('pp', PASS);
  await press('CONFIRM AND WITHDRAW');
  await waitText(/Withdrawal of the transfer offer on .* confirmed/, 'the withdrawal');
  ok(!(await nameOnChain(NAME)).pendingTransfer, 'the offer is gone (chain)');
  await type('otto', wallets.w2.address);
  await press('REVIEW TRANSFER OFFER');
  await type('pp', PASS);
  await press('CONFIRM AND OFFER THE NAME');
  await waitText(/Transfer offer on .* confirmed on the chain/, 'the second offer');

  // ── W3 (a stranger) has no part in it ──
  await as(wallets.w3);
  await open(NAME);
  ok(!/MANAGE THIS NAME|OFFERED TO YOUR WALLET|REVIEW AND ACCEPT/.test(await words()), 'a stranger is shown no owner, recipient or recovery actions');

  // ── W2 accepts ──
  await as(wallets.w2);
  await open(NAME);
  await waitText(/OFFERED TO YOUR WALLET/, 'the recipient panel');
  await press('REVIEW AND ACCEPT');
  await waitText(/CONFIRM AND TAKE THE NAME/, 'the accept review');
  await type('pp', PASS);
  await press('CONFIRM AND TAKE THE NAME');
  await waitText(/Acceptance of the transfer on .* confirmed/, 'the acceptance');
  ok((await nameOnChain(NAME)).owner === wallets.w2.address, 'W2 owns the name (chain)');
  ok(/MANAGE THIS NAME/.test(await words()), 'the new owner now sees MANAGE THIS NAME');

  // ── recovery: W2 names W1 as the recovery address ──
  await type('orec', wallets.w1.address);
  await press('REVIEW RECOVERY ADDRESS');
  await waitText(/CONFIRM AND SET RECOVERY ADDRESS/, 'the recovery review');
  await type('pp', PASS);
  await press('CONFIRM AND SET RECOVERY ADDRESS');
  await waitText(/Recovery address on .* confirmed/, 'the recovery address');
  ok((await nameOnChain(NAME)).recoveryAddress === wallets.w1.address, 'W1 is the recovery address (chain)');

  // ── W1 starts a recovery ──
  await as(wallets.w1);
  await open(NAME);
  await waitText(/This wallet is the recovery address/, 'the recovery panel');
  ok(!/MANAGE THIS NAME/.test(await words()), 'the recovery address is not shown the owner panel');
  await type('onew', wallets.w1.address);
  await press('REVIEW AND START RECOVERY');
  await waitText(/CONFIRM AND START RECOVERY/, 'the start review');
  await type('pp', PASS);
  await press('CONFIRM AND START RECOVERY');
  await waitText(/Recovery on .* confirmed/, 'the recovery start');
  const inFlight = await nameOnChain(NAME);
  ok(inFlight.pendingRecovery?.newAddress === wallets.w1.address && inFlight.owner === wallets.w2.address, 'a recovery is in flight and W2 still owns the name (chain)');
  const finalize = await buttonState('REVIEW AND COMPLETE RECOVERY');
  ok(finalize.found && finalize.disabled && /READY AT/.test(await words()), 'completing is disabled before the delay, with the time it becomes ready');

  // ── W2 cancels it ──
  await as(wallets.w2);
  await open(NAME);
  await waitText(/A RECOVERY IS IN FLIGHT/, 'the owner is warned');
  await press('CANCEL THE RECOVERY');
  await waitText(/CONFIRM AND CANCEL RECOVERY/, 'the cancel review');
  await type('pp', PASS);
  await press('CONFIRM AND CANCEL RECOVERY');
  await waitText(/Cancellation of the recovery on .* confirmed/, 'the cancellation');
  ok(!(await nameOnChain(NAME)).pendingRecovery, 'the recovery is cancelled (chain)');

  // ── the Marketplace lock ──
  await page.evaluate(() => window.ObsidianGo('ons'));
  await sleep(1500);
  await page.waitForSelector('#pr0', { timeout: 30000 });
  await type('pr0', '5');
  await type('pp2', PASS);
  await press(`LIST ${NAME}`);
  await until('the listing', async () => (await nameOnChain(NAME)).marketStatus === 'LISTED');
  await open(NAME);
  const listedWords = await words();
  ok(/NAME_LISTED/.test(listedWords) && /Remove the listing/.test(listedWords), 'a listed name says why its owner actions are off');
  const states = await Promise.all(['REVIEW CHANGE OF ADDRESS', 'REVIEW TRANSFER OFFER', 'REVIEW RECOVERY ADDRESS'].map(buttonState));
  ok(states.every((b) => b.found && b.disabled), 'change address, transfer and recovery are all disabled while listed');
  await type('pp2', PASS).catch(() => {});
  await page.evaluate(() => window.ObsidianGo('ons'));
  await sleep(1500);
  await page.waitForSelector('#pp2', { timeout: 30000 });
  await type('pp2', PASS);
  await press('REMOVE LISTING');
  await until('the listing to be removed', async () => (await nameOnChain(NAME)).marketStatus !== 'LISTED');
  ok(true, 'the listing is removed (chain)');
  ok(problems.length === 0, `no script errors${problems.length ? ` (${problems[0]})` : ''}`);
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${error.message}`);
  console.log((await words().catch(() => '')).slice(0, 1200));
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
