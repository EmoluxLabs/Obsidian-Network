/**
 * Derived finality — producer-diversity checkpoints (protocol 1.9.0), against a real chain.
 *
 * There are no votes to forge and no certificates to verify, so the properties that matter are properties of chain
 * history: finality advances only when enough distinct, established producers have built on a block; it is a value in
 * consensus state, so every node (and every replay) computes the same number; it never moves backwards; it survives a
 * restart; and a branch that omits the finalized prefix is refused whatever its weight.
 *
 * Blocks are placed at explicit protocol timestamps, exactly one target interval apart (round 0), in the chain's real
 * validity window (after genesis, before now + drift), so a few hundred blocks run in a second or two.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { blockHash } from '../../src/blockchain/block.js';
import { ChainManager } from '../../src/blockchain/chain.js';
import { producerDecision } from '../../src/consensus/schedule.js';
import { finalityQuorum, finalityReport, finalityWindow } from '../../src/consensus/finality.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
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

const F = CONSENSUS_PARAMS.consensus.finality;
const P = CONSENSUS_PARAMS.consensus.producers;
const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const harnesses: Harness[] = [];

afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

/** One block on schedule: exactly one target interval after its parent, signed by whoever the schedule names. */
function step(h: Harness, txs: Parameters<Harness['produce']>[0] = []): void {
  h.produce(txs, { timestamp: h.chain.tip!.timestamp + SLOT });
}

/** Register `count` nodes (at most maxRegistrationsPerBlock per block) and return them. */
function registerFleet(h: Harness, count: number): TestNode[] {
  const nodes = Array.from({ length: count }, () => makeNode(makeWallet()));
  for (let i = 0; i < nodes.length; i += P.maxRegistrationsPerBlock) {
    const ts = h.chain.tip!.timestamp + SLOT;
    const batch = nodes.slice(i, i + P.maxRegistrationsPerBlock);
    h.produce(
      batch.map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })),
      { timestamp: ts },
    );
    for (const node of batch) h.signers.set(node.address, nodeSigner(node));
  }
  return nodes;
}

async function fleetHarness(count: number): Promise<{ h: Harness; nodes: TestNode[] }> {
  const h = await createHarness();
  harnesses.push(h);
  const nodes = registerFleet(h, count);
  return { h, nodes };
}

/** Produce blocks until the head is `height`. */
function growTo(h: Harness, height: number, onBlock?: () => void): void {
  while (h.chain.height < height) {
    step(h);
    onBlock?.();
  }
}

const firstFinalizableHead = (registeredAt: number, n: number) => registeredAt + P.maturityBlocks + finalityWindow(n);

describe('finality arithmetic', () => {
  it('needs strictly more than two thirds of n, and a window that scales with n inside its bounds', () => {
    expect(finalityQuorum(0)).toBe(0);
    expect([3, 4, 5, 6, 7, 9, 10, 30].map(finalityQuorum)).toEqual([3, 3, 4, 5, 5, 7, 7, 21]);
    for (let n = 1; n <= 200; n += 1) {
      // strictly more than 2/3: 3q > 2n, and q is the least such integer
      const q = finalityQuorum(n);
      expect(3 * q).toBeGreaterThan(2 * n);
      expect(3 * (q - 1)).toBeLessThanOrEqual(2 * n);
      expect(q).toBeLessThanOrEqual(n);
    }
    expect(finalityWindow(1)).toBe(F.windowMin);
    expect(finalityWindow(10_000)).toBe(F.windowMax);
    expect(finalityWindow(20)).toBe(Math.min(F.windowMax, Math.max(F.windowMin, F.windowPerProducer * 20)));
  });
});

