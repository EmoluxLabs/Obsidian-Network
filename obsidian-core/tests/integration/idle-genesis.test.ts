/**
 * A chain is not a clock (protocol 1.9.0).
 *
 * Genesis carries a fixed timestamp; a network is usually launched some time after it, and a network can sit idle for
 * days. Height counts BLOCKS, never seconds, so a first block produced months after genesis is height 1 and nothing is
 * wrong with that. These tests pin the properties that make this safe: such a block is valid, the schedule's round is a
 * function of the two timestamps only, every independent replay reaches the same state root, and the slot clock that
 * governs everything else (round 0 = one target interval) restarts from the late block, not from genesis.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { blockHash } from '../../src/blockchain/block.js';
import { proposerRound } from '../../src/consensus/schedule.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import { createHarness, makeNode, makeWallet, nodeSigner, nodeStatement, type Harness } from '../helpers/harness.js';

const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

describe('a chain that starts long after its genesis timestamp', () => {
  it('accepts a first block months after genesis, at height 1, and every replay agrees', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const genesisTimestamp = h.chain.tip!.timestamp;
    const late = Math.floor(Date.now() / 1000) - 5;
    expect(late - genesisTimestamp).toBeGreaterThan(30 * 86_400);

    const first = h.produce([], { timestamp: late });
    expect(first.header.height).toBe(1);
    // The slot clock restarts from the late block: the next block one interval later is ordinary round 0.
    expect(proposerRound(late, late + SLOT)).toBe(0);
    const second = h.produce([], { timestamp: late + SLOT });
    expect(second.header.height).toBe(2);

    const replica = await createHarness({ producer: h.producer });
    harnesses.push(replica);
    for (const block of [first, second]) expect(replica.chain.addBlock(block).accepted).toBe(true);
    expect(replica.chain.tip!.hash).toBe(h.chain.tip!.hash);
    expect(replica.chain.stateRoot).toBe(h.chain.stateRoot);
  });

  it('a late block is never allowed to claim more future than the drift bound, whatever the gap behind it', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const now = Math.floor(Date.now() / 1000);
    const verdict = h.tryBlock([], { timestamp: now + CONSENSUS_PARAMS.block.maxFutureDriftSeconds + 120 });
    expect(verdict.accepted).toBe(false);
  });

  it('after an idle gap the schedule moves to a later round deterministically and every node names the same producer', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const nodes = Array.from({ length: 3 }, () => makeNode(makeWallet()));
    const t0 = Math.floor(Date.now() / 1000) - 10 * 86_400;
    h.produce([], { timestamp: t0 });
    h.produce(
      nodes.slice(0, 2).map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: t0 + SLOT })),
      { timestamp: t0 + SLOT },
    );
    for (const node of nodes) h.signers.set(node.address, nodeSigner(node));
    h.produce([nodeStatement(h, nodes[2], { op: NodeRegistryOp.REGISTER }, { protocolTime: t0 + 2 * SLOT })], { timestamp: t0 + 2 * SLOT });
    let ts = t0 + 2 * SLOT;
    while (h.chain.height < CONSENSUS_PARAMS.consensus.producers.maturityBlocks + 6) {
      ts += SLOT;
      h.produce([], { timestamp: ts });
    }
    // Three days of silence, then the next block: a very late round, still a pure function of the two timestamps.
    const resume = ts + 3 * 86_400;
    expect(proposerRound(ts, resume)).toBeGreaterThan(1000);
    const block = h.produce([], { timestamp: resume });
    expect(h.chain.tip!.hash).toBe(blockHash(block.header));

    const replica = await createHarness({ producer: h.producer });
    harnesses.push(replica);
    for (let height = 1; height <= h.chain.height; height += 1) {
      const stored = h.chain.store.getBlockByHash(h.chain.store.getCanonicalHashAtHeight(height)!)!;
      expect(replica.chain.addBlock(stored).accepted, `block ${height}`).toBe(true);
    }
    expect(replica.chain.stateRoot).toBe(h.chain.stateRoot);
  });
});
