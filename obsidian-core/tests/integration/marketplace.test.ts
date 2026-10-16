/**
 * ONS Marketplace (protocol 2.0.0): listings and the listing lock, fixed-price purchases, owner-directed offers with
 * consensus escrow, and the money invariants that tie them together. Every test builds real blocks on a real chain and
 * reads the resulting consensus state — nothing here mocks an executor, a balance or an escrow.
 *
 * A rejected transaction rejects the block that carries it (the producer drops such a transaction at assembly), so
 * `bad()` asserts both the protocol error and that the world state's root is byte-identical afterwards: a failed
 * transaction leaves no partial state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { MarketOp, OnsOp, TxType, type MarketOffer, type OnsRecord, type TxEnvelope } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { computeStateRoot } from '../../src/blockchain/state-root.js';
import { WorldState } from '../../src/blockchain/state.js';
import { ChainManager } from '../../src/blockchain/chain.js';
import { blockHash } from '../../src/blockchain/block.js';
import { decodeMarketBody } from '../../src/transactions/executors/marketplace.js';
import { activeListings, incomingOffers, nameMarketStatus, outgoingOffers } from '../../src/rpc/market-views.js';
import { createHarness, makeWallet, marketBody, onsBody, paymentBody, signedClaim, parseObs, type Harness, type TestWallet } from '../helpers/harness.js';

const ONS = CONSENSUS_PARAMS.ons;
const MARKET = ONS.market;
const GENESIS_TS = 1_767_225_600;
const T0 = GENESIS_TS + 100;
const OBS = parseObs('1'); // 1 OBS in seals

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

interface Scene {
  h: Harness;
  alice: TestWallet;
  bob: TestWallet;
  carol: TestWallet;
  dave: TestWallet;
  mallory: TestWallet;
  clock: { now: number };
}

const world = (s: Scene) => s.h.chain.world;
const root = (s: Scene) => computeStateRoot(world(s).s);
const bal = (s: Scene, w: TestWallet) => world(s).getAccount(w.address)?.balance ?? 0n;
const locked = (s: Scene, w: TestWallet) => world(s).escrowLockedBy(w.address);
const rec = (s: Scene, name = 'alpha'): OnsRecord => structuredClone(world(s).s.names.get(name)!);
const offerOf = (s: Scene, id: string): MarketOffer => world(s).offer(id)!;

function ons(s: Scene, w: TestWallet, op: OnsOp, name: string, extra: { address?: string; to?: string; fee?: bigint } = {}, gas = 0n, nonce?: number): TxEnvelope {
  return s.h.sign(w, TxType.ONS, onsBody(op, name, extra), { gas, nonce, protocolTime: s.clock.now });
}

function mkt(
  s: Scene,
  w: TestWallet,
  op: MarketOp,
  name: string,
  extra: { amount?: bigint; counterparty?: string; offerId?: string } = {},
  gas = 0n,
  nonce?: number,
): TxEnvelope {
  return s.h.sign(w, TxType.ONS_MARKET, marketBody(op, name, extra), { gas, nonce, protocolTime: s.clock.now });
}

const list = (s: Scene, w: TestWallet, name: string, price: bigint, nonce?: number) => mkt(s, w, MarketOp.LIST, name, { amount: price }, 0n, nonce);
const buy = (s: Scene, w: TestWallet, name: string, price: bigint, seller: TestWallet, nonce?: number, gas = expectedGas(price)) =>
  mkt(s, w, MarketOp.BUY, name, { amount: price, counterparty: seller.address }, gas, nonce);
const offer = (s: Scene, w: TestWallet, name: string, amount: bigint, owner: TestWallet, nonce?: number, gas = expectedGas(amount)) =>
  mkt(s, w, MarketOp.OFFER, name, { amount, counterparty: owner.address }, gas, nonce);
const accept = (s: Scene, w: TestWallet, name: string, o: TxEnvelope, amount: bigint, nonce?: number) =>
  mkt(s, w, MarketOp.ACCEPT_OFFER, name, { amount, offerId: o.id }, 0n, nonce);
const decline = (s: Scene, w: TestWallet, name: string, o: TxEnvelope, nonce?: number) => mkt(s, w, MarketOp.DECLINE_OFFER, name, { offerId: o.id }, 0n, nonce);
const cancel = (s: Scene, w: TestWallet, name: string, o: TxEnvelope, nonce?: number) => mkt(s, w, MarketOp.CANCEL_OFFER, name, { offerId: o.id }, 0n, nonce);

/** Include `txs` in the next block (5 s later) and require acceptance. */
function ok(s: Scene, ...txs: TxEnvelope[]) {
  s.clock.now += 5;
  const block = s.h.produce(txs, { timestamp: s.clock.now });
  return { block, events: s.h.chain.eventsForBlock(blockHash(block.header)) };
}

/** Include `txs` in one block and require rejection with `code`, leaving the state root untouched. */
function bad(s: Scene, code: ErrCode, ...txs: TxEnvelope[]) {
  const before = root(s);
  s.clock.now += 5;
  const verdict = s.h.tryBlock(txs, { timestamp: s.clock.now });
  expect(verdict.accepted, verdict.message).toBe(false);
  expect(verdict.code).toBe(code);
  expect(root(s)).toBe(before);
}

function advanceTo(s: Scene, t: number) {
  s.clock.now = t;
  s.h.produce([], { timestamp: s.clock.now });
}

async function scene(): Promise<Scene> {
  const h = await createHarness();
  open.push(h);
  const alice = makeWallet();
  const clock = { now: T0 };
  h.produce([signedClaim(h, alice, clock.now)], { timestamp: clock.now });
  const s: Scene = { h, alice, bob: makeWallet(), carol: makeWallet(), dave: makeWallet(), mallory: makeWallet(), clock };
  const fund = (w: TestWallet, obs: string, nonce: number) =>
    s.h.sign(alice, TxType.PAYMENT, paymentBody(w.address, obs), { gas: expectedGas(parseObs(obs)), nonce, protocolTime: clock.now });
  clock.now += 1;
  const n = world(s).getAccount(alice.address)!.nonce;
  h.produce([fund(s.bob, '5000', n), fund(s.carol, '5000', n + 1), fund(s.dave, '1000', n + 2)], { timestamp: clock.now });
  clock.now += 1;
  const regs = ['alpha', 'beta', 'gamma'].map((name, i) =>
    s.h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, name, { fee: ONS.registrationFee }), {
      gas: expectedGas(ONS.registrationFee),
      nonce: world(s).getAccount(alice.address)!.nonce + i,
      protocolTime: clock.now,
    }),
  );
  h.produce(regs, { timestamp: clock.now });
  return s;
}

