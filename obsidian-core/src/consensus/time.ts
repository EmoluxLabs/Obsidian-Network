/**
 * Proof of Time — the temporal layer of the protocol.
 *
 * WHAT PoT IS HERE
 *   Obsidian's consensus does not ask anyone to spend computation. Blocks are
 *   produced by the validator whose slot the protocol clock hands the turn to,
 *   and the chain a node adopts is the one carrying the most verified state and
 *   the most verified time (PoT Weight, then height). The scarce resource the
 *   protocol defends is TIME: a block cannot exist before its time, a mining
 *   claim cannot be made before its time, and a capsule cannot open before its
 *   time. Every node checks those statements against chain data it holds, so
 *   "what time is it" is never answered by a browser, a device clock, a
 *   website, or the operator of the node answering an API request.
 *
 * WHAT IS STILL CRYPTOGRAPHIC
 *   SHA-256 (block ids, Merkle roots, state roots, PoT Weight), Ed25519
 *   (signatures, node identity, reward-wallet proof of ownership), PBKDF2 and
 *   AES-GCM (the browser vault). Hashing and signing are transport and
 *   integrity tools here. They are not the consensus competition, and their
 *   speed buys nobody authority — which is exactly what separates PoT from PoW.
 *
 * HOW TIME IS AGREED
 *   1. `medianTimePast(ancestors)` is the median timestamp of the last
 *      (window) blocks — a monotone, manipulation-resistant clock derived from
 *      the chain itself.
 *   2. `potDifficulty` measures how the chain's observed spacing compares with
 *      the protocol target, from the last (window) blocks. It is published in
 *      milliseconds of spacing and in basis points, and it is what the interface
 *      shows where a Proof of Work chain would show difficulty. It is a
 *      MEASUREMENT of time, not an extra gate: the protocol deliberately does
 *      not reject a block for being faster than the target, because a healthy
 *      devnet, a catching-up node and a burst of activity are all legitimately
 *      faster, and a consensus rule that punished them would make the network
 *      slower without making it safer. What the timing rules actually enforce
 *      is in point 3, and none of it can be manufactured by a fast machine.
 *
 *   3. `validateBlockTime(header, ancestors, localTime)` requires
 *        timestamp > median time past,
 *        timestamp >= parent timestamp + minBlockTimestampGap (PoT Difficulty),
 *        timestamp <= localTime + maxFutureDriftSeconds.
 *      The third clause is the only place a node's own clock is consulted, and
 *      it can only *reject* a block that claims the future; it can never make a
 *      past block acceptable. A node with a wildly wrong clock therefore harms
 *      itself, not the chain: honest peers reject its blocks and it falls behind.
 *   4. `protocolTime` (see ChainManager) is max(local wall clock, head
 *      timestamp + 1): a node never believes it is earlier than the chain it
 *      holds, so claims and expiry cannot be back-dated to bypass cooldowns.
 *      Cooldowns are enforced by the validators against block timestamps, not
 *      by the interface showing a countdown.
 *
 * WHAT THE USER'S DEVICE CAN AND CANNOT DO
 *   The interface's countdown is a convenience rendering of protocol time read
 *   from a node. A manipulated browser clock changes what the countdown *says*
 *   and nothing else: a claim is accepted only if the protocol-time schedule
 *   allows it in the block that includes it.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';

export interface TimestampedBlock {
  timestamp: number;
  height?: number;
}

/**
 * Median time past (MTP): the median timestamp of up to `window` ancestors,
 * nearest parent first. Median, not maximum and not average, so one absurd
 * timestamp (honest clock skew or a hostile producer) cannot move the clock: it
 * takes a majority of the window to shift it.
 */
export function medianTimePast(
  ancestors: TimestampedBlock[],
  window: number = CONSENSUS_PARAMS.block.medianTimePastWindow,
): number {
  if (ancestors.length === 0) return 0;
  const slice = ancestors.slice(0, window).map((block) => Math.trunc(block.timestamp)).sort((a, b) => a - b);
  const middle = Math.floor(slice.length / 2);
  return slice.length % 2 === 1 ? slice[middle] : Math.floor((slice[middle - 1] + slice[middle]) / 2);
}

