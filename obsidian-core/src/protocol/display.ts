/**
 * Display formatting for people. Nothing in this file is ever read by consensus, a signature, a fee calculation, a
 * balance or an API payload: it turns exact values into text, and it never turns text back into a value.
 *
 * Every user-facing OBS amount, count and long identifier in every interface goes through here (or through its
 * byte-for-byte mirror in obsidian-app-web/public/data.mjs, which tests/display-parity.test.mjs holds to the same
 * vectors), so the main platform, the Web App, the Wallet web app and the explorer cannot disagree about how one
 * number looks.
 *
 * Rules (each one is pinned by tests/unit/display.test.ts):
 *
 *   - Exact. Amounts are BigInt arithmetic on decimal text. A `Number` never touches a token quantity, so a
 *     balance past 2^53 base units is not rounded.
 *   - Nothing is silently shortened. By default every significant fractional digit up to the protocol's 18 is shown,
 *     so 0.000000000000000001 OBS reads as exactly that. A caller that asks for fewer digits gets the value cut
 *     DOWN (never rounded up, so the screen never shows more than the holder has), and a non-zero amount that would
 *     show as zero is shown as `<0.00000001` instead of `0`.
 *   - Trailing zeros and a dangling decimal point are removed: 0.05000000000000000000 reads 0.05, and
 *     100000.000000000000000000 reads 100,000. Zero reads 0.
 *   - Whole digits are grouped with a comma, whatever the viewer's locale: the same amount must read the same on
 *     every device, and `toLocaleString` does not promise that (nor is it exact for large integers).
 *   - Never scientific notation. Text such as `1e-18` is not an amount here and renders as the unavailable mark.
 *   - Identifiers are shortened for DISPLAY only, with a fixed policy per kind; the full value is what is copied,
 *     validated, signed and sent.
 */
import { OBS_DECIMALS } from './amount.js';

/** What is shown for a value that is missing or is not an amount. Never `0`: a missing balance is not a zero one. */
export const UNAVAILABLE = '—';

export interface ObsDisplayOptions {
  /** Most fractional digits to show, 0..18. Default 18: every digit the protocol can hold. */
  maxDecimals?: number;
  /** Group the whole part in threes with commas. Default true. */
  group?: boolean;
}

const UNIT = 10n ** BigInt(OBS_DECIMALS);

function clampDecimals(value: number | undefined): number {
  if (value === undefined) return OBS_DECIMALS;
  if (!Number.isFinite(value)) return OBS_DECIMALS;
  return Math.max(0, Math.min(OBS_DECIMALS, Math.floor(value)));
}

/** Insert commas into a string of digits. */
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Shared tail: a non-negative whole and an 18-digit fraction, to text. */
function render(negative: boolean, whole: bigint, fraction18: string, opts: ObsDisplayOptions | undefined): string {
  const maxDecimals = clampDecimals(opts?.maxDecimals);
  const group = opts?.group !== false;
  const kept = fraction18.slice(0, maxDecimals).replace(/0+$/, '');
  const wholeText = group ? groupDigits(whole.toString()) : whole.toString();
  const nonZero = whole > 0n || /[1-9]/.test(fraction18);
  if (whole === 0n && kept === '' && nonZero) {
    // A real amount that the requested precision would hide. Say so, rather than show 0.
    const floor = maxDecimals === 0 ? '1' : `0.${'0'.repeat(maxDecimals - 1)}1`;
    return `${negative ? '-' : ''}<${floor}`;
  }
  const sign = negative && nonZero ? '-' : '';
  return `${sign}${wholeText}${kept ? `.${kept}` : ''}`;
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

/** An OBS decimal string ("0.05000000000000000000", "21000000") to display text. Over-precise input is cut down, never rounded. */
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
