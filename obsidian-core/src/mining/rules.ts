/**
 * Mining eligibility rules — the anti-cheat core.
 *
 * ELIGIBILITY IS A FUNCTION OF PROTOCOL STATE AND THE INCLUDING BLOCK'S
 * TIMESTAMP ONLY. Nothing here can be influenced by:
 *   - the user's device clock, timezone, cookies or local storage;
 *   - a frontend countdown;
 *   - the HTTP request time;
 *   - a node operator's wall clock (the block timestamp is bounded by the
 *     median-time-past rule and a 60-second future drift limit);
 *   - retries, duplicate requests or multiple tabs (claim ids and nonces are
 *     unique per attempt and replay-protected in state).
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { ErrCode, reject } from '../protocol/errors.js';
import type { Account, MiningState } from '../protocol/types.js';
import { claimRewardForActiveMiners } from './schedule.js';

export interface MiningEligibility {
  eligible: boolean;
  /** Protocol time (seconds) at which the wallet may next claim. */
  nextEligibleAt: number;
  /** Remaining seconds, floored at zero (UI hint only — never authority). */
  secondsRemaining: number;
  claimsThisCycle: number;
  claimsRemainingInCycle: number;
  cycleStartAt: number;
  cycleEndsAt: number;
  nextClaimSequence: number;
  rewardPerClaim: bigint;
  reason: ErrCode;
  /** True when this wallet would receive the one-time Genesis Allocation. */
  genesisEligible: boolean;
}

/** Aligned claim cycle window that every node agrees on. */
export function alignedCycleStart(protocolTime: number): number {
  const cycle = CONSENSUS_PARAMS.mining.cycleSeconds;
  return Math.floor(protocolTime / cycle) * cycle;
}

export function cycleEndsAt(cycleStart: number): number {
  return cycleStart + CONSENSUS_PARAMS.mining.cycleSeconds;
}

export function freshMiningState(protocolTime: number): MiningState {
  return {
    claimSequence: 1,
    lastClaimAt: 0,
    lastClaimHeight: 0,
    cycleStartAt: alignedCycleStart(protocolTime),
    claimsThisCycle: 0,
    totalClaims: 0,
    totalReward: 0n,
    eligible: false,
  };
}

/**
 * Evaluate eligibility for `address` at `protocolTime`.
 *
 * Determinism note: the returned object is a pure function of
 * (account.mining, protocolTime, metrics.activeMiners, genesis state).
 */
export function evaluateMining(
  account: Account | undefined,
  protocolTime: number,
  activeMiners: number,
  genesisClaimed: boolean,
): MiningEligibility {
  const interval = CONSENSUS_PARAMS.mining.claimIntervalSeconds;
  const maxClaims = CONSENSUS_PARAMS.mining.maxClaimsPerCycle;
  const rewardPerClaim = claimRewardForActiveMiners(activeMiners);

  const mining = account?.mining;
  const cycleStart = alignedCycleStart(protocolTime);
  const sameCycle = mining ? mining.cycleStartAt === cycleStart : true;
  const claimsThisCycle = mining && sameCycle ? mining.claimsThisCycle : 0;

  const base: Omit<MiningEligibility, 'eligible' | 'nextEligibleAt' | 'secondsRemaining' | 'reason'> = {
    claimsThisCycle,
    claimsRemainingInCycle: Math.max(0, maxClaims - claimsThisCycle),
    cycleStartAt: cycleStart,
    cycleEndsAt: cycleEndsAt(cycleStart),
    nextClaimSequence: mining ? mining.claimSequence : 1,
    rewardPerClaim,
    genesisEligible: !genesisClaimed,
  };

  const ineligible = (nextEligibleAt: number, reason: ErrCode): MiningEligibility => ({
    ...base,
    eligible: false,
    nextEligibleAt,
    secondsRemaining: Math.max(0, nextEligibleAt - protocolTime),
    reason,
  });


  if (claimsThisCycle >= maxClaims) {
    return ineligible(cycleEndsAt(cycleStart), ErrCode.MINING_CYCLE_LIMIT);
  }

  const lastClaimAt = mining?.lastClaimAt ?? 0;
  const firstClaimAt = lastClaimAt === 0 ? 0 : lastClaimAt + interval;
  if (lastClaimAt !== 0 && protocolTime < firstClaimAt) {
    return ineligible(firstClaimAt, ErrCode.MINING_TOO_SOON);
  }

  return {
    ...base,
    eligible: true,
    nextEligibleAt: protocolTime,
    secondsRemaining: 0,
    reason: ErrCode.OK,
  };
}

/** Throwing form used inside the state machine. */
export function assertMiningEligibility(
  account: Account | undefined,
  protocolTime: number,
  activeMiners: number,
  genesisClaimed: boolean,
): MiningEligibility {
  const eligibility = evaluateMining(account, protocolTime, activeMiners, genesisClaimed);
  if (!eligibility.eligible) {
    reject(eligibility.reason, 'mining claim rejected by protocol eligibility rules', {
      nextEligibleAt: eligibility.nextEligibleAt,
      protocolTime,
      claimsThisCycle: eligibility.claimsThisCycle,
    });
  }
  return eligibility;
}

/**
 * Max claims one wallet may place in a single block. Prevents a producer from
 * bundling a queue of claims to fast-forward a wallet's history.
 */
export const MAX_CLAIMS_PER_BLOCK_PER_WALLET = CONSENSUS_PARAMS.mining.maxClaimsPerBlockPerWallet;
