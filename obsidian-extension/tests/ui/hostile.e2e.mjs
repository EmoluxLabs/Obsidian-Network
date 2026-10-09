// A hostile app server. The extension connects to whatever server its user typed in, and renders what that server says,
// so the server is untrusted input. This puts a rewriting proxy between the extension and a real devnet stack that
// appends script, markup and attribute-breaking text to every string in every /api answer, then walks every screen
// and every clickable row it can reach with the real UI. Nothing may run, and nothing it injected may become markup.
//
// Run it on a stack that has chain data (run ext.e2e.mjs first: it leaves blocks, claims and a payment on the chain).
//   APP_URL=http://127.0.0.1:38790 node tests/ui/hostile.e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveExtension, launch, sleep, sendOrigin } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../../dist');
const APP = process.env.APP_URL ?? 'http://127.0.0.1:38790';
const PORT = Number(process.env.EXT_PORT ?? 4173);
const PROXY_PORT = Number(process.env.HOSTILE_PORT ?? 38795);
const ORIGIN = `http://127.0.0.1:${PORT}`;
// HOSTILE_TARGET=webapp walks the web app itself (its inline handlers are real there, and its CSP allows them) through
// the same hostile proxy, which is the stricter test: nothing but the escaping stands between the data and the page.
const WEBAPP = process.env.HOSTILE_TARGET === 'webapp';
const CLICK = WEBAPP ? '[onclick]' : '[data-obs-click]';
const CALL = WEBAPP ? 'onclick' : 'data-obs-click';
const PAYLOAD = `');window.__pwn=4;//"'><img src=x onerror=window.__pwn=1><svg onload=window.__pwn=2></script><script>window.__pwn=3</script>\u2028\u2029`;
const STRUCTURAL = /^(?:[0-9a-f]{16,}|(?:obs|tobs|sobs|dobs)1[0-9a-z]{20,}|-?\d+(?:\.\d+)?|devnet|testnet|mainnet|staging)$/i;

let mode = 'everything'; // 'everything': every string; 'free-text': only what is not an id, an address or a number
const mutate = (value, key) => {
  if (typeof value === 'string') return mode === 'free-text' && STRUCTURAL.test(value) ? value : value + PAYLOAD;
  if (Array.isArray(value)) return value.map((v) => mutate(v, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [mode === 'everything' ? k : k, mutate(v, k)]));
  return value;
};
const proxy = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const upstream = await fetch(APP + req.url, { method: req.method, headers: { 'content-type': req.headers['content-type'] ?? 'application/json', cookie: req.headers.cookie ?? '' }, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), redirect: 'manual' }).catch(() => null);
  const headers = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' };
  if (req.method === 'OPTIONS') return res.writeHead(204, headers).end();
  if (!upstream) return res.writeHead(502, headers).end('{}');
  let body = await upstream.text();
  if (req.url.startsWith('/api/') && (upstream.headers.get('content-type') ?? '').includes('json')) {
    try { body = JSON.stringify(mutate(JSON.parse(body))); } catch { /* not JSON */ }
  }
  res.writeHead(upstream.status, { ...headers, 'content-type': upstream.headers.get('content-type') ?? 'application/json' }).end(body);
});
await new Promise((r) => proxy.listen(PROXY_PORT, '127.0.0.1', r));
const HOSTILE = `http://127.0.0.1:${PROXY_PORT}`;

