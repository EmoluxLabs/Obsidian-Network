/**
 * World state: the mutable protocol state every node derives independently.
 *
 * INVARIANTS ENFORCED HERE (and re-checked after every block):
 *   1. metrics.totalSupply <= 21,000,000 OBS at all times.
 *   2. totalSupply equals the sum of every account balance plus the Mining Pool
 *      balance plus validator and node-runner bonds held by the protocol.
 *   3. Only two issuance sources exist: GENESIS_ALLOCATION and MINING_REWARD.
 *      No other code path may increase totalSupply.
 *   4. genesis.allocationClaimed may transition false -> true exactly once.
 *
 * Application databases, caches and interfaces have no access to this object.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { ErrCode, reject } from '../protocol/errors.js';
import type {
  Account,
  GenesisState,
  Metrics,
  MiningPoolState,
  NodeEvidenceRecord,
  NodeRecord,
  NodeRewardPoolState,
  NodeRewardSettlement,
  MiningState,
  OnsRecord,
  OracleState,
  ProtocolEvent,
  SlashRecord,
  StateSnapshot,
  ValidatorState,
} from '../protocol/types.js';
import { MAX_SUPPLY_SEALS } from '../protocol/amount.js';
import { assertSplitInvariant, splitOnsRevenue, type RevenueSource } from '../economy/accounting.js';
import { treasuryWallet } from '../genesis/rules.js';
import { STATE_SNAPSHOT_VERSION } from '../version.js';

/** The only two authorised issuance sources in the Obsidian protocol. */
export type IssuanceSource = 'GENESIS_ALLOCATION' | 'MINING_REWARD';

const AUTHORISED_ISSUANCE: ReadonlySet<IssuanceSource> = new Set<IssuanceSource>([
  'GENESIS_ALLOCATION',
  'MINING_REWARD',
]);

export const RECENT_CLAIM_ID_WINDOW = 200_000;

export function emptyGenesisState(): GenesisState {
  return {
    allocationClaimed: false,
    recipient: '',
    treasuryWallet: '',
    amount: CONSENSUS_PARAMS.genesisAllocation,
    bootstrapValidatorKeys: [],
  };
}

export function emptyOracleState(): OracleState {
  return {
    observations: {},
    medianPriceUsdMicro: 0n,
    medianUpdatedAt: 0,
    sourceCount: 0,
    stale: true,
  };
}

export function emptyPoolState(): MiningPoolState {
  return {
    balance: 0n,
    lifetimeInflow: 0n,
    lifetimeDistributed: 0n,
    recentDistributions: [],
    lastSettlementHeight: -1,
    settledClaims: 0,
  };
}

export function emptyNodeRewardPool(): NodeRewardPoolState {
  return {
    balance: 0n,
    lifetimeInflow: 0n,
    lifetimeDistributed: 0n,
    lastSettledPeriod: 0,
    blockCountPeriod: -1,
    blockCount: 0,
    recentSettlements: [],
    unclaimedRevenue: 0n,
    revenueBySource: [],
  };
}

export function emptyMetrics(): Metrics {
  return {
    activeMiners: 0,
    totalAccounts: 0,
    totalTransactions: 0,
    totalMiningClaims: 0,
    minedSupply: 0n,
    issuedGenesis: 0n,
    totalSupply: 0n,
    totalGasBurnedToPool: 0n,
    totalFeesToPool: 0n,
    totalTreasuryRevenue: 0n,
    totalOnsRevenue: 0n,
    totalOnsRunnerShare: 0n,
    totalOnsTreasuryShare: 0n,
    totalNodeRewardsPaid: 0n,
    totalSlashedToPool: 0n,
    totalSlashes: 0,
    registeredNodes: 0,
    totalNamesRegistered: 0,
  };
}

export interface MutableState {
  height: number;
  timestamp: number;
  chainId: number;
  protocolVersion: string;
  accounts: Map<string, Account>;
  genesis: GenesisState;
  names: Map<string, OnsRecord>;
  oracle: OracleState;
  pool: MiningPoolState;
  metrics: Metrics;
  recentClaimIds: Map<string, number>;
  validators: Set<string>;
  /**
   * Has this chain ever accepted a valid validator registration?
   *
   * Consensus state, committed in the state root. False only before the first
   * successful VALIDATOR_REGISTER (bootstrap mode, where any node may propose so
   * that a first validator can arrive); true for ever after it, so an empty
   * active set means the chain halts rather than opening production to any key.
   */
  validatorModeEstablished: boolean;
  /** Registered node runners, keyed by nodeId (lexicographic iteration). */
  nodes: Map<string, NodeRecord>;
  /** Per-period evidence, keyed `${period}:${nodeId}`. */
  nodeEvidence: Map<string, NodeEvidenceRecord>;
  /** Reverse index: reward wallet → nodeId. One wallet may back one node only. */
  nodeWallets: Map<string, string>;
  /** Node Runner Reward Pool plus platform-revenue accounting. */
  nodeRewards: NodeRewardPoolState;
  /** Applied slashes, keyed by evidence id. Consensus state, committed in the root. */
  slashes: Map<string, SlashRecord>;
}

