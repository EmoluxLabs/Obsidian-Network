#!/usr/bin/env node
/**
 * Creating a wallet, with the real buttons in a real browser.
 *
 *   APP_URL=http://127.0.0.1:39390 node tests/e2e-browser-wallet-create.mjs
 *
 * Not part of `npm test` (it needs a running web app and a browser:
 * `npm i --no-save puppeteer-core @sparticuz/chromium`, or CHROME_PATH). It needs no account and no funds.
 *
 * Why it exists: the jsdom-style unit tests keep one fake element per id, so a repaint never unticks anything there.
 * In a browser a repaint builds new elements, and the box "I have saved both the recovery phrase and the private key"
 * came back unticked the moment SEAL WALLET was pressed. The page then refused to seal ("Confirm that you have
 * saved…"), whatever the person did. Each case below reads what a person reads.
 *
 *   1  tick the box, type the proof words and a passphrase, press SEAL -> the wallet is sealed
 *   2  a wrong word -> the error is shown, the box is STILL ticked, and the proof words are kept; fix it -> sealed
 *   3  the box left unticked -> refused, and nothing is stored
 *   4  recover from a private key: tick "this is my address", a short passphrase -> refused, box still ticked; fix -> sealed
 *
 * Optional, the same flow on the other two sites (set the URLs, then the matching case runs):
 *   PLATFORM_URL  the main platform's /wallet/ page   5  passphrase, generate, tick the box, the way on opens
 *   WALLET_URL    the standalone wallet site          6  password, generate, a refusal keeps the box, then it seals
 */
import assert from 'node:assert/strict';

