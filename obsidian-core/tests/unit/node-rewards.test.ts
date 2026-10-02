/**
 * Node runner economics: the 40/60 split, the scoring formula and the
 * settlement algorithm, tested as arithmetic.
 *
 * These are pure-function tests. The on-chain behaviour (registration, proof of
 * wallet ownership, evidence, settlement inside a block) is exercised against a
 * real chain in tests/integration/node-runners.test.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  NOT_PLATFORM_REVENUE,
  RevenueSource,
  assertSplitInvariant,
  splitPlatformRevenue,
} from '../../src/economy/accounting.js';
import {
  rewardPeriodAt,
  rewardPeriodEnd,
  rewardPeriodStart,
  scoreNode,
  settleNodeRewards,
  type NodeEvidence,
} from '../../src/economy/node-rewards.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { parseObs } from '../../src/protocol/amount.js';
import { TxType } from '../../src/protocol/types.js';

const NR = CONSENSUS_PARAMS.nodeRewards;

/** Evidence for a node that did everything right in a network of `peers`. */
function perfectEvidence(peers = 4): NodeEvidence {
  return {
    liveness: { registered: true, heartbeats: NR.heartbeatsPerPeriod, distinctAttesters: peers - 1, peerUniverse: peers },
    participation: { blocksProduced: 10, blocksExpected: 10, attestationsMade: peers - 1 },
    reliability: { faults: 0, invalidAttestations: 0 },
    responsiveness: { responsiveHeartbeats: NR.heartbeatsPerPeriod, staleHeartbeats: 0 },
  };
}

describe('the 40/60 revenue split', () => {
  it('sends exactly 40% to node runners and 60% to the treasury', () => {
    const split = splitPlatformRevenue(parseObs('100'), RevenueSource.ONS_REGISTRATION);
    expect(split.nodeRunnerPool).toBe(parseObs('40'));
    expect(split.treasury).toBe(parseObs('60'));
    expect(split.nodePoolBps).toBe(4_000);
    expect(split.treasuryBps).toBe(6_000);
  });

  it('never loses or invents a seal, at any amount', () => {
    // Includes amounts that do not divide by 10_000: the remainder must land
    // somewhere, and it must land in the treasury rather than vanishing.
    for (const amount of [1n, 2n, 3n, 7n, 9_999n, 10_000n, 10_001n, 123_456_789n, parseObs('0.000000000000000001'), parseObs('21000000')]) {
      const split = splitPlatformRevenue(amount, RevenueSource.EXPLICIT_PAYMENT);
      assertSplitInvariant(split);
      expect(split.nodeRunnerPool + split.treasury).toBe(amount);
      expect(split.nodeRunnerPool).toBeLessThanOrEqual(amount);
      expect(split.treasury).toBeGreaterThanOrEqual(split.nodeRunnerPool === 0n ? amount : 0n);
    }
  });

  it('floors the node share, so the treasury absorbs the rounding dust', () => {
    // 9 seals: 40% is 3.6 → the node pool takes 3, the treasury takes 6.
    const split = splitPlatformRevenue(9n, RevenueSource.BUSINESS_PAGE);
    expect(split.nodeRunnerPool).toBe(3n);
    expect(split.treasury).toBe(6n);
  });

  it('refuses a non-positive amount instead of silently doing nothing', () => {
    expect(() => splitPlatformRevenue(0n, RevenueSource.ONS_RENEWAL)).toThrow(/must be positive/);
    expect(() => splitPlatformRevenue(-5n, RevenueSource.ONS_RENEWAL)).toThrow(/must be positive/);
  });

  it('keeps the two shares summing to 100% in the parameters themselves', () => {
    expect(NR.nodePoolShareBps + NR.treasuryShareBps).toBe(10_000);
  });

  it('documents what is NOT platform revenue, including user transfers and mining', () => {
    const kinds = NOT_PLATFORM_REVENUE.map((entry) => entry.txType);
    expect(kinds).toContain(TxType.PAYMENT);
    expect(kinds).toContain(TxType.MINING_CLAIM);
    expect(kinds).toContain(TxType.CAPSULE);
    expect(kinds).toContain(TxType.VALIDATOR);
    for (const entry of NOT_PLATFORM_REVENUE) expect(entry.because.length).toBeGreaterThan(10);
  });
});

describe('reward periods', () => {
  it('maps protocol time onto fixed, non-overlapping windows', () => {
    const period = rewardPeriodAt(NR.periodSeconds * 5 + 17);
    expect(period).toBe(5);
    expect(rewardPeriodStart(5)).toBe(NR.periodSeconds * 5);
    expect(rewardPeriodEnd(5)).toBe(NR.periodSeconds * 6);
    expect(rewardPeriodAt(rewardPeriodEnd(5))).toBe(6);
  });

  it('never returns a negative period for a nonsense timestamp', () => {
    expect(rewardPeriodAt(-1)).toBe(0);
    expect(rewardPeriodAt(Number.NaN)).toBe(0);
  });
});

