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
 *   Deterministic round-robin over the active validator set, sorted by address,
 *   offset by the ROUND — how many slots have elapsed since the parent block:
 *       round(parent, block) = max(0, floor((block.ts - parent.ts) / targetBlockSeconds) - 1)
 *       proposer(height, round) = activeValidators[(height + round) mod validatorCount]
 *
 *   Round 0 is the common case and reduces to the plain `height mod count`
 *   rotation. The round exists so that a validator which does not show up costs
 *   the network one slot instead of the chain: once its slot has elapsed the
 *   turn passes to the next validator, and once EVERY validator has been given
 *   a slot (round >= validatorCount) any node may propose. Without that
 *   backstop a single offline validator halts block production permanently,
 *   because the schedule would keep naming an address that never answers.
 *
 *   The round is derived from the parent timestamp and the block's own
 *   timestamp — both already committed to the header — so every node computes
 *   the same answer from the block alone, with no extra header field and no
 *   out-of-band round negotiation. A proposer cannot claim an arbitrary round:
 *   the timestamp rules in src/consensus/time.ts bound how far into the future
 *   a block may be dated (maxFutureDriftSeconds) and require it to exceed the
 *   median time past, so the reachable round range is small and verifiable.
 *
 *   There is no randomness to grind, no leader election race and no committee
 *   that can be bribed into silence beyond the round-robin schedule. Jailed
 *   validators are skipped by construction because they are not in the active
 *   set. While NO validator is registered the network is in "genesis open"
 *   mode, where any node may propose; the first registered validator closes it
 *   for round 0 only.
 *
 * FORK CHOICE
 *   The chain with the greatest PoT Weight wins, then the greatest height, then
 *   the lowest block hash (a fully deterministic tie-break, so two honest nodes
 *   never disagree about the head). PoT Weight counts verified blocks and
 *   verified transactions — the state a chain carries — not spent computation.
 */

import type { WorldState } from '../blockchain/state.js';
import type { Block } from '../protocol/types.js';
import { blockHash } from '../blockchain/block.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { medianTimePast, validateBlockTime } from './time.js';

export { medianTimePast };

/**
 * How many proposer slots elapsed between a block and its parent.
 *
 * A block produced on schedule (one target interval after its parent) is round
 * 0. Each further whole interval of delay advances the round by one, handing
 * the turn to the next validator in the rotation. Derived purely from two
 * timestamps that are already committed to the headers, so it is identical on
 * every node that has the blocks.
 */
export function proposerRound(parentTimestamp: number, blockTimestamp: number): number {
  const elapsed = blockTimestamp - parentTimestamp;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  const slots = Math.floor(elapsed / CONSENSUS_PARAMS.block.targetBlockSeconds);
  return Math.max(0, slots - 1);
}

/**
 * Address scheduled to propose at `height` in `round`, or null when any node
 * may propose — which happens in two cases:
 *
 *   - no validator is registered at all (genesis-open mode), or
 *   - the round has passed every validator in the set, so each one has already
 *     been offered this height and declined it. This is the liveness backstop:
 *     it is what stops an absent validator from stalling the chain forever.
 */
export function scheduledProposer(state: WorldState, height: number, round = 0): string | null {
  const active = state.activeValidators();
  if (active.length === 0) return null;
  if (round >= active.length) return null;
  return active[(height + round) % active.length];
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

export function assertProposerAllowed(state: WorldState, block: Block, parentTimestamp: number): void {
  const round = proposerRound(parentTimestamp, block.header.timestamp);
  const scheduled = scheduledProposer(state, block.header.height, round);
  if (scheduled === null) return; // genesis-open mode, or every validator skipped this height
  if (block.header.producer !== scheduled) {
    const error = new Error(
      `proposer for height ${block.header.height} round ${round} must be ${scheduled}, ` +
        `received ${block.header.producer}`,
    );
    (error as Error & { code?: string }).code = 'ERR_NOT_PRODUCER_TURN';
    throw error;
  }
}

export function isProposerAllowed(state: WorldState, producer: string, height: number, round = 0): boolean {
  const scheduled = scheduledProposer(state, height, round);
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
