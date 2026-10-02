/**
 * Protocol time helpers.
 *
 * Protocol time is the timestamp of the block currently being applied. It is
 * NEVER read from the local clock inside a state transition: doing so would
 * make the state root differ between nodes.
 */

export const ONE_MINUTE = 60;
export const ONE_HOUR = 60 * ONE_MINUTE;
export const ONE_DAY = 24 * ONE_HOUR;

/** Retention window for capsule preview receipts (indexer convenience only). */
export const PREVIEW_RECEIPT_WINDOW = ONE_DAY;

export function formatIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** Deterministic pseudo-identifier derived from a seed and a counter. */
export function deriveId(seed: string, counter: number): string {
  return `${seed}:${counter}`;
}
