/**
 * ATTACK ROUND 4 — front-running other producers' slots by dating a block into the future.
 *
 * The producer of a block is a function of its ROUND, and the round is computed from the block's own timestamp
 * (`proposerRound(parent, block)`). The one clock-based rule is "timestamp <= my clock + maxFutureDriftSeconds".
 * With a 60 second allowance a node that is merely one of several scheduled producers could, the instant a parent
 * appeared, sign a block dated up to eleven slots ahead, pick the round in which the schedule names IT, and
 * publish it five seconds (or more) before the honest round-0 producer's slot opened: it could take any slot,
 * and every such block also recorded the honest round-0 producer as having MISSED its turn (three misses in a row
 * suspend a node). The drift allowance is now two slots: the most a producer can gain over an honest, on-time
 * peer is the next slot, never a run of them.
 *
 * Time is faked so the node's clock is exactly the parent's timestamp (the best case for the attacker).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
} from '../helpers/harness.js';

const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const P = CONSENSUS_PARAMS.consensus.producers;
const harnesses: Harness[] = [];
afterEach(() => {
  vi.useRealTimers();
  while (harnesses.length) harnesses.pop()!.close();
});

describe('round 4: a producer cannot claim slots whose time has not come', () => {
  it('accepts at most the very next slot ahead of the local clock, and refuses a run of future rounds without penalty-grade blame', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const nodes = Array.from({ length: 5 }, () => makeNode(makeWallet()));
    for (let i = 0; i < nodes.length; i += P.maxRegistrationsPerBlock) {
      const batch = nodes.slice(i, i + P.maxRegistrationsPerBlock);
      const ts = h.chain.tip!.timestamp + SLOT;
      h.produce(batch.map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })), { timestamp: ts });
      for (const node of batch) h.signers.set(node.address, nodeSigner(node));
    }
    while (h.chain.height < P.maturityBlocks + 4) h.produce([], { timestamp: h.chain.tip!.timestamp + SLOT });

    const parentHeight = h.chain.height;
    const parentTs = h.chain.tip!.timestamp;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(parentTs * 1000);

    const outcomes: Array<{ round: number; accepted: boolean; code?: string }> = [];
    for (let round = 0; round <= 11; round += 1) {
      const timestamp = parentTs + SLOT * (round + 1);
      const block = h.makeBlockOn(forkParent(h, parentHeight), [], { timestamp }).block;
      const verdict = h.chain.addBlock(block);
      outcomes.push({ round, accepted: verdict.accepted, code: verdict.code });
    }
    const accepted = outcomes.filter((o) => o.accepted).map((o) => o.round);
    // Round 0 (on time) and round 1 (dated exactly one drift ahead) are the most a clock can justify.
    expect(Math.max(...accepted)).toBeLessThanOrEqual(1);
    for (const o of outcomes.filter((x) => x.round >= 2)) expect(o.code, `round ${o.round}`).toBe(ErrCode.BAD_TIMESTAMP);
  }, 60_000);

  it('keeps the drift allowance at two slots, so the bound is a property of the parameters and not of one test', () => {
    expect(CONSENSUS_PARAMS.block.maxFutureDriftSeconds).toBeLessThanOrEqual(2 * SLOT);
  });
});
