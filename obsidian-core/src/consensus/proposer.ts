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
 *   turn passes to the next active validator. The rotation remains validator-
 *   only in every round; it never opens block production to an unbonded node.
 *   If every registered validator is offline the chain deliberately stops
 *   rather than trading safety for unauthenticated block production.
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
 *   set.
 *
 *   TWO MODES, ONE COMMITTED INDICATOR. Before the chain has ever accepted a
 *   valid registration it is in bootstrap mode, where any node may propose so
 *   that a first validator can arrive; the first successful registration sets a
 *   state-committed indicator and closes the rotation for ever. From then on an
 *   empty active set HALTS the chain: nobody may produce, in any round. "No
 *   validators are registered" cannot be told apart, from the chain alone, from
 *   "every validator left", so the mode is stored explicitly rather than
 *   inferred from a count that a jail, an unbonding or a slash can empty.
 *
 *   HONEST LIMIT. The schedule is a rule about WHEN a block may carry a given
 *   validator's name, enforced through timestamps; it is not a vote or a
 *   finality gadget. A block may be dated up to `maxFutureDriftSeconds` ahead of
 *   a node's clock, so a validator can claim a later round than real elapsed
 *   time supports — at most (drift / targetBlockSeconds) rounds ahead. It still
 *   cannot escape the bonded validator set. Bootstrap mode exists only until the
 *   first registration is accepted; it never reopens.
 *
 * FORK CHOICE
 *   The chain with the greatest PoT Weight wins, then the greatest height, then
 *   the lowest block hash (a fully deterministic tie-break, so two honest nodes
 *   holding the same candidates agree about the head). Every valid block adds
 *   exactly one weight unit. Transactions never buy fork-choice authority.
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
 * Is block production open to any node that can sign a block?
 *
 * ONLY while the chain has never accepted a valid validator registration — the
 * bootstrap window in which the first validator has to arrive at all. The answer
 * comes from a committed, state-root indicator, not from a count: once the
 * indicator is set, an empty active set is a halt, not an invitation.
 */
export function validatorRotationIsOpen(state: WorldState): boolean {
  if (!CONSENSUS_PARAMS.consensus.validatorSetNeverReopens) return true;
  return state.s.validatorModeEstablished !== true;
}

/**
 * Has this chain stopped for want of validators?
 *
 * True when the rotation is closed (a validator has registered at some point)
 * and no validator is active at `atTimestamp`. A halted chain accepts no block
 * from anyone — not from the validator that left, not from a stranger, in no
 * round. That is the deliberate answer: "nobody is bonded right now" is not
 * distinguishable on-chain from "every validator left", so the safe response is
 * to stop rather than to let any key that can sign take over the chain.
 *
 * The chain restarts by consensus, with no operator and no admin call: a
 * validator whose jail term lapses in time, or a new registration carrying a
 * full 20,000 OBS bond, restores the set and the schedule resumes.
 */
export function chainIsHaltedForWantOfValidators(
  state: WorldState,
  atTimestamp: number = state.s.timestamp,
): boolean {
  if (validatorRotationIsOpen(state)) return false;
  return state.activeValidators(atTimestamp).length === 0;
}

/** The three possible answers to "who may produce this height?". */
export type ProposerDecision =
  /** Bootstrap mode: no validator has ever registered, so any node may propose. */
  | { kind: 'OPEN' }
  /** The rotation named this address for this height and round. */
  | { kind: 'SCHEDULED'; proposer: string }
  /** The rotation is closed and empty: the chain is halted, nobody may propose. */
  | { kind: 'HALTED'; reason: string };

/**
 * Answer "who may propose at `height` in `round`?" from committed state alone.
 *
 * One function, three outcomes, so no caller has to reason about what a null
 * meant. The active set is read AT `atTimestamp` — the timestamp of the block
 * being judged — because a jail is a duration of protocol time and can lapse
 * between a parent block and its child; every node evaluates it at the same
 * instant, from the same committed term.
 */
export function proposerDecision(
  state: WorldState,
  height: number,
  round = 0,
  atTimestamp: number = state.s.timestamp,
): ProposerDecision {
  const active = state.activeValidators(atTimestamp);
  if (active.length > 0) {
    const safeRound = Number.isSafeInteger(round) && round >= 0 ? round : 0;
    return { kind: 'SCHEDULED', proposer: active[(height + safeRound) % active.length] };
  }
  if (validatorRotationIsOpen(state)) return { kind: 'OPEN' };
  return {
    kind: 'HALTED',
    reason:
      'the validator rotation is closed and no validator is active, so the chain is halted ' +
      'for want of validators; it resumes when a validator becomes active again',
  };
}

