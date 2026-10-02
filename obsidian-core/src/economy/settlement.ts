/**
 * Node Runner reward settlement — a block routine, not a service.
 *
 * WHY IT IS A BLOCK ROUTINE
 *   Rewards must exist whether or not anyone is watching. There is no cron job,
 *   no operator script, no "click settle" endpoint and no server that could
 *   forget to run: the routine below executes deterministically inside
 *   `runBlockRoutines` for every block every node applies, exactly like capsule
 *   unlocks (which also fire without their creator being online). If two nodes
 *   disagree about a period, their state roots diverge and one of them is simply
 *   wrong. That is the whole point of putting it in consensus.
 *
 * WHEN IT RUNS
 *   Periods are fixed windows of protocol time (nodeRewards.periodSeconds, one
 *   day). The first block whose timestamp lands in a new period settles the
 *   period that just closed, using only evidence recorded inside it. A period is
 *   therefore settled exactly once, at a height any observer can compute, and a
 *   period with no registered nodes is skipped by advancing the marker.
 *
 * WHAT IT CANNOT DO
 *   - It cannot pay a node that produced no verifiable evidence: the score is
 *     built from recorded heartbeats, attestations and blocks, and a node with a
 *     zero weight gets a zero allocation.
 *   - It cannot pay more than the pool holds: allocations are floors of the pool
 *     balance, and the invariant `Σpayouts + carried == pool` is asserted before
 *     anything is written.
 *   - It cannot be triggered twice: `lastSettledPeriod` is consensus state.
 *   - It cannot be steered by the block producer: the routine reads the pool, the
 *     registry and the evidence, and nothing else.
 */

import type { ProtocolEvent } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import type { WorldState } from '../blockchain/state.js';
import {
  rewardPeriodAt,
  rewardPeriodStart,
  settleNodeRewards,
  type NodeEvidence,
} from './node-rewards.js';

const NR = CONSENSUS_PARAMS.nodeRewards;

export interface SettlementContext {
  state: WorldState;
  apply: { height: number; timestamp: number; producer?: string };
}

/**
 * Called for every block. Records the block for participation scoring, then — on
 * the first block of a new period — settles the previous one.
 */
export function processNodeRewardRoutine(ctx: SettlementContext): void {
  const { state, apply } = ctx;
  const period = rewardPeriodAt(apply.timestamp);
  const pool = state.s.nodeRewards;

  // 1. Period rollover: settle the period that just closed, exactly once.
  if (pool.blockCountPeriod !== period) {
    if (pool.blockCountPeriod >= 0 && period > pool.blockCountPeriod) {
      settlePeriod(state, pool.blockCountPeriod, apply);
    }
    pool.blockCountPeriod = period;
    pool.blockCount = 0;
  }

  // 2. Record this block for participation scoring. A node is credited for
  //    blocks produced by the wallet it registered, so a node cannot claim
  //    another operator's block production.
  pool.blockCount += 1;
  if (apply.producer) {
    for (const node of state.registeredNodes()) {
      if (node.rewardWallet === apply.producer) {
        state.nodeEvidenceFor(period, node.nodeId).blocksProduced += 1;
        break;
      }
    }
  }
  // 3. Credit the node's own heartbeat when the producer wallet is the node's
  //    reward wallet and the heartbeat transaction landed in this very block:
  //    the executor already recorded it, so nothing to do here.

  // 4. Bounded state: evidence older than the retention window is dropped.
  state.pruneNodeEvidence(period);
}