describe('finality on a real chain', () => {
  it('starts at genesis with finalized height 0 and says finality is unavailable with no producers', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const report = h.chain.finalityStatus();
    expect(report.finalizedHeight).toBe(0);
    expect(report.available).toBe(false);
    expect(report.reason).toMatch(/unavailable/);
    expect(report.model).toBe('PRODUCER_DIVERSITY_CHECKPOINT');
  });

  it('reports finality as unavailable (and finalizes nothing) with fewer than minProducers nodes', async () => {
    const { h } = await fleetHarness(F.minProducers - 1);
    growTo(h, P.maturityBlocks + finalityWindow(F.minProducers) + 40);
    expect(h.chain.world.s.finality.finalizedHeight).toBe(0);
    const report = h.chain.finalityStatus();
    expect(report.available).toBe(false);
    expect(report.eligibleProducers).toBeLessThan(F.minProducers);
  });

  it('advances the checkpoint once three established producers have built on a block, never before maturity', async () => {
    const { h, nodes } = await fleetHarness(3);
    const registeredAt = Math.max(...nodes.map((node) => h.chain.world.node(node.nodeId)!.registeredAtHeight));
    const firstHead = firstFinalizableHead(registeredAt, 3);
    const seen: number[] = [];
    growTo(h, firstHead - 1, () => seen.push(h.chain.world.s.finality.finalizedHeight));
    // Not mature yet: nothing can be final, whatever the block count.
    expect(h.chain.world.s.finality.finalizedHeight).toBe(0);

    growTo(h, firstHead + 40, () => seen.push(h.chain.world.s.finality.finalizedHeight));
    const fin = h.chain.world.s.finality;
    expect(fin.finalizedHeight).toBeGreaterThan(0);
    // Checkpoint = head - window while the quorum holds, and the stored hash is the canonical block at that height.
    expect(fin.finalizedHeight).toBe(h.chain.height - finalityWindow(3));
    expect(fin.finalizedHash).toBe(h.chain.store.getCanonicalHashAtHeight(fin.finalizedHeight));
    // Monotonic across the whole run.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    const report = h.chain.finalityStatus();
    expect(report.available).toBe(true);
    expect(report.lag).toBe(finalityWindow(3));
    expect(report.finalizedHash).toBe(fin.finalizedHash);
  });

  it('a single producer, however many blocks it makes, cannot finalize anything', async () => {
    const { h, nodes } = await fleetHarness(3);
    const attacker = nodes[0];
    // Only the attacker ever produces: each block is stamped at the first round whose scheduled producer is the attacker.
    const target = P.maturityBlocks + finalityWindow(3) + 60;
    while (h.chain.height < target) {
      const head = h.chain.tip!;
      let placed = false;
      for (let round = 0; round < 6 && !placed; round += 1) {
        const timestamp = head.timestamp + SLOT * (round + 1);
        const decision = producerDecision(h.chain.world, head.height + 1, round, timestamp);
        if (decision.kind === 'SCHEDULED' && decision.producer === attacker.address) {
          h.produce([], { timestamp, producer: nodeSigner(attacker) });
          placed = true;
        }
      }
      if (!placed) throw new Error('the attacker is not scheduled in any of the next rounds');
    }
    expect(h.chain.world.s.finality.finalizedHeight).toBe(0);
    // The others were skipped so often that they were suspended: the base shrank below the minimum, and the report says so.
    const report = finalityReport(h.chain.world);
    expect(report.finalizedHeight).toBe(0);
    expect(new Set([...Array(30).keys()].map((i) => h.chain.store.getBlockByHash(h.chain.store.getCanonicalHashAtHeight(h.chain.height - i)!)!.header.producer))).toEqual(
      new Set([attacker.address]),
    );
  });

  it('two of three producers cannot finalize either (the quorum for three is three)', async () => {
    const { h, nodes } = await fleetHarness(3);
    const absent = nodes[2];
    const target = P.maturityBlocks + finalityWindow(3) + 20;
    while (h.chain.height < target) {
      const head = h.chain.tip!;
      // Blocks where the schedule names the absent node are produced a round late by the next node instead.
      for (let round = 0; round < 6; round += 1) {
        const timestamp = head.timestamp + SLOT * (round + 1);
        const decision = producerDecision(h.chain.world, head.height + 1, round, timestamp);
        if (decision.kind === 'SCHEDULED' && decision.producer !== absent.address) {
          const signer = h.signers.get(decision.producer)!;
          h.produce([], { timestamp, producer: signer });
          break;
        }
      }
    }
    expect(h.chain.world.s.finality.finalizedHeight).toBe(0);
  });

  it('is computed identically by an independent node replaying the blocks, and a wrong claim fails the state root', async () => {
    const { h } = await fleetHarness(3);
    growTo(h, P.maturityBlocks + finalityWindow(3) + 30);
    expect(h.chain.world.s.finality.finalizedHeight).toBeGreaterThan(0);

    const replica = await createHarness({ producer: h.producer });
    harnesses.push(replica);
    for (let height = 1; height <= h.chain.height; height += 1) {
      const block = h.chain.store.getBlockByHash(h.chain.store.getCanonicalHashAtHeight(height)!)!;
      const result = replica.chain.addBlock(block);
      expect(result.accepted, `block ${height}: ${result.message}`).toBe(true);
    }
    expect(replica.chain.world.s.finality).toEqual(h.chain.world.s.finality);
    expect(replica.chain.tip!.hash).toBe(h.chain.tip!.hash);

    // The checkpoint is part of the state root: a block whose header root was computed over a different finality state
    // cannot be accepted. Corrupt the finalized height in a copy of the parent state and the produced root differs.
    const parent = forkParent(h, h.chain.height);
    const tampered = parent.state.clone();
    tampered.s.finality.finalizedHeight += 1;
    const honest = h.makeBlockOn(parent, [], { timestamp: h.chain.tip!.timestamp + SLOT });
    const dishonest = h.makeBlockOn({ ...parent, state: tampered }, [], { timestamp: h.chain.tip!.timestamp + SLOT });
    expect(dishonest.block.header.stateRoot).not.toBe(honest.block.header.stateRoot);
  });

  it('survives a restart: the finalized checkpoint is read back from state and never regresses', async () => {
    const { h } = await fleetHarness(3);
    growTo(h, P.maturityBlocks + finalityWindow(3) + 30);
    const before = { ...h.chain.world.s.finality };
    expect(before.finalizedHeight).toBeGreaterThan(0);

    const restored = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: h.chain.genesisDocument,
      enforceProposerRotation: true,
    });
    await restored.init();
    expect(restored.height).toBe(h.chain.height);
    expect(restored.world.s.finality.finalizedHeight).toBe(before.finalizedHeight);
    expect(restored.world.s.finality.finalizedHash).toBe(before.finalizedHash);
    expect(restored.finalityStatus().finalizedHash).toBe(before.finalizedHash);
  });

  it('refuses a branch that omits the finalized block, even one that is longer', async () => {
    const { h } = await fleetHarness(3);
    growTo(h, P.maturityBlocks + finalityWindow(3) + 30);
    const finalized = h.chain.world.s.finality.finalizedHeight;
    expect(finalized).toBeGreaterThan(2);
    const tipBefore = h.chain.tip!.hash;

    // A competing branch forks BELOW the finalized height and grows longer than the canonical chain.
    let parent = forkParent(h, finalized - 2);
    let rejected = 0;
    let ts = h.chain.store.getIndexEntry(parent.hash)!.timestamp;
    const needed = h.chain.height - parent.height + 5;
    for (let i = 0; i < needed; i += 1) {
      ts += SLOT + 1; // a different timestamp makes every block differ from the canonical one
      const { block, state } = h.makeBlockOn(parent, [], { timestamp: ts });
      const verdict = h.chain.addBlock(block);
      if (!verdict.accepted) {
        rejected += 1;
        expect([ErrCode.FINALITY_CONFLICT, ErrCode.NOT_PRODUCER_TURN]).toContain(verdict.code);
        break;
      }
      parent = { hash: blockHash(block.header), height: block.header.height, cumulativePotWeight: block.header.cumulativePotWeight, state };
    }
    expect(rejected).toBe(1);
    expect(h.chain.tip!.hash).toBe(tipBefore);
    expect(h.chain.world.s.finality.finalizedHeight).toBe(finalized);
  });
});
