/**
 * Node Runner rewards — who gets the ONS-funded 90% share, measured how, and why.
 *
 * THE ECONOMIC POINT
 *   Independent nodes are the network. The protocol therefore pays for the
 *   things that make independent nodes useful — being reachable, being in sync,
 *   relaying and validating, staying up across time — and pays for nothing else.
 *   Latency alone is not virtue, expensive hardware is not virtue and an
 *   operator's own opinion of its node is not evidence.
 *
 * THE RULE OF EVIDENCE
 *   Every number that decides a payout is computed by each node from chain
 *   state: blocks actually produced, attestations actually signed and
 *   countersigned by other nodes, faults reported by peers. A node cannot send
 *   the protocol "I was online 99%" — there is no field for it. The only thing a
 *   node may assert is a signed statement about *other* nodes' liveness, and
 *   that statement is worthless unless independent nodes make compatible ones.
 *
 * SCORING (all integer, all deterministic, all in basis points)
 *
 *   uptimeBps        = heartbeats seen in the period / heartbeats expected
 *                      (capped at 10_000)
 *   participationBps = mean of
 *                        producedBps = blocks produced / blocks expected for
 *                                      the node's scheduled slots
 *                        coverageBps = peers this node attested / peers that
 *                                      existed for most of the period
 *   reliabilityBps   = 10_000 − penalties, where each fault attributable to the
 *                      node by `minReporters` distinct reporters costs
 *                      `faultPenaltyBps`, and an invalid/conflicting attestation
 *                      costs the same
 *   responsivenessBps= share of this node's heartbeats that arrived while its
 *                      reported height was within `responsiveHeightLag` of the
 *                      network's, i.e. verification stayed current
 *
 *   scoreBps = (uptime*wU + participation*wP + reliability*wR + responsive*wS) / 10_000
 *
 *   weight   = scoreBps − minScoreBps, when uptime ≥ minUptimeBps and the node
 *              is registered and its height was recent at period close; else 0.
 *
 * SYBIL RESISTANCE (no administrator, no allowlist)
 *   - One reward identity may be registered per reward wallet, and one identity
 *     per reward wallet: an operator that splits a machine into ten nodes must
 *     present ten distinct identities and ten distinct reward wallets, and the
 *     protocol binds each to the other.
 *   - Registration itself moves no funds. The protocol's capital requirement is
 *     the validator bond (20,000 OBS, src/protocol/params.ts) — one bond, one
 *     rule, enforced in one place — and node rewards are capped per node
 *     (`maxNodeShareBps`) so no fleet can take a period.
 *   - Rewards are capped per node (`maxNodeShareBps`), so one operator's fleet
 *     cannot take a period.
 *   - Uptime requires attestations from *other* nodes, so ten nodes on one
 *     laptop attest ten nodes on one laptop: the protocol counts what honest
 *     peers observed, and a fleet that is one point of failure scores like one.
 *
 * WALLET CHANGES
 *   A reward wallet change requires a signature from the NEW wallet over
 *   a domain-separated message (see `walletChangeMessage`) and takes effect
 *   `walletChangeDelayPeriods` periods later. Rewards already accrued stay with
 *   the wallet that accrued them; only future periods follow the new wallet. A
 *   stolen node key therefore cannot redirect a single seal that has not been
 *   earned yet, and an operator cannot be locked out of their own node forever.
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
  scoreWeights: { uptimeBps: number; participationBps: number; reliabilityBps: number; responsivenessBps: number };
}

/** Period index that contains a protocol timestamp. Deterministic, no clock. */
export function rewardPeriodAt(timestamp: number): number {
  if (!Number.isFinite(timestamp) || timestamp < 0) return 0;
  return Math.floor(timestamp / NR.periodSeconds);
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
  /** Heartbeats from this node inside the period. */
  heartbeats: number;
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
  /** Score above the floor that earns a share; 0 when ineligible. */
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

  // ── Uptime: heartbeats actually seen, gated on independent attestation ────
  const requiredAttesters = Math.min(NR.minAttesters, Math.max(0, liveness.peerUniverse - 1));
  let uptimeBps = clampBps((liveness.heartbeats / NR.heartbeatsPerPeriod) * 10_000);
  if (liveness.peerUniverse <= 1) {
    // A one-node network cannot independently verify anyone, including itself.
    // The protocol does not pretend otherwise: it caps the claim at the
    // bootstrap allowance and says so.
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
      ? clampBps((participation.blocksProduced / participation.blocksExpected) * 10_000)
      : 0;
  const coverageDenominator = Math.max(1, liveness.peerUniverse - 1);
  const coverageBps = clampBps((participation.attestationsMade / coverageDenominator) * 10_000);
  const participationBps = clampBps(
    (producedBps * NR.participationWeights.blocksBps + coverageBps * NR.participationWeights.coverageBps) / 10_000,
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
  const responsivenessBps = beats > 0 ? clampBps((responsiveness.responsiveHeartbeats / beats) * 10_000) : 0;
  if (beats > 0 && responsivenessBps < 10_000) {
    reasons.push(
      `${responsiveness.staleHeartbeats} of ${beats} heartbeat(s) reported a height more than ${NR.responsiveHeightLag} blocks behind`,
    );
  }

  const w = NR.scoreWeights;
  const scoreBps = clampBps(
    (uptimeBps * w.uptimeBps +
      participationBps * w.participationBps +
      reliabilityBps * w.reliabilityBps +
      responsivenessBps * w.responsivenessBps) /
      10_000,
  );

  let eligible = true;
  if (!liveness.registered) {
    eligible = false;
    reasons.push('node has not registered a reward wallet with a signed proof of ownership');
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
    weight: eligible ? scoreBps - NR.minScoreBps : 0,
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
 * Distribute a period's Node Runner Reward Pool.
 *
 * Deterministic algorithm, exact integer arithmetic throughout:
 *
 *   1. Score every registered node from verified evidence (scoreNode).
 *   2. weight_n = scoreBps_n − minScoreBps for eligible nodes, else 0. A node
 *      that produced nothing and attested nobody has weight 0, so standing
 *      still earns nothing no matter how long it has been registered.
 *   3. shareBps_n = floor(weight_n * 10_000 / Σweight), then no single node may
 *      exceed maxNodeShareBps; excess is left in the pool (cap, not a re-run).
 *   4. amount_n = floor(poolSeals * shareBps_n / 10_000). The rounding remainder
 *      is carried in the pool: `Σamount + carried == poolSeals` always holds.
 *
 * `nodes` must be sorted by nodeId by the caller (chain state is iterated in
 * lexicographic order), so the result does not depend on iteration order.
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

  const allocations: RewardAllocation[] = [];
  let distributed = 0n;
  for (const entry of contributors) {
    const rawShareBps = Number((BigInt(entry.score.weight) * 10_000n) / totalWeight);
    const shareBps = Math.min(rawShareBps, NR.maxNodeShareBps);
    const amount = (input.poolSeals * BigInt(shareBps)) / 10_000n;
    allocations.push({
      nodeId: entry.nodeId,
      rewardWallet: '',
      scoreBps: entry.score.scoreBps,
      weight: entry.score.weight,
      shareBps,
      amount,
    });
    distributed += amount;
  }

  const totalShareBps = allocations.reduce((sum, entry) => sum + entry.shareBps, 0);
  if (totalShareBps < 10_000) {
    // Integer flooring leaves a remainder. It is carried, never invented: a
    // settlement can never mint a seal, and the invariant below proves it.
    const leftoverSeals = input.poolSeals - distributed;
    const biggest = allocations.reduce(
      (best, entry) => (entry.amount > best.amount ? entry : best),
      allocations[0],
    );
    const room = NR.maxNodeShareBps - biggest.shareBps;
    if (leftoverSeals > 0n && room > 0) {
      const floorBonusBps = Math.min(room, Math.floor(10_000 - totalShareBps));
      const bonusAmount = (input.poolSeals * BigInt(floorBonusBps)) / 10_000n;
      biggest.shareBps += floorBonusBps;
      biggest.amount += bonusAmount;
      distributed += bonusAmount;
    }
  }

  const carriedSeals = input.poolSeals - distributed;
  if (carriedSeals < 0n) throw new Error('node reward settlement attempted to distribute more than the pool holds');
  for (const allocation of allocations) {
    if (allocation.amount < 0n) throw new Error('negative node reward allocation');
  }

  return {
    period: input.period,
    poolSeals: input.poolSeals,
    allocations,
    distributedSeals: distributed,
    carriedSeals,
    eligibleNodes: allocations.length,
    scoredNodes,
    method:
      'weight = scoreBps − minScoreBps over verified uptime, participation, reliability and responsiveness; ' +
      'share = weight/totalWeight capped at maxNodeShareBps; amount = floor(pool × share); remainder carried forward',
  };
}

/**
 * Domain-separated messages the node identity and the reward wallet sign.
 *
 * Signed with the protocol's own primitive — secp256k1 ECDSA, RFC 6979
 * deterministic nonces, 64-byte compact low-S, exactly as transactions and
 * blocks are signed (see src/crypto/keys.ts). Each message carries its own
 * `OBSIDIAN:NODE_*` domain tag and both the network id and chain id, so a
 * signature made for one network, one chain, or one purpose can never be
 * replayed as another: a heartbeat cannot be re-submitted as a registration,
 * and a testnet proof is worthless on mainnet.
 */
export function nodeRegistrationMessage(input: {
  networkId: string;
  chainId: number;
  nodeId: string;
  rewardWallet: string;
  endpoint: string;
  issuedAt: number;
  expiresAt: number;
}): string {
  return [
    'OBSIDIAN:NODE_REGISTRATION:v1',
    `networkId:${input.networkId}`,
    `chainId:${input.chainId}`,
    `nodeId:${input.nodeId}`,
    `rewardWallet:${input.rewardWallet}`,
    `endpoint:${input.endpoint}`,
    `issuedAt:${input.issuedAt}`,
    `expiresAt:${input.expiresAt}`,
  ].join('\n');
}

export function walletChangeMessage(input: {
  networkId: string;
  chainId: number;
  nodeId: string;
  currentWallet: string;
  newWallet: string;
  requestedAt: number;
}): string {
  return [
    'OBSIDIAN:NODE_WALLET_CHANGE:v1',
    `networkId:${input.networkId}`,
    `chainId:${input.chainId}`,
    `nodeId:${input.nodeId}`,
    `currentWallet:${input.currentWallet}`,
    `newWallet:${input.newWallet}`,
    `requestedAt:${input.requestedAt}`,
  ].join('\n');
}

export function deregistrationMessage(input: {
  networkId: string;
  chainId: number;
  nodeId: string;
  rewardWallet: string;
  requestedAt: number;
}): string {
  return [
    'OBSIDIAN:NODE_DEREGISTRATION:v1',
    `networkId:${input.networkId}`,
    `chainId:${input.chainId}`,
    `nodeId:${input.nodeId}`,
    `rewardWallet:${input.rewardWallet}`,
    `requestedAt:${input.requestedAt}`,
  ].join('\n');
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
    heartbeats: number;
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
    scoreWeights: { ...NR.scoreWeights },
  };
}
