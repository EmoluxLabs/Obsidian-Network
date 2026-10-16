/**
 * Model-based property test for the ONS Marketplace. A seeded pseudo-random sequence of transactions (ordinary ONS
 * operations, payments and every Marketplace operation, singly and in racing pairs, with the clock jumping past
 * offer lifetimes) is thrown at a real chain. After every ACCEPTED block the whole-ledger invariants must hold, and a
 * REJECTED block must leave the committed state root untouched. The test mirrors only what consensus must guarantee.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { MarketOp, OnsOp, TxType, type TxEnvelope } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { computeStateRoot } from '../../src/blockchain/state-root.js';
import { WorldState } from '../../src/blockchain/state.js';
import { createHarness, makeWallet, marketBody, onsBody, paymentBody, signedClaim, parseObs, type Harness, type TestWallet } from '../helpers/harness.js';

const ONS = CONSENSUS_PARAMS.ons;
const GENESIS_TS = 1_767_225_600;
const OBS = parseObs('1');
const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

/** mulberry32: a tiny deterministic PRNG so a failure is reproducible from its seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(seed: number, steps: number) {
  const rnd = prng(seed);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const h = await createHarness();
  open.push(h);
  const clock = { now: GENESIS_TS + 100 };
  const alice = makeWallet();
  h.produce([signedClaim(h, alice, clock.now)], { timestamp: clock.now });
  const wallets: TestWallet[] = [alice, makeWallet(), makeWallet(), makeWallet()];
  const world = () => h.chain.world;
  const nonceOf = (w: TestWallet) => world().getAccount(w.address)?.nonce ?? 0;
  clock.now += 1;
  const n0 = nonceOf(alice);
  h.produce(
    wallets.slice(1).map((w, i) =>
      h.sign(alice, TxType.PAYMENT, paymentBody(w.address, '2000'), { gas: expectedGas(parseObs('2000')), nonce: n0 + i, protocolTime: clock.now }),
    ),
    { timestamp: clock.now },
  );
  const names = ['alpha', 'beta', 'gamma'];
  clock.now += 1;
  // Register through the real executor, one name per wallet plus one extra.
  const regs = names.map((name, i) => {
    const w = wallets[i % wallets.length]!;
    return { w, name };
  });
  for (const { w, name } of regs) {
    clock.now += 1;
    h.produce([h.sign(w, TxType.ONS, onsBody(OnsOp.REGISTER, name, { fee: ONS.registrationFee }), { gas: expectedGas(ONS.registrationFee), protocolTime: clock.now })], { timestamp: clock.now });
  }

  const randomTx = (w: TestWallet, nonce: number): TxEnvelope => {
    const name = pick(names);
    const rec = world().s.names.get(name);
    const owner = rec ? wallets.find((x) => x.address === rec.owner) : undefined;
    const other = pick(wallets.filter((x) => x !== w));
    const offers = [...world().s.offers.values()];
    const anyOffer = offers.length && rnd() < 0.85 ? pick(offers) : undefined;
    const price = BigInt(1 + Math.floor(rnd() * 400)) * OBS;
    const mk = (op: MarketOp, extra: { amount?: bigint; counterparty?: string; offerId?: string } = {}, gas = 0n) =>
      h.sign(w, TxType.ONS_MARKET, marketBody(op, name, extra), { gas, nonce, protocolTime: clock.now });
    const ons = (op: OnsOp, extra: { address?: string; to?: string; fee?: bigint } = {}, gas = 0n) =>
      h.sign(w, TxType.ONS, onsBody(op, name, extra), { gas, nonce, protocolTime: clock.now });
    switch (Math.floor(rnd() * 16)) {
      case 0:
      case 1:
        return mk(MarketOp.LIST, { amount: price });
      case 2:
        return mk(MarketOp.UPDATE_PRICE, { amount: price });
      case 3:
        return mk(MarketOp.DELIST);
      case 4:
      case 5:
        return mk(MarketOp.BUY, { amount: rec?.listing && rnd() < 0.9 ? rec.listing.price : price, counterparty: (owner ?? other).address }, expectedGas(price));
      case 6:
      case 7:
      case 8:
        return mk(MarketOp.OFFER, { amount: price, counterparty: (owner ?? other).address }, expectedGas(price));
      case 9:
        return mk(MarketOp.ACCEPT_OFFER, { amount: anyOffer?.amount ?? price, offerId: anyOffer?.id ?? '00'.repeat(32) });
      case 10:
        return mk(MarketOp.DECLINE_OFFER, { offerId: anyOffer?.id ?? '00'.repeat(32) });
      case 11:
        return mk(MarketOp.CANCEL_OFFER, { offerId: anyOffer?.id ?? '00'.repeat(32) });
      case 12:
        return ons(OnsOp.TRANSFER, { to: other.address });
      case 13:
        return ons(rnd() < 0.5 ? OnsOp.ACCEPT_TRANSFER : OnsOp.CANCEL_TRANSFER);
      case 14:
        return ons(OnsOp.UPDATE_ADDRESS, { address: other.address });
      default:
        return h.sign(w, TxType.PAYMENT, paymentBody(other.address, '3'), { gas: expectedGas(parseObs('3')), nonce, protocolTime: clock.now });
    }
  };

  const checkInvariants = (label: string) => {
    const w = world();
    expect(w.verifySupplyInvariant(), `${label}: supply`).toMatchObject({ ok: true });
    let pending = 0n;
    const lockedBy = new Map<string, bigint>();
    for (const o of w.s.offers.values()) {
      if (o.status === 'PENDING') {
        pending += o.amount;
        lockedBy.set(o.maker, (lockedBy.get(o.maker) ?? 0n) + o.amount);
        const rec = w.s.names.get(o.name);
        expect(rec, `${label}: pending offer on a missing name`).toBeDefined();
        expect(rec!.owner, `${label}: pending offer outlived an ownership change`).toBe(o.owner);
        expect(rec!.listing, `${label}: a listed name holds a pending offer`).toBeUndefined();
        expect(o.resolvedAt, `${label}: pending offer has a resolution`).toBeUndefined();
        expect(o.maker).not.toBe(o.owner);
      } else {
        expect(o.resolvedAt, `${label}: terminal offer without resolution`).toBeDefined();
        expect(o.resolvedBy).toBeDefined();
      }
    }
    expect(w.s.market.escrowBalance, `${label}: escrow equals pending offers`).toBe(pending);
    for (const x of wallets) expect(w.escrowLockedBy(x.address), `${label}: lock per maker`).toBe(lockedBy.get(x.address) ?? 0n);
    for (const [name, rec] of w.s.names) {
      if (rec.listing) {
        expect(rec.listing.seller, `${label}: seller is the owner of ${name}`).toBe(rec.owner);
        expect(rec.listing.price).toBeGreaterThanOrEqual(ONS.market.minPriceSeals);
        expect(rec.transfer, `${label}: listed name with a transfer in flight`).toBeUndefined();
        expect(rec.recovery, `${label}: listed name with a recovery in flight`).toBeUndefined();
      }
    }
    for (const x of wallets) {
      const acc = w.getAccount(x.address);
      if (acc) expect(acc.balance).toBeGreaterThanOrEqual(0n);
    }
    // The committed state round-trips through a snapshot without changing its root.
    const again = WorldState.fromSnapshot(w.toSnapshot('00'.repeat(32)));
    expect(computeStateRoot(again.s), `${label}: snapshot round trip`).toBe(computeStateRoot(w.s));
  };

  let accepted = 0;
  const kinds = new Set<string>();
  for (let step = 0; step < steps; step += 1) {
    // Occasionally jump far enough to lapse offers (7 days) without ever passing the 1-year name term.
    clock.now += rnd() < 0.04 ? 3 * 24 * 3600 : 5;
    const sender = pick(wallets);
    const second = rnd() < 0.35 ? pick(wallets) : undefined;
    const txs: TxEnvelope[] = [randomTx(sender, nonceOf(sender))];
    if (second) txs.push(randomTx(second, second === sender ? nonceOf(sender) + 1 : nonceOf(second)));
    const before = computeStateRoot(world().s);
    let verdict = h.tryBlock(txs, { timestamp: clock.now });
    if (!verdict.accepted) {
      expect(computeStateRoot(world().s), `step ${step}: a rejected block changed state`).toBe(before);
      // A race: retry the transactions one at a time, as a producer would drop the loser.
      for (const tx of txs) {
        const beforeTx = computeStateRoot(world().s);
        verdict = h.tryBlock([tx], { timestamp: clock.now });
        if (!verdict.accepted) expect(computeStateRoot(world().s), `step ${step}: a rejected tx changed state`).toBe(beforeTx);
        if (verdict.accepted) {
          accepted += 1;
          kinds.add(String(TxType[tx.type]));
          checkInvariants(`seed ${seed} step ${step}`);
        }
      }
    } else {
      accepted += 1;
      for (const tx of txs) kinds.add(String(TxType[tx.type]));
      checkInvariants(`seed ${seed} step ${step}`);
    }
  }
  return { accepted, world: world() };
}

const totals = { sales: 0, offers: 0, listings: 0, status: {} as Record<string, number> };

describe('marketplace model-based invariants', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`seed ${seed}: supply, escrow, ownership and listing invariants hold over a random run`, async () => {
      const { accepted, world } = await run(seed, 140);
      expect(accepted).toBeGreaterThan(20);
      // The run really exercised the marketplace.
      const m = world.s.market;
      expect(m.offersMade + m.listingsCreated).toBeGreaterThan(0);
      const t = totals;
      t.sales += m.salesCount;
      t.offers += m.offersMade;
      t.listings += m.listingsCreated;
      for (const o of world.s.offers.values()) t.status[o.status] = (t.status[o.status] ?? 0) + 1;
    }, 120_000);
  }
  it('the seeds together reached sales and every offer outcome', () => {
    expect(totals.sales).toBeGreaterThan(0);
    for (const status of ['PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED', 'INVALIDATED']) {
      expect(totals.status[status] ?? 0, `no offer ever reached ${status}: ${JSON.stringify(totals)}`).toBeGreaterThan(0);
    }
  });
});