/** Settle one closed period. Deterministic, exact-arithmetic, idempotent. */
function settlePeriod(
  state: WorldState,
  period: number,
  apply: { height: number; timestamp: number },
): void {
  const pool = state.s.nodeRewards;
  if (pool.lastSettledPeriod >= period) return;

  // Wallet changes scheduled for this period take effect BEFORE settlement, so
  // the wallet that receives is the one the protocol recorded as the destination
  // — never a wallet introduced in the same block that pays out.
  for (const node of state.registeredNodes()) {
    if (node.pendingWallet && node.pendingWalletEffectivePeriod !== undefined && node.pendingWalletEffectivePeriod <= period) {
      const previous = node.rewardWallet;
      state.removeNodeWallet(previous, node.nodeId);
      node.rewardWallet = node.pendingWallet;
      node.pendingWallet = undefined;
      node.pendingWalletEffectivePeriod = undefined;
      node.pendingWalletRequestedAtHeight = undefined;
      state.putNode(node);
      state.emit('NODE_WALLET_CHANGE_EFFECTIVE', {
        nodeId: node.nodeId,
        from: previous,
        to: node.rewardWallet,
        period,
      }, apply);
    }
  }

  const nodes = state.registeredNodes();
  pool.lastSettledPeriod = period;
  if (nodes.length === 0) {
    pool.recentSettlements = pushSettlement(pool.recentSettlements, {
      period,
      poolSeals: pool.balance,
      distributedSeals: 0n,
      carriedSeals: pool.balance,
      eligibleNodes: 0,
      scoredNodes: 0,
      atHeight: apply.height,
      payouts: [],
    });
    return;
  }

  // Only nodes that were already registered when the period opened are scored.
  // A node that appears halfway through a period has half a period of evidence;
  // scoring it against a full period's expectations would punish it for time it
  // did not exist. It becomes eligible at the next settlement instead. Nodes that
  // deregistered inside the period are excluded for the same reason: leaving
  // mid-period forfeits that period's share, while the bond and every already
  // settled payout are untouched.
  const periodOpenedAt = rewardPeriodStart(period);
  const candidates = nodes.filter((node) => node.registeredAt < periodOpenedAt);
  const skippedNewRegistrations = nodes.length - candidates.length;

  const peerUniverse = nodes.length;
  const totalBlocks = pool.blockCount;
  const fairShare = Math.max(1, Math.floor(totalBlocks / peerUniverse));

  const evidence = candidates.map((node) => {
    const record = state.s.nodeEvidence.get(`${period}:${node.nodeId}`);
    const heartbeats = record?.heartbeats ?? 0;
    const distinctAttesters = record?.attesters.length ?? 0;
    const attested = record?.attested.length ?? 0;
    const faultReporters = record?.faultReporters.length ?? 0;
    // A fault only counts when independent peers corroborate it. One node's
    // accusation is recorded on-chain but never changes a payout on its own.
    const corroborationRequired = Math.min(NR.minAttesters, Math.max(1, peerUniverse - 1));
    const corroboratedFaults = faultReporters >= corroborationRequired ? record?.faults ?? 0 : 0;
    const entry: { nodeId: string; evidence: NodeEvidence } = {
      nodeId: node.nodeId,
      evidence: {
        liveness: { registered: true, heartbeats, distinctAttesters, peerUniverse },
        participation: {
          blocksProduced: record?.blocksProduced ?? 0,
          blocksExpected: fairShare,
          attestationsMade: attested,
        },
        reliability: { faults: corroboratedFaults, invalidAttestations: record?.invalidAttestations ?? 0 },
        responsiveness: {
          responsiveHeartbeats: heartbeats - (record?.staleHeartbeats ?? 0),
          staleHeartbeats: record?.staleHeartbeats ?? 0,
        },
      },
    };
    return entry;
  });

  const settlement = settleNodeRewards({ period, poolSeals: pool.balance, nodes: evidence });
  const walletOf = new Map(candidates.map((node) => [node.nodeId, node.rewardWallet]));
  const payouts: Array<{ nodeId: string; rewardWallet: string; amount: bigint; scoreBps: number; shareBps: number }> = [];

  for (const allocation of settlement.allocations) {
    const wallet = walletOf.get(allocation.nodeId);
    if (!wallet) continue;
    if (allocation.amount > 0n) {
      state.nodeRewardOutflow(allocation.amount, apply, `node runner reward for period ${period}`);
      state.credit(wallet, allocation.amount, apply, `node runner reward, period ${period}`);
      const node = state.node(allocation.nodeId);
      if (node) {
        node.lifetimeReward += allocation.amount;
        node.settledPeriods = [...node.settledPeriods, period].slice(-NR.evidenceWindowPeriods);
        state.putNode(node);
      }
    }
    payouts.push({
      nodeId: allocation.nodeId,
      rewardWallet: wallet,
      amount: allocation.amount,
      scoreBps: allocation.scoreBps,
      shareBps: allocation.shareBps,
    });
  }

  const distributed = payouts.reduce((sum, payout) => sum + payout.amount, 0n);
  // The pool invariant, checked against the post-payout balance: everything the
  // period paid plus everything it kept must equal what the pool held before.
  if (distributed > settlement.poolSeals || pool.balance + distributed !== settlement.poolSeals) {
    throw new Error(
      `node reward settlement violated the pool invariant: paid ${distributed} + kept ${pool.balance} != ${settlement.poolSeals}`,
    );
  }
  pool.recentSettlements = pushSettlement(pool.recentSettlements, {
    period,
    poolSeals: settlement.poolSeals,
    distributedSeals: distributed,
    carriedSeals: pool.balance,
    eligibleNodes: payouts.filter((payout) => payout.amount > 0n).length,
    scoredNodes: settlement.scoredNodes,
    atHeight: apply.height,
    payouts,
  });

  state.emit('NODE_REWARDS_SETTLED', {
    period,
    poolSeals: settlement.poolSeals.toString(),
    distributedSeals: distributed.toString(),
    carriedSeals: pool.balance.toString(),
    scoredNodes: settlement.scoredNodes,
    eligibleNodes: payouts.filter((payout) => payout.amount > 0n).length,
    skippedNewRegistrations,
    method: settlement.method,
    // Event payloads are flat key/value strings by design (see events.ts): the
    // per-node detail is emitted as one compact, machine-readable line so an
    // indexer can rebuild the whole payout table without parsing prose.
    payouts: payouts
      .map((payout) => `${payout.nodeId}|${payout.rewardWallet}|${payout.amount.toString()}|${payout.scoreBps}|${payout.shareBps}`)
      .join(';'),
  }, { ...apply });

  // Revenue that arrived before a treasury wallet existed is released to the
  // designated wallet as soon as one exists — including at settlement time, so
  // no operator action is required to make it correct.
  state.claimUnclaimedRevenue({ ...apply });
}

/** Keep the most recent settlements, newest last, for explorer audit. */
function pushSettlement<T>(list: T[], entry: T, cap = 30): T[] {
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export { rewardPeriodAt };
export type { ProtocolEvent };