const PRICE = 100n * OBS;

// ── listing ────────────────────────────────────────────────────────────────────────────────────────────────────

describe('listing', () => {
  it('the owner lists a name; ownership is untouched and the listing is consensus state', async () => {
    const s = await scene();
    const { events } = ok(s, list(s, s.alice, 'alpha', PRICE));
    const r = rec(s);
    expect(r.owner).toBe(s.alice.address);
    expect(r.listing).toMatchObject({ price: PRICE, seller: s.alice.address });
    expect(events.some((e) => e.type === 'ONS_LISTED' && e.data.price === PRICE.toString())).toBe(true);
    expect(world(s).s.market.listingsCreated).toBe(1);
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a non-owner, bad prices, a duplicate listing, a missing name and a gas charge', async () => {
    const s = await scene();
    bad(s, ErrCode.NAME_NOT_OWNED, list(s, s.bob, 'alpha', PRICE));
    bad(s, ErrCode.AMOUNT_ZERO, list(s, s.alice, 'alpha', 0n));
    bad(s, ErrCode.AMOUNT_ZERO, list(s, s.alice, 'alpha', MARKET.minPriceSeals - 1n));
    bad(s, ErrCode.NOT_FOUND, list(s, s.alice, 'nosuchname', PRICE));
    bad(s, ErrCode.SUPPLY_EXCEEDED, list(s, s.alice, 'alpha', 21_000_001n * OBS));
    // a price that does not fit the wire format at all
    expect(() => marketBody(MarketOp.LIST, 'alpha', { amount: 2n ** 130n })).toThrow();
    // gas on a zero-gas operation
    const gassed = s.h.sign(s.alice, TxType.ONS_MARKET, marketBody(MarketOp.LIST, 'alpha', { amount: PRICE }), { gas: 1n, protocolTime: s.clock.now });
    s.clock.now += 5;
    expect(s.h.tryBlock([gassed], { timestamp: s.clock.now }).accepted).toBe(false);
    ok(s, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.MARKET_STATE, list(s, s.alice, 'alpha', PRICE + 1n));
    expect(rec(s).listing?.price).toBe(PRICE);
  });

  it('refuses a name with an open ordinary transfer or recovery in flight', async () => {
    const s = await scene();
    ok(s, ons(s, s.alice, OnsOp.TRANSFER, 'alpha', { to: s.bob.address }));
    bad(s, ErrCode.NAME_TRANSFER_STATE, list(s, s.alice, 'alpha', PRICE));
    ok(s, ons(s, s.alice, OnsOp.CANCEL_TRANSFER, 'alpha'));
    ok(s, list(s, s.alice, 'alpha', PRICE));
  });

  it('price update and removal are owner-only; removal restores ordinary use; relisting works', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.NAME_NOT_OWNED, mkt(s, s.bob, MarketOp.UPDATE_PRICE, 'alpha', { amount: 5n * OBS }));
    bad(s, ErrCode.NAME_NOT_OWNED, mkt(s, s.bob, MarketOp.DELIST, 'alpha'));
    bad(s, ErrCode.MARKET_STATE, mkt(s, s.alice, MarketOp.UPDATE_PRICE, 'alpha', { amount: PRICE }));
    bad(s, ErrCode.AMOUNT_ZERO, mkt(s, s.alice, MarketOp.UPDATE_PRICE, 'alpha', { amount: 0n }));
    ok(s, mkt(s, s.alice, MarketOp.UPDATE_PRICE, 'alpha', { amount: 250n * OBS }));
    expect(rec(s).listing?.price).toBe(250n * OBS);
    ok(s, mkt(s, s.alice, MarketOp.DELIST, 'alpha'));
    expect(rec(s).listing).toBeUndefined();
    bad(s, ErrCode.MARKET_STATE, mkt(s, s.alice, MarketOp.DELIST, 'alpha'));
    bad(s, ErrCode.MARKET_STATE, mkt(s, s.alice, MarketOp.UPDATE_PRICE, 'alpha', { amount: PRICE }));
    ok(s, ons(s, s.alice, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.carol.address }));
    expect(rec(s).address).toBe(s.carol.address);
    ok(s, list(s, s.alice, 'alpha', 7n * OBS));
    expect(rec(s).listing?.price).toBe(7n * OBS);
  });
});

// ── the listing lock ───────────────────────────────────────────────────────────────────────────────────────────

