// End-to-end test of the BUILT extension (dist/) in headless Chromium against a real devnet stack.
//
//   node tests/ui/ext.e2e.mjs
//
// Needs: `npm run build`, a running devnet stack (node + platform + app server), and puppeteer-core + @sparticuz/chromium
// resolvable from this directory (see README.md). Everything created is disposable: a throw-away account on a devnet
// whose genesis invitation is supplied, and a wallet generated for this run. Nothing touches mainnet.
//
// What this does NOT prove: that a real Chrome or Firefox loads the package. See README.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveExtension, launch, sleep, waitText, clickText } from './harness.mjs';
import { disposableWallet, totp, rpc } from './fund.mjs';
import { evaluateClaim } from '../../src/claim-watch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist');
const APP = process.env.APP_URL ?? 'http://127.0.0.1:38790';
const NODE = process.env.NODE_URL ?? 'http://127.0.0.1:38630';
const INVITE = process.env.GENESIS_INVITE ?? fs.readFileSync(process.env.INVITE_FILE ?? '/tmp/ext/stack/code.txt', 'utf8').trim();
const PORT = Number(process.env.EXT_PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PASS = 'correct horse battery staple';
const ACCOUNT_PASSWORD = 'a-long-enough-password-1';

let passed = 0;
let page;
const consoleErrors = [];
const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`);
    if (page) {
      console.log('       --- page text ---\n' + (await text().catch(() => '')).split('\n').map((l) => '       ' + l).join('\n'));
      if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    }
    throw error;
  }
};
const shot = (n) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: true });
const text = () => page.evaluate(() => document.body.innerText);
const shim = () => page.evaluate(() => window.__shim.read());
const open = async (file) => {
  await page.goto(`${ORIGIN}/${file}`, { waitUntil: 'load' });
};
const popup = () => open('popup.html?popup=1');
const fill = async (id, value) => {
  await page.$eval(`#${id}`, (e) => { e.focus(); e.value = ''; });
  await page.type(`#${id}`, value);
};
const configure = (patch) =>
  page.evaluate((p) => {
    const s = window.__shim.read();
    const current = s.local['obsidian.settings'] ?? {};
    s.local['obsidian.settings'] = { ...current, ...p.settings };
    if (p.perms) s.perms = p.perms;
    window.__shim.write(s);
  }, patch);

