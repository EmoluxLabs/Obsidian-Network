/**
 * Canonical state root.
 *
 * Every node computes the same state root for the same block, or the block is
 * rejected (ErrCode.BAD_STATE_ROOT). The root is a domain-separated SHA-256 over
 * a canonical serialization of every consensus-relevant collection, with all
 * maps emitted in lexicographic key order and no floating-point numbers anywhere.
 *
 * Deliberately excluded from the root: nothing. If a field can influence a
 * future decision it must be in the root, otherwise two nodes could diverge
 * without noticing.
 */

import { Writer } from '../protocol/encoding.js';
import { DOMAIN } from '../protocol/domains.js';
import { domainHash } from '../crypto/hash.js';
import type {
  Account,
  CapsuleRecord,
  DivisionRecord,
  GenesisState,
  Metrics,
  MiningPoolState,
  NodeEvidenceRecord,
  NodeRecord,
  NodeRewardPoolState,
  OnsRecord,
  OracleState,
  ParcelRecord,
  PostRecord,
  SocialRecord,
} from '../protocol/types.js';
import type { MutableState } from './state.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { sha256Hex, utf8 } from '../crypto/hash.js';
import { encode } from '../protocol/encoding.js';

/**
 * Deterministic fingerprint of the consensus parameter set. Nodes exchange this
 * in the p2p handshake: a peer with a different hash is on a different protocol
 * and is refused, which surfaces accidental forks immediately.
 */
export const PARAMS_HASH: string = sha256Hex(
  encode((w) => {
    const p = CONSENSUS_PARAMS;
    w.string(p.protocolVersion);
    w.u128(p.maxSupply);
    w.u128(p.genesisAllocation);
    w.u64(BigInt(p.mining.claimIntervalSeconds));
    w.u32(p.mining.maxClaimsPerCycle);
    w.u64(BigInt(p.mining.cycleSeconds));
    w.u128(p.mining.initialDailyReward);
    w.u128(p.mining.initialClaimReward);
    w.u64(BigInt(p.mining.activeMinerWindowSeconds));
    w.u32(p.mining.reductionBasisPointsPerStep);
    w.u64(BigInt(p.mining.reductionStepMiners));
    w.u128(p.mining.dailyRewardFloor);
    w.u32(p.gas.basisPoints);
    w.u128(p.gas.maxGas);
    w.u64(BigInt(p.block.targetBlockSeconds));
    w.u32(p.block.maxBlockBytes);
    w.u32(p.block.maxBlockTransactions);
    w.u32(p.block.maxFutureDriftSeconds);
    w.u32(p.block.medianTimePastWindow);
    w.u128(p.consensus.minValidatorBond);
    w.u64(BigInt(p.consensus.unbondingBlocks));
    w.u32(p.block.confirmationDepthHard);
    w.u32(p.tx.expiryBlocks);
    w.u32(p.tx.maxMemoBytes);
    w.u32(p.tx.maxTxBytes);
    w.u32(p.ons.minLength);
    w.u32(p.ons.maxLength);
    w.u128(p.ons.registrationFee);
    w.u128(p.ons.renewalFee);
    w.u64(BigInt(p.ons.termSeconds));
    w.u128(p.capsules.minCommitment);
    w.u128(p.capsules.timeTravelMultiplier);
    w.u32(p.capsules.previewSeconds);
    w.u32(p.capsules.maxPreviewsPerAccount);
    w.u64(BigInt(p.circle.parcelSquareMetres));
    w.u32(p.circle.appreciationStepBps);
    w.u32(p.circle.depreciationStepBps);
    w.u64(p.circle.minGlvUsd);
    w.u64(p.circle.maxGlvUsd);
    w.u32(p.social.monetisationMinFollowers);
    w.u32(p.social.monetisationMinMonthlyViews);
    w.u32(p.social.creatorShareBps);
    w.u32(p.social.networkShareBps);
    w.u128(p.social.businessPagePrice);
    w.u32(p.oracle.maxAgeSeconds);
    w.u32(p.oracle.minSources);
    w.u32(p.oracle.maxDeviationBps);
    w.u64(p.oracle.minPriceUsdMicro);
    w.u64(p.oracle.maxPriceUsdMicro);
    w.u32(p.registry.maxInvitesPerAccount);
    w.u128(p.registry.newAccountBalance);
    // Proof of Time: the timing rule is consensus, so it is fingerprinted.
    w.string(p.proofOfTime.consensus);
    w.string(p.proofOfTime.weightRule);
    w.u32(p.proofOfTime.difficultyWindowBlocks);
    w.u32(p.proofOfTime.difficultyTargetSeconds);
    w.u32(p.proofOfTime.minDifficultyBps);
    w.u32(p.proofOfTime.maxDifficultyBps);
    w.u32(p.proofOfTime.minBlockSpacingMs);
    w.u64(BigInt(p.proofOfTime.timeRateWindowSeconds));
    // Node runner rewards: the 40/60 split and every scoring input are
    // consensus. A node built with a different split has a different params
    // hash and is refused at the handshake instead of silently forking.
    w.u32(p.nodeRewards.nodePoolShareBps);
    w.u32(p.nodeRewards.treasuryShareBps);
    w.u64(BigInt(p.nodeRewards.periodSeconds));
    w.u32(p.nodeRewards.minUptimeBps);
    w.u32(p.nodeRewards.minScoreBps);
    w.u32(p.nodeRewards.minAttesters);
    w.u32(p.nodeRewards.bootstrapUptimeBps);
    w.u32(p.nodeRewards.maxAttestationsPerAttester);
    w.u32(p.nodeRewards.heartbeatsPerPeriod);
    w.u32(p.nodeRewards.maxFaultReportsPerReporterPerPeriod);
    w.u32(p.nodeRewards.faultPenaltyBps);
    w.u32(p.nodeRewards.responsiveHeightLag);
    w.u32(p.nodeRewards.scoreWeights.uptimeBps);
    w.u32(p.nodeRewards.scoreWeights.participationBps);
    w.u32(p.nodeRewards.scoreWeights.reliabilityBps);
    w.u32(p.nodeRewards.scoreWeights.responsivenessBps);
    w.u32(p.nodeRewards.participationWeights.blocksBps);
    w.u32(p.nodeRewards.participationWeights.coverageBps);
    w.u32(p.nodeRewards.maxNodeShareBps);
    w.u32(p.nodeRewards.walletChangeDelayPeriods);
    w.u32(p.nodeRewards.evidenceWindowPeriods);
    w.u32(p.nodeRewards.minRegistrationBlocks);
    w.u64(BigInt(p.nodeRewards.proofMaxValiditySeconds));
    w.u128(p.nodeRewards.registrationBond);
  }),
).slice(0, 32);

