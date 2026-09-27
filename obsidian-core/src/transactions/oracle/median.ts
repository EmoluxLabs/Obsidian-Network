/**
 * Median aggregation for the protocol price oracle.
 *
 * Deterministic rules:
 *   - only observations inside the freshness window are counted;
 *   - the median of the accepted prices is the protocol price;
 *   - with fewer than params.oracle.minSources fresh observations the feed is
 *     marked stale and medianPriceUsdMicro is left at its previous value (it is
 *     never zeroed, so historical state roots stay reproducible).
 */

import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import type { MutableState } from '../../blockchain/state.js';

export interface MedianResult {
  medianPriceUsdMicro: bigint;
  medianUpdatedAt: number;
  sourceCount: number;
  stale: boolean;
  sources: string[];
}

export function recomputeMedian(state: MutableState, protocolTime: number): MedianResult {
  const fresh: Array<{ source: string; price: bigint; observedAt: number }> = [];
  for (const observation of Object.values(state.oracle.observations)) {
    if (protocolTime - observation.observedAt > CONSENSUS_PARAMS.oracle.maxSourceAgeSeconds) continue;
    fresh.push({
      source: observation.source,
      price: observation.priceUsdMicro,
      observedAt: observation.observedAt,
    });
  }
  fresh.sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0));

  if (fresh.length < CONSENSUS_PARAMS.oracle.minSources) {
    state.oracle.sourceCount = fresh.length;
    state.oracle.stale = true;
    state.oracle.medianUpdatedAt = protocolTime;
    return {
      medianPriceUsdMicro: state.oracle.medianPriceUsdMicro,
      medianUpdatedAt: state.oracle.medianUpdatedAt,
      sourceCount: fresh.length,
      stale: true,
      sources: fresh.map((f) => f.source),
    };
  }

  const prices = fresh.map((f) => f.price).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(prices.length / 2);
  const median =
    prices.length % 2 === 1
      ? prices[middle]
      : (prices[middle - 1] + prices[middle]) / 2n;

  state.oracle.medianPriceUsdMicro = median;
  state.oracle.medianUpdatedAt = protocolTime;
  state.oracle.sourceCount = fresh.length;
  state.oracle.stale = false;

  return {
    medianPriceUsdMicro: median,
    medianUpdatedAt: protocolTime,
    sourceCount: fresh.length,
    stale: false,
    sources: fresh.map((f) => f.source),
  };
}

/** True when the stored price may be used for a USD-priced feature. */
export function priceIsUsable(state: MutableState, protocolTime: number): boolean {
  const oracle = state.oracle;
  if (oracle.medianPriceUsdMicro <= 0n) return false;
  if (oracle.sourceCount < CONSENSUS_PARAMS.oracle.minSources) return false;
  return protocolTime - oracle.medianUpdatedAt <= CONSENSUS_PARAMS.oracle.maxAgeSeconds;
}
