/**
 * Paying a `.obs` name from the wallet: the recipient step of REVIEW and SIGN.
 *
 * The wallet's own helpers run against the REAL core resolver and the REAL address validator, with the node mocked
 * (nothing here touches a network, a mainnet state or any OBS). What is pinned: an address is validated exactly as
 * before; a name becomes an address only from a good ONS record for this network; every failure stops with its own message;
 * the QR and image paths still take an address only; and the review shows the name, the full address and the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle, newWallet } from './helpers.mjs';
import { readRecipientField, resolveForReview, confirmBeforeSigning, parseRecipient } from '../public/lib/pure.mjs';
import { V } from '../public/lib/views.mjs';

const NOW = 1_800_000_000;
const HRP = 'obs';
const MAIN = { chainId: 7777, addressHrp: 'obs' };
const me = newWallet('obs');
const friend = newWallet('obs');
const owner = newWallet('obs');

class NodeError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const record = (over = {}) => ({
  name: 'friend.obs', owner: owner.address, address: friend.address, registeredAt: NOW - 5, registeredAtHeight: 2,
  expiresAt: NOW + 1000, transferCount: 0, resolved: true, ...over,
});

/** The core's resolver with a mocked node: what `W.resolveRecipientName` is in the page. */
function resolver({ answer = record(), context = { ...MAIN, protocolTime: NOW }, expected = MAIN } = {}) {
  const calls = [];
  const deps = {
    lookup: async (name) => {
      calls.push(name);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    context: async () => context,
    expected: async () => expected,
    timeoutMs: 100,
  };
  return {
    calls,
    resolveName: (raw) => bundle.resolveOnsName(raw, deps),
    reconfirm: (resolved) => bundle.reconfirmOnsName(resolved, deps),
  };
}

const ctx = (extra = {}) => ({ hrp: HRP, own: me.address, readScanned: bundle.readScanned, onsFailureMessage: bundle.onsFailureMessage, ...extra });
const field = (raw) => readRecipientField(raw, { hrp: HRP, own: me.address, readScanned: bundle.readScanned, core: bundle });

test('an address is validated exactly as before, and a name is only checked for its shape', () => {
  assert.deepEqual(field(friend.address), { ok: true, kind: 'address', value: friend.address });
  assert.deepEqual(field(friend.address), { ...parseRecipient(friend.address, ctx()), kind: 'address' });
  assert.deepEqual(field('Friend.OBS'), { ok: true, kind: 'name' });
  for (const bad of [me.address, `obsidian:${friend.address}`, `${friend.address}?amount=5`, 'obs1notanaddress', '', 'friend']) {
    const r = field(bad);
    assert.equal(r.ok, false, bad);
    assert.deepEqual(r, { ...parseRecipient(bad, ctx()) }, `${bad}: same verdict as parseRecipient`);
  }
});

test('a malformed .obs string is refused as a bad name, not as a bad address', () => {
  for (const bad of ['fr iend.obs', 'ab.obs', 'a--b.obs', 'a.b.obs', '-ab.obs', 'foo.obs.obs', 'admin.obs', 'fo/o.obs', 'foo@bar.obs', 'foo.obs?x=1']) {
    const r = field(bad);
    if (bad === 'foo.obs?x=1') {
      assert.equal(r.ok, false); // not a name at all (does not end in .obs): falls to the address rules
      continue;
    }
    assert.equal(r.ok, false, bad);
    assert.match(r.message, /not a valid ONS name/, bad);
    assert.doesNotMatch(r.message, /address/i, bad);
  }
});

test('the QR and image paths still refuse a name: they take a bare address only', () => {
  const r = parseRecipient('friend.obs', ctx());
  assert.equal(r.ok, false);
  assert.match(r.message, /bare address/);
});

test('a registered name resolves to the record address, validated like a pasted one', async () => {
  const r = resolver();
  const out = await resolveForReview('  Friend.obs ', { ...ctx(), resolveName: r.resolveName });
  assert.equal(out.ok, true);
  assert.equal(out.value, friend.address);
  assert.equal(out.ons.name, 'friend.obs');
  assert.notEqual(out.value, owner.address, 'the registered address, not the owner');
  assert.deepEqual(r.calls, ['friend.obs']);
});

test('each failure stops with its own message and nothing is guessed', async () => {
  const bad = (a) => a.slice(0, -1) + (a.endsWith('q') ? 'p' : 'q');
  const cases = [
    ['unregistered', { answer: new NodeError('name not registered', 404, 'ERR_NOT_FOUND') }, 'ONS name not found on Mainnet.'],
    ['rpc 500', { answer: new NodeError('HTTP 500', 500, null) }, 'Could not resolve this ONS name. Please try again.'],
    ['transport', { answer: new TypeError('fetch failed') }, 'Could not resolve this ONS name. Please try again.'],
    ['malformed', { answer: { nope: true } }, 'The ONS lookup returned an unusable answer. Transaction blocked.'],
    ['invalid address', { answer: record({ address: bad(friend.address) }) }, 'ONS name resolved to an invalid OBS address. Transaction blocked.'],
    ['testnet address', { answer: record({ address: newWallet('tobs').address }) }, 'ONS lookup came from a different network than Obsidian Mainnet. Transaction blocked.'],
    ['other chain', { context: { chainId: 7778, addressHrp: 'tobs', protocolTime: NOW } }, 'ONS lookup came from a different network than Obsidian Mainnet. Transaction blocked.'],
    ['expired', { answer: record({ expiresAt: NOW - 1 }) }, 'This ONS name has expired, so its address is no longer trusted. Transaction blocked.'],
  ];
  for (const [label, setup, message] of cases) {
    const out = await resolveForReview('friend.obs', { ...ctx(), resolveName: resolver(setup).resolveName });
    assert.deepEqual(out, { ok: false, message }, label);
  }
});

test('a name that resolves to the wallet’s own address is refused, with that reason', async () => {
  const out = await resolveForReview('friend.obs', { ...ctx(), resolveName: resolver({ answer: record({ address: me.address }) }).resolveName });
  assert.equal(out.ok, false);
  assert.match(out.message, /your own address/);
});

test('a resolver that hangs does not block the review forever and does not guess', async () => {
  const r = resolver();
  const hang = () => bundle.resolveOnsName('friend.obs', { lookup: () => new Promise(() => {}), context: async () => ({ ...MAIN, protocolTime: NOW }), expected: async () => MAIN, timeoutMs: 30 });
  const out = await resolveForReview('friend.obs', { ...ctx(), resolveName: hang });
  assert.deepEqual(out, { ok: false, message: 'Could not resolve this ONS name. Please try again.' });
  void r;
});

test('signing re-resolves a reviewed name and refuses any change', async () => {
  const first = resolver();
  const out = await resolveForReview('friend.obs', { ...ctx(), resolveName: first.resolveName });
  const review = { to: out.value, ons: out.ons };
  assert.deepEqual(await confirmBeforeSigning(review, { reconfirm: first.reconfirm }), { ok: true });

  const moved = resolver({ answer: record({ address: newWallet('obs').address }) });
  const m = await confirmBeforeSigning(review, { reconfirm: moved.reconfirm });
  assert.equal(m.ok, false);
  assert.match(m.message, /different address|no longer resolves/);
  assert.match(m.message, /Nothing was signed/);

  for (const answer of [record({ expiresAt: NOW - 1 }), new NodeError('name not registered', 404, 'ERR_NOT_FOUND'), new TypeError('down')]) {
    const r = await confirmBeforeSigning(review, { reconfirm: resolver({ answer }).reconfirm });
    assert.equal(r.ok, false);
    assert.match(r.message, /Nothing was signed/);
  }
});

test('an address review is not re-resolved: there is nothing to resolve', async () => {
  let asked = 0;
  const r = await confirmBeforeSigning({ to: friend.address, ons: null }, { reconfirm: async () => { asked += 1; return { ok: true }; } });
  assert.deepEqual(r, { ok: true });
  assert.equal(asked, 0);
});

const state = (extra = {}) => ({
  view: 'review', net: { state: 'ok', name: 'mainnet', hrp: 'obs', chainId: 7777 }, address: me.address, err: '', busy: false,
  balance: { state: 'ok', seals: 10n * 10n ** 18n }, draft: { to: '', amount: '' }, ...extra,
});

test('the review shows the name, the full resolved address, the network and the status', async () => {
  const out = await resolveForReview('friend.obs', { ...ctx(), resolveName: resolver().resolveName });
  const html = V.review(state({ review: { to: out.value, ons: out.ons, amount: 3n * 10n ** 18n, amountText: '3', gas: 10n ** 15n, balance: 5n * 10n ** 18n } }));
  for (const needle of ['ONS NAME', 'friend.obs', 'RESOLVES TO', 'STATUS', 'Registered on-chain', 'NETWORK', 'MAINNET', 'CONFIRM &amp; SIGN']) {
    assert.ok(html.includes(needle), needle);
  }
  const text = html.replace(/<[^>]+>/g, '');
  assert.ok(text.includes(friend.address), 'the whole address is on the screen, in one piece');
  assert.ok(!text.includes(owner.address), 'the owner is not shown as the recipient');
});

test('an address review is unchanged: TO, no ONS rows', () => {
  const html = V.review(state({ review: { to: friend.address, ons: null, amount: 1n, amountText: '1', gas: 1n, balance: 10n } }));
  assert.ok(html.includes('<span>TO</span>'));
  assert.ok(!html.includes('ONS NAME') && !html.includes('RESOLVES TO'));
});

test('the send form says a name is accepted', () => {
  const html = V.send(state({ view: 'send' }));
  assert.ok(html.includes('RECIPIENT ADDRESS OR .OBS NAME'));
  assert.ok(html.includes('name.obs'));
});
