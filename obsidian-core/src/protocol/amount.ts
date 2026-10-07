/**
 * Obsidian monetary arithmetic.
 *
 * All OBS amounts are represented as unsigned integers of "seals" where
 * 1 OBS = 10^18 seals (18 decimal places). Integer arithmetic is mandatory:
 * the protocol NEVER performs consensus maths in floating point.
 *
 * Rationale for 18 decimals: the mining schedule expresses rewards such as
 * 0.000166666666666666 OBS per claim, which requires more than 8 decimals to
 * represent exactly at the base unit. 18 decimals removes all rounding drift
 * from the supply invariant.
 */

export const OBS_DECIMALS = 18;
export const OBS_UNIT = 10n ** BigInt(OBS_DECIMALS); // 1 OBS in seals

/** Hard maximum supply: 21,000,000 OBS. Never exceeded by any code path. */
export const MAX_SUPPLY_SEALS = 21_000_000n * OBS_UNIT;

export type Seals = bigint;

export class AmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmountError';
  }
}

/** Parse a decimal OBS string ("12.5") into seals. Rejects over-precision. */
export function parseObs(input: string | number | bigint): bigint {
  if (typeof input === 'bigint') return input;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new AmountError('amount is not finite');
    input = input.toString();
  }
  const raw = String(input).trim();
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new AmountError(`invalid OBS amount: ${raw}`);
  const negative = raw.startsWith('-');
  const body = negative ? raw.slice(1) : raw;
  const [whole, frac = ''] = body.split('.');
  if (frac.length > OBS_DECIMALS) {
    throw new AmountError(
      `amount ${raw} exceeds ${OBS_DECIMALS} decimal places (base unit is 1e-18 OBS)`,
    );
  }
  const scaled = BigInt(whole) * OBS_UNIT + BigInt((frac + '0'.repeat(OBS_DECIMALS)).slice(0, OBS_DECIMALS) || '0');
  return negative ? -scaled : scaled;
}

/**
 * Format seals as a decimal OBS string with trimmed trailing zeros.
 *
 * The default is FULL 18-decimal precision so protocol values (for example a
 * claim reward of 0.000166666666666666 OBS) are never displayed truncated. Pass
 * a smaller `decimals` only for display-only surfaces that want compactness.
 */
export function formatObs(seals: bigint, decimals = OBS_DECIMALS): string {
  const negative = seals < 0n;
  const abs = negative ? -seals : seals;
  const whole = abs / OBS_UNIT;
  const frac = abs % OBS_UNIT;
  // Always render the full precision by default: a monetary amount is never
  // shown shorter than the protocol can express, so 0 becomes
  // "0.000000000000000000" and never a bare "0".
  const padded = frac.toString().padStart(OBS_DECIMALS, '0');
  const fracStr = decimals >= OBS_DECIMALS ? padded : padded.slice(0, decimals);
  const out = fracStr.length > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${out}` : out;
}

/**
 * Deterministic integer division rounded half-up. Used for reward splits so
 * every node computes byte-identical results.
 */
export function divRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new AmountError('division by zero');
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const q = n / d;
  const r = n % d;
  const rounded = r * 2n >= d ? q + 1n : q;
  return negative ? -rounded : rounded;
}

/** floor(numerator/denominator) for bigints. */
export function divFloor(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new AmountError('division by zero');
  return numerator / denominator;
}

/**
 * Fixed-point multiply: (value * bps) / 10_000 using integer maths only.
 * Used for gas (2 bps = 0.02%) and reward reduction maths.
 */
export function applyBasisPoints(value: bigint, basisPoints: number): bigint {
  return divFloor(value * BigInt(Math.round(basisPoints)), 10_000n);
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Clamp helper for USD oracle values expressed in micro-dollars (1e-6 USD). */
export const USD_UNIT = 1_000_000n;
