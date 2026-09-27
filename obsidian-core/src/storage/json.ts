/**
 * Lossless JSON codec for protocol state.
 *
 * Consensus values are 128-bit integers. JSON has no integer type, and double
 * precision silently corrupts amounts above 2^53, so every bigint is encoded as
 * {"$bigint":"..."} and restored exactly. Round-tripping a state snapshot
 * through this codec is therefore bit-exact — the checkpoints a node reloads are
 * the same state it had in memory.
 */

const BIGINT_TAG = '$bigint';

export function stringifyState(value: unknown): string {
  return JSON.stringify(value, (_key, raw) =>
    typeof raw === 'bigint' ? { [BIGINT_TAG]: raw.toString() } : raw,
  );
}

export function parseState<T>(text: string): T {
  return JSON.parse(text, (_key, raw) => {
    if (
      raw &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      typeof (raw as Record<string, unknown>)[BIGINT_TAG] === 'string' &&
      Object.keys(raw as Record<string, unknown>).length === 1
    ) {
      return BigInt((raw as Record<string, string>)[BIGINT_TAG]);
    }
    return raw;
  }) as T;
}

/** Same codec, but for pretty-printed operator-facing files. */
export function stringifyStatePretty(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, raw) => (typeof raw === 'bigint' ? { [BIGINT_TAG]: raw.toString() } : raw),
    2,
  );
}
