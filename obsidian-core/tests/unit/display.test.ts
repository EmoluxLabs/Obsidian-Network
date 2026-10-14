/**
 * Display formatting: at most 6 decimals, rounded to nearest, locale-free, never scientific, never silently zero.
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
  DISPLAY_DECIMALS,
  EXACT_OBS,
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
  });
  it('the mining figures a holder actually reads', () => {
    expect(displayObsWithUnit('99999.820626666666666664')).toBe('99,999.820627 OBS');
    expect(displayObsWithUnit('100000.000626666666666664')).toBe('100,000.000627 OBS');
    expect(displayObsWithUnit('0.000626666666666664')).toBe('0.000627 OBS');
    expect(displayObsWithUnit('0.000166666666666666')).toBe('0.000167 OBS');
  });
  it('a missing value is the unavailable mark with no unit, never zero', () => {
    expect(displayObsWithUnit(undefined)).toBe(UNAVAILABLE);
    expect(displayObsWithUnit(null)).toBe(UNAVAILABLE);
    expect(displayObsWithUnit('not a number')).toBe(UNAVAILABLE);
    expect(displayObs(5 as unknown as string)).toBe(UNAVAILABLE); // a float cannot carry a token quantity
    expect(displayObs(Number.NaN as unknown as string)).toBe(UNAVAILABLE);
    expect(displayObs({} as unknown as string)).toBe(UNAVAILABLE);
  });
});

describe('the display policy', () => {
  it('shows at most six fractional digits, and says so', () => {
    expect(DISPLAY_DECIMALS).toBe(6);
    const samples = [1n, 999n, 166666666666666n, 626666666666664n, 99999820626666666666664000n, 10n ** 18n + 1n, 123456789012345678901234567890n, MAX_SUPPLY_SEALS];
    let x = 88172645463325252n;
    for (let i = 0; i < 400; i += 1) {
      x = (x * 6364136223846793005n + 1442695040888963407n) & ((1n << 90n) - 1n);
      samples.push(x);
    }
    for (const seals of samples) {
      const shown = displaySeals(seals);
      expect(shown).not.toMatch(/e|E|\.$/);
      expect(shown.replace(/^</, '').split('.')[1]?.length ?? 0).toBeLessThanOrEqual(6);
      // the exact view never loses a digit
      expect(parseObs(displaySeals(seals, { ...EXACT_OBS, group: false }))).toBe(seals);
    }
  });

  it('rounds to the nearest unit, ties away from zero, with a carry into the whole part', () => {
    expect(displayDecimal('0.0000005')).toBe('0.000001'); // exactly half: up
    expect(displayDecimal('0.0000004999999999')).toBe('<0.000001'); // just below half: hidden, not zero
    expect(displayDecimal('0.0000015')).toBe('0.000002');
    expect(displayDecimal('0.0000014999')).toBe('0.000001');
    expect(displayDecimal('0.9999995')).toBe('1');
    expect(displayDecimal('0.9999994999')).toBe('0.999999');
    expect(displayDecimal('99999.9999995')).toBe('100,000');
    expect(displayDecimal('-1.2345675')).toBe('-1.234568'); // away from zero, symmetric
    expect(displayDecimal('2.5', { maxDecimals: 0 })).toBe('3');
    expect(displayDecimal('2.4999', { maxDecimals: 0 })).toBe('2');
  });

  it('removes trailing zeros and a dangling point', () => {
    expect(displayDecimal('12.340000')).toBe('12.34');
    expect(displayDecimal('100000.000000')).toBe('100,000');
    expect(displayDecimal('0.100000')).toBe('0.1');
    expect(displayDecimal('0.000000')).toBe('0');
  });

  it('a non-zero amount below the shown precision is never shown as 0', () => {
    for (const text of ['0.000000000000000001', '0.000000000000000999', '0.0000004', '0.0000004999999999']) {
      expect(displayDecimal(text)).toBe('<0.000001');
      expect(displayDecimal(text)).not.toBe('0');
    }
    expect(displayDecimal('-0.0000001')).toBe('>-0.000001');
    expect(displaySeals(1n)).toBe('<0.000001');
    expect(displaySeals(1n, EXACT_OBS)).toBe('0.000000000000000001');
    expect(displayObsWithUnit(1n)).toBe('<0.000001 OBS');
    for (let d = 0; d <= 18; d += 1) {
      for (const text of ['0.000000000000000001', '0.000000000000000999', '0.4']) {
        const shown = displayDecimal(text, { maxDecimals: d });
        expect(shown, `${text} at ${d}`).not.toBe('0');
        expect(shown, `${text} at ${d}`).not.toBe('');
      }
    }
  });

  it('a genuine zero is 0, and zero is never given the "less than" form', () => {
    for (const z of ['0', '0.0', '0.000000000000000000', '-0', '000']) expect(displayDecimal(z)).toBe('0');
    expect(displayObs(0n)).toBe('0');
    expect(displaySeals(0n)).toBe('0');
    expect(displayObsWithUnit(0n)).toBe('0 OBS');
  });

  it('the detail view carries every digit the protocol holds', () => {
    expect(displayDecimal('99999.820626666666666664', EXACT_OBS)).toBe('99,999.820626666666666664');
    expect(displaySeals(166666666666666n, EXACT_OBS)).toBe('0.000166666666666666');
    expect(displaySeals(21_000_000n * OBS_UNIT, EXACT_OBS)).toBe('21,000,000');
  });

  it('keeps very large values exact in the whole part', () => {
    expect(displaySeals(123456789012345678901234567890n)).toBe('123,456,789,012.345679');
    expect(displaySeals(MAX_SUPPLY_SEALS)).toBe('21,000,000');
  });

  it('never produces scientific notation', () => {
    for (const text of ['1e-18', '1E3', '5e+2', '0x10', 'Infinity', 'NaN']) expect(displayObs(text)).toBe(UNAVAILABLE);
  });

  it('does not touch the value: formatting is read-only and the protocol formatter is unchanged', () => {
    const seals = parseObs('99999.820626666666666664');
    displaySeals(seals);
    expect(formatObs(seals)).toBe('99999.820626666666666664');
    expect(parseObs('99999.820626666666666664')).toBe(seals);
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

// ── the Mining Pool view ─────────────────────────────────────────────────────

import { describeMiningPool } from '../../src/protocol/display.js';

const poolVectors = JSON.parse(readFileSync(resolve(__dirname, '../../../tests/vectors/mining-pool.json'), 'utf8'));

describe('Mining Pool view (shared vectors)', () => {
  for (const c of poolVectors.cases) {
    it(c.name, () => {
      const view = describeMiningPool(c.input);
      for (const [key, want] of Object.entries(c.expect)) {
        expect((view as unknown as Record<string, unknown>)[key], key).toEqual(want);
      }
      // a view that is not `ok` never carries a figure, and never claims a verified zero
      if (view.state !== 'ok') {
        expect(view.value).toBe(UNAVAILABLE);
        expect(view.exact).toBeNull();
        expect(view.zero).toBe(false);
        expect(view.reason).toBeTruthy();
      }
    });
  }

  it('never invents a balance: with nothing returned the answer is never a figure', () => {
    for (const input of [{}, { expectedChainId: 7777 }, { supply: {} }, { status: {}, supply: null }]) {
      const view = describeMiningPool(input);
      expect(view.state).toBe('unavailable');
      expect(view.value).toBe(UNAVAILABLE);
    }
  });
});