function encodeAccount(w: Writer, address: string, a: Account): void {
  w.string(address);
  w.u128(a.balance);
  w.u32(a.nonce);
  w.u128(a.totalReceived);
  w.u128(a.totalSent);
  w.u32(a.txCount);
  w.u32(a.createdAtHeight);
  w.u64(BigInt(Math.trunc(a.createdAt)));
  w.boolean(Boolean(a.flags.verifiedBlue));
  w.boolean(Boolean(a.flags.verifiedGold));
  w.boolean(Boolean(a.flags.businessPage));
  w.boolean(Boolean(a.flags.monetisationEnabled));
  w.boolean(Boolean(a.flags.suspended));
  const m = a.mining;
  w.boolean(Boolean(m));
  if (m) {
    w.u32(m.claimSequence);
    w.u64(BigInt(Math.trunc(m.lastClaimAt)));
    w.u32(m.lastClaimHeight);
    w.u64(BigInt(Math.trunc(m.cycleStartAt)));
    w.u32(m.claimsThisCycle);
    w.u32(m.totalClaims);
    w.u128(m.totalReward);
    w.boolean(m.eligible);
  }
  const v = a.validator;
  w.boolean(Boolean(v));
  if (v) {
    w.string(v.validatorKey);
    w.u128(v.bond);
    w.u32(v.commissionBps);
    w.u32(v.registeredAtHeight);
    w.u32(v.jailedUntilHeight ?? 0);
    w.u32(v.missedSlots);
    w.string(v.status);
    w.u32(v.unbondingStartHeight ?? 0);
  }
}

function encodeGenesis(w: Writer, g: GenesisState): void {
  w.boolean(g.allocationClaimed);
  w.string(g.recipient);
  w.string(g.treasuryWallet);
  w.u32(g.claimedAtHeight ?? 0);
  w.string(g.claimedByTxId ?? '');
  w.u128(g.amount);
}

