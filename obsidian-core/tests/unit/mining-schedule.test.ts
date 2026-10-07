/**
 * Unit tests for the mining emission schedule and claim eligibility rules
 * (spec §17–§27, §73).
 *
 * These are the rules an attacker would target first, so they are tested as
 * pure functions AND audited for hidden clock or environment dependencies.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  claimRewardForActiveMiners,
  dailyRewardForActiveMiners,
  issuanceCeilingSeals,
  scheduleView,
} from '../../src/mining/schedule.js';
import { alignedCycleStart, cycleEndsAt, evaluateMining, freshMiningState } from '../../src/mining/rules.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { buildGenesisBlock, createGenesisState } from '../../src/genesis/initialize.js';
import type { Account, MiningState } from '../../src/protocol/types.js';
import { DEVNET } from '../helpers/harness.js';

const INITIAL_DAILY = parseObs('0.001');
const PER_CLAIM = 166_666_666_666_666n; // floor(0.001 / 6) OBS
const FLOOR_DAILY = parseObs('0.0002');

function scratchAccount(mining?: Partial<MiningState>): Account {
  const state = createGenesisState(buildGenesisBlock(DEVNET_GENESIS, DEVNET), DEVNET);
  state.credit('obs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5z3j', 1n, { height: 1, timestamp: 1 }, 'test fixture');
  const account = state.getAccount('obs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqr5z3j')!;
  if (mining) account.mining = { ...freshMiningState(1_000_000), ...mining };
  return account;
}

const DEVNET_GENESIS = {
  networkId: DEVNET.networkId,
  chainId: DEVNET.chainId,
  protocolVersion: '1.0.0',
  timestamp: 1_767_225_600,
  note: 'unit test genesis',
};

describe('emission schedule', () => {
  it('starts at the genesis-era rate of 0.001 OBS per day', () => {
    expect(dailyRewardForActiveMiners(0)).toBe(INITIAL_DAILY);
    expect(claimRewardForActiveMiners(0)).toBe(PER_CLAIM);
    expect(formatObs(PER_CLAIM)).toBe('0.000166666666666666');
  });

  it('reduces by exactly 0.5% per 100,000 active miners', () => {
    const one = dailyRewardForActiveMiners(100_000);
    expect(one).toBe(995_000_000_000_000n); // 0.000995 OBS
    const two = dailyRewardForActiveMiners(200_000);
    expect(two).toBe((995_000_000_000_000n * 9_950n) / 10_000n);
    expect(two).toBeLessThan(one);
  });

  it('never crosses the 0.0002 OBS per day hard floor', () => {
    // The floor binds after ~322 reduction steps (0.995^322 < 0.2).
    for (const miners of [100_000_000, 1_000_000_000, 10_000_000_000]) {
      expect(dailyRewardForActiveMiners(miners)).toBe(FLOOR_DAILY);
      expect(claimRewardForActiveMiners(miners)).toBe(FLOOR_DAILY / 6n);
    }
  });

  it('is monotonically non-increasing in the miner count', () => {
    let previous = INITIAL_DAILY;
    for (const miners of [0, 50_000, 100_000, 250_000, 500_000, 1_000_000]) {
      const daily = dailyRewardForActiveMiners(miners);
      expect(daily).toBeLessThanOrEqual(previous);
      expect(daily).toBeGreaterThanOrEqual(FLOOR_DAILY);
      previous = daily;
    }
  });

  it('is a protocol constant across nodes (no randomness, no floats)', () => {
    const values = [0, 100_000, 999_999].map((m) => dailyRewardForActiveMiners(m).toString());
    expect(values).toEqual([0, 100_000, 999_999].map((m) => dailyRewardForActiveMiners(m).toString()));
    expect(() => dailyRewardForActiveMiners(-1)).toThrow();
    expect(() => dailyRewardForActiveMiners(Number.NaN)).toThrow();
  });

  it('exposes a deterministic schedule view for the interface', () => {
    const view = scheduleView(0);
    expect(view.claimRewardObs).toBe('0.000166666666666666');
    expect(view.floorDailyObs).toBe('0.0002');
    expect(view.claimsPerCycle).toBe(6);
    expect(view.intervalSeconds).toBe(4 * 60 * 60);
  });

  it('keeps the emission ceiling above any possible honest issuance', () => {
    expect(issuanceCeilingSeals(0)).toBe(0n);
    expect(issuanceCeilingSeals(100_000)).toBeGreaterThan(0n);
    expect(issuanceCeilingSeals(100_000)).toBeGreaterThan(
      BigInt(100_000) * BigInt(CONSENSUS_PARAMS.mining.maxClaimsPerCycle) * PER_CLAIM,
    );
  });
});

describe('claim eligibility', () => {
  const T = 1_800_000_000;

  it('allows a brand-new wallet to claim immediately', () => {
    const result = evaluateMining(undefined, T, 0, false);
    expect(result.eligible).toBe(true);
    expect(result.reason).toBe(ErrCode.OK);
    expect(result.nextClaimSequence).toBe(1);
    expect(result.rewardPerClaim).toBe(PER_CLAIM);
    expect(result.genesisEligible).toBe(true);
    expect(result.secondsRemaining).toBe(0);
  });

  it('does not offer the genesis allocation once it has been claimed', () => {
    expect(evaluateMining(undefined, T, 0, true).genesisEligible).toBe(false);
  });

  it('enforces the 4-hour interval between claims', () => {
    const interval = CONSENSUS_PARAMS.mining.claimIntervalSeconds;
    const tooSoon = evaluateMining(scratchAccount({ lastClaimAt: T - 10 }), T, 0, true);
    expect(tooSoon.eligible).toBe(false);
    expect(tooSoon.reason).toBe(ErrCode.MINING_TOO_SOON);
    expect(tooSoon.nextEligibleAt).toBe(T - 10 + interval);
    expect(tooSoon.secondsRemaining).toBe(interval - 10);

    const due = evaluateMining(scratchAccount({ lastClaimAt: T - interval }), T, 0, true);
    expect(due.eligible).toBe(true);
  });

  it('enforces the 6-claims-per-24-hour cycle limit', () => {
    const cycleStart = alignedCycleStart(T);
    const spent = evaluateMining(
      scratchAccount({ lastClaimAt: T - 60 * 60 * 24, cycleStartAt: cycleStart, claimsThisCycle: 6 }),
      T,
      0,
      true,
    );
    expect(spent.eligible).toBe(false);
    expect(spent.reason).toBe(ErrCode.MINING_CYCLE_LIMIT);
    expect(spent.nextEligibleAt).toBe(cycleEndsAt(cycleStart));
    expect(spent.claimsRemainingInCycle).toBe(0);
  });

  it('resets the cycle counter in a new 24-hour window', () => {
    const previousCycle = alignedCycleStart(T) - CONSENSUS_PARAMS.mining.cycleSeconds;
    const result = evaluateMining(
      scratchAccount({ lastClaimAt: previousCycle, cycleStartAt: previousCycle, claimsThisCycle: 6 }),
      T,
      0,
      true,
    );
    expect(result.claimsThisCycle).toBe(0);
    expect(result.eligible).toBe(true);
  });


  it('depends only on protocol state, never on the device clock', () => {
    const account = scratchAccount({ lastClaimAt: T - 100 });
    const before = evaluateMining(account, T, 5_000, false);
    vi.setSystemTime(new Date('2031-05-05T05:05:05Z'));
    const after = evaluateMining(account, T, 5_000, false);
    vi.useRealTimers();
    expect(after).toEqual(before);
  });

  it('pays less as the active-miner count grows, never below the floor', () => {
    const small = evaluateMining(undefined, T, 0, true).rewardPerClaim;
    const large = evaluateMining(undefined, T, 500_000, true).rewardPerClaim;
    const huge = evaluateMining(undefined, T, 500_000_000, true).rewardPerClaim;
    expect(large).toBeLessThan(small);
    expect(huge).toBe(FLOOR_DAILY / 6n);
  });
});

describe('clock independence audit', () => {
  it('never reads the wall clock in mining or schedule code', () => {
    for (const file of ['src/mining/rules.ts', 'src/mining/schedule.ts']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/Date\.now|new Date\(|performance\.now|hrtime/);
    }
  });

  it('never reads the wall clock in reward-affecting transaction helpers', () => {
    for (const file of ['src/transactions/helpers.ts', 'src/protocol/amount.ts']) {
      const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      expect(source).not.toMatch(/Date\.now|new Date\(/);
    }
  });
});
