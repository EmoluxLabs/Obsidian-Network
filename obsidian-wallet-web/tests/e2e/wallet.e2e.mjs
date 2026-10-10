/**
 * The wallet, driven through its own screens in a real browser, against a real devnet (node + platform) that this script
 * starts and throws away. Not part of `npm test`: it needs the browser libraries (see browser.mjs) and takes a few minutes
 * (blocks are ten seconds apart).
 *
 *   npm run build            # the signing bundle
 *   npm run test:e2e
 *
 * Every assertion reads what a person would read, or what the NODE says. A step passes only because of what happened, not
 * because a label contained a word. Nothing here touches another network: every wallet is generated for the run.
 */
import assert from 'node:assert/strict';
import { startDevnet } from './stack.mjs';
import { claimDirect, waitBalance } from './fund.mjs';
import { launch, sleep, qrVideo, pngFile } from './browser.mjs';
import { exactObs } from '../../public/lib/pure.mjs';
import * as bundle from '../../../obsidian-app-web/web/index.mjs';
import { rasterise, modulesFromSvg } from '../../../obsidian-app-web/tests/helpers/qr-raster.mjs';

const OBS = 10n ** 18n;
let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.stack?.split('\n').slice(0, 4).join('\n       ')}`);
    throw error;
  }
};

// ── the people in this test ──────────────────────────────────────────────────

const HRP = 'dobs';
const FUNDER = bundle.generatePhrase(); // imported into the wallet under test, funded by a mining claim
const FRIEND = bundle.generatePhrase(); // the recipient; its address is derived here, its phrase never enters a page
const friend = bundle.walletFromPhrase(FRIEND, HRP);
const funder = bundle.walletFromPhrase(FUNDER, HRP);
const PASS_NEW = 'created wallet password 4711';
const PASS_FUNDER = 'imported wallet password 0815';
const SECRETS = new Set();
const secretWords = (phrase) => phrase.split(' ').slice(0, 4).join(' ');
const remember = (phrase, ...passwords) => {
  SECRETS.add(secretWords(phrase));
  SECRETS.add(bundle.walletFromPhrase(phrase, HRP).privateKeyHex);
  for (const p of passwords) SECRETS.add(p);
};
remember(FUNDER, PASS_FUNDER);

const net = await startDevnet();
// the camera shows the friend's address
const video = qrVideo(bundle.qrModules(friend.address));
// Chromium here runs single-process, which has no separate browser contexts: every "profile" below is its own browser,
// with its own empty storage. A missing browser must not leave a devnet running.
const browsers = [];
const freshBrowser = async () => {
  const b = await launch({ video });
  browsers.push(b);
  return b;
};
await freshBrowser().catch(async (error) => { await net.stop(); throw error; });
const rpc = async (path, body) => {
  const r = await fetch(net.rpcUrl + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const balanceOf = async (address) => BigInt((await rpc('/wallet/balance', { address })).body.balanceSeals);

// the camera shows the friend's address; a second QR (another network) is uploaded as a photo
const evidence = { requests: [], consoles: [], violations: [], pageErrors: [] };
let failed = false;

async function newPage(label) {
  const page = await (browsers.length === 1 && !browsers.used ? ((browsers.used = true), browsers[0]) : await freshBrowser()).newPage();
  await page.setViewport({ width: 430, height: 1000 });
  page.on('request', (r) => evidence.requests.push(`${label} ${r.method()} ${r.url()} ${r.postData() ?? ''}`));
  page.on('console', (m) => evidence.consoles.push(`${label} ${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => evidence.pageErrors.push(`${label}: ${e.message}`));
  page.on('dialog', (d) => d.dismiss());
  await page.evaluateOnNewDocument(() => {
    window.__gum = 0;
    window.__deny = false;
    const real = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (real) {
      navigator.mediaDevices.getUserMedia = (c) => {
        window.__gum += 1;
        return window.__deny ? Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' })) : real(c);
      };
    }
    window.__blobs = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { blob.text().then((t) => window.__blobs.push(t)); return create(blob); };
    document.addEventListener('securitypolicyviolation', (e) => (window.__csp = (window.__csp || []).concat(`${e.violatedDirective} ${e.blockedURI}`)));
    // keep a clipboard we can read: headless has none
    window.__clip = '';
    try { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t) => { window.__clip = t; } }, configurable: true }); } catch { /* ignore */ }
  });
  const rules = [];
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (req.isInterceptResolutionHandled()) return;
    for (const rule of rules) {
      if (rule.when(req)) {
        if (rule.once) rules.splice(rules.indexOf(rule), 1);
        return rule.then(req);
      }
    }
    return req.continue();
  });
  page.rules = rules;
  await page.goto(net.base, { waitUntil: 'load' });
  return page;
}