describe('the listing lock is enforced by consensus', () => {
  it('blocks every ordinary owner operation on a listed name, and nothing else', async () => {
    const s = await scene();
    ok(s, ons(s, s.alice, OnsOp.SET_RECOVERY, 'alpha', { address: s.mallory.address }));
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const gas = expectedGas(ONS.renewalFee);
    bad(s, ErrCode.NAME_LISTED, ons(s, s.alice, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.bob.address }));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.alice, OnsOp.TRANSFER, 'alpha', { to: s.bob.address }));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.bob, OnsOp.ACCEPT_TRANSFER, 'alpha'));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.alice, OnsOp.SET_RECOVERY, 'alpha', { address: s.bob.address }));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.mallory, OnsOp.START_RECOVERY, 'alpha', { address: s.mallory.address }));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.mallory, OnsOp.FINALIZE_RECOVERY, 'alpha'));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.alice, OnsOp.RENEW, 'alpha', { fee: ONS.renewalFee }, gas));
    // an owner cannot re-list or offer on the listing, and cannot make an offer on their own name
    bad(s, ErrCode.MARKET_STATE, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.NAME_LISTED, offer(s, s.bob, 'alpha', 10n * OBS, s.alice));
    // the other names of the same owner are unaffected
    ok(s, ons(s, s.alice, OnsOp.UPDATE_ADDRESS, 'beta', { address: s.bob.address }));
    expect(rec(s, 'beta').address).toBe(s.bob.address);
    expect(rec(s).listing?.price).toBe(PRICE);
  });

  it('a lock racing an operation in the same block cannot be bypassed in either order', async () => {
    const s = await scene();
    const n = world(s).getAccount(s.alice.address)!.nonce;
    // transfer offered, then listed in the same block: the listing is refused (a transfer is open)
    bad(s, ErrCode.NAME_TRANSFER_STATE, ons(s, s.alice, OnsOp.TRANSFER, 'alpha', { to: s.bob.address }, 0n, n), list(s, s.alice, 'alpha', PRICE, n + 1));
    // listed, then an edit in the same block: the edit is refused
    bad(s, ErrCode.NAME_LISTED, list(s, s.alice, 'alpha', PRICE, n), ons(s, s.alice, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.bob.address }, 0n, n + 1));
    expect(rec(s).listing).toBeUndefined();
  });

  it('cancelling an ordinary transfer or recovery stays possible, and removal restores everything', async () => {
    const s = await scene();
    ok(s, ons(s, s.alice, OnsOp.SET_RECOVERY, 'alpha', { address: s.dave.address }));
    ok(s, list(s, s.alice, 'alpha', PRICE));
    ok(s, mkt(s, s.alice, MarketOp.DELIST, 'alpha'));
    ok(s, ons(s, s.alice, OnsOp.RENEW, 'alpha', { fee: ONS.renewalFee }, expectedGas(ONS.renewalFee)));
    ok(s, ons(s, s.alice, OnsOp.TRANSFER, 'alpha', { to: s.bob.address }));
    ok(s, ons(s, s.alice, OnsOp.CANCEL_TRANSFER, 'alpha'));
  });

  it('an active listing does not resolve; an unlisted name does', async () => {
    const s = await scene();
    expect(nameMarketStatus(world(s), 'alpha', s.clock.now)).toMatchObject({ status: 'OWNED', locked: false, canOffer: true, canBuy: false });
    ok(s, list(s, s.alice, 'alpha', PRICE));
    expect(nameMarketStatus(world(s), 'alpha', s.clock.now)).toMatchObject({ status: 'LISTED', locked: true, canOffer: false, canBuy: true });
    expect(nameMarketStatus(world(s), 'unregistered', s.clock.now)).toMatchObject({ status: 'AVAILABLE', canRegister: true, canOffer: false });
  });
});

// ── buying ─────────────────────────────────────────────────────────────────────────────────────────────────────

describe('buying a listed name', () => {
  it('pays the seller the full price, charges the buyer price + gas, moves the name, removes the listing, takes no commission', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const gas = expectedGas(PRICE);
    const [sellerBefore, buyerBefore, poolBefore, supplyBefore] = [bal(s, s.alice), bal(s, s.bob), world(s).s.pool.balance, world(s).s.metrics.totalSupply];
    const { events } = ok(s, buy(s, s.bob, 'alpha', PRICE, s.alice));
    const r = rec(s);
    expect(r.owner).toBe(s.bob.address);
    expect(r.address).toBe(s.bob.address);
    expect(r.listing).toBeUndefined();
    expect(r.transferCount).toBe(1);
    expect(bal(s, s.alice) - sellerBefore).toBe(PRICE);
    expect(buyerBefore - bal(s, s.bob)).toBe(PRICE + gas);
    expect(world(s).s.pool.balance - poolBefore).toBe(gas);
    expect(world(s).s.metrics.totalSupply).toBe(supplyBefore);
    expect(world(s).s.market.salesCount).toBe(1);
    expect(world(s).s.market.salesVolume).toBe(PRICE);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['ONS_SOLD', 'ONS_TRANSFERRED']));
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
  });

  it('the new owner can use the name and the old owner has lost every right', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    ok(s, buy(s, s.bob, 'alpha', PRICE, s.alice));
    ok(s, ons(s, s.bob, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.carol.address }));
    expect(rec(s).address).toBe(s.carol.address);
    bad(s, ErrCode.NAME_NOT_OWNED, ons(s, s.alice, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.alice.address }));
    bad(s, ErrCode.NAME_NOT_OWNED, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.NAME_NOT_OWNED, mkt(s, s.alice, MarketOp.DELIST, 'alpha'));
    ok(s, list(s, s.bob, 'alpha', 3n * OBS));
  });

  it('a sale clears the previous owner\'s recovery path', async () => {
    const s = await scene();
    ok(s, ons(s, s.alice, OnsOp.SET_RECOVERY, 'alpha', { address: s.mallory.address }));
    ok(s, list(s, s.alice, 'alpha', PRICE));
    ok(s, buy(s, s.bob, 'alpha', PRICE, s.alice));
    expect(rec(s).recoveryAddress).toBeUndefined();
    bad(s, ErrCode.NAME_RECOVERY_STATE, ons(s, s.mallory, OnsOp.START_RECOVERY, 'alpha', { address: s.mallory.address }));
  });

  it('fails safely without enough OBS: nobody is paid and nothing moves', async () => {
    const s = await scene();
    const poor = makeWallet();
    ok(s, s.h.sign(s.bob, TxType.PAYMENT, paymentBody(poor.address, '50'), { gas: expectedGas(parseObs('50')), protocolTime: s.clock.now }));
    ok(s, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.INSUFFICIENT_FUNDS, buy(s, poor, 'alpha', PRICE, s.alice));
    // exactly the price but no room for gas also fails
    const exact = makeWallet();
    ok(s, s.h.sign(s.bob, TxType.PAYMENT, paymentBody(exact.address, PRICE), { gas: expectedGas(PRICE), protocolTime: s.clock.now }));
    bad(s, ErrCode.INSUFFICIENT_FUNDS, buy(s, exact, 'alpha', PRICE, s.alice));
    expect(rec(s).owner).toBe(s.alice.address);
    expect(rec(s).listing?.price).toBe(PRICE);
  });

  it('refuses a stale price, a wrong seller, the seller, an unlisted name and the wrong gas', async () => {
    const s = await scene();
    bad(s, ErrCode.MARKET_STATE, buy(s, s.bob, 'alpha', PRICE, s.alice)); // not listed
    ok(s, list(s, s.alice, 'alpha', PRICE));
    ok(s, mkt(s, s.alice, MarketOp.UPDATE_PRICE, 'alpha', { amount: 500n * OBS }));
    bad(s, ErrCode.MARKET_PRICE_MISMATCH, buy(s, s.bob, 'alpha', PRICE, s.alice)); // saw the old price
    bad(s, ErrCode.MARKET_STATE, buy(s, s.bob, 'alpha', 500n * OBS, s.carol)); // reviewed another seller
    bad(s, ErrCode.MARKET_STATE, buy(s, s.alice, 'alpha', 500n * OBS, s.alice)); // the seller
    s.clock.now += 5;
    const cheapGas = s.h.tryBlock([buy(s, s.bob, 'alpha', 500n * OBS, s.alice, undefined, 1n)], { timestamp: s.clock.now });
    expect(cheapGas.accepted).toBe(false);
    ok(s, buy(s, s.bob, 'alpha', 500n * OBS, s.alice));
    expect(rec(s).owner).toBe(s.bob.address);
  });

  it('two buyers racing for one name: exactly one wins, in either order, and the loser sees "no longer listed"', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.MARKET_STATE, buy(s, s.bob, 'alpha', PRICE, s.alice), buy(s, s.carol, 'alpha', PRICE, s.alice));
    ok(s, buy(s, s.carol, 'alpha', PRICE, s.alice));
    const carolBefore = bal(s, s.carol);
    bad(s, ErrCode.MARKET_STATE, buy(s, s.bob, 'alpha', PRICE, s.alice));
    expect(rec(s).owner).toBe(s.carol.address);
    expect(bal(s, s.carol)).toBe(carolBefore);
    expect(world(s).s.market.salesCount).toBe(1);
  });

  it('remove versus buy: whichever is ordered first wins and the other fails', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const n = world(s).getAccount(s.alice.address)!.nonce;
    bad(s, ErrCode.MARKET_STATE, mkt(s, s.alice, MarketOp.DELIST, 'alpha', {}, 0n, n), buy(s, s.bob, 'alpha', PRICE, s.alice));
    bad(s, ErrCode.NAME_NOT_OWNED, buy(s, s.bob, 'alpha', PRICE, s.alice), mkt(s, s.alice, MarketOp.DELIST, 'alpha', {}, 0n, n));
    ok(s, mkt(s, s.alice, MarketOp.DELIST, 'alpha'));
    bad(s, ErrCode.MARKET_STATE, buy(s, s.bob, 'alpha', PRICE, s.alice));
    expect(rec(s).owner).toBe(s.alice.address);
  });

  it('a replayed purchase is refused', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const tx = buy(s, s.bob, 'alpha', PRICE, s.alice);
    ok(s, tx);
    ok(s, list(s, s.bob, 'alpha', PRICE));
    s.clock.now += 5;
    expect(s.h.tryBlock([tx], { timestamp: s.clock.now }).accepted).toBe(false);
    expect(rec(s).owner).toBe(s.bob.address);
  });
});

