/**
 * The producer schedule and fork choice — the mechanical heart of Proof of Time in 1.9.0.
 *
 * There is no hash-puzzle race, no stake, no bond and no vote. Authority to produce a block is a function of
 * TIME and of the NODE REGISTRY:
 *
 *   - the producer of a height is the registered node whose slot the protocol clock hands the turn to;
 *   - a block may only be produced once protocol time has advanced past its parent (median time past, plus PoT
 *     difficulty — see consensus/time.ts);
 *   - the chain a node adopts is the one that contains the finalized prefix and then carries the most verified time.
 *
 * Every node can recompute every one of those decisions from committed state and the block alone.
 *
 * THE PRODUCER IS THE NODE'S IDENTITY KEY
 *   A node is registered under one secp256k1 identity key (`NodeRecord.nodePublicKey`). Its producer address is the
 *   address of that key, and a block is only valid if the header signature verifies under the key that hashes to
 *   `header.producer` (block.ts). The header format is unchanged from 1.8.x; the only thing that changed is WHO may
 *   appear in the `producer` field.
 *
 * THE PRODUCER SET (deterministic, from the PARENT state, evaluated at the candidate block's timestamp)
 *
 *   TIER 1 — registered, not banned, MATURE (registered at least `maturityBlocks` blocks ago), LIVE (a sign of life
 *            inside `activityWindowSeconds`) and not SUSPENDED. This is the normal set.
 *   TIER 2 — only when tier 1 is empty: every registered, non-banned node, ignoring maturity, liveness and
 *            suspension. A chain whose only mature producers vanished must be able to continue.
 *   OPEN   — only when no registered, non-banned node exists at all: any key may produce. This is the founding
 *            state of a fresh chain (nobody can be registered before the first block exists) and it ends with the
 *            first accepted registration. It reopens only if every node deregisters or is banned.
 *
 *   The set is sorted by producer address. Registration order, registration time and who got there first have no
 *   influence on the order: that is what "resist registration order" means here.
 *
 * THE SCHEDULE
 *       round(parent, block)    = max(0, floor((block.ts - parent.ts) / targetBlockSeconds) - 1)
 *       producer(height, round) = set[(height + round) mod |set|]
 *
 *   Round 0 is the common case. A node that does not show up costs the network ONE SLOT, not the chain: once its
 *   slot has elapsed the turn passes to the next node in the set. The round is derived from two timestamps already
 *   committed to the headers, so every node computes the same answer from the block alone.
 *
 * SKIPPED SLOTS
 *   When a block belongs to a later round, the round-0 producer of that height missed its slot. Exactly one node is
 *   named per block (see `missedProducersFor`): a future-dated block cannot frame many nodes at once. Three
 *   consecutive misses suspend the node for `baseSuspensionSeconds`, doubling on each repeat (capped); producing a
 *   block clears the counters. A suspended node is outside tier 1, so it does not delay anybody.
 *
 * HONEST LIMITS
 *   - A block may be dated up to `maxFutureDriftSeconds` ahead of a node's clock, so a producer can claim a later
 *     round than real elapsed time supports. The allowance is two slots (10 s), so that is the NEXT slot and no
 *     further: with the earlier 60 s a single scheduled producer could take any of eleven future slots, front-run
 *     the honest producer and have it recorded as having missed its turn (tests/security/attack-r4-slot-frontrun).
 *     It still cannot leave the producer set.
 *   - Admission is not free: it is rate-limited and delayed (maturity), not priced. A patient attacker with many
 *     machines can register many nodes. Finality needs two thirds of the mature producers, so a fleet over one
 *     third of them can stall finality and a fleet over two thirds can control the chain. See docs/consensus-v1.9.0.md.
 *   - OPEN mode means the first registered node of a fresh network is whoever registers first. Founding
 *     operators register their node before publishing the network's address.
 *
 * FORK CHOICE
 *   A branch must contain the finalized prefix. Among such branches the greatest PoT weight wins, then the greatest
 *   height, then the lowest block hash (a fully deterministic tie-break, so two honest nodes holding the same
 *   candidates agree about the head). Every valid block adds exactly one weight unit. Transactions never buy
 *   fork-choice authority.
 */

import type { WorldState } from '../blockchain/state.js';
import type { Block, NodeRecord } from '../protocol/types.js';
import { blockHash } from '../blockchain/block.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { medianTimePast, validateBlockTime } from './time.js';

export { medianTimePast };

const P = CONSENSUS_PARAMS.consensus.producers;

/**
 * How many producer slots elapsed between a block and its parent. A block produced on schedule (one target
 * interval after its parent) is round 0; each further whole interval of delay advances the round by one.
 */
export function proposerRound(parentTimestamp: number, blockTimestamp: number): number {
  const elapsed = blockTimestamp - parentTimestamp;
  if (!Number.isFinite(elapsed) || elapsed <= 0) return 0;
  const slots = Math.floor(elapsed / CONSENSUS_PARAMS.block.targetBlockSeconds);
  return Math.max(0, slots - 1);
}