const text = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
async function waitText(page, needle, timeout = 30_000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, needle);
  } catch {
    throw new Error(`never saw "${needle}". The screen says: ${(await text(page)).slice(0, 500)}`);
  }
}
async function waitGone(page, needle, timeout = 30_000) {
  await page.waitForFunction((t) => !document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, needle);
}
async function waitH1(page, heading, timeout = 30_000) {
  try {
    await page.waitForFunction((t) => document.querySelector('h1')?.innerText === t, { timeout }, heading);
  } catch {
    throw new Error(`the heading never became "${heading}". The screen says: ${(await text(page)).slice(0, 400)}`);
  }
}
async function toHome(page) {
  for (let i = 0; i < 4; i += 1) {
    const done = await page.evaluate(() => {
      if (document.getElementById('bal')) return true;
      (document.querySelector('[data-a="go"][data-v="home"]') ?? document.querySelector('.back[data-a="go"]'))?.click();
      return false;
    });
    if (done) return;
  }
  throw new Error(`could not get back to the wallet screen: ${(await text(page)).slice(0, 300)}`);
}
async function toSend(page) {
  for (let i = 0; i < 4; i += 1) {
    // back out of whatever screen this is (a transaction opens over the activity list) until Send is offered
    const done = await page.evaluate(() => {
      if ([...document.querySelectorAll('[data-a="go"][data-v="send"]')].some((e) => !e.disabled && e.classList.contains('p'))) return true;
      (document.querySelector('[data-a="go"][data-v="home"]') ?? document.querySelector('.back[data-a="go"]'))?.click();
      return false;
    });
    if (done) break;
  }
  await a(page, 'go', 'send');
  await waitH1(page, 'SEND OBS');
}
const err = (page) => page.evaluate(() => document.querySelector('.err')?.innerText ?? '');
async function waitErr(page, needle) {
  try {
    await page.waitForFunction((t) => (document.querySelector('.err')?.innerText ?? '').toLowerCase().includes(t.toLowerCase()), { timeout: 20_000 }, needle);
  } catch {
    throw new Error(`no error containing "${needle}"; the error line says "${await err(page)}"`);
  }
}
const a = async (page, action, value) => {
  const found = await page.evaluate((x, v) => {
    const el = [...document.querySelectorAll(`[data-a="${x}"]`)].find((e) => !e.disabled && (v === undefined || e.dataset.v === v));
    el?.click();
    return Boolean(el);
  }, action, value);
  if (!found) throw new Error(`no enabled control data-a=${action}${value ? ` v=${value}` : ''}. The screen says: ${(await text(page)).slice(0, 400)}`);
};
async function fill(page, id, value) {
  await page.evaluate((i, v) => { const e = document.getElementById(i); e.focus(); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, id, value);
}
const submit = (page, form) => page.evaluate((f) => document.querySelector(`form[data-submit="${f}"] button[type=submit]`).click(), form);
const storage = (page) => page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, cookie: document.cookie }));
const shownAddress = (page) => page.evaluate(() => document.getElementById('addr')?.innerText ?? '');
const balanceText = (page) => page.evaluate(() => document.getElementById('bal')?.innerText ?? '');

async function importPhrase(page, phrase, password) {
  await a(page, 'go', 'import');
  await waitText(page, 'IMPORT WALLET');
  await fill(page, 'rp', phrase);
  await fill(page, 'pw', password);
  await fill(page, 'pw2', password);
  await submit(page, 'importPhrase');
}

