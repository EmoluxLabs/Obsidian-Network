/**
 * World state: the mutable protocol state every node derives independently.
 *
 * INVARIANTS ENFORCED HERE (and re-checked after every block):
 *   1. metrics.totalSupply <= 21,000,000 OBS at all times.
 *   2. totalSupply equals the sum of every account balance plus the Mining Pool
 *      balance plus balances locked in Time Capsules waiting to unlock.
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
  CapsuleRecord,
  DivisionRecord,
  GenesisState,
  Metrics,
  MiningPoolState,
  MiningState,
  OnsRecord,
  OracleState,
  ParcelRecord,
  PostRecord,
  ProtocolEvent,
  SocialRecord,
  StateSnapshot,
  ValidatorState,
} from '../protocol/types.js';
import { MAX_SUPPLY_SEALS } from '../protocol/amount.js';

/** The only two authorised issuance sources in the Obsidian protocol. */
export type IssuanceSource = 'GENESIS_ALLOCATION' | 'MINING_REWARD';

const AUTHORISED_ISSUANCE: ReadonlySet<IssuanceSource> = new Set<IssuanceSource>([
  'GENESIS_ALLOCATION',
  'MINING_REWARD',
]);

/** Retention window for the in-state replay guard. */
export const RECENT_TX_ID_WINDOW = 50_000;
export const RECENT_CLAIM_ID_WINDOW = 200_000;

export function emptyGenesisState(): GenesisState {
  return {
    allocationClaimed: false,
    recipient: '',
    treasuryWallet: '',
    amount: CONSENSUS_PARAMS.genesisAllocation,
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
    totalCreatorEarnings: 0n,
    totalTips: 0n,
    totalCapsulesCreated: 0,
    totalParcelsIssued: 0,
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
  divisions: Map<string, DivisionRecord>;
  parcels: Map<string, ParcelRecord>;
  capsules: Map<string, CapsuleRecord>;
  social: Map<string, SocialRecord>;
  posts: Map<string, PostRecord>;
  oracle: OracleState;
  pool: MiningPoolState;
  metrics: Metrics;
  recentTxIds: string[];
  recentTxIdSet: Set<string>;
  recentClaimIds: Map<string, number>;
  validators: Set<string>;
  socialFollowing: Set<string>;
  verificationRequests: Map<
    string,
    { tier: 'BLUE' | 'GOLD'; requestedBy: string; requestedAtHeight: number; evidenceHash: string }
  >;
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
      divisions: new Map(),
      parcels: new Map(),
      capsules: new Map(),
      social: new Map(),
      posts: new Map(),
      oracle: emptyOracleState(),
      pool: emptyPoolState(),
      metrics: emptyMetrics(),
      recentTxIds: [],
      recentTxIdSet: new Set(),
      recentClaimIds: new Map(),
      validators: new Set(),
      socialFollowing: new Set(),
      verificationRequests: new Map(),
    };
  }

  // ── Construction / snapshots ──────────────────────────────────────────────

  toSnapshot(blockHash: string): StateSnapshot {
    return {
      height: this.s.height,
      blockHash,
      chainId: this.s.chainId,
      protocolVersion: this.s.protocolVersion,
      timestamp: this.s.timestamp,
      accounts: Object.fromEntries([...this.s.accounts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      genesis: { ...this.s.genesis },
      names: Object.fromEntries([...this.s.names.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      divisions: Object.fromEntries([...this.s.divisions.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      parcels: Object.fromEntries([...this.s.parcels.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      capsules: Object.fromEntries([...this.s.capsules.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      social: Object.fromEntries([...this.s.social.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      posts: Object.fromEntries([...this.s.posts.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      oracle: { ...this.s.oracle, observations: { ...this.s.oracle.observations } },
      pool: { ...this.s.pool, recentDistributions: this.s.pool.recentDistributions.map((c) => ({ ...c })) },
      metrics: { ...this.s.metrics },
      recentTxIds: [...this.s.recentTxIds],
      recentClaimIds: { ...Object.fromEntries(this.s.recentClaimIds) },
      validators: [...this.s.validators].sort(),
      socialFollowing: [...this.s.socialFollowing].sort(),
      verificationRequests: Object.fromEntries(
        [...this.s.verificationRequests.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
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
    s.genesis = { ...snapshot.genesis };
    for (const [k, v] of Object.entries(snapshot.names)) s.names.set(k, { ...v });
    for (const [k, v] of Object.entries(snapshot.divisions)) s.divisions.set(k, { ...v });
    for (const [k, v] of Object.entries(snapshot.parcels)) s.parcels.set(k, { ...v });
    for (const [k, v] of Object.entries(snapshot.capsules)) s.capsules.set(k, { ...v });
    for (const [k, v] of Object.entries(snapshot.social)) s.social.set(k, { ...v });
    for (const [k, v] of Object.entries(snapshot.posts)) s.posts.set(k, { ...v });
    s.oracle = { ...snapshot.oracle, observations: { ...snapshot.oracle.observations } };
    s.pool = { ...snapshot.pool, recentDistributions: snapshot.pool.recentDistributions.map((c) => ({ ...c })) };
    s.metrics = { ...snapshot.metrics };
    s.recentTxIds = [...snapshot.recentTxIds];
    s.recentTxIdSet = new Set(s.recentTxIds);
    s.recentClaimIds = new Map(Object.entries(snapshot.recentClaimIds));
    s.validators = new Set(snapshot.validators);
    s.socialFollowing = new Set(snapshot.socialFollowing ?? []);
    s.verificationRequests = new Map(Object.entries(snapshot.verificationRequests ?? {}));
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
        flags: {},
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
  debit(address: string, amount: bigint, ctx: ApplyContext, reason: string): void {
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
    ctx: ApplyContext,
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

  /** Move value into the Mining Pool (gas, capsule commitments, Time Travel). */
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

  hasTxId(txId: string): boolean {
    return this.s.recentTxIdSet.has(txId);
  }

  rememberTxId(txId: string): void {
    if (this.s.recentTxIdSet.has(txId)) return;
    this.s.recentTxIds.push(txId);
    this.s.recentTxIdSet.add(txId);
    if (this.s.recentTxIds.length > RECENT_TX_ID_WINDOW) {
      const removed = this.s.recentTxIds.splice(0, this.s.recentTxIds.length - RECENT_TX_ID_WINDOW);
      for (const id of removed) this.s.recentTxIdSet.delete(id);
    }
  }

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

  removeValidator(address: string): void {
    const account = this.s.accounts.get(address);
    if (account) delete account.validator;
    this.s.validators.delete(address);
  }

  /** Validators that can currently propose, in deterministic address order. */
  activeValidators(): string[] {
    const out: string[] = [];
    for (const address of [...this.s.validators].sort()) {
      const v = this.s.accounts.get(address)?.validator;
      if (!v) continue;
      if (v.status === 'JAILED' && (v.jailedUntilHeight ?? 0) > this.s.height) continue;
      if (v.status === 'UNBONDING') continue;
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
    for (const capsule of this.s.capsules.values()) {
      if (capsule.status === 'LOCKED') sum += capsule.creatorCommitment;
    }
    // Validator bonds are locked value: they are excluded from the liquid
    // balance but still exist and must be counted by the supply invariant.
    for (const account of this.s.accounts.values()) {
      if (account.validator) sum += account.validator.bond;
    }
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
    flags: { ...account.flags },
    mining: account.mining ? { ...account.mining } : undefined,
    validator: account.validator ? { ...account.validator } : undefined,
  };
}
