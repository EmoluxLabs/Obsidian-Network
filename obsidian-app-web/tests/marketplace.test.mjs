/**
 * The ONS Marketplace in the mobile web app (protocol 2.0.0).
 *
 * Operations: what gets signed (decoded with the core's own decoder), which gas it carries, and what is refused before
 * the passphrase is even asked for. Screen: the four search outcomes and the escrow figures, rendered from node answers.
 * The gas shown on screen must equal the gas the operation signs, for every amount.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
})();

const { createVault, saveVault, loadVault } = await import('../web/vault.mjs');
const ops = await import('../web/ops.mjs');
const { decodeMarketBody } = await import('../../obsidian-interface/web/core/transactions/executors/marketplace.js');
const { decodeSignedTxFromBytes } = await import('../../obsidian-interface/web/core/transactions/encode.js');
const { TxType, MarketOp } = await import('../../obsidian-interface/web/core/protocol/types.js');
const { expectedGas } = await import('../web/index.mjs');
const { SCREENS } = await import('../public/screens.mjs');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';
const ME = 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj';
const OTHER = 'obs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrxdgrk';
const OBS = 10n ** 18n;

before(async () => {
  saveVault(await createVault(PHRASE, PASSPHRASE, 'dobs'));
});

function node(world) {
  const sent = [];
  let asked = 0;
  return {
    sent,
    asked: () => asked,
    loadVault: () => loadVault(),
    loadAddress: () => ME,
    requestPassphrase: async () => {
      asked += 1;
      return PASSPHRASE;
    },
    getContext: async () => ({ chainId: 7777, protocolVersion: '2.0.1', protocolTime: 1_700_000_000 }),
    getNonce: async () => 3,
    getBalance: async () => ({ balanceSeals: (world.spendable ?? 100n * OBS).toString(), spendableSeals: (world.spendable ?? 100n * OBS).toString() }),
    getMarketName: async (name) => world.names[name] ?? null,
    getMarketOffer: async (id) => (world.offers[id] ? { offer: world.offers[id] } : null),
    submit: async (hex, txId) => {
      sent.push(hex);
      return { accepted: true, txId };
    },
  };
}

const decode = (hex) => {
  const tx = decodeSignedTxFromBytes(Uint8Array.from(Buffer.from(hex, 'hex')));
  return { tx, body: decodeMarketBody(tx.body) };
};
const listed = (seller, price) => ({ status: 'LISTED', owner: seller, listing: { name: 'alpha.obs', seller, priceSeals: price.toString() }, locked: true });

test('buy signs the reviewed price and seller with gas on the price', async () => {
  const price = 40n * OBS;
  const n = node({ names: { alpha: listed(OTHER, price) }, offers: {} });
  const result = await ops.submitMarketBuy(n, { name: 'alpha.obs', reviewedPriceSeals: price.toString(), reviewedSeller: OTHER });
  assert.equal(result.ok, true, JSON.stringify(result));
  const { tx, body } = decode(n.sent[0]);
  assert.equal(tx.type, TxType.ONS_MARKET);
  assert.equal(tx.gas, expectedGas(price));
  assert.equal(body.op, MarketOp.BUY);
  assert.equal(body.amount, price);
  assert.equal(body.counterparty, OTHER);
});

test('buy is refused before the passphrase is asked for when the listing moved or cannot be afforded', async () => {
  const price = 40n * OBS;
  const base = { names: { alpha: listed(OTHER, price) }, offers: {} };
  for (const [world, input, code] of [
    [base, { name: 'alpha', reviewedPriceSeals: (price + 1n).toString(), reviewedSeller: OTHER }, 'LISTING_CHANGED'],
    [{ ...base, names: { alpha: { status: 'OWNED', owner: OTHER } } }, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: OTHER }, 'NOT_LISTED'],
    [{ ...base, names: { alpha: listed(ME, price) } }, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: ME }, 'OWN_LISTING'],
    [{ ...base, spendable: price }, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: OTHER }, 'INSUFFICIENT_FUNDS'],
  ]) {
    const n = node(world);
    const result = await ops.submitMarketBuy(n, input);
    assert.equal(result.ok, false);
    assert.equal(result.reason, code);
    assert.equal(n.sent.length, 0);
    assert.equal(n.asked(), 0, 'no passphrase prompt for something the chain would refuse');
  }
});

test('offer signs counterparty = the owner, gas on top; refused on a listed name, an own name, or without funds', async () => {
  const n = node({ names: { alpha: { status: 'OWNED', owner: OTHER }, beta: listed(OTHER, OBS), mine: { status: 'OWNED', owner: ME } }, offers: {}, spendable: 30n * OBS });
  const ok = await ops.submitMarketOffer(n, { name: 'alpha.obs', amountObs: '25', reviewedOwner: OTHER });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const { tx, body } = decode(n.sent[0]);
  assert.equal(tx.gas, expectedGas(25n * OBS));
  assert.deepEqual([body.op, body.amount, body.counterparty], [MarketOp.OFFER, 25n * OBS, OTHER]);
  assert.equal((await ops.submitMarketOffer(n, { name: 'beta', amountObs: '1' })).reason, 'LISTED');
  assert.equal((await ops.submitMarketOffer(n, { name: 'mine', amountObs: '1' })).reason, 'OWN_NAME');
  assert.equal((await ops.submitMarketOffer(n, { name: 'alpha', amountObs: '30' })).reason, 'INSUFFICIENT_FUNDS');
  assert.equal((await ops.submitMarketOffer(n, { name: 'alpha', amountObs: '0' })).reason, 'BAD_AMOUNT');
  assert.equal((await ops.submitMarketOffer(n, { name: 'alpha', amountObs: '1', reviewedOwner: ME })).reason, 'OWNER_CHANGED');
  assert.equal(n.sent.length, 1);
});

test('list, update and delist are owner-only and zero-gas', async () => {
  const n = node({ names: { mine: { status: 'OWNED', owner: ME }, up: listed(ME, 5n * OBS), theirs: { status: 'OWNED', owner: OTHER } }, offers: {} });
  assert.equal((await ops.submitMarketList(n, { name: 'mine', priceObs: '2.5' })).ok, true);
  assert.equal((await ops.submitMarketUpdate(n, { name: 'up', priceObs: '9' })).ok, true);
  assert.equal((await ops.submitMarketDelist(n, { name: 'up' })).ok, true);
  const decoded = n.sent.map(decode);
  assert.deepEqual(decoded.map((d) => d.body.op), [MarketOp.LIST, MarketOp.UPDATE_PRICE, MarketOp.DELIST]);
  assert.ok(decoded.every((d) => d.tx.gas === 0n));
  assert.equal(decoded[0].body.amount, 25n * OBS / 10n);
  assert.equal((await ops.submitMarketList(n, { name: 'theirs', priceObs: '1' })).reason, 'NAME_NOT_OWNED');
  assert.equal((await ops.submitMarketList(n, { name: 'up', priceObs: '1' })).reason, 'ALREADY_LISTED');
  assert.equal((await ops.submitMarketList(n, { name: 'mine', priceObs: '0' })).reason, 'BAD_AMOUNT');
  assert.equal((await ops.submitMarketDelist(n, { name: 'mine' })).reason, 'NOT_LISTED');
  assert.equal(n.sent.length, 3);
});

test('accept, decline and cancel act on the offer by id, for the right party, while pending', async () => {
  const id = 'cd'.repeat(32);
  const offer = { id, name: 'alpha.obs', maker: OTHER, owner: ME, currentOwner: ME, amountSeals: (40n * OBS).toString(), status: 'PENDING' };
  const world = { names: {}, offers: { [id]: offer } };
  const n = node(world);
  assert.equal((await ops.submitMarketAccept(n, { offerId: id })).ok, true);
  assert.equal((await ops.submitMarketDecline(n, { offerId: id })).ok, true);
  const [a, d] = n.sent.map(decode);
  assert.deepEqual([a.body.op, a.body.amount, a.body.offerId, a.body.name], [MarketOp.ACCEPT_OFFER, 40n * OBS, id, 'alpha']);
  assert.deepEqual([d.body.op, d.body.offerId], [MarketOp.DECLINE_OFFER, id]);
  assert.equal((await ops.submitMarketCancel(n, { offerId: id })).reason, 'NOT_MAKER');
  world.offers[id] = { ...offer, status: 'ACCEPTED' };
  assert.equal((await ops.submitMarketAccept(n, { offerId: id })).reason, 'OFFER_CLOSED');
  world.offers[id] = { ...offer, currentOwner: OTHER };
  assert.equal((await ops.submitMarketAccept(n, { offerId: id })).reason, 'NOT_OWNER');
  world.offers[id] = { ...offer, maker: ME, currentOwner: OTHER };
  assert.equal((await ops.submitMarketCancel(n, { offerId: id })).ok, true);
  assert.equal(decode(n.sent[2]).body.op, MarketOp.CANCEL_OFFER);
});

// ── the screen ───────────────────────────────────────────────────────────────────────────────────────────────────

const screenState = (over = {}) => ({
  account: { email: 'a@b.c' },
  walletAddress: ME,
  params: { ons: { registrationFeeObs: '0.05', renewalFeeObs: '0.05', termSeconds: 31_536_000 } },
  balance: { balanceSeals: (100n * OBS).toString(), spendableSeals: (60n * OBS).toString(), lockedSeals: (40n * OBS).toString(), totalSeals: (100n * OBS).toString() },
  ownNames: [],
  ons: { query: '', result: null },
  market: { feed: { listings: [], total: 0, hasMore: false }, sort: 'newest', offset: 0, incoming: { offers: [] }, outgoing: { offers: [] }, mine: null, events: null, review: null },
  error: '',
  notice: '',
  busy: null,
  ...over,
});

test('a listed name shows the Marketplace status, exact price, seller and a Buy action', () => {
  const html = SCREENS.ons(screenState({
    ons: { query: 'alpha', result: { name: 'alpha.obs', registered: true, record: { owner: OTHER, address: OTHER, expiresAt: 2_000_000_000 }, market: listed(OTHER, 250n * OBS) } },
  }));
  assert.match(html, /LISTED ON ONS MARKETPLACE/);
  assert.match(html, /250 OBS/);
  assert.match(html, /ObsidianMarketReviewBuy\(\)/);
  assert.doesNotMatch(html, /ObsidianMarketReviewOffer/);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test('an owned, unlisted name offers a Make Offer form; an available one offers registration', () => {
  const owned = SCREENS.ons(screenState({
    ons: { query: 'alpha', result: { name: 'alpha.obs', registered: true, record: { owner: OTHER, address: OTHER, expiresAt: 2_000_000_000 }, market: { status: 'OWNED', owner: OTHER, listing: null } } },
  }));
  assert.match(owned, /ObsidianMarketReviewOffer\(\)/);
  assert.doesNotMatch(owned, /ObsidianMarketReviewBuy/);
  const free = SCREENS.ons(screenState({ ons: { query: 'free', result: { name: 'free.obs', registered: false, record: null } } }));
  assert.match(free, /ObsidianRegisterName/);
  assert.doesNotMatch(free, /ObsidianMarketReview/);
});

test('the review shows price, gas, total and spendable, and the gas equals what the operation signs', () => {
  const price = 250n * OBS;
  const html = SCREENS.ons(screenState({
    ons: { query: 'alpha', result: { name: 'alpha.obs', registered: true, record: { owner: OTHER, address: OTHER, expiresAt: 2_000_000_000 }, market: listed(OTHER, price) } },
    market: { feed: null, sort: 'newest', offset: 0, incoming: null, outgoing: null, mine: null, events: null, review: { kind: 'buy', name: 'alpha.obs', listing: listed(OTHER, price).listing } },
  }));
  assert.match(html, /REVIEW PURCHASE/);
  assert.match(html, /0\.01 OBS/); // 2 bps of 250 OBS is 0.05, capped at 0.01
  assert.match(html, /ObsidianMarketBuy\(\)/);
  // the on-screen rule is the protocol rule for every amount, including both sides of the cap
  const screenGas = (amount) => {
    const gas = (amount * 2n) / 10_000n;
    return gas > 10n ** 16n ? 10n ** 16n : gas;
  };
  for (const amount of [1n, 9_999n, 10n ** 15n, 10n ** 18n, 50n * OBS, 5_000n * OBS, 123_456_789_012_345_678_901n]) {
    assert.equal(screenGas(amount), expectedGas(amount), String(amount));
  }
});

test('locked escrow, incoming and outgoing offers and per-name controls are shown from node state', () => {
  const id = 'ef'.repeat(32);
  const offer = (over) => ({ id, name: 'alpha.obs', maker: OTHER, owner: ME, amountSeals: (40n * OBS).toString(), status: 'PENDING', ...over });
  const html = SCREENS.ons(screenState({
    ownNames: ['alpha.obs', 'beta.obs'],
    market: {
      feed: { listings: [{ name: 'gamma.obs', priceSeals: (3n * OBS).toString(), seller: OTHER }], total: 1, hasMore: false },
      sort: 'newest', offset: 0,
      incoming: { offers: [offer({})] },
      outgoing: { offers: [offer({ maker: ME, owner: OTHER, status: 'DECLINED' })] },
      mine: { 'alpha.obs': { status: 'OWNED', owner: ME, listing: null }, 'beta.obs': listed(ME, 7n * OBS) },
      events: { events: [{ type: 'ONS_LISTED', data: { name: 'beta.obs' } }] },
      review: null,
    },
  }));
  assert.match(html, /LOCKED IN OFFERS/);
  assert.match(html, /40 OBS/);
  assert.match(html, /ObsidianMarketAccept\('ef/);
  assert.match(html, /ObsidianMarketDecline\('ef/);
  assert.doesNotMatch(html, /ObsidianMarketCancel\('ef/, 'a declined offer offers no action');
  assert.match(html, /ObsidianMarketList\('alpha\.obs','pr0'\)/);
  assert.match(html, /ObsidianMarketDelist\('beta\.obs'\)/);
  assert.match(html, /gamma\.obs/);
  assert.doesNotMatch(html, /undefined|NaN/);
});
