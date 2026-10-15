/**
 * Node rewards — who gets the ONS-funded 90% share, measured how, and why (protocol 1.9.0).
 *
 * THE FORMULA
 *     reward(node) = nodePool × weight(node) / Σ weight(eligible nodes)          (nodePool = the 90% pool)
 *   `weight` is the node's score in basis points, counted only for ELIGIBLE nodes. Eligibility is a gate, not a
 *   bonus: a node below the uptime or score floor, an unregistered, banned or wallet-less node, and a node that
 *   registered after the period opened all weigh zero and are paid nothing.
 *
 * THE RULE OF EVIDENCE
 *   Every number that decides a payout is computed by each node from chain state. A node cannot send the protocol
 *   "I was online 99%": there is no field for it. What the chain contains is:
 *     - in-sync HEARTBEATS, at most one per uptime window (one hour of protocol time), signed by the node key;
 *     - BLOCKS the node produced (a produced block also proves the node was up in its window);
 *     - ATTESTATIONS of other nodes, only for a subject that has recorded uptime in the same period;
 *     - FAULT reports, which change a payout only when independent reporters corroborate them.
 *
 * SCORING (integer arithmetic only — no floating point anywhere, so every platform computes the same bits)
 *   uptimeBps         = liveWindows × 10 000 / windowsPerPeriod, scaled down when too few independent nodes
 *                       attested it, and capped for a peerless network
 *   participationBps  = (producedBps × wBlocks + coverageBps × wCoverage) / 10 000
 *   reliabilityBps    = 10 000 − faultPenalty × (corroborated faults + invalid attestations), floored at zero
 *   responsivenessBps = in-sync heartbeats / all heartbeats (a stale node earns no uptime and no responsiveness)
 *   scoreBps          = weighted sum of the four
 *
 * TREATMENT OF BAD BEHAVIOUR
 *   downtime        → fewer live windows, lower uptime, lower weight; below the floor, no payout at all.
 *   missed slots    → the node is suspended (consensus/producers.ts) and produces nothing, which lowers participation.
 *   unsynced        → a stale heartbeat is counted as stale and earns no uptime window.
 *   invalid claims  → an attestation the chain can see is false is recorded and costs reliability.
 *   equivocation    → the node is banned: weight zero for ever, wallet released.
 *
 * ALLOCATION (exact, `allocateReward` below)
 *   Largest-remainder method on integer seals. No single node may take more than max(maxNodeShareBps,
 *   ceil(10 000 / contributors)) of the pool — a small network is paid in full instead of stranding the pool — and
 *   the overflow of a capped node is redistributed to the others in the same pass. An allocation below
 *   `minPayoutSeals` is not paid as dust: it stays in the pool and carries into the next period. Σ paid + carried
 *   equals the pool exactly, always; a settlement can never mint a seal.
 *
 * WHAT THIS DOES NOT SOLVE
 *   Several nodes run by one operator earn several shares; the protocol cannot tell. The per-node cap and the
 *   independent-attester requirement limit what one fleet can take from honest nodes, nothing more. A node that
 *   lies about being in sync is only caught by other nodes' attestations. See docs/rewards-v1.9.0.md.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';

const NR = CONSENSUS_PARAMS.nodeRewards;

export interface NodeRewardParamsSummary {
  nodePoolBps: number;
  treasuryBps: number;
  periodSeconds: number;
  minUptimeBps: number;
  minScoreBps: number;
  maxNodeShareBps: number;
  minAttesters: number;
  walletChangeDelayPeriods: number;
  evidenceWindowPeriods: number;
  uptimeWindowSeconds: number;
  uptimeWindowsPerPeriod: number;
  minPayoutSeals: string;
  reclaimDelayPeriods: number;
  scoreWeights: { uptimeBps: number; participationBps: number; reliabilityBps: number; responsivenessBps: number };
}

/** Period index that contains a protocol timestamp. Deterministic, no clock. */
export function rewardPeriodAt(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) return 0;
  return Math.floor(timestamp / NR.periodSeconds);
}

/** Index (absolute, since protocol time 0) of the uptime window that contains a timestamp. */
export function uptimeWindowIndex(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) return 0;
  return Math.floor(timestamp / NR.uptimeWindowSeconds);
}

/** Position (0..windowsPerPeriod-1) of a timestamp's uptime window inside its reward period. */
export function uptimeWindowInPeriod(timestamp: number): number {
  return uptimeWindowIndex(timestamp) % NR.uptimeWindowsPerPeriod;
}

/** Number of set bits (live windows) in an evidence mask. */
export function popcount(mask: number): number {
  let n = mask >>> 0;
  let count = 0;
  while (n !== 0) {
    count += n & 1;
    n >>>= 1;
  }
  return count;
}

