/**
 * Obsidian protocol object model.
 *
 * These types are the consensus surface. The canonical encoder in
 * encoding.ts serializes them; a field not listed here cannot affect state.
 */

export type Hex = string;

// ─────────────────────────────────────────────────────────────────────────────
// Payments & transactions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Protocol time is measured in integer seconds and is ALWAYS taken from the
 * block timestamp of the block that includes an object — never from a browser,
 * a device, an HTTP request or a wall clock inside a node.
 */
export type ProtocolTimeSeconds = number;

export interface TxSignature {
  /** 33-byte compressed secp256k1 public key (hex). */
  publicKey: Hex;
  /** 64-byte compact ECDSA signature (hex, low-S, RFC 6979). */
  signature: Hex;
}

export interface TxEnvelope {
  /** Protocol version the signer used. Nodes reject unknown versions. */
  protocolVersion: string;
  /** Chain ID — replay protection across networks. */
  chainId: number;
  /** OBS.0001...: canonical transaction id (domain-separated SHA-256). */
  id: Hex;
  /** Signer's obs1... address. Must control `publicKey`. */
  sender: string;
  /** Strictly increasing per-sender sequence number (account nonce). */
  nonce: number;
  /** Transaction type discriminator (u16). */
  type: TxType;
  /** Gas paid to the Mining Pool, validated against the protocol formula. */
  gas: bigint;
  /** Serialized body, decoded according to `type`. */
  body: Uint8Array;
  /** Optional human memo, never interpreted by consensus. */
  memo?: string;
  /** Absolute expiry in protocol seconds (height-derived in the node). */
  validUntil: ProtocolTimeSeconds;
  signature: TxSignature;
}

export enum TxType {
  PAYMENT = 1,
  ONS = 2,
  ORACLE = 6,
  MINING_CLAIM = 7,
  // 8 (VALIDATOR) and 12 (SLASH) were removed in 1.9.0 and are never reused: the validator model does not exist.
  TREASURY = 9,
  GOVERNANCE = 10,
  /**
   * Node Runner registry. Carries the signed statements that make node-runner
   * rewards measurable: registration (signed by the node's own key; the reward wallet is only named, no wallet
   * signature and no gas), wallet changes, deregistration, liveness heartbeats, peer attestations and
   * peer fault reports. None of these carry an amount: the protocol computes
   * every payout from the evidence it collects here (see src/economy/node-rewards.ts).
   */
  NODE_REGISTRY = 11,
  /**
   * Mining gate authority update (protocol 1.8.0): rotate or revoke the issuer keys that open the mining gate.
   * Authorised by a majority of the CURRENT issuer keys, who sign the exact change; the submitter's own key and
   * account decide nothing and no gas is paid (see src/mining/gate-authority.ts).
   */
  GATE_AUTHORITY = 13,
  /**
   * ONS Marketplace (protocol 2.0.0): fixed-price listings, purchases, and owner-directed offers with protocol escrow.
   * Every operation is signed by the account that performs it and carries standard gas where value enters the
   * protocol (a purchase, an offer); see src/transactions/executors/marketplace.ts and docs/marketplace-v2.0.0.md.
   */
  ONS_MARKET = 14,
}

/** Operations inside a GATE_AUTHORITY transaction. */
export enum GateAuthorityOp {
  /** Add and/or remove issuer keys, signed by a majority of the current set. */
  UPDATE = 1,
}

/** One current issuer's signature over a gate authority update. */
export interface GateApproval {
  /** Compressed public key of an issuer in the CURRENT active set. */
  key: string;
  /** Compact signature (128 hex) over the update message. */
  signature: string;
}

export interface GateAuthorityBody {
  op: GateAuthorityOp;
  /** The epoch this update creates; must be exactly the chain's current epoch + 1 (so an update applies once). */
  epoch: number;
  add: string[];
  remove: string[];
  approvals: GateApproval[];
}

