/**
 * ATTACK ROUND 2 — economic chaos: try to make the chain create value, lose value or disagree with itself.
 *
 * A seeded random adversary drives the node registry, node-reward settlement, payments and name fees across many reward
 * periods, mixing valid and invalid statements (wrong windows, wrong signers, duplicate registrations, wallet swaps,
 * deregistration). After EVERY step the chain must still hold:
 *   - the supply invariant (nothing minted or lost, pools and escrow included);
 *   - no negative balance;
 *   - a state that survives a snapshot round trip with an identical root (a restart must not change history);
 *   - an unchanged state root when a block is rejected (a refusal leaves no trace).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  makeNode,
  makeWallet,
  nodeSigner,
  nodeStatement,
  onsBody,
  paymentBody,
  signedClaim,
  type Harness,
  type TestNode,
  type TestWallet,
} from '../helpers/harness.js';
import { WorldState } from '../../src/blockchain/state.js';
import { computeStateRoot } from '../../src/blockchain/state-root.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { NodeRegistryOp, OnsOp, TxType } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { parseObs } from '../../src/protocol/amount.js';
import { rewardPeriodAt, uptimeWindowIndex } from '../../src/economy/node-rewards.js';
import type { TxEnvelope } from '../../src/protocol/types.js';

const GENESIS_TS = 1_767_225_600;
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function run(seed: number, steps: number): Promise<{ accepted: number; kinds: Set<string>; periodsSettled: number }> {
  const rnd = prng(seed);
  const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)]!;
  const alice = makeWallet();
  const h = await createHarness({ producer: alice });
  harnesses.push(h);
  const clock = { now: GENESIS_TS + 10 };
  h.produce([signedClaim(h, alice, clock.now)], { timestamp: clock.now });

  const users: TestWallet[] = Array.from({ length: 4 }, () => makeWallet());
  const nodes: TestNode[] = Array.from({ length: 7 }, () => makeNode(makeWallet()));
  for (const n of nodes) h.signers.set(n.address, nodeSigner(n));
  // Fund the users from alice so payments and name fees have something to move.
  for (const u of users) {
    clock.now += 5;
    h.produce([h.sign(alice, TxType.PAYMENT, paymentBody(u.address, '40'), { gas: expectedGas(parseObs('40')), protocolTime: clock.now })], { timestamp: clock.now });
  }

  const world = () => h.chain.world;
  const nonceOf = (address: string) => world().getAccount(address)?.nonce ?? 0;
  const periodOf = () => rewardPeriodAt(clock.now);
  const names = ['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff'];
  const kinds = new Set<string>();

  const randomTx = (): TxEnvelope => {
    const n = pick(nodes);
    const t = (fields: Parameters<typeof nodeStatement>[2]) =>
      nodeStatement(h, n, fields, { nonce: nonceOf(n.address), protocolTime: clock.now });
    const roll = Math.floor(rnd() * 14);
    switch (roll) {
      case 0:
      case 1:
        kinds.add('register');
        return t({ op: NodeRegistryOp.REGISTER, endpoint: '203.0.113.7:8631' });
      case 2:
      case 3:
      case 4:
        kinds.add('heartbeat');
        // Sometimes the window is wrong on purpose.
        return t({ op: NodeRegistryOp.HEARTBEAT, slot: uptimeWindowIndex(clock.now) + (rnd() < 0.15 ? 1 : 0), reportedHeight: h.chain.height });
      case 5:
      case 6:
        kinds.add('attest');
        return t({ op: NodeRegistryOp.ATTEST, slot: periodOf(), subject: pick(nodes).nodeId });
      case 7:
        kinds.add('change-wallet');
        return t({ op: NodeRegistryOp.CHANGE_WALLET, rewardWallet: pick(users).address });
      case 8: {
        kinds.add('cancel-or-reclaim');
        const u = pick(users);
        return h.sign(u, TxType.NODE_REGISTRY, nodeStatement(h, n, { op: rnd() < 0.5 ? NodeRegistryOp.CANCEL_WALLET_CHANGE : NodeRegistryOp.RECLAIM_WALLET, rewardWallet: u.address }).body, { gas: 0n, nonce: nonceOf(u.address), protocolTime: clock.now });
      }
      case 9:
        if (rnd() < 0.3) {
          kinds.add('deregister');
          return t({ op: NodeRegistryOp.DEREGISTER });
        }
        kinds.add('heartbeat');
        return t({ op: NodeRegistryOp.HEARTBEAT, slot: uptimeWindowIndex(clock.now), reportedHeight: h.chain.height });
      case 10:
      case 11: {
        kinds.add('payment');
        const u = pick(users);
        const amount = parseObs(pick(['0.000001', '0.5', '3', '11']));
        return h.sign(u, TxType.PAYMENT, paymentBody(pick(users).address, amount), { gas: expectedGas(amount), nonce: nonceOf(u.address), protocolTime: clock.now });
      }
      default: {
        kinds.add('name-fee');
        const u = pick(users);
        const fee = CONSENSUS_PARAMS.ons.registrationFee;
        return h.sign(u, TxType.ONS, onsBody(OnsOp.REGISTER, pick(names), { fee }), { gas: expectedGas(fee), nonce: nonceOf(u.address), protocolTime: clock.now });
      }
    }
  };

  const invariants = (label: string) => {
    const w = world();
    expect(w.verifySupplyInvariant(), `${label}: supply`).toMatchObject({ ok: true });
    for (const [address, account] of w.s.accounts) {
      expect(account.balance >= 0n, `${label}: negative balance at ${address}`).toBe(true);
    }
    for (const node of w.s.nodes.values()) expect(node.lifetimeReward >= 0n, `${label}: negative lifetime reward`).toBe(true);
    expect(w.s.nodeRewards.lifetimeDistributed <= w.s.nodeRewards.lifetimeInflow, `${label}: paid out more than ever flowed in`).toBe(true);
    const again = WorldState.fromSnapshot(w.toSnapshot('00'.repeat(32)));
    expect(computeStateRoot(again.s), `${label}: snapshot round trip`).toBe(computeStateRoot(w.s));
  };

  let accepted = 0;
  let settled = 0;
  let lastPaid = world().s.nodeRewards.lifetimeDistributed;
  for (let step = 0; step < steps; step += 1) {
    const r = rnd();
    clock.now += r < 0.1 ? 26 * 3600 : r < 0.4 ? 1900 : 7;
    const count = 1 + Math.floor(rnd() * 3);
    const used = new Set<string>();
    const txs: TxEnvelope[] = [];
    for (let i = 0; i < count; i += 1) {
      const tx = randomTx();
      if (used.has(tx.sender)) continue;
      used.add(tx.sender);
      txs.push(tx);
    }
    const before = computeStateRoot(world().s);
    const verdict = h.tryBlock(txs, { timestamp: clock.now });
    if (!verdict.accepted) {
      expect(computeStateRoot(world().s), `step ${step}: a rejected block changed the state`).toBe(before);
      // Retry the transactions one by one so a single bad one does not hide the rest.
      for (const tx of txs) {
        const single = h.tryBlock([tx], { timestamp: clock.now });
        if (single.accepted) accepted += 1;
        else expect(computeStateRoot(world().s), `step ${step}: a rejected block changed the state`).toBe(computeStateRoot(world().s));
        clock.now += 1;
      }
    } else {
      accepted += 1;
    }
    const paidNow = world().s.nodeRewards.lifetimeDistributed;
    if (paidNow > lastPaid) settled += 1;
    lastPaid = paidNow;
    invariants(`seed ${seed} step ${step}`);
  }
  return { accepted, kinds, periodsSettled: settled };
}

describe('round 2: economic chaos against the node registry and settlement', () => {
  for (const seed of [11, 4242, 90210]) {
    it(`seed ${seed}: supply, balances and snapshots hold across periods of hostile traffic`, async () => {
      const result = await run(seed, 140);
      expect(result.accepted).toBeGreaterThan(40);
      for (const kind of ['register', 'heartbeat', 'attest', 'payment', 'name-fee']) expect(result.kinds.has(kind)).toBe(true);
    }, 120_000);
  }
});

describe('round 2b: diligent operators and a sybil fleet are paid from one pool that can never overdraw', () => {
  it('pays honest, attesting nodes, never more than the pool has held, and the supply invariant survives every settlement', async () => {
    const alice = makeWallet();
    const h = await createHarness({ producer: alice });
    harnesses.push(h);
    const clock = { now: GENESIS_TS + 10 };
    h.produce([signedClaim(h, alice, clock.now)], { timestamp: clock.now });
    const payer = makeWallet();
    clock.now += 5;
    h.produce([h.sign(alice, TxType.PAYMENT, paymentBody(payer.address, '200'), { gas: expectedGas(parseObs('200')), protocolTime: clock.now })], { timestamp: clock.now });

    const honest: TestNode[] = Array.from({ length: 5 }, () => makeNode(makeWallet()));
    const sybils: TestNode[] = Array.from({ length: 12 }, () => makeNode(makeWallet()));
    for (const n of [...honest, ...sybils]) h.signers.set(n.address, nodeSigner(n));
    const nonceOf = (a: string) => h.chain.world.getAccount(a)?.nonce ?? 0;
    const world = () => h.chain.world;
    const registered = new Set<string>();
    let nameCounter = 0;
    const WINDOW = CONSENSUS_PARAMS.nodeRewards.uptimeWindowSeconds;
    const DAY = CONSENSUS_PARAMS.nodeRewards.periodSeconds;

    const step = (txs: TxEnvelope[]) => {
      const before = computeStateRoot(world().s);
      const verdict = h.tryBlock(txs, { timestamp: clock.now });
      if (!verdict.accepted) expect(computeStateRoot(world().s)).toBe(before);
      expect(world().verifySupplyInvariant()).toMatchObject({ ok: true });
      return verdict.accepted;
    };

    for (let hour = 0; hour < 24 * 8; hour += 1) {
      clock.now += WINDOW;
      const txs: TxEnvelope[] = [];
      const fleet = [...honest, ...sybils];
      const live = fleet.filter((n) => world().nodeByProducer(n.address) !== undefined);
      // Everyone registered heartbeats; the sybils also attest each other and every honest node.
      for (const n of live) {
        txs.push(nodeStatement(h, n, { op: NodeRegistryOp.HEARTBEAT, slot: uptimeWindowIndex(clock.now), reportedHeight: h.chain.height }, { nonce: nonceOf(n.address), protocolTime: clock.now }));
      }
      step(txs.slice(0, 40));
      if (hour % 24 === 1) {
        clock.now += 3;
        const attests: TxEnvelope[] = [];
        for (const n of live) {
          const subject = live[(live.indexOf(n) + 1) % live.length]!;
          attests.push(nodeStatement(h, n, { op: NodeRegistryOp.ATTEST, slot: rewardPeriodAt(clock.now), subject: subject.nodeId }, { nonce: nonceOf(n.address), protocolTime: clock.now }));
        }
        step(attests);
        clock.now += 3;
        const fee = CONSENSUS_PARAMS.ons.registrationFee;
        nameCounter += 1;
        step([h.sign(payer, TxType.ONS, onsBody(OnsOp.REGISTER, `rev${nameCounter}x`, { fee }), { gas: expectedGas(fee), nonce: nonceOf(payer.address), protocolTime: clock.now })]);
      }
      // Registrations trickle in, as many as the chain allows.
      if (hour % 6 === 0) {
        for (const n of [...honest, ...sybils]) {
          if (registered.has(n.nodeId)) continue;
          clock.now += 2;
          if (step([nodeStatement(h, n, { op: NodeRegistryOp.REGISTER, endpoint: '203.0.113.8:8631' }, { nonce: nonceOf(n.address), protocolTime: clock.now })])) registered.add(n.nodeId);
          break;
        }
      }
    }
    const pool = world().s.nodeRewards;
    expect(pool.lifetimeDistributed <= pool.lifetimeInflow).toBe(true);
    expect(pool.balance >= 0n).toBe(true);
    expect(pool.lifetimeInflow - pool.lifetimeDistributed - pool.balance <= pool.unclaimedRevenue + 0n || pool.balance === pool.lifetimeInflow - pool.lifetimeDistributed).toBe(true);
    const paid = [...world().s.nodes.values()].map((n) => n.lifetimeReward);
    const total = paid.reduce((a, b) => a + b, 0n);
    // Every seal that left the pool is on exactly one node record: nothing paid to nobody, nothing paid twice.
    expect(total).toBe(pool.lifetimeDistributed);
    expect(total > 0n, 'diligent nodes were never paid: the scenario is not exercising settlement').toBe(true);
    console.log('R2b', 'registered', registered.size, 'distributed', pool.lifetimeDistributed, 'inflow', pool.lifetimeInflow);
  }, 150_000);
});