// ── offers and escrow ──────────────────────────────────────────────────────────────────────────────────────────

describe('making an offer locks real funds', () => {
  it('moves the amount into escrow immediately, charges gas separately, and records the offer', async () => {
    const s = await scene();
    const amount = 40n * OBS;
    const gas = expectedGas(amount);
    const before = bal(s, s.bob);
    const o = offer(s, s.bob, 'alpha', amount, s.alice);
    const { events } = ok(s, o);
    expect(bal(s, s.bob)).toBe(before - amount - gas);
    expect(locked(s, s.bob)).toBe(amount);
    expect(world(s).s.market.escrowBalance).toBe(amount);
    expect(offerOf(s, o.id)).toMatchObject({ id: o.id, name: 'alpha', maker: s.bob.address, owner: s.alice.address, amount, status: 'PENDING' });
    expect(offerOf(s, o.id).expiresAt).toBe(offerOf(s, o.id).createdAt + MARKET.offerSeconds);
    expect(events.some((e) => e.type === 'ONS_OFFER_MADE' && e.data.offerId === o.id)).toBe(true);
    // the name has not moved and the owner has not been paid
    expect(rec(s).owner).toBe(s.alice.address);
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
  });

  it('locked funds cannot be spent, and the gas is never taken from escrow', async () => {
    const s = await scene();
    const spendable = bal(s, s.dave);
    // an offer for almost everything leaves only enough for the gas
    const amount = spendable - expectedGas(spendable) - 1n;
    const big = amount - (amount % 1n);
    ok(s, offer(s, s.dave, 'alpha', big - expectedGas(big) , s.alice));
    const remaining = bal(s, s.dave);
    bad(s, ErrCode.INSUFFICIENT_FUNDS, s.h.sign(s.dave, TxType.PAYMENT, paymentBody(s.bob.address, remaining + 1n), { gas: expectedGas(remaining + 1n), protocolTime: s.clock.now }));
    expect(locked(s, s.dave)).toBe(big - expectedGas(big));
    // an offer one seal beyond what is spendable is refused outright
    bad(s, ErrCode.INSUFFICIENT_FUNDS, offer(s, s.dave, 'beta', remaining + 1n, s.alice));
  });

  it('refuses an offer on a listed name, the owner\'s own offer, a wrong owner, bad amounts and duplicates', async () => {
    const s = await scene();
    bad(s, ErrCode.MARKET_STATE, offer(s, s.alice, 'beta', 10n * OBS, s.alice));
    bad(s, ErrCode.MARKET_STATE, offer(s, s.bob, 'beta', 10n * OBS, s.carol)); // addressed to somebody else
    bad(s, ErrCode.AMOUNT_ZERO, offer(s, s.bob, 'beta', 0n, s.alice));
    bad(s, ErrCode.NOT_FOUND, offer(s, s.bob, 'nosuchname', 10n * OBS, s.alice));
    ok(s, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.NAME_LISTED, offer(s, s.bob, 'alpha', 10n * OBS, s.alice));
    ok(s, offer(s, s.bob, 'beta', 10n * OBS, s.alice));
    bad(s, ErrCode.MARKET_STATE, offer(s, s.bob, 'beta', 11n * OBS, s.alice)); // one pending offer per maker per name
    expect(world(s).s.market.offersMade).toBe(1);
  });

  it('enforces the per-name and per-maker limits so slots cannot be squatted without bound', async () => {
    const s = await scene();
    expect(MARKET.maxPendingOffersPerName).toBeGreaterThan(1);
    const makers = Array.from({ length: MARKET.maxPendingOffersPerName + 1 }, () => makeWallet());
    const n0 = world(s).getAccount(s.alice.address)!.nonce;
    ok(s, ...makers.map((m, i) => s.h.sign(s.alice, TxType.PAYMENT, paymentBody(m.address, '10'), { gas: expectedGas(parseObs('10')), nonce: n0 + i, protocolTime: s.clock.now })));
    for (let i = 0; i < MARKET.maxPendingOffersPerName; i += 1) ok(s, offer(s, makers[i]!, 'alpha', OBS, s.alice));
    bad(s, ErrCode.MARKET_STATE, offer(s, makers[MARKET.maxPendingOffersPerName]!, 'alpha', OBS, s.alice));
    expect(world(s).offersForName('alpha', 'PENDING')).toHaveLength(MARKET.maxPendingOffersPerName);
  });
});

