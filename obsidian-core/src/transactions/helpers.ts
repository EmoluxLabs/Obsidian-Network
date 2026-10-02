/**
 * Shared executor helpers: gas, oracle price access, address checks.
 *
 * These functions are consensus-critical and therefore pure and deterministic.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { applyBasisPoints, minBig, divRoundHalfUp } from '../protocol/amount.js';
import { ErrCode, reject } from '../protocol/errors.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import { isValidAddress } from '../crypto/keys.js';
import type { WorldState } from '../blockchain/state.js';
import { ONE_DAY } from './time.js';

/**
 * Protocol gas: 0.02% of the transferred OBS, capped at 0.01 OBS.
 * Integer-only so every node computes the identical number.
 */
export function expectedGas(base: bigint): bigint {
  if (base <= 0n) return 0n;
  const computed = applyBasisPoints(base, CONSENSUS_PARAMS.gas.basisPoints);
  const capped = minBig(computed, CONSENSUS_PARAMS.gas.maxGas);
  return capped < CONSENSUS_PARAMS.gas.minGas ? CONSENSUS_PARAMS.gas.minGas : capped;
}

/** Reject a transaction that does not carry exactly the protocol gas. */
export function assertGas(provided: bigint, base: bigint): bigint {
  const expected = expectedGas(base);
  if (provided !== expected) {
    reject(ErrCode.BAD_GAS, `gas mismatch: expected ${expected}, received ${provided}`, {
      expected: expected.toString(),
      received: provided.toString(),
      base: base.toString(),
    });
  }
  return expected;
}

export function assertAmount(amount: bigint, { allowZero = false, label = 'amount' } = {}): void {
  if (amount < 0n) reject(ErrCode.AMOUNT_NEGATIVE, `${label} must not be negative`);
  if (amount === 0n && !allowZero) reject(ErrCode.AMOUNT_ZERO, `${label} must be greater than zero`);
}

export function assertAddress(address: string, net: NetworkDefinition, label = 'address'): void {
  if (!isValidAddress(address, net.addressHrp)) {
    reject(ErrCode.BAD_ADDRESS, `${label} "${address}" is not a valid ${net.addressHrp}1 address`);
  }
}

export interface OraclePrice {
  /** Micro-USD per OBS (1e-6 USD units). */
  priceUsdMicro: bigint;
  updatedAt: number;
  sourceCount: number;
}

/**
 * Read the protocol price used to convert USD-denominated features into OBS.
 * Fails closed: a stale or absent price rejects the transaction rather than
 * inventing a value, so an oracle outage can never corrupt consensus state.
 */
export function requirePrice(state: WorldState, protocolTime: number): OraclePrice {
  const oracle = state.s.oracle;
  if (oracle.medianPriceUsdMicro <= 0n || oracle.sourceCount < CONSENSUS_PARAMS.oracle.minSources) {
    reject(ErrCode.ORACLE_UNAVAILABLE, 'no protocol price is available (insufficient sources)', {
      sources: oracle.sourceCount,
      required: CONSENSUS_PARAMS.oracle.minSources,
    });
  }
  const age = protocolTime - oracle.medianUpdatedAt;
  if (age > CONSENSUS_PARAMS.oracle.maxAgeSeconds) {
    reject(ErrCode.ORACLE_STALE, 'the protocol price is stale', {
      ageSeconds: age,
      maxAgeSeconds: CONSENSUS_PARAMS.oracle.maxAgeSeconds,
    });
  }
  return {
    priceUsdMicro: oracle.medianPriceUsdMicro,
    updatedAt: oracle.medianUpdatedAt,
    sourceCount: oracle.sourceCount,
  };
}

/**
 * Convert a USD micro-unit amount into OBS seals, rounding UP.
 * Rounding up guarantees the protocol/network side is never under-paid, and it
 * is deterministic in integer arithmetic.
 */
export function usdMicroToSeals(usdMicro: bigint, priceUsdMicro: bigint): bigint {
  if (priceUsdMicro <= 0n) reject(ErrCode.ORACLE_UNAVAILABLE, 'cannot price in OBS without a price');
  const numerator = usdMicro * 10n ** 18n;
  const quotient = numerator / priceUsdMicro;
  const remainder = numerator % priceUsdMicro;
  return remainder === 0n ? quotient : quotient + 1n;
}

/** Convert OBS seals into USD micro-units, rounding down (conservative). */
export function sealsToUsdMicro(seals: bigint, priceUsdMicro: bigint): bigint {
  return (seals * priceUsdMicro) / 10n ** 18n;
}

/** Split an amount by basis points with the protocol's rounding rule. */
export function splitBps(amount: bigint, bps: number): bigint {
  return divRoundHalfUp(amount * BigInt(bps), 10_000n);
}

export { ONE_DAY };
