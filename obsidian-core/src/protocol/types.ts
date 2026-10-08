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
  /**
   * Slashing. Carries self-contained cryptographic proof that a bonded
   * validator signed two conflicting messages for one consensus slot. The
   * submitter chooses nothing: the executor derives the penalty from the
   * consensus slash ratio and the validator's own record, and a validator can
   * only be slashed by evidence that every honest node verifies identically
   * (src/consensus/slash-evidence.ts).
   */
  SLASH = 12,
}

/** Operations inside a SLASH transaction. */
export enum SlashOp {
  /** Two conflicting block proposals, or two conflicting finality votes. */
  EQUIVOCATION = 1,
}

/**
 * The evidence carried by a SLASH transaction.
 *
 * `evidence` is one of the two canonical `EquivocationEvidence` shapes the rest
 * of the protocol already uses — the same objects the node detects locally and
 * publishes at `/finality`. The evidence id is recomputed from the evidence
 * itself during execution, so a submitter cannot rename or reshape it.
 *
 * Proposer evidence proves two signed headers at one height in one round, but a
 * header does not carry its parent's timestamp, and the round is a function of
 * it. The transaction therefore also carries both parent headers. They are
 * bound to the children by `child.prevHash === blockHash(parent)`, so a parent
 * cannot be fabricated to fake a round: finding a header that hashes to the
 * committed prevHash is the same problem as breaking SHA-256.
 */
