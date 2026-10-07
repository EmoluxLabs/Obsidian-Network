/**
 * MINING_CLAIM — the protocol-authoritative mining mechanism (spec §21–§27).
 *
 * Determinism: the reward is derived from (activeMiners at this height,
 * protocol schedule constants) and the eligibility window from the including
 * block's timestamp. Nothing in this executor reads a wall clock, a request
 * header, or any client-provided timestamp.
 *
 * Settlement: a valid claim pays immediately
 *      pool funds first  ->  scheduled issuance for the remainder
 * so the reward schedule is stable while gas recycled into the Mining Pool is
 * spent on real mining rewards before new OBS is ever minted.
 *
 * Genesis: if the allocation is still unclaimed, THIS transaction (in canonical
 * block order) wins it. See genesis/rules.ts for the atomicity argument.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { DOMAIN } from '../../protocol/domains.js';
import { domainHash, fromHex, toHex } from '../../crypto/hash.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import type { MiningClaimBody, TxEnvelope } from '../../protocol/types.js';
import { assertMiningEligibility, alignedCycleStart } from '../../mining/rules.js';
import { claimRewardForActiveMiners } from '../../mining/schedule.js';
import { awardGenesisAllocation } from '../../genesis/rules.js';
import type { ExecutorContext } from '../types.js';
import { minBig } from '../../protocol/amount.js';

/** Cap on the audit history of pool distributions kept inside state. */
export const POOL_DISTRIBUTION_HISTORY = 256;

export function decodeMiningBody(body: Uint8Array): MiningClaimBody {
  const r = new Reader(body);
  const claimId = r.string();
  const claimSequence = r.u32();
  const viaNodeId = r.string();
  r.ensureConsumed();
  return { claimId, claimSequence, viaNodeId: viaNodeId.length ? viaNodeId : undefined };
}

export function encodeMiningBody(body: MiningClaimBody): Uint8Array {
  const w = new Writer();
  w.string(body.claimId);
  w.u32(body.claimSequence);
  w.string(body.viaNodeId ?? '');
  return w.finish();
}

/**
 * Canonical claim id. Binding the id to chain, wallet, sequence and the
 * previous claim height makes every claim unique, unforgeable and impossible to
 * replay — the same computed id can only ever be accepted once.
 */
export function computeClaimId(
  chainId: number,
  address: string,
  claimSequence: number,
  lastClaimHeight: number,
): string {
  return toHex(
    domainHash(
      DOMAIN.TX,
      fromHex('00'),
      new TextEncoder().encode(
        `CLAIM|${chainId}|${address}|${claimSequence}|${lastClaimHeight}|${CONSENSUS_PARAMS.protocolVersion}`,
      ),
    ),
  );
}