/** Operations inside a NODE_REGISTRY transaction. */
export enum NodeRegistryOp {
  REGISTER = 1,
  CHANGE_WALLET = 2,
  DEREGISTER = 3,
  /** A signed liveness statement from the node itself, valid within a slot. */
  HEARTBEAT = 4,
  /** A signed statement from one node about another node's liveness. */
  ATTEST = 5,
  /** A signed report that another node behaved incorrectly. */
  REPORT_FAULT = 6,
  /** The current wallet cancels a pending reward-wallet change (sender = current reward wallet). */
  CANCEL_WALLET_CHANGE = 7,
  /**
   * The owner of a bound wallet releases it from a node that did not prove control of it (sender = the wallet).
   * Unsigned binding means anyone can bind anyone's address; this is the owner's way out, after a transparent delay.
   */
  RECLAIM_WALLET = 8,
  /** Cryptographic proof that a node signed two different blocks on one parent: the node is banned (no bond to slash). */
  REPORT_EQUIVOCATION = 9,
}

export interface NodeRegistryBody {
  op: NodeRegistryOp;
  /** 64 hex characters: the hash of the node identity public key. */
  nodeId: string;
  /** Address that receives this node's rewards. Never the key itself. */
  rewardWallet: string;
  /** Compressed secp256k1 public key of the node identity (66 hex chars). */
  nodePublicKey: string;
  /** Signature over the operation's domain-separated message (128 hex chars). */
  proof: string;
  /** Informational endpoint hint. Never an identity, never trusted for scoring. */
  endpoint?: string;
  /** Monotonic slot for heartbeats/attestations, derived from protocol time. */
  slot?: number;
  /** For ATTEST / REPORT_FAULT: the subject node. */
  subject?: string;
  /** Height the reporting node claims to be at, verified against chain tolerance. */
  reportedHeight?: number;
  /** For REPORT_FAULT: short machine-readable reason stored on-chain. */
  reason?: string;
  /** Protocol time the statement was issued at (registration proofs). */
  issuedAt?: number;
  /** Protocol time the statement stops being valid (registration proofs). */
  expiresAt?: number;
  /** REPORT_EQUIVOCATION: hex of the two signed headers (canonical signed encoding). */
  firstHeader?: string;
  secondHeader?: string;
}

// ── Payments ─────────────────────────────────────────────────────────────────

export interface PaymentBody {
  to: string;
  amount: bigint;
  memo?: string;
}

// ── ONS ──────────────────────────────────────────────────────────────────────

export enum OnsOp {
  REGISTER = 1,
  UPDATE_ADDRESS = 2,
  /** Owner OFFERS the name to `to`. Nothing changes hands until `to` sends ACCEPT_TRANSFER. */
  TRANSFER = 3,
  RENEW = 4,
  /** The offered recipient takes the name (sender must equal the offer's `to`). Atomic. */
  ACCEPT_TRANSFER = 5,
  /** The owner withdraws an open offer. */
  CANCEL_TRANSFER = 6,
  /** The owner sets (or clears, with an empty address) the recovery address. */
  SET_RECOVERY = 7,
  /** The recovery address starts a recovery to `address`; effective after `ons.recoveryDelaySeconds`. */
  START_RECOVERY = 8,
  /** The owner cancels a recovery in flight. */
  CANCEL_RECOVERY = 9,
  /** The recovery address completes a recovery once its delay has passed. */
  FINALIZE_RECOVERY = 10,
}

/** Operations inside an ONS_MARKET transaction. Numbers are part of the wire format and are never reused. */
export enum MarketOp {
  /** The owner lists the name for a fixed price. Locks the name; voids and refunds any pending offers. */
  LIST = 1,
  /** The owner changes the price of an active listing. */
  UPDATE_PRICE = 2,
  /** The owner removes the listing and gets ordinary use of the name back. */
  DELIST = 3,
  /** A buyer pays the listed price; payment and ownership move in the same state transition. */
  BUY = 4,
  /** A buyer offers an amount for an owned, unlisted name; the amount moves into protocol escrow at once. */
  OFFER = 5,
  /** The owner accepts one pending offer: name to the offer maker, escrow to the owner, atomically. */
  ACCEPT_OFFER = 6,
  /** The owner declines one pending offer: escrow returns to the offer maker. */
  DECLINE_OFFER = 7,
  /** The offer maker withdraws a pending offer: escrow returns to the offer maker. */
  CANCEL_OFFER = 8,
}

