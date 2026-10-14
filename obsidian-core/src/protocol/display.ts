/**
 * Display formatting for people. Nothing in this file is ever read by consensus, a signature, a fee calculation, a
 * balance or an API payload: it turns exact values into text, and it never turns text back into a value.
 *
 * Every user-facing OBS amount, count and long identifier in every interface goes through here (or through its
 * mirror in obsidian-app-web/public/data.mjs, which tests/display-parity.test.mjs holds to the same vectors), so the
 * main platform, the Web App, the Wallet web app and the explorer cannot disagree about how one number looks.
 *
 * THE POLICY (each line is pinned by tests/unit/display.test.ts and the shared vectors):
 *
 *   - Ordinary display is at most 6 fractional digits (DISPLAY_DECIMALS). The protocol holds 18; a screen of balances,
 *     supply, rewards and claims is not the place for 18, and 99,999.820626666666666664 OBS is read as
 *     99,999.820627 OBS.
 *   - Rounding is to the NEAREST displayed unit, ties away from zero (0.0000005 -> 0.000001, 0.0000004999 -> shown as
 *     "less than"). It is done in exact integer arithmetic on the full 18-digit value, so a carry into the whole part
 *     (99.9999996 -> 100) is right and no float is involved.
 *   - A non-zero amount that rounds to zero is NEVER shown as 0: it reads `<0.000001`, so it stays distinguishable from
 *     a genuine zero. (A negative one reads `>-0.000001`.)
 *   - Trailing zeros and a dangling decimal point are removed (12.340000 -> 12.34, 100000.000000 -> 100,000); zero is 0.
 *   - Whole digits are grouped with a comma, whatever the viewer's locale.
 *   - Never scientific notation. Text such as `1e-18` is not an amount here and renders as the unavailable mark.
 *   - Missing or invalid is the unavailable mark, never 0. A JavaScript `Number` is refused: it cannot hold a token
 *     quantity exactly, so there is no honest way to print one.
 *   - Rounding is for the eyes only. The exact value is always available: pass `EXACT_OBS` (maxDecimals 18) for a
 *     detail view, a confirmation or a tooltip. Nothing here changes the value that is signed, sent, stored or summed.
 *   - Identifiers are shortened for DISPLAY only, with a fixed policy per kind; the full value is what is copied,
 *     validated, signed and sent.
 */
import { OBS_DECIMALS } from './amount.js';

/** What is shown for a value that is missing or is not an amount. Never `0`: a missing balance is not a zero one. */
export const UNAVAILABLE = '—';

/** Fractional digits shown for an ordinary amount (balance, supply, mined, pool, reward, claim). */
export const DISPLAY_DECIMALS = 6;

export interface ObsDisplayOptions {
  /** Most fractional digits to show, 0..18. Default DISPLAY_DECIMALS (6); 18 is every digit the protocol holds. */
  maxDecimals?: number;
  /** Group the whole part in threes with commas. Default true. */
  group?: boolean;
}

const UNIT = 10n ** BigInt(OBS_DECIMALS);

function clampDecimals(value: number | undefined): number {
  if (value === undefined) return DISPLAY_DECIMALS;
  if (!Number.isFinite(value)) return DISPLAY_DECIMALS;
  return Math.max(0, Math.min(OBS_DECIMALS, Math.floor(value)));
}

/** Insert commas into a string of digits. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Every digit the protocol holds, for a detail view, a confirmation or a tooltip. */
export const EXACT_OBS: Readonly<ObsDisplayOptions> = Object.freeze({ maxDecimals: OBS_DECIMALS });

/** Shared tail: a non-negative whole and an 18-digit fraction, to text. Exact integer arithmetic throughout. */
function render(negative: boolean, whole: bigint, fraction18: string, opts: ObsDisplayOptions | undefined): string {
  const maxDecimals = clampDecimals(opts?.maxDecimals);
  const group = opts?.group !== false;
  const total = whole * UNIT + BigInt(fraction18);
  const nonZero = total > 0n;
  // Round to the nearest displayed unit, ties away from zero (the magnitude is rounded, then the sign is put back).
  const divisor = 10n ** BigInt(OBS_DECIMALS - maxDecimals);
  let units = total / divisor;
  if ((total % divisor) * 2n >= divisor && divisor > 1n) units += 1n;
  if (units === 0n && nonZero) {
    // A real amount that the displayed precision would hide. Say so, rather than show 0.
    const floor = maxDecimals === 0 ? '1' : `0.${'0'.repeat(maxDecimals - 1)}1`;
    return negative ? `>-${floor}` : `<${floor}`;
  }
  const scale = 10n ** BigInt(maxDecimals);
  const shownWhole = units / scale;
  const shownFraction = maxDecimals === 0 ? '' : (units % scale).toString().padStart(maxDecimals, '0').replace(/0+$/, '');
  const wholeText = group ? groupDigits(shownWhole.toString()) : shownWhole.toString();
  return `${negative && units > 0n ? '-' : ''}${wholeText}${shownFraction ? `.${shownFraction}` : ''}`;
}