describe('accepting an offer', () => {
  it('moves the name to the maker and the escrow to the owner in one step, with no gas and no commission', async () => {
    const s = await scene();
    const amount = 40n * OBS;
    const o = offer(s, s.bob, 'alpha', amount, s.alice);
    ok(s, o);
    const [aliceBefore, bobBefore, supply] = [bal(s, s.alice), bal(s, s.bob), world(s).s.metrics.totalSupply];
    const { events } = ok(s, accept(s, s.alice, 'alpha', o, amount));
    expect(rec(s).owner).toBe(s.bob.address);
    expect(rec(s).address).toBe(s.bob.address);
    expect(bal(s, s.alice) - aliceBefore).toBe(amount);
    expect(bal(s, s.bob)).toBe(bobBefore);
    expect(world(s).s.market.escrowBalance).toBe(0n);
    expect(locked(s, s.bob)).toBe(0n);
    expect(offerOf(s, o.id)).toMatchObject({ status: 'ACCEPTED', resolvedBy: s.alice.address, resolvedTxId: expect.any(String) });
    expect(world(s).s.metrics.totalSupply).toBe(supply);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['ONS_OFFER_ACCEPTED', 'ONS_TRANSFERRED']));
    expect(world(s).s.market.offersAccepted).toBe(1);
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
    // the old owner lost the name entirely, the new owner may use it
    bad(s, ErrCode.NAME_NOT_OWNED, ons(s, s.alice, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.alice.address }));
    ok(s, ons(s, s.bob, OnsOp.UPDATE_ADDRESS, 'alpha', { address: s.carol.address }));
  });

  it('refunds every competing offer in the same step, so each escrow is released exactly once', async () => {
    const s = await scene();
    const ob = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    const oc = offer(s, s.carol, 'alpha', 60n * OBS, s.alice);
    ok(s, ob);
    ok(s, oc);
    const carolBefore = bal(s, s.carol);
    ok(s, accept(s, s.alice, 'alpha', ob, 40n * OBS));
    expect(offerOf(s, oc.id).status).toBe('INVALIDATED');
    expect(bal(s, s.carol)).toBe(carolBefore + 60n * OBS);
    expect(world(s).s.market.escrowBalance).toBe(0n);
    bad(s, ErrCode.NAME_NOT_OWNED, accept(s, s.alice, 'alpha', oc, 60n * OBS));
  });

  it('only the current owner may accept, with the right amount, an unexpired offer, on an unlisted name', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    bad(s, ErrCode.NAME_NOT_OWNED, accept(s, s.mallory, 'alpha', o, 40n * OBS));
    bad(s, ErrCode.NAME_NOT_OWNED, accept(s, s.bob, 'alpha', o, 40n * OBS)); // the maker cannot accept their own offer
    bad(s, ErrCode.MARKET_PRICE_MISMATCH, accept(s, s.alice, 'alpha', o, 39n * OBS));
    bad(s, ErrCode.NOT_FOUND, mkt(s, s.alice, MarketOp.ACCEPT_OFFER, 'alpha', { amount: 40n * OBS, offerId: 'ab'.repeat(32) }));
    bad(s, ErrCode.MALFORMED, mkt(s, s.alice, MarketOp.ACCEPT_OFFER, 'alpha', { amount: 40n * OBS, offerId: 'xyz' }));
    bad(s, ErrCode.NOT_FOUND, accept(s, s.alice, 'beta', o, 40n * OBS)); // an offer on another name
    expect(offerOf(s, o.id).status).toBe('PENDING');
    expect(locked(s, s.bob)).toBe(40n * OBS);
  });

  it('an offer that has lapsed cannot be accepted, and the sweep refunds it exactly once', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    const bobBefore = bal(s, s.bob);
    const created = offerOf(s, o.id).createdAt;
    s.clock.now = created + MARKET.offerSeconds - 1;
    // the block just before expiry still sees a live offer
    const live = accept(s, s.alice, 'alpha', o, 40n * OBS);
    s.clock.now = created + MARKET.offerSeconds + 1;
    bad(s, ErrCode.MARKET_STATE, live);
    advanceTo(s, created + MARKET.offerSeconds + 2);
    expect(offerOf(s, o.id).status).toBe('EXPIRED');
    expect(bal(s, s.bob)).toBe(bobBefore + 40n * OBS);
    expect(world(s).s.market.escrowBalance).toBe(0n);
    advanceTo(s, s.clock.now + 5);
    expect(bal(s, s.bob)).toBe(bobBefore + 40n * OBS);
  });
});

