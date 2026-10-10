import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { V, activityRows } from '../public/lib/views.mjs';
import { newWallet } from './helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAYLOAD = `"><img src=x onerror=window.__pwned=1><script>window.__pwned=1</script>'`;
const own = newWallet().address;

const state = (over = {}) => ({
  view: 'home',
  net: { state: 'ok', name: 'devnet', chainId: 7780, hrp: 'dobs', error: PAYLOAD },
  node: { state: 'ok', height: 1234, lastBlockTimestamp: 1_700_000_000, syncing: false },
  address: own,
  unlocked: true,
  balance: { state: 'ok', seals: 5n * 10n ** 18n, error: PAYLOAD },
  hist: { state: 'ok', ids: new Set(), error: PAYLOAD, rows: [] },
  records: [],
  draft: { to: PAYLOAD, amount: PAYLOAD },
  review: { to: own, amount: 1n, amountText: '1', gas: 1n, balance: 10n },
  tx: { txId: 'a'.repeat(64), state: 'pending', message: PAYLOAD, to: PAYLOAD, amount: 1n, gas: 1n, counterparty: PAYLOAD, note: PAYLOAD, validUntil: 1, confirmations: 0, signed: true, accepted: true, signedHex: 'ab' },
  txBack: 'home',
  qr: '',
  tab: 'phrase',
  err: PAYLOAD,
  busy: false,
  copied: false,
  lockedFor: 0,
  minPass: 12,
  ...over,
});

const hostileRows = [
  { txId: PAYLOAD, height: 5, timestamp: 1, sender: PAYLOAD, recipient: PAYLOAD, amount: '1', gas: '1', kind: PAYLOAD },
  { txId: 'b'.repeat(64), height: 5, timestamp: 1, sender: 'x', recipient: PAYLOAD, amount: '1', gas: '1', kind: 'ONS_' + PAYLOAD },
];

/** Every opening tag in the markup, with its attributes. A payload that became markup shows up as a tag we did not write. */
const tags = (html) =>
  [...html.matchAll(/<([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g)].map((m) => ({
    name: m[1].toLowerCase(),
    // attribute NAMES only, so text inside a quoted value (which is harmless) is not mistaken for an attribute
    names: [...m[2].matchAll(/([^\s=\/"']+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)].map((a) => a[1].toLowerCase()),
    attrs: m[2],
  }));

test('hostile text from the node, a QR code or a field is only ever text, on every screen', () => {
  const allowed = new Set(['div', 'span', 'b', 'p', 'h1', 'button', 'form', 'input', 'textarea', 'label', 'img', 'ol', 'ul', 'li', 'br']);
  for (const [name, view] of Object.entries(V)) {
    const S = state({
      view: name,
      hist: { state: 'ok', ids: new Set(), error: PAYLOAD, rows: hostileRows },
      records: [{ txId: 'c'.repeat(64), state: 'submitted', to: own, amount: '1', gas: '1', submittedAt: 1, validUntil: 2, from: own }],
    });
    const html = view(S, 'word '.repeat(24).trim() + ` ${PAYLOAD}`);
    for (const t of tags(html)) {
      assert.ok(allowed.has(t.name), `${name}: unexpected <${t.name}> (injection?)`);
      assert.ok(!t.names.some((n) => n.startsWith('on')), `${name}: an event handler attribute appeared: ${t.names}`);
      assert.ok(!t.names.includes('style'), `${name}: an inline style appeared`);
      assert.ok(!t.names.includes('srcdoc'), `${name}: srcdoc appeared`);
      for (const m of t.attrs.matchAll(/(?:href|src|action|formaction)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi)) assert.ok(!/javascript:/i.test(m[1]), `${name}: a script URL appeared`);
    }
    assert.ok(!/<script/i.test(html), `${name}: a script element appeared`);
    assert.equal(tags(html).filter((t) => t.name === 'img').every((t) => /^\s+class="logo" src="\/logo\.png"/.test(t.attrs)), true, `${name}: an <img> we did not write`);
  }
});

test('the activity list shows rows from the node and from this device, and says so when it cannot', () => {
  const rows = activityRows(state({ hist: { state: 'ok', ids: new Set(), error: '', rows: hostileRows } }), 0);
  assert.match(rows, /class="row tx"/);
  assert.match(activityRows(state({ hist: { state: 'loading', ids: new Set(), rows: [], error: '' } }), 5), /Loading/);
  const failed = activityRows(state({ hist: { state: 'error', ids: new Set(), rows: [], error: 'node down' } }), 5);
  assert.match(failed, /unavailable/i);
  assert.match(failed, /RETRY/);
  assert.match(activityRows(state({ hist: { state: 'ok', ids: new Set(), rows: [], error: '' } }), 5), /No transactions on this address yet/);
  // a transaction the node already lists is not shown twice
  const rec = { txId: 'd'.repeat(64), state: 'pending', to: own, amount: '1', gas: '1', submittedAt: 1, validUntil: 2, from: own };
  const once = activityRows(state({ records: [rec], hist: { state: 'ok', ids: new Set([rec.txId]), rows: [], error: '' } }), 0);
  assert.ok(!once.includes(rec.txId));
});

test('an unknown balance is "Unavailable", never 0', () => {
  const failed = V.home(state({ balance: { state: 'error', seals: 0n, error: 'node down' } }));
  assert.match(failed, />Unavailable</);
  assert.match(failed, /RETRY/);
  assert.ok(!/id="bal">0/.test(failed));
  assert.match(V.home(state({ balance: { state: 'loading', seals: 0n, error: '' } })), /Loading…/);
  assert.match(V.home(state({ balance: { state: 'ok', seals: 0n, error: '' } })), /id="bal">0 /, 'a real zero is shown as zero');
  assert.match(V.home(state({ node: { state: 'error', height: 0, lastBlockTimestamp: null, syncing: false } })), /NODE UNREACHABLE/);
});

test('a test network says so, and mainnet does not pretend to be one', () => {
  assert.match(V.home(state()), /test network/);
  assert.match(V.home(state({ net: { state: 'ok', name: 'mainnet', chainId: 7777, hrp: 'obs', error: '' } })), /MAINNET/);
  assert.ok(!/test network/.test(V.home(state({ net: { state: 'ok', name: 'mainnet', chainId: 7777, hrp: 'obs', error: '' } }))));
  assert.match(V.home(state({ net: { state: 'error', name: '', chainId: null, hrp: '', error: 'x' } })), /UNVERIFIED/);
});

test('no screen offers a private key, a plaintext download or clipboard phrase copy', () => {
  for (const [name, view] of Object.entries(V)) {
    const html = view(state({ view: name }), 'a '.repeat(24).trim());
    assert.ok(!/data-a="(copyPk|copyRk|dlRk|showPk)"/.test(html), name);
    assert.ok(!/COPY PRIVATE KEY|COPY PHRASE|DOWNLOAD<\/button>/.test(html), name);
  }
});

test('the review shows address, amount, fee, total, network, and asks for the password', () => {
  const html = V.review(state({ review: { to: own, amount: 3n * 10n ** 18n, amountText: '3', gas: 10n ** 15n, balance: 5n * 10n ** 18n } }));
  for (const needle of ['TO', 'AMOUNT', 'FEE', 'TOTAL', 'NETWORK', 'DEVNET', '3 OBS', '0.001 OBS', '3.001 OBS', 'type="password"', 'CONFIRM &amp; SIGN']) assert.ok(html.includes(needle), needle);
  assert.ok(html.includes(`<b>${own.slice(0, 8)}</b>`), 'the first characters of the address are emphasised');
});

test('every action and form a screen uses has a handler in the controller', () => {
  const app = readFileSync(join(root, 'public', 'app.mjs'), 'utf8');
  const aBlock = app.slice(app.indexOf('const A = {'), app.indexOf('/** The node has this transaction'));
  const fBlock = app.slice(app.indexOf('const F = {'), app.indexOf('const readAll'));
  const have = (block, name) => new RegExp(`(^|\\n)\\s+(async\\s+)?${name}\\s*(\\(|:)`).test(block);
  const used = { a: new Set(), s: new Set() };
  for (const [name, view] of Object.entries(V)) {
    const html = view(state({ view: name, tab: 'phrase' }), 'a b');
    for (const m of html.matchAll(/data-a="([\w]+)"/g)) used.a.add(m[1]);
    for (const m of html.matchAll(/data-submit="([\w]+)"/g)) used.s.add(m[1]);
  }
  for (const m of V.import(state({ tab: 'backup' })).matchAll(/data-submit="([\w]+)"/g)) used.s.add(m[1]);
  for (const m of V.status(state({ tx: { ...state().tx, state: 'failed' } })).matchAll(/data-a="([\w]+)"/g)) used.a.add(m[1]);
  assert.ok(used.a.size > 12 && used.s.size >= 8);
  for (const name of used.a) assert.ok(have(aBlock, name), `no handler for data-a="${name}"`);
  for (const name of used.s) assert.ok(have(fBlock, name), `no handler for data-submit="${name}"`);
});

test('every link between screens leads to a screen that exists', () => {
  const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../public/lib/views.mjs'), 'utf8');
  const targets = new Set();
  for (const m of source.matchAll(/data-a="go" data-v="([a-z0-9]+)"/g)) targets.add(m[1]);
  for (const m of source.matchAll(/\bback\('([a-z0-9]+)'/g)) targets.add(m[1]);
  for (const m of source.matchAll(/\bback\(([^)]*)\)/g)) for (const q of m[1].matchAll(/'([a-z0-9]+)'/g)) targets.add(q[1]);
  assert.ok(targets.size >= 8, `found ${[...targets]}`);
  for (const target of targets) assert.ok(Object.hasOwn(V, target), `a link goes to "${target}", which is not a screen`);
});
