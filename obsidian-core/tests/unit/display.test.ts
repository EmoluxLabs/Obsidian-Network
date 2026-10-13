/**
 * Display formatting: exact, locale-free, never scientific, never silently zero.
 *
 * The same vectors (tests/vectors/display.json) are run against the Web App's mirror in
 * obsidian-app-web/tests/display-parity.test.mjs, so a number reads the same in every interface.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  displayDecimal,
  displayInteger,
  displayObs,
  displayObsWithUnit,
  displaySeals,
  groupDigits,
  isMaskedIdentifier,
  shortenIdentifier,
  UNAVAILABLE,
} from '../../src/protocol/display.js';
import { MAX_SUPPLY_SEALS, OBS_UNIT, formatObs, parseObs } from '../../src/protocol/amount.js';

const vectors = JSON.parse(readFileSync(resolve(__dirname, '../../../tests/vectors/display.json'), 'utf8'));

describe('shared vectors', () => {
  for (const v of vectors.obs) {
    it(`amount ${JSON.stringify(v.in)} ${v.opts ? JSON.stringify(v.opts) : ''} -> ${v.out}`, () => {
      const fn = v.kind === 'decimal' ? displayDecimal : displayObs;
      expect(fn(v.in, v.opts)).toBe(v.out);
    });
  }
  for (const v of vectors.integers) {
    it(`integer ${JSON.stringify(v.in)} -> ${v.out}`, () => expect(displayInteger(v.in)).toBe(v.out));
  }
  for (const v of vectors.identifiers) {
    it(`identifier ${String(v.in).slice(0, 14)} (${v.kind}, ${v.width}) -> ${v.out}`, () => {
      expect(shortenIdentifier(v.in, v.kind, v.width)).toBe(v.out);
    });
  }
});

describe('the figures the products state', () => {
  it('ONS registration fee, maximum supply and genesis allocation', () => {
    expect(displayObsWithUnit('0.05000000000000000000')).toBe('0.05 OBS');
    expect(displayObsWithUnit(MAX_SUPPLY_SEALS)).toBe('21,000,000 OBS');
    expect(displayObsWithUnit('21000000.00000000000000000000')).toBe('21,000,000 OBS');
    expect(displayObsWithUnit('100000.00000000000000000000')).toBe('100,000 OBS');
    expect(displayObsWithUnit(0n)).toBe('0 OBS');
    expect(displayObsWithUnit('0.000000000000000001')).toBe('0.000000000000000001 OBS');
  });
  it('a missing value is the unavailable mark with no unit, never zero', () => {
    expect(displayObsWithUnit(undefined)).toBe(UNAVAILABLE);
    expect(displayObsWithUnit('not a number')).toBe(UNAVAILABLE);
    expect(displayObs(5 as unknown as string)).toBe(UNAVAILABLE); // a float cannot carry a token quantity
  });
});

describe('exactness', () => {
  it('displays every seal of a balance past 2^53 without rounding', () => {
    const seals = 9_007_199_254_740_993n * 1000n + 7n;
    const text = displaySeals(seals, { group: false });
    expect(parseObs(text)).toBe(seals);
  });

  it('round-trips with the protocol parser for every shape of amount (no digit lost, no digit added)', () => {
    const samples = [0n, 1n, 9n, 10n, 999n, 10n ** 17n, 10n ** 18n - 1n, OBS_UNIT, OBS_UNIT + 1n, 166666666666666n, 123456789012345678901234567890n, MAX_SUPPLY_SEALS];
    let x = 88172645463325252n;
    for (let i = 0; i < 400; i += 1) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 90n) - 1n);
      samples.push(x);
    }
    for (const seals of samples) {
      const shown = displaySeals(seals, { group: false });
      expect(shown).not.toMatch(/e|E|<|\.$/);
      expect(parseObs(shown)).toBe(seals);
      // the display agrees with the protocol's own formatter once its trailing zeros are removed
      expect(shown).toBe(formatObs(seals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
      // grouping changes only the commas
      expect(displaySeals(seals).replace(/,/g, '')).toBe(shown);
    }
  });

  it('a reduced precision cuts down and never rounds up', () => {
    expect(displayDecimal('0.999999999', { maxDecimals: 3 })).toBe('0.999');
    expect(displayDecimal('2.9999', { maxDecimals: 0 })).toBe('2');
  });

  it('never shows a non-zero amount as zero at any precision', () => {
    for (let d = 0; d <= 18; d += 1) {
      for (const text of ['0.000000000000000001', '0.000000000000000999', '0.4']) {
        const shown = displayDecimal(text, { maxDecimals: d });
        expect(shown, `${text} at ${d}`).not.toBe('0');
        expect(shown, `${text} at ${d}`).not.toBe('');
      }
    }
  });

  it('never produces scientific notation', () => {
    for (const text of ['1e-18', '1E3', '5e+2', '0x10', 'Infinity', 'NaN']) expect(displayObs(text)).toBe(UNAVAILABLE);
  });

  it('groups digits in threes and leaves the rest alone', () => {
    expect(groupDigits('1')).toBe('1');
    expect(groupDigits('1000')).toBe('1,000');
    expect(groupDigits('1234567')).toBe('1,234,567');
  });
});

describe('identifiers', () => {
  it('shortens for display and leaves the original untouched', () => {
    const address = 'obs1abcdefghijklmnopqrstuvwxyz123456789';
    const shown = shortenIdentifier(address);
    expect(shown).toBe('obs1abcd...456789');
    expect(address).toBe('obs1abcdefghijklmnopqrstuvwxyz123456789');
    expect(shown.length).toBeLessThan(address.length);
    expect(shown.startsWith(address.slice(0, 8)) && shown.endsWith(address.slice(-6))).toBe(true);
  });
  it('leaves a value the node already masked exactly as it came', () => {
    expect(isMaskedIdentifier('obs1ab…wxyz')).toBe(true);
    expect(isMaskedIdentifier('obs1abcdefghijklmnopqrstuvwxyz123456789')).toBe(false);
  });
  it('keeps a value that would not get shorter', () => {
    expect(shortenIdentifier('obs1short')).toBe('obs1short');
  });
});
