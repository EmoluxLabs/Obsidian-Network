/**
 * Economic accounting — the one place that says where money may go.
 *
 * THE RULE
 *   Every OBS in the system belongs to exactly one accounting category, and no
 *   transition may move value between categories except along the paths declared
 *   here. This file is the declaration; the executors are the enforcement.
 *
 * WHY IT EXISTS
 *   A blockchain can be perfectly consensus-correct and still be economically
 *   dishonest: revenue quietly routed to the wrong wallet, a fee counted twice,
 *   escrow spent as if it were income. Splitting the categories and writing them
 *   down makes that class of bug a failing test instead of a slow leak.
 *
 * CATEGORIES
 *   MINING_POOL        protocol-owned; gas, capsule commitments, Time Travel
 *                      revenue and other protocol inflows are distributed to
 *                      miners by the mining schedule. Never platform income.
 *   TREASURY           60% of qualifying platform revenue, sent to the wallet
 *                      designated on-chain by the genesis rule.
 *   NODE_RUNNER_POOL   40% of qualifying platform revenue, held for the node
 *                      runner reward settlement (see src/economy/node-rewards.ts).
 *   USER_FUNDS         balances owned by users. Never platform revenue, never a
 *                      destination for protocol revenue.
 *   CREATOR_FUNDS      the creator share of platform-monetised activity, paid
 *                      straight to the creator's own balance.
 *   MARKETPLACE_ESCROW value held for a specific counterparty (a land sale
 *                      between two users, a tipping balance in flight). Owned by
 *                      users, not by the protocol.
 *   UNCLAIMED_REVENUE  qualifying platform revenue received before the genesis
 *                      allocation designates a treasury wallet. Held in the
 *                      Mining Pool as protocol value and *recorded* as unclaimed
 *                      so no node can treat it as income; the recorded source
 *                      decides its destination once the designation exists.
 *
 * WHAT IS NOT PLATFORM REVENUE
 *   user-to-user transfers, mining rewards, capsule commitments and Time Travel
 *   payments, gas, validator bonds, marketplace sale proceeds, tips and any
 *   escrowed balance. Those are enumerated in NOT_PLATFORM_REVENUE below and
 *   asserted by tests.
 */

import type { TxType } from '../protocol/types.js';
import { TxType as Tx } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';

export enum AccountingCategory {
  MINING_POOL = 'MINING_POOL',
  TREASURY = 'TREASURY',
  NODE_RUNNER_POOL = 'NODE_RUNNER_POOL',
  USER_FUNDS = 'USER_FUNDS',
  CREATOR_FUNDS = 'CREATOR_FUNDS',
  MARKETPLACE_ESCROW = 'MARKETPLACE_ESCROW',
  UNCLAIMED_REVENUE = 'UNCLAIMED_REVENUE',
}

/**
 * Why a payment is platform revenue. The reason is stored on-chain with the
 * split event, so an auditor can classify every basis point from chain data
 * alone instead of trusting this file's intent.
 */
export enum RevenueSource {
  /** A `.obs` name registration. */
  ONS_REGISTRATION = 'ONS_REGISTRATION',
  /** A `.obs` name renewal. */
  ONS_RENEWAL = 'ONS_RENEWAL',
  /** A business page: the flat 0.005 OBS activation fee. */
  BUSINESS_PAGE = 'BUSINESS_PAGE',
  /** An explicit treasury revenue payment signed by a platform wallet. */
  EXPLICIT_PAYMENT = 'EXPLICIT_PAYMENT',
  /**
   * Land released by the protocol market. Protocol-issued land revenue is
   * classified as qualifying platform revenue: the protocol is the seller and
   * the treasury buys land back from owners, so the two flows belong in one
   * account. Buy-backs move *treasury* funds to the owner and are not revenue.
   */
  LAND_PROTOCOL_SALE = 'LAND_PROTOCOL_SALE',
}

/** Value that is explicitly NOT platform revenue, with the reason attached. */
export const NOT_PLATFORM_REVENUE: ReadonlyArray<{ txType: TxType; name: string; because: string }> = [
  { txType: Tx.PAYMENT, name: 'user-to-user transfer', because: 'the sender owns the funds; the protocol is only the messenger' },
  { txType: Tx.MINING_CLAIM, name: 'mining reward', because: 'issued by the protocol schedule, never paid in by a user' },
  { txType: Tx.CAPSULE, name: 'capsule commitment', because: 'transfers to the Mining Pool by protocol rule at unlock' },
  { txType: Tx.VALIDATOR, name: 'validator bond', because: 'the bond stays the validator\'s own funds and returns at unbonding' },
  { txType: Tx.GOVERNANCE, name: 'governance action', because: 'carries no payment to the protocol' },
  { txType: Tx.ORACLE, name: 'oracle submission', because: 'a market observation paid for by gas, not a platform sale' },
];

export interface RevenueSplit {
  /** Total qualifying platform revenue received. */
  total: bigint;
  /** 40% → Node Runner Reward Pool. */
  nodeRunnerPool: bigint;
  /** 60% → treasury wallet (or the unclaimed account before designation). */
  treasury: bigint;
  /** Always 10_000; carried so consumers can print the split without guessing. */
  totalBps: number;
  nodePoolBps: number;
  treasuryBps: number;
}

/**
 * Split qualifying platform revenue with exact integer arithmetic.
 *
 * `nodePool = floor(total * nodePoolBps / 10_000)` and `treasury = total -
 * nodePool`, so the parts always add back to the whole. Flooring in favour of
 * the treasury is deliberate: the last seal can never be lost to rounding, and
 * the treasury is the account that pays it back out through buy-backs.
 */
export function splitPlatformRevenue(total: bigint, source: RevenueSource): RevenueSplit {
  if (total <= 0n) throw new Error(`${source}: platform revenue must be positive`);
  const { nodePoolShareBps, treasuryShareBps } = CONSENSUS_PARAMS.nodeRewards;
  if (nodePoolShareBps + treasuryShareBps !== 10_000) {
    throw new Error('node reward parameters do not sum to 100%: a protocol upgrade is required');
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

/** The invariant every route that credits platform revenue must satisfy. */
export function assertSplitInvariant(split: RevenueSplit): void {
  if (split.nodeRunnerPool + split.treasury !== split.total) {
    throw new Error(
      `revenue split invariant violated: ${split.nodeRunnerPool} + ${split.treasury} != ${split.total}`,
    );
  }
  if (split.nodeRunnerPool > split.total) {
    throw new Error('revenue split invariant violated: node pool exceeds the total');
  }
}
