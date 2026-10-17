#!/usr/bin/env node
/**
 * One account, three websites, in a real browser: the forms people actually use.
 *
 *   PLATFORM_URL=http://platform.localhost:49931 APP_URL=http://app.localhost:49990 \
 *   WALLET_URL=http://wallet.localhost:49991 GENESIS_CODE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX \
 *     node tests/e2e-browser-accounts.mjs
 *
 * The three sites must be on DIFFERENT HOSTNAMES, as in production (`*.localhost` resolves to this machine in Chromium):
 * cookies ignore the port, so two sites on 127.0.0.1:A and 127.0.0.1:B would share one session and prove nothing.
 *
 * Needs the platform on a fresh data directory (the first account consumes the genesis invitation), the web app and the
 * wallet site on the same network, and a browser (`npm i --no-save puppeteer-core @sparticuz/chromium`, or CHROME_PATH).
 * Not part of `npm test`.
 *
 *   dana   registers on the platform's own page, enrols a second factor there, signs in on the web app's own form
 *          (which first asks for the code, and says so), and issues an invitation there
 *   eli    registers on the web app with dana's invitation, enrols a second factor there, then signs in on the
 *          platform's own form with that code
 *   wallet the wallet site loads, has no account form, and its own account API is closed
 *
 * It reads what a person reads: the words on the page, never a status the page did not show.
 */
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';

const PLATFORM = (process.env.PLATFORM_URL ?? 'http://platform.localhost:38788').replace(/\/$/, '');
const APP = (process.env.APP_URL ?? 'http://app.localhost:38790').replace(/\/$/, '');
const WALLET = process.env.WALLET_URL?.replace(/\/$/, '');
const GENESIS = process.env.GENESIS_CODE;
if (!GENESIS) {
  console.error('set GENESIS_CODE to the genesis invitation the platform was started with');
  process.exit(2);
}
for (const [name, url] of Object.entries({ PLATFORM, APP, ...(WALLET ? { WALLET } : {}) })) {
  if (/\/\/(?:\d{1,3}\.){3}\d{1,3}(?::|\/|$)/.test(url) || /\/\/\[/.test(url)) {
    console.error(`${name}_URL is an IP address: cookies ignore ports, so the sites would share one session. Use platform.localhost / app.localhost / wallet.localhost.`);
    process.exit(2);
  }
}

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error('puppeteer-core is not installed. Run: npm i --no-save puppeteer-core @sparticuz/chromium');
  process.exit(2);
}
async function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  process.env.AWS_EXECUTION_ENV ??= 'AWS_Lambda_nodejs22.x'; // lets the bundled Chromium unpack the libraries it needs
  const chromium = (await import('@sparticuz/chromium')).default;
  return { path: await chromium.executablePath(), args: chromium.args };
}
const chrome = await chromePath();
const browser = await puppeteer.launch({
  executablePath: typeof chrome === 'string' ? chrome : chrome.path,
  args: [...(typeof chrome === 'string' ? ['--no-sandbox'] : chrome.args), '--window-size=1100,900'],
  headless: 'shell',
  defaultViewport: { width: 1100, height: 900 },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const problems = [];
async function open(label, url) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => problems.push(`${label}: script error: ${error.message}`));
  await page.goto(url, { waitUntil: 'networkidle0' });
  return page;
}
const words = (page) => page.evaluate(() => document.body.innerText);
async function waitFor(page, pattern, what, ms = 12000) {
  const started = Date.now();
  for (;;) {
    const now = await words(page);
    if (pattern.test(now)) return now;
    if (Date.now() - started > ms) assert.fail(`${what}: waited for ${pattern}, the page says:\n${now.slice(0, 700)}`);
    await sleep(150);
  }
}
async function click(page, label, selector = 'button, a, b, .tab, [role=tab], .big, div.btn') {
  // A page may still be drawing (the app shows a splash while it checks the network): look for up to six seconds.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const clicked = await page.evaluate(
      (label, selector) => {
        const target = [...document.querySelectorAll(selector)].find((e) => e.offsetParent !== null && e.textContent.trim().toLowerCase() === label.toLowerCase());
        if (!target) return false;
        target.click();
        return true;
      },
      label,
      selector,
    );
    if (clicked) return;
    await sleep(150);
  }
  assert.fail(`no visible control called "${label}"; the page says:\n${(await words(page)).slice(0, 400)}`);
}
async function fill(page, selector, value) {
  // The apps repaint a screen when a background request finishes; a field that vanishes between "found" and "typed
  // into" is looked up again, the way a person would retype it.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.waitForSelector(selector, { visible: true, timeout: 8000 });
      // Focus the field itself rather than clicking where it was: a repaint can move the layout under the pointer.
      await page.$eval(selector, (el) => {
        el.focus();
        el.value = '';
      });
      await page.type(selector, value, { delay: 2 });
      if ((await page.$eval(selector, (el) => el.value)) === value) return;
    } catch (error) {
      if (attempt >= 3) assert.fail(`cannot type into ${selector}: ${error.message}\nthe page says:\n${(await words(page)).slice(0, 600)}`);
    }
    await sleep(300);
  }
}