describe('node scoring', () => {
  it('gives a fully participating node a high score and makes it eligible', () => {
    const score = scoreNode(perfectEvidence());
    expect(score.eligible).toBe(true);
    expect(score.uptimeBps).toBe(10_000);
    expect(score.participationBps).toBe(10_000);
    expect(score.reliabilityBps).toBe(10_000);
    expect(score.responsivenessBps).toBe(10_000);
    expect(score.scoreBps).toBe(10_000);
  });

  it('ranks a node with more verified uptime above one with less', () => {
    const full = scoreNode(perfectEvidence());
    const half = scoreNode({
      ...perfectEvidence(),
      liveness: { registered: true, heartbeats: 0, distinctAttesters: 3, peerUniverse: 4 },
      responsiveness: { responsiveHeartbeats: 0, staleHeartbeats: 0 },
    });
    expect(half.scoreBps).toBeLessThan(full.scoreBps);
    expect(half.eligible).toBe(false); // zero uptime cannot earn
    expect(half.reasons.join(' ')).toMatch(/below the eligibility floor/);
  });

  it('cannot be satisfied by self-assertion: uptime needs independent attesters', () => {
    const unattested = scoreNode({
      ...perfectEvidence(),
      liveness: { registered: true, heartbeats: NR.heartbeatsPerPeriod, distinctAttesters: 0, peerUniverse: 4 },
    });
    // The node sent its heartbeat and claims to be up. Without any peer saying
    // the same, the uptime component collapses to zero.
    expect(unattested.uptimeBps).toBe(0);
    expect(unattested.eligible).toBe(false);
    expect(unattested.reasons.join(' ')).toMatch(/not independently attestable/);
  });

  it('scales uptime by how much independent corroboration exists', () => {
    const partial = scoreNode({
      ...perfectEvidence(),
      liveness: { registered: true, heartbeats: NR.heartbeatsPerPeriod, distinctAttesters: 1, peerUniverse: 4 },
    });
    // One of the two required attesters: half credit, not full and not zero.
    expect(partial.uptimeBps).toBe(5_000);
  });

  it('caps a peerless network honestly instead of pretending it is verified', () => {
    const alone = scoreNode({
      liveness: { registered: true, heartbeats: NR.heartbeatsPerPeriod, distinctAttesters: 0, peerUniverse: 1 },
      participation: { blocksProduced: 5, blocksExpected: 5, attestationsMade: 0 },
      reliability: { faults: 0, invalidAttestations: 0 },
      responsiveness: { responsiveHeartbeats: NR.heartbeatsPerPeriod, staleHeartbeats: 0 },
    });
    expect(alone.uptimeBps).toBe(NR.bootstrapUptimeBps);
    expect(alone.reasons.join(' ')).toMatch(/peerless network/);
  });

  it('penalises corroborated faults and stale synchronisation', () => {
    const faulty = scoreNode({ ...perfectEvidence(), reliability: { faults: 2, invalidAttestations: 0 } });
    expect(faulty.reliabilityBps).toBe(10_000 - 2 * NR.faultPenaltyBps);
    expect(faulty.scoreBps).toBeLessThan(scoreNode(perfectEvidence()).scoreBps);

    const stale = scoreNode({
      ...perfectEvidence(),
      responsiveness: { responsiveHeartbeats: 0, staleHeartbeats: NR.heartbeatsPerPeriod },
    });
    expect(stale.responsivenessBps).toBe(0);
    expect(stale.reasons.join(' ')).toMatch(/behind/);
  });

  it('refuses an unregistered node no matter how good its evidence looks', () => {
    const unregistered = scoreNode({
      ...perfectEvidence(),
      liveness: { ...perfectEvidence().liveness, registered: false },
    });
    expect(unregistered.eligible).toBe(false);
    expect(unregistered.weight).toBe(0);
    expect(unregistered.reasons.join(' ')).toMatch(/signed proof of ownership/);
  });

  it('weights the four components exactly as the parameters declare', () => {
    expect(
      NR.scoreWeights.uptimeBps +
        NR.scoreWeights.participationBps +
        NR.scoreWeights.reliabilityBps +
        NR.scoreWeights.responsivenessBps,
    ).toBe(10_000);
  });

  it('is deterministic: identical evidence always scores identically', () => {
    expect(scoreNode(perfectEvidence())).toEqual(scoreNode(perfectEvidence()));
  });
});