export function executeMiningClaim(ctx: ExecutorContext, tx: TxEnvelope): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net, chainId } = ctx;
  if (tx.gas !== 0n) {
    // Mining must remain free: new wallets hold exactly 0 OBS by protocol rule.
    reject(ErrCode.BAD_GAS, 'mining claims do not carry gas');
  }
  const decoded = decodeMiningBody(tx.body);
  const protocolTime = apply.timestamp;

  const account = state.getAccount(tx.sender);
  const eligibility = assertMiningEligibility(
    account,
    protocolTime,
    state.s.metrics.activeMiners,
    state.s.genesis.allocationClaimed,
  );

  const mining = state.ensureMiningState(tx.sender, apply);

  // ── Claim identity, sequence and replay protection ──────────────────────
  if (decoded.claimSequence !== mining.claimSequence) {
    reject(ErrCode.MINING_CLAIM_REPLAY, 'claim sequence does not match protocol state', {
      expected: mining.claimSequence,
      received: decoded.claimSequence,
    });
  }
  const expectedClaimId = computeClaimId(chainId, tx.sender, mining.claimSequence, mining.lastClaimHeight);
  if (decoded.claimId !== expectedClaimId) {
    reject(ErrCode.MINING_BAD_PROOF, 'claim id is not the canonical id for this wallet and sequence');
  }
  if (state.s.recentClaimIds.has(decoded.claimId)) {
    reject(ErrCode.MINING_CLAIM_REPLAY, 'this claim id has already been accepted');
  }

  // ── Reward ───────────────────────────────────────────────────────────────
  const reward = claimRewardForActiveMiners(state.s.metrics.activeMiners);
  if (reward !== eligibility.rewardPerClaim) {
    // The schedule is a pure function; a mismatch means the node is running a
    // different protocol version.
    reject(ErrCode.VERSION_MISMATCH, 'reward schedule disagreement — protocol version mismatch');
  }

  // ── Immediate settlement: pool first, issuance for the remainder ──────────
  // The pool may also hold a treasury share that is parked until a treasury is designated. That
  // share is owed to the treasury, not to miners, so it is not spendable here. (It is zero in every
  // chain that has ever been reachable: nobody can pay in before the first claim designates a
  // treasury. The rule is what keeps the release at designation from ever finding the pool short.)
  const reservedForTreasury = state.s.nodeRewards.unclaimedRevenue;
  const spendable = state.s.pool.balance > reservedForTreasury ? state.s.pool.balance - reservedForTreasury : 0n;
  const fromPool = minBig(spendable, reward);
  let fromIssuance = reward - fromPool;
  if (fromIssuance > 0n) {
    const remainingCapacity = CONSENSUS_PARAMS.maxSupply - state.s.metrics.totalSupply;
    if (fromIssuance > remainingCapacity) {
      // The supply cap is absolute: pay what is left, never exceed the cap.
      fromIssuance = remainingCapacity < 0n ? 0n : remainingCapacity;
    }
    if (fromIssuance > 0n) {
      state.issue('MINING_REWARD', fromIssuance, apply, 'mining claim reward (scheduled issuance)');
    }
  }
  if (fromPool > 0n) {
    state.poolOutflow(fromPool, 'mining claim reward paid from mining pool');
  }
  const paid = fromPool + fromIssuance;
  state.credit(tx.sender, paid, apply, 'mining claim reward');
  mining.totalReward += paid;

  // ── Advance protocol mining state ────────────────────────────────────────
  const cycleStart = alignedCycleStart(protocolTime);
  mining.cycleStartAt = cycleStart;
  mining.claimsThisCycle = eligibility.claimsThisCycle + 1;
  mining.lastClaimAt = protocolTime;
  mining.lastClaimHeight = apply.height;
  mining.claimSequence += 1;
  mining.totalClaims += 1;
  mining.eligible = true;

  state.s.metrics.totalMiningClaims += 1;
  state.rememberClaimId(decoded.claimId, apply.height);
  state.recountActiveMiners();

  // ── Pool distribution audit trail ────────────────────────────────────────
  state.s.pool.recentDistributions.push({
    address: tx.sender,
    claimHeight: apply.height,
    claimTime: protocolTime,
    amount: paid,
    paid,
    claimId: decoded.claimId,
  });
  if (state.s.pool.recentDistributions.length > POOL_DISTRIBUTION_HISTORY) {
    state.s.pool.recentDistributions.splice(
      0,
      state.s.pool.recentDistributions.length - POOL_DISTRIBUTION_HISTORY,
    );
  }
  state.s.pool.settledClaims += 1;
  state.s.pool.lastSettlementHeight = apply.height;

  // ── Genesis Allocation (first valid miner wins, exactly once) ─────────────
  const genesis = awardGenesisAllocation(state, tx.sender, apply);

  state.emit('MINING_CLAIM', {
    miner: tx.sender,
    claimId: decoded.claimId,
    claimSequence: decoded.claimSequence - 1,
    reward: paid.toString(),
    rewardFromPool: fromPool.toString(),
    rewardFromIssuance: fromIssuance.toString(),
    activeMiners: state.s.metrics.activeMiners,
    protocolTime,
    claimsThisCycle: mining.claimsThisCycle,
    genesisAwarded: genesis.awarded,
  }, apply);

  return {
    gasBase: 0n,
    detail: {
      reward: paid.toString(),
      rewardObs: formatSeals(paid),
      fromPool: fromPool.toString(),
      fromIssuance: fromIssuance.toString(),
      claimId: decoded.claimId,
      nextEligibleAt: mining.lastClaimAt + CONSENSUS_PARAMS.mining.claimIntervalSeconds,
      claimsThisCycle: mining.claimsThisCycle,
      genesisAwarded: genesis.awarded,
      genesisRecipient: genesis.awarded ? genesis.recipient : undefined,
      treasuryWallet: state.s.genesis.treasuryWallet || undefined,
      networkId: net.networkId,
    },
  };
}

function formatSeals(seals: bigint): string {
  const whole = seals / 10n ** 18n;
  const frac = (seals % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '');
  return frac.length ? `${whole}.${frac}` : whole.toString();
}
