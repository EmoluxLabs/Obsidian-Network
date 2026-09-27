/**
 * Obsidian mining emission schedule — pure, deterministic, integer-only.
 *
 * Rules (spec §21, §23):
 *   - 6 claims per 24-hour cycle, one every 4 hours.
 *   - Genesis-era network emission: 0.001 OBS per 24 hours.
 *   - Per-claim reward = floor(dailyReward / 6) = 0.000166666666666666 OBS.
 *   - Reduction: 0.5% per 100,000 active miners (compounding, floor-rounded).
 *   - Hard floor: 0.0002 OBS per 24 hours, never crossed.
 *
 * Every node computes the identical value from the identical inputs, so no
 * client-side calculation, oracle or administrator can alter a reward.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { divFloor } from '../protocol/amount.js';

const SCALE = 10_000n; // basis-point denominator
const KEEP = SCALE - BigInt(CONSENSUS_PARAMS.mining.reductionBasisPointsPerStep); // 9950

/**
 * Daily network emission for a given active-miner count.
 * reward = max(floor, floor(initial * (9950/10000)^steps))
 * where steps = floor(activeMiners / 100000).
 */
export function dailyRewardForActiveMiners(activeMiners: number): bigint {
  const { initialDailyReward, dailyRewardFloor, reductionStepMiners } = CONSENSUS_PARAMS.mining;
  if (!Number.isFinite(activeMiners) || activeMiners < 0) {
    throw new Error('activeMiners must be a non-negative finite number');
  }
  let steps = Math.floor(activeMiners / reductionStepMiners);
  // Fast-exit: the floor is reached long before any realistic miner count.
  const maxUsefulSteps = 4_000;
  if (steps > maxUsefulSteps) steps = maxUsefulSteps;

  let numerator = initialDailyReward;
  let denominator = 1n;
  for (let i = 0; i < steps; i += 1) {
    numerator *= KEEP;
    denominator *= SCALE;
    // Keep the working numbers bounded; the ratio converges and the floor
    // dominates long before this matters.
    if (numerator < denominator) {
      return dailyRewardFloor;
    }
  }
  const reward = divFloor(numerator, denominator);
  return reward < dailyRewardFloor ? dailyRewardFloor : reward;
}

/** Reward paid for one accepted claim at a given active-miner count. */
export function claimRewardForActiveMiners(activeMiners: number): bigint {
  const daily = dailyRewardForActiveMiners(activeMiners);
  const perClaim = divFloor(daily, BigInt(CONSENSUS_PARAMS.mining.maxClaimsPerCycle));
  const floorPerClaim = divFloor(
    CONSENSUS_PARAMS.mining.dailyRewardFloor,
    BigInt(CONSENSUS_PARAMS.mining.maxClaimsPerCycle),
  );
  return perClaim < floorPerClaim ? floorPerClaim : perClaim;
}

/**
 * Emission ceiling for a given height — the maximum OBS that may ever have been
 * issued by mining up to that point. Used as a belt-and-braces assertion: an
 * implementation that drifts above this schedule is rejected by peers.
 *
 * The ceiling is intentionally generous (initial daily reward at the floor
 * applied for the whole history) because issuance is also gated by the supply
 * invariant; this function exists to make gross emission bugs impossible.
 */
export function issuanceCeilingSeals(height: number): bigint {
  const claims = BigInt(Math.max(0, height)) * 1n;
  const maxClaimsPerHeight =
    BigInt(CONSENSUS_PARAMS.block.maxBlockTransactions) * BigInt(CONSENSUS_PARAMS.mining.maxClaimsPerCycle);
  const perClaimCeiling = claimRewardForActiveMiners(0);
  return claims * maxClaimsPerHeight * perClaimCeiling;
}

export interface MiningScheduleView {
  activeMiners: number;
  dailyRewardSeals: bigint;
  dailyRewardObs: string;
  claimRewardSeals: bigint;
  claimRewardObs: string;
  reductionPercentPerStep: number;
  reductionStepMiners: number;
  floorDailySeals: bigint;
  floorDailyObs: string;
  claimsPerCycle: number;
  intervalSeconds: number;
}

export function scheduleView(activeMiners: number): MiningScheduleView {
  const daily = dailyRewardForActiveMiners(activeMiners);
  const claim = claimRewardForActiveMiners(activeMiners);
  return {
    activeMiners,
    dailyRewardSeals: daily,
    dailyRewardObs: formatObsAmount(daily),
    claimRewardSeals: claim,
    claimRewardObs: formatObsAmount(claim),
    reductionPercentPerStep: CONSENSUS_PARAMS.mining.reductionBasisPointsPerStep / 100,
    reductionStepMiners: CONSENSUS_PARAMS.mining.reductionStepMiners,
    floorDailySeals: CONSENSUS_PARAMS.mining.dailyRewardFloor,
    floorDailyObs: formatObsAmount(CONSENSUS_PARAMS.mining.dailyRewardFloor),
    claimsPerCycle: CONSENSUS_PARAMS.mining.maxClaimsPerCycle,
    intervalSeconds: CONSENSUS_PARAMS.mining.claimIntervalSeconds,
  };
}

/** Full-precision formatting (no rounding) for the mining schedule. */
function formatObsAmount(seals: bigint): string {
  const whole = seals / 10n ** 18n;
  const frac = (seals % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac.length ? `${whole}.${frac}` : whole.toString();
}
