/**
 * Producer bookkeeping — the per-block routine that keeps the schedule honest.
 *
 * Runs inside the block state machine for every block on every node, from the block alone:
 *   - the node that produced the block is shown alive and its miss counters are cleared;
 *   - the node whose round-0 slot the block skipped (see `missedProducersFor`) gets a miss; three consecutive
 *     misses suspend it for a term that doubles on each repeat, up to a ceiling.
 *
 * A suspension is a duration of PROTOCOL time: it costs the node its turns, never funds, and ends by itself.
 */

import type { WorldState } from '../blockchain/state.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';

const P = CONSENSUS_PARAMS.consensus.producers;

export function suspensionTerm(level: number): number {
  const doublings = Math.max(0, level - 1);
  const term = P.baseSuspensionSeconds * 2 ** Math.min(doublings, 30);
  return Math.min(P.maxSuspensionSeconds, term);
}

export function processProducerBookkeeping(
  state: WorldState,
  apply: { height: number; timestamp: number; producer?: string },
  missed: string[],
): void {
  if (apply.producer) {
    const node = state.nodeByProducer(apply.producer);
    if (node && node.deregisteredAtHeight === undefined) {
      node.lastActiveAt = apply.timestamp;
      node.missedSlots = 0;
      node.suspensions = 0;
      node.suspendedUntil = undefined;
      node.blocksProduced += 1;
      state.putNode(node);
    }
  }
  for (const address of missed) {
    const node = state.nodeByProducer(address);
    if (!node || node.deregisteredAtHeight !== undefined || node.bannedAtHeight !== undefined) continue;
    node.missedSlots += 1;
    if (node.missedSlots >= P.maxConsecutiveMisses) {
      node.suspensions += 1;
      node.missedSlots = 0;
      node.suspendedUntil = apply.timestamp + suspensionTerm(node.suspensions);
      state.emit('PRODUCER_SUSPENDED', {
        nodeId: node.nodeId,
        producer: node.producerAddress,
        until: node.suspendedUntil,
        level: node.suspensions,
      }, apply);
    }
    state.putNode(node);
  }
}