const base32 = (text) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of text.replace(/\s/g, '').replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
/** A phone's authenticator: a step already accepted is never accepted again, so each use takes the next allowed step. */
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
      if (waited > 70) throw new Error('the clock did not reach a fresh authenticator step');
      await sleep(1000);
    }
  }
}

let n = 0;
const say = (text) => console.log(`${String(++n).padStart(2, '0')}  ${text}`);
const PASSWORD = 'correct horse battery 7 staple';
const run = Math.random().toString(36).slice(2, 7);
const danaEmail = `browser.dana.${run}@gmail.com`;
const eliEmail = `browser.eli.${run}@gmail.com`;

try {
  // ── dana registers on the platform's own page ────────────────────────────────────────────────────────────────
  const platform = await open('platform', `${PLATFORM}/app/`);
  await click(platform, 'Register');
  await fill(platform, '#reg-email', danaEmail);
  await fill(platform, '#reg-password', PASSWORD);
  await fill(platform, '#reg-confirm', PASSWORD);
  await fill(platform, '#reg-invite', GENESIS);
  await click(platform, 'Create account');
  const shown = await waitFor(platform, /Write these down now/, 'platform: recovery codes');
  assert.equal((shown.match(/OBS-RECOVERY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g) ?? []).length, 10, 'platform shows ten recovery codes');
  await platform.click('#ack-codes');
  await click(platform, 'I have saved them — continue to MFA');
  await platform.waitForSelector('code.breakable', { timeout: 8000 });
  const danaAuth = new Authenticator(await platform.evaluate(() => document.querySelector('code.breakable').textContent));
  await fill(platform, '#mfa-code', await danaAuth.code());
  await click(platform, 'Confirm and open mining');
  await waitFor(platform, new RegExp(danaEmail.replace(/\./g, '\\.')), 'platform: signed in as dana');
  say('platform page: dana registered, saw ten recovery codes once, enrolled a second factor');

  // ── dana signs in on the web app's own form ───────────────────────────────────────────────────────────────
  const app = await open('app', `${APP}/`);
  await click(app, 'START MINING');
  await click(app, 'SIGN IN', 'b');
  await fill(app, '#em', danaEmail);
  await fill(app, '#pw', PASSWORD);
  await click(app, 'SIGN IN', 'button');
  const asked = await waitFor(app, /AUTHENTICATOR CODE/, 'app: asks for the second factor');
  assert.doesNotMatch(asked, /not valid|invalid|incorrect|wrong/i, 'the app says "code needed", not "wrong password"');
  assert.match(asked, /authenticator/i);
  await fill(app, '#mf', await danaAuth.code());
  await click(app, 'SIGN IN', 'button');
  await waitFor(app, /Welcome back/, 'app: signed in');
  await click(app, 'MENU', '.nav *, nav *, .big, div, span, b, a, button');
  const menu = await waitFor(app, new RegExp(danaEmail.replace(/\./g, '\\.')), 'app: the menu names dana');
  assert.match(menu, /SECOND FACTOR\s*\n?\s*ENABLED/, 'the second factor enrolled on the platform shows as enabled on the app');
  say('web app form: asked for the code (not a wrong-password message), accepted the platform-enrolled factor, same account');

  // ── dana issues an invitation on the app ──────────────────────────────────────────────────────────────────
  await click(app, 'ISSUE AN INVITE');
  const issued = await waitFor(app, /[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/, 'app: the issued invitation is shown');
  const invite = issued.match(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/)[0];
  await app.reload({ waitUntil: 'networkidle0' });
  await click(app, 'MENU', '.nav *, nav *, .big, div, span, b, a, button');
  const reloaded = await waitFor(app, /INVITATIONS/, 'app: the menu after a reload');
  assert.ok(reloaded.includes(invite), `the listed invitation is spelled as it was issued (${invite})`);
  say(`web app: invitation issued and still listed, spelled exactly as issued`);
  await click(app, 'SIGN OUT');
  await waitFor(app, /INVITE-ONLY|WELCOME BACK|START MINING/, 'app: signed out');

  // ── eli registers on the web app with dana's invitation ───────────────────────────────────────────────────────
  await click(app, 'START MINING').catch(() => undefined);
  await fill(app, '#em', eliEmail);
  await fill(app, '#pw', PASSWORD);
  await fill(app, '#p2', PASSWORD);
  await fill(app, '#rf', invite);
  await click(app, 'CREATE ACCOUNT');
  const codes = await waitFor(app, /YOUR RECOVERY CODES/, 'app: recovery codes');
  assert.equal((codes.match(/OBS-RECOVERY-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g) ?? []).length, 10, 'the app shows ten recovery codes');
  await click(app, 'I HAVE WRITTEN THEM DOWN');
  await click(app, 'SET UP MFA');
  await app.waitForFunction(() => /SCAN OR ENTER THIS SECRET/.test(document.body.innerText), { timeout: 8000 });
  const eliAuth = new Authenticator(
    await app.evaluate(() => {
      const label = [...document.querySelectorAll('.lb')].find((e) => /SCAN OR ENTER THIS SECRET/.test(e.textContent));
      return label.nextElementSibling.textContent.trim();
    }),
  );
  await fill(app, '#mf', await eliAuth.code());
  await click(app, 'CONFIRM');
  await waitFor(app, /SECOND FACTOR\s*\n?\s*ENABLED/, 'app: eli enrolled a second factor');
  say('web app form: eli registered with the invitation dana issued, saw ten recovery codes, enrolled a second factor');

  // ── eli signs in on the platform's own form ───────────────────────────────────────────────────────────────────
  const platform2 = await open('platform', `${PLATFORM}/app/`);
  // This browser is still signed in on the platform as dana (signing out of the app never touched that session).
  await waitFor(platform2, new RegExp(danaEmail.replace(/\./g, '\\.')), 'platform: dana\u2019s own session is still there');
  await click(platform2, 'Sign out');
  await click(platform2, 'Sign in', '.tab, [role=tab], button, a');
  await fill(platform2, '#log-email', eliEmail);
  await fill(platform2, '#log-password', PASSWORD);
  await fill(platform2, '#log-totp', await eliAuth.code());
  await click(platform2, 'Sign in', 'button[type=submit]');
  await waitFor(platform2, new RegExp(eliEmail.replace(/\./g, '\\.')), 'platform: signed in as eli');
  await waitFor(platform2, /MFA\s*\n?\s*ENABLED/, 'platform: eli\u2019s second factor shows as enabled');
  say('platform form: eli (registered and enrolled on the app) signed in with the app-enrolled code');

  // ── the wallet site ───────────────────────────────────────────────────────────────────────────────────────────
  if (WALLET) {
    const wallet = await open('wallet', `${WALLET}/`);
    const welcome = await waitFor(wallet, /wallet/i, 'wallet: loads');
    assert.doesNotMatch(welcome, /sign in|register|password.*email|gmail/i, 'the wallet site offers no account sign-in');
    const answer = await wallet.evaluate(async () => (await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
    assert.ok([403, 404].includes(answer), `the wallet site\u2019s account API is closed (HTTP ${answer})`);
    say('wallet site: loads, has no account form, account API closed (it unlocks with its own vault password)');
  }

  assert.deepEqual(problems, [], `script errors in the pages:\n${problems.join('\n')}`);
  console.log('e2e-browser-accounts: all steps passed');
} finally {
  await browser.close();
}