export interface MarketBody {
  op: MarketOp;
  name: string;
  /** LIST/UPDATE_PRICE: the price. BUY: the price the buyer expects. OFFER: the offered amount. ACCEPT_OFFER: the amount accepted. */
  amount: bigint;
  /** BUY: the seller the buyer expects. OFFER: the owner the offer is addressed to. Empty otherwise. */
  counterparty: string;
  /** ACCEPT_OFFER / DECLINE_OFFER / CANCEL_OFFER: the offer id (the id of the transaction that created it). */
  offerId: string;
}

/** An active fixed-price listing. It lives on the name record, so a name can never have two. */
export interface MarketListing {
  /** Price in seals. */
  price: bigint;
  /** The owner who listed it; always equal to the record's owner while the listing exists. */
  seller: string;
  listedAt: ProtocolTimeSeconds;
  listedAtHeight: number;
}

export type MarketOfferStatus = 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'CANCELLED' | 'EXPIRED' | 'INVALIDATED';

/**
 * An owner-directed offer. `amount` is held in protocol escrow while the status is PENDING and is released exactly
 * once when the status leaves it. The record is kept after settlement as the audit trail.
 */
export interface MarketOffer {
  /** The id of the transaction that created the offer. */
  id: string;
  name: string;
  maker: string;
  /** The owner of the name when the offer was made (and the only address that may accept or decline it). */
  owner: string;
  amount: bigint;
  status: MarketOfferStatus;
  createdAt: ProtocolTimeSeconds;
  createdAtHeight: number;
  expiresAt: ProtocolTimeSeconds;
  resolvedAt?: ProtocolTimeSeconds;
  resolvedAtHeight?: number;
  /** Who or what ended it: an address for accept/decline/cancel, or LISTED / OWNER_CHANGED / NAME_EXPIRED / OFFER_EXPIRED. */
  resolvedBy?: string;
  resolvedTxId?: string;
}

/** Committed marketplace accounting. `escrowBalance` is exactly the sum of the amounts of the PENDING offers. */
export interface MarketState {
  escrowBalance: bigint;
  listingsCreated: number;
  salesCount: number;
  salesVolume: bigint;
  offersMade: number;
  offersAccepted: number;
}

export interface OnsBody {
  op: OnsOp;
  name: string;
  address?: string;
  to?: string;
  /** Fee in OBS the signer offers; must cover the fixed protocol fee. */
  fee: bigint;
}

// ── Oracle ───────────────────────────────────────────────────────────────────

export interface OracleBody {
  /** Observations the submitter attests to. */
  observations: Array<{
    source: string;
    priceUsdMicro: bigint;
    observedAt: ProtocolTimeSeconds;
  }>;
  /** Optional replay guard for oracle submissions. */
  submissionId: Hex;
}

// ── Mining ───────────────────────────────────────────────────────────────────

export interface MiningClaimBody {
  /**
   * Protocol-authoritative claim identity.
   * claimId = H(CLAIM | chainId | address | claimSequence | lastClaimBlockHeight)
   * Duplicate or replayed claim ids are rejected in the state machine.
   */
  claimId: Hex;
  /** Sequence number asserted by the miner; must equal state's next value. */
  claimSequence: number;
  /** Hash of the node the claim was submitted through (audit only). */
  viaNodeId?: string;
  /**
   * Mining gate certificate. Consensus REQUIRES it: a claim without a valid one is rejected, so the account system
   * (sign-in, MFA, one wallet per account) is the only door to mining, not just the platform's own endpoint.
   */
  gate?: MiningGateCertificate;
}

/** A short-lived statement, signed by a genesis-committed issuer key, that ONE wallet may make ONE specific claim. */
export interface MiningGateCertificate {
  /** Compressed public key of the issuer; must be one of the keys active when the claim is included (genesis keys, as changed by GATE_AUTHORITY updates). */
  issuer: string;
  /** Protocol time (seconds) at which the issuer signed. Valid for `miningGate.certificateTtlSeconds` after it. */
  issuedAt: number;
  /** Compact signature (128 hex) over the certificate message. */
  signature: string;
}

// ── Treasury ─────────────────────────────────────────────────────────────────

export enum TreasuryOp {
  /** Existing treasury balance grants signed by the designated treasury key. */
  GRANT = 2,
}