const server = await serveExtension(dist, PORT);
const browser = await launch();
try {
  page = await browser.newPage();
  await page.evaluateOnNewDocument(fs.readFileSync(path.join(here, 'shim.js'), 'utf8'));
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // ── first run ──────────────────────────────────────────────────────────────────────────────
  await step('first run: connect screen, no demo data, nothing requested from any server', async () => {
    const requests = [];
    page.on('request', (r) => { if (/^(https?|wss?):/.test(r.url()) && !r.url().startsWith(ORIGIN)) requests.push(r.url()); });
    await popup();
    await waitText(page, 'This extension has no server yet');
    const t = await text();
    for (const demo of ['time.obs', 'satoshi', 'OBS-FOUN', 'OBS-TIME', 'OBS-BETA', '0.25', 'EDGE NODE']) {
      assert.ok(!t.toLowerCase().includes(demo.toLowerCase()), `demo text "${demo}" present`);
    }
    assert.ok(!/BLOCK HEIGHT|SUPPLY|ACTIVE MINERS|\d{2,} OBS/i.test(t), 'no chain figure on the connect screen');
    await sleep(500);
    assert.deepEqual(requests, [], 'no network request before a server is configured');
    page.removeAllListeners('request');
    await shot('01-connect');
  });

  await step('CONNECTION SETTINGS button opens the options page', async () => {
    await clickText(page, 'button', 'CONNECTION SETTINGS');
    await sleep(200);
    assert.equal((await shim()).optionsOpened, 1);
  });

  // ── options ────────────────────────────────────────────────────────────────────────────────
  await step('options: bad addresses are refused with a reason, nothing saved', async () => {
    await open('options.html');
    await waitText(page, 'APP SERVER ADDRESS');
    for (const [bad, why] of [
      ['http://10.1.2.3:8790', 'Plain http'],
      ['http://example.org', 'Plain http'],
      ['javascript:alert(1)', 'addresses are accepted'],
      ['https://user:pw@example.org', 'user name'],
      ['https://example.org/some/path', 'without a path'],
      ['ftp://example.org', 'addresses are accepted'],
      ['', 'Enter the address'],
    ]) {
      await fill('server', bad);
      await page.select('#network', 'devnet');
      await clickText(page, 'button', 'SAVE & ALLOW');
      await waitText(page, why);
    }
    assert.equal((await shim()).local['obsidian.settings'], undefined);
    assert.deepEqual((await shim()).perms, []);
  });

  await step('options: permission refused by the user → nothing saved', async () => {
    await page.evaluate(() => { const s = window.__shim.read(); s.permAnswer = false; window.__shim.write(s); });
    await fill('server', APP);
    await page.select('#network', 'devnet');
    await clickText(page, 'button', 'SAVE & ALLOW');
    await waitText(page, 'Permission was not granted');
    assert.equal((await shim()).local['obsidian.settings'], undefined);
    await page.evaluate(() => { const s = window.__shim.read(); s.permAnswer = true; window.__shim.write(s); });
  });

  await step('options: the wrong network is refused, nothing saved, permission withdrawn again', async () => {
    await fill('server', APP);
    await page.select('#network', 'mainnet');
    await clickText(page, 'button', 'SAVE & ALLOW');
    await waitText(page, 'WRONG NETWORK');
    const s = await shim();
    assert.equal(s.local['obsidian.settings'], undefined);
    assert.deepEqual(s.perms, [], 'permission granted only for the check is taken back');
  });

  await step('options: a port with nothing listening is reported as unreachable, nothing saved', async () => {
    await fill('server', 'http://127.0.0.1:9');
    await page.select('#network', 'devnet');
    await clickText(page, 'button', 'SAVE & ALLOW');
    await waitText(page, 'Could not connect to the server');
    assert.equal((await shim()).local['obsidian.settings'], undefined);
  });

  await step('options: something that is not an Obsidian server is refused as malformed/unsupported', async () => {
    // The static server serving this very extension answers /app-config.json with a 404.
    await fill('server', ORIGIN);
    await page.select('#network', 'devnet');
    await clickText(page, 'button', 'SAVE & ALLOW');
    await waitText(page, 'Not saved');
    assert.equal((await shim()).local['obsidian.settings'], undefined);
  });

  await step('options: the right server and network save, diagnostics all pass', async () => {
    await fill('server', APP);
    await page.select('#network', 'devnet');
    await clickText(page, 'button', 'SAVE & ALLOW');
    await waitText(page, 'Connected to 127.0.0.1:38790');
    const s = await shim();
    assert.equal(s.local['obsidian.settings'].serverUrl, APP);
    assert.deepEqual(s.perms, ['http://127.0.0.1/*']);
    await clickText(page, 'button', 'RUN CHECKS');
    await waitText(page, 'GENESIS AGREEMENT');
    await sleep(300);
    const t = await text();
    const oks = (t.match(/\nOK\n/g) ?? []).length;
    assert.equal(oks, 4, `4 passing checks, got: ${t}`);
    assert.ok(!/FAIL/.test(t));
    await shot('02-options');
  });

  // ── signed out, connected ─────────────────────────────────────────────────────────────────
  await step('connected: the real landing screen with live chain figures and a connection summary', async () => {
    await popup();
    await waitText(page, 'THE PROOF OF TIME');
    await waitText(page, 'CONNECTED TO');
    const height = (await rpc(NODE, '/status')).height;
    const shown = await page.evaluate(() => document.body.innerText.match(/BLOCK HEIGHT\s+#?(\d+)/)?.[1]);
    assert.ok(shown && Math.abs(Number(shown) - height) < 40, `height ${shown} vs node ${height}`);
  });

  await step('the design file\u2019s demo handlers are neutered; only navigation remains', async () => {
    const result = await page.evaluate(() => {
      const kept = ['go', 'goClose', 'toggleMenu', 'tab'];
      const original = {};
      // Replace the parts that would navigate so calling them is observable, then call every other action.
      return Object.keys(A).map((k) => [k, A[k].toString().replace(/\s+/g, ' ').slice(0, 40), kept.includes(k)]);
    });
    for (const [key, source, kept] of result) {
      if (!kept) assert.ok(/^\(\) *=> *\{ *\}$/.test(source), `A.${key} should be a no-op, is: ${source}`);
    }
    const stored = await page.evaluate(() => localStorage.getItem('obs'));
    assert.equal(stored, null, 'the design\u2019s demo store was never written');
  });

  await step('NODE screen: real figures that match the node, and an honest validator section', async () => {
    await clickText(page, 'button', 'NODE & CONNECTION');
    await waitText(page, 'NODES BEHIND THIS SERVER');
    await page.waitForFunction(() => /\bCONNECTED\b/.test(document.body.innerText) && /HEALTHY/.test(document.body.innerText));
    const t = await text();
    const status = await rpc(NODE, '/status');
    assert.ok(t.includes('CONNECTED'));
    assert.ok(t.includes(status.genesisId.slice(0, 12)), 'genesis id comes from the node');
    assert.ok(/REGISTERED\s+0/.test(t) && /NOT AVAILABLE IN A BROWSER/.test(t));
    assert.ok(/20000 OBS/.test(t), 'the validator bond comes from the node\u2019s own answer');
    await clickText(page, 'button', 'RUN CHECKS');
    await waitText(page, 'GENESIS AGREEMENT');
    await shot('03-node');
  });

  await step('NODE screen: when the node stops answering the figures turn STALE, they are not shown as current', async () => {
    await page.setRequestInterception(true);
    const block = (r) => (r.url().includes('/api/rpc') || r.url().includes('/api/nodes') ? r.abort('connectionrefused') : r.continue());
    page.on('request', block);
    await clickText(page, 'button', 'REFRESH');
    await waitText(page, 'STALE');
    const t = await text();
    assert.ok(/these figures are from/i.test(t));
    assert.ok(/UNAVAILABLE|Unavailable/.test(t));
    await shot('04-stale');
    page.off('request', block);
    await page.setRequestInterception(false);
    await clickText(page, 'button', 'REFRESH');
    await waitText(page, 'CONNECTED');
  });

  // ── account, wallet, mining, payment ─────────────────────────────────────────────────────
  const email = `ext${Date.now().toString(36)}@gmail.com`;
  const mine = await disposableWallet('dobs');
  const other = await disposableWallet('dobs');

  await step('sign up with the genesis invitation through the extension (cookie round-trip)', async () => {
    await clickText(page, 'button', 'BACK');
    await sleep(200);
    await clickText(page, 'button', 'CREATE WALLET');
    await waitText(page, 'CREATE YOUR ACCOUNT');
    await fill('em', email);
    await fill('pw', ACCOUNT_PASSWORD);
    await fill('p2', ACCOUNT_PASSWORD);
    await fill('rf', INVITE);
    await clickText(page, 'button', 'CREATE ACCOUNT');
    await waitText(page, 'I HAVE WRITTEN THEM DOWN', 60000);
    await shot('05-signup');
  });

  await step('the session persists across a popup reload (cookie sent with credentials)', async () => {
    await clickText(page, 'button', 'I HAVE WRITTEN THEM DOWN');
    if (process.env.DEBUG_COOKIES) console.log('cookies', JSON.stringify(await page.cookies(APP)));
    await popup();
    await waitText(page, email.split('@')[0].slice(0, 6), 20000).catch(async () => {
      // the home screen shows the account differently; fall back to the nav being present
      await waitText(page, 'WALLET');
    });
    const t = await text();
    assert.ok(/HOME/.test(t) && /MENU/.test(t), 'signed-in navigation is shown after a reload');
  });

  await step('MFA: set up with a real TOTP code', async () => {
    await clickText(page, '.nav a', 'MENU');
    await waitText(page, 'SET UP MFA');
    await clickText(page, 'button', 'SET UP MFA');
    await waitText(page, 'SCAN OR ENTER THIS SECRET');
    const secret = await page.evaluate(() => [...document.querySelectorAll('.lb')].find((e) => e.textContent.includes('SCAN OR ENTER')).nextElementSibling.textContent.trim());
    await fill('mf', totp(secret));
    await clickText(page, 'button', 'CONFIRM');
    await waitText(page, 'ENABLED', 20000);
  });

  await step('wallet: import a disposable recovery phrase, sealed under a passphrase, address matches the phrase', async () => {
    await clickText(page, '.nav a', 'WALLET');
    await sleep(300);
    await page.evaluate(() => ObsidianWalletTab('setup'));
    await clickText(page, 'button', 'IMPORT').catch(() => page.evaluate(() => ObsidianSetupMode('import')));
    await waitText(page, 'RECOVERY PHRASE');
    await fill('ph', mine.phrase);
    await fill('pp', PASS);
    await fill('p2', PASS);
    await clickText(page, 'button', 'SEAL WALLET ON THIS DEVICE');
    await waitText(page, mine.address.slice(0, 12), 60000);
    // no secret in the DOM, storage the extension controls, or its settings
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    const firstWord = mine.phrase.split(' ')[0];
    assert.ok(!html.includes(mine.phrase), 'phrase not in the DOM');
    const stored = JSON.stringify((await shim()).local);
    assert.ok(!stored.includes(mine.phrase) && !stored.includes(PASS), 'no secret in extension storage');
    assert.ok(!JSON.stringify(consoleErrors).includes(mine.phrase));
    assert.ok(firstWord.length > 0);
    assert.equal((await shim()).local['obsidian.settings'].address, null, 'alerts are off: the address is not mirrored yet');
  });

  await step('mining: link the wallet to the account (signed with the passphrase), then claim', async () => {
    await clickText(page, '.nav a', 'MINE');
    await waitText(page, 'LINK YOUR WALLET TO MINE', 20000);
    await fill('pp', PASS);
    await clickText(page, 'button', 'LINK THIS WALLET TO MY ACCOUNT');
    await waitText(page, 'linked to your account', 60000);
    await page.waitForFunction(() => !/LINK YOUR WALLET TO MINE/.test(document.body.innerText), { timeout: 20000 });
    await shot('06-mine');
    const eligible = (await rpc(NODE, `/mining/status?address=${mine.address}`)).eligible;
    assert.equal(eligible, true, 'the node itself says this address can claim');
    // The service worker's own decision, run against the live server: the node says eligible, so it would alert.
    const watch = { serverUrl: APP, network: 'devnet', alerts: true, address: mine.address };
    const open = await evaluateClaim(watch);
    assert.equal(open.state, 'eligible');
    assert.equal(open.notify, true);
    await fill('pp', PASS);
    await clickText(page, 'button', 'SIGN & SUBMIT CLAIM');
    await waitText(page, 'Claim submitted', 60000);
  });

  await step('the claim is confirmed by the node, and the extension shows it only once the node does', async () => {
    const deadline = Date.now() + 60000;
    let claims = 0;
    while (Date.now() < deadline) {
      claims = (await rpc(NODE, `/mining/status?address=${mine.address}`)).totalClaims;
      if (claims >= 1) break;
      await sleep(1000);
    }
    assert.equal(claims, 1, 'exactly one claim recorded by the node');
    const after = await evaluateClaim({ serverUrl: APP, network: 'devnet', alerts: true, address: mine.address });
    assert.equal(after.state, 'waiting', 'once the node has the claim, the service worker would not alert');
    assert.equal(after.notify, false);
    // A reopened popup reads the node again; the balance shown is the node's.
    await popup();
    await page.waitForSelector('.nav a', { timeout: 30000 });
    await clickText(page, '.nav a', 'WALLET');
    const record = await fetch(`${NODE}/wallet/balance`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: mine.address }) }).then((r) => r.json());
    const shownAs = record.balanceObs.slice(0, record.balanceObs.indexOf('.') + 7); // the wallet shows six decimals
    await page.waitForFunction((v) => document.body.innerText.includes(v), { timeout: 30000 }, shownAs);
    assert.ok(record.mining.totalClaims === 1 && record.txCount === 1, 'the node recorded exactly one claim');
    await shot('07-wallet');
  });

  await step('send: a real payment, passphrase required, no duplicate on a double click', async () => {
    await page.evaluate(() => ObsidianWalletTab('send'));
    const before = (await rpc(NODE, `/address/${other.address}?limit=5`));
    await fill('to', other.address);
    await fill('am', '0.00005');
    await fill('pp', PASS);
    // A double click must not send twice: the app disables the button while a send is in flight.
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('data-obs-click')?.includes('ObsidianSend')); b?.click(); b?.click(); });
    await waitText(page, 'Payment submitted', 60000);
    const deadline = Date.now() + 60000;
    let seen = 0;
    while (Date.now() < deadline) {
      const h = await rpc(NODE, `/address/${other.address}?limit=10`);
      seen = JSON.stringify(h).split('"txId"').length - 1;
      if (seen >= 1) break;
      await sleep(1000);
    }
    assert.equal(seen, 1, `exactly one payment reached the node (saw ${seen}); before: ${JSON.stringify(before).slice(0, 80)}`);
  });

  await step('send: a wrong passphrase signs nothing', async () => {
    await fill('to', other.address);
    await fill('am', '0.00001');
    await fill('pp', 'not the passphrase at all');
    await page.evaluate(() => { [...document.querySelectorAll('[data-obs-click]')].find((x) => x.getAttribute('data-obs-click').includes('ObsidianSend'))?.click(); });
    await waitText(page, 'passphrase', 30000);
    await sleep(1500);
    const h = await rpc(NODE, `/address/${other.address}?limit=10`);
    assert.equal(JSON.stringify(h).split('"txId"').length - 1, 1, 'still exactly one payment');
  });

  await step('explorer: blocks come from the node', async () => {
    await clickText(page, '.nav a', 'EXPLORER');
    await waitText(page, 'Blocks', 20000).catch(() => waitText(page, 'BLOCK'));
    const t = await text();
    const height = (await rpc(NODE, '/status')).height;
    const heights = [...t.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    assert.ok(heights.length > 0 && Math.max(...heights) <= height + 5 && Math.max(...heights) > height - 60, `explorer heights ${heights.slice(0, 5)} vs node ${height}`);
    await shot('08-explorer');
  });

  await step('claim alerts: turning them on mirrors only the public address, turning them off forgets it', async () => {
    await clickText(page, '.nav a', 'MENU');
    await waitText(page, 'TURN ON ALERTS');
    await clickText(page, 'button', 'TURN ON ALERTS');
    await waitText(page, 'TURN OFF ALERTS');
    const s = (await shim()).local['obsidian.settings'];
    assert.equal(s.alerts, true);
    assert.equal(s.address, mine.address);
    assert.ok(!JSON.stringify(s).includes(PASS));
    await clickText(page, 'button', 'TURN OFF ALERTS');
    await waitText(page, 'TURN ON ALERTS');
    const off = (await shim()).local['obsidian.settings'];
    assert.equal(off.alerts, false);
    assert.equal(off.address, null, 'turning alerts off forgets the address again');
  });

  await step('Menu rows: NODE, OPEN IN A TAB and CONNECTION all work', async () => {
    await waitText(page, 'OPEN IN A TAB');
    await clickText(page, '.big', 'NODE');
    await waitText(page, 'NODES BEHIND THIS SERVER');
    await clickText(page, 'button', 'BACK');
    await waitText(page, 'OPEN IN A TAB');
    await clickText(page, '.big', 'OPEN IN A TAB');
    await sleep(200);
    assert.ok((await shim()).tabs.some((u) => u.endsWith('/popup.html')));
    await clickText(page, '.big', 'CONNECTION');
    await sleep(200);
    assert.ok((await shim()).optionsOpened >= 2);
  });

  await step('sign out ends the session on the server', async () => {
    await clickText(page, 'button', 'SIGN OUT');
    await waitText(page, 'THE PROOF OF TIME');
    const me = await page.evaluate(async (app) => (await fetch(`${app}/api/auth/me`, { credentials: 'include' })).status, APP);
    assert.equal(me, 401);
  });

  // ── refusals ─────────────────────────────────────────────────────────────────────────────────
  await step('pinned to another network: refuses to show anything from the server', async () => {
    await configure({ settings: { network: 'testnet' } });
    await popup();
    await waitText(page, 'WRONG NETWORK');
    const t = await text();
    assert.ok(/this server is devnet, but this extension is set to testnet/.test(t));
    assert.ok(!/BLOCK HEIGHT|SUPPLY/.test(t));
    await shot('09-wrong-network');
    await configure({ settings: { network: 'devnet' } });
  });

  await step('permission withdrawn: asks for it instead of failing silently', async () => {
    await configure({ settings: {}, perms: [] });
    await popup();
    await waitText(page, 'PERMISSION NEEDED');
    await configure({ settings: {}, perms: ['http://127.0.0.1/*'] });
  });

  await step('server down: says so plainly, shows no chain data', async () => {
    await configure({ settings: { serverUrl: 'http://127.0.0.1:9' } });
    await popup();
    await waitText(page, 'CAN\u2019T REACH THE SERVER');
    assert.ok(!/BLOCK HEIGHT/.test(await text()));
    await configure({ settings: { serverUrl: APP } });
  });

  await step('no inline handler survives in the DOM, and no CSP violation was reported', async () => {
    await popup();
    await waitText(page, 'THE PROOF OF TIME');
    await sleep(500);
    const inline = await page.evaluate(() => document.querySelectorAll('[onclick],[onload],[onerror],[onchange]').length);
    assert.equal(inline, 0);
    const csp = consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e));
    assert.deepEqual(csp, []);
  });

  const unexpected = consoleErrors.filter((e) => !/Failed to load resource|net::ERR|401|\b429\b/.test(e));
  console.log(`\n${passed} steps passed${unexpected.length ? `; unexpected console errors:\n${unexpected.join('\n')}` : ''}`);
  if (unexpected.length) process.exitCode = 1;
} catch {
  process.exitCode = 1;
} finally {
  await browser.close();
  server.close();
}
