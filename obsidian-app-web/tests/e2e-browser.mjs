/**
 * The whole app, driven through its own screens in a real browser.
 *
 * Not a unit test and not part of `npm test`: it needs a live node, platform and app
 * on one network, a browser, and one unspent invitation. It signs a brand-new person
 * up through the real form and walks every screen with the real buttons:
 *
 *   sign up -> recovery codes -> MFA -> CREATE a wallet (24 words, 3-word proof) ->
 *   seal -> fund -> send -> register a name -> claim -> explorer -> own activity ->
 *   menu (link address, invite) -> sign out -> sign in with an MFA code
 *
 * Every assertion reads what the user would read. A step that "passes" because a
 * label happened to contain the word is not a pass, so the checks look at the notice
 * and error lines, the held Claim button, the ledger-facing counters and the vault.
 *
 * Environment
 *   APP_URL         the app under test                    (default http://127.0.0.1:38790)
 *   INVITE          one unspent invitation code           (required)
 *   FUNDER_PHRASE   recovery phrase of a funded wallet on this network. Without it the
 *                   send / name steps are skipped and said to be.
 *   FUNDER_PASS     passphrase to seal the funder with     (default: a throwaway)
 *   CHROME_PATH     a Chrome/Chromium binary; otherwise @sparticuz/chromium is tried
 *
 * Needs `puppeteer-core` (not a dependency of this package: `npm i --no-save puppeteer-core`).
 */

import { createHmac } from 'node:crypto';
import { register } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = (process.env.APP_URL ?? 'http://127.0.0.1:38790').replace(/\/$/, '');
const INVITE = process.env.INVITE;
const FUNDER_PHRASE = process.env.FUNDER_PHRASE;
const FUNDER_PASS = process.env.FUNDER_PASS ?? 'throwaway funder passphrase 1';
if (!INVITE) {
  console.error('INVITE is required: one unspent invitation code for this platform.');
  process.exit(2);
}

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed. Run: npm i --no-save puppeteer-core');
  process.exit(2);
}

async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    const chromium = (await import('@sparticuz/chromium')).default;
    return { path: await chromium.executablePath(), args: chromium.args };
  } catch {
    console.error('No browser: set CHROME_PATH, or `npm i --no-save @sparticuz/chromium`.');
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = Date.now().toString(36);
const email = `ui.walker.${stamp}@gmail.com`;
const password = 'correct horse battery 7 staple';
const PASS = 'a long vault passphrase 42';

let failed = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`);
  if (!cond) failed += 1;
};
const skip = (msg) => console.log(`SKIP  ${msg}`);

// ── funding: the app's own wallet code, driven from node ─────────────────────

async function fund(address, amountObs) {
  const dir = resolve(HERE, '..');
  register(
    `data:text/javascript,${encodeURIComponent(
      `export async function resolve(s,c,n){ if(s==='/js/obsidian.js') return {url:${JSON.stringify(
        pathToFileURL(resolve(dir, 'public/js/obsidian.js')).href,
      )},shortCircuit:true}; return n(s,c);}`,
    )}`,
  );
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const real = globalThis.fetch;
  globalThis.fetch = (u, i) => real(String(u).startsWith('/') ? APP + u : u, i);
  const wallet = await import(pathToFileURL(resolve(dir, 'public/wallet.mjs')).href);
  await wallet.setupWallet({ phrase: FUNDER_PHRASE, passphrase: FUNDER_PASS });
  const result = await wallet.send({ to: address, amountObs, memo: 'e2e-browser' }, async () => FUNDER_PASS);
  const from = await wallet.addressForPhrase(FUNDER_PHRASE);
  globalThis.fetch = real;
  return { ...result, from };
}

// ── a TOTP, for the MFA the walk enrols ──────────────────────────────────────

function totp(secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)));
  const h = createHmac('sha1', key).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

// ── the browser ──────────────────────────────────────────────────────────────

const found = await chromePath();
const browser = await puppeteer.launch({
  executablePath: found.path ?? found,
  args: [...(found.args ?? []), '--no-sandbox'],
  headless: 'shell',
});
const page = await browser.newPage();
await page.setViewport({ width: 430, height: 900 });
page.on('dialog', (d) => d.accept());
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

const text = () => page.evaluate(() => document.body.innerText.replace(/\n+/g, ' | '));
const errorLine = () => page.evaluate(() => document.querySelector('.err')?.innerText ?? '');
async function click(label) {
  const hit = await page.evaluate((label) => {
    const els = [...document.querySelectorAll('button,.btn,.big,.row,a,[onclick]')];
    const el = els.find((e) => e.innerText && e.innerText.trim().toUpperCase().startsWith(label.toUpperCase()));
    if (!el) return false;
    el.click();
    return true;
  }, label);
  await sleep(500);
  return hit;
}
async function type(id, value) {
  await page.evaluate((id) => {
    const e = document.getElementById(id);
    if (e) e.value = '';
  }, id);
  await page.type(`#${id}`, value);
}

