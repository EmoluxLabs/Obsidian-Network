// @vitest-environment jsdom
/**
 * ONS Marketplace in the browser (protocol 2.0.0).
 *
 * Two things matter here and neither is cosmetic:
 *   1. what the wallet signs: the body is the core's own canonical encoding, carries the price and seller (or amount and
 *      owner) the person reviewed, the right gas, and is refused locally when the chain state has already moved on;
 *   2. what the ONS page shows for each of the four search outcomes, from the node's answer and from nothing else.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { operations } from '../web/src/lib/operations.js';
import { Wallet } from '../web/src/lib/wallet.js';
import type { MarketListing, MarketNameStatus, MarketOfferView, ObsidianClient } from '../web/src/lib/client.js';
import { PROTOCOL_VERSION } from '../web/core/version.js';
import { decodeSignedTxFromBytes } from '../web/core/transactions/encode.js';
import { TxType, MarketOp } from '../web/core/protocol/types.js';
import { decodeMarketBody } from '../web/core/transactions/executors/marketplace.js';
import { expectedGas } from '../web/core/transactions/helpers.js';

const OBS = 10n ** 18n;
const PASSPHRASE = 'a passphrase long enough for the vault';
const OTHER = 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5z3j';

let wallet: Wallet;
beforeEach(async () => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  window.localStorage.clear();
  wallet = await Wallet.create('dobs', PASSPHRASE);
});

interface World {
  names: Record<string, MarketNameStatus>;
  offers: Record<string, MarketOfferView>;
  spendable: bigint;
}

function stub(world: World) {
  const submitted: Uint8Array[] = [];
  const client = {
    async status() {
      return { chainId: 7780, lastBlockTimestamp: 1_790_597_000 };
    },
    async network() {
      return { network: { chainId: 7780 } };
    },
    async balance(address: string) {
      return { address, nonce: 7, balanceSeals: world.spendable.toString(), spendableSeals: world.spendable.toString(), lockedSeals: '0' };
    },
    async marketName(name: string) {
      const status = world.names[name];
      if (!status) throw new Error('unknown');
      return status;
    },
    async marketOffer(id: string) {
      return { offer: world.offers[id]!, escrow: { held: true, amountSeals: world.offers[id]!.amountSeals }, atHeight: 10 };
    },
    async submit(signed: Uint8Array | string) {
      submitted.push(signed as Uint8Array);
      return { accepted: true, txId: 'ab'.repeat(32) };
    },
  };
  return { client: client as unknown as ObsidianClient, submitted };
}

const listing = (seller: string, price: bigint): MarketListing => ({
  name: 'alpha.obs',
  seller,
  owner: seller,
  priceSeals: price.toString(),
  priceObs: '',
  listedAt: 1,
  listedAtHeight: 5,
  expiresAt: 2_000_000_000,
  pendingOffers: 0,
});
const status = (over: Partial<MarketNameStatus>): MarketNameStatus => ({
  name: 'alpha.obs', status: 'OWNED', owner: OTHER, listing: null, pendingOffers: 0, locked: false, canRegister: false, canBuy: false, canOffer: true, atHeight: 10, ...over,
});
const decoded = (bytes: Uint8Array) => {
  const tx = decodeSignedTxFromBytes(bytes);
  return { tx, body: decodeMarketBody(tx.body) };
};

describe('what the wallet signs', () => {
  it('buy: carries the reviewed price and seller, gas on the price, and the node\u2019s protocol version', async () => {
    const price = 100n * OBS;
    const world: World = { names: { alpha: status({ status: 'LISTED', listing: listing(OTHER, price), canBuy: true, canOffer: false, locked: true }) }, offers: {}, spendable: 500n * OBS };
    const { client, submitted } = stub(world);
    await operations.buyName(client, wallet, { name: 'alpha.obs', reviewedPriceSeals: price.toString(), reviewedSeller: OTHER });
    const { tx, body } = decoded(submitted[0]!);
    expect(tx.type).toBe(TxType.ONS_MARKET);
    expect(tx.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(tx.gas).toBe(expectedGas(price));
    expect(body).toMatchObject({ op: MarketOp.BUY, name: 'alpha', amount: price, counterparty: OTHER });
  });

  it('buy: refuses locally when the listing changed, was removed, is the buyer\u2019s own, or cannot be afforded', async () => {
    const price = 100n * OBS;
    const base = { names: { alpha: status({ status: 'LISTED', listing: listing(OTHER, price), canBuy: true, locked: true }) }, offers: {}, spendable: 500n * OBS };
    const { client, submitted } = stub(base);
    await expect(operations.buyName(client, wallet, { name: 'alpha', reviewedPriceSeals: (price - 1n).toString(), reviewedSeller: OTHER })).rejects.toThrow(/changed since you reviewed/);
    await expect(operations.buyName(client, wallet, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: wallet.address })).rejects.toThrow(/changed since you reviewed/);
    const gone = stub({ ...base, names: { alpha: status({}) } });
    await expect(operations.buyName(gone.client, wallet, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: OTHER })).rejects.toThrow(/no longer listed/);
    const own = stub({ ...base, names: { alpha: status({ status: 'LISTED', listing: listing(wallet.address, price), locked: true }) } });
    await expect(operations.buyName(own.client, wallet, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: wallet.address })).rejects.toThrow(/your own/);
    const poor = stub({ ...base, spendable: price });
    await expect(operations.buyName(poor.client, wallet, { name: 'alpha', reviewedPriceSeals: price.toString(), reviewedSeller: OTHER })).rejects.toThrow(/insufficient spendable balance/);
    expect(submitted.length + gone.submitted.length + own.submitted.length + poor.submitted.length).toBe(0);
  });

  it('offer: addressed to the current owner, gas on top of the amount, refused on a listed name or without funds', async () => {
    const world: World = { names: { alpha: status({}), beta: status({ name: 'beta.obs', status: 'LISTED', listing: listing(OTHER, OBS), locked: true }) }, offers: {}, spendable: 50n * OBS };
    const { client, submitted } = stub(world);
    await operations.makeOffer(client, wallet, { name: 'alpha.obs', amountObs: '25' });
    const { tx, body } = decoded(submitted[0]!);
    expect(tx.gas).toBe(expectedGas(25n * OBS));
    expect(body).toMatchObject({ op: MarketOp.OFFER, name: 'alpha', amount: 25n * OBS, counterparty: OTHER });
    await expect(operations.makeOffer(client, wallet, { name: 'beta', amountObs: '1' })).rejects.toThrow(/listed for sale/);
    await expect(operations.makeOffer(client, wallet, { name: 'alpha', amountObs: '50' })).rejects.toThrow(/Funds locked in offers are not spendable/);
    await expect(operations.makeOffer(client, wallet, { name: 'alpha', amountObs: '0' })).rejects.toThrow();
    expect(submitted).toHaveLength(1);
  });

  it('list, re-price and remove: owner only, positive price only, zero gas', async () => {
    const mine = status({ owner: wallet.address });
    const listed = status({ owner: wallet.address, status: 'LISTED', listing: listing(wallet.address, 5n * OBS), locked: true });
    const a = stub({ names: { alpha: mine }, offers: {}, spendable: OBS });
    await operations.listName(a.client, wallet, { name: 'alpha', priceObs: '7.5' });
    expect(decoded(a.submitted[0]!)).toMatchObject({ tx: { gas: 0n }, body: { op: MarketOp.LIST, name: 'alpha', amount: 75n * OBS / 10n } });
    await expect(operations.listName(a.client, wallet, { name: 'alpha', priceObs: '0' })).rejects.toThrow();
    const b = stub({ names: { alpha: listed }, offers: {}, spendable: OBS });
    await operations.updateListingPrice(b.client, wallet, { name: 'alpha', priceObs: '9' });
    await operations.removeListing(b.client, wallet, { name: 'alpha' });
    expect(b.submitted.map((bytes) => decoded(bytes).body.op)).toEqual([MarketOp.UPDATE_PRICE, MarketOp.DELIST]);
    await expect(operations.listName(b.client, wallet, { name: 'alpha', priceObs: '1' })).rejects.toThrow(/already listed/);
    const stranger = stub({ names: { alpha: status({}) }, offers: {}, spendable: OBS });
    await expect(operations.listName(stranger.client, wallet, { name: 'alpha', priceObs: '1' })).rejects.toThrow(/only the owner/);
    await expect(operations.removeListing(stranger.client, wallet, { name: 'alpha' })).rejects.toThrow();
  });

  it('accept, decline and cancel: use the offer\u2019s own id and amount, and only for the right party and state', async () => {
    const offer: MarketOfferView = {
      id: 'cd'.repeat(32), name: 'alpha.obs', maker: OTHER, owner: wallet.address, amountSeals: (40n * OBS).toString(), amountObs: '', status: 'PENDING',
      createdAt: 1, createdAtHeight: 1, expiresAt: 2, resolvedAt: null, resolvedAtHeight: null, resolvedBy: null, resolvedTxId: null, escrowHeld: true, currentOwner: wallet.address,
    };
    const world: World = { names: {}, offers: { [offer.id]: offer }, spendable: OBS };
    const { client, submitted } = stub(world);
    await operations.acceptOffer(client, wallet, { offer });
    await operations.declineOffer(client, wallet, { offer });
    expect(submitted.map((bytes) => decoded(bytes).body)).toMatchObject([
      { op: MarketOp.ACCEPT_OFFER, name: 'alpha', amount: 40n * OBS, offerId: offer.id },
      { op: MarketOp.DECLINE_OFFER, name: 'alpha', offerId: offer.id },
    ]);
    await expect(operations.cancelOffer(client, wallet, { offer })).rejects.toThrow(/only the maker/);
    world.offers[offer.id] = { ...offer, status: 'CANCELLED' };
    await expect(operations.acceptOffer(client, wallet, { offer })).rejects.toThrow(/already cancelled/);
    world.offers[offer.id] = { ...offer, currentOwner: OTHER };
    await expect(operations.acceptOffer(client, wallet, { offer })).rejects.toThrow(/only the current owner/);
    world.offers[offer.id] = { ...offer, maker: wallet.address, owner: OTHER, currentOwner: OTHER };
    await operations.cancelOffer(client, wallet, { offer });
    expect(decoded(submitted[2]!).body.op).toBe(MarketOp.CANCEL_OFFER);
  });
});

// ── the page ─────────────────────────────────────────────────────────────────────────────────────────────────────

const calls: string[] = [];
let answers: Record<string, unknown> = {};

function install(fixtures: Record<string, unknown>) {
  answers = fixtures;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = decodeURIComponent(String(input));
    calls.push(url);
    const path = url.replace(/^.*\/api\/rpc\?path=/, '');
    const key = Object.keys(answers).find((candidate) => path === candidate || path.startsWith(`${candidate}?`)) ?? '';
    const body = answers[key];
    if (body === undefined) return new Response(JSON.stringify({ error: 'not found', code: 'ERR_NOT_FOUND' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
};

async function openPage(fixtures: Record<string, unknown>, search: string) {
  vi.resetModules();
  document.body.innerHTML = '<div id="app"></div>';
  install({
    '/params': { ons: { registrationFeeObs: '0.05', renewalFeeObs: '0.05', termSeconds: 31_536_000 } },
    '/names': { names: [], count: 0, matched: 0 },
    '/market/listings': { listings: [], total: 0, offset: 0, limit: 20, hasMore: false, atHeight: 10 },
    ...fixtures,
  });
  await import('../web/src/pages/ons.js');
  await settle();
  const input = document.querySelector<HTMLInputElement>('#ons-lookup')!;
  input.value = search;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  await settle();
  return document.querySelector('#ons-result')!.textContent ?? '';
}

afterEach(() => {
  vi.unstubAllGlobals();
  calls.length = 0;
});

describe('search outcomes on the ONS page', () => {
  it('A — an available name offers registration and nothing about buying', async () => {
    const text = await openPage({ '/market/name/free': status({ name: 'free.obs', status: 'AVAILABLE', owner: null, canRegister: true, canOffer: false }) }, 'free.obs');
    expect(text).toContain('AVAILABLE');
    expect(document.querySelector('#ons-go-register')).not.toBeNull();
    expect(document.querySelector('#market-buy')).toBeNull();
    expect(document.querySelector('#market-offer-review')).toBeNull();
  });

  it('B — a listed name shows the Marketplace badge, the exact price, the seller and a Buy action', async () => {
    const text = await openPage(
      { '/market/name/alpha': status({ status: 'LISTED', listing: listing(OTHER, 250n * OBS), canBuy: true, canOffer: false, locked: true }), '/names/alpha.obs': { name: 'alpha.obs', registeredAtHeight: 4, transferCount: 0 } },
      'alpha.obs',
    );
    expect(text).toContain('LISTED ON ONS MARKETPLACE');
    expect(text).toContain('250 OBS');
    expect(text).toContain('Seller');
    expect(document.querySelector('#market-buy')).not.toBeNull();
    expect(document.querySelector('#market-offer-review')).toBeNull();
    expect(text).not.toContain('undefined');
  });

  it('C — an owned, unlisted name offers a Make Offer form and no Buy', async () => {
    const text = await openPage({ '/market/name/alpha': status({}), '/names/alpha.obs': { name: 'alpha.obs', registeredAtHeight: 4, transferCount: 1 } }, 'alpha');
    expect(text).toContain('REGISTERED, NOT FOR SALE');
    expect(document.querySelector('#market-offer-amount')).not.toBeNull();
    expect(document.querySelector('#market-offer-review')).not.toBeNull();
    expect(document.querySelector('#market-buy')).toBeNull();
  });

  it('D — an unreachable node is said plainly and nothing is offered', async () => {
    const text = await openPage({}, 'alpha');
    expect(text).toContain('UNAVAILABLE');
    expect(document.querySelector('#market-buy')).toBeNull();
    expect(document.querySelector('#market-offer-review')).toBeNull();
    expect(document.querySelector('#ons-go-register')).toBeNull();
  });

  it('the feed lists active listings from the node with their prices', async () => {
    await openPage({ '/market/listings': { listings: [listing(OTHER, 3n * OBS / 2n)], total: 1, offset: 0, limit: 20, hasMore: false, atHeight: 10 } }, '');
    const feed = document.querySelector('#market-feed')!.textContent ?? '';
    expect(feed).toContain('alpha.obs');
    expect(feed).toContain('1.5 OBS');
    expect(feed).toContain('1 name listed');
  });
});