export interface TreasuryBody {
  op: TreasuryOp;
  amount: bigint;
  purpose: string;
  to?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

export interface BlockHeader {
  protocolVersion: string;
  chainId: number;
  height: number;
  prevHash: Hex;
  /** Merkle root over the canonical transaction ids in the block. */
  txRoot: Hex;
  /** Root of the canonical state tree after applying every transaction. */
  stateRoot: Hex;
  /** SHA-256 of the protocol parameter set — a fork detector across nodes. */
  paramsHash: Hex;
  timestamp: ProtocolTimeSeconds;
  /** Producer address: the address of a registered node's identity key (or any key while no node is registered). */
  producer: string;
  /** Accumulated work used by the deterministic fork-choice rule. */
  cumulativePotWeight: bigint;
  /** Number of transactions in the block (redundant, tamper-evident). */
  txCount: number;
  /** Root of protocol events emitted by the block (indexers verify this). */
  eventsRoot: Hex;
  /** Producer signature over the header hash. */
  producerSignature: TxSignature;
}

export interface BlockBody {
  transactions: TxEnvelope[];
}

export interface Block {
  header: BlockHeader;
  transactions: TxEnvelope[];
}

export interface BlockSummary {
  hash: Hex;
  height: number;
  timestamp: ProtocolTimeSeconds;
  txCount: number;
  producer: string;
  size: number;
  prevHash: Hex;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

export interface Account {
  address: string;
  /** Liquid balance in seals. */
  balance: bigint;
  /** Next expected transaction nonce. */
  nonce: number;
  /** Total ever received (metric). */
  totalReceived: bigint;
  /** Total ever sent (metric). */
  totalSent: bigint;
  /** Number of transactions signed by this account. */
  txCount: number;
  /** Protocol height at which the account first appeared. */
  createdAtHeight: number;
  createdAt: ProtocolTimeSeconds;
  /** Mining state, if the account has ever claimed. */
  mining?: MiningState;
  /** Oracle submission throttle (deterministic anti-spam, height based). */
  oracleSubmissions?: OracleThrottle;
}

export interface OracleThrottle {
  /** Height of the last accepted oracle transaction from this account. */
  lastHeight: number;
  /** Lifetime accepted oracle submissions. */
  count: number;
}

export interface MiningState {
  /** Sequence of the next acceptable claim (starts at 1). */
  claimSequence: number;
  /** Protocol time of the last accepted claim. */
  lastClaimAt: ProtocolTimeSeconds;
  /** Height of the last accepted claim. */
  lastClaimHeight: number;
  /** Start of the current 24-hour claim cycle. */
  cycleStartAt: ProtocolTimeSeconds;
  /** Claims accepted inside the current cycle. */
  claimsThisCycle: number;
  /** Lifetime accepted claims (metric and reward-step input). */
  totalClaims: number;
  /** Lifetime reward paid to this account for mining. */
  totalReward: bigint;
  /** True once the account has produced at least one accepted claim. */
  eligible: boolean;
}

export interface GenesisState {
  /** false -> true exactly once, ever. */
  allocationClaimed: boolean;
  /** Wallet recorded as the first valid miner (empty until claimed). */
  recipient: string;
  /** Protocol treasury wallet. Equals `recipient` under the initial rule. */
  treasuryWallet: string;
  /** Height at which the allocation was made. */
  claimedAtHeight?: number;
  /** Transaction that won the allocation. */
  claimedByTxId?: Hex;
  /** Amount actually issued (fixed at params.genesisAllocation). */
  amount: bigint;
  /** Issuer keys committed by genesis whose certificates open the mining gate. Empty means no claim is possible. */
  miningGateKeys: string[];
  /**
   * The issuer keys that are valid NOW (protocol 1.8.0). Equals `miningGateKeys` until a GATE_AUTHORITY update
   * rotates or revokes some. `miningGateKeys` itself never changes: it is what the genesis id commits to.
   */
  gateKeysActive: string[];
  /** Keys removed by an update. A revoked key can never be added again. Bounded by `miningGate.maxRevoked`. */
  gateKeysRevoked: string[];
  /** Number of gate authority updates applied. */
  gateEpoch: number;
}

export interface OnsRecord {
  name: string;
  owner: string;
  address: string;
  registeredAtHeight: number;
  registeredAt: ProtocolTimeSeconds;
  expiresAt: ProtocolTimeSeconds;
  transferCount: number;
  /** An open transfer offer. The name changes hands only if `to` accepts before `offerExpiresAt`. */
  pendingTransfer?: { to: string; offeredAt: ProtocolTimeSeconds; offerExpiresAt: ProtocolTimeSeconds };
  /** Preconfigured recovery address. Set by the owner; may start a delayed recovery; has no other power. */
  recoveryAddress?: string;
  /** A recovery in flight. It takes effect only at `effectiveAt`, and the current owner may cancel until then. */
  pendingRecovery?: { by: string; newAddress: string; startedAt: ProtocolTimeSeconds; effectiveAt: ProtocolTimeSeconds };
  /** An active Marketplace listing (protocol 2.0.0). While it exists the owner cannot use or manage the name. */
  listing?: MarketListing;
}

export interface OracleObservation {
  source: string;
  priceUsdMicro: bigint;
  observedAt: ProtocolTimeSeconds;
  submitter: string;
  height: number;
}

export interface OracleState {
  /** Source id -> latest accepted observation. */
  observations: Record<string, OracleObservation>;
  /** Median of accepted observations, or 0 when there is no valid price. */
  medianPriceUsdMicro: bigint;
  /** Protocol time of the median computation. */
  medianUpdatedAt: ProtocolTimeSeconds;
  /** Number of sources used. */
  sourceCount: number;
  /** True when the median is older than params.oracle.maxAgeSeconds. */
  stale: boolean;
}

/**
 * A mining reward actually paid. Mining rewards settle immediately at the
 * height that accepts the claim (pool funds first, then scheduled issuance), so
 * a distribution record is an audit entry rather than a pending obligation.
 */
export interface PoolClaim {
  address: string;
  /** Height of the block that accepted the claim. */
  claimHeight: number;
  /** Protocol time of that block. */
  claimTime: ProtocolTimeSeconds;
  /** Reward owed at that time, computed deterministically. */
  amount: bigint;
  /** Reward actually paid so far. */
  paid: bigint;
  claimId: Hex;
}

export interface MiningPoolState {
  /** Protocol account holding gas and other explicitly allocated mining-pool inflows. */
  balance: bigint;
  /** Lifetime inflow (for the explorer). */
  lifetimeInflow: bigint;
  /** Lifetime outflow paid to miners. */
  lifetimeDistributed: bigint;
  /** Recent pool distributions, oldest first (capped, for explorer audit). */
  recentDistributions: PoolClaim[];
  /** Last height at which settlement ran. */
  lastSettlementHeight: number;
  /** Total claims settled in the protocol's lifetime. */
  settledClaims: number;
}

/**
 * A registered node runner.
 *
 * IDENTITY → OPERATOR → REWARD WALLET
 *   `nodeId` is the hash of a secp256k1 public key the operator holds. It is the
 *   identity: it survives an IP change, a hosting migration, a new machine and a
 *   new domain. The IP address, hostname or endpoint a node advertises is a hint
 *   stored beside the record and is NEVER used as identity or as evidence.
 *
 *   `rewardWallet` is the address that receives this node's share of the Node
 *   Runner Reward Pool. It is bound by a secp256k1 signature from that wallet's
 *   own key over a domain-separated message, so nobody can point someone else's
 *   wallet at a node they run.
 *
 * REWARD UNIQUENESS
 *   One reward wallet may back exactly one node, and one node may have exactly
 *   one reward wallet at a time. `rewardWalletOf` in state.ts is the reverse
 *   index every registration checks, which is what stops one machine presenting
 *   itself as ten nodes and collecting ten shares.
 */
export interface NodeRecord {
  nodeId: string;
  /** Address that receives rewards. Bound by signature, never by trust. */
  rewardWallet: string;
  /** Compressed secp256k1 public key of the node identity, hex. */
  nodePublicKey: string;
  /** Endpoint hint for operators to find each other. Never an identity. */
  endpoint: string;
  registeredAtHeight: number;
  registeredAt: ProtocolTimeSeconds;
  /** Set when the node deregisters; it stops earning immediately. */
  deregisteredAtHeight?: number;
  /** Wallet change in flight: signed by the new wallet, effective at a period. */
  pendingWallet?: string;
  pendingWalletEffectivePeriod?: number;
  pendingWalletRequestedAtHeight?: number;
  /**
   * Block-producer address: the bech32 address of `nodePublicKey` on this network. The header signature must verify
   * under the key that hashes to the producer address, so one node cannot forge another's identity.
   */
  producerAddress: string;
  /** Protocol time of the node's last sign of life: registration, heartbeat or a block it produced. */
  lastActiveAt: ProtocolTimeSeconds;
  /** Consecutive scheduled slots this node missed (reset when it produces a block). */
  missedSlots: number;
  /** Suspension back-off level: suspensions in a row without a produced block in between. */
  suspensions: number;
  /** While in the future (protocol time) the node is skipped by the schedule. */
  suspendedUntil?: ProtocolTimeSeconds;
  /** Set by a verified equivocation report. A banned node never produces, never earns, never counts. */
  bannedAtHeight?: number;
  /** Id of the evidence that banned it. */
  banEvidenceId?: string;
  /** A release of the bound wallet requested by that wallet's owner (see RECLAIM_WALLET). */
  reclaimEffectivePeriod?: number;
  /** The bound (or reserved) wallet that asked to be released. */
  reclaimWallet?: string;
  /** Blocks this node has produced, lifetime (metric, never an input to scoring). */
  blocksProduced: number;
  /** Lifetime rewards credited to this node's wallets, for the operator UI. */
  lifetimeReward: bigint;
  /** Periods already settled for this node, capped to the evidence window. */
  settledPeriods: number[];
}

/** Per-period, per-node evidence, written only by block routines. */
export interface NodeEvidenceRecord {
  nodeId: string;
  period: number;
  /** In-sync heartbeats accepted in the period (at most one per uptime window; replays are rejected). */
  heartbeats: number;
  /**
   * Bitmask of the uptime windows of this period in which the node was provably up: bit i is window i of the period.
   * Set by an in-sync heartbeat or by a block the node produced in that window. Uptime = popcount / windows.
   */
  liveWindows: number;
  /** Distinct nodes that attested this node in the period. */
  attesters: string[];
  /** Blocks this node produced inside the period. */
  blocksProduced: number;
  /** Distinct peers this node attested inside the period. */
  attested: string[];
  /** Fault reports attributed to this node (penalised only when corroborated). */
  faults: number;
  /** Distinct nodes that filed a fault report about this node in the period. */
  faultReporters: string[];
  /** Heartbeats that carried a height outside the protocol tolerance. */
  staleHeartbeats: number;
  /** Attestations from this node that contradicted protocol state. */
  invalidAttestations: number;
  /** Reported height of the last heartbeat/attestation in the period. */
  lastReportedHeight: number;
}

/**
 * The Node Runner Reward Pool: the 90% share of ONS revenue, held as a
 * protocol balance and paid out once per period by the block routine.
 *
 * `unclaimedRevenue` is the 10% treasury share received before the first valid
 * mining claim designates a treasury wallet. It remains visible and is
 * credited to that wallet when it is designated.
 */
export interface NodeRewardPoolState {
  /** Seals held for node runners (the 90% ONS-revenue share). */
  balance: bigint;
  /** Reward period the block counter below belongs to (-1 = not started). */
  blockCountPeriod: number;
  /** Blocks counted inside `blockCountPeriod`, used to score participation. */
  blockCount: number;
  /** Lifetime inflow into the pool. */
  lifetimeInflow: bigint;
  /** Lifetime amount paid out to registered nodes. */
  lifetimeDistributed: bigint;
  /** Last period settled by the block routine (0 = none yet). */
  lastSettledPeriod: number;
  /** Rewards settled in the last few periods, newest last (explorer audit). */
  recentSettlements: NodeRewardSettlement[];
  /** ONS revenue received before a treasury wallet existed. */
  unclaimedRevenue: bigint;
  /** Lifetime ONS revenue, by source (registration or renewal). */
  revenueBySource: Array<{ source: string; total: bigint }>;
}

export interface NodeRewardSettlement {
  period: number;
  poolSeals: bigint;
  distributedSeals: bigint;
  carriedSeals: bigint;
  eligibleNodes: number;
  scoredNodes: number;
  atHeight: number;
  /** nodeId → amount credited, in registration order (lexicographic). */
  payouts: Array<{ nodeId: string; rewardWallet: string; amount: bigint; scoreBps: number; shareBps: number }>;
}

export interface Metrics {
  /** Accounts that claimed inside the active-miner window at this height. */
  activeMiners: number;
  totalAccounts: number;
  totalTransactions: number;
  totalMiningClaims: number;
  /** Seals issued through mining so far. */
  minedSupply: bigint;
  /** Every issuance bucket, for the supply invariant audit. */
  issuedGenesis: bigint;
  totalSupply: bigint;
  totalGasBurnedToPool: bigint;
  totalFeesToPool: bigint;
  totalTreasuryRevenue: bigint;
  /** ONS revenue before the exact 90/10 split. */
  totalOnsRevenue: bigint;
  /** Lifetime ONS revenue routed to the Node Runner Reward Pool. */
  totalOnsRunnerShare: bigint;
  /** Lifetime ONS revenue routed to the treasury. */
  totalOnsTreasuryShare: bigint;
  /** Lifetime node runner rewards paid out of the pool. */
  totalNodeRewardsPaid: bigint;
  /** Registered (non-deregistered) node runners at this height. */
  registeredNodes: number;
  totalNamesRegistered: number;
}

export interface ProtocolEvent {
  /** Canonical event type name (indexers switch on this). */
  type: string;
  height: number;
  txId?: Hex;
  /** Hex-encoded canonical payload of the event. */
  data: Record<string, string | number | boolean | null>;
}

export interface StateSnapshot {
  /**
   * Lossless snapshot format. 2.0.0 uses format 7 (format 6 plus the Marketplace listing, offer table and escrow
   * counters; 6 was producer schedule fields on node records, ONS transfer and recovery fields, no validator state); older snapshots are refused rather than partially read.
   */
  snapshotVersion?: number;
  /** Network identity fields make cross-network restores fail closed. */
  networkId?: string;
  genesisId?: Hex;
  paramsHash?: Hex;
  /** State root independently recomputed before a snapshot is accepted. */
  stateRoot?: Hex;
  /** Height this snapshot represents. */
  height: number;
  /** Hash of the block this state results from. */
  blockHash: Hex;
  chainId: number;
  protocolVersion: string;
  /** Protocol time of the block that produced this state. */
  timestamp: ProtocolTimeSeconds;
  accounts: Record<string, Account>;
  genesis: GenesisState;
  names: Record<string, OnsRecord>;
  /** Marketplace offers of every status still retained, keyed by offer id. */
  offers: Record<string, MarketOffer>;
  market: MarketState;
  oracle: OracleState;
  pool: MiningPoolState;
  metrics: Metrics;
  /** Set of accepted mining claim ids with heights, for claim replay protection. */
  recentClaimIds: Record<string, number>;
  /** Registered node runners, keyed by nodeId. Consensus state: rewards depend on it. */
  nodes: Record<string, NodeRecord>;
  /** Per-period node evidence, keyed "period:nodeId". */
  nodeEvidence: Record<string, NodeEvidenceRecord>;
  /** Node Runner Reward Pool and revenue accounting. */
  nodeRewards: NodeRewardPoolState;
  /** Derived finality (consensus state, committed in the state root). */
  finality: FinalityState;
}

/** One entry of the rolling window finality is computed from. */
export interface FinalityRecentBlock {
  height: number;
  /** Producer address of the block at `height`. */
  producer: string;
  /** Hash of the block at `height`; known once its child has been applied, '' for the newest entry. */
  hash: string;
}

/**
 * Finality as consensus state. Block `finalizedHeight` and everything before it is final on this chain: a branch that
 * does not contain `finalizedHash` at `finalizedHeight` is never adopted. It only ever moves forward, and it is part
 * of the state root, so two nodes with the same head agree on it or disagree on the root.
 */
export interface FinalityState {
  finalizedHeight: number;
  finalizedHash: Hex;
  recent: FinalityRecentBlock[];
}

export interface ChainMeta {
  chainId: number;
  networkId: string;
  genesisId: Hex;
  genesisHash: Hex;
  protocolVersion: string;
  /** SHA-256 of the frozen parameter set. */
  paramsHash: Hex;
  /** Height of the genesis block (0 in Obsidian). */
  genesisHeight: number;
}

export type StateChangeKind =
  | 'CREDIT'
  | 'DEBIT'
  | 'SET'
  | 'DELETE'
  | 'EVENT';

export interface StateChange {
  kind: StateChangeKind;
  path: string;
  value?: string | number | boolean | null;
  /** Human-readable reason for the audit log. */
  reason: string;
}
