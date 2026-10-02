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
 * a device, an HTTP request or a wall clock inside a validator.
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
  CAPSULE = 3,
  LAND = 4,
  SOCIAL = 5,
  ORACLE = 6,
  MINING_CLAIM = 7,
  VALIDATOR = 8,
  TREASURY = 9,
  GOVERNANCE = 10,
  /**
   * Node Runner registry. Carries the signed statements that make node-runner
   * rewards measurable: registration with a proof of reward-wallet ownership,
   * wallet changes, deregistration, liveness heartbeats, peer attestations and
   * peer fault reports. None of these carry an amount: the protocol computes
   * every payout from the evidence it collects here (see src/economy/node-rewards.ts).
   */
  NODE_REGISTRY = 11,
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
  TRANSFER = 3,
  RENEW = 4,
}

export interface OnsBody {
  op: OnsOp;
  name: string;
  address?: string;
  to?: string;
  /** Fee in OBS the signer offers; must cover the protocol fee at oracle price. */
  fee: bigint;
}

// ── Capsules ─────────────────────────────────────────────────────────────────

export enum CapsuleOp {
  CREATE = 1,
  PREVIEW = 2,
}

export interface CapsuleBody {
  op: CapsuleOp;
  /** Capsule id = bech32m("obsid", SHA-256(encrypted content digest + owner + unlockAt)). */
  capsuleId: string;
  /** SHA-256 commitment to the encrypted payload (content never hits the chain). */
  contentCommitment?: Hex;
  /** Size of the encrypted payload in bytes. */
  contentBytes?: number;
  /** Commitment locked in seals. */
  commitment?: bigint;
  /** AAD used by the client-side AEAD, transcribed so others can open it later. */
  contentNonce?: Hex;
  unlockAt?: ProtocolTimeSeconds;
  /** PREVIEW only: the plaintext preview slice, already decrypted client-side. */
  previewChunk?: Hex;
  /** PREVIEW only: the OBS price the signer pays (1000 x commitment). */
  payment?: bigint;
}

// ── Land (Obsidian Circle) ───────────────────────────────────────────────────

export enum LandOp {
  /** Official protocol market: issues one new parcel to the buyer at GLV. */
  PROTOCOL_BUY = 1,
  /** Owner lists a parcel at their marketplace asking price (MSP). */
  LIST = 2,
  DELIST = 3,
  /** Buyer accepts a listed MSP price. Does not change GLV. */
  BUY_LISTED = 4,
  /** Owner transfers a parcel to another wallet (standard gas rules). */
  GIFT = 5,
  /** Official protocol buyback: pays current GLV and reduces GLV. */
  PROTOCOL_SELL = 6,
}

/**
 * Land transactions carry the human-readable location descriptor, never a
 * pre-computed parcel id: every node re-derives the canonical content-addressed
 * parcel id itself, which removes any possibility of id spoofing or aliasing.
 */
export interface LandBody {
  op: LandOp;
  /** First-level administrative division, e.g. "US-CA" or "JP". */
  divisionId: string;
  /** ISO 3166-1 alpha-2 country code; must prefix divisionId. */
  countryCode: string;
  /** Administrative level of `subId` (see land/registry DIVISION_LEVEL_CODES). */
  level: number;
  /** City / district / street identifier inside the division. */
  subId: string;
  /** Plot ordinal inside the sub-division; the protocol market issues one plot per transaction. */
  plotIndex: bigint;
  /** Approximate parcel coordinates in integer micro-degrees. */
  latMicro?: number;
  lonMicro?: number;
  /** LIST: MSP in OBS. BUY_LISTED: the price the buyer accepts. */
  price?: bigint;
  /** GIFT: recipient wallet. */
  to?: string;
  /** PROTOCOL_BUY: USD value the signer is paying at oracle price (for audit). */
  usdValueAtPurchase?: bigint;
}

// ── Social ───────────────────────────────────────────────────────────────────

export enum SocialOp {
  SET_PROFILE = 1,
  FOLLOW = 2,
  UNFOLLOW = 3,
  POST = 4,
  DELETE_POST = 5,
  TIP = 6,
  PAY_BUSINESS_PAGE = 7,
  REQUEST_VERIFICATION = 8,
  SET_MONETISATION = 9,
  ATTEST_VIEWS = 10,
}

export interface SocialBody {
  op: SocialOp;
  /** Stable application account id (opaque string, never a wallet determinant). */
  accountId?: string;
  handle?: string;
  displayName?: string;
  bio?: string;
  avatarHash?: Hex;
  /** POST */
  postId?: Hex;
  content?: string;
  parentPostId?: Hex;
  /** FOLLOW / TIP / PAY_BUSINESS_PAGE */
  target?: string;
  targetAccountId?: string;
  amount?: bigint;
  kind?: 'TIP' | 'VIEW_REVENUE' | 'BUSINESS_PAGE' | 'CREATOR_PAYOUT';
  metadataHash?: Hex;
  tier?: 'BLUE' | 'GOLD';
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
}