/** Start timestamp of a period. */
export function rewardPeriodStart(period: number): number {
  return period * NR.periodSeconds;
}

/** End timestamp (exclusive) of a period. */
export function rewardPeriodEnd(period: number): number {
  return (period + 1) * NR.periodSeconds;
}

export interface NodeLivenessEvidence {
  registered: boolean;
  /** Uptime windows of the period in which the node was provably up. */
  liveWindows: number;
  /** Distinct nodes that attested this node inside the period. */
  distinctAttesters: number;
  /** Nodes that existed for most of the period (the attestation universe). */
  peerUniverse: number;
}

export interface NodeParticipationEvidence {
  /** Blocks this node produced inside the period that are in the canonical chain. */
  blocksProduced: number;
  /** Blocks the protocol scheduled for this node's slots inside the period. */
  blocksExpected: number;
  /** Distinct peers this node attested inside the period. */
  attestationsMade: number;
}

export interface NodeReliabilityEvidence {
  /** Corroborated fault reports attributed to this node. */
  faults: number;
  /** Attestations from this node that contradicted the protocol (duplicates, lies). */
  invalidAttestations: number;
}

export interface NodeResponsivenessEvidence {
  /** Heartbeats that carried a height within tolerance of the network's. */
  responsiveHeartbeats: number;
  /** Heartbeats that carried a stale height. */
  staleHeartbeats: number;
}

export interface NodeEvidence {
  liveness: NodeLivenessEvidence;
  participation: NodeParticipationEvidence;
  reliability: NodeReliabilityEvidence;
  responsiveness: NodeResponsivenessEvidence;
}

export interface NodeScore {
  /** Uptime component, basis points. */
  uptimeBps: number;
  participationBps: number;
  reliabilityBps: number;
  responsivenessBps: number;
  /** Weighted total, basis points. */
  scoreBps: number;
  /** The node's score when eligible, 0 otherwise. This is its weight in the pool split. */
  weight: number;
  eligible: boolean;
  /** Machine-readable explanation, recomputed identically by every node. */
  reasons: string[];
}

/** Cap a value into [0, max] basis-point space. */
function clampBps(value: number, max = 10_000): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(max, Math.floor(value));
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Score one node from verified evidence. Pure function: the same evidence must
 * produce the same score on every node, so this takes no clock, no randomness
 * and no configuration beyond the consensus parameters.
 */
export function scoreNode(evidence: NodeEvidence): NodeScore {
  const reasons: string[] = [];
  const { liveness, participation, reliability, responsiveness } = evidence;

  // ── Uptime: live windows actually recorded, gated on independent attestation ──
  const requiredAttesters = Math.min(NR.minAttesters, Math.max(0, liveness.peerUniverse - 1));
  let uptimeBps = clampBps(Math.floor((liveness.liveWindows * 10_000) / NR.uptimeWindowsPerPeriod));
  if (liveness.peerUniverse <= 1) {
    // A one-node network cannot independently verify anyone, including itself. The protocol does not pretend
    // otherwise: it caps the claim at the bootstrap allowance and says so.
    uptimeBps = Math.min(uptimeBps, NR.bootstrapUptimeBps);
    reasons.push(`peerless network: uptime capped at ${NR.bootstrapUptimeBps} bps until another registered node attests`);
  } else if (liveness.distinctAttesters < requiredAttesters) {
    reasons.push(
      `uptime not independently attestable: ${liveness.distinctAttesters} distinct attester(s), ${requiredAttesters} required`,
    );
  }
  if (requiredAttesters > 0 && liveness.distinctAttesters < requiredAttesters) {
    uptimeBps = Math.floor((uptimeBps * liveness.distinctAttesters) / requiredAttesters);
  }

  // ── Participation: scheduled blocks produced + peers actually attested ────
  const producedBps =
    participation.blocksExpected > 0
      ? clampBps(Math.floor((participation.blocksProduced * 10_000) / participation.blocksExpected))
      : 0;
  const coverageDenominator = Math.max(1, liveness.peerUniverse - 1);
  const coverageBps = clampBps(Math.floor((participation.attestationsMade * 10_000) / coverageDenominator));
  const participationBps = clampBps(
    Math.floor((producedBps * NR.participationWeights.blocksBps + coverageBps * NR.participationWeights.coverageBps) / 10_000),
  );

  // ── Reliability: faults and lies, each costing the same flat penalty ──────
  const penaltyEvents = reliability.faults + reliability.invalidAttestations;
  const reliabilityBps = clampBps(10_000 - penaltyEvents * NR.faultPenaltyBps);
  if (penaltyEvents > 0) {
    reasons.push(
      `${penaltyEvents} protocol-attributed fault(s)/invalid attestation(s): −${penaltyEvents * NR.faultPenaltyBps} bps`,
    );
  }

  // ── Responsiveness: stayed in sync while up ───────────────────────────────
  const beats = responsiveness.responsiveHeartbeats + responsiveness.staleHeartbeats;
  const responsivenessBps = beats > 0 ? clampBps(Math.floor((responsiveness.responsiveHeartbeats * 10_000) / beats)) : 0;
  if (beats > 0 && responsivenessBps < 10_000) {
    reasons.push(
      `${responsiveness.staleHeartbeats} of ${beats} heartbeat(s) reported a height more than ${NR.responsiveHeightLag} blocks behind`,
    );
  }

  const w = NR.scoreWeights;
  const scoreBps = clampBps(
    Math.floor(
      (uptimeBps * w.uptimeBps +
        participationBps * w.participationBps +
        reliabilityBps * w.reliabilityBps +
        responsivenessBps * w.responsivenessBps) /
        10_000,
    ),
  );

  let eligible = true;
  if (!liveness.registered) {
    eligible = false;
    reasons.push('node is not registered with a bound reward wallet');
  }
  if (uptimeBps < NR.minUptimeBps) {
    eligible = false;
    reasons.push(`uptime ${uptimeBps} bps is below the eligibility floor ${NR.minUptimeBps} bps`);
  }
  if (scoreBps < NR.minScoreBps) {
    eligible = false;
    reasons.push(`score ${scoreBps} bps is below the eligibility floor ${NR.minScoreBps} bps`);
  }

  return {
    uptimeBps,
    participationBps,
    reliabilityBps,
    responsivenessBps,
    scoreBps,
    // The weight IS the score: floors above are gates, they are not subtracted.
    weight: eligible ? scoreBps : 0,
    eligible,
    reasons,
  };
}