export interface SlashBody {
  op: SlashOp;
  evidence: EquivocationEvidence;
  /** Parent header of `evidence.firstHeader`, hex of its signed encoding. */
  firstParentHeader?: Hex;
  /** Parent header of `evidence.secondHeader`, hex of its signed encoding. */
  secondParentHeader?: Hex;
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

// ── Native Proof-of-Time finality and equivocation evidence ──────────────────

export interface FinalityVote {
  protocolVersion: string;
  networkId: string;
  chainId: number;
  genesisId: Hex;
  paramsHash: Hex;
  type: 'POT_FINALITY';
  finalizedHeight: number;
  finalizedHash: Hex;
  height: number;
  round: number;
  blockHash: Hex;
  parentHash: Hex;
  validatorSetHash: Hex;
  validator: string;
  publicKey: Hex;
  signature: Hex;
}

export interface FinalityCertificate {
  version: 1;
  finalizedHeight: number;
  finalizedHash: Hex;
  height: number;
  blockHash: Hex;
  parentHash: Hex;
  validatorSetHash: Hex;
  quorum: number;
  validatorCount: number;
  votes: FinalityVote[];
}

export interface ProposerEquivocationEvidence {
  version: 1;
  id: Hex;
  type: 'PROPOSER_EQUIVOCATION';
  validator: string;
  height: number;
  round: number;
  messageType: 'BLOCK_PROPOSAL';
  firstId: Hex;
  secondId: Hex;
  firstHeader: Hex;
  secondHeader: Hex;
}

export interface VoteEquivocationEvidence {
  version: 1;
  id: Hex;
  type: 'VOTE_EQUIVOCATION';
  validator: string;
  height: number;
  round: number;
  messageType: 'POT_FINALITY';
  firstId: Hex;
  secondId: Hex;
  firstVote: FinalityVote;
  secondVote: FinalityVote;
}

export type EquivocationEvidence = ProposerEquivocationEvidence | VoteEquivocationEvidence;

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

export interface ValidatorState {
  validatorKey: Hex;
  bond: bigint;
  commissionBps: number;
  registeredAtHeight: number;
  /**
   * Protocol time at which the jail ends, set while jailed.
   *
   * A DURATION OF PROTOCOL TIME, not a height: on a chain that has stopped
   * producing — which is what a jail can cause once it empties the active set —
   * a height-denominated term would never be reached. Absent means "not
   * jailed"; a JAILED validator with no term is treated as jailed for ever
   * (fail closed) rather than as free.
   */
  jailedUntilTime?: ProtocolTimeSeconds;
  missedSlots: number;
  /**
   * SLASHED is terminal for this registration: the validator is out of the
   * proposer rotation and out of the finality committee the moment the block
   * carrying the evidence is applied, and the remainder of the bond (never the
   * slashed part) can be claimed after the ordinary unbonding delay. Returning
   * as a validator means a fresh registration with a full bond.
   */
  status: 'ACTIVE' | 'UNBONDING' | 'JAILED' | 'SLASHED';
  unbondingStartHeight?: number;
  /** Height of the block whose state transition applied the slash. */
  slashedAtHeight?: number;
  /** Id of the evidence that caused the slash; committed in the state root. */
  slashEvidenceId?: Hex;
}

/**
 * One applied slash. Keyed by evidence id, which is what makes slashing
 * idempotent across replays, restarts and competing submitters: the second
 * transaction carrying the same evidence finds the record and is rejected.
 */
export interface SlashRecord {
  evidenceId: Hex;
  type: 'PROPOSER_EQUIVOCATION' | 'VOTE_EQUIVOCATION';
  validator: string;
  /** Height of the equivocation (not of the block that punished it). */
  height: number;
  round: number;
  /** Slashed amount, exactly `consensus.equivocationSlashBps` of the bond. */
  amount: bigint;
  /** Bond held by the validator before the slash. */
  bondBefore: bigint;
  /** Bond still held by the validator after the slash. */
  bondAfter: bigint;
  slashedAtHeight: number;
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
  /** Public keys committed by the fresh genesis as the initial finality set. */
  bootstrapValidatorKeys: string[];
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
  /** Lifetime value moved from slashed validator bonds into the Mining Pool. */
  totalSlashedToPool: bigint;
  /** Number of applied slashes. */
  totalSlashes: number;
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
  /** Lossless snapshot format. v1.6.0 uses format 2; older snapshots are not compatible. */
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
  /** Registered validators in deterministic (address-sorted) order. */
  validators: string[];
  /**
   * Whether this chain has ever accepted a valid validator registration.
   *
   * CONSENSUS STATE, committed in the state root and required in format 3:
   *   - false — bootstrap mode. No validator has ever registered, so any node
   *     may propose; this is how the first validator arrives at all.
   *   - true  — the rotation is closed for ever. Block production belongs to
   *     the active set, and an empty active set halts the chain instead of
   *     letting any key produce.
   *
   * It is set only by the state transition of the first successful
   * VALIDATOR_REGISTER, it is never cleared, and it is never inferred from the
   * number of validators a node currently sees — "no validators" is not
   * distinguishable on-chain from "every validator left".
   */
  validatorModeEstablished: boolean;
  /**
   * Applied slashes, keyed by evidence id. Consensus state: it is what stops a
   * replay of the same evidence from slashing the same bond twice.
   */
  slashes?: Record<string, SlashRecord>;
}

/**
 * The historical lookups a consensus-critical validation may perform.
 *
 * A finality vote, a certificate and slash evidence must be judged against
 * HISTORY — the committee and the anchor as they were when the message was
 * produced — never against whatever the validating node happens to hold now.
 * Every caller supplies this same interface, which is what lets ONE predicate
 * serve P2P admission, block execution, certificate verification, vote
 * restoration and evidence verification without a second implementation to
 * drift out of step with the first.
 *
 * A lookup returns null when this node does not have the data. The predicate
 * then reports that explicitly and the CALLER decides: consensus paths fail
 * closed, an admission path may treat it as "unknown, do not relay". No
 * predicate may substitute current state for a missing historical answer.
 */
export interface ConsensusEvidenceContext {
  /** This node's chain identity: a message for another chain is not one here. */
  readonly networkId: string;
  readonly chainId: number;
  readonly genesisId: string;
  readonly paramsHash: string;
  /** Bech32 prefix this network's validator addresses use. */
  readonly addressHrp: string;
  /** Height and protocol time of a block this node holds, or null. */
  anchorFor(hash: string): { height: number; timestamp: number } | null;
  /** A block this node holds, or null. */
  blockByHash(hash: string): Block | null;
  /**
   * Finality committee in force for the anchor's parent, in the deterministic
   * address order the set hash is computed over — or null when the anchor state
   * is not available on this node. Order is part of the hash, so a caller must
   * not re-sort or filter what it returns.
   */
  committeeFor(
    parentHash: string,
    finalizedHeight: number,
  ): readonly { address: string; publicKey: string }[] | null;
  /** Whether `block` qualifies as a bootstrap finality target for `setHash`. */
  isBootstrapTarget(block: Block, setHash: string, historical: boolean): boolean;
  /**
   * Address the proposer schedule names for `height` in `round` on top of
   * `parentHash`, or null when no validator is scheduled (bootstrap mode). A
   * vote may only point at a block the schedule actually authorised.
   */
  scheduledProposerFor(
    parentHash: string,
    height: number,
    round: number,
    timestamp: number,
  ): string | null;
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