/** Exact base units (seals; 1 OBS = 10^18) to display text. */
export function displaySeals(seals: bigint | string | null | undefined, opts?: ObsDisplayOptions): string {
  if (seals === null || seals === undefined) return UNAVAILABLE;
  let value: bigint;
  if (typeof seals === 'bigint') value = seals;
  else if (typeof seals === 'string' && /^-?\d+$/.test(seals.trim())) value = BigInt(seals.trim());
  else return UNAVAILABLE;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return render(negative, abs / UNIT, (abs % UNIT).toString().padStart(OBS_DECIMALS, '0'), opts);
}

/** An OBS decimal string ("0.05000000000000000000", "21000000") to display text. Input beyond 18 places is cut at 18 (the protocol cannot hold more); rounding to the display precision happens on that. */
export function displayDecimal(text: string | null | undefined, opts?: ObsDisplayOptions): string {
  if (typeof text !== 'string') return UNAVAILABLE;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return UNAVAILABLE;
  const fraction = (match[3] ?? '').slice(0, OBS_DECIMALS).padEnd(OBS_DECIMALS, '0');
  return render(match[1] === '-', BigInt(match[2]), fraction, opts);
}

/**
 * The node speaks two exact shapes for one quantity: seal counts (integer text) and OBS decimals (text with a point).
 * This accepts either and picks by the point. A bigint is a seal count. A JavaScript number is refused: it cannot hold
 * a token quantity exactly, so there is no honest way to print one.
 */
export function displayObs(value: string | bigint | null | undefined, opts?: ObsDisplayOptions): string {
  if (typeof value === 'bigint') return displaySeals(value, opts);
  if (typeof value !== 'string') return UNAVAILABLE;
  return value.includes('.') ? displayDecimal(value, opts) : displaySeals(value, opts);
}

/** "12.5 OBS". Zero is "0 OBS"; a missing value is the unavailable mark with no unit. */
export function displayObsWithUnit(value: string | bigint | null | undefined, opts?: ObsDisplayOptions): string {
  const text = displayObs(value, opts);
  return text === UNAVAILABLE ? text : `${text} OBS`;
}

/** A whole-number count (block height, miners, iterations) with commas, exact for any size, same in every locale. */
export function displayInteger(value: string | bigint | number | null | undefined): string {
  let text: string;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return UNAVAILABLE;
    text = String(value);
  } else if (typeof value === 'string') text = value.trim();
  else return UNAVAILABLE;
  const match = /^(-?)(\d+)$/.exec(text);
  if (!match) return UNAVAILABLE;
  return `${match[1]}${groupDigits(match[2].replace(/^0+(?=\d)/, ''))}`;
}

// ── identifiers ──────────────────────────────────────────────────────────────

export type IdentifierKind = 'address' | 'hash' | 'id';

/**
 * How many characters each end keeps. The narrow policy is the one in use on phones: `obs1ijdn...slvgsi` is the
 * address policy (8 + 6). `wide` is for screens with room; a detail view shows the whole value instead.
 */
export const IDENTIFIER_POLICY: Readonly<
  Record<IdentifierKind, { narrow: readonly [number, number]; wide: readonly [number, number] }>
> = {
  address: { narrow: [8, 6], wide: [14, 8] },
  hash: { narrow: [10, 8], wide: [16, 10] },
  id: { narrow: [10, 8], wide: [16, 10] },
};

export const ELLIPSIS = '...';

/**
 * A value a node has already masked for the explorer ("obs1abcd…wxyz") carries its own ellipsis. It is not an
 * identifier to copy or to shorten a second time; it is shown as it came.
 */
export function isMaskedIdentifier(value: string | null | undefined): boolean {
  return typeof value === 'string' && (value.includes('…') || value.includes(ELLIPSIS));
}

/**
 * Display-only shortening: first N, "...", last M. Returns the value unchanged when shortening would not make it
 * shorter. The result is NOT an identifier and must never be copied, compared, validated, signed or sent.
 */