export interface RewardAllocation {
  nodeId: string;
  rewardWallet: string;
  scoreBps: number;
  weight: number;
  /** Share of the period pool, basis points of the whole pool. */
  shareBps: number;
  /** Amount credited to `rewardWallet`, in seals. */
  amount: bigint;
}

export interface RewardSettlement {
  period: number;
  poolSeals: bigint;
  allocations: RewardAllocation[];
  /** Sum of allocated amounts. Equals `poolSeals` unless capped or nobody qualified. */
  distributedSeals: bigint;
  /** Remainder left in the pool for the next period (rounding and caps). */
  carriedSeals: bigint;
  eligibleNodes: number;
  scoredNodes: number;
  /** Machine-readable policy line, identical on every node. */
  method: string;
}

/**
 * Exact largest-remainder split of `pool` seals by integer `weights`, with a per-node ceiling.
 *
 *   - every weight is positive; nodes are given in a fixed order (by nodeId) and ties break in that order;
 *   - a node whose proportional share exceeds `capAmount` is fixed at `capAmount` and the others are re-split over
 *     what is left (repeated until no node exceeds it) — the overflow is redistributed, not stranded;
 *   - after flooring, the leftover seals (fewer than the number of nodes) go one each to the largest remainders;
 *   - Σ result ≤ pool, with equality unless every node is capped.
 */
export function allocateReward(pool: bigint, weights: bigint[], capAmount: bigint): bigint[] {
  const out: bigint[] = weights.map(() => 0n);
  let remaining = pool;
  let active = weights.map((_, index) => index);
  for (;;) {
    const total = active.reduce((sum, index) => sum + weights[index], 0n);
    if (total === 0n || remaining <= 0n || active.length === 0) return out;
    const over = active.filter((index) => (remaining * weights[index]) / total > capAmount);
    if (over.length === 0) {
      let given = 0n;
      const remainders: Array<{ index: number; rem: bigint }> = [];
      for (const index of active) {
        const numerator = remaining * weights[index];
        out[index] = numerator / total;
        remainders.push({ index, rem: numerator % total });
        given += out[index];
      }
      let leftover = remaining - given;
      remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
      for (const entry of remainders) {
        if (leftover <= 0n) break;
        if (out[entry.index] + 1n <= capAmount) {
          out[entry.index] += 1n;
          leftover -= 1n;
        }
      }
      return out;
    }
    for (const index of over) {
      out[index] = capAmount;
      remaining -= capAmount;
    }
    active = active.filter((index) => !over.includes(index));
  }
}

