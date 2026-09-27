/**
 * ORACLE — the protocol price feed for USD-denominated features.
 *
 * Design goals (spec §30, §76):
 *   - No single external API can become a hidden consensus authority.
 *   - Outliers are rejected, not averaged in.
 *   - A stale feed fails closed: USD-priced features are refused rather than
 *     priced with invented data, so an outage can never corrupt state.
 *   - Prices move in bounded steps, so a compromised source cannot reprice the
 *     whole ecosystem in one block.
 *
 * The median of all accepted sources is the protocol price. Each source
 * contributes at most one observation, and an observation is accepted only if:
 *   1. the source id is well-formed;
 *   2. the reported timestamp is not in the future and not older than
 *      params.oracle.maxSourceAgeSeconds;
 *   3. the price is inside the absolute protocol bounds;
 *   4. if a median already exists, the price is within
 *      params.oracle.maxDeviationFromPreviousBps of it;
 *   5. the submitting account has not submitted an oracle update in the last
 *      oracle.submissionCooldownBlocks blocks (deterministic anti-spam).
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import type { OracleBody, TxEnvelope } from '../../protocol/types.js';
import { assertGas } from '../helpers.js';
import type { ExecutorContext } from '../types.js';
import { recomputeMedian } from '../oracle/median.js';

/** Deterministic oracle submission cooldown, in blocks. */
export const ORACLE_SUBMISSION_COOLDOWN_BLOCKS = 100;
const SOURCE_PATTERN = /^[a-z0-9][a-z0-9._-]{2,47}$/;

export function decodeOracleBody(body: Uint8Array): OracleBody {
  const r = new Reader(body);
  const count = r.u32();
  if (count > 16) reject(ErrCode.MALFORMED, 'too many observations in one submission');
  const observations: OracleBody['observations'] = [];
  for (let i = 0; i < count; i += 1) {
    const source = r.string();
    const priceUsdMicro = r.u64();
    const observedAt = Number(r.u64());
    observations.push({ source, priceUsdMicro, observedAt });
  }
  const submissionId = r.string();
  r.ensureConsumed();
  return { observations, submissionId };
}

export function encodeOracleBody(body: OracleBody): Uint8Array {
  const w = new Writer();
  w.u32(body.observations.length);
  for (const observation of body.observations) {
    w.string(observation.source);
    w.u64(observation.priceUsdMicro);
    w.u64(BigInt(Math.trunc(observation.observedAt)));
  }
  w.string(body.submissionId);
  return w.finish();
}

export interface AcceptedObservation {
  source: string;
  priceUsdMicro: bigint;
  observedAt: number;
}

export function executeOracle(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply } = ctx;
  const body = decodeOracleBody(tx.body);
  const protocolTime = apply.timestamp;
  assertGas(tx.gas, 0n);

  const account = state.touchAccount(tx.sender, apply);
  const throttle = account.oracleSubmissions;
  if (throttle && apply.height - throttle.lastHeight < ORACLE_SUBMISSION_COOLDOWN_BLOCKS) {
    reject(
      ErrCode.RATE_LIMITED,
      `oracle submissions are limited to one per ${ORACLE_SUBMISSION_COOLDOWN_BLOCKS} blocks per account`,
    );
  }
  if (body.observations.length === 0) reject(ErrCode.MALFORMED, 'a submission needs at least one observation');
  if (!/^[0-9a-f]{16,64}$/.test(body.submissionId)) {
    reject(ErrCode.MALFORMED, 'submissionId must be 8-32 bytes of hex');
  }

  const accepted: AcceptedObservation[] = [];
  const previousMedian = state.s.oracle.medianPriceUsdMicro;
  const maxDeviation = BigInt(CONSENSUS_PARAMS.oracle.maxDeviationBps);

  for (const observation of body.observations) {
    if (!SOURCE_PATTERN.test(observation.source)) {
      reject(ErrCode.MALFORMED, `invalid oracle source id "${observation.source}"`);
    }
    if (observation.observedAt > protocolTime + CONSENSUS_PARAMS.block.maxFutureDriftSeconds) {
      reject(ErrCode.ORACLE_OUT_OF_BOUNDS, 'an observation claims a future timestamp');
    }
    if (protocolTime - observation.observedAt > CONSENSUS_PARAMS.oracle.maxSourceAgeSeconds) {
      reject(ErrCode.ORACLE_STALE, `observation from ${observation.source} is stale`);
    }
    if (
      observation.priceUsdMicro < CONSENSUS_PARAMS.oracle.minPriceUsdMicro ||
      observation.priceUsdMicro > CONSENSUS_PARAMS.oracle.maxPriceUsdMicro
    ) {
      reject(ErrCode.ORACLE_OUT_OF_BOUNDS, `price from ${observation.source} is outside protocol bounds`);
    }
    if (previousMedian > 0n) {
      const delta = observation.priceUsdMicro > previousMedian
        ? observation.priceUsdMicro - previousMedian
        : previousMedian - observation.priceUsdMicro;
      if (delta * 10_000n > previousMedian * maxDeviation) {
        reject(
          ErrCode.ORACLE_OUT_OF_BOUNDS,
          `price from ${observation.source} deviates more than ${CONSENSUS_PARAMS.oracle.maxDeviationBps / 100}% from the current median`,
        );
      }
    }
    // Latest write per source wins; only fresher observations replace older ones.
    const existing = state.s.oracle.observations[observation.source];
    if (existing && existing.observedAt >= observation.observedAt) continue;
    state.s.oracle.observations[observation.source] = {
      source: observation.source,
      priceUsdMicro: observation.priceUsdMicro,
      observedAt: observation.observedAt,
      submitter: tx.sender,
      height: apply.height,
    };
    accepted.push(observation);
  }

  if (accepted.length === 0) {
    reject(ErrCode.ORACLE_STALE, 'no observation in this submission improved on the stored feed');
  }

  account.oracleSubmissions = {
    lastHeight: apply.height,
    count: (throttle?.count ?? 0) + 1,
  };

  const median = recomputeMedian(state.s, protocolTime);
  state.emit('ORACLE_UPDATED', {
    submitter: tx.sender,
    acceptedSources: accepted.map((o) => o.source).join(','),
    medianPriceUsdMicro: median.medianPriceUsdMicro.toString(),
    sourceCount: median.sourceCount,
    stale: median.stale,
  }, apply);

  return {
    gasBase: 0n,
    detail: {
      medianPriceUsdMicro: median.medianPriceUsdMicro.toString(),
      medianPriceUsd: formatUsd(median.medianPriceUsdMicro),
      sourceCount: median.sourceCount,
      stale: median.stale,
    },
  };
}

function formatUsd(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac.length ? `$${whole}.${frac}` : `$${whole}`;
}
