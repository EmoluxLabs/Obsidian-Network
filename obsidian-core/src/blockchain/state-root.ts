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
  GenesisState,
  Metrics,
  MiningPoolState,
  NodeEvidenceRecord,
  NodeRecord,
  NodeRewardPoolState,
  OnsRecord,
  OracleState,
} from '../protocol/types.js';
import type { MutableState } from './state.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { sha256Hex, utf8 } from '../crypto/hash.js';

/**
 * Canonical, type-tagged serialisation of a consensus parameter tree.
 *
 * Keys are emitted in lexicographic order so the hash does not depend on
 * declaration order, and every scalar carries a type tag so that changing `5`
 * to `"5"`, or `5` to `5n`, changes the bytes. Floating point is rejected
 * outright rather than serialised: a non-integer consensus parameter could
 * round differently on different platforms, and nothing in CONSENSUS_PARAMS is
 * permitted to be one.
 */
function canonicalParams(value: unknown, path = 'CONSENSUS_PARAMS'): string {
  if (typeof value === 'string') return `s:${JSON.stringify(value)}`;
  if (typeof value === 'bigint') return `i:${value.toString()}`;
  if (typeof value === 'boolean') return `b:${value ? 1 : 0}`;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(
        `consensus parameter ${path} is ${value}, which is not an integer; ` +
          'floating point must never reach the params hash',
      );
    }
    return `n:${value.toString()}`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalParams(item, `${path}[${index}]`)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalParams((value as Record<string, unknown>)[key], `${path}.${key}`)}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error(`consensus parameter ${path} has unsupported type ${value === null ? 'null' : typeof value}`);
}

/** Fingerprint of any parameter tree. Exported so tests can prove sensitivity. */
export function computeParamsHash(params: unknown): string {
  return sha256Hex(utf8(canonicalParams(params))).slice(0, 32);
}

/**
 * Deterministic fingerprint of the consensus parameter set. Nodes exchange this
 * in the p2p handshake: a peer with a different hash is on a different protocol
 * and is refused, which surfaces accidental forks immediately.
 *
 * This hashes the WHOLE parameter object. It used to hash a hand-maintained
 * list of fields, which silently omitted `gas.minGas`, `tx.minTransfer`,
 * `tx.maxEventsPerTx`, `consensus.maxReorgDepth`, every nested protocol bound not
 * explicitly listed, and more. A node built with any of those altered passed
 * the handshake and then forked at the first transaction that touched the
 * differing rule — the worst failure mode available, because both sides
 * believed they agreed. Enumerating fields by hand cannot be kept correct as
 * parameters are added; serialising the object can.
 */
export const PARAMS_HASH: string = computeParamsHash(CONSENSUS_PARAMS);

function encodeAccount(w: Writer, address: string, a: Account): void {
  w.string(address);
  w.u128(a.balance);
  w.u32(a.nonce);
  w.u128(a.totalReceived);
  w.u128(a.totalSent);
  w.u32(a.txCount);
  w.u32(a.createdAtHeight);
  w.u64(BigInt(Math.trunc(a.createdAt)));
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
  const bootstrapKeys = [...g.bootstrapValidatorKeys].sort();
  w.u32(bootstrapKeys.length);
  for (const publicKey of bootstrapKeys) w.string(publicKey);
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
  w.u128(m.totalOnsRevenue);
  w.u128(m.totalOnsRunnerShare);
  w.u128(m.totalOnsTreasuryShare);
  w.u128(m.totalNodeRewardsPaid);
  w.u32(m.registeredNodes);
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

  encodeOracle(w, state.oracle);
  encodePool(w, state.pool);
  encodeMetrics(w, state.metrics);

  const claimIds = [...state.recentClaimIds.keys()].sort();
  w.u32(claimIds.length);
  for (const id of claimIds) w.string(id);

  const validators = [...state.validators].sort();
  w.u32(validators.length);
  for (const address of validators) w.string(address);

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