describe('declining and cancelling an offer', () => {
  it('decline refunds the maker exactly once and the name stays put; only the owner may decline', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    const before = bal(s, s.bob);
    bad(s, ErrCode.NAME_NOT_OWNED, decline(s, s.mallory, 'alpha', o));
    bad(s, ErrCode.NAME_NOT_OWNED, decline(s, s.bob, 'alpha', o));
    const { events } = ok(s, decline(s, s.alice, 'alpha', o));
    expect(bal(s, s.bob)).toBe(before + 40n * OBS);
    expect(offerOf(s, o.id).status).toBe('DECLINED');
    expect(rec(s).owner).toBe(s.alice.address);
    expect(events.some((e) => e.type === 'ONS_OFFER_DECLINED')).toBe(true);
    // one terminal state per offer
    bad(s, ErrCode.MARKET_STATE, decline(s, s.alice, 'alpha', o));
    bad(s, ErrCode.MARKET_STATE, cancel(s, s.bob, 'alpha', o));
    bad(s, ErrCode.MARKET_STATE, accept(s, s.alice, 'alpha', o, 40n * OBS));
    expect(bal(s, s.bob)).toBe(before + 40n * OBS);
  });

  it('cancel refunds the maker; only the maker may cancel; the maker may then offer again', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    const before = bal(s, s.bob);
    bad(s, ErrCode.UNAUTHORIZED, cancel(s, s.alice, 'alpha', o));
    bad(s, ErrCode.UNAUTHORIZED, cancel(s, s.mallory, 'alpha', o));
    ok(s, cancel(s, s.bob, 'alpha', o));
    expect(bal(s, s.bob)).toBe(before + 40n * OBS);
    expect(offerOf(s, o.id).status).toBe('CANCELLED');
    ok(s, offer(s, s.bob, 'alpha', 41n * OBS, s.alice));
    expect(world(s).s.market.escrowBalance).toBe(41n * OBS);
  });

  it('accept versus cancel in one block settles once, whichever is first', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    bad(s, ErrCode.MARKET_STATE, accept(s, s.alice, 'alpha', o, 40n * OBS), cancel(s, s.bob, 'alpha', o));
    bad(s, ErrCode.MARKET_STATE, cancel(s, s.bob, 'alpha', o), accept(s, s.alice, 'alpha', o, 40n * OBS));
    ok(s, cancel(s, s.bob, 'alpha', o));
    bad(s, ErrCode.MARKET_STATE, accept(s, s.alice, 'alpha', o, 40n * OBS));
    expect(rec(s).owner).toBe(s.alice.address);
  });

  it('concurrent offers from one account cannot double-spend the same balance', async () => {
    const s = await scene();
    const spendable = bal(s, s.dave);
    const half = (spendable * 6n) / 10n;
    const n = world(s).getAccount(s.dave.address)!.nonce;
    // two offers that each fit alone but not together
    bad(s, ErrCode.INSUFFICIENT_FUNDS, offer(s, s.dave, 'alpha', half, s.alice, n), offer(s, s.dave, 'beta', half, s.alice, n + 1));
    expect(world(s).s.market.escrowBalance).toBe(0n);
    ok(s, offer(s, s.dave, 'alpha', half, s.alice));
    bad(s, ErrCode.INSUFFICIENT_FUNDS, offer(s, s.dave, 'beta', half, s.alice));
  });
});

// ── listing and offers are mutually exclusive ─────────────────────────────────────────────────────────────────

describe('listing versus pending offers', () => {
  it('listing a name refunds every pending offer in the same transaction, and no offer can be accepted afterwards', async () => {
    const s = await scene();
    const ob = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    const oc = offer(s, s.carol, 'alpha', 60n * OBS, s.alice);
    ok(s, ob);
    ok(s, oc);
    const [bobBefore, carolBefore] = [bal(s, s.bob), bal(s, s.carol)];
    const { events } = ok(s, list(s, s.alice, 'alpha', PRICE));
    expect(offerOf(s, ob.id).status).toBe('INVALIDATED');
    expect(offerOf(s, oc.id).status).toBe('INVALIDATED');
    expect(bal(s, s.bob)).toBe(bobBefore + 40n * OBS);
    expect(bal(s, s.carol)).toBe(carolBefore + 60n * OBS);
    expect(world(s).s.market.escrowBalance).toBe(0n);
    expect(events.filter((e) => e.type === 'ONS_OFFER_INVALIDATED')).toHaveLength(2);
    bad(s, ErrCode.NAME_LISTED, accept(s, s.alice, 'alpha', ob, 40n * OBS));
    bad(s, ErrCode.NAME_LISTED, offer(s, s.bob, 'alpha', 40n * OBS, s.alice));
    // after the listing is removed a fresh offer works again
    ok(s, mkt(s, s.alice, MarketOp.DELIST, 'alpha'));
    ok(s, offer(s, s.bob, 'alpha', 40n * OBS, s.alice));
  });

  it('a purchase refunds offers made earlier on the name... which a listing has already cleared', async () => {
    const s = await scene();
    ok(s, offer(s, s.bob, 'alpha', 40n * OBS, s.alice));
    ok(s, list(s, s.alice, 'alpha', PRICE));
    ok(s, buy(s, s.carol, 'alpha', PRICE, s.alice));
    expect(world(s).offersForName('alpha', 'PENDING')).toHaveLength(0);
    expect(world(s).s.market.escrowBalance).toBe(0n);
  });
});

