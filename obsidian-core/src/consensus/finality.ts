/**
 * Derived finality — PRODUCER-DIVERSITY CHECKPOINTS (protocol 1.9.0).
 *
 * NO VOTES. Nobody signs a finality message, nothing is gossiped, no certificate exists and no timer decides
 * anything. Finality is computed inside the block state machine from the blocks themselves, stored in the state
 * (`state.s.finality`) and committed in the state root. A node that disagrees about finality therefore disagrees
 * about the state root, and its block is refused — independent verification is not a feature, it is the same check
 * every block already goes through.
 *
 * THE RULE
 *   Let H be the head being applied and n_head the number of eligible producers at H.
 *       W = clamp(windowPerProducer * n_head, windowMin, windowMax)         blocks
 *       h = H - W                                                           the candidate checkpoint
 *   Let base(h) be the nodes that were registered AND mature at height h and are, at H, still registered, unbanned,
 *   unsuspended and live (a sign of life within `inactivityPeriods` reward periods). Let n = |base(h)|.
 *   Block h (and every ancestor) becomes FINAL iff
 *       n >= minProducers  and  |{ distinct producers of blocks h+1 .. H that belong to base(h) }| >= floor(2n/3) + 1.
 *   The finalized height only ever moves forward.
 *
 * WHAT THIS MEANS — AND WHAT IT DOES NOT
 *   It means: two thirds of the nodes that were already established when block h was made have since built on it.
 *   Under a partition each side would have to contain more than two thirds of the producers, which is impossible
 *   unless producers build on BOTH sides. So, with no more than one third of the mature producers faulty and with
 *   honest producers that never build on a branch below the finalized prefix, two conflicting blocks cannot both
 *   become final.
 *   It does NOT mean: Byzantine fault tolerance. There are no locks and no bond, so a producer that builds on one
 *   branch and later switches to another (while the first is not yet final in its own view) is counted on both and
 *   cannot be punished for it, and a fleet of more than one third of the mature producers breaks the guarantee.
 *   Finality is conditional and economic, not deterministic-by-quorum-certificate. A node that has been offline for
 *   longer than the reorg window must obtain a recent finalized checkpoint from a source it trusts (weak
 *   subjectivity) — the protocol cannot give it that proof.
 *   With fewer than `minProducers` eligible nodes — including a single-node network — finality is UNAVAILABLE and
 *   says so; the chain still advances, and nothing is called final.
 */

import type { WorldState } from '../blockchain/state.js';
import type { NodeRecord } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { isCandidate } from './schedule.js';

const F = CONSENSUS_PARAMS.consensus.finality;
const P = CONSENSUS_PARAMS.consensus.producers;

/** Blocks that follow a candidate checkpoint before it can be judged, for n eligible producers. */
export function finalityWindow(n: number): number {
  const raw = F.windowPerProducer * Math.max(0, n);
  return Math.min(F.windowMax, Math.max(F.windowMin, raw));
}

/** Distinct producers needed: strictly more than two thirds of n. */
export function finalityQuorum(n: number): number {
  if (!Number.isSafeInteger(n) || n <= 0) return 0;
  return Math.floor((n * F.quorumNumerator) / F.quorumDenominator) + 1;
}

/** Was this node an established producer at `height` and is it still a counting member at `headTimestamp`? */
export function inFinalityBase(node: NodeRecord, height: number, headTimestamp: number): boolean {
  if (!isCandidate(node)) return false;
  if (node.registeredAtHeight + P.maturityBlocks > height) return false;
  const cutoff = headTimestamp - F.inactivityPeriods * CONSENSUS_PARAMS.nodeRewards.periodSeconds;
  if (node.lastActiveAt < cutoff) return false;
  if (node.suspendedUntil !== undefined && node.suspendedUntil > headTimestamp) return false;
  return true;
}

function baseAt(state: WorldState, height: number, headTimestamp: number): NodeRecord[] {
  return state.registeredNodes().filter((node) => inFinalityBase(node, height, headTimestamp));
}

export interface FinalityBlockContext {
  height: number;
  timestamp: number;
  producer: string;
  /** Hash of the parent block (the block at height - 1). */
  parentHash: string;
}

/**
 * Record the block being applied in the rolling window and, if the rule above is met, advance the finalized
 * checkpoint. Called once per block by the state machine, after node bookkeeping. Mutates `state.s.finality`.
 */
export function processFinality(state: WorldState, ctx: FinalityBlockContext): void {
  const fin = state.s.finality;
  const last = fin.recent[fin.recent.length - 1];
  if (last && last.height === ctx.height - 1) last.hash = ctx.parentHash;
  fin.recent.push({ height: ctx.height, producer: ctx.producer, hash: '' });
  // Entries are kept for the widest window plus one, so the candidate checkpoint is always still in the window.
  const keepFrom = ctx.height - F.windowMax;
  while (fin.recent.length > 0 && fin.recent[0].height < keepFrom) fin.recent.shift();

  const nHead = baseAt(state, ctx.height, ctx.timestamp).length;
  const window = finalityWindow(nHead);
  const candidate = ctx.height - window;
  if (candidate < 1 || candidate <= fin.finalizedHeight) return;

  const base = baseAt(state, candidate, ctx.timestamp);
  const n = base.length;
  if (n < F.minProducers) return;
  const members = new Set(base.map((node) => node.producerAddress));
  const seen = new Set<string>();
  let checkpointHash = '';
  for (const entry of fin.recent) {
    if (entry.height === candidate) checkpointHash = entry.hash;
    if (entry.height > candidate && entry.height <= ctx.height && members.has(entry.producer)) seen.add(entry.producer);
  }
  if (!checkpointHash) return;
  if (seen.size < finalityQuorum(n)) return;

  fin.finalizedHeight = candidate;
  fin.finalizedHash = checkpointHash;
  state.emit('FINALITY_ADVANCED', {
    finalizedHeight: candidate,
    finalizedHash: checkpointHash,
    producersSeen: seen.size,
    baseProducers: n,
    quorum: finalityQuorum(n),
    window,
  }, { height: ctx.height, timestamp: ctx.timestamp });
}

export interface FinalityReport {
  model: typeof F.model;
  available: boolean;
  /** Why finality is or is not being produced, in words an operator can act on. */
  reason: string;
  finalizedHeight: number;
  finalizedHash: string;
  headHeight: number;
  /** Blocks between the head and the finalized checkpoint. */
  lag: number;
  eligibleProducers: number;
  window: number;
  quorum: number;
  minProducers: number;
}

/** Read-only report for RPC and the UI, computed from a state. Never mutates it. */
export function finalityReport(state: WorldState): FinalityReport {
  const fin = state.s.finality;
  const nHead = baseAt(state, state.s.height, state.s.timestamp).length;
  const available = nHead >= F.minProducers;
  return {
    model: F.model,
    available,
    reason: available
      ? 'finality advances when two thirds of the established producers have built on a block'
      : `finality is unavailable: ${nHead} established producer(s), at least ${F.minProducers} are required`,
    finalizedHeight: fin.finalizedHeight,
    finalizedHash: fin.finalizedHash,
    headHeight: state.s.height,
    lag: Math.max(0, state.s.height - fin.finalizedHeight),
    eligibleProducers: nHead,
    window: finalityWindow(nHead),
    quorum: finalityQuorum(nHead),
    minProducers: F.minProducers,
  };
}