export type ProducerTier = 'TIER1' | 'TIER2' | 'OPEN';

export interface ProducerSet {
  tier: ProducerTier;
  /** Producer addresses in schedule order (sorted). Empty only in OPEN mode. */
  producers: string[];
}

/** Is this node a candidate at all (registered, not banned)? */
export function isCandidate(node: NodeRecord): boolean {
  return node.deregisteredAtHeight === undefined && node.bannedAtHeight === undefined;
}

/** Tier-1 predicate for one node, at one height and one instant. */
export function isTier1(node: NodeRecord, height: number, atTimestamp: number): boolean {
  if (!isCandidate(node)) return false;
  if (height - node.registeredAtHeight < P.maturityBlocks) return false;
  if (node.lastActiveAt < atTimestamp - P.activityWindowSeconds) return false;
  if (node.suspendedUntil !== undefined && node.suspendedUntil > atTimestamp) return false;
  return true;
}

/**
 * The producer set for the block at `height` whose timestamp is `atTimestamp`, read from `state` — the PARENT state.
 * Everything here is committed, so the answer is identical on every node that has the parent.
 */
export function producerSetFor(state: WorldState, height: number, atTimestamp: number): ProducerSet {
  const candidates = state.registeredNodes().filter(isCandidate);
  if (candidates.length === 0) return { tier: 'OPEN', producers: [] };
  const tier1 = candidates.filter((node) => isTier1(node, height, atTimestamp));
  const pick = tier1.length > 0 ? tier1 : candidates;
  const producers = pick.map((node) => node.producerAddress).sort();
  return { tier: tier1.length > 0 ? 'TIER1' : 'TIER2', producers };
}

/** The possible answers to "who may produce this height?". */
export type ProducerDecision =
  /** No registered node exists: any key may produce (founding state only). */
  | { kind: 'OPEN' }
  /** The schedule named this address for this height and round. */
  | { kind: 'SCHEDULED'; producer: string; tier: ProducerTier; setSize: number };

export function producerDecision(
  state: WorldState,
  height: number,
  round = 0,
  atTimestamp: number = state.s.timestamp,
): ProducerDecision {
  const set = producerSetFor(state, height, atTimestamp);
  if (set.tier === 'OPEN') return { kind: 'OPEN' };
  const safeRound = Number.isSafeInteger(round) && round >= 0 ? round : 0;
  return {
    kind: 'SCHEDULED',
    producer: set.producers[(height + safeRound) % set.producers.length],
    tier: set.tier,
    setSize: set.producers.length,
  };
}

/** Address scheduled at `height` in `round`, or null in OPEN mode (null never means "anyone may" to a caller). */
export function scheduledProducer(
  state: WorldState,
  height: number,
  round = 0,
  atTimestamp: number = state.s.timestamp,
): string | null {
  const decision = producerDecision(state, height, round, atTimestamp);
  return decision.kind === 'SCHEDULED' ? decision.producer : null;
}

/**
 * Nodes to record as having missed their slot for a block: only the ROUND-0 producer of the height, and only when
 * the block that was finally produced belongs to a later round and came from somebody else. One name per block.
 * Pure function of (parent state, height, parent timestamp, block timestamp, producer).
 */
export function missedProducersFor(
  parentState: WorldState,
  height: number,
  parentTimestamp: number,
  blockTimestamp: number,
  producer: string,
): string[] {
  if (proposerRound(parentTimestamp, blockTimestamp) === 0) return [];
  const first = scheduledProducer(parentState, height, 0, blockTimestamp);
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

/** Thrown for a block whose producer the schedule did not name. Carries the wire error code. */
export class NotProducerTurnError extends Error {
  readonly code = 'ERR_NOT_PRODUCER_TURN';
}

/**
 * Reject a block whose producer the schedule did not name. `state` is the PARENT state.
 */
export function assertProducerAllowed(state: WorldState, block: Block, parentTimestamp: number): void {
  const round = proposerRound(parentTimestamp, block.header.timestamp);
  const decision = producerDecision(state, block.header.height, round, block.header.timestamp);
  if (decision.kind === 'OPEN') return;
  if (block.header.producer !== decision.producer) {
    throw new NotProducerTurnError(
      `producer for height ${block.header.height} round ${round} must be ${decision.producer}, ` +
        `received ${block.header.producer}`,
    );
  }
}

/** May `producer` author the block at `height` in `round`, evaluated at the candidate block's own protocol time? */
export function isProducerAllowed(
  state: WorldState,
  producer: string,
  height: number,
  round = 0,
  atTimestamp: number = state.s.timestamp,
): boolean {
  const decision = producerDecision(state, height, round, atTimestamp);
  return decision.kind === 'OPEN' || decision.producer === producer;
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
 *   timestamp >= parent timestamp + PoT difficulty spacing (seconds)
 *   timestamp <= this node's clock + maxFutureDriftSeconds
 *
 * The first two clauses come from chain data only. The third is the only place a validating node's own clock
 * appears, and it can only reject a block that claims the future: a node with a broken clock cannot make an old
 * block acceptable, it can only fall behind honest peers.
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