/**
 * Distribute a period's Node Reward Pool.
 *
 *   1. Score every candidate node from verified evidence (scoreNode).
 *   2. weight = scoreBps for eligible nodes, 0 otherwise.
 *   3. cap   = max(maxNodeShareBps, ceil(10 000 / contributors)) of the pool.
 *   4. amounts = allocateReward(pool, weights, cap).  An amount below `minPayoutSeals` is not paid: it stays in
 *      the pool for the next period.
 *
 * `nodes` must be sorted by nodeId by the caller, so the result does not depend on iteration order.
 */
export function settleNodeRewards(input: {
  period: number;
  poolSeals: bigint;
  nodes: Array<{ nodeId: string; evidence: NodeEvidence }>;
}): RewardSettlement {
  const scored = input.nodes.map((node) => ({ nodeId: node.nodeId, evidence: node.evidence, score: scoreNode(node.evidence) }));
  const scoredNodes = scored.length;
  const contributors = scored.filter((entry) => entry.score.eligible && entry.score.weight > 0);
  const totalWeight = contributors.reduce((sum, entry) => sum + BigInt(entry.score.weight), 0n);

  if (totalWeight === 0n || input.poolSeals <= 0n) {
    return {
      period: input.period,
      poolSeals: input.poolSeals,
      allocations: [],
      distributedSeals: 0n,
      carriedSeals: input.poolSeals,
      eligibleNodes: 0,
      scoredNodes,
      method:
        'no eligible node had a positive weight in this period; the whole pool is carried forward, not burned and not paid to anyone',
    };
  }

  const capBps = BigInt(Math.max(NR.maxNodeShareBps, Math.ceil(10_000 / contributors.length)));
  const capAmount = (input.poolSeals * capBps) / 10_000n;
  const amounts = allocateReward(
    input.poolSeals,
    contributors.map((entry) => BigInt(entry.score.weight)),
    capAmount,
  );

  const allocations: RewardAllocation[] = [];
  let distributed = 0n;
  contributors.forEach((entry, index) => {
    // Dust is carried, not paid: the seals stay in the pool and the next period's split includes them.
    const amount = amounts[index] >= NR.minPayoutSeals ? amounts[index] : 0n;
    distributed += amount;
    allocations.push({
      nodeId: entry.nodeId,
      rewardWallet: '',
      scoreBps: entry.score.scoreBps,
      weight: entry.score.weight,
      shareBps: Number((amount * 10_000n) / input.poolSeals),
      amount,
    });
  });

  const carriedSeals = input.poolSeals - distributed;
  if (carriedSeals < 0n) throw new Error('node reward settlement attempted to distribute more than the pool holds');

  return {
    period: input.period,
    poolSeals: input.poolSeals,
    allocations,
    distributedSeals: distributed,
    carriedSeals,
    eligibleNodes: allocations.filter((entry) => entry.amount > 0n).length,
    scoredNodes,
    method:
      'weight = scoreBps of eligible nodes (uptime, participation, reliability, responsiveness); ' +
      'amount = largest-remainder share of the pool with a per-node ceiling of max(maxNodeShareBps, ceil(10000/contributors)) ' +
      'and the overflow redistributed; amounts below minPayoutSeals and the rounding remainder are carried forward',
  };
}

export interface NodeRewardStatusView {
  nodeId: string;
  rewardWallet: string;
  registered: boolean;
  registeredAtHeight: number;
  period: number;
  score: NodeScore | null;
  paidObs: string;
  pendingObs: string;
  claimablePeriods: number[];
  pendingWalletChange: { wallet: string; effectivePeriod: number } | null;
  facts: {
    liveWindows: number;
    attesters: number;
    peerUniverse: number;
    blocksProduced: number;
    blocksExpected: number;
    attestationsMade: number;
    faults: number;
    invalidAttestations: number;
    staleHeartbeats: number;
  };
}

/** Parameters a node operator needs, published by every node identically. */
export function nodeRewardParams(): NodeRewardParamsSummary {
  return {
    nodePoolBps: NR.nodePoolShareBps,
    treasuryBps: NR.treasuryShareBps,
    periodSeconds: NR.periodSeconds,
    minUptimeBps: NR.minUptimeBps,
    minScoreBps: NR.minScoreBps,
    maxNodeShareBps: NR.maxNodeShareBps,
    minAttesters: NR.minAttesters,
    walletChangeDelayPeriods: NR.walletChangeDelayPeriods,
    evidenceWindowPeriods: NR.evidenceWindowPeriods,
    uptimeWindowSeconds: NR.uptimeWindowSeconds,
    uptimeWindowsPerPeriod: NR.uptimeWindowsPerPeriod,
    minPayoutSeals: NR.minPayoutSeals.toString(),
    reclaimDelayPeriods: NR.reclaimDelayPeriods,
    scoreWeights: { ...NR.scoreWeights },
  };
}
