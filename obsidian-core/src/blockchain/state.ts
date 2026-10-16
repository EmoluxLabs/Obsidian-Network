/**
 * World state: the mutable protocol state every node derives independently.
 *
 * INVARIANTS ENFORCED HERE (and re-checked after every block):
 *   1. metrics.totalSupply <= 21,000,000 OBS at all times.
 *   2. totalSupply equals the sum of every account balance plus the Mining Pool
 *      balance plus the protocol-held pools.
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
  FinalityState,
  Metrics,
  MarketOffer,
  MarketState,
  MiningPoolState,
  NodeEvidenceRecord,
  NodeRecord,
  NodeRewardPoolState,
  NodeRewardSettlement,
  MiningState,
  OnsRecord,
  OracleState,
  ProtocolEvent,
  StateSnapshot,
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
    miningGateKeys: [],
    gateKeysActive: [],
    gateKeysRevoked: [],
    gateEpoch: 0,
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

export function emptyMarketState(): MarketState {
  return { escrowBalance: 0n, listingsCreated: 0, salesCount: 0, salesVolume: 0n, offersMade: 0, offersAccepted: 0 };
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
  /** Registered node runners, keyed by nodeId (lexicographic iteration). */
  nodes: Map<string, NodeRecord>;
  /** Per-period evidence, keyed `${period}:${nodeId}`. */
  nodeEvidence: Map<string, NodeEvidenceRecord>;
  /** Reverse index: reward wallet → nodeId. One wallet may back one node only. */
  nodeWallets: Map<string, string>;
  /** Node Runner Reward Pool plus platform-revenue accounting. */
  nodeRewards: NodeRewardPoolState;
  /** Derived finality (committed in the state root). */
  finality: FinalityState;
  /** Derived index, not committed: producer address → nodeId. */
  nodeProducers: Map<string, string>;
  /** Marketplace offers of every retained status, keyed by offer id (committed in the state root). */
  offers: Map<string, MarketOffer>;
  /** Marketplace accounting, including the escrow balance (committed in the state root). */
  market: MarketState;
  /** Derived indexes, not committed: offer ids by name and by maker. Rebuilt from `offers` on every load. */
  offersByName: Map<string, Set<string>>;
  offersByMaker: Map<string, Set<string>>;
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
      oracle: emptyOracleState(),
      pool: emptyPoolState(),
      metrics: emptyMetrics(),
      recentClaimIds: new Map(),
      nodes: new Map(),
      nodeEvidence: new Map(),
      nodeWallets: new Map(),
      nodeRewards: emptyNodeRewardPool(),
      finality: { finalizedHeight: 0, finalizedHash: '', recent: [] },
      nodeProducers: new Map(),
      offers: new Map(),
      market: emptyMarketState(),
      offersByName: new Map(),
      offersByMaker: new Map(),
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
      genesis: {
        ...this.s.genesis,
        miningGateKeys: [...this.s.genesis.miningGateKeys],
        gateKeysActive: [...this.s.genesis.gateKeysActive],
        gateKeysRevoked: [...this.s.genesis.gateKeysRevoked],
        gateEpoch: this.s.genesis.gateEpoch,
      },
      names: Object.fromEntries([...this.s.names.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      offers: Object.fromEntries([...this.s.offers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      market: { ...this.s.market },
      oracle: { ...this.s.oracle, observations: { ...this.s.oracle.observations } },
      pool: { ...this.s.pool, recentDistributions: this.s.pool.recentDistributions.map((c) => ({ ...c })) },
      metrics: { ...this.s.metrics },
      recentClaimIds: { ...Object.fromEntries(this.s.recentClaimIds) },
      nodes: Object.fromEntries([...this.s.nodes.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      nodeEvidence: Object.fromEntries([...this.s.nodeEvidence.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      finality: {
        finalizedHeight: this.s.finality.finalizedHeight,
        finalizedHash: this.s.finality.finalizedHash,
        recent: this.s.finality.recent.map((entry) => ({ ...entry })),
      },
      nodeRewards: {
        ...this.s.nodeRewards,
        recentSettlements: this.s.nodeRewards.recentSettlements.map((settlement: NodeRewardSettlement) => ({
          ...settlement,
          payouts: settlement.payouts.map((payout: NodeRewardSettlement['payouts'][number]) => ({ ...payout })),
        })),
        revenueBySource: this.s.nodeRewards.revenueBySource.map((entry: { source: string; total: bigint }) => ({ ...entry })),
      },
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
    // Fail closed: a snapshot without the gate keys is from a build
    // that predates the gate, and silently reading it as "no keys" would hide that it is the wrong format.
    if (!Array.isArray(snapshot.genesis.miningGateKeys)) {
      throw new Error(
        `state snapshot is missing miningGateKeys (format ${snapshot.snapshotVersion ?? 'unknown'}); ` +
          `this build requires snapshot format ${STATE_SNAPSHOT_VERSION}`,
      );
    }
    if (
      !Array.isArray(snapshot.genesis.gateKeysActive) ||
      !Array.isArray(snapshot.genesis.gateKeysRevoked) ||
      !Number.isSafeInteger(snapshot.genesis.gateEpoch)
    ) {
      throw new Error(
        `state snapshot is missing the gate authority state (format ${snapshot.snapshotVersion ?? 'unknown'}); ` +
          `this build requires snapshot format ${STATE_SNAPSHOT_VERSION}`,
      );
    }
    s.genesis = {
      ...snapshot.genesis,
      miningGateKeys: [...snapshot.genesis.miningGateKeys],
      gateKeysActive: [...snapshot.genesis.gateKeysActive],
      gateKeysRevoked: [...snapshot.genesis.gateKeysRevoked],
      gateEpoch: snapshot.genesis.gateEpoch,
    };
    for (const [k, v] of Object.entries(snapshot.names)) {
      s.names.set(k, {
        ...v,
        pendingTransfer: v.pendingTransfer ? { ...v.pendingTransfer } : undefined,
        pendingRecovery: v.pendingRecovery ? { ...v.pendingRecovery } : undefined,
        listing: v.listing ? { ...v.listing, price: BigInt(v.listing.price) } : undefined,
      });
    }
    // Fail closed, like the gate and finality state: a snapshot without the marketplace state is from a build that
    // predates it, and reading it as "no offers, no escrow" would invent a state.
    if (!snapshot.market || typeof snapshot.offers !== 'object' || snapshot.offers === null) {
      throw new Error(
        `state snapshot is missing the marketplace state (format ${snapshot.snapshotVersion ?? 'unknown'}); ` +
          `this build requires snapshot format ${STATE_SNAPSHOT_VERSION}`,
      );
    }
    s.market = {
      ...snapshot.market,
      escrowBalance: BigInt(snapshot.market.escrowBalance),
      salesVolume: BigInt(snapshot.market.salesVolume),
    };
    for (const [k, v] of Object.entries(snapshot.offers)) {
      const offer: MarketOffer = { ...v, amount: BigInt(v.amount) };
      s.offers.set(k, offer);
      indexOffer(s, offer);
    }
    s.oracle = { ...snapshot.oracle, observations: { ...snapshot.oracle.observations } };
    s.pool = { ...snapshot.pool, recentDistributions: snapshot.pool.recentDistributions.map((c) => ({ ...c })) };
    s.metrics = { ...snapshot.metrics };
    s.recentClaimIds = new Map(Object.entries(snapshot.recentClaimIds));
    for (const [k, v] of Object.entries(snapshot.nodes ?? {})) {
      s.nodes.set(k, { ...v, lifetimeReward: BigInt(v.lifetimeReward), settledPeriods: [...(v.settledPeriods ?? [])] });
      // Only a live node holds wallets: a deregistered or banned node released them, and a restart must not take
      // them back (the live state and the reloaded state have to agree on who may bind an address).
      if (v.deregisteredAtHeight === undefined && v.bannedAtHeight === undefined) {
        if (v.rewardWallet) s.nodeWallets.set(v.rewardWallet, k);
        if (v.pendingWallet) s.nodeWallets.set(v.pendingWallet, k);
      }
      s.nodeProducers.set(v.producerAddress, k);
    }
    if (!snapshot.finality || !Number.isSafeInteger(snapshot.finality.finalizedHeight) || !Array.isArray(snapshot.finality.recent)) {
      throw new Error(
        `state snapshot is missing the finality state (format ${snapshot.snapshotVersion ?? 'unknown'}); ` +
          `this build requires snapshot format ${STATE_SNAPSHOT_VERSION}`,
      );
    }
    s.finality = {
      finalizedHeight: snapshot.finality.finalizedHeight,
      finalizedHash: snapshot.finality.finalizedHash,
      recent: snapshot.finality.recent.map((entry) => ({ ...entry })),
    };
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
    // The Node Runner Reward Pool is protocol-held value: not in anyone's liquid
    // balance, so the invariant counts it explicitly or every node payout would
    // look like a supply mismatch. There are no bonds in 1.9.0: nothing is ever locked.
    sum += this.s.nodeRewards.balance;
    // Marketplace escrow is protocol-held value too: it left the offer maker's balance when the offer was made and
    // returns to the maker or reaches the seller when the offer settles. It must equal the pending offers exactly.
    sum += this.s.market.escrowBalance;
    let pending = 0n;
    for (const offer of this.s.offers.values()) if (offer.status === 'PENDING') pending += offer.amount;
    if (pending !== this.s.market.escrowBalance) {
      return {
        ok: false,
        reason: `escrow mismatch: held=${this.s.market.escrowBalance} pending offers=${pending}`,
      };
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

  /** Reverse lookup: the node whose identity key hashes to this producer address. */
  nodeByProducer(address: string): NodeRecord | undefined {
    const id = this.s.nodeProducers.get(address);
    return id === undefined ? undefined : this.s.nodes.get(id);
  }

  putNode(node: NodeRecord): void {
    // Only a live node holds wallets; deregistration and a ban release them (see releaseWallets).
    if (node.deregisteredAtHeight === undefined && node.bannedAtHeight === undefined) {
      if (node.rewardWallet) this.s.nodeWallets.set(node.rewardWallet, node.nodeId);
      if (node.pendingWallet) this.s.nodeWallets.set(node.pendingWallet, node.nodeId);
    }
    this.s.nodeProducers.set(node.producerAddress, node.nodeId);
    this.s.nodes.set(node.nodeId, node);
    this.s.metrics.registeredNodes = this.registeredNodes().length;
  }

  removeNodeWallet(wallet: string, nodeId: string): void {
    if (this.s.nodeWallets.get(wallet) === nodeId) this.s.nodeWallets.delete(wallet);
  }

  /** Read-only view of one (period, node) evidence bucket; undefined when nothing was recorded. */
  nodeEvidence(period: number, nodeId: string): NodeEvidenceRecord | undefined {
    return this.s.nodeEvidence.get(`${period}:${nodeId}`);
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
        liveWindows: 0,
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

  // ── ONS Marketplace ───────────────────────────────────────────────────────
  //
  // Escrow is a protocol balance, not an account: funds leave the offer maker's spendable balance when the offer is
  // made, so no transaction can spend them, and they re-enter an account only through `escrowRelease`, which every
  // terminal offer transition calls exactly once (a settled offer is never PENDING again).

  offer(id: string): MarketOffer | undefined {
    return this.s.offers.get(id);
  }

  putOffer(offer: MarketOffer): void {
    this.s.offers.set(offer.id, offer);
    indexOffer(this.s, offer);
  }

  /** Offers of one name in a given status (all statuses when omitted), oldest first by id order of creation. */
  offersForName(name: string, status?: MarketOffer['status']): MarketOffer[] {
    const ids = this.s.offersByName.get(name);
    if (!ids) return [];
    const out: MarketOffer[] = [];
    for (const id of ids) {
      const offer = this.s.offers.get(id);
      if (offer && (!status || offer.status === status)) out.push(offer);
    }
    return out.sort((a, b) => a.createdAtHeight - b.createdAtHeight || (a.id < b.id ? -1 : 1));
  }

  offersByMaker(maker: string, status?: MarketOffer['status']): MarketOffer[] {
    const ids = this.s.offersByMaker.get(maker);
    if (!ids) return [];
    const out: MarketOffer[] = [];
    for (const id of ids) {
      const offer = this.s.offers.get(id);
      if (offer && (!status || offer.status === status)) out.push(offer);
    }
    return out.sort((a, b) => a.createdAtHeight - b.createdAtHeight || (a.id < b.id ? -1 : 1));
  }

  /** Move `amount` from the maker's spendable balance into escrow. Throws on insufficient funds, leaving no trace. */
  escrowLock(maker: string, amount: bigint, ctx: ApplyContext, reason: string): void {
    this.debit(maker, amount, ctx, reason);
    this.s.market.escrowBalance += amount;
    this.delta('CREDIT', 'market.escrowBalance', amount.toString(), reason);
  }

  /** Release `amount` from escrow to `to`. Only the terminal offer transitions call this. */
  escrowRelease(to: string, amount: bigint, ctx: ApplyContext, reason: string): void {
    if (amount <= 0n) reject(ErrCode.AMOUNT_ZERO, 'escrow release must be positive');
    if (this.s.market.escrowBalance < amount) {
      reject(ErrCode.INTERNAL, 'escrow cannot cover this release', {
        held: this.s.market.escrowBalance.toString(),
        requested: amount.toString(),
      });
    }
    this.s.market.escrowBalance -= amount;
    this.delta('DEBIT', 'market.escrowBalance', amount.toString(), reason);
    this.credit(to, amount, ctx, reason);
  }

  /** Total escrowed by one maker across their PENDING offers (their locked balance). */
  escrowLockedBy(maker: string): bigint {
    let total = 0n;
    for (const offer of this.offersByMaker(maker, 'PENDING')) total += offer.amount;
    return total;
  }

  /** Drop settled offers older than the retention window (bounded state; the chain's events keep the history). */
  pruneOffers(now: number): void {
    const cutoff = now - CONSENSUS_PARAMS.ons.market.offerRetentionSeconds;
    for (const [id, offer] of [...this.s.offers]) {
      if (offer.status !== 'PENDING' && (offer.resolvedAt ?? offer.createdAt) < cutoff) {
        this.s.offers.delete(id);
        this.s.offersByName.get(offer.name)?.delete(id);
        this.s.offersByMaker.get(offer.maker)?.delete(id);
      }
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

  /** Install the result of a verified gate authority update. The caller has already checked every rule. */
  applyGateUpdate(next: { active: string[]; revoked: string[]; epoch: number; added: string[]; removed: string[] }): void {
    this.s.genesis.gateKeysActive = [...next.active];
    this.s.genesis.gateKeysRevoked = [...next.revoked];
    this.s.genesis.gateEpoch = next.epoch;
    for (const key of next.removed) this.delta('SET', `genesis.gateKeys.revoked.${key}`, true, 'GATE_AUTHORITY');
    for (const key of next.added) this.delta('SET', `genesis.gateKeys.active.${key}`, true, 'GATE_AUTHORITY');
    this.delta('SET', 'genesis.gateEpoch', next.epoch, 'GATE_AUTHORITY');
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

function indexOffer(s: MutableState, offer: MarketOffer): void {
  let byName = s.offersByName.get(offer.name);
  if (!byName) s.offersByName.set(offer.name, (byName = new Set()));
  byName.add(offer.id);
  let byMaker = s.offersByMaker.get(offer.maker);
  if (!byMaker) s.offersByMaker.set(offer.maker, (byMaker = new Set()));
  byMaker.add(offer.id);
}

function cloneAccount(account: Account): Account {
  return {
    ...account,
    mining: account.mining ? { ...account.mining } : undefined,
  };
}