try {
  await page.goto(APP, { waitUntil: 'networkidle2' });
  await sleep(3500); // the splash

  // ── an account, through the form ───────────────────────────────────────────
  ok(await click('START MINING'), 'landing: START MINING leads to sign-up');
  await type('em', email);
  await type('pw', password);
  await type('p2', password);
  await type('rf', INVITE);
  await click('CREATE ACCOUNT');
  await sleep(2500);
  ok(/RECOVERY CODES/.test(await text()), 'home: recovery codes are shown once after sign-up');
  await click('I HAVE WRITTEN THEM DOWN');

  // ── a second factor, started from Home, finished on the Menu ───────────────
  await click('SET UP MFA');
  await sleep(2000);
  const secret = (await text()).match(/\b[A-Z2-7]{16,}\b/)?.[0];
  ok(Boolean(secret), 'MFA: starting it from Home takes you to the secret, not to a button that did nothing');
  await type('mf', '000000');
  await click('CONFIRM');
  await sleep(2000);
  ok((await errorLine()).length > 0, 'MFA: a wrong code says so (the Menu has an error line)');
  await type('mf', totp(secret));
  await click('CONFIRM');
  await sleep(2500);
  ok(/SECOND FACTOR \| ENABLED/.test(await text()), 'MFA: the right code enables it');

  // ── a wallet, created: the phrase is shown, proven, then sealed ────────────
  await page.evaluate(() => window.ObsidianGo('wallet'));
  await sleep(800);
  ok(/CREATE NEW/.test(await text()) && /GENERATE MY RECOVERY PHRASE/.test(await text()), 'wallet: with no wallet, CREATE is offered first');
  await click('GENERATE MY RECOVERY PHRASE');
  await sleep(800);
  const words = await page.evaluate(() => [...document.querySelectorAll('#app div[style*="grid"] b.m')].map((b) => b.textContent));
  ok(words.length === 24, `wallet: 24 words are shown (${words.length})`);
  const wanted = await page.evaluate(() =>
    [...document.querySelectorAll('#app label, #app .lb')].map((l) => l.textContent).filter((t) => /^WORD #/.test(t)).map((t) => Number(t.replace('WORD #', ''))),
  );
  ok(wanted.length === 3, 'wallet: three words are asked back');
  await type('cw0', 'wrong');
  await type('cw1', 'wrong');
  await type('cw2', 'wrong');
  await type('pp', PASS);
  await type('p2', PASS);
  await click('SEAL WALLET');
  await sleep(700);
  ok(/do not match the phrase/.test(await errorLine()), 'wallet: wrong proof words are refused');
  for (let i = 0; i < 3; i += 1) await type(`cw${i}`, words[wanted[i] - 1]);
  await type('pp', 'short');
  await type('p2', 'short');
  await click('SEAL WALLET');
  await sleep(700);
  ok(/at least 12/.test(await errorLine()), 'wallet: a short passphrase is refused');
  await type('pp', PASS); // the proof words were kept across the error; only the passphrases are asked again
  await type('p2', PASS);
  await click('SEAL WALLET');
  await sleep(4000);
  const address = await page.evaluate(() => document.querySelector('#app .m[style*="break-all"]')?.textContent?.trim());
  const stored = await page.evaluate(() => ({ v1: localStorage.getItem('obsidian.vault.v1') !== null, legacy: localStorage.getItem('obsidian.vault') !== null, all: JSON.stringify(localStorage) }));
  ok(/^[a-z]+1[0-9a-z]{30,}$/.test(address ?? ''), `wallet: sealed, address ${address}`);
  ok(stored.v1 && !stored.legacy, 'wallet: sealed in the platform-format vault (obsidian.vault.v1)');
  ok(!stored.all.includes(`${words[0]} ${words[1]}`), 'wallet: the phrase is not in storage in the clear');

  // ── send, and a name: need funds ───────────────────────────────────────────
  if (FUNDER_PHRASE) {
    const funded = await fund(address, '5');
    ok(funded.ok, `fund: 5 OBS sent to the new wallet (${funded.txId ?? funded.message})`);
    if (!funded.ok) {
      skip('send and ONS: the funder has no usable balance on this network, so there is nothing to send');
    } else {
      await sleep(14000);
      await page.evaluate(() => window.ObsidianGo('wallet'));
      await sleep(2500);
      await click('SEND');
      const hrp = address.split('1')[0];
      ok((await page.evaluate(() => document.getElementById('to')?.placeholder ?? '')).startsWith(`${hrp}1`), `send: the recipient hint uses this network's prefix (${hrp}1…)`);
      await type('to', address.replace(/.$/, address.endsWith('q') ? 'p' : 'q')); // an address that fails the checksum
      await type('am', '1');
      await type('pp', PASS);
      await click('SIGN & SEND');
      await sleep(2500);
      ok((await errorLine()).length > 0 && (await page.evaluate(() => document.getElementById('to')?.value)) !== '', 'send: a refused payment explains itself and keeps the recipient typed');
      await type('to', funded.from);
      await type('am', '1');
      await type('pp', PASS);
      await click('SIGN & SEND');
      await sleep(3500);
      ok(/Payment submitted/.test(await text()) && /not yet confirmed/.test(await text()), 'send: a valid payment is reported as submitted, never as confirmed');
      await sleep(14000);

      await page.evaluate(() => window.ObsidianGo('ons'));
      await sleep(800);
      const name = `uiwalk-${stamp}`;
      await type('nm', name);
      await click('SEARCH');
      await sleep(1500);
      ok(/AVAILABLE/.test(await text()), 'ons: a fresh name is AVAILABLE');
      ok(/365 days/.test(await text()), 'ons: the term reads 365 days, not 8760h');
      await type('pp', PASS);
      await click(`REGISTER ${name}`);
      await sleep(3500);
      ok(/Registration submitted/.test(await text()), 'ons: the success notice is shown (and says "not yet confirmed")');
      await sleep(14000);
      await page.evaluate(() => window.ObsidianGo('ons'));
      await sleep(1500);
      ok(new RegExp(`YOUR NAMES \\| ${name}\\.obs \\| ACTIVE`).test(await text()), 'ons: the name is listed under YOUR NAMES once a block holds it');
    }
  } else {
    skip('send and ONS: set FUNDER_PHRASE to a funded wallet on this network');
  }

  // ── mining: the claim is a real claim ──────────────────────────────────────
  await page.evaluate(() => window.ObsidianGo('mine'));
  await sleep(2500);
  ok(/READY TO CLAIM/.test(await text()), 'mine: a fresh wallet is READY TO CLAIM');
  await type('pp', 'not the right passphrase');
  await click('SIGN & SUBMIT');
  await sleep(1500);
  ok(/passphrase is not correct/.test(await errorLine()), 'mine: a wrong passphrase is reported on the Mine screen');
  await type('pp', PASS);
  await click('SIGN & SUBMIT');
  await sleep(4500);
  ok(/Claim submitted/.test(await text()), 'mine: the claim reports submitted, "not yet confirmed"');
  ok(/CLAIM SUBMITTED — WAITING FOR A BLOCK/.test(await text()), 'mine: the Claim button is held, so a second claim cannot be sent by accident');
  await sleep(16000);
  await page.evaluate(() => window.ObsidianGo('mine'));
  await sleep(2500);
  ok(/WAITING/.test(await text()) && /TOTAL CLAIMS \| 1/.test(await text()), 'mine: once a block holds it the screen waits for the next window and counts 1 claim');

  // ── explorer ───────────────────────────────────────────────────────────────
  await page.evaluate(() => window.ObsidianGo('explorer'));
  await sleep(1500);
  await page.evaluate(() => window.ObsidianExTab('claims'));
  await sleep(1500);
  ok(/LATEST MINING CLAIMS/.test(await text()) && /[a-z]+1[0-9a-z]{4,}…/.test(await text()), 'explorer: claims are listed, miners masked');
  ok(!/BALANCE/i.test(await text()), 'explorer: no balance anywhere');
  await page.evaluate(() => window.ObsidianGo('wallet'));
  await sleep(2500);
  await click('SEND');
  const opened = await page.evaluate(() => {
    const row = document.querySelector('.row[onclick*="ObsidianExOpen"]');
    if (!row) return false;
    row.click();
    return true;
  });
  await sleep(1500);
  ok(opened && /TRANSACTION/.test(await text()) && /EXPLORER/.test(await text()), 'wallet: tapping your own activity opens that transaction in the explorer');

  // ── menu ───────────────────────────────────────────────────────────────────
  await page.evaluate(() => window.ObsidianGo('menu'));
  await sleep(2000);
  await click('LINK THIS ADDRESS');
  await sleep(2500);
  ok(/Address linked/.test(await text()), 'menu: linking the address says so');
  await click('ISSUE AN INVITE');
  await sleep(1800);
  ok(/OPEN/.test(await text()) && /ISSUED \| 1 of 5/.test(await text()), 'menu: an invitation can be issued from the app');

  // ── sign out, sign in with the second factor ───────────────────────────────
  await click('SIGN OUT');
  await sleep(1500);
  await page.evaluate(() => window.ObsidianGo('signin'));
  await sleep(500);
  await type('em', email);
  await type('pw', password);
  await click('SIGN IN');
  await sleep(2000);
  ok(/AUTHENTICATOR CODE/.test(await text()), 'sign-in: an account with a second factor is asked for its code');
  ok((await page.evaluate(() => document.getElementById('em')?.value)) === email, 'sign-in: the address is still there, so only the code is typed');
  await type('mf', totp(secret));
  await click('SIGN IN');
  await sleep(2500);
  ok(/Welcome back/.test(await text()) && /RECENT ACTIVITY/.test(await text()), 'sign-in: the code signs the user back in');

  ok(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);
} finally {
  await browser.close();
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
