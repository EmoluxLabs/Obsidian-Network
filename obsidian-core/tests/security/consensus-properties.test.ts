/**
 * Consensus properties: checked over many generated cases instead of a handful of hand-picked ones.
 *
 * Seeded and deterministic (no new dependency, no wall clock): a failure names its seed and reproduces exactly.
 * What this is NOT: a proof, a model check, or an independent verification of the consensus protocol. It samples the
 * real state machine; docs/consensus-assumptions.md says what is assumed and what no test here establishes.
 *
 *  1. Quorum arithmetic: any two finality quorums share more than a third of the validators; a set with the maximum
 *     tolerated faults can still form a quorum; the threshold is strictly more than two thirds.
 *  2. State-machine determinism: two independent nodes that apply the same blocks end on the same state root.
 *  3. Invalid blocks never change state: a rejected block leaves the root, the tip, the supply and the balances as
 *     they were, whatever shape the invalidity takes.
 *  4. Supply conservation holds after every accepted block.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { finalityQuorum } from '../../src/consensus/finality.js';
import { parseObs } from '../../src/protocol/amount.js';
import { TxType, type Block } from '../../src/protocol/types.js';
import { encodePaymentBody } from '../../src/transactions/executors/payment.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { issueMiningGateCertificate } from '../../src/mining/gate.js';
import { computeClaimId, encodeMiningBody } from '../../src/transactions/executors/mining.js';
import { FOREIGN_GATE_ISSUER, advance, createHarness, makeWallet, signedClaim, signedPayment, type Harness, type TestWallet } from '../helpers/harness.js';

/** xorshift32: tiny, deterministic, good enough to drive a generator. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(items: T[]): T => items[Math.floor(next() * items.length)]! };
}

describe('finality quorum arithmetic (n = 1 .. 3000)', () => {
  it('is strictly more than two thirds, never more than n, and any two quorums overlap in more than a third of the set', () => {
    for (let n = 1; n <= 3000; n += 1) {
      const q = finalityQuorum(n);
      expect(q, `n=${n}`).toBeLessThanOrEqual(n);
      expect(3 * q, `n=${n}`).toBeGreaterThan(2 * n);
      const overlap = 2 * q - n; // the fewest validators two different quorums must share
      expect(3 * overlap, `n=${n}`).toBeGreaterThan(n);
      // so conflicting finalization needs more than n/3 validators to have signed both: that is the accountable-safety bound
    }
  });

  it('a set with the largest tolerable number of faulty validators (f < n/3) can still finalize', () => {
    for (let n = 1; n <= 3000; n += 1) {
      const f = Math.floor((n - 1) / 3);
      expect(n - f, `n=${n}`).toBeGreaterThanOrEqual(finalityQuorum(n));
      // and one more fault than that can stall it (liveness is genuinely lost, which the docs say)
      if (n >= 4) expect(n - (f + 1) < finalityQuorum(n) || 3 * (f + 1) >= n, `n=${n}`).toBe(true);
    }
  });

  it('is monotone: a bigger set never needs fewer votes', () => {
    for (let n = 1; n < 3000; n += 1) expect(finalityQuorum(n + 1)).toBeGreaterThanOrEqual(finalityQuorum(n));
  });

  it('rejects nonsense sizes by returning no quorum, never a quorum of NaN or a negative one', () => {
    for (const bad of [0, -1, -100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) expect(finalityQuorum(bad)).toBe(0);
  });
});

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
const node = async (): Promise<Harness> => {
  const h = await createHarness();
  open.push(h);
  return h;
};

const balances = (h: Harness, wallets: TestWallet[]) => wallets.map((w) => h.chain.world.getAccount(w.address)?.balance ?? 0n);
const snapshot = (h: Harness, wallets: TestWallet[]) => ({
  root: h.chain.stateRoot,
  tip: h.chain.tip!.hash,
  height: h.chain.height,
  supply: h.chain.world.s.metrics.totalSupply,
  balances: balances(h, wallets),
});

describe('state machine: determinism, rejection leaves no trace, supply is conserved (seeded)', () => {
  for (const seed of [20261012, 7, 424242]) {
    it(`seed ${seed}: 40 random steps, valid and invalid, on two independent nodes`, async () => {
      const random = rng(seed);
      const a = await node();
      const b = await node();
      const wallets = Array.from({ length: 5 }, () => makeWallet());

      // The first valid claim funds a wallet and designates it the treasury; then spread some funds around.
      a.produce([signedClaim(a, wallets[0]!)]);
      advance(a, 1);
      // Give every wallet something to spend, so the generator can pick any of them.
      a.produce(wallets.slice(1).map((w) => signedPayment(a, wallets[0]!, w.address, parseObs('50'), { nonce: a.chain.world.getAccount(wallets[0]!.address)!.nonce + wallets.slice(1).indexOf(w) })));

      let rejected = 0;
      for (let step = 0; step < 40; step += 1) {
        const funded = wallets.filter((w) => (a.chain.world.getAccount(w.address)?.balance ?? 0n) > parseObs('20'));
        const from = random.pick(funded);
        const to = random.pick(wallets.filter((w) => w !== from));
        const balance = a.chain.world.getAccount(from.address)!.balance;
        const kind = random.int(8);
        const amount = parseObs(String(1 + random.int(5)));
        const before = snapshot(a, wallets);

        let txs;
        let valid = false;
        switch (kind) {
          case 0: // wrong nonce (future)
            txs = [signedPayment(a, from, to.address, amount, { nonce: (a.chain.world.getAccount(from.address)?.nonce ?? 0) + 3 })];
            break;
          case 1: // more than the balance
            txs = [signedPayment(a, from, to.address, balance + parseObs('1'))];
            break;
          case 2: // gas that does not match the amount
            txs = [a.sign(from, TxType.PAYMENT, encodePaymentBody({ to: to.address, amount }), { gas: expectedGas(amount) + 1n })];
            break;
          case 3: // the same transaction twice in one block
            {
              const tx = signedPayment(a, from, to.address, amount);
              txs = [tx, tx];
            }
            break;
          case 4: // an expired transaction
            txs = [a.sign(from, TxType.PAYMENT, encodePaymentBody({ to: to.address, amount }), { gas: expectedGas(amount), validUntil: a.chain.protocolTime - 10 })];
            break;
          case 5: // a claim certified by a key the chain never committed
            {
              const claimId = computeClaimId(a.net.chainId, from.address, 1, 0);
              const gate = issueMiningGateCertificate(FOREIGN_GATE_ISSUER.privateKey, FOREIGN_GATE_ISSUER.publicKey, { networkId: a.net.networkId, chainId: a.net.chainId, address: from.address, claimId }, a.chain.protocolTime);
              txs = [a.sign(from, TxType.MINING_CLAIM, encodeMiningBody({ claimId, claimSequence: 1, gate }), { gas: 0n })];
            }
            break;
          default: // a valid payment
            txs = [signedPayment(a, from, to.address, amount)];
            valid = true;
        }

        const outcome = a.tryBlock(txs, { simulate: valid });
        if (valid) {
          expect(outcome.accepted, `seed ${seed} step ${step}: ${outcome.message}`).toBe(true);
        } else {
          rejected += 1;
          // A block built without simulation also fails on its roots; that would prove nothing about the transaction.
          expect(outcome.message, `seed ${seed} step ${step} kind ${kind}`).not.toMatch(/state root mismatch|root/i);
          expect(outcome.accepted, `seed ${seed} step ${step} kind ${kind} should be refused`).toBe(false);
          // A refused block leaves no trace at all.
          const after = snapshot(a, wallets);
          expect(after, `seed ${seed} step ${step} kind ${kind}`).toEqual(before);
        }
        // Conservation after every step, accepted or not.
        expect(a.chain.world.verifySupplyInvariant().ok, `seed ${seed} step ${step}`).toBe(true);
      }
      expect(rejected).toBeGreaterThan(5); // the generator really did produce invalid cases

      // An independent node fed the same canonical blocks, in order, lands on the same everything.
      for (let height = 1; height <= a.chain.height; height += 1) {
        const block = a.chain.store.getBlockByHash(a.chain.store.getCanonicalHashAtHeight(height)!)!;
        expect(b.chain.addBlock(block).accepted, `replay height ${height}`).toBe(true);
      }
      expect(b.chain.tip!.hash).toBe(a.chain.tip!.hash);
      expect(b.chain.stateRoot).toBe(a.chain.stateRoot);
      expect(balances(b, wallets)).toEqual(balances(a, wallets));
      expect(b.chain.world.verifySupplyInvariant().ok).toBe(true);
    });
  }
});

describe('a block that is not valid for any reason never moves the tip or the state (targeted shapes)', () => {
  it('wrong parent, wrong height, tampered state root, tampered transactions, foreign chain id', async () => {
    const h = await node();
    advance(h, 2);
    const wallet = makeWallet();
    const good = h.makeBlock([signedClaim(h, wallet)]);
    const before = { root: h.chain.stateRoot, tip: h.chain.tip!.hash, supply: h.chain.world.s.metrics.totalSupply };
    const mutations: Array<[string, Block]> = [
      ['wrong parent', { ...good, header: { ...good.header, prevHash: '00'.repeat(32) } }],
      ['wrong height', { ...good, header: { ...good.header, height: good.header.height + 5 } }],
      ['tampered state root', { ...good, header: { ...good.header, stateRoot: 'ab'.repeat(32) } }],
      ['tampered tx root', { ...good, header: { ...good.header, txRoot: 'cd'.repeat(32) } }],
      ['foreign chain id', { ...good, header: { ...good.header, chainId: good.header.chainId + 1 } }],
      ['transactions removed', { ...good, transactions: [] }],
    ];
    for (const [label, block] of mutations) {
      const verdict = h.chain.addBlock(block);
      expect(verdict.accepted, label).toBe(false);
      expect(h.chain.stateRoot, label).toBe(before.root);
      expect(h.chain.tip!.hash, label).toBe(before.tip);
      expect(h.chain.world.s.metrics.totalSupply, label).toBe(before.supply);
    }
    // And the untampered one is still fine afterwards: the refusals did not poison anything.
    expect(h.chain.addBlock(good).accepted).toBe(true);
  });
});
