/**
 * Proposer selection and fork choice.
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
 *   Heaviest chain wins: greatest cumulativeWork, then greatest height, then
 *   the lowest block hash (a fully deterministic tie-break, so two honest nodes
 *   never disagree about the head).
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import type { WorldState } from '../blockchain/state.js';
import type { Block } from '../protocol/types.js';
import { blockHash } from '../blockchain/block.js';

/** Address scheduled to propose at `height`, or null in genesis-open mode. */
export function scheduledProposer(state: WorldState, height: number): string | null {
  const active = state.activeValidators();
  if (active.length === 0) return null;
  return active[height % active.length];
}

export interface ForkChoiceInput {
  height: number;
  cumulativeWork: bigint;
  hash: string;
}

/**
 * Compare two candidate chain tips. Returns 1 when `a` should be preferred over
 * `b`, -1 when `b` wins, 0 when they are equivalent (same block).
 */
export function compareTips(a: ForkChoiceInput, b: ForkChoiceInput): number {
  if (a.cumulativeWork !== b.cumulativeWork) return a.cumulativeWork > b.cumulativeWork ? 1 : -1;
  if (a.height !== b.height) return a.height > b.height ? 1 : -1;
  if (a.hash === b.hash) return 0;
  return a.hash < b.hash ? 1 : -1;
}

export function tipOf(block: Block): ForkChoiceInput {
  return {
    height: block.header.height,
    cumulativeWork: block.header.cumulativeWork,
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

/** Median time past over the last `params.block.medianTimePastWindow` blocks. */
export function medianTimePast(ancestors: Array<{ timestamp: number }>): number {
  if (ancestors.length === 0) return 0;
  const window = CONSENSUS_PARAMS.block.medianTimePastWindow;
  const slice = ancestors.slice(0, window).map((a) => a.timestamp).sort((x, y) => x - y);
  const middle = Math.floor(slice.length / 2);
  return slice.length % 2 === 1 ? slice[middle] : Math.floor((slice[middle - 1] + slice[middle]) / 2);
}

export interface TimestampCheck {
  ok: boolean;
  reason?: string;
  medianTimePast: number;
}

/**
 * Timestamp validity for a candidate block.
 *
 *   medianTimePast(ancestors) < timestamp <= now + maxFutureDriftSeconds
 *
 * This is the ONLY clock the protocol trusts, and it is bounded by the parent
 * chain, not by the machine that happens to be validating.
 */
export function checkBlockTimestamp(
  timestamp: number,
  ancestorTimestamps: number[],
  localTimeSeconds: number,
): TimestampCheck {
  const mtp = medianTimePast(ancestorTimestamps.map((t) => ({ timestamp: t })));
  if (ancestorTimestamps.length > 0 && timestamp <= mtp) {
    return { ok: false, reason: `timestamp ${timestamp} is not later than median time past ${mtp}`, medianTimePast: mtp };
  }
  // Strict monotonicity against the parent. Protocol time drives mining
  // eligibility, so it must never be able to stall: every accepted block
  // advances chain time by at least one second, while the producer can never
  // reach further ahead than the drift limit below.
  const parentTimestamp = ancestorTimestamps[0];
  if (parentTimestamp !== undefined && timestamp <= parentTimestamp) {
    return {
      ok: false,
      reason: `timestamp ${timestamp} does not advance the parent timestamp ${parentTimestamp}`,
      medianTimePast: mtp,
    };
  }
  const drift = CONSENSUS_PARAMS.block.maxFutureDriftSeconds;
  if (timestamp > localTimeSeconds + drift) {
    return {
      ok: false,
      reason: `timestamp ${timestamp} is more than ${drift}s ahead of local time`,
      medianTimePast: mtp,
    };
  }
  return { ok: true, medianTimePast: mtp };
}
