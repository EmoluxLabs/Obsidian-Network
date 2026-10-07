/**
 * Deterministic accounting rules for protocol-held OBS.
 *
 * ONS registration and renewal fees are the only protocol-revenue sources.
 * At receipt, each fee is split in integer base units: floor(90% of the fee) to
 * the Node Runner Reward Pool and the exact remainder to the genesis-designated
 * treasury wallet (or recorded as unclaimed until that wallet exists).
 *
 * Gas, issuance, validator bonds, mining rewards, treasury grants and
 * user-to-user transfers are separate accounting categories and are never
 * counted as ONS revenue.
 */

import type { TxType } from '../protocol/types.js';
import { TxType as Tx } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';

export enum AccountingCategory {
  MINING_POOL = 'MINING_POOL',
  TREASURY = 'TREASURY',
  NODE_RUNNER_POOL = 'NODE_RUNNER_POOL',
  USER_FUNDS = 'USER_FUNDS',
  UNCLAIMED_REVENUE = 'UNCLAIMED_REVENUE',
}

/** The complete, closed set of protocol-revenue sources. */
export enum RevenueSource {
  ONS_REGISTRATION = 'ONS_REGISTRATION',
  ONS_RENEWAL = 'ONS_RENEWAL',
}

/** Value that is explicitly NOT ONS revenue, with the reason attached. */
export const NOT_ONS_REVENUE: ReadonlyArray<{ txType: TxType; name: string; because: string }> = [
  { txType: Tx.PAYMENT, name: 'user-to-user transfer', because: 'the sender owns the funds; the protocol is only the messenger' },
  { txType: Tx.MINING_CLAIM, name: 'mining reward', because: 'issued by the protocol schedule, never paid in by a user' },
  { txType: Tx.VALIDATOR, name: 'validator bond', because: 'the bonded OBS remains attributable to its owner and is returned at unbonding' },
  { txType: Tx.GOVERNANCE, name: 'governance action', because: 'carries no payment to the protocol' },
  { txType: Tx.ORACLE, name: 'oracle submission', because: 'an observation paid for by gas, not an ONS sale' },
  { txType: Tx.TREASURY, name: 'treasury grant', because: 'moves existing treasury funds; it creates no protocol revenue' },
];

export interface RevenueSplit {
  /** Total ONS revenue received. */
  total: bigint;
  /** 90% target share → Node Runner Reward Pool (floored in base units). */
  nodeRunnerPool: bigint;
  /** Exact remainder → treasury, preserving every base unit. */
  treasury: bigint;
  totalBps: number;
  nodePoolBps: number;
  treasuryBps: number;
}

/** Split ONS revenue without rounding loss or duplicated allocation. */
export function splitOnsRevenue(total: bigint, source: RevenueSource): RevenueSplit {
  if (!Object.values(RevenueSource).includes(source)) {
    throw new Error(`unsupported protocol-revenue source: ${String(source)}`);
  }
  if (total <= 0n) throw new Error(`${source}: protocol revenue must be positive`);
  const { nodePoolShareBps, treasuryShareBps } = CONSENSUS_PARAMS.nodeRewards;
  if (nodePoolShareBps !== 9_000 || treasuryShareBps !== 1_000 || nodePoolShareBps + treasuryShareBps !== 10_000) {
    throw new Error('ONS revenue parameters are not the v1.6.0 90/10 split: a protocol upgrade is required');
  }
  const nodeRunnerPool = (total * BigInt(nodePoolShareBps)) / 10_000n;
  return {
    total,
    nodeRunnerPool,
    treasury: total - nodeRunnerPool,
    totalBps: 10_000,
    nodePoolBps: nodePoolShareBps,
    treasuryBps: treasuryShareBps,
  };
}

/** The invariant every ONS fee transition must satisfy. */
export function assertSplitInvariant(split: RevenueSplit): void {
  if (split.nodeRunnerPool + split.treasury !== split.total) {
    throw new Error(
      `revenue split invariant violated: ${split.nodeRunnerPool} + ${split.treasury} != ${split.total}`,
    );
  }
  if (split.nodeRunnerPool < 0n || split.nodeRunnerPool > split.total || split.treasury < 0n) {
    throw new Error('revenue split invariant violated: a share is outside the fee amount');
  }
}