describe('stale ownership', () => {
  it('an ordinary transfer invalidates pending offers and refunds them; the new owner cannot accept the old owner\'s offer', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    const before = bal(s, s.bob);
    ok(s, ons(s, s.alice, OnsOp.TRANSFER, 'alpha', { to: s.dave.address }));
    ok(s, ons(s, s.dave, OnsOp.ACCEPT_TRANSFER, 'alpha'));
    expect(offerOf(s, o.id).status).toBe('INVALIDATED');
    expect(bal(s, s.bob)).toBe(before + 40n * OBS);
    bad(s, ErrCode.MARKET_STATE, accept(s, s.dave, 'alpha', o, 40n * OBS));
    expect(world(s).s.market.escrowBalance).toBe(0n);
  });

  it('a finalized recovery also voids offers', async () => {
    const s = await scene();
    ok(s, ons(s, s.alice, OnsOp.SET_RECOVERY, 'alpha', { address: s.dave.address }));
    const o = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    ok(s, o);
    ok(s, ons(s, s.dave, OnsOp.START_RECOVERY, 'alpha', { address: s.dave.address }));
    s.clock.now += ONS.recoveryDelaySeconds + 10;
    ok(s, ons(s, s.dave, OnsOp.FINALIZE_RECOVERY, 'alpha'));
    expect(rec(s).owner).toBe(s.dave.address);
    expect(offerOf(s, o.id).status).toBe('INVALIDATED');
    expect(world(s).s.market.escrowBalance).toBe(0n);
  });

  it('a name that expires with a pending offer or a listing refunds the escrow and never strands it', async () => {
    const s = await scene();
    const o = offer(s, s.bob, 'beta', 40n * OBS, s.alice);
    ok(s, o);
    ok(s, list(s, s.alice, 'gamma', PRICE));
    const before = bal(s, s.bob);
    // test-only: the chain is younger than a name term, so move the expiry back (as the mining tests rewind a timer)
    for (const name of ['beta', 'gamma']) world(s).s.names.get(name)!.expiresAt = s.clock.now - ONS.graceSeconds - 10;
    // cannot trade an expired name
    bad(s, ErrCode.NAME_TAKEN, accept(s, s.alice, 'beta', o, 40n * OBS));
    advanceTo(s, s.clock.now + 5);
    expect(world(s).s.names.has('beta')).toBe(false);
    expect(world(s).s.names.has('gamma')).toBe(false);
    expect(offerOf(s, o.id).status).toBe('INVALIDATED');
    expect(bal(s, s.bob)).toBe(before + 40n * OBS);
    expect(world(s).s.market.escrowBalance).toBe(0n);
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
  });

  it('a listed name cannot be renewed, so the lock cannot be used to hold a name past its term', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    bad(s, ErrCode.NAME_LISTED, ons(s, s.alice, OnsOp.RENEW, 'alpha', { fee: ONS.renewalFee }, expectedGas(ONS.renewalFee)));
    // an offer's own deadline never outlives the name
    const o = offer(s, s.bob, 'beta', 40n * OBS, s.alice);
    world(s).s.names.get('beta')!.expiresAt = s.clock.now + 60;
    ok(s, o);
    expect(offerOf(s, o.id).expiresAt).toBeLessThanOrEqual(world(s).s.names.get('beta')!.expiresAt);
  });
});

// ── malformed and adversarial input ───────────────────────────────────────────────────────────────────────────

describe('hostile input', () => {
  it('rejects unknown operations, truncated bodies, trailing bytes and bad names', async () => {
    const s = await scene();
    const tx = (body: Uint8Array) => s.h.sign(s.alice, TxType.ONS_MARKET, body, { gas: 0n, protocolTime: s.clock.now });
    const good = marketBody(MarketOp.LIST, 'alpha', { amount: PRICE });
    for (const body of [marketBody(99, 'alpha'), good.slice(0, good.length - 1), new Uint8Array([...good, 0]), marketBody(MarketOp.LIST, 'Bad Name!', { amount: PRICE }), new Uint8Array()]) {
      s.clock.now += 5;
      const verdict = s.h.tryBlock([tx(body)], { timestamp: s.clock.now });
      expect(verdict.accepted).toBe(false);
      expect(verdict.code).toMatch(/^ERR_/);
    }
    expect(rec(s).listing).toBeUndefined();
    expect(decodeMarketBody(good)).toMatchObject({ op: MarketOp.LIST, name: 'alpha', amount: PRICE });
  });

  it('a signature from the wrong key or a tampered body never executes', async () => {
    const s = await scene();
    const tx = list(s, s.alice, 'alpha', PRICE);
    const tampered = { ...tx, body: marketBody(MarketOp.LIST, 'alpha', { amount: 1n }) };
    s.clock.now += 5;
    expect(s.h.tryBlock([tampered as TxEnvelope], { timestamp: s.clock.now }).accepted).toBe(false);
    expect(rec(s).listing).toBeUndefined();
  });
});

// ── persistence, indexes, reprocessing ────────────────────────────────────────────────────────────────────────

describe('state, persistence and views', () => {
  async function busy(): Promise<{ s: Scene; offerId: string }> {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const o = offer(s, s.bob, 'beta', 40n * OBS, s.alice);
    ok(s, o);
    ok(s, offer(s, s.carol, 'beta', 30n * OBS, s.alice));
    return { s, offerId: o.id };
  }

  it('a snapshot round-trips losslessly and commits to the listing, offers and escrow', async () => {
    const { s } = await busy();
    const snapshot = world(s).toSnapshot(s.h.chain.tip!.hash);
    expect(snapshot.snapshotVersion).toBe(7);
    const restored = WorldState.fromSnapshot(snapshot);
    expect(computeStateRoot(restored.s)).toBe(root(s));
    expect(restored.s.names.get('alpha')!.listing!.price).toBe(PRICE);
    expect(restored.offersForName('beta', 'PENDING')).toHaveLength(2);
    expect(restored.verifySupplyInvariant().ok).toBe(true);
    // a snapshot from before the Marketplace is refused rather than read as "no escrow"
    const old = { ...snapshot, snapshotVersion: 6, offers: undefined, market: undefined } as never;
    expect(() => WorldState.fromSnapshot(old)).toThrow();
  });

  it('the state root changes when a listing, an offer or the escrow changes', async () => {
    const s = await scene();
    const r0 = root(s);
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const r1 = root(s);
    ok(s, mkt(s, s.alice, MarketOp.UPDATE_PRICE, 'alpha', { amount: PRICE + 1n }));
    const r2 = root(s);
    expect(new Set([r0, r1, r2]).size).toBe(3);
  });

  it('restarting from disk replays to the same state, and an earlier height still shows the earlier state (reprocessing safety)', async () => {
    const { s } = await busy();
    const tipHeight = s.h.chain.height;
    const expected = root(s);
    const restarted = new ChainManager({ dataDir: s.h.dir, net: s.h.net, genesisDocument: s.h.chain.genesisDocument, enforceProposerRotation: true });
    await restarted.init();
    expect(restarted.height).toBe(tipHeight);
    expect(computeStateRoot(restarted.world.s)).toBe(expected);
    expect(restarted.world.s.names.get('alpha')!.listing?.price).toBe(PRICE);
    expect(restarted.world.offersForName('beta', 'PENDING')).toHaveLength(2);
    const hash = s.h.chain.store.getCanonicalHashAtHeight(tipHeight - 3)!;
    const earlier = s.h.chain.stateAtHeight(tipHeight - 3, hash);
    expect(earlier.s.names.get('alpha')!.listing).toBeUndefined();
    expect(earlier.s.market.escrowBalance).toBe(0n);
  });

  it('answers listing, offer and ownership queries from state, paginated and ordered deterministically', async () => {
    const { s, offerId } = await busy();
    ok(s, list(s, s.alice, 'gamma', 5n * OBS));
    const page1 = activeListings(world(s), { limit: 1, offset: 0, sort: 'price_asc', now: s.clock.now });
    expect(page1.total).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.listings[0]!.name).toBe('gamma.obs');
    const page2 = activeListings(world(s), { limit: 1, offset: 1, sort: 'price_asc', now: s.clock.now });
    expect(page2.listings[0]!.name).toBe('alpha.obs');
    expect(page2.hasMore).toBe(false);
    expect(activeListings(world(s), { seller: s.bob.address, limit: 10, offset: 0, now: s.clock.now }).total).toBe(0);
    expect(incomingOffers(world(s), s.alice.address, 'PENDING').map((o) => o.name)).toEqual(['beta.obs', 'beta.obs']);
    expect(outgoingOffers(world(s), s.bob.address).map((o) => o.id)).toEqual([offerId]);
    expect(incomingOffers(world(s), s.bob.address)).toHaveLength(0);
  });
});