function encodeName(w: Writer, n: OnsRecord): void {
  w.string(n.name);
  w.string(n.owner);
  w.string(n.address);
  w.u32(n.registeredAtHeight);
  w.u64(BigInt(Math.trunc(n.registeredAt)));
  w.u64(BigInt(Math.trunc(n.expiresAt)));
  w.u32(n.transferCount);
}

function encodeDivision(w: Writer, d: DivisionRecord): void {
  w.string(d.divisionId);
  w.string(d.countryCode);
  w.u64(d.glvUsdMicro);
  w.u32(d.protocolPurchases);
  w.u32(d.protocolBuybacks);
  w.u32(d.lastUpdatedAtHeight);
}

function encodeParcel(w: Writer, p: ParcelRecord): void {
  w.string(p.parcelId);
  w.string(p.divisionId);
  w.string(p.countryCode);
  w.string(p.cityId ?? '');
  w.string(p.districtId ?? '');
  w.string(p.streetId ?? '');
  w.i128(BigInt(p.latMicro ?? 0));
  w.i128(BigInt(p.lonMicro ?? 0));
  w.u64(BigInt(p.squareMetres));
  w.string(p.owner);
  w.u64(p.glvUsdMicro);
  w.u64(p.ilvUsdMicro ?? 0n);
  w.u128(p.mspObs ?? 0n);
  w.string(p.status);
  w.u32(p.acquiredAtHeight);
  w.u32(p.issuedAtHeight);
  w.u32(p.transferCount);
  w.u32(p.lastProtocolAdjustmentHeight ?? 0);
  w.u32(p.glvUpdatedAtHeight ?? 0);
  w.u32(p.glvEntryCount ?? 0);
  w.u32(p.plotIndex ?? 0);
  w.u8(p.level ?? 0);
  w.string(p.subId ?? '');
}

function encodeCapsule(w: Writer, c: CapsuleRecord): void {
  w.string(c.capsuleId);
  w.string(c.owner);
  w.u128(c.creatorCommitment);
  w.string(c.contentCommitment);
  w.u32(c.contentBytes);
  w.string(c.contentNonce);
  w.u64(BigInt(Math.trunc(c.createdAt)));
  w.u32(c.createdAtHeight);
  w.u64(BigInt(Math.trunc(c.unlockAt)));
  w.string(c.status);
  w.u32(c.unlockedAtHeight ?? 0);
  w.u128(c.poolContribution ?? 0n);
  w.string(c.teaser ?? '');
  w.u32(c.previewedBy.length);
  for (const viewer of [...c.previewedBy].sort()) w.string(viewer);
  w.u32(c.previewCount);
  w.u128(c.totalTimeTravelRevenue);
}

function encodeSocial(w: Writer, s: SocialRecord): void {
  w.string(s.accountId);
  w.string(s.handle);
  w.string(s.displayName);
  w.string(s.bio);
  w.string(s.avatarHash ?? '');
  w.string(s.owner);
  w.u64(BigInt(Math.trunc(s.createdAt)));
  w.u32(s.followers);
  w.u32(s.following);
  w.u32(s.postCount);
  w.u32(s.monthlyViews);
  w.u128(s.earnings);
  w.string(s.tier);
  w.boolean(s.businessPage);
  w.boolean(s.monetisationEnabled);
}

function encodePost(w: Writer, p: PostRecord): void {
  w.string(p.postId);
  w.string(p.authorAccountId);
  w.string(p.authorAddress);
  w.string(p.content);
  w.string(p.parentPostId ?? '');
  w.u64(BigInt(Math.trunc(p.createdAt)));
  w.u32(p.createdAtHeight);
  w.boolean(p.deleted);
  w.u32(p.likes);
}

function encodeOracle(w: Writer, o: OracleState): void {
  w.u64(o.medianPriceUsdMicro);
  w.u64(BigInt(Math.trunc(o.medianUpdatedAt)));
  w.u32(o.sourceCount);
  w.boolean(o.stale);
  const sources = Object.keys(o.observations).sort();
  w.u32(sources.length);
  for (const source of sources) {
    const obs = o.observations[source];
    w.string(source);
    w.u64(obs.priceUsdMicro);
    w.u64(BigInt(Math.trunc(obs.observedAt)));
    w.string(obs.submitter);
    w.u32(obs.height);
  }
}