export interface ApplyContext {
  height: number;
  timestamp: number;
  txId?: string;
  /** Producer that authored the including block. */
  producer?: string;
}

export interface StateDelta {
  kind: 'CREDIT' | 'DEBIT' | 'SET' | 'DELETE' | 'ISSUE' | 'BURN' | 'EVENT';
  path: string;
  value?: string | number | boolean | null;
  reason: string;
}

/**
 * Protocol time at which a validator's jail ends, or null when it is not jailed.
 *
 * A JAILED record with no term returns null and is treated as jailed for ever:
 * the term is what makes a jail end, and guessing a default would let a
 * malformed record free a validator that the chain had removed.
 */
export function jailEndsAt(validator: { status: string; jailedUntilTime?: number }): number | null {
  if (validator.status !== 'JAILED') return null;
  const until = validator.jailedUntilTime;
  if (typeof until !== 'number' || !Number.isFinite(until)) return null;
  return until;
}

/**
 * Whether a jail has lapsed at `atTimestamp`.
 *
 * Deliberately a pure function of committed state and a protocol timestamp: the
 * same question asked about the same block gets the same answer on every node,
 * and it keeps working on a chain that has stopped producing blocks — which is
 * exactly the chain a jail can cause once it empties the active set.
 */
export function jailIsOver(validator: { status: string; jailedUntilTime?: number }, atTimestamp: number): boolean {
  const until = jailEndsAt(validator);
  return until !== null && atTimestamp >= until;
}

export class WorldState {
  readonly s: MutableState;
  /** Audit trail of every mutation in the current application run. */
  readonly deltas: StateDelta[] = [];

  constructor(state?: MutableState) {
    this.s = state ?? WorldState.freshState(0, 0, 7777, CONSENSUS_PARAMS.protocolVersion);
  }

  static freshState(
    height: number,
    timestamp: number,
    chainId: number,
    protocolVersion: string,
  ): MutableState {
    return {
      height,
      timestamp,
      chainId,
      protocolVersion,
      accounts: new Map(),
      genesis: emptyGenesisState(),
      names: new Map(),
      oracle: emptyOracleState(),
      pool: emptyPoolState(),
      metrics: emptyMetrics(),
      recentClaimIds: new Map(),
      validators: new Set(),
      validatorModeEstablished: false,
      nodes: new Map(),
      nodeEvidence: new Map(),
      nodeWallets: new Map(),
      nodeRewards: emptyNodeRewardPool(),
      slashes: new Map(),
    };
  }

  // ── Construction / snapshots ──────────────────────────────────────────────