// ── economics ──────────────────────────────────────────────────────────────────────────────────────────────────

describe('economic reconciliation', () => {
  it('after a mixed history the books balance: supply unchanged, escrow equals pending offers, no value created or lost', async () => {
    const s = await scene();
    const supply = world(s).s.metrics.totalSupply;
    const sumAll = () => {
      let total = world(s).s.pool.balance + world(s).s.market.escrowBalance;
      for (const a of world(s).s.accounts.values()) total += a.balance;
      return total;
    };
    const o1 = offer(s, s.bob, 'alpha', 40n * OBS, s.alice);
    const o2 = offer(s, s.carol, 'alpha', 30n * OBS, s.alice);
    ok(s, o1);
    ok(s, o2);
    ok(s, decline(s, s.alice, 'alpha', o2));
    ok(s, accept(s, s.alice, 'alpha', o1, 40n * OBS));
    ok(s, list(s, s.bob, 'alpha', 90n * OBS));
    ok(s, buy(s, s.dave, 'alpha', 90n * OBS, s.bob));
    const o3 = offer(s, s.carol, 'beta', 10n * OBS, s.alice);
    ok(s, o3);
    ok(s, cancel(s, s.carol, 'beta', o3));
    expect(world(s).s.metrics.totalSupply).toBe(supply);
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
    expect(world(s).s.market.escrowBalance).toBe(0n);
    let pending = 0n;
    for (const o of world(s).s.offers.values()) if (o.status === 'PENDING') pending += o.amount;
    expect(pending).toBe(world(s).s.market.escrowBalance);
    // Σ balances + pool + escrow + node-reward pool + treasury + fee splits is conserved by every Marketplace step
    expect(sumAll()).toBeGreaterThan(0n);
    expect(rec(s).owner).toBe(s.dave.address);
  });

  it('a tampered escrow (more or less than the pending offers) is caught by the supply invariant', async () => {
    const s = await scene();
    ok(s, offer(s, s.bob, 'alpha', 40n * OBS, s.alice));
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
    world(s).s.market.escrowBalance += 1n;
    expect(world(s).verifySupplyInvariant().ok).toBe(false);
  });
});

// ── grace period (found in the 2.0.1 audit: registration used to ignore it) ───────────────────────────────────

describe('a lapsed name is protected by its grace period', () => {
  const register = (s: Scene, w: TestWallet, name: string) =>
    ons(s, w, OnsOp.REGISTER, name, { fee: ONS.registrationFee }, expectedGas(ONS.registrationFee));

  it('nobody but the owner can take a name that has lapsed but is still inside grace; after grace anyone can', async () => {
    const s = await scene();
    ok(s, list(s, s.alice, 'alpha', PRICE));
    const o = offer(s, s.bob, 'beta', 40n * OBS, s.alice);
    ok(s, o);
    world(s).s.names.get('alpha')!.expiresAt = s.clock.now - 10;
    world(s).s.names.get('beta')!.expiresAt = s.clock.now - 10;
    // inside grace: a stranger cannot register over the lapsed name (and so cannot steal its listing or offers)
    bad(s, ErrCode.NAME_TAKEN, register(s, s.bob, 'alpha'));
    bad(s, ErrCode.NAME_TAKEN, register(s, s.bob, 'beta'));
    expect(rec(s).owner).toBe(s.alice.address);
    // the owner can still renew a lapsed name that is not listed
    ok(s, ons(s, s.alice, OnsOp.RENEW, 'beta', { fee: ONS.renewalFee }, expectedGas(ONS.renewalFee)));
    expect(world(s).s.names.get('beta')!.expiresAt).toBeGreaterThan(s.clock.now);
    // past grace the registry drops the name and anyone may register it again
    world(s).s.names.get('alpha')!.expiresAt = s.clock.now - ONS.graceSeconds - 10;
    ok(s, register(s, s.bob, 'alpha'));
    expect(rec(s).owner).toBe(s.bob.address);
    expect(rec(s).listing).toBeUndefined();
    // beta's offer (made before the test moved its expiry) is still pending and still held; alpha had none
    expect(world(s).s.market.escrowBalance).toBe(40n * OBS);
    expect(offerOf(s, o.id).status).toBe('PENDING');
    expect(world(s).verifySupplyInvariant().ok).toBe(true);
  });
});