function encodePool(w: Writer, p: MiningPoolState): void {
  w.u128(p.balance);
  w.u128(p.lifetimeInflow);
  w.u128(p.lifetimeDistributed);
  w.i128(BigInt(p.lastSettlementHeight));
  w.u32(p.settledClaims);
  w.u32(p.recentDistributions.length);
  for (const claim of p.recentDistributions) {
    w.string(claim.address);
    w.u32(claim.claimHeight);
    w.u64(BigInt(Math.trunc(claim.claimTime)));
    w.u128(claim.amount);
    w.u128(claim.paid);
    w.string(claim.claimId);
  }
}

function encodeMetrics(w: Writer, m: Metrics): void {
  w.u32(m.activeMiners);
  w.u32(m.totalAccounts);
  w.u32(m.totalTransactions);
  w.u32(m.totalMiningClaims);
  w.u128(m.minedSupply);
  w.u128(m.issuedGenesis);
  w.u128(m.totalSupply);
  w.u128(m.totalGasBurnedToPool);
  w.u128(m.totalFeesToPool);
  w.u128(m.totalTreasuryRevenue);
  w.u128(m.totalPlatformRevenue);
  w.u128(m.totalNodeRewardRevenue);
  w.u128(m.totalTreasuryFromSplit);
  w.u128(m.totalNodeRewardsPaid);
  w.u32(m.registeredNodes);
  w.u128(m.totalCreatorEarnings);
  w.u128(m.totalTips);
  w.u32(m.totalCapsulesCreated);
  w.u32(m.totalParcelsIssued);
  w.u32(m.totalNamesRegistered);
}

function encodeNode(w: Writer, n: NodeRecord): void {
  w.string(n.nodeId);
  w.string(n.rewardWallet);
  w.string(n.nodePublicKey);
  w.string(n.endpoint);
  w.u32(n.registeredAtHeight);
  w.u64(BigInt(Math.trunc(n.registeredAt)));
  w.u128(n.bond);
  w.u32(n.deregisteredAtHeight ?? 0);
  w.string(n.pendingWallet ?? '');
  w.i128(BigInt(n.pendingWalletEffectivePeriod ?? -1));
  w.u32(n.pendingWalletRequestedAtHeight ?? 0);
  w.u128(n.lifetimeReward);
  w.u32(n.settledPeriods.length);
  for (const period of [...n.settledPeriods].sort((a, b) => a - b)) w.i128(BigInt(period));
}

function encodeNodeEvidence(w: Writer, e: NodeEvidenceRecord): void {
  w.string(e.nodeId);
  w.i128(BigInt(e.period));
  w.u32(e.heartbeats);
  w.u32(e.attesters.length);
  for (const attester of [...e.attesters].sort()) w.string(attester);
  w.u32(e.blocksProduced);
  w.u32(e.attested.length);
  for (const subject of [...e.attested].sort()) w.string(subject);
  w.u32(e.faults);
  w.u32(e.faultReporters.length);
  for (const reporter of [...e.faultReporters].sort()) w.string(reporter);
  w.u32(e.staleHeartbeats);
  w.u32(e.invalidAttestations);
  w.u32(e.lastReportedHeight);
}

function encodeNodeRewards(w: Writer, p: NodeRewardPoolState): void {
  w.u128(p.balance);
  w.u128(p.bondedSeals);
  w.u128(p.lifetimeInflow);
  w.u128(p.lifetimeDistributed);
  w.i128(BigInt(p.lastSettledPeriod));
  w.i128(BigInt(p.blockCountPeriod));
  w.u32(p.blockCount);
  w.u128(p.unclaimedRevenue);
  const sources = [...p.revenueBySource].sort((a, b) => (a.source < b.source ? -1 : 1));
  w.u32(sources.length);
  for (const entry of sources) {
    w.string(entry.source);
    w.u128(entry.total);
  }
  w.u32(p.recentSettlements.length);
  for (const settlement of p.recentSettlements) {
    w.i128(BigInt(settlement.period));
    w.u128(settlement.poolSeals);
    w.u128(settlement.distributedSeals);
    w.u128(settlement.carriedSeals);
    w.u32(settlement.eligibleNodes);
    w.u32(settlement.scoredNodes);
    w.u32(settlement.atHeight);
    w.u32(settlement.payouts.length);
    for (const payout of settlement.payouts) {
      w.string(payout.nodeId);
      w.string(payout.rewardWallet);
      w.u128(payout.amount);
      w.u32(payout.scoreBps);
      w.u32(payout.shareBps);
    }
  }
}