describe('settlement arithmetic', () => {
  const pool = parseObs('1000');

  it('splits a period proportionally to verified weight', () => {
    const settlement = settleNodeRewards({
      period: 3,
      poolSeals: pool,
      nodes: [
        { nodeId: 'aaa', evidence: perfectEvidence() },
        { nodeId: 'bbb', evidence: perfectEvidence() },
      ],
    });
    expect(settlement.allocations).toHaveLength(2);
    // Two identical nodes, but the per-node cap is 5%, so neither can take half
    // of the pool: the rest is carried to the next period rather than paid out.
    for (const allocation of settlement.allocations) {
      expect(allocation.shareBps).toBeLessThanOrEqual(NR.maxNodeShareBps);
    }
    expect(settlement.distributedSeals + settlement.carriedSeals).toBe(pool);
  });

  it('never distributes more than the pool holds', () => {
    const many = Array.from({ length: 50 }, (_, index) => ({
      nodeId: `node-${String(index).padStart(3, '0')}`,
      evidence: perfectEvidence(50),
    }));
    const settlement = settleNodeRewards({ period: 1, poolSeals: pool, nodes: many });
    expect(settlement.distributedSeals).toBeLessThanOrEqual(pool);
    expect(settlement.distributedSeals + settlement.carriedSeals).toBe(pool);
  });

  it('pays an offline node nothing while paying an online one', () => {
    const offline: NodeEvidence = {
      liveness: { registered: true, heartbeats: 0, distinctAttesters: 0, peerUniverse: 2 },
      participation: { blocksProduced: 0, blocksExpected: 10, attestationsMade: 0 },
      reliability: { faults: 0, invalidAttestations: 0 },
      responsiveness: { responsiveHeartbeats: 0, staleHeartbeats: 0 },
    };
    const settlement = settleNodeRewards({
      period: 2,
      poolSeals: pool,
      nodes: [
        { nodeId: 'online', evidence: perfectEvidence(2) },
        { nodeId: 'offline', evidence: offline },
      ],
    });
    const paid = settlement.allocations.map((allocation) => allocation.nodeId);
    expect(paid).toContain('online');
    expect(paid).not.toContain('offline');
  });

  it('carries the whole pool forward when nobody qualifies — never burns it', () => {
    const settlement = settleNodeRewards({
      period: 4,
      poolSeals: pool,
      nodes: [
        {
          nodeId: 'idle',
          evidence: {
            liveness: { registered: true, heartbeats: 0, distinctAttesters: 0, peerUniverse: 3 },
            participation: { blocksProduced: 0, blocksExpected: 5, attestationsMade: 0 },
            reliability: { faults: 0, invalidAttestations: 0 },
            responsiveness: { responsiveHeartbeats: 0, staleHeartbeats: 0 },
          },
        },
      ],
    });
    expect(settlement.distributedSeals).toBe(0n);
    expect(settlement.carriedSeals).toBe(pool);
    expect(settlement.method).toMatch(/carried forward, not burned/);
  });

  it('settles an empty pool without error', () => {
    const settlement = settleNodeRewards({ period: 5, poolSeals: 0n, nodes: [{ nodeId: 'a', evidence: perfectEvidence() }] });
    expect(settlement.distributedSeals).toBe(0n);
    expect(settlement.carriedSeals).toBe(0n);
  });

  it('is deterministic: the same evidence settles to the same payouts every time', () => {
    const nodes = [
      { nodeId: 'aaa', evidence: perfectEvidence(6) },
      { nodeId: 'bbb', evidence: { ...perfectEvidence(6), reliability: { faults: 1, invalidAttestations: 0 } } },
      { nodeId: 'ccc', evidence: { ...perfectEvidence(6), participation: { blocksProduced: 2, blocksExpected: 10, attestationsMade: 2 } } },
    ];
    const first = settleNodeRewards({ period: 9, poolSeals: pool, nodes });
    const second = settleNodeRewards({ period: 9, poolSeals: pool, nodes });
    expect(first).toEqual(second);
    // And a better node is never paid less than a worse one.
    const byId = new Map(first.allocations.map((allocation) => [allocation.nodeId, allocation.amount]));
    expect(byId.get('aaa')!).toBeGreaterThanOrEqual(byId.get('bbb') ?? 0n);
    expect(byId.get('bbb') ?? 0n).toBeGreaterThanOrEqual(byId.get('ccc') ?? 0n);
  });

  it('caps any single node so one operator cannot take a whole period', () => {
    const settlement = settleNodeRewards({
      period: 11,
      poolSeals: pool,
      nodes: [{ nodeId: 'solo', evidence: perfectEvidence(3) }],
    });
    const [allocation] = settlement.allocations;
    expect(allocation.shareBps).toBeLessThanOrEqual(NR.maxNodeShareBps);
    expect(allocation.amount).toBeLessThanOrEqual((pool * BigInt(NR.maxNodeShareBps)) / 10_000n);
  });
});