const server = WEBAPP ? { close() {} } : await serveExtension(dist, PORT);
const browser = await launch();
const violations = [];
let sawPayloadAsText = 0; // proof the hostile text really reached the screens (otherwise a pass means nothing)
let passed = 0;
try {
  const page = await browser.newPage();
  if (!WEBAPP) {
    await page.evaluateOnNewDocument(fs.readFileSync(path.join(here, 'shim.js'), 'utf8'));
    await sendOrigin(page, ORIGIN);
  }
  page.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text().slice(0, 140)); });
  page.on('dialog', (d) => { violations.push(`dialog: ${d.message()}`); d.dismiss(); });

  const inspect = async (label) => {
    const found = await page.evaluate(() => ({
      pwn: window.__pwn,
      injected: [...document.querySelectorAll(window.__webapp ? 'img[src="x"], svg[onload], script:not([src])' : 'img[src="x"], svg[onload], [onerror], [onload], [onmouseover], script:not([src])')].filter((e) => !(window.__webapp && e.tagName === 'SCRIPT' && !/__pwn/.test(e.textContent))).map((e) => e.outerHTML.slice(0, 100)),
      handlers: [...document.querySelectorAll('[onclick]')].length,
      // anything an attacker managed to turn into an element of their own
      attrs: (window.__webapp ? [] : [...document.querySelectorAll('*')]).filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).map((e) => e.outerHTML.slice(0, 100)),
    }));
    if ((await page.evaluate(() => document.body.innerText)).includes('window.__pwn=1')) sawPayloadAsText += 1;
    assert.equal(found.pwn, undefined, `${label}: injected script ran (window.__pwn=${found.pwn})`);
    assert.deepEqual(found.injected, [], `${label}: injected markup became elements`);
    assert.deepEqual(found.attrs, [], `${label}: an event-handler attribute survived`);
  };
  const state = (mode_) => page.evaluate((m) => {
    const s = { local: { 'obsidian.settings': { serverUrl: m.url, network: 'devnet', alerts: false, address: null } }, perms: ['http://127.0.0.1/*'], tabs: [], notifications: [], optionsOpened: 0, level: 'granted', permAnswer: true, badge: '' };
    localStorage.setItem('__ext_shim', JSON.stringify(s));
  }, mode_);
  const clickables = () => page.$$eval(CLICK, (els, attr) => els.map((e, i) => ({ i, call: e.getAttribute(attr) ?? '', text: (e.textContent || '').trim().slice(0, 30) })), CALL);
  const clickIndex = (i) => page.$$eval(CLICK, (els, k) => els[k]?.click(), i);
  const visible = () => page.evaluate(() => document.body.innerText);

  for (const m of ['everything', 'free-text']) {
    mode = m;
    if (WEBAPP) {
      await page.goto(`${HOSTILE}/`, { waitUntil: 'load' });
      await page.evaluate(() => { window.__webapp = true; });
    } else {
      await page.goto(`${ORIGIN}/popup.html?popup=1`, { waitUntil: 'load' });
      await state({ url: HOSTILE });
      await page.goto(`${ORIGIN}/popup.html?popup=1`, { waitUntil: 'load' });
    }
    await sleep(3500);
    await inspect(`${m}: first screen`);

    // every screen the navigation reaches, and from each one every clickable thing once (depth one), then the explorer in depth
    const screens = ['HOME', 'MINE', 'WALLET', 'EXPLORER', 'MENU'];
    for (const name of screens) {
      await page.evaluate((n) => { [...document.querySelectorAll('.nav a, [data-obs-click], [onclick]')].find((e) => e.textContent.trim() === n)?.click(); }, name);
      await sleep(900);
      await inspect(`${m}: ${name}`);
      const items = await clickables();
      for (const item of items.slice(0, 40)) {
        if (/SignOut|Logout|Reset|Remove|Delete|Disconnect/i.test(item.call)) continue;
        await clickIndex(item.i).catch(() => {});
        await sleep(350);
        await inspect(`${m}: ${name} > ${item.call.slice(0, 40)}`);
        await page.evaluate(() => (window.ObsidianExClose ? window.ObsidianExClose() : null)).catch(() => {});
        await page.evaluate((n) => { [...document.querySelectorAll('.nav a, [data-obs-click], [onclick]')].find((e) => e.textContent.trim() === n)?.click(); }, name);
        await sleep(250);
      }
    }
    // explorer: every tab, every row, every detail page
    await page.evaluate(() => { [...document.querySelectorAll('.nav a')].find((e) => e.textContent.trim() === 'EXPLORER')?.click(); });
    await sleep(900);
    for (const tab of ['overview', 'blocks', 'claims', 'names', 'network']) {
      await page.evaluate((t) => window.ObsidianExTab?.(t), tab);
      await sleep(1200);
      await inspect(`${m}: explorer tab ${tab}`);
      const rows = (await clickables()).filter((c) => /ObsidianExOpen/.test(c.call));
      for (const row of rows.slice(0, 6)) {
        await clickIndex(row.i).catch(() => {});
        await sleep(900);
        await inspect(`${m}: explorer ${tab} detail ${row.call.slice(0, 50)}`);
        await page.evaluate(() => window.ObsidianExClose?.());
        await sleep(300);
      }
    }
    // the NODE screen, which shows server-provided text by design (versions, node urls, validator names)
    await page.evaluate(() => { [...document.querySelectorAll('.nav a')].find((e) => e.textContent.trim() === 'MENU')?.click(); });
    await sleep(600);
    await page.evaluate(() => { [...document.querySelectorAll('[data-obs-click], [onclick]')].find((e) => /NODE/.test(e.textContent))?.click(); });
    await sleep(1500);
    await inspect(`${m}: NODE screen`);
    const text = await visible();
    assert.ok(text.length > 40, `${m}: something was rendered`);
    passed += 1;
    console.log(`  ok   ${m}: every reachable screen rendered hostile text as text (${(await clickables()).length} controls on the last screen)`);
  }
  assert.deepEqual(violations.filter((v) => /dialog/.test(v)), [], 'no alert/confirm/prompt dialog opened');
  assert.ok(sawPayloadAsText >= 10, `the hostile text was visible as text on only ${sawPayloadAsText} screens: the test did not reach enough rendering`);
  console.log(`  hostile text was displayed (as text) on ${sawPayloadAsText} screens`);
  console.log(`\n${passed} passes. CSP refusals during the run (inline script the page tried and the policy stopped): ${violations.filter((v) => !/dialog/.test(v)).length}`);
} finally {
  await browser.close();
  server.close();
  proxy.close();
}