export interface PotDifficultyState {
  /** Required minimum spacing between consecutive block timestamps, milliseconds. */
  requiredSpacingMs: number;
  /** The same value in basis points of the target spacing (10_000 = on target). */
  difficultyBps: number;
  /** Blocks that contributed to the measurement. */
  windowBlocks: number;
  /** Observed mean spacing over the window, milliseconds (0 when unknown). */
  observedSpacingMs: number;
  /** True while the chain is younger than the difficulty window. */
  warmingUp: boolean;
  /** Chain height the difficulty was computed at. */
  atHeight: number;
  /** Chain head timestamp the difficulty was computed at. */
  atTimestamp: number;
}

/**
 * PoT Difficulty, derived from the spacing the chain has actually observed.
 *
 * This is a property of the *chain*, computed identically by every node from
 * timestamps every node already stores. It does not change who may produce a
 * block (the validator schedule does) and it does not make anyone compute more:
 * it says how much time must pass between blocks.
 *
 *   observed  = MEDIAN of the per-block gaps in the window          seconds
 *   rawBps    = 10_000 * target / observed         (>10_000 when blocks are fast)
 *   clamped   = min(maxDifficultyBps, max(minDifficultyBps, rawBps))
 *   spacingMs = max(minBlockSpacingMs, floor(target * 1000 * clamped / 10_000))
 *
 * The direction matters: when the chain is running FASTER than the target the
 * difficulty rises and the protocol demands more time between blocks; when it
 * is running slower the requirement relaxes towards the floor so a recovering
 * network is never locked out by its own history. PoT Difficulty exists to stop
 * a validator from racing time, never to punish a slow network.
 *
 * Two corrections, both found by running a packaged release rather than by
 * reading the code:
 *
 *   1. The gap between genesis and the first real block is EXCLUDED. The
 *      genesis timestamp is a constant written into the genesis document, not
 *      an observation of the network's rhythm; whatever time passed between
 *      that instant and launch says nothing about block spacing. Including it
 *      made a node producing a block every 5 seconds report 7,822,856,666 ms
 *      of "observed spacing".
 *   2. The MEDIAN of the remaining gaps is used, not the mean over the span,
 *      so one stalled block after an outage cannot redefine the measurement
 *      while a genuine change in rhythm still moves it immediately.
 *
 * `ancestors` is ordered nearest-parent-first, as chain storage returns it.
 */
export function potDifficulty(ancestors: TimestampedBlock[], atHeight = 0): PotDifficultyState {
  const pot = CONSENSUS_PARAMS.proofOfTime;
  const target = pot.difficultyTargetSeconds;
  const window = Math.min(pot.difficultyWindowBlocks, ancestors.length);
  // A single block carries no spacing information; report the floor honestly.
  if (window < 2) {
    return {
      requiredSpacingMs: pot.minBlockSpacingMs,
      difficultyBps: 10_000,
      windowBlocks: window,
      observedSpacingMs: 0,
      warmingUp: true,
      atHeight,
      atTimestamp: ancestors[0]?.timestamp ?? 0,
    };
  }
  const slice = ancestors.slice(0, window);
  const recent = slice.map((block) => Math.trunc(block.timestamp));
  const heights = slice.map((block) => block.height);
  const tip = recent[0];
  // Per-block gaps, newest first; timestamps strictly increase by consensus.
  // The gap whose OLDER end is the genesis block is skipped: the genesis
  // timestamp is a constant in the genesis document, not an observation of the
  // network's rhythm, and including it reports however long passed between the
  // genesis instant and launch as the chain's block spacing.
  const gapList: number[] = [];
  for (let index = 0; index < recent.length - 1; index += 1) {
    if (heights[index + 1] === 0) continue;
    gapList.push(recent[index] - recent[index + 1]);
  }
  const sorted = [...gapList].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const medianGapSeconds =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[middle]
        : Math.floor((sorted[middle - 1] + sorted[middle]) / 2);
  // Only the genesis gap existed: the chain has one real block, so there is
  // nothing to measure. Say so rather than publishing the genesis gap.
  if (gapList.length === 0) {
    return {
      requiredSpacingMs: pot.minBlockSpacingMs,
      difficultyBps: 10_000,
      windowBlocks: window,
      observedSpacingMs: 0,
      warmingUp: true,
      atHeight,
      atTimestamp: tip,
    };
  }
  if (medianGapSeconds <= 0) {
    // Timestamps are non-decreasing by consensus; a flat window means the chain
    // is running at the floor, which is the correct answer, not a division by 0.
    return {
      requiredSpacingMs: Math.max(
        pot.minBlockSpacingMs,
        Math.floor((target * 1000 * pot.maxDifficultyBps) / 10_000),
      ),
      difficultyBps: pot.maxDifficultyBps,
      windowBlocks: window,
      observedSpacingMs: 0,
      warmingUp: window < pot.difficultyWindowBlocks,
      atHeight,
      atTimestamp: tip,
    };
  }
  const observedSpacingMs = medianGapSeconds * 1000;
  const rawBps = Math.floor((target * 10_000 * 1000) / Math.max(1, observedSpacingMs));
  const difficultyBps = Math.min(pot.maxDifficultyBps, Math.max(pot.minDifficultyBps, rawBps));
  const requiredSpacingMs = Math.max(
    pot.minBlockSpacingMs,
    Math.floor((target * 1000 * difficultyBps) / 10_000),
  );
  return {
    requiredSpacingMs,
    difficultyBps,
    windowBlocks: window,
    observedSpacingMs,
    warmingUp: window < pot.difficultyWindowBlocks,
    atHeight,
    atTimestamp: tip,
  };
}