// ── Validators ───────────────────────────────────────────────────────────────

export enum ValidatorOp {
  REGISTER = 1,
  UNREGISTER = 2,
  CLAIM_UNBONDED = 3,
}

export interface ValidatorBody {
  op: ValidatorOp;
  bond: bigint;
  /** Public key used for proposer-turn derivation (compressed secp256k1). */
  validatorKey: Hex;
  commissionBps?: number;
}

// ── Treasury ─────────────────────────────────────────────────────────────────

export enum TreasuryOp {
  /**
   * Explicit, auditable protocol revenue payment into the treasury wallet.
   * This is the ONLY way protocol revenue reaches the treasury: it moves funds
   * from the signer's own balance. It can never mint.
   */
  PAY_REVENUE = 1,
  /** Foundation grants from the treasury wallet (signed by the treasury key). */
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
  /** Producer (validator) address; must be registered for this height's slot. */
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
  /** Validator state, if registered. */
  validator?: ValidatorState;
  /** Mining state, if the account has ever claimed. */
  mining?: MiningState;
  /** Social/monetisation flags that must be consensus-visible. */
  flags: AccountFlags;
  /** Oracle submission throttle (deterministic anti-spam, height based). */
  oracleSubmissions?: OracleThrottle;
}

export interface AccountFlags {
  verifiedBlue?: boolean;
  verifiedGold?: boolean;
  businessPage?: boolean;
  monetisationEnabled?: boolean;
  suspended?: boolean;
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

export interface ValidatorState {
  validatorKey: Hex;
  bond: bigint;
  commissionBps: number;
  registeredAtHeight: number;
  /** Set while jailed; jailed validators are skipped in the proposer rotation. */
  jailedUntilHeight?: number;
  missedSlots: number;
  status: 'ACTIVE' | 'UNBONDING' | 'JAILED';
  unbondingStartHeight?: number;
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
}

export interface OnsRecord {
  name: string;
  owner: string;
  address: string;
  registeredAtHeight: number;
  registeredAt: ProtocolTimeSeconds;
  expiresAt: ProtocolTimeSeconds;
  transferCount: number;
}

export interface ParcelRecord {
  parcelId: string;
  /** First-level administrative division id, e.g. "US-CA". */
  divisionId: string;
  countryCode: string;
  cityId?: string;
  districtId?: string;
  streetId?: string;
  /** Approximate coordinates, stored as integer degrees * 1e6. */
  latMicro?: number;
  lonMicro?: number;
  /** Square metres (protocol parcels are 1 m²). */
  squareMetres: number;
  owner: string;
  /** Official protocol location value at the time of last update, USD micro. */
  glvSeals: bigint;
  /**
   * Division purchase counter when this parcel was issued or last acquired.
   * A parcel tracks later GLV movements only, so a buyer never retroactively
   * benefits from the purchase that created their own entry.
   */
  glvEntryCount?: number;
  /** Plot ordinal inside the sub-division (content-addressed identity input). */
  plotIndex?: number;
  /** Administrative level of `subId`. */
  level?: number;
  subId?: string;
  /** Individual location value established by a marketplace trade, USD micro. */
  ilvSeals?: bigint;
  /** Owner's marketplace asking price in OBS (not USD). */
  mspObs?: bigint;
  status: 'OWNED' | 'LISTED';
  acquiredAtHeight: number;
  issuedAtHeight: number;
  transferCount: number;
  lastProtocolAdjustmentHeight?: number;
  /** Height of the protocol purchase that last changed GLV. */
  glvUpdatedAtHeight?: number;
}

export interface DivisionRecord {
  divisionId: string;
  countryCode: string;
  /** Official protocol location value for every parcel in this division. */
  glvSeals: bigint;
  /** Count of protocol purchases used to derive appreciation. */
  protocolPurchases: number;
  protocolBuybacks: number;
  lastUpdatedAtHeight: number;
}

export interface CapsuleRecord {
  capsuleId: string;
  owner: string;
  creatorCommitment: bigint;
  contentCommitment: Hex;
  contentBytes: number;
  contentNonce: Hex;
  createdAt: ProtocolTimeSeconds;
  createdAtHeight: number;
  unlockAt: ProtocolTimeSeconds;
  status: 'LOCKED' | 'UNLOCKED';
  unlockedAtHeight?: number;
  /** OBS returned to the Mining Pool at unlock. */
  poolContribution?: bigint;
  /** Hex teaser the creator chose to make previewable (max 4 KiB). */
  teaser?: Hex;
  /** Sorted list of wallets that paid to Time Travel this capsule. */
  previewedBy: string[];
  previewCount: number;
  totalTimeTravelRevenue: bigint;
}

export interface SocialRecord {
  accountId: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarHash?: Hex;
  owner: string;
  createdAt: ProtocolTimeSeconds;
  followers: number;
  following: number;
  postCount: number;
  monthlyViews: number;
  earnings: bigint;
  tier: 'NONE' | 'BLUE' | 'GOLD';
  businessPage: boolean;
  monetisationEnabled: boolean;
}

export interface PostRecord {
  postId: Hex;
  authorAccountId: string;
  authorAddress: string;
  content: string;
  parentPostId?: Hex;
  createdAt: ProtocolTimeSeconds;
  createdAtHeight: number;
  deleted: boolean;
  likes: number;
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
  /** Protocol account holding gas, capsule commitments and Time Travel revenue. */
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
  /** Bond locked from the reward wallet at registration, returned at exit. */
  bond: bigint;
  /** Set when the node deregisters; it stops earning immediately. */
  deregisteredAtHeight?: number;
  /** Wallet change in flight: signed by the new wallet, effective at a period. */
  pendingWallet?: string;
  pendingWalletEffectivePeriod?: number;
  pendingWalletRequestedAtHeight?: number;
  /** Lifetime rewards credited to this node's wallets, for the operator UI. */
  lifetimeReward: bigint;
  /** Periods already settled for this node, capped to the evidence window. */
  settledPeriods: number[];
}

/** Per-period, per-node evidence, written only by block routines. */
export interface NodeEvidenceRecord {
  nodeId: string;
  period: number;
  /** Heartbeats accepted in the period (one per slot, replayed ones rejected). */
  heartbeats: number;
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
 * The Node Runner Reward Pool: the 40% share of qualifying platform revenue,
 * held as a protocol balance and paid out once per period by the block routine.
 *
 * `unpaidRevenue` is the part of qualifying revenue that arrived before the
 * genesis rule had designated a treasury wallet. It is not lost and it is not
 * income for anyone: when the designation exists, the recorded amount is split
 * by the same 40/60 rule. Recording it separately is what makes that provable.
 */
export interface NodeRewardPoolState {
  /** Seals held for node runners (already split from platform revenue). */
  balance: bigint;
  /** Registration bonds held by the protocol. Returned in full at deregistration. */
  bondedSeals: bigint;
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
  /** Qualifying revenue received before a treasury wallet existed. */
  unclaimedRevenue: bigint;
  /** Lifetime qualifying platform revenue, by source. */
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
  /** Qualifying platform revenue before the 40/60 split. */
  totalPlatformRevenue: bigint;
  /** Lifetime amount of qualifying revenue routed to the Node Runner Reward Pool. */
  totalNodeRewardRevenue: bigint;
  /** Lifetime amount of qualifying revenue routed to the treasury. */
  totalTreasuryFromSplit: bigint;
  /** Lifetime node runner rewards paid out of the pool. */
  totalNodeRewardsPaid: bigint;
  /** Registered (non-deregistered) node runners at this height. */
  registeredNodes: number;
  totalCreatorEarnings: bigint;
  totalTips: bigint;
  totalCapsulesCreated: number;
  totalParcelsIssued: number;
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
  divisions: Record<string, DivisionRecord>;
  parcels: Record<string, ParcelRecord>;
  capsules: Record<string, CapsuleRecord>;
  social: Record<string, SocialRecord>;
  posts: Record<string, PostRecord>;
  oracle: OracleState;
  pool: MiningPoolState;
  metrics: Metrics;
  /** Set of accepted mining claim ids with heights, for claim replay protection. */
  recentClaimIds: Record<string, number>;
  /** Follow edges "followerAccount->followedAccount", sorted, for the graph. */
  socialFollowing: string[];
  /** Registered node runners, keyed by nodeId. Consensus state: rewards depend on it. */
  nodes: Record<string, NodeRecord>;
  /** Per-period node evidence, keyed "period:nodeId". */
  nodeEvidence: Record<string, NodeEvidenceRecord>;
  /** Node Runner Reward Pool and revenue accounting. */
  nodeRewards: NodeRewardPoolState;
  /** Pending verification requests awaiting platform attestation. */
  verificationRequests: Record<
    string,
    { tier: 'BLUE' | 'GOLD'; requestedBy: string; requestedAtHeight: number; evidenceHash: string }
  >;
  /** Registered validators in deterministic (address-sorted) order. */
  validators: string[];
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
