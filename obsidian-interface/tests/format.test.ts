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
  oraclePriceMicro,
  oraclePriceText,
  rewardLine,
  rewardPerClaim,
  sealsFromObs,
  usd,
  usdDollars,
  usdMicroFromDollars,
  usdText,
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

describe('dollar formatting', () => {
  it('formats micro-USD exactly', () => {
    expect(usd('50000000')).toBe('$50');
    expect(usd('50000000', 2)).toBe('$50');
    expect(usd('50123456')).toBe('$50.12');
    expect(usd('20403550000', 2)).toBe('$20,403.55');
    expect(usd('0')).toBe('$0');
  });

  it('formats whole-dollar registry values as dollars, not as micro-USD', () => {
    // /land/countries sends "20403" meaning $20,403 — read as micro-USD it would print $0.02.
    expect(usdDollars('20403')).toBe('$20,403');
    expect(usdDollars('20403', 2)).toBe('$20,403');
    expect(usdDollars('100')).toBe('$100');
  });

  it('passes through amounts the node already formatted', () => {
    expect(usdText('$20,403.55')).toBe('$20,403.55');
    expect(usdDollars('$100')).toBe('$100');
    expect(usd(undefined)).toBe('—');
  });

  it('converts dollars to micro-USD without a float', () => {
    expect(usdMicroFromDollars('50.00')).toBe(50_000_000n);
    expect(usdMicroFromDollars('5.000000')).toBe(5_000_000n);
    expect(usdMicroFromDollars('0.01')).toBe(10_000n);
    expect(() => usdMicroFromDollars('$5')).toThrow();
  });

  it('converts the registration fee to OBS at the protocol median exactly', () => {
    // $5.00 at $50.10/OBS = 0.099800399201596806 OBS (truncated to seals).
    const fee = usdMicroFromDollars('5.000000');
    const price = oraclePriceMicro({ usable: true, priceUsdMicro: '50100000' })!;
    expect(obsFromSeals((fee * 10n ** 18n) / price)).toBe('0.099800399201596806');
  });
});

describe('protocol price display', () => {
  it('shows a price only when the node says the feed is usable', () => {
    expect(oraclePriceText({ usable: true, priceUsd: '$50.1', priceUsdMicro: '50100000' })).toBe('$50.1');
    expect(oraclePriceText({ usable: false, priceUsd: '$50.1' })).toBe('no price yet');
    expect(oraclePriceText(undefined)).toBe('no price yet');
  });

  it('gives the fee maths a median only when the feed is usable', () => {
    expect(oraclePriceMicro({ usable: true, priceUsdMicro: '50100000' })).toBe(50_100_000n);
    expect(oraclePriceMicro({ usable: false, priceUsdMicro: '50100000' })).toBeUndefined();
    expect(oraclePriceMicro({ usable: true, priceUsdMicro: '0' })).toBeUndefined();
  });
});

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