/**
 * The spacing, in whole seconds, that the measured difficulty corresponds to.
 * Reported by /pot and the explorer; not a validation threshold (see above).
 */
export function requiredSpacingSeconds(difficulty: PotDifficultyState): number {
  return Math.max(1, Math.floor(difficulty.requiredSpacingMs / 1000));
}

export interface BlockTimeVerdict {
  ok: boolean;
  code?: 'ERR_TIME_NOT_ADVANCING' | 'ERR_TIME_TOO_SOON' | 'ERR_TIME_FROM_FUTURE';
  reason?: string;
  medianTimePast: number;
  minimumTimestamp: number;
}

/**
 * The temporal rules a block header must satisfy. Pure function: same inputs,
 * same verdict on every node.
 *
 * `localTime` is used for one thing only — refusing a timestamp that claims to
 * be from the future beyond the allowed drift. It cannot admit anything.
 */
export function validateBlockTime(
  header: TimestampedBlock,
  ancestors: TimestampedBlock[],
  localTime?: number,
): BlockTimeVerdict {
  const mtp = medianTimePast(ancestors);
  const parent = ancestors[0];
  const difficulty = potDifficulty(ancestors, header.height ?? 0);
  // The enforced floor is the protocol's minimum spacing (one whole second,
  // which is also strict monotonicity), NOT the measured difficulty: see the
  // module comment. Difficulty is reported so operators and the interface can
  // see how time is tracking, and is deliberately not a rejection rule.
  const floorFromSpacing = parent
    ? Math.trunc(parent.timestamp) + Math.max(1, Math.floor(CONSENSUS_PARAMS.proofOfTime.minBlockSpacingMs / 1000))
    : 0;
  const minimumTimestamp = Math.max(mtp + 1, floorFromSpacing);

  if (parent && header.timestamp <= Math.trunc(parent.timestamp)) {
    return {
      ok: false,
      code: 'ERR_TIME_NOT_ADVANCING',
      reason: `block timestamp ${header.timestamp} does not advance past parent ${parent.timestamp}`,
      medianTimePast: mtp,
      minimumTimestamp,
    };
  }
  if (header.timestamp < minimumTimestamp) {
    return {
      ok: false,
      code: 'ERR_TIME_TOO_SOON',
      reason:
        `block timestamp ${header.timestamp} is before the protocol minimum ${minimumTimestamp} ` +
        `(median time past ${mtp}; observed PoT difficulty ${difficulty.difficultyBps}bps)`,
      medianTimePast: mtp,
      minimumTimestamp,
    };
  }
  if (localTime !== undefined && header.timestamp > Math.trunc(localTime) + CONSENSUS_PARAMS.block.maxFutureDriftSeconds) {
    return {
      ok: false,
      code: 'ERR_TIME_FROM_FUTURE',
      reason: `block timestamp ${header.timestamp} is more than ${CONSENSUS_PARAMS.block.maxFutureDriftSeconds}s ahead of this node's clock`,
      medianTimePast: mtp,
      minimumTimestamp,
    };
  }
  return { ok: true, medianTimePast: mtp, minimumTimestamp };
}

