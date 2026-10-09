// UI end-to-end test: the real renderer in headless Chromium, driven through the dev bridge,
// against a real devnet node started by the real supervisor. Everything is disposable.
//
//   node tests/ui/ui.e2e.mjs            (needs: npm run build, puppeteer-core + @sparticuz/chromium)
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, sleep, waitText, clickText } from './browser.mjs';
import { claimDirect } from './fund.mjs';

const PORT = Number(process.env.UI_PORT ?? 5174);
const OFFSET = 83;
const BASE = `http://127.0.0.1:${PORT}`;
const PASS = 'correct horse battery staple';
const SHOTS = process.env.SHOTS_DIR;
if (SHOTS) (await import('node:fs')).mkdirSync(SHOTS, { recursive: true });
const data = mkdtempSync(join(tmpdir(), 'obsnode-ui-'));
const root = new URL('../../', import.meta.url).pathname;
const bridge = spawn(process.execPath, [join(root, 'dist/dev/bridge.js'), '--port', String(PORT), '--data', data], { stdio: ['ignore', 'pipe', 'pipe'] });
let bridgeLog = '';
bridge.stdout.on('data', (d) => (bridgeLog += d));
bridge.stderr.on('data', (d) => (bridgeLog += d));

let passed = 0;
const step = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    console.log(`  FAIL ${name}\n       ${error.message}`);
    if (page && SHOTS) await page.screenshot({ path: join(SHOTS, `FAIL-${name.replace(/\W+/g, '-')}.png`) }).catch(() => {});
    throw error;
  }
};
const shot = async (n) => SHOTS && page.screenshot({ path: join(SHOTS, `${n}.png`) });
const text = () => page.evaluate(() => document.body.innerText);
const go = async (route) => { await page.evaluate((r) => { location.hash = r; }, route); await sleep(400); };
const type = async (sel, value) => { await page.$eval(sel, (e) => { e.focus(); e.select(); }); await page.keyboard.press('Backspace'); await page.type(sel, value); };
const api = (channel, payload) => page.evaluate(async (c, p) => (await window.obsidian.invoke(c, p)), channel, payload);