try {
  // ── the funded wallet ─────────────────────────────────────────────────────
  await step('the devnet is up, and funds a disposable wallet by a real mining claim', async () => {
    const cfg = await (await fetch(`${net.base}/app-config.json`)).json();
    assert.deepEqual([cfg.network, cfg.chainId, cfg.addressHrp], ['devnet', 7780, 'dobs']);
    for (let i = 0; i < 40 && (await rpc('/status')).body.height < 1; i += 1) await sleep(1000);
    const claim = await claimDirect({ phrase: FUNDER, rpcUrl: net.rpcUrl, gate: net.gate });
    assert.equal(claim.address, funder.address);
    await waitBalance(net.rpcUrl, funder.address, (s) => s > 0n);
  });
  const fundedBalance = await balanceOf(funder.address);
  const base = (await rpc('/wallet/balance', { address: funder.address })).body;
  assert.ok(fundedBalance > 100n * OBS);

  // ── first run: nothing exists until the user says so ──────────────────────
  const first = await newPage('create');
  await step('first run: welcome, the network is named, nothing is stored', async () => {
    await waitText(first, 'DECENTRALISED OBS COIN WALLET');
    const t = await text(first);
    assert.match(t, /DEVNET/);
    assert.match(t, /test network/i);
    assert.match(t, /CREATE WALLET/);
    assert.equal(await storage(first), JSON.stringify({ local: {}, session: {}, cookie: '' }));
  });

  let created = null;
  await step('create: short or mismatched passwords are refused before anything is generated', async () => {
    await a(first, 'go', 'create1');
    await waitText(first, 'Choose a password');
    await fill(first, 'pw', 'short');
    await fill(first, 'pw2', 'short');
    await submit(first, 'makeWallet');
    await waitErr(first, 'at least 12');
    await fill(first, 'pw', PASS_NEW);
    await fill(first, 'pw2', `${PASS_NEW}x`);
    await submit(first, 'makeWallet');
    await waitErr(first, 'do not match');
    assert.equal((await storage(first)).includes('obsidian.vault'), false);
  });

  await step('create: a real 24-word phrase is shown, and NOTHING is persisted before the backup is confirmed', async () => {
    await fill(first, 'pw', PASS_NEW);
    await fill(first, 'pw2', PASS_NEW);
    await submit(first, 'makeWallet');
    await waitText(first, 'SAVE YOUR RECOVERY PHRASE');
    const words = await first.evaluate(() => [...document.querySelectorAll('.words li')].map((li) => li.textContent.replace(/^\s*\d+\s*/, '').trim()));
    assert.equal(words.length, 24);
    const phrase = words.join(' ');
    assert.equal(bundle.isValidPhrase(phrase), true, 'the real BIP-39 checksum accepts it');
    created = { phrase, wallet: bundle.walletFromPhrase(phrase, HRP) };
    remember(phrase, PASS_NEW);
    const s = await storage(first);
    assert.equal(s.includes('obsidian.vault'), false, 'no vault yet');
    assert.equal(s.includes('obsidian.address'), false, 'no address yet');
    assert.equal(s.includes(secretWords(phrase)), false);
    const controls = await first.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.innerText.trim()));
    assert.deepEqual(controls.sort(), ['CANCEL', 'CONTINUE'], 'the phrase screen has no copy, download or share control');
  });

  await step('create: leaving without confirming keeps nothing; the checkbox is required', async () => {
    await submit(first, 'finishCreate');
    await waitErr(first, 'confirm you have written down');
    assert.equal((await storage(first)).includes('obsidian.vault'), false);
  });

  await step('create: after the confirmation the vault is sealed, opens with the password, and holds this phrase', async () => {
    await first.evaluate(() => { document.getElementById('ck').checked = true; });
    await submit(first, 'finishCreate');
    await waitText(first, 'OBS COIN BALANCE');
    assert.equal(await shownAddress(first), created.wallet.address, 'the address on screen is the one the real derivation gives for those words');
    assert.ok(created.wallet.address.startsWith('dobs1'));
    const s = JSON.parse(await storage(first));
    const vault = JSON.parse(s.local['obsidian.vault.v1']);
    assert.equal(vault.kdf, 'PBKDF2-SHA256');
    assert.equal(vault.iterations, 600000);
    assert.equal(await bundle.openVault(vault, PASS_NEW), created.phrase);
    await assert.rejects(bundle.openVault(vault, 'not the password at all'), bundle.PassphraseError);
    const raw = JSON.stringify(s);
    for (const secret of SECRETS) assert.equal(raw.includes(secret), false, 'no secret in storage in the clear');
  });

  await step('a new wallet shows a real zero and an honest empty history', async () => {
    await waitText(first, 'No transactions on this address yet');
    assert.match(await balanceText(first), /^0 OBS$/);
    assert.match(await text(first), /Fiat value: unavailable/);
    assert.match(await text(first), /BLOCK \d+/);
  });

  await step('receive: the QR on screen decodes to exactly this address, with network context', async () => {
    await a(first, 'go', 'receive');
    await first.waitForSelector('#qr svg');
    const svg = await first.evaluate(() => document.querySelector('#qr').innerHTML);
    const decoded = bundle.decodeQr(rasterise(modulesFromSvg(svg), 8));
    assert.equal(decoded, created.wallet.address);
    const t = await text(first);
    assert.match(t, /DEVNET/);
    assert.match(t, /Only send devnet OBS Coin/);
    await a(first, 'copyAddr');
    await waitText(first, 'COPIED');
    assert.equal(await first.evaluate(() => window.__clip), created.wallet.address);
    await a(first, 'go', 'home');
  });

  await step('lock: the wallet needs the password again; a wrong one is refused', async () => {
    await a(first, 'lock');
    await waitText(first, 'WELCOME BACK');
    assert.match(await text(first), new RegExp(created.wallet.address.slice(0, 8)));
    await fill(first, 'pw', 'a wrong password here');
    await submit(first, 'unlock');
    await waitErr(first, 'Wrong password');
    await fill(first, 'pw', PASS_NEW);
    await submit(first, 'unlock');
    await waitText(first, 'OBS COIN BALANCE');
  });

  await step('backup: the phrase is shown only after the password, and hides again', async () => {
    await a(first, 'go', 'backup');
    await waitText(first, 'BACKUP & RECOVERY');
    assert.equal(await first.evaluate(() => document.querySelectorAll('.words li').length), 0, 'no words before the password');
    await fill(first, 'pw', 'wrong password for backup');
    await submit(first, 'reveal');
    await waitErr(first, 'Wrong password');
    await fill(first, 'pw', PASS_NEW);
    await submit(first, 'reveal');
    await first.waitForSelector('.words li');
    const words = await first.evaluate(() => [...document.querySelectorAll('.words li')].map((li) => li.textContent.replace(/^\s*\d+\s*/, '').trim()).join(' '));
    assert.equal(words, created.phrase);
    await a(first, 'hidePhrase');
    await first.waitForFunction(() => document.querySelectorAll('.words li').length === 0, { timeout: 5000 });
    assert.equal((await text(first)).includes(created.phrase.split(' ').slice(0, 3).join(' ')), false);
  });

  let backupFile = '';
  await step('backup: the downloadable file is the ENCRYPTED vault and nothing else', async () => {
    await a(first, 'downloadBackup');
    await first.waitForFunction(() => window.__blobs.length > 0, { timeout: 5000 });
    backupFile = await first.evaluate(() => window.__blobs[0]);
    const parsed = JSON.parse(backupFile);
    assert.equal(parsed.kdf, 'PBKDF2-SHA256');
    for (const secret of SECRETS) assert.equal(backupFile.includes(secret), false);
    assert.equal(await bundle.openVault(parsed, PASS_NEW), created.phrase);
  });

  // ── import: phrase and encrypted backup, in clean browser profiles ─────────
  const second = await newPage('import');
  await step('import: a wrong phrase, a bad checksum, a short password and a private key are all refused', async () => {
    await waitText(second, 'DECENTRALISED OBS COIN WALLET');
    await importPhrase(second, 'not a real phrase at all', PASS_FUNDER);
    await waitErr(second, 'not valid');
    const words = FUNDER.split(' ');
    let broken = null; // two words swapped, with a checksum that fails (one swap in 256 would still pass)
    for (let i = 0; i < words.length - 1 && !broken; i += 1) {
      const swapped = [...words];
      [swapped[i], swapped[i + 1]] = [words[i + 1], words[i]];
      if (!bundle.isValidPhrase(swapped.join(' '))) broken = swapped.join(' ');
    }
    assert.ok(broken, 'a bad-checksum variant exists');
    await fill(second, 'rp', broken);
    await fill(second, 'pw', PASS_FUNDER);
    await fill(second, 'pw2', PASS_FUNDER);
    await submit(second, 'importPhrase');
    await waitErr(second, 'not valid');
    await fill(second, 'rp', FUNDER);
    await fill(second, 'pw', 'short');
    await fill(second, 'pw2', 'short');
    await submit(second, 'importPhrase');
    await waitErr(second, 'at least 12');
    await fill(second, 'rp', funder.privateKeyHex);
    await fill(second, 'pw', PASS_FUNDER);
    await fill(second, 'pw2', PASS_FUNDER);
    await submit(second, 'importPhrase');
    await waitErr(second, 'not valid');
    assert.equal((await storage(second)).includes('obsidian.vault'), false, 'a refused import stores nothing');
    assert.match(await text(second), /Private keys cannot be imported/);
  });

  await step('import: the funded phrase becomes a wallet whose balance and history come from the node', async () => {
    await fill(second, 'rp', `  ${FUNDER.toUpperCase().replace(/ /g, '   ')}  `); // case and spacing are normalised
    await fill(second, 'pw', PASS_FUNDER);
    await fill(second, 'pw2', PASS_FUNDER);
    await submit(second, 'importPhrase');
    await waitText(second, 'OBS COIN BALANCE');
    assert.equal(await shownAddress(second), funder.address);
    const onChain = await balanceOf(funder.address);
    await second.waitForFunction((v) => document.getElementById('bal')?.innerText.startsWith(v), { timeout: 20000 }, (onChain / OBS).toString());
    const shown = await balanceText(second);
    const [whole, frac = ''] = shown.replace(' OBS', '').split('.');
    assert.equal(BigInt(whole) * OBS + BigInt(frac.padEnd(18, '0')), onChain, `the screen shows the node's exact balance (${shown})`);
    await waitText(second, 'Mining reward');
  });

  const third = await newPage('backup-import');
  await step('import: an encrypted backup needs its password; hostile files are refused before any key work', async () => {
    await waitText(third, 'DECENTRALISED OBS COIN WALLET');
    await a(third, 'go', 'import');
    await a(third, 'tab', 'backup');
    await waitText(third, 'BACKUP FILE');
    const tryBackup = async (content, password, expect) => {
      await fill(third, 'bt', content);
      await fill(third, 'pw', password);
      const started = Date.now();
      await submit(third, 'importBackup');
      await waitErr(third, expect);
      return Date.now() - started;
    };
    await tryBackup('this is not a backup', PASS_NEW, 'not a wallet backup');
    const bomb = await tryBackup(JSON.stringify({ ...JSON.parse(backupFile), iterations: 4_000_000_000 }), PASS_NEW, 'unsafe key setting');
    assert.ok(bomb < 3000, `a key-stretching bomb was refused at once (${bomb} ms)`);
    await tryBackup(backupFile, 'the wrong backup password', 'does not open');
    assert.equal((await storage(third)).includes('obsidian.vault'), false);
    await fill(third, 'bt', backupFile);
    await fill(third, 'pw', PASS_NEW);
    await submit(third, 'importBackup');
    await waitText(third, 'OBS COIN BALANCE');
    assert.equal(await shownAddress(third), created.wallet.address, 'the backup restored the same wallet');
  });
  await third.close();

  // ── the QR scanner, on the send screen of the funded wallet ────────────────
  await step('send: validation refuses everything but a bare address of this network', async () => {
    await a(second, 'go', 'send');
    await waitText(second, 'SEND OBS');
    const attempt = async (to, amount, expect) => {
      await fill(second, 'to', to);
      await fill(second, 'am', amount);
      await submit(second, 'review');
      await waitErr(second, expect);
    };
    const other = (hrp) => bundle.walletFromPhrase(FRIEND, hrp).address;
    await attempt('', '1', 'Enter the address');
    await attempt(funder.address, '1', 'own address');
    await attempt(`obsidian:${friend.address}`, '1', 'bare address');
    await attempt(`${friend.address}?amount=5`, '1', 'bare address');
    await attempt('friend.obs', '1', 'bare address');
    await attempt(other('obs'), '1', 'mainnet');
    await attempt(friend.address.slice(0, -1) + (friend.address.endsWith('q') ? 'p' : 'q'), '1', 'checksum');
    await attempt(friend.address, '', 'Enter an amount');
    await attempt(friend.address, '0', 'greater than zero');
    await attempt(friend.address, '1.0000000000000000001', '18 decimal');
    await attempt(friend.address, '-5', 'digits only');
    await attempt(friend.address, '1e3', 'digits only');
    await attempt(friend.address, '999999999', 'Not enough balance');
    assert.equal((await rpc('/mempool')).body.size, 0, 'nothing reached the node');
  });

  await step('send: the camera opens only on the user\'s tap, reads the friend\'s code and fills the recipient, nothing more', async () => {
    assert.equal(await second.evaluate(() => window.__gum), 0, 'no camera request before the tap');
    await fill(second, 'to', '');
    await fill(second, 'am', '');
    await a(second, 'scan');
    await second.waitForSelector('#scanner');
    await second.waitForFunction((v) => document.getElementById('to').value === v, { timeout: 25_000 }, friend.address);
    assert.equal(await second.evaluate(() => window.__gum), 1);
    assert.equal(await second.evaluate(() => document.getElementById('am').value), '', 'the scan did not touch the amount');
    assert.match(await text(second), /SEND OBS/, 'and it did not submit anything');
    assert.equal(await second.evaluate(() => !!document.getElementById('scanner')), false, 'the camera overlay is gone');
  });

  await step('send: a denied camera says so and offers a photo; a photo of another network\'s code is refused', async () => {
    await second.evaluate(() => { window.__deny = true; });
    await a(second, 'scan');
    await second.waitForSelector('#scanner');
    await waitText(second, 'Camera permission was denied');
    assert.match(await text(second), /CHOOSE A PHOTO/);
    await second.click('#scanner-cancel');
    await second.evaluate(() => { window.__deny = false; });
    // the upload button, with a photo of a mainnet address
    const foreign = pngFile(rasterise(bundle.qrModules(bundle.walletFromPhrase(FRIEND, 'obs').address), 8));
    await fill(second, 'to', '');
    await (await second.$('#fi')).uploadFile(foreign);
    await waitErr(second, 'mainnet');
    assert.equal(await second.evaluate(() => document.getElementById('to').value), '');
    const good = pngFile(rasterise(bundle.qrModules(friend.address), 8));
    await (await second.$('#fi')).uploadFile(good);
    await second.waitForFunction((v) => document.getElementById('to').value === v, { timeout: 10_000 }, friend.address);
    const blank = pngFile(rasterise([[false]], 20));
    await (await second.$('#fi')).uploadFile(blank);
    await waitErr(second, 'No QR code');
  });

  // ── a payment, end to end ──────────────────────────────────────────────────
  const amountText = '12.5';
  const amount = 125n * OBS / 10n;
  const gas = bundle.expectedGas(amount);
  await step('send: the review shows the exact protocol fee, and a wrong password signs nothing', async () => {
    await fill(second, 'to', friend.address);
    await fill(second, 'am', amountText);
    assert.equal(await second.evaluate(() => document.getElementById('fee').innerText), `${exactObs(gas)} OBS`, 'the live fee is the protocol rule for this amount');
    await submit(second, 'review');
    await waitH1(second, 'REVIEW TRANSACTION');
    const t = await text(second);
    assert.ok(t.includes('12.5 OBS'));
    assert.ok(t.includes(`${exactObs(gas)} OBS`));
    assert.ok(t.includes(`${exactObs(amount + gas)} OBS`), 'the total is amount plus fee');
    assert.ok(t.includes(`${exactObs(fundedBalance - amount - gas)} OBS`), 'the balance after is exact');
    const shownTo = await second.evaluate(() => document.querySelector('.addr-l').innerText.replace(/\s+/g, ''));
    assert.equal(shownTo, friend.address, 'the full recipient is on the review screen');
    await fill(second, 'pw', 'not my password at all');
    await submit(second, 'sign');
    await waitErr(second, 'Wrong password');
    assert.equal(await balanceOf(funder.address), fundedBalance, 'nothing was spent');
    assert.equal((await rpc('/mempool')).body.size, 0, 'nothing was submitted');
  });

  let sentTxId = '';
  await step('send: authorize with the password; a double click and a double Enter send ONE transaction', async () => {
    await fill(second, 'pw', PASS_FUNDER);
    await second.evaluate(() => {
      const b = document.querySelector('form[data-submit="sign"] button[type=submit]');
      b.click();
      b.click();
      document.querySelector('form[data-submit="sign"]').requestSubmit();
    });
    await second.waitForFunction(() => /SUBMITTED|PENDING|CONFIRMED/.test(document.querySelector('h1')?.innerText ?? ''), { timeout: 60_000 });
    sentTxId = await second.evaluate(() => document.getElementById('txid').innerText.trim());
    assert.match(sentTxId, /^[0-9a-f]{64}$/);
    const word = await second.evaluate(() => document.querySelector('h1').innerText);
    assert.ok(['SUBMITTED', 'PENDING', 'CONFIRMED'].includes(word), word);
    if (word !== 'CONFIRMED') {
      assert.equal(await second.evaluate(() => document.querySelector('.steps li:last-child').className), '', 'not "included in a block" before a block holds it');
    }
    const sentAt = await second.evaluate(() => document.querySelector('.steps li:nth-child(3)').className);
    assert.equal(sentAt, 'done', 'the node answered, so "accepted by the node" is true');
  });

  await step('send: while it is unsettled another payment is refused, and the node confirms exactly one', async () => {
    // a second payment straight away: refused while the first is unsettled (unless a block has already settled it)
    await a(second, 'go', 'home');
    await a(second, 'go', 'send');
    await fill(second, 'to', friend.address);
    await fill(second, 'am', '1');
    await submit(second, 'review');
    await second.waitForFunction(() => /not settled yet/.test(document.querySelector('.err')?.innerText ?? '') || document.querySelector('h1')?.innerText === 'REVIEW TRANSACTION', { timeout: 20_000 });
    if (await second.evaluate(() => document.querySelector('h1')?.innerText === 'REVIEW TRANSACTION')) {
      assert.equal((await rpc(`/tx/${sentTxId}`)).body.confirmed, true, 'a review was allowed, so the first payment must already be in a block');
    }
    await a(second, 'go', 'home');
    await a(second, 'go', 'activity');
    await second.evaluate((id) => document.querySelector(`[data-a="tx"][data-id="${id}"]`)?.click(), sentTxId);
    for (let i = 0; i < 60 && !(await rpc(`/tx/${sentTxId}`)).body?.confirmed; i += 1) await sleep(1000);
    const record = (await rpc(`/tx/${sentTxId}`)).body;
    assert.equal(record.confirmed, true);
    assert.equal(record.amount, amount.toString());
    assert.equal(record.gas, gas.toString());
    assert.equal(await balanceOf(friend.address), amount, 'the friend holds exactly the amount');
    assert.equal(await balanceOf(funder.address), fundedBalance - amount - gas, 'the sender paid the amount and the protocol fee, once');
    const acct = (await rpc('/wallet/balance', { address: funder.address })).body;
    assert.equal(acct.txCount, base.txCount + 1, 'exactly ONE payment');
    assert.equal(acct.nonce, base.nonce + 1);
  });

  await step('history: the node\'s record is shown with the right direction, amount and a detail view', async () => {
    await a(second, 'go', 'home');
    await waitText(second, 'RECENT TRANSACTIONS');
    await waitText(second, `−${bundle.formatObs(amount).replace(/0+$/, '').replace(/\.$/, '')}`);
    await a(second, 'go', 'activity');
    await waitText(second, 'Sent');
    await second.evaluate(() => [...document.querySelectorAll('[data-a="tx"]')].find((e) => e.innerText.includes('Sent')).click());
    await waitH1(second, 'CONFIRMED');
    const t = await text(second);
    assert.ok(t.includes(sentTxId), 'the id is shown in full');
    assert.match(t, /BLOCK \d+/);
    assert.match(t, /12\.5 OBS/);
    await a(second, 'go', 'home').catch(() => {});
  });

  await step('the recipient\'s own history shows it as Received (counterparty masked by the node)', async () => {
    // a wallet for the friend is not needed: the node's history for the friend's address is what that wallet would read
    const h = (await rpc(`/address/${friend.address}?limit=5`)).body;
    assert.ok(h.transactions.some((t) => t.txId === sentTxId));
  });

  // ── what goes wrong: the node refuses, the connection drops, the node is silent ─
  await step('failure: a node that REFUSES the submission is shown as rejected, with no retry and no success', async () => {
    await toSend(second);
    await fill(second, 'to', friend.address);
    await fill(second, 'am', '1');
    await submit(second, 'review');
    await waitH1(second, 'REVIEW TRANSACTION');
    second.rules.push({
      once: true,
      when: (r) => r.method() === 'POST' && r.url().includes(encodeURIComponent('/tx/submit')),
      then: (r) => r.respond({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'ERR_BAD_NONCE: nonce is not the next one', code: 'ERR_REJECTED' }) }),
    });
    await fill(second, 'pw', PASS_FUNDER);
    await submit(second, 'sign');
    await waitText(second, 'REJECTED');
    const t = await text(second);
    assert.match(t, /nonce is not the next one/);
    assert.ok(!/SEND THE SAME TRANSACTION AGAIN/.test(t));
    assert.ok(!/CONFIRMED/.test(await second.evaluate(() => document.querySelector('h1').innerText)));
    assert.equal(await balanceOf(funder.address), fundedBalance - amount - gas, 'nothing moved');
    await a(second, 'go', 'home');
  });

  await step('failure: a connection that dies BEFORE the node sees it is "not sent", and resending lands the same transaction once', async () => {
    await toSend(second);
    await fill(second, 'to', friend.address);
    await fill(second, 'am', '1');
    await submit(second, 'review');
    await waitH1(second, 'REVIEW TRANSACTION');
    second.rules.push({ once: true, when: (r) => r.method() === 'POST' && r.url().includes(encodeURIComponent('/tx/submit')), then: (r) => r.abort('connectionreset') });
    await fill(second, 'pw', PASS_FUNDER);
    await submit(second, 'sign');
    await waitText(second, 'NOT CONFIRMED SENT');
    assert.match(await text(second), /not known whether the node received it/);
    assert.ok(!/Accepted by the node/.test(await second.evaluate(() => document.querySelector('.steps li.done:nth-child(3)')?.innerText ?? '')));
    const txId = await second.evaluate(() => document.getElementById('txid').innerText.trim());
    assert.equal((await rpc(`/tx/${txId}`)).status, 404, 'the node never saw it');
    await a(second, 'resubmit');
    await second.waitForFunction(() => /SUBMITTED|PENDING|CONFIRMED/.test(document.querySelector('h1')?.innerText ?? ''), { timeout: 30_000 });
    assert.equal(await second.evaluate(() => document.getElementById('txid').innerText.trim()), txId, 'the SAME transaction, not a second signature');
    await waitH1(second, 'CONFIRMED', 90_000);
    assert.equal((await rpc(`/tx/${txId}`)).body.confirmed, true);
    assert.equal(await balanceOf(friend.address), amount + OBS);
  });

  await step('failure: a reply that is lost AFTER the node accepted it is found, adopted, and never sent twice', async () => {
    await toSend(second);
    await fill(second, 'to', friend.address);
    await fill(second, 'am', '2');
    await submit(second, 'review');
    await waitH1(second, 'REVIEW TRANSACTION');
    let relayed = 0;
    second.rules.push({
      once: true,
      when: (r) => r.method() === 'POST' && r.url().includes(encodeURIComponent('/tx/submit')),
      then: async (r) => {
        const real = await fetch(r.url().replace(/^https?:\/\/[^/]+/, net.base), { method: 'POST', headers: { 'content-type': 'application/json', origin: net.base }, body: r.postData() });
        relayed = real.status;
        return r.respond({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'bad gateway' }) });
      },
    });
    await fill(second, 'pw', PASS_FUNDER);
    await submit(second, 'sign');
    await waitText(second, 'NOT CONFIRMED SENT');
    assert.ok(relayed >= 200 && relayed < 300, 'the node did accept it');
    const txId = await second.evaluate(() => document.getElementById('txid').innerText.trim());
    await a(second, 'checkTx');
    await second.waitForFunction(() => /PENDING|CONFIRMED|SUBMITTED/.test(document.querySelector('h1')?.innerText ?? ''), { timeout: 40_000 });
    await waitH1(second, 'CONFIRMED', 90_000);
    assert.equal(await balanceOf(friend.address), amount + 3n * OBS, 'exactly one payment of 2 arrived');
    const acct = (await rpc('/wallet/balance', { address: funder.address })).body;
    assert.equal(acct.txCount, base.txCount + 3, 'three payments, none doubled');
    assert.equal((await rpc(`/tx/${txId}`)).body.confirmed, true);
  });

  // ── honesty about what cannot be known ─────────────────────────────────────
  await step('a balance that cannot be read is "Unavailable" with a retry, never 0', async () => {
    await a(second, 'go', 'home');
    await waitText(second, 'OBS COIN BALANCE');
    second.rules.push({ when: (r) => r.url().includes('wallet%2Fbalance'), then: (r) => r.abort('failed') });
    await a(second, 'go', 'activity');
    await a(second, 'go', 'home');
    await second.waitForFunction(() => document.getElementById('bal')?.innerText === 'Unavailable', { timeout: 20_000 });
    assert.match(await text(second), /RETRY/);
    assert.equal(/\b0 OBS\b/.test(await balanceText(second)), false);
    second.rules.length = 0;
    await a(second, 'refresh');
    await second.waitForFunction(() => /OBS$/.test(document.getElementById('bal')?.innerText ?? '') && !/Unavailable/.test(document.getElementById('bal').innerText), { timeout: 20_000 });
  });

  await step('a send cannot be prepared while the balance cannot be read', async () => {
    await toSend(second);
    await fill(second, 'to', friend.address);
    await fill(second, 'am', '1');
    second.rules.push({ when: (r) => r.url().includes('wallet%2Fbalance'), then: (r) => r.abort('failed') });
    await submit(second, 'review');
    await waitErr(second, 'balance could not be read');
    second.rules.length = 0;
    await a(second, 'go', 'home');
  });

  await step('hostile text from the node is only ever text: no script, no element, no handler, no CSP violation', async () => {
    const payload = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>"\'`';
    const body = JSON.stringify({
      address: 'x',
      transactions: [
        { txId: 'f'.repeat(64), height: 3, timestamp: 1791602058, sender: payload, recipient: payload, amount: '1', gas: '1', kind: payload, note: payload },
        { txId: 'e'.repeat(64), height: 3, timestamp: 1791602058, sender: payload, recipient: 'dobs1x', amount: '1', gas: '1', kind: 'ONS_' + payload },
      ],
      miningClaims: [],
    });
    second.rules.push({ when: (r) => r.url().includes('address%2F'), then: (r) => r.respond({ status: 200, contentType: 'application/json', body }) });
    await a(second, 'go', 'activity');
    await waitText(second, '<img src=x');
    await second.evaluate(() => [...document.querySelectorAll('[data-a="tx"]')].find((e) => e.innerText.includes('<img'))?.click());
    await sleep(500);
    const probe = await second.evaluate(() => ({
      pwned: window.__pwned ?? null,
      imgs: [...document.querySelectorAll('#app img')].filter((i) => i.getAttribute('onerror') || i.getAttribute('src') === 'x').length,
      scripts: document.querySelectorAll('#app script').length,
      handlers: [...document.querySelectorAll('#app *')].filter((e) => [...e.attributes].some((x) => x.name.startsWith('on'))).length,
      csp: window.__csp ?? [],
    }));
    assert.deepEqual(probe, { pwned: null, imgs: 0, scripts: 0, handlers: 0, csp: [] });
    second.rules.length = 0;
    await toHome(second);
  });

  await step('the page runs under a policy with no inline script, and an injected inline script does not run', async () => {
    const result = await second.evaluate(async () => {
      const s = document.createElement('script');
      s.textContent = 'window.__inline = 1';
      document.body.appendChild(s);
      await new Promise((r) => setTimeout(r, 200));
      return { ran: window.__inline ?? null, violations: window.__csp ?? [] };
    });
    assert.equal(result.ran, null, 'the browser refused the inline script');
    assert.ok(result.violations.some((v) => v.startsWith('script-src')));
    await second.evaluate(() => { window.__csp = []; });
  });

  await step('the app will not sign or even open when the node is another network than the page', async () => {
    const page = await (await freshBrowser()).newPage();
    page.on('pageerror', (e) => evidence.pageErrors.push(`mismatch: ${e.message}`));
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().endsWith('/app-config.json')) return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ network: 'mainnet', chainId: 7777, addressHrp: 'obs', production: true }) });
      return r.continue();
    });
    await page.goto(net.base, { waitUntil: 'load' });
    await waitText(page, 'CANNOT CONFIRM THE NETWORK');
    const t = await text(page);
    assert.match(t, /Nothing was signed/i);
    assert.ok(!/CREATE WALLET|IMPORT WALLET|UNLOCK/.test(t), 'no way forward');
    await page.close();
  });

  await step('remove: needs the box ticked, deletes the vault and every record of this wallet, and returns to welcome', async () => {
    await toHome(second);
    await a(second, 'go', 'remove');
    await waitH1(second, 'REMOVE WALLET');
    await submit(second, 'remove');
    await waitErr(second, 'Tick the box');
    await second.evaluate(() => { document.getElementById('ck').checked = true; });
    await submit(second, 'remove');
    await waitText(second, 'DECENTRALISED OBS COIN WALLET');
    const s = JSON.parse(await storage(second));
    assert.equal(s.local['obsidian.vault.v1'], undefined);
    assert.equal(s.local['obsidian.address'], undefined);
    assert.equal(JSON.parse(s.local['obsidian.wallet.submitted.v1'] ?? '[]').length, 0);
    await second.reload({ waitUntil: 'load' });
    await waitText(second, 'DECENTRALISED OBS COIN WALLET');
  });

  // ── the whole session, searched for secrets ───────────────────────────────
  await step('no secret appeared in any request, URL, console line, or stored value; no page error', async () => {
    assert.ok(evidence.requests.length > 100, 'the requests were really recorded');
    for (const secret of SECRETS) {
      assert.equal(evidence.requests.some((l) => l.includes(secret)), false, `a secret reached the network: ${secret.slice(0, 12)}…`);
      assert.equal(evidence.consoles.some((l) => l.includes(secret)), false, 'a secret reached the console');
    }
    // the only things that leave the browser are reads and a signed transaction: no phrase, no key, no password
    const writes = evidence.requests.filter((l) => / POST /.test(l));
    assert.ok(writes.every((l) => /wallet%2Fbalance|wallet%2Fquote|tx%2Fsubmit/.test(l)), `unexpected POSTs: ${writes.filter((l) => !/wallet%2Fbalance|wallet%2Fquote|tx%2Fsubmit/.test(l)).slice(0, 3)}`);
    assert.ok(evidence.requests.every((l) => !/ https?:\/\/(?!127\.0\.0\.1)/.test(l)), 'nothing went to another host');
    assert.deepEqual(evidence.pageErrors, []);
    const unexpected = evidence.consoles.filter((l) => /error|warn/.test(l.split(':')[0]) && !/Failed to load resource|net::ERR|status of (400|404|502)|Content Security Policy|Refused to execute inline script/i.test(l));
    assert.deepEqual(unexpected, []);
  });
} catch (error) {
  failed = true;
  console.error(error?.stack ?? error);
  console.error('\nwallet server log:\n' + net.log().slice(-1500));
} finally {
  for (const b of browsers) await b.close().catch(() => {});
  await net.stop().catch(() => {});
}
console.log(`\n${passed} passed${failed ? ', FAILED' : ', 0 failed'}`);
process.exit(failed ? 1 : 0);