export interface TimeRate {
  /** Verified blocks per minute of protocol time across the window. */
  blocksPerMinute: number;
  /** Verified transactions per minute of protocol time across the window. */
  transactionsPerMinute: number;
  /** Blocks that contributed to the measurement. */
  blocks: number;
  /** Transactions recorded in those blocks. */
  transactions: number;
  /** Seconds of protocol time covered by the window. */
  windowSeconds: number;
  /** Observed mean spacing, milliseconds. */
  observedSpacingMs: number;
  /** PoT Difficulty at the head, for context. */
  difficultyBps: number;
  /** Machine-readable unit, so no consumer has to guess. */
  unit: 'BLOCKS_AND_TXS_PER_MINUTE';
  /** How the number was produced — repeated verbatim by the interface. */
  method: string;
}

export interface MeasuredBlock extends TimestampedBlock {
  txCount?: number;
}

/**
 * Time-Rate: the protocol's participation metric.
 *
 * A Proof of Work chain advertises hashrate — computation per second — because
 * that is what its security is bought with. Obsidian's security is bought with
 * time and verification, so the headline metric is how much verified state the
 * network is carrying per minute of protocol time.
 *
 *   windowSeconds      = tip.timestamp - oldest.timestamp
 *   blocksPerMinute    = (blocks - 1) * 60 / windowSeconds
 *   transactionsPerMin  = sum(txCount) * 60 / windowSeconds
 *
 * Returns zeros with an honest `windowSeconds` of 0 when the window is too
 * short or the chain is flat — never a fabricated rate.
 */
export function timeRate(
  ancestors: MeasuredBlock[],
  windowSeconds: number = CONSENSUS_PARAMS.proofOfTime.timeRateWindowSeconds,
): TimeRate {
  const cutoffSeconds = windowSeconds;
  const tip = ancestors[0];
  if (!tip) {
    return emptyTimeRate('no blocks in the measurement window');
  }
  const tipTime = Math.trunc(tip.timestamp);
  const measured: MeasuredBlock[] = [];
  for (const block of ancestors) {
    const age = tipTime - Math.trunc(block.timestamp);
    if (age > cutoffSeconds) break;
    measured.push(block);
  }
  const oldest = measured[measured.length - 1];
  const covered = tipTime - Math.trunc(oldest.timestamp);
  if (measured.length < 2 || covered <= 0) {
    return emptyTimeRate('fewer than two blocks in the window, or no time elapsed between them');
  }
  const blocks = measured.length;
  const transactions = measured.reduce((sum, block) => sum + (block.txCount ?? 0), 0);
  const gaps = blocks - 1;
  const difficulty = potDifficulty(ancestors === measured ? ancestors : measured, 0);
  return {
    blocksPerMinute: round6((gaps * 60) / covered),
    transactionsPerMinute: round6((transactions * 60) / covered),
    blocks,
    transactions,
    windowSeconds: covered,
    observedSpacingMs: Math.floor((covered * 1000) / gaps),
    difficultyBps: difficulty.difficultyBps,
    unit: 'BLOCKS_AND_TXS_PER_MINUTE',
    method: `${gaps} verified blocks and ${transactions} verified transactions over ${covered}s of protocol time`,
  };
}

function emptyTimeRate(why: string): TimeRate {
  return {
    blocksPerMinute: 0,
    transactionsPerMinute: 0,
    blocks: 0,
    transactions: 0,
    windowSeconds: 0,
    observedSpacingMs: 0,
    difficultyBps: 10_000,
    unit: 'BLOCKS_AND_TXS_PER_MINUTE',
    method: why,
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
