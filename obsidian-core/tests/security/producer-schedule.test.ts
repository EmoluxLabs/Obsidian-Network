/**
 * The producer schedule (protocol 1.9.0): who may produce, what happens when somebody does not, and what time may and
 * may not do. Replaces the validator-mode suite: the subject is now the node registry, not a bonded validator set.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { blockHash } from '../../src/blockchain/block.js';
import { producerDecision, producerSetFor, proposerRound, compareTips, tipOf } from '../../src/consensus/schedule.js';
import { suspensionTerm } from '../../src/consensus/producers.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import {
  createHarness,
  forkParent,
  makeNode,
  makeWallet,
  nodeSigner,
  nodeStatement,
  type Harness,
  type TestNode,
} from '../helpers/harness.js';

const P = CONSENSUS_PARAMS.consensus.producers;
const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

function registerNodes(h: Harness, nodes: TestNode[]): void {
  for (let i = 0; i < nodes.length; i += P.maxRegistrationsPerBlock) {
    const batch = nodes.slice(i, i + P.maxRegistrationsPerBlock);
    const ts = h.chain.tip!.timestamp + SLOT;
    h.produce(batch.map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })), { timestamp: ts });
    for (const node of batch) h.signers.set(node.address, nodeSigner(node));
  }
}

async function scene(count: number): Promise<{ h: Harness; nodes: TestNode[] }> {
  const h = await createHarness();
  harnesses.push(h);
  const nodes = Array.from({ length: count }, () => makeNode(makeWallet()));
  registerNodes(h, nodes);
  return { h, nodes };
}

const onSchedule = (h: Harness) => h.chain.tip!.timestamp + SLOT;

describe('the founding state and admission', () => {
  it('is OPEN until the first registration, then names exactly the registered node (no validator window, no halt)', async () => {
    const h = await createHarness();
    harnesses.push(h);
    expect(producerDecision(h.chain.world, 1, 0, 1_767_225_700).kind).toBe('OPEN');
    // Any key may produce the founding blocks.
    h.produce([], { producer: makeWallet() });
    const node = makeNode(makeWallet());
    registerNodes(h, [node]);
    const decision = producerDecision(h.chain.world, h.chain.height + 1, 0, onSchedule(h));
    expect(decision).toMatchObject({ kind: 'SCHEDULED', producer: node.address, setSize: 1 });
    // The founding key is now an outsider.
    const outsider = h.tryBlock([], { timestamp: onSchedule(h), producer: makeWallet() });
    expect(outsider.accepted).toBe(false);
    expect(outsider.code).toBe(ErrCode.NOT_PRODUCER_TURN);
  });

  it('promotes a node to tier 1 only after it has existed on chain for maturityBlocks, and a new node never displaces mature ones', async () => {
    const { h, nodes } = await scene(2);
    expect(producerSetFor(h.chain.world, h.chain.height + 1, onSchedule(h)).tier).toBe('TIER2');
    while (h.chain.height < P.maturityBlocks + 3) h.produce([], { timestamp: onSchedule(h) });
    const mature = producerSetFor(h.chain.world, h.chain.height + 1, onSchedule(h));
    expect(mature.tier).toBe('TIER1');
    expect(mature.producers.sort()).toEqual(nodes.map((n) => n.address).sort());

    // A freshly minted identity is registered but does not enter the schedule until it matures.
    const newcomer = makeNode(makeWallet());
    registerNodes(h, [newcomer]);
    const after = producerSetFor(h.chain.world, h.chain.height + 1, onSchedule(h));
    expect(after.tier).toBe('TIER1');
    expect(after.producers).not.toContain(newcomer.address);
    expect(h.chain.world.registeredNodes()).toHaveLength(3);
  });

  it('does not depend on registration order or timing: the same nodes in any order give the same schedule', async () => {
    const nodes = Array.from({ length: 4 }, () => makeNode(makeWallet()));
    const orders = [nodes, [...nodes].reverse(), [nodes[2], nodes[0], nodes[3], nodes[1]]];
    const schedules: string[][] = [];
    for (const order of orders) {
      const h = await createHarness();
      harnesses.push(h);
      registerNodes(h, order);
      const ts = h.chain.tip!.timestamp + SLOT;
      schedules.push(
        [0, 1, 2, 3, 4, 5].map((round) => {
          const decision = producerDecision(h.chain.world, 40, round, ts);
          return decision.kind === 'SCHEDULED' ? decision.producer : 'OPEN';
        }),
      );
    }
    expect(schedules[1]).toEqual(schedules[0]);
    expect(schedules[2]).toEqual(schedules[0]);
    expect(new Set(schedules[0]).size).toBe(4);
  });

  it('a node that leaves and comes back restarts its maturity: churn buys no priority', async () => {
    const { h, nodes } = await scene(2);
    while (h.chain.height < P.maturityBlocks + 3) h.produce([], { timestamp: onSchedule(h) });
    const [node] = nodes;
    expect(producerSetFor(h.chain.world, h.chain.height + 1, onSchedule(h)).producers).toContain(node.address);
    const ts = onSchedule(h);
    const leave = nodeStatement(h, node, { op: NodeRegistryOp.DEREGISTER }, { protocolTime: ts });
    h.produce([leave], { timestamp: ts, producer: h.signers.get(producerDecisionAddress(h, ts)) });
    const ts2 = onSchedule(h);
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts2 })], { timestamp: ts2, producer: h.signers.get(producerDecisionAddress(h, ts2)) });
    const record = h.chain.world.node(node.nodeId)!;
    expect(record.registeredAtHeight).toBe(h.chain.height);
    expect(producerSetFor(h.chain.world, h.chain.height + 1, onSchedule(h)).producers).not.toContain(node.address);
  });
});

function producerDecisionAddress(h: Harness, ts: number): string {
  const decision = producerDecision(h.chain.world, h.chain.height + 1, proposerRound(h.chain.tip!.timestamp, ts), ts);
  if (decision.kind !== 'SCHEDULED') throw new Error('expected a scheduled producer');
  return decision.producer;
}

describe('skipped slots', () => {
  it('hands the slot to the next producer one interval later, deterministically, and refuses everybody else', async () => {
    const { h, nodes } = await scene(3);
    const head = h.chain.tip!;
    const height = head.height + 1;
    const set = producerSetFor(h.chain.world, height, head.timestamp + SLOT).producers;
    const round0 = set[height % 3];
    const round1 = set[(height + 1) % 3];
    const round2 = set[(height + 2) % 3];
    const byAddress = new Map(nodes.map((node) => [node.address, node]));

    // At round 0 only the round-0 producer is valid.
    const wrongAtRound0 = h.tryBlock([], { timestamp: head.timestamp + SLOT, producer: nodeSigner(byAddress.get(round1)!) });
    expect(wrongAtRound0.code).toBe(ErrCode.NOT_PRODUCER_TURN);
    // One interval later (round 1) the NEXT producer is valid and the skipped one is not.
    const lateTs = head.timestamp + 2 * SLOT;
    expect(proposerRound(head.timestamp, lateTs)).toBe(1);
    expect(h.tryBlock([], { timestamp: lateTs, producer: nodeSigner(byAddress.get(round0)!) }).code).toBe(ErrCode.NOT_PRODUCER_TURN);
    expect(h.tryBlock([], { timestamp: lateTs, producer: nodeSigner(byAddress.get(round2)!) }).code).toBe(ErrCode.NOT_PRODUCER_TURN);
    h.produce([], { timestamp: lateTs, producer: nodeSigner(byAddress.get(round1)!) });
    expect(h.chain.tip!.producer).toBe(round1);
    // The skipped node is recorded as having missed exactly one slot; the one who produced is clean.
    expect(h.chain.world.nodeByProducer(round0)!.missedSlots).toBe(1);
    expect(h.chain.world.nodeByProducer(round1)!.missedSlots).toBe(0);
  });

  it('suspends a node after three consecutive misses, and drops it from tier 1', async () => {
    const { h, nodes } = await scene(2);
    while (h.chain.height < P.maturityBlocks + 3) h.produce([], { timestamp: onSchedule(h) });
    const [x, y] = nodes;
    const bySigner = new Map(nodes.map((n) => [n.address, n]));
    // y produces everything: on X's slots it does so one round late (X misses), on its own slots on time.
    let guard = 0;
    while (h.chain.world.node(x.nodeId)!.suspendedUntil === undefined && guard < 40) {
      guard += 1;
      const head = h.chain.tip!;
      const onTime = head.timestamp + SLOT;
      const first = producerDecision(h.chain.world, head.height + 1, 0, onTime);
      const ts = first.kind === 'SCHEDULED' && first.producer === y.address ? onTime : head.timestamp + 2 * SLOT;
      h.produce([], { timestamp: ts, producer: nodeSigner(bySigner.get(y.address)!) });
    }
    const suspended = h.chain.world.node(x.nodeId)!;
    expect(suspended.suspendedUntil).toBeDefined();
    expect(suspended.suspensions).toBe(1);
    const head = h.chain.tip!;
    expect(suspended.suspendedUntil! - head.timestamp).toBeLessThanOrEqual(P.baseSuspensionSeconds);
    expect(producerSetFor(h.chain.world, head.height + 1, head.timestamp + SLOT).producers).toEqual([y.address]);
    // And x cannot produce while suspended.
    const refused = h.tryBlock([], { timestamp: head.timestamp + SLOT, producer: nodeSigner(x) });
    expect(refused.code).toBe(ErrCode.NOT_PRODUCER_TURN);
    // Suspension is a duration of protocol time: it lapses on its own and the node is back in tier 1.
    const lapsed = suspended.suspendedUntil! + 1;
    expect(producerSetFor(h.chain.world, head.height + 1, lapsed).producers.sort()).toEqual([x.address, y.address].sort());
  });

  it('doubles the suspension term on repeats and caps it', () => {
    expect(suspensionTerm(1)).toBe(P.baseSuspensionSeconds);
    expect(suspensionTerm(2)).toBe(P.baseSuspensionSeconds * 2);
    expect(suspensionTerm(3)).toBe(P.baseSuspensionSeconds * 4);
    expect(suspensionTerm(99)).toBe(P.maxSuspensionSeconds);
    for (let level = 1; level < 40; level += 1) expect(suspensionTerm(level + 1)).toBeGreaterThanOrEqual(suspensionTerm(level));
  });

  it('recovery: when every mature node has gone stale the schedule falls back to the registered set and the chain keeps going', async () => {
    const { h, nodes } = await scene(2);
    while (h.chain.height < P.maturityBlocks + 3) h.produce([], { timestamp: onSchedule(h) });
    const farFuture = h.chain.tip!.timestamp + P.activityWindowSeconds + 3600;
    const set = producerSetFor(h.chain.world, h.chain.height + 1, farFuture);
    expect(set.tier).toBe('TIER2');
    expect(set.producers.sort()).toEqual(nodes.map((n) => n.address).sort());
  });
});

describe('timestamps: time is a rule, not a request', () => {
  it('refuses a block at or before its parent, a block below median time past, and a block from the future', async () => {
    const { h, nodes } = await scene(1);
    const signer = nodeSigner(nodes[0]);
    for (let i = 0; i < 12; i += 1) h.produce([], { timestamp: onSchedule(h), producer: signer });
    const head = h.chain.tip!;

    const same = h.tryBlock([], { timestamp: head.timestamp, producer: signer });
    expect(same.accepted).toBe(false);
    const earlier = h.tryBlock([], { timestamp: head.timestamp - 3600, producer: signer });
    expect(earlier.accepted).toBe(false);
    // Far beyond now + drift: a producer cannot claim a later round (or a later reward period) than real time supports.
    const future = h.tryBlock([], { timestamp: Math.floor(Date.now() / 1000) + CONSENSUS_PARAMS.block.maxFutureDriftSeconds + 600, producer: signer });
    expect(future.accepted).toBe(false);
    expect(h.chain.tip!.hash).toBe(head.hash);
  });
});

describe('duplicate blocks and fork choice', () => {
  it('ignores a block it already has, and never lets a replay change the head', async () => {
    const { h, nodes } = await scene(1);
    const block = h.produce([], { timestamp: onSchedule(h), producer: nodeSigner(nodes[0]) });
    const tip = h.chain.tip!.hash;
    const replay = h.chain.addBlock(block);
    expect(replay.accepted).toBe(false);
    expect(replay.code).toBe(ErrCode.DUPLICATE_BLOCK);
    expect(h.chain.tip!.hash).toBe(tip);
  });

  it('chooses between two valid siblings by the deterministic tie-break, identically on every node', async () => {
    const { h, nodes } = await scene(1);
    const signer = nodeSigner(nodes[0]);
    h.produce([], { timestamp: onSchedule(h), producer: signer });
    const parent = forkParent(h, h.chain.height - 1);
    const head = h.chain.tip!;
    // Two competing blocks for one height by the one scheduled node, a second apart: both valid, equal weight.
    const a = h.makeBlockOn(parent, [], { timestamp: head.timestamp, producer: signer }).block;
    const b = h.makeBlockOn(parent, [], { timestamp: head.timestamp + 1, producer: signer }).block;
    const candidates = [a, b].filter((block) => blockHash(block.header) !== head.hash);
    for (const block of candidates) h.chain.addBlock(block);
    const all = [h.chain.store.getBlockByHash(head.hash)!, ...candidates];
    const lowest = all.map((block) => tipOf(block)).sort((x, y) => compareTips(y, x))[0];
    expect(h.chain.tip!.hash).toBe(lowest.hash);

    // A second node that sees the same candidates in the opposite order lands on the same head.
    const other = await createHarness({ producer: h.producer });
    harnesses.push(other);
    for (let height = 1; height < head.height; height += 1) {
      const canonical = h.chain.store.getBlockByHash(h.chain.store.getCanonicalHashAtHeight(height)!)!;
      expect(other.chain.addBlock(canonical).accepted).toBe(true);
    }
    for (const block of [...all].reverse()) other.chain.addBlock(block);
    expect(other.chain.tip!.hash).toBe(h.chain.tip!.hash);
  });
});