/** Serialize the whole consensus state into canonical bytes. */
export function encodeState(state: MutableState): Uint8Array {
  const w = new Writer();
  w.u32(state.chainId);
  w.string(state.protocolVersion);
  w.u32(state.height);
  w.u64(BigInt(Math.trunc(state.timestamp)));

  encodeGenesis(w, state.genesis);

  const addresses = [...state.accounts.keys()].sort();
  w.u32(addresses.length);
  for (const address of addresses) encodeAccount(w, address, state.accounts.get(address)!);

  const names = [...state.names.keys()].sort();
  w.u32(names.length);
  for (const name of names) encodeName(w, state.names.get(name)!);

  const divisions = [...state.divisions.keys()].sort();
  w.u32(divisions.length);
  for (const id of divisions) encodeDivision(w, state.divisions.get(id)!);

  const parcels = [...state.parcels.keys()].sort();
  w.u32(parcels.length);
  for (const id of parcels) encodeParcel(w, state.parcels.get(id)!);

  const capsules = [...state.capsules.keys()].sort();
  w.u32(capsules.length);
  for (const id of capsules) encodeCapsule(w, state.capsules.get(id)!);

  const social = [...state.social.keys()].sort();
  w.u32(social.length);
  for (const id of social) encodeSocial(w, state.social.get(id)!);

  const posts = [...state.posts.keys()].sort();
  w.u32(posts.length);
  for (const id of posts) encodePost(w, state.posts.get(id)!);

  encodeOracle(w, state.oracle);
  encodePool(w, state.pool);
  encodeMetrics(w, state.metrics);

  const claimIds = [...state.recentClaimIds.keys()].sort();
  w.u32(claimIds.length);
  for (const id of claimIds) w.string(id);

  const validators = [...state.validators].sort();
  w.u32(validators.length);
  for (const address of validators) w.string(address);

  const following = [...state.socialFollowing].sort();
  w.u32(following.length);
  for (const edge of following) w.string(edge);

  const requests = [...state.verificationRequests.keys()].sort();
  w.u32(requests.length);
  for (const accountId of requests) {
    const request = state.verificationRequests.get(accountId)!;
    w.string(accountId);
    w.string(request.tier);
    w.string(request.requestedBy);
    w.u32(request.requestedAtHeight);
    w.string(request.evidenceHash);
  }

  // Node runner registry, evidence and pool: every field can decide a future
  // payout, so all of it is committed. Omitting any of it would let two nodes
  // disagree about money without their state roots disagreeing.
  const nodeIds = [...state.nodes.keys()].sort();
  w.u32(nodeIds.length);
  for (const id of nodeIds) encodeNode(w, state.nodes.get(id)!);

  const evidenceKeys = [...state.nodeEvidence.keys()].sort();
  w.u32(evidenceKeys.length);
  for (const key of evidenceKeys) {
    w.string(key);
    encodeNodeEvidence(w, state.nodeEvidence.get(key)!);
  }

  encodeNodeRewards(w, state.nodeRewards);

  const paramsHash = PARAMS_HASH;
  w.string(paramsHash);

  return w.finish();
}

/** SHA-256 state root, domain-separated from every other digest type. */
export function computeStateRoot(state: MutableState): string {
  const body = encodeState(state);
  const digest = domainHash(DOMAIN.STATE_ROOT, body);
  return `${bytesToHexLower(digest)}`;
}

function bytesToHexLower(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Human-facing short form used by logs and the explorer. */
export function shortHash(hash: string, chars = 12): string {
  if (!hash) return '';
  return `${hash.slice(0, chars)}…${hash.slice(-6)}`;
}

/** Utility for tests and debug: parameter hash as ASCII hex. */
export function paramsHashUtf8(): Uint8Array {
  return utf8(PARAMS_HASH);
}