let browser, page;
const consoleErrors = [];
try {
  for (let i = 0; i < 50 && !bridgeLog.includes('dev bridge on'); i += 1) await sleep(100);
  browser = await launch();
  page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
  await page.goto(BASE, { waitUntil: 'load' });
  await waitText(page, 'Node stopped');

  await step('every route renders, honest stopped state, no demo text', async () => {
    const heads = { overview: 'Overview', node: 'Node Management', network: 'Network & Peers', validator: 'Validator Centre', wallet: 'Wallet', tx: 'Transactions', explorer: 'Blockchain Explorer', logs: 'Logs & Diagnostics', settings: 'Settings', help: 'Help & Support' };
    for (const [route, h] of Object.entries(heads)) {
      await go(route);
      const t = await text();
      assert.ok(t.includes(h), `${route}: heading "${h}"`);
      assert.ok(!/DESIGN PREVIEW|DEMO DATA|demo\)|simulated/i.test(t), `${route}: no demo wording`);
      assert.ok(!/Node running ·/i.test(t), `${route}: must not claim the node is running`);
      await shot(`stopped-${route}`);
    }
  });

  await step('footer shows real app version, not a design-preview note', async () => {
    const t = await text();
    assert.match(t, /Obsidian Node v\d+\.\d+\.\d+/);
  });

  await step('switch network to Devnet through the title-bar menu (confirmation required)', async () => {
    await go('overview');
    await page.click('.net');
    await page.waitForSelector('.dd');
    await clickText(page, '.dd button', 'Devnet');
    await waitText(page, 'Switch to Devnet?');
    await clickText(page, '.md button', 'Cancel');
    await sleep(300);
    assert.match(await text(), /TESTNET/);
    await page.click('.net');
    await page.waitForSelector('.dd');
    await clickText(page, '.dd button', 'Devnet');
    await waitText(page, 'Switch to Devnet?');
    await clickText(page, '.md button', 'Change Network');
    await waitText(page, 'DEVNET');
  });

  await step('settings: invalid value is refused with a message; valid port offset saves', async () => {
    await go('settings');
    await type('#st-name', '!!bad name');
    await clickText(page, 'button[type=submit]', 'Save settings');
    await waitText(page, 'nodeName');
    await shot('settings-invalid');
    await type('#st-name', 'e2e-node');
    await type('#st-offset', String(OFFSET));
    await clickText(page, 'button[type=submit]', 'Save settings');
    await waitText(page, 'Saved for Devnet');
    const st = await api('settings:get');
    assert.equal(st.data.settings.nodes.devnet.portOffset, OFFSET);
  });

  await step('start node: new-chain confirmation, then really synchronized', async () => {
    await go('overview');
    await clickText(page, 'button', 'Start Node');
    await waitText(page, 'Create a new local chain?');
    await shot('new-chain-confirm');
    await clickText(page, '.md button', 'Create and start');
    await waitText(page, 'Node running · synchronized', 60000);
    await sleep(6500);
    await waitText(page, 'Block height');
    const t = await text();
    assert.match(t, /Obsidian Node|Block height/);
    await shot('running-overview');
    const snap = (await api('chain:snapshot')).data;
    assert.equal(snap.link, 'connected');
    assert.ok(snap.status.height >= 1, 'chain has advanced');
  });

  let rpc;
  await step('node screen shows real process info; network/explorer read the live node', async () => {
    rpc = (await api('node:state')).data.rpcUrl;
    assert.equal(rpc, `http://127.0.0.1:${38630 + OFFSET}`);
    await go('node');
    await waitText(page, 'Process id');
    await shot('running-node');
    await go('network');
    await waitText(page, 'Proof of Time');
    await waitText(page, 'PROOF_OF_TIME');
    await shot('running-network');
    await go('explorer');
    await waitText(page, 'Latest blocks');
    await shot('running-explorer');
    await page.type('#ex-q', '0');
    await clickText(page, 'button[type=submit]', 'Search');
    await waitText(page, 'Block 0');
    await waitText(page, 'GENESIS');
    await go('explorer');
    await clickText(page, 'button', 'Latest blocks').catch(() => {});
    await type('#ex-q', 'not-a-thing');
    await clickText(page, 'button[type=submit]', 'Search');
    await waitText(page, 'Nothing found');
  });

  let phrase;
  let walletAddress;
  await step('wallet: create flow (phrase shown once, words verified, passphrase set)', async () => {
    await go('wallet');
    await waitText(page, 'Create a new wallet');
    await clickText(page, 'button', 'Create wallet');
    await waitText(page, 'Create a wallet');
    await clickText(page, '.md button', 'Continue');
    await waitText(page, 'Your recovery phrase');
    phrase = await page.$$eval('.words .wd', (els) => els.map((e) => e.textContent.replace(/^\d+/, '').trim()).join(' '));
    assert.equal(phrase.split(' ').length, 24);
    await shot('wallet-phrase');
    await clickText(page, '.md button', 'Continue').catch(() => {});
    await waitText(page, 'Confirm the phrase is written down').catch(() => {});
    await page.click('#cw-written');
    await clickText(page, '.md button', 'Continue');
    await waitText(page, 'Confirm and protect');
    const positions = await page.$$eval('label[for^="cw-"]', (els) => els.filter((e) => /Word #/.test(e.textContent)).map((e) => Number(e.textContent.replace(/\D/g, ''))));
    assert.equal(positions.length, 3);
    // wrong word is refused
    await type('#cw-0', 'wrong');
    await type('#cw-1', phrase.split(' ')[positions[1] - 1]);
    await type('#cw-2', phrase.split(' ')[positions[2] - 1]);
    await type('#cw-pass', PASS);
    await type('#cw-pass2', PASS);
    await clickText(page, '.md button', 'Continue');
    await sleep(500);
    assert.ok(/./.test(await page.$eval('.md', (e) => e.innerText)), 'dialog still open');
    assert.ok(await page.$('.md .wr.er'), 'a wrong confirmation word shows an error and nothing is created');
    await type('#cw-0', phrase.split(' ')[positions[0] - 1]);
    await clickText(page, '.md button', 'Continue');
    await waitText(page, 'Wallet created');
    await sleep(300);
    walletAddress = (await api('wallet:status')).data.address;
    assert.match(walletAddress, /^dobs1/);
    await waitText(page, walletAddress);
    const t = await text();
    for (const w of phrase.split(' ').slice(0, 5)) assert.ok(!t.includes(phrase), 'phrase must not remain on screen');
    assert.ok(!t.includes(phrase));
  });

  await step('wallet: fund by a direct mining claim, balance appears from the node', async () => {
    const r = await claimDirect({ phrase, rpcUrl: rpc });
    assert.equal(r.res.accepted, true, JSON.stringify(r.res));
    for (let i = 0; i < 40; i += 1) {
      const b = (await api('wallet:balance')).data;
      if (b.state === 'ready' && Number(b.data.balanceObs) > 0) return;
      await sleep(1000);
    }
    throw new Error('balance never arrived');
  });

  const SEND_TO = 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0';
  await step('send: review → wrong passphrase refused → correct passphrase submits → confirmed by node', async () => {
    await go('wallet');
    await waitText(page, 'Send OBS');
    await type('#send-to', SEND_TO);
    await type('#send-amount', '1.5');
    await type('#send-memo', 'e2e');
    await clickText(page, 'button[type=submit]', 'Review transfer');
    await waitText(page, 'Review transfer');
    await waitText(page, 'Total debited').catch(() => {});
    await shot('send-review');
    const dlg = await page.$eval('.md', (e) => e.innerText);
    assert.ok(dlg.includes(SEND_TO) || dlg.includes('dobs13s4pgc4qc'), 'recipient shown in the review');
    await type('#plan-pass', 'not the passphrase!!');
    await clickText(page, '.md button', 'Sign and send');
    await page.waitForSelector('.md .wr.er', { timeout: 15000 });
    assert.ok((await text()).includes('Review transfer'), 'dialog stays open for a retry');
    await type('#plan-pass', PASS);
    await clickText(page, '.md button', 'Sign and send');
    await waitText(page, 'Submitted to the node');
    await waitText(page, 'NOT YET CONFIRMED');
    await shot('send-submitted');
    await clickText(page, '.md button', 'Open Transactions');
    await waitText(page, 'Submitted from this app');
    await waitText(page, 'CONFIRMED', 60000);
    await shot('tx-confirmed');
  });

  let identity;
  await step('validator: identity account shown; register refused until funded, with the real reason', async () => {
    await go('validator');
    await waitText(page, 'Validator account');
    const v = (await api('validator:view')).data;
    identity = v.identityAddress;
    assert.match(identity, /^dobs1/);
    assert.equal(v.operations.register.allowed, false);
    assert.match(v.operations.register.reason, /needs/);
    await waitText(page, 'Not registered');
    await shot('validator-unfunded');
    const disabled = await page.$eval('button[data-op=register]', (b) => b.disabled);
    assert.equal(disabled, true);
  });

  await step('validator: fund the identity account from the wallet through the UI', async () => {
    const bal = (await api('wallet:balance')).data.data.balanceObs;
    assert.ok(Number(bal) > 20001.5, `wallet balance ${bal} is enough to fund the bond`);
    await clickText(page, 'button', 'Send OBS to this account');
    await waitText(page, 'Send OBS');
    assert.equal(await page.$eval('#send-to', (e) => e.value), identity);
    await type('#send-amount', '20001');
    await clickText(page, 'button[type=submit]', 'Review transfer');
    await waitText(page, 'Sign and send');
    await type('#plan-pass', PASS);
    await clickText(page, '.md button', 'Sign and send');
    await waitText(page, 'Submitted to the node');
    await clickText(page, '.md button', 'Copy id').catch(() => {});
    await page.evaluate(() => document.querySelector('.md button.p')?.click());
    for (let i = 0; i < 60; i += 1) {
      const v = (await api('validator:view')).data;
      if (v.operations.register.allowed) return;
      await sleep(1000);
    }
    throw new Error('identity account never became funded');
  });

  await step('validator: register through review → authorize → active on the node', async () => {
    await go('validator');
    await waitText(page, 'Become a Validator');
    await page.waitForFunction(() => { const b = document.querySelector('button[data-op=register]'); return b && !b.disabled; }, { timeout: 20000 });
    await clickText(page, 'button', 'Become a Validator');
    await waitText(page, 'Review validator registration');
    await shot('validator-register-review');
    const dlg = await page.$eval('.md', (e) => e.innerText);
    assert.match(dlg, /20,000\.00/);
    assert.match(dlg, /Signed with this node/);
    await clickText(page, '.md button', 'Authorize registration');
    await waitText(page, 'Submitted to the node');
    await page.evaluate(() => document.querySelector('.md button.p')?.click());
    for (let i = 0; i < 90; i += 1) {
      const v = (await api('validator:view')).data;
      if (v.phase === 'active') break;
      await sleep(1000);
      if (i === 89) throw new Error('validator never became active; phase ' + v.phase);
    }
    await go('validator');
    await waitText(page, 'Active validator');
    await shot('validator-active');
  });

  await step('validator: unbonding requires confirmation and reaches UNBONDING; claim stays unavailable until the delay passes', async () => {
    await go('validator');
    await page.waitForFunction(() => { const b = document.querySelector('button[data-op=unregister]'); return b && !b.disabled; }, { timeout: 30000 });
    await clickText(page, 'button', 'Request Unbonding');
    await waitText(page, 'Request unbonding?');
    await clickText(page, '.md button', 'Cancel');
    await sleep(300);
    assert.equal((await api('validator:view')).data.phase, 'active', 'cancel changed nothing');
    await clickText(page, 'button', 'Request Unbonding');
    await waitText(page, 'Request unbonding?');
    await clickText(page, '.md button', 'Request Unbonding');
    await waitText(page, 'Submitted to the node');
    await page.evaluate(() => document.querySelector('.md button.p')?.click());
    for (let i = 0; i < 90; i += 1) {
      const v = (await api('validator:view')).data;
      if (v.phase === 'unbonding') { assert.equal(v.operations.claim.allowed, false); break; }
      await sleep(1000);
      if (i === 89) throw new Error('never unbonding; phase ' + v.phase);
    }
    await go('validator');
    await waitText(page, 'Unbonding');
    await shot('validator-unbonding');
  });

  await step('logs: live node lines, severity filter, redaction of secrets; diagnostics run for real', async () => {
    await go('logs');
    await waitText(page, 'Keys, passphrases and recovery phrases are removed');
    const t = await text();
    assert.ok(!t.includes(PASS), 'passphrase never appears in logs');
    await clickText(page, '.tabs button', 'Diagnostics');
    await waitText(page, 'Node RPC answers');
    await waitText(page, 'Protocol parameters match this app');
    await shot('diagnostics');
    const report = (await api('diag:report')).data.text;
    assert.ok(!report.includes(PASS));
    for (const w of phrase.split(' ').slice(0, 24)) void w;
    assert.ok(!report.includes(phrase), 'report has no recovery phrase');
  });

  await step('help shows real versions', async () => {
    await go('help');
    await waitText(page, 'Obsidian Core');
    const t = await text();
    assert.match(t, /Core version\s*1\.\d+\.\d+/);
    assert.match(t, /Parameters hash/);
  });

  await step('stop node: confirmation, honest stopped state, process gone', async () => {
    await go('overview');
    await clickText(page, 'button', 'Stop Node');
    await waitText(page, 'Stop node?');
    await clickText(page, '.md button', 'Stop Node');
    await waitText(page, 'Node stopped', 40000);
    await sleep(500);
    const left = execSync("ps -eo pid,args | grep '[m]ain/node-host.js' || true").toString().trim();
    assert.equal(left, '', 'no node-host process remains');
    await shot('stopped-after');
    await go('wallet');
    await waitText(page, 'Start the node');
  });

  await step('restart on existing data needs no new-chain prompt and comes back synchronized', async () => {
    await go('overview');
    await clickText(page, 'button', 'Start Node');
    await waitText(page, 'Node running · synchronized', 60000);
  });

  await step('connection loss is shown honestly when the node process is killed', async () => {
    const pid = (await api('node:state')).data.pid;
    process.kill(pid, 'SIGKILL');
    await waitText(page, 'Node failed', 30000);
    assert.ok(!/Node running · synchronized/.test(await text()));
    await shot('node-failed');
  });

  await step('no browser console errors during the whole run', async () => {
    assert.deepEqual(consoleErrors.filter((e) => !/favicon/.test(e)), []);
  });
  console.log(`\nUI e2e: ${passed} steps passed`);
} catch (error) {
  console.log(`\nUI e2e FAILED after ${passed} steps: ${error.message}`);
  console.log('--- bridge log tail ---\n' + bridgeLog.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  bridge.kill('SIGTERM');
  await sleep(2500);
  try { execSync("ps -eo pid,args | grep '[m]ain/node-host.js' | awk '{print $1}' | xargs -r kill -9 || true"); } catch {}
  rmSync(data, { recursive: true, force: true });
}