export function shortenIdentifier(
  value: string | null | undefined,
  kind: IdentifierKind = 'address',
  width: 'narrow' | 'wide' = 'narrow',
): string {
  if (typeof value !== 'string' || value === '') return UNAVAILABLE;
  const [head, tail] = IDENTIFIER_POLICY[kind][width];
  if (isMaskedIdentifier(value) || value.length <= head + tail + ELLIPSIS.length) return value;
  return `${value.slice(0, head)}${ELLIPSIS}${value.slice(-tail)}`;
}

// ── the Mining Pool ──────────────────────────────────────────────────────────

/**
 * What a screen may say about the Mining Pool, decided from what the node actually returned. Display only.
 *
 * The Mining Pool is protocol state (`state.pool.balance`), served by a node as `GET /supply` -> `poolBalanceObs`.
 * It is NOT the total supply, NOT the amount mined, NOT the node-runner reward pool, NOT the treasury and NOT any
 * wallet's balance, and nothing here derives it from any of those. It is a recycling pool: gas, slashed bonds and the
 * parked treasury share flow in, and the next mining claim is paid from it first, so `0` is a normal, genuine
 * reading whenever fees have already been paid out. That is why a zero is shown as zero ONLY when the node said
 * zero, and a missing answer is "unavailable", never 0.
 *
 *   mismatch    the node answering reports another chain than this interface is for; its figures are not shown
 *   unavailable the value is missing, malformed, or the node's own supply check does not hold
 *   ok          `value` is the node's figure (rounded for display), `exact` carries every digit
 */
export interface MiningPoolView {
  state: 'ok' | 'unavailable' | 'mismatch';
  /** Display text with the unit, or the unavailable mark. */
  value: string;
  /** Every digit the node returned, with the unit; null unless state is `ok`. */
  exact: string | null;
  /** True only when the node returned a pool balance of exactly zero. */
  zero: boolean;
  /** Why the value is not shown; null when it is. */
  reason: string | null;
  /** Lifetime fees paid into the pool and paid out of it, from `/status` `pool`, when the node returned them. */
  lifetimeInflow: string | null;
  lifetimeDistributed: string | null;
}

export interface MiningPoolInput {
  /** The chain this interface is for (mainnet is 7777). Omit to skip the network check. */
  expectedChainId?: number | null;
  /** The node's `/status` answer: `chainId` and `pool`. */
  status?: { chainId?: unknown; pool?: { lifetimeInflow?: unknown; lifetimeDistributed?: unknown } } | null;
  /** The node's `/supply` answer: `poolBalanceObs` and `invariantOk`. */
  supply?: { poolBalanceObs?: unknown; invariantOk?: unknown } | null;
}

export function describeMiningPool(input: MiningPoolInput): MiningPoolView {
  // The node returns OBS decimals with a point (formatObs). Anything else is not a pool balance.
  const shown = (v: unknown, o?: ObsDisplayOptions): string => {
    const t = typeof v === 'string' && v.includes('.') ? displayDecimal(v, o) : UNAVAILABLE;
    return t === UNAVAILABLE ? t : `${t} OBS`;
  };
  const none = (state: MiningPoolView['state'], reason: string): MiningPoolView => ({
    state, value: UNAVAILABLE, exact: null, zero: false, reason, lifetimeInflow: null, lifetimeDistributed: null,
  });
  const expected = input.expectedChainId;
  if (expected !== undefined && expected !== null) {
    const reported = input.status?.chainId;
    const reportedChain = typeof reported === 'number' ? reported : typeof reported === 'string' && /^\d+$/.test(reported) ? Number(reported) : null;
    if (reportedChain === null) return none('unavailable', 'The node has not said which network it is on, so its pool figure cannot be trusted for this one.');
    if (reportedChain !== expected) return none('mismatch', `The node answering is on chain ${reportedChain}, but this is chain ${expected}. Its figures are not shown.`);
  }
  const pool = input.supply?.poolBalanceObs;
  if (shown(pool) === UNAVAILABLE) return none('unavailable', 'The node has not returned the Mining Pool figure.');
  if (input.supply?.invariantOk === false) return none('unavailable', 'The node reports that its supply check does not hold, so the pool figure is not shown.');
  const inflow = input.status?.pool?.lifetimeInflow;
  const distributed = input.status?.pool?.lifetimeDistributed;
  const text = (v: unknown): string | null => (shown(v) === UNAVAILABLE ? null : shown(v));
  return {
    state: 'ok',
    value: shown(pool),
    exact: shown(pool, EXACT_OBS),
    zero: shown(pool, EXACT_OBS) === '0 OBS',
    reason: null,
    lifetimeInflow: text(inflow),
    lifetimeDistributed: text(distributed),
  };
}
