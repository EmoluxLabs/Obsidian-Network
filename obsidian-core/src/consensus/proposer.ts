/**
 * Proposer selection and fork choice — the mechanical heart of Proof of Time.
 *
 * There is no hash-puzzle race, no nonce search and no competition to spend
 * computation. Authority to produce a block is a function of TIME and of the
 * validator schedule:
 *
 *   - the proposer of a height is the validator whose slot the protocol clock
 *     hands the turn to;
 *   - a block may only be produced once protocol time has advanced past its
 *     parent (median time past, plus PoT Difficulty — see src/consensus/time.ts);
 *   - the chain a node adopts is the one carrying the most verified state and
 *     the most verified time (PoT Weight, then height), never the one that
 *     burned the most computation.
 *
 * Any node with the chain can recompute every one of those decisions, and a
 * node that lies about time is rejected the same way a forged signature would be.
 *
 * PROPOSER SELECTION
 *   Deterministic round-robin over the active validator set, sorted by address:
 *       proposer(height) = activeValidators[height mod validatorCount]
 *   There is no randomness to grind, no leader election race and no committee
 *   that can be bribed into silence beyond the round-robin schedule. Jailed
 *   validators are skipped by construction because they are not in the active
 *   set. While NO validator is registered the network is in "genesis open"
 *   mode, where any node may propose; the first registered validator closes it.
 *
 * FORK CHOICE
 *   The chain with the greatest PoT Weight wins, then the greatest height, then
 *   the lowest block hash (a fully deterministic tie-break, so two honest nodes
 *   never disagree about the head). PoT Weight counts verified blocks and
 *   verified transactions — the state a chain carries — not spent computation.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import type { WorldState } from '../blockchain/state.js';
import type { Block } from '../protocol/types.js';
import { blockHash } from '../blockchain/block.js';
import { medianTimePast, validateBlockTime } from './time.js';

export { medianTimePast };

/** Address scheduled to propose at `height`, or null in genesis-open mode. */
export function scheduledProposer(state: WorldState, height: number): string | null {
  const active = state.activeValidators();
  if (active.length === 0) return null;
  return active[height % active.length];
}

export interface ForkChoiceInput {
  height: number;
  cumulativePotWeight: bigint;
  hash: string;
}

/**
 * Compare two candidate chain tips. Returns 1 when `a` should be preferred over
 * `b`, -1 when `b` wins, 0 when they are equivalent (same block).
 */
export function compareTips(a: ForkChoiceInput, b: ForkChoiceInput): number {
  if (a.cumulativePotWeight !== b.cumulativePotWeight) return a.cumulativePotWeight > b.cumulativePotWeight ? 1 : -1;
  if (a.height !== b.height) return a.height > b.height ? 1 : -1;
  if (a.hash === b.hash) return 0;
  return a.hash < b.hash ? 1 : -1;
}

export function tipOf(block: Block): ForkChoiceInput {
  return {
    height: block.header.height,
    cumulativePotWeight: block.header.cumulativePotWeight,
    hash: blockHash(block.header),
  };
}

export function assertProposerAllowed(state: WorldState, block: Block): void {
  const scheduled = scheduledProposer(state, block.header.height);
  if (scheduled === null) return; // genesis-open mode
  if (block.header.producer !== scheduled) {
    const error = new Error(
      `proposer for height ${block.header.height} must be ${scheduled}, received ${block.header.producer}`,
    );
    (error as Error & { code?: string }).code = 'ERR_NOT_PRODUCER_TURN';
    throw error;
  }
}

export function isProposerAllowed(state: WorldState, producer: string, height: number): boolean {
  const scheduled = scheduledProposer(state, height);
  return scheduled === null || scheduled === producer;
}


export interface TimestampCheck {
  ok: boolean;
  reason?: string;
  medianTimePast: number;
  /** Minimum timestamp the protocol would accept for this position. */
  minimumTimestamp?: number;
}

/**
 * Timestamp validity for a candidate block: Proof of Time, expressed as a rule.
 *
 *   timestamp >  median time past of the last `medianTimePastWindow` ancestors
 *   timestamp >= parent timestamp + PoT Difficulty spacing (seconds)
 *   timestamp <= this node's clock + maxFutureDriftSeconds
 *
 * The first two clauses are derived entirely from chain data, so every node
 * computes the same answer. The third is the only place a validating node's own
 * clock appears, and it can only reject a block that claims the future: a node
 * with a broken clock cannot make an old block acceptable, it can only fall
 * behind honest peers. That asymmetry is what stops "my device clock says it is
 * 3am" from ever mattering to consensus.
 *
 * Delegates to src/consensus/time.ts so the rule lives in exactly one place.
 */
export function checkBlockTimestamp(
  timestamp: number,
  ancestorTimestamps: number[],
  localTimeSeconds: number,
): TimestampCheck {
  const ancestors = ancestorTimestamps.map((value) => ({ timestamp: value }));
  const verdict = validateBlockTime({ timestamp }, ancestors, localTimeSeconds);
  if (verdict.ok) {
    return { ok: true, medianTimePast: verdict.medianTimePast, minimumTimestamp: verdict.minimumTimestamp };
  }
  return {
    ok: false,
    reason: verdict.reason,
    medianTimePast: verdict.medianTimePast,
    minimumTimestamp: verdict.minimumTimestamp,
  };
}