  toSnapshot(
    blockHash: string,
    identity: { networkId?: string; genesisId?: string; paramsHash?: string; stateRoot?: string } = {},
  ): StateSnapshot {
    return {
      snapshotVersion: STATE_SNAPSHOT_VERSION,
      ...identity,
      height: this.s.height,
      blockHash,
      chainId: this.s.chainId,
      protocolVersion: this.s.protocolVersion,
      timestamp: this.s.timestamp,
      accounts: Object.fromEntries([...this.s.accounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      genesis: { ...this.s.genesis, bootstrapValidatorKeys: [...this.s.genesis.bootstrapValidatorKeys] },
      names: Object.fromEntries([...this.s.names.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      oracle: { ...this.s.oracle, observations: { ...this.s.oracle.observations } },
      pool: { ...this.s.pool, recentDistributions: this.s.pool.recentDistributions.map((c) => ({ ...c })) },
      metrics: { ...this.s.metrics },
      recentClaimIds: { ...Object.fromEntries(this.s.recentClaimIds) },
      validators: [...this.s.validators].sort(),
      validatorModeEstablished: this.s.validatorModeEstablished,
      nodes: Object.fromEntries([...this.s.nodes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      nodeEvidence: Object.fromEntries([...this.s.nodeEvidence.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      nodeRewards: {
        ...this.s.nodeRewards,
        recentSettlements: this.s.nodeRewards.recentSettlements.map((settlement: NodeRewardSettlement) => ({
          ...settlement,
          payouts: settlement.payouts.map((payout: NodeRewardSettlement['payouts'][number]) => ({ ...payout })),
        })),
        revenueBySource: this.s.nodeRewards.revenueBySource.map((entry: { source: string; total: bigint }) => ({ ...entry })),
      },
      slashes: Object.fromEntries([...this.s.slashes.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, record]) => [id, { ...record }])),
    };
  }

  static fromSnapshot(snapshot: StateSnapshot): WorldState {
    const s = WorldState.freshState(
      snapshot.height,
      snapshot.timestamp,
      snapshot.chainId,
      snapshot.protocolVersion,
    );
    for (const [k, v] of Object.entries(snapshot.accounts)) s.accounts.set(k, cloneAccount(v));
    s.genesis = { ...snapshot.genesis, bootstrapValidatorKeys: [...(snapshot.genesis.bootstrapValidatorKeys ?? [])] };
    for (const [k, v] of Object.entries(snapshot.names)) s.names.set(k, { ...v });
    s.oracle = { ...snapshot.oracle, observations: { ...snapshot.oracle.observations } };
    s.pool = { ...snapshot.pool, recentDistributions: snapshot.pool.recentDistributions.map((c) => ({ ...c })) };
    s.metrics = { ...snapshot.metrics };
    s.recentClaimIds = new Map(Object.entries(snapshot.recentClaimIds));
    s.validators = new Set(snapshot.validators);
    // Fail closed. A snapshot that does not say which mode the chain is in is
    // from a build that predates the indicator, and reading it as "bootstrap"
    // would hand an established chain back to permissionless production. The
    // snapshot version check in storage already refuses it; this makes the
    // state itself refuse it too, so no code path can bypass that check.
    if (typeof snapshot.validatorModeEstablished !== 'boolean') {
      throw new Error(
        `state snapshot is missing validatorModeEstablished (format ${snapshot.snapshotVersion ?? 'unknown'}); ` +
          `this build requires snapshot format ${STATE_SNAPSHOT_VERSION}`,
      );
    }
    s.validatorModeEstablished = snapshot.validatorModeEstablished;
    for (const [k, v] of Object.entries(snapshot.nodes ?? {})) {
      s.nodes.set(k, { ...v, lifetimeReward: BigInt(v.lifetimeReward), settledPeriods: [...(v.settledPeriods ?? [])] });
      s.nodeWallets.set(v.rewardWallet, k);
      if (v.pendingWallet) s.nodeWallets.set(v.pendingWallet, k);
    }
    for (const [k, v] of Object.entries(snapshot.nodeEvidence ?? {})) {
      s.nodeEvidence.set(k, {
        ...v,
        attesters: [...v.attesters],
        attested: [...v.attested],
        faultReporters: [...(v.faultReporters ?? [])],
      });
    }
    if (snapshot.nodeRewards) {
      s.nodeRewards = {
        ...snapshot.nodeRewards,
        unclaimedRevenue: BigInt(snapshot.nodeRewards.unclaimedRevenue),
        balance: BigInt(snapshot.nodeRewards.balance),
        lifetimeInflow: BigInt(snapshot.nodeRewards.lifetimeInflow),
        lifetimeDistributed: BigInt(snapshot.nodeRewards.lifetimeDistributed),
        recentSettlements: (snapshot.nodeRewards.recentSettlements ?? []).map((settlement: NodeRewardSettlement) => ({
          ...settlement,
          payouts: settlement.payouts.map((payout: NodeRewardSettlement['payouts'][number]) => ({ ...payout, amount: BigInt(payout.amount) })),
        })),
        revenueBySource: (snapshot.nodeRewards.revenueBySource ?? []).map((entry: { source: string; total: bigint }) => ({
          ...entry,
          total: BigInt(entry.total),
        })),
      };
    }
    for (const [id, record] of Object.entries(snapshot.slashes ?? {})) {
      s.slashes.set(id, {
        ...record,
        amount: BigInt(record.amount),
        bondBefore: BigInt(record.bondBefore),
        bondAfter: BigInt(record.bondAfter),
      });
    }
    return new WorldState(s);
  }

  clone(): WorldState {
    return WorldState.fromSnapshot(this.toSnapshot(''));
  }

  /** Apply every pending height/timestamp update from a new block. */
  advanceBlock(height: number, timestamp: number): void {
    this.s.height = height;
    this.s.timestamp = timestamp;
  }

  // ── Accounts ──────────────────────────────────────────────────────────────

  getAccount(address: string): Account | undefined {
    return this.s.accounts.get(address);
  }

  /**
   * Fetch or create an account record. Creating an account never creates value:
   * the balance starts at exactly zero and only a valid credit can change it.
   */
  touchAccount(address: string, ctx: ApplyContext): Account {
    let account = this.s.accounts.get(address);
    if (!account) {
      account = {
        address,
        balance: 0n,
        nonce: 0,
        totalReceived: 0n,
        totalSent: 0n,
        txCount: 0,
        createdAtHeight: ctx.height,
        createdAt: ctx.timestamp,
      };
      this.s.accounts.set(address, account);
      this.s.metrics.totalAccounts = this.s.accounts.size;
      this.delta('SET', `accounts.${address}`, address, 'account created with zero balance');
    }
    return account;
  }

  credit(address: string, amount: bigint, ctx: ApplyContext, reason: string): void {
    if (amount < 0n) reject(ErrCode.AMOUNT_NEGATIVE, 'credit amount must not be negative');
    if (amount === 0n) return;
    const account = this.touchAccount(address, ctx);
    account.balance += amount;
    account.totalReceived += amount;
    this.delta('CREDIT', `accounts.${address}.balance`, amount.toString(), reason);
  }

  /**
   * Debit without touching the nonce. Throws on insufficient funds: the state
   * machine never allows a negative balance, which is what makes OBS
   * double-spend-free at the account level.
   */
  debit(address: string, amount: bigint, _ctx: ApplyContext, reason: string): void {
    if (amount < 0n) reject(ErrCode.AMOUNT_NEGATIVE, 'debit amount must not be negative');
    if (amount === 0n) return;
    const account = this.s.accounts.get(address);
    if (!account || account.balance < amount) {
      reject(ErrCode.INSUFFICIENT_FUNDS, `insufficient balance: ${reason}`, {
        address,
        required: amount.toString(),
        available: (account?.balance ?? 0n).toString(),
      });
    }
    account.balance -= amount;
    account.totalSent += amount;
    this.delta('DEBIT', `accounts.${address}.balance`, amount.toString(), reason);
  }

  setNonce(address: string, nonce: number, ctx: ApplyContext): void {
    const account = this.touchAccount(address, ctx);
    account.nonce = nonce;
    account.txCount += 1;
  }

  // ── Issuance ──────────────────────────────────────────────────────────────

  /**
   * The single authorisation gate for creating new OBS.
   * Every issuance path must come through here; there is no other way to
   * increase totalSupply anywhere in the codebase.
   */
  issue(
    source: IssuanceSource,
    amount: bigint,
    _ctx: ApplyContext,
    reason: string,
  ): void {
    if (!AUTHORISED_ISSUANCE.has(source)) {
      reject(ErrCode.UNAUTHORIZED, `issuance source "${source}" is not authorised by consensus`);
    }
    if (amount <= 0n) reject(ErrCode.AMOUNT_ZERO, 'issuance amount must be positive');
    const projected = this.s.metrics.totalSupply + amount;
    if (projected > MAX_SUPPLY_SEALS) {
      reject(ErrCode.SUPPLY_EXCEEDED, 'issuance would exceed the 21,000,000 OBS maximum supply', {
        current: this.s.metrics.totalSupply.toString(),
        requested: amount.toString(),
        projected: projected.toString(),
        max: MAX_SUPPLY_SEALS.toString(),
      });
    }
    this.s.metrics.totalSupply = projected;
    if (source === 'GENESIS_ALLOCATION') this.s.metrics.issuedGenesis += amount;
    if (source === 'MINING_REWARD') this.s.metrics.minedSupply += amount;
    this.delta('ISSUE', `supply.${source}`, amount.toString(), reason);
  }

  /** Move an explicitly classified protocol inflow into the Mining Pool. */
  poolInflow(amount: bigint, reason: string): void {
    if (amount <= 0n) return;
    this.s.pool.balance += amount;
    this.s.pool.lifetimeInflow += amount;
    this.delta('CREDIT', 'pool.balance', amount.toString(), reason);
  }

  poolOutflow(amount: bigint, reason: string): void {
    if (amount <= 0n) return;
    if (this.s.pool.balance < amount) {
      reject(ErrCode.INSUFFICIENT_FUNDS, 'mining pool cannot cover this outflow', {
        requested: amount.toString(),
        available: this.s.pool.balance.toString(),
      });
    }
    this.s.pool.balance -= amount;
    this.s.pool.lifetimeDistributed += amount;
    this.delta('DEBIT', 'pool.balance', amount.toString(), reason);
  }

  // ── Replay guards ─────────────────────────────────────────────────────────

  // There is no transaction-id replay window. Strict nonce equality
  // (`tx.nonce === account.nonce`, enforced in state-machine.ts) already makes
  // an exact replay impossible, and a tx-id set would be *wrong* across a
  // reorg: when a rollback frees a nonce again, re-including the very same
  // signed transaction is the correct outcome, not a replay. The set was also
  // the only consensus-relevant field `encodeState` never hashed, so two nodes
  // could disagree about what to accept while publishing identical state roots.

  rememberClaimId(claimId: string, height: number): void {
    this.s.recentClaimIds.set(claimId, height);
    if (this.s.recentClaimIds.size > RECENT_CLAIM_ID_WINDOW) {
      const sorted = [...this.s.recentClaimIds.entries()].sort((a, b) => a[1] - b[1]);
      const excess = sorted.length - RECENT_CLAIM_ID_WINDOW;
      for (let i = 0; i < excess; i += 1) this.s.recentClaimIds.delete(sorted[i][0]);
    }
  }

  // ── Mining state helpers ───────────────────────────────────────────────────

  ensureMiningState(address: string, ctx: ApplyContext): MiningState {
    const account = this.touchAccount(address, ctx);
    if (!account.mining) {
      account.mining = {
        claimSequence: 1,
        lastClaimAt: 0,
        lastClaimHeight: 0,
        cycleStartAt: 0,
        claimsThisCycle: 0,
        totalClaims: 0,
        totalReward: 0n,
        eligible: false,
      };
    }
    return account.mining;
  }

  setValidator(address: string, validator: ValidatorState, ctx: ApplyContext): void {
    const account = this.touchAccount(address, ctx);
    account.validator = validator;
    this.s.validators.add(address);
  }

  /**
   * Close validator-open block production for ever.
   *
   * Called by the state transition of the FIRST successful validator
   * registration, so the change is part of the block that caused it: it is
   * committed in that block's state root, it is restored by a snapshot, and
   * every node that applies the block reaches it. Idempotent by construction —
   * a later registration does not touch it, and nothing clears it.
   */
  establishValidatorMode(): void {
    this.s.validatorModeEstablished = true;
  }

  removeValidator(address: string): void {
    const account = this.s.accounts.get(address);
    if (account) delete account.validator;
    this.s.validators.delete(address);
  }

  /**
   * Validators that may propose, in deterministic address order.
   *
   * `atTimestamp` is the protocol time the question is being asked about — the
   * candidate block's timestamp when the schedule for that block is derived,
   * which is what every validating node uses. Defaulting to this state's own
   * timestamp keeps the old call sites correct. A jail is a duration of protocol
   * time, so the answer for one instant can differ from the answer for another;
   * both are derived from committed state and neither consults a clock that
   * another node cannot see.
   */
  activeValidators(atTimestamp: number = this.s.timestamp): string[] {
    const out: string[] = [];
    for (const address of [...this.s.validators].sort()) {
      const v = this.s.accounts.get(address)?.validator;
      if (!v) continue;
      if (v.status === 'JAILED' && !jailIsOver(v, atTimestamp)) continue;
      if (v.status === 'UNBONDING') continue;
      // A slashed registration leaves the rotation the moment the block that
      // carried the evidence is applied — not when the node restarts.
      if (v.status === 'SLASHED') continue;
      out.push(address);
    }
    return out;
  }

  // ── Invariant checks ──────────────────────────────────────────────────────

  /**
   * Recompute the supply from first principles and compare with the tracked
   * total. Any mismatch means a state-transition bug or a malicious node, and
   * the block that produced it is rejected.
   */
  verifySupplyInvariant(): { ok: true; totalSupply: bigint } | { ok: false; reason: string } {
    let sum = 0n;
    for (const account of this.s.accounts.values()) sum += account.balance;
    sum += this.s.pool.balance;
    // Validator bonds are locked value: they are excluded from the liquid
    // balance but still exist and must be counted by the supply invariant.
    for (const account of this.s.accounts.values()) {
      if (account.validator) sum += account.validator.bond;
    }
    // The Node Runner Reward Pool is protocol-held value: not in anyone's liquid
    // balance, so the invariant counts it explicitly or every node payout would
    // look like a supply mismatch. Slashed value never appears as a new term —
    // it moves from a validator's bond (counted above) into the Mining Pool
    // (counted above), so a slash can neither create nor destroy a seal.
    sum += this.s.nodeRewards.balance;
    if (sum !== this.s.metrics.totalSupply) {
      return {
        ok: false,
        reason: `supply mismatch: tracked=${this.s.metrics.totalSupply} recomputed=${sum}`,
      };
    }
    if (sum > MAX_SUPPLY_SEALS) {
      return { ok: false, reason: `supply ${sum} exceeds maximum ${MAX_SUPPLY_SEALS}` };
    }
    const issued = this.s.metrics.issuedGenesis + this.s.metrics.minedSupply;
    if (issued > sum) {
      return { ok: false, reason: `issued ${issued} exceeds existing supply ${sum}` };
    }
    return { ok: true, totalSupply: sum };
  }

  // ── Events ────────────────────────────────────────────────────────────────

  /** Per-block event buffer; the caller flushes it into the block's eventsRoot. */
  private eventBuffer: ProtocolEvent[] = [];

  emit(type: string, data: ProtocolEvent['data'], ctx: ApplyContext): void {
    this.eventBuffer.push({ type, height: ctx.height, txId: ctx.txId, data });
  }

  takeEvents(): ProtocolEvent[] {
    const events = this.eventBuffer;
    this.eventBuffer = [];
    return events;
  }

  private delta(kind: StateDelta['kind'], path: string, value: string | number | boolean | null, reason: string): void {
    this.deltas.push({ kind, path, value, reason });
  }

  clearDeltas(): void {
    this.deltas.length = 0;
  }

  /** Snapshot counts used by metrics derived at each block. */
  // ── Node runner registry ──────────────────────────────────────────────────
  //
  // These accessors are the ONLY way consensus code touches node records, so the
  // invariants they enforce (one reward wallet per node, one node per wallet,
  // evidence always keyed by period) hold everywhere by construction.

  node(nodeId: string): NodeRecord | undefined {
    return this.s.nodes.get(nodeId);
  }

  /** Reverse lookup: which node, if any, has claimed this reward wallet. */
  nodeByRewardWallet(wallet: string): string | undefined {
    return this.s.nodeWallets.get(wallet);
  }

  registeredNodes(): NodeRecord[] {
    return [...this.s.nodes.values()]
      .filter((node) => node.deregisteredAtHeight === undefined)
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : 1));
  }

  putNode(node: NodeRecord): void {
    this.s.nodeWallets.set(node.rewardWallet, node.nodeId);
    if (node.pendingWallet) this.s.nodeWallets.set(node.pendingWallet, node.nodeId);
    this.s.nodes.set(node.nodeId, node);
    this.s.metrics.registeredNodes = this.registeredNodes().length;
  }

  removeNodeWallet(wallet: string, nodeId: string): void {
    if (this.s.nodeWallets.get(wallet) === nodeId) this.s.nodeWallets.delete(wallet);
  }

  /** Evidence bucket for one (period, node). Created empty on first write. */
  nodeEvidenceFor(period: number, nodeId: string): NodeEvidenceRecord {
    const key = `${period}:${nodeId}`;
    let record = this.s.nodeEvidence.get(key);
    if (!record) {
      record = {
        nodeId,
        period,
        heartbeats: 0,
        attesters: [],
        blocksProduced: 0,
        attested: [],
        faults: 0,
        faultReporters: [],
        staleHeartbeats: 0,
        invalidAttestations: 0,
        lastReportedHeight: 0,
      };
      this.s.nodeEvidence.set(key, record);
    }
    return record;
  }

  /** Drop evidence for periods older than the retention window (bounded state). */
  pruneNodeEvidence(currentPeriod: number): void {
    const oldest = currentPeriod - CONSENSUS_PARAMS.nodeRewards.evidenceWindowPeriods;
    for (const [key, record] of this.s.nodeEvidence) {
      if (record.period < oldest) this.s.nodeEvidence.delete(key);
    }
  }

  // ── ONS revenue accounting ────────────────────────────────────────────────
  //
  // Every ONS revenue flow goes through this closed-source accounting path. It
  // performs the 90/10 split, credits each side, records the source, and keeps the accounting
  // identities that tests assert:
  //
  //   totalOnsRevenue = totalOnsRunnerShare + totalOnsTreasuryShare
  //   totalOnsRevenue includes ONS registration and renewal fees only
  //   nodeRewards.balance  = Σ inflows − Σ node payouts
  //
  // When no treasury wallet exists yet (nobody mined the genesis allocation),
  // the treasury share is not silently abandoned: it is credited to the Mining
  // Pool so the value stays protocol-owned and visible, and the amount owed to
  // the future treasury is recorded in `unclaimedRevenue`.

  creditOnsRevenue(
    source: RevenueSource,
    amount: bigint,
    ctx: ApplyContext,
    reason: string,
  ): { nodePool: bigint; treasury: bigint; unclaimed: bigint } {
    if (amount <= 0n) reject(ErrCode.AMOUNT_NEGATIVE, 'ONS revenue must be positive');
    const split = splitOnsRevenue(amount, source);
    assertSplitInvariant(split);

    this.s.nodeRewards.balance += split.nodeRunnerPool;
    this.s.nodeRewards.lifetimeInflow += split.nodeRunnerPool;
    this.delta('CREDIT', 'nodeRewards.balance', split.nodeRunnerPool.toString(), `${reason} (node runner pool)`);

    const existing = this.s.nodeRewards.revenueBySource.find((entry) => entry.source === source);
    if (existing) existing.total += amount;
    else this.s.nodeRewards.revenueBySource.push({ source, total: amount });

    this.s.metrics.totalOnsRevenue += amount;
    this.s.metrics.totalOnsRunnerShare += split.nodeRunnerPool;

    const treasury = treasuryWallet(this);
    let unclaimed = 0n;
    if (treasury) {
      this.credit(treasury, split.treasury, ctx, `${reason} (treasury share)`);
      this.s.metrics.totalOnsTreasuryShare += split.treasury;
      this.s.metrics.totalTreasuryRevenue += split.treasury;
    } else {
      // Protocol-owned, not income: tracked, spendable only through the pool,
      // and recorded as owed so the future treasury can claim its share.
      this.s.nodeRewards.unclaimedRevenue += split.treasury;
      this.poolInflow(split.treasury, `${reason} (treasury share pending a designated treasury wallet)`);
      unclaimed = split.treasury;
    }

    this.emit('ONS_REVENUE', {
      source,
      amount: amount.toString(),
      nodePoolBps: split.nodePoolBps,
      treasuryBps: split.treasuryBps,
      nodeRunnerPool: split.nodeRunnerPool.toString(),
      treasuryShare: split.treasury.toString(),
      treasuryDesignated: Boolean(treasury),
      unclaimed: unclaimed.toString(),
    }, ctx);

    return { nodePool: split.nodeRunnerPool, treasury: split.treasury, unclaimed };
  }

  /** Pay node runner rewards out of the pool. Only the settlement routine calls this. */
  nodeRewardOutflow(amount: bigint, _ctx: ApplyContext, reason: string): void {
    if (amount <= 0n) return;
    if (this.s.nodeRewards.balance < amount) {
      reject(ErrCode.INSUFFICIENT_FUNDS, 'node runner pool cannot cover this payout', {
        requested: amount.toString(),
        available: this.s.nodeRewards.balance.toString(),
      });
    }
    this.s.nodeRewards.balance -= amount;
    this.s.nodeRewards.lifetimeDistributed += amount;
    this.s.metrics.totalNodeRewardsPaid += amount;
    this.delta('DEBIT', 'nodeRewards.balance', amount.toString(), reason);
  }

  /**
   * Apply a verified, canonical equivocation slash.
   *
   * The value moves from the validator's bond into the Mining Pool in one
   * integer step: `bond -= amount` and `poolInflow(amount)`. Both sides are
   * counted by the supply invariant, so the total supply is unchanged by
   * construction — no issuance, no burn, nothing routed through ONS revenue and
   * nothing credited to the treasury.
   *
   * The validator's registration becomes SLASHED: it leaves the proposer
   * rotation and the finality committee immediately, and whatever is left of
   * the bond is claimable after the ordinary unbonding delay. Re-registering
   * means a fresh registration and a full bond; the remainder is never a
   * discounted seat.
   */
  /**
   * The window of heights an offence can be charged to the bond that is held
   * right now, for one validator.
   *
   * `null` means the current registration is not liable for anything: there is
   * no validator record, or the record has already been slashed (one
   * registration is slashed once).
   *
   * Otherwise the window is `[registeredAtHeight, unbondingStartHeight]`:
   *
   *   - an offence cannot predate the registration that committed it.
   *     Re-registering is a new bond, a new key binding and a new liability, so
   *     evidence about an earlier tenure can never charge the new one — which is
   *     also what makes a claim-and-re-register cycle safe for everyone else;
   *   - an offence cannot postdate the moment the registration left the active
   *     set to unbond. While the bond is still escrowed (ACTIVE, JAILED, or
   *     UNBONDING) it stays liable for what it did in that window, so
   *     unregistering is not an exit from a penalty — it only starts the clock
   *     on how long the evidence has to arrive.
   *
   * The window is read from consensus state only: no history, no block lookup,
   * no local observation. A node replaying the chain from genesis derives the
   * same window as the node that watched the offence happen.
   */
  slashTenure(address: string): { from: number; to?: number } | null {
    const validator = this.s.accounts.get(address)?.validator;
    if (!validator) return null;
    if (validator.status === 'SLASHED') return null;
    return { from: validator.registeredAtHeight, to: validator.unbondingStartHeight };
  }

  /** True when `offenceHeight` falls inside the current registration's tenure. */
  offenceChargesToCurrentRegistration(address: string, offenceHeight: number): boolean {
    const tenure = this.slashTenure(address);
    if (!tenure) return false;
    if (!Number.isSafeInteger(offenceHeight) || offenceHeight < tenure.from) return false;
    if (tenure.to !== undefined && offenceHeight > tenure.to) return false;
    return true;
  }

  applyEquivocationSlash(
    slash: {
      evidenceId: string;
      type: SlashRecord['type'];
      validator: string;
      height: number;
      round: number;
      amount: bigint;
      bondBefore: bigint;
      remaining: bigint;
    },
    ctx: ApplyContext,
  ): SlashRecord {
    const account = this.s.accounts.get(slash.validator);
    const validator = account?.validator;
    if (!validator) reject(ErrCode.NOT_FOUND, 'the slashed validator no longer exists');
    if (this.s.slashes.has(slash.evidenceId)) reject(ErrCode.REPLAY, 'this evidence has already been applied');
    // The verifier has already decided this; the state transition re-derives it
    // from its own record so the ledger can never hold a charge that the current
    // registration is not liable for.
    if (!this.offenceChargesToCurrentRegistration(slash.validator, slash.height)) {
      reject(
        ErrCode.UNAUTHORIZED,
        'the offence falls outside the tenure of the registration that is bonded now',
      );
    }
    if (validator.bond !== slash.bondBefore || slash.amount + slash.remaining !== slash.bondBefore) {
      reject(ErrCode.MALFORMED, 'slash accounting does not add up against the validator bond');
    }

    validator.bond = slash.remaining;
    validator.status = 'SLASHED';
    validator.slashedAtHeight = ctx.height;
    validator.slashEvidenceId = slash.evidenceId;
    // The remainder follows the ordinary unbonding path: claimable after the
    // protocol delay, returned in full, never confiscated.
    validator.unbondingStartHeight = ctx.height;

    this.poolInflow(slash.amount, `equivocation penalty: ${slash.amount} from validator ${slash.validator}`);
    this.s.metrics.totalSlashedToPool += slash.amount;
    this.s.metrics.totalSlashes += 1;

    const record: SlashRecord = {
      evidenceId: slash.evidenceId,
      type: slash.type,
      validator: slash.validator,
      height: slash.height,
      round: slash.round,
      amount: slash.amount,
      bondBefore: slash.bondBefore,
      bondAfter: slash.remaining,
      slashedAtHeight: ctx.height,
    };
    this.s.slashes.set(slash.evidenceId, record);
    this.emit('VALIDATOR_SLASHED', {
      validator: slash.validator,
      evidenceId: slash.evidenceId,
      evidenceType: slash.type,
      equivocationHeight: slash.height,
      round: slash.round,
      bondBefore: slash.bondBefore.toString(),
      slashed: slash.amount.toString(),
      remaining: slash.remaining.toString(),
      destination: 'MINING_POOL',
    }, ctx);
    return record;
  }

  slashRecord(evidenceId: string): SlashRecord | undefined {
    return this.s.slashes.get(evidenceId);
  }

  /** Split revenue before the treasury exists, once a treasury is designated. */
  claimUnclaimedRevenue(ctx: ApplyContext): bigint {
    const owed = this.s.nodeRewards.unclaimedRevenue;
    const treasury = treasuryWallet(this);
    if (owed <= 0n || !treasury) return 0n;
    if (this.s.pool.balance < owed) {
      // Should be impossible: the amount is credited to the pool when recorded.
      reject(ErrCode.INSUFFICIENT_FUNDS, 'unclaimed revenue is not covered by the mining pool');
    }
    this.s.pool.balance -= owed;
    this.s.nodeRewards.unclaimedRevenue = 0n;
    this.credit(treasury, owed, ctx, 'treasury share recorded before the treasury wallet was designated');
    this.s.metrics.totalOnsTreasuryShare += owed;
    this.s.metrics.totalTreasuryRevenue += owed;
    this.emit('UNCLAIMED_REVENUE_SETTLED', { treasury, amount: owed.toString() }, ctx);
    return owed;
  }

  recountActiveMiners(): number {
    const window = CONSENSUS_PARAMS.mining.activeMinerWindowSeconds;
    const cutoff = this.s.timestamp - window;
    let count = 0;
    for (const account of this.s.accounts.values()) {
      const mining = account.mining;
      if (mining && mining.totalClaims > 0 && mining.lastClaimAt > cutoff) count += 1;
    }
    this.s.metrics.activeMiners = count;
    return count;
  }
}

function cloneAccount(account: Account): Account {
  return {
    ...account,
    mining: account.mining ? { ...account.mining } : undefined,
    validator: account.validator ? { ...account.validator } : undefined,
  };
}