/**
 * Address scheduled to propose at `height` in `round`, or null when nobody is.
 *
 * Rounds cycle through the active set. They never fall through to arbitrary
 * nodes: that old fallback let any unbonded key wait `validatorCount` slots (or
 * immediately future-date within the drift allowance) and bypass validator
 * admission entirely.
 *
 * NULL IS AMBIGUOUS ON PURPOSE AND MUST NOT BE READ AS "ANYONE MAY PROPOSE":
 * it means either bootstrap mode or a halt, and only
 * `validatorRotationIsOpen` / `chainIsHaltedForWantOfValidators` can tell them
 * apart. Callers that accept a block use `isProposerAllowed`, which does.
 */
export function scheduledProposer(
  state: WorldState,
  height: number,
  round = 0,
  atTimestamp: number = state.s.timestamp,
): string | null {
  const decision = proposerDecision(state, height, round, atTimestamp);
  return decision.kind === 'SCHEDULED' ? decision.proposer : null;
}

/**
 * Validators to be recorded as having missed their slot for a block.
 *
 * Exactly one validator can ever be named: the ROUND-0 proposer of the height,
 * and only when the block that was finally produced belongs to a later round
 * (the round-0 validator had its whole window and a block still did not come
 * from it). Naming only the first slot-holder is deliberate. Timestamps can be
 * nudged inside the drift window, so a rule that blamed every validator the
 * round skipped would let one future-dated block frame many of them at once;
 * one name per block bounds that to a single validator per block, which the
 * leaky counter in processValidatorBookkeeping then absorbs.
 *
 * Pure function of (parent state, height, parent timestamp, block timestamp,
 * producer), so every node computes the same list from the block alone.
 */
export function missedProposersFor(
  parentState: WorldState,
  height: number,
  parentTimestamp: number,
  blockTimestamp: number,
  producer: string,
): string[] {
  if (proposerRound(parentTimestamp, blockTimestamp) === 0) return [];
  const first = scheduledProposer(parentState, height, 0, blockTimestamp);
  if (first === null || first === producer) return [];
  return [first];
}

export interface ForkChoiceInput {
  height: number;
  cumulativePotWeight: bigint;
  hash: string;
}

/** Compare tips by PoT weight, height, then the lexicographically lowest block hash. */
export function compareTips(a: ForkChoiceInput, b: ForkChoiceInput): number {
  if (a.hash === b.hash) return 0;
  if (a.cumulativePotWeight !== b.cumulativePotWeight) return a.cumulativePotWeight > b.cumulativePotWeight ? 1 : -1;
  if (a.height !== b.height) return a.height > b.height ? 1 : -1;
  return a.hash < b.hash ? 1 : -1;
}

export function tipOf(block: Block): ForkChoiceInput {
  return {
    height: block.header.height,
    cumulativePotWeight: block.header.cumulativePotWeight,
    hash: blockHash(block.header),
  };
}

/**
 * Reject a block whose producer the schedule did not name.
 *
 * A halted chain rejects EVERY producer here: the validator that left, a
 * stranger, any round. The error code is the schedule's own — the chain is not
 * merely expecting somebody else, it is expecting nobody.
 */
export function assertProposerAllowed(state: WorldState, block: Block, parentTimestamp: number): void {
  const round = proposerRound(parentTimestamp, block.header.timestamp);
  const decision = proposerDecision(state, block.header.height, round, block.header.timestamp);
  if (decision.kind === 'OPEN') return; // bootstrap mode only, and only until the first registration
  if (decision.kind === 'HALTED') {
    const error = new Error(
      `the chain is halted for want of validators at height ${block.header.height}: ${decision.reason}`,
    );
    (error as Error & { code?: string }).code = 'ERR_NOT_PRODUCER_TURN';
    throw error;
  }
  if (block.header.producer !== decision.proposer) {
    const error = new Error(
      `proposer for height ${block.header.height} round ${round} must be ${decision.proposer}, ` +
        `received ${block.header.producer}`,
    );
    (error as Error & { code?: string }).code = 'ERR_NOT_PRODUCER_TURN';
    throw error;
  }
}

/**
 * May `producer` author the block at `height` in `round`?
 *
 * Evaluated at `atTimestamp` — the candidate block's own protocol time — so a
 * validator whose jail lapses exactly at that block is already back in the set
 * that names it. False for everybody while the chain is halted.
 */
export function isProposerAllowed(
  state: WorldState,
  producer: string,
  height: number,
  round = 0,
  atTimestamp: number = state.s.timestamp,
): boolean {
  const decision = proposerDecision(state, height, round, atTimestamp);
  if (decision.kind === 'OPEN') return true;
  return decision.kind === 'SCHEDULED' && decision.proposer === producer;
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
