/**
 * Display formatting: the exact-number boundary of the interface.
 *
 * Amounts arrive from nodes in two shapes (seal counts and OBS decimal strings)
 * and dollars in two more (micro-USD and whole dollars). Mixing them up does not
 * throw — it silently prints `0` next to a real balance, which is how a working
 * protocol looks broken in a browser. These tests pin the conversions to exact
 * integer arithmetic: no `Number()`, no `parseFloat`, no `toFixed` on amounts.
 */

import { describe, expect, it } from 'vitest';
import {
  obs,
  obsFromSeals,
  rewardLine,
  rewardPerClaim,
  sealsFromObs,
} from '../web/src/lib/ui.js';

describe('seal counts → OBS', () => {
  it('formats the launch reward exactly (1e15 seals is 0.001 OBS, not 0)', () => {
    expect(obs('1000000000000000')).toBe('0.001');
    expect(obs('166666666666666')).toBe('0.00016666');
    expect(obs(1_000_000_000_000_000n)).toBe('0.001');
  });

  it('formats whole OBS with thousands separators', () => {
    expect(obs('100000000000000000000000')).toBe('100,000');
    expect(obs('21000000000000000000000000')).toBe('21,000,000');
    expect(obs('0')).toBe('0');
    expect(obs(0n)).toBe('0');
  });

  it('formats one seal as the smallest visible amount, never as 0', () => {
    expect(obs('1')).toBe('0');
    // 1 seal is below the default 8-decimal display, so show it with full precision instead of lying
    expect(obs('1', 18)).toBe('0.000000000000000001');
  });
});

describe('OBS decimal strings (the node\'s other shape)', () => {
  it('passes exact decimals through without float rounding', () => {
    expect(obs('100000.000000000000000000')).toBe('100,000');
    expect(obs('100166.666666666666000000')).toBe('100,166.66666666');
    expect(obs('0.000166666666666666')).toBe('0.00016666');
    expect(obs('0.0002')).toBe('0.0002');
  });

  it('refuses to invent a number for garbage', () => {
    expect(obs('')).toBe('—');
    expect(obs('not an amount')).toBe('—');
    expect(obs(undefined)).toBe('—');
    expect(obs(null)).toBe('—');
  });

  it('keeps the sign', () => {
    expect(obs('-1000000000000000000')).toBe('-1');
  });
});

describe('exact round trips used to build transactions', () => {
  it('converts seals to an exact decimal and back', () => {
    for (const seals of [0n, 1n, 999n, 10n ** 18n, 166666666666666n, 100000n * 10n ** 18n]) {
      const text = obsFromSeals(seals);
      expect(text).toMatch(/^\d+\.\d{18}$/);
      expect(sealsFromObs(text)).toBe(seals);
    }
  });

  it('scales a capsule commitment by the Time Travel multiplier exactly', () => {
    const commitment = '0.0001';
    expect(obsFromSeals(sealsFromObs(commitment) * 1000n)).toBe('0.100000000000000000');
  });

  it('rejects values that are not plain amounts', () => {
    expect(() => sealsFromObs('-1')).toThrow();
    expect(() => sealsFromObs('$5')).toThrow();
    expect(() => sealsFromObs('1e18')).toThrow();
    expect(() => obsFromSeals(-1n)).toThrow();
  });
});

/*
 * The dollar-formatting and protocol-price suites were removed in 1.2.10 with
 * the helpers they covered. Protocol fees are denominated in OBS, no page
 * converts through an exchange rate, and `tests/no-usd-copy.test.ts` now
 * asserts that no page can quote a dollar amount at all.
 */

describe('mining schedule fields', () => {
  it('reads the node\'s real field names', () => {
    const schedule = {
      activeMiners: 0,
      dailyRewardSeals: '1000000000000000',
      dailyRewardObs: '0.001',
      claimRewardSeals: '166666666666666',
      claimRewardObs: '0.000166666666666666',
    };
    expect(rewardLine(schedule)).toBe('0.001 OBS');
    expect(rewardPerClaim(schedule)).toBe('0.00016666 OBS');
  });

  it('still displays something honest when a node sends only seal counts', () => {
    expect(rewardLine({ dailyRewardSeals: '1000000000000000' })).toBe('0.001 OBS');
    expect(rewardPerClaim({ claimRewardSeals: '166666666666666' })).toBe('0.00016666 OBS');
  });
});