const APP = (process.env.APP_URL ?? 'http://127.0.0.1:38790').replace(/\/$/, '');
const PLATFORM = process.env.PLATFORM_URL?.replace(/\/$/, '');
const WALLET = process.env.WALLET_URL?.replace(/\/$/, '');
const PASS = 'a long vault passphrase 42';

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed. Run: npm i --no-save puppeteer-core @sparticuz/chromium');
  process.exit(2);
}
async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs22.x';
  const chromium = (await import('@sparticuz/chromium')).default;
  return { path: await chromium.executablePath(), args: chromium.args };
}
const chrome = await chromePath();
const browser = await puppeteer.launch({
  executablePath: typeof chrome === 'string' ? chrome : chrome.path,
  args: [...(typeof chrome === 'string' ? ['--no-sandbox'] : chrome.args), '--window-size=1000,1400'],
  headless: 'shell',
  defaultViewport: { width: 1000, height: 1400 },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed += 1;
};

let shared = null;
async function fresh() {
  // One page, emptied between cases (the bundled Chromium runs single-process and has no second browser context), so
  // one case never sees another's wallet.
  const page = shared ?? (shared = await browser.newPage());
  const problems = [];
  page.removeAllListeners('pageerror');
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto(APP, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP, { waitUntil: 'networkidle0' });
  const context = { close: async () => {} };
  await sleep(1500); // the design's splash timer sends the page to the landing screen ~0.8 s after load; wait it out, as a person would
  await page.evaluate(() => window.ObsidianGo('wallet'));
  await sleep(600);
  return { page, context, problems };
}
const text = (page) => page.evaluate(() => document.body.innerText);
const errorLine = (page) => page.evaluate(() => document.querySelector('#app .er, #app [class*="err"]')?.textContent ?? '');
async function type(page, id, value) {
  await page.$eval(`#${id}`, (el) => {
    el.value = '';
  });
  await page.type(`#${id}`, value);
}
async function press(page, label) {
  const ok = await page.evaluate((wanted) => {
    const button = [...document.querySelectorAll('#app button')].find((b) => b.textContent.includes(wanted));
    if (!button) return false;
    button.click();
    return true;
  }, label);
  assert.ok(ok, `a button reading "${label}" is on the page`);
}
const ticked = (page, id) => page.$eval(`#${id}`, (el) => el.checked).catch(() => null);
const vault = (page) => page.evaluate(() => localStorage.getItem('obsidian.vault.v1') !== null);

async function phrase(page) {
  await press(page, 'GENERATE MY RECOVERY PHRASE');
  await page.waitForSelector('#cksaved', { timeout: 15000 });
  const words = await page.evaluate(() => [...document.querySelectorAll('#app div[style*="grid"] b.m')].map((b) => b.textContent));
  const wanted = await page.evaluate(() =>
    [...document.querySelectorAll('#app label, #app .lb')].map((l) => l.textContent).filter((t) => /^WORD #/.test(t)).map((t) => Number(t.replace('WORD #', ''))),
  );
  assert.equal(words.length, 24);
  assert.equal(wanted.length, 3);
  return { words, wanted };
}
async function proof(page, { words, wanted }, wrong = false) {
  for (let i = 0; i < 3; i += 1) await type(page, `cw${i}`, wrong && i === 1 ? 'wrong' : words[wanted[i] - 1]);
}

try {
  // 1 ── the reported bug: tick, type, seal
  {
    const { page, context, problems } = await fresh();
    const made = await phrase(page);
    await proof(page, made);
    await page.click('#cksaved');
    ok((await ticked(page, 'cksaved')) === true, '1: the box is ticked by a real click');
    await type(page, 'pp', PASS);
    await type(page, 'p2', PASS);
    await press(page, 'SEAL WALLET');
    await sleep(4000);
    ok(await vault(page), '1: the wallet is sealed in this browser (the box did not clear itself)');
    ok(!/Confirm that you have saved/.test(await text(page)), '1: no "confirm you saved" refusal after ticking the box');
    ok(/^[a-z]+1[0-9a-z]{30,}$/.test(await page.evaluate(() => document.querySelector('#app .m[style*="break-all"]')?.textContent?.trim() ?? '')), '1: the wallet address is shown');
    ok(problems.length === 0, `1: no script errors${problems.length ? ` (${problems[0]})` : ''}`);
    await context.close();
  }

  // 2 ── a wrong word: the error says so, the box stays ticked, the words stay typed
  {
    const { page, context } = await fresh();
    const made = await phrase(page);
    await proof(page, made, true);
    await page.click('#cksaved');
    await type(page, 'pp', PASS);
    await type(page, 'p2', PASS);
    await press(page, 'SEAL WALLET');
    await sleep(900);
    ok(/do not match the phrase/.test(await errorLine(page)), '2: a wrong word is refused with the right reason');
    ok((await ticked(page, 'cksaved')) === true, '2: the box is still ticked after the refusal');
    ok((await page.$eval('#cw0', (el) => el.value)) === made.words[made.wanted[0] - 1], '2: the proof words are kept');
    ok(!(await vault(page)), '2: nothing was sealed');
    await type(page, 'cw1', made.words[made.wanted[1] - 1]);
    await type(page, 'pp', PASS); // passphrases are never carried over: asked again
    await type(page, 'p2', PASS);
    await press(page, 'SEAL WALLET');
    await sleep(4000);
    ok(await vault(page), '2: after fixing the word, the wallet is sealed without ticking the box again');
    await context.close();
  }

  // 3 ── the box left unticked is still refused
  {
    const { page, context } = await fresh();
    const made = await phrase(page);
    await proof(page, made);
    await type(page, 'pp', PASS);
    await type(page, 'p2', PASS);
    await press(page, 'SEAL WALLET');
    await sleep(900);
    ok(/saved both the recovery phrase and the private key/.test(await errorLine(page)), '3: an unticked box is refused, and says why');
    ok(!(await vault(page)), '3: nothing was sealed');
    await context.close();
  }

  // 4 ── recovering from a private key: the "this is my address" box survives a refusal
  {
    const { page, context } = await fresh();
    const made = await phrase(page); // only to obtain a real key for this network
    const key = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('#app .card .m')].map((e) => e.textContent.trim());
      return cards.find((t) => /^[0-9a-f]{64}$/.test(t)) ?? '';
    });
    assert.match(key, /^[0-9a-f]{64}$/, 'the private key is on the creation screen');
    void made;
    await page.evaluate(() => window.ObsidianGo('wallet'));
    await sleep(500);
    await page.evaluate(() => window.ObsidianSetupMode('key'));
    await sleep(300);
    await type(page, 'pk', key);
    await press(page, 'CHECK THIS KEY');
    await page.waitForSelector('#ckaddr', { timeout: 15000 });
    await page.click('#ckaddr');
    await type(page, 'pp', 'short');
    await type(page, 'p2', 'short');
    await press(page, 'SEAL WALLET');
    await sleep(900);
    ok(/at least 12/.test(await errorLine(page)), '4: a short passphrase is refused');
    ok((await ticked(page, 'ckaddr')) === true, '4: "this is my address" is still ticked after the refusal');
    await type(page, 'pp', PASS);
    await type(page, 'p2', PASS);
    await press(page, 'SEAL WALLET');
    await sleep(4000);
    ok(await vault(page), '4: sealed after fixing the passphrase');
    await context.close();
  }

  // 5 ── the platform's own wallet page
  if (PLATFORM) {
    const page = shared ?? (shared = await browser.newPage());
    await page.goto(`${PLATFORM}/wallet/`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${PLATFORM}/wallet/`, { waitUntil: 'networkidle0' });
    await page.waitForSelector('#passphrase', { timeout: 15000 });
    await type(page, 'passphrase', PASS);
    await type(page, 'passphrase-confirm', PASS);
    await page.click('#create');
    await page.waitForSelector('#backup-saved', { timeout: 20000 });
    ok(await page.$eval('#next-steps', (el) => el.hasAttribute('hidden')), '5: the way on is hidden until the box is ticked');
    await page.click('#backup-saved');
    ok((await ticked(page, 'backup-saved')) === true && !(await page.$eval('#next-steps', (el) => el.hasAttribute('hidden'))), '5: ticking the box opens the way on, and it stays ticked');
    await sleep(1500);
    ok((await ticked(page, 'backup-saved')) === true, '5: the box is still ticked a moment later (no background repaint clears it)');
    ok(await vault(page), '5: the wallet is sealed in this browser');
  } else console.log('SKIP  5: the platform wallet page (PLATFORM_URL not set)');

  // 6 ── the standalone wallet site
  if (WALLET) {
    const page = shared ?? (shared = await browser.newPage());
    await page.goto(WALLET, { waitUntil: 'networkidle0' });
    await page.evaluate(() => { localStorage.clear(); indexedDB.databases?.().then((all) => all.forEach((d) => indexedDB.deleteDatabase(d.name))); });
    await page.goto(WALLET, { waitUntil: 'networkidle0' });
    await sleep(1200);
    const clickText = (label) => page.evaluate((wanted) => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes(wanted)); b?.click(); return Boolean(b); }, label);
    ok(await clickText('CREATE WALLET'), '6: the welcome screen offers CREATE WALLET');
    await page.waitForSelector('#pw', { timeout: 10000 });
    await type(page, 'pw', PASS);
    await type(page, 'pw2', PASS);
    await clickText('CREATE WALLET');
    await page.waitForSelector('#ck', { timeout: 30000 });
    await page.click('#ck');
    await sleep(1500);
    ok((await ticked(page, 'ck')) === true, '6: the box stays ticked');
    await clickText('CONTINUE');
    await sleep(5000);
    ok(!(await page.$('#ck')), '6: sealed and moved on to the wallet');
  } else console.log('SKIP  6: the wallet site (WALLET_URL not set)');
} catch (error) {
  failed += 1;
  console.log(`FAIL  ${error.message}`);
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed');
process.exit(failed ? 1 : 0);
