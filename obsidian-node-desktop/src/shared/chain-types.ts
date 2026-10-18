/**
 * Shapes of the Obsidian Core RPC responses that the app reads.
 *
 * Every field here was verified against obsidian-core/src/rpc/server.ts (v1.7.0) and a
 * running devnet node. Only fields the app uses are listed; the validators in
 * src/core/rpc-client.ts return exactly these fields and reject a response in which one
 * is missing or has the wrong type.
 */

export type NetworkName = 'mainnet' | 'testnet' | 'staging' | 'devnet';
export const NETWORK_NAMES: readonly NetworkName[] = ['mainnet', 'testnet', 'staging', 'devnet'];

export interface HealthInfo {
  status: string;
  coreVersion: string;
  protocolVersion: string;
  network: string;
  networkId: string;
  chainId: number;
  genesisId: string;
  paramsHash: string;
  height: number;
  headHash: string;
  peers: number;
  syncing: boolean;
  supplyOk: boolean;
  uptimeSeconds: number;
  timestamp: number;
}

export interface StatusInfo {
  height: number;
  headHash: string;
  genesisHash: string;
  totalBlocks: number;
  diskBytes: number;
  mempoolTransactions: number;
  mempoolBytes: number;
  peers: number;
  syncing: boolean;
  supplyObs: string;
  maxSupplyObs: string;
  nodes: number;
  scheduleTier: string;
  activeMiners: number;
  lastBlockTimestamp: number;
  finalizedHeight: number;
  finalizedHash: string;
  finalityLag: number;
  finalityAvailable: boolean;
  finalityEligibleProducers: number;
  finalityQuorum: number;
  genesisAllocationClaimed: boolean;
}

/** `GET /finality`: derived from chain state alone. Checkpoint (economic) finality, not BFT. */
export interface FinalityInfo {
  model: string;
  available: boolean;
  /** Why finality is or is not being produced, in the node's own words. */
  reason: string;
  finalizedHeight: number;
  finalizedHash: string;
  headHeight: number;
  lag: number;
  eligibleProducers: number;
  window: number;
  quorum: number;
  minProducers: number;
  assumptions: string;
}

export interface ParamsInfo {
  protocolVersion: string;
  paramsHash: string;
  blockTargetSeconds: number;
  gasBasisPoints: number;
  maxGasObs: string;
  maxSupplyObs: string;
}

export interface NetworkInfo {
  name: string;
  networkId: string;
  chainId: number;
  addressHrp: string;
  displayName: string;
  isProduction: boolean;
  genesisId: string;
  paramsHash: string;
  coreVersion: string;
  protocolVersion: string;
}

export interface ConnectedPeer {
  address: string;
  nodeId: string;
  height: number;
  inbound: boolean;
  version: string;
}

export interface KnownPeer {
  address: string;
  nodeId: string;
  identity: string;
  height: number;
  version: string;
  lastSeen: number;
  successCount: number;
  failureCount: number;
}

export interface PeersInfo {
  nodeId: string;
  name: string;
  identity: string;
  listening: boolean;
  endpoint: string;
  connected: number;
  inbound: number;
  outbound: number;
  known: number;
  bestPeerHeight: number;
  connectedPeers: ConnectedPeer[];
  knownPeers: KnownPeer[];
}

export interface PotInfo {
  consensus: string;
  height: number;
  protocolTime: number;
  medianTimePast: number;
  cumulativePotWeight: string;
  difficultyBps: number;
  observedSpacingMs: number;
  warmingUp: boolean;
  blocksPerMinute: number;
  transactionsPerMinute: number;
}

/** One registered node as `GET /producers` lists it. The producer address is masked by the node. */
export interface ProducerEntry {
  nodeId: string;
  producer: string;
  tier1: boolean;
  registeredAtHeight: number;
  lastActiveAt: number;
  blocksProduced: number;
  missedSlots: number;
  suspensions: number;
  suspendedUntil: number | null;
  bannedAtHeight: number | null;
}

export interface ProducersInfo {
  tier: string;
  eligible: number;
  registered: number;
  banned: number;
  nodes: ProducerEntry[];
}

/** `GET /nodes/status/:nodeId`: one node's own on-chain record. Null fields mean "none", not "unknown". */
export interface NodeStatusInfo {
  nodeId: string;
  rewardWallet: string;
  registered: boolean;
  bannedAtHeight: number | null;
  deregisteredAtHeight: number | null;
  registeredAtHeight: number;
  lifetimeRewardObs: string;
  pendingWalletChange: { wallet: string; effectivePeriod: number | null } | null;
  pendingReclaim: { effectivePeriod: number } | null;
  currentPeriod: number;
  liveWindows: number;
  expectedWindows: number;
  heartbeats: number;
  faults: number;
}

export interface BlockSummary {
  hash: string;
  height: number;
  timestamp: number;
  txCount: number;
  producer: string;
  size: number;
  prevHash: string;
}

export interface BlockTx {
  id: string;
  type: string;
  sender: string;
  nonce: number;
  gas: string;
}

export interface BlockDetail {
  summary: BlockSummary;
  stateRoot: string;
  txRoot: string;
  producer: string;
  protocolVersion: string;
  confirmations: number;
  transactions: BlockTx[];
}

export interface TxRecord {
  txId: string;
  status: 'PENDING' | 'INCLUDED';
  type: string;
  kind?: string;
  sender: string;
  recipient?: string;
  amount?: string;
  gas: string;
  height?: number;
  blockHash?: string;
  timestamp?: number;
  confirmations?: number;
  memo?: string;
}

/** OBS the protocol credited to an address inside a block with no transaction naming it (treasury share of ONS fees, Node Runner rewards). */
export interface ProtocolCredit {
  kind: string;
  height: number;
  timestamp: number;
  amountObs: string;
  txId?: string;
  reference?: string;
  note?: string;
}

export interface AddressHistory {
  address: string;
  transactions: TxRecord[];
  /** Absent from nodes older than this field. */
  credits: ProtocolCredit[];
}

export interface MempoolInfo {
  size: number;
  bytes: number;
  transactions: Array<{ txId: string; type: string; sender: string; gas: string }>;
}

export interface WalletBalance {
  address: string;
  balanceObs: string;
  balanceSeals: string;
  nonce: number;
  txCount: number;
  atHeight: number;
}

export interface SimulationResult {
  valid: boolean;
  error: string | null;
}

export interface SubmitResult {
  accepted: boolean;
  duplicate: boolean;
  txId: string;
}

export interface VersionInfoRpc {
  coreVersion: string;
  protocolVersion: string;
  wireProtocolVersion: number;
  buildId: string;
}

/**
 * Names of the transaction types, mirroring `TxType` in obsidian-core/src/protocol/types.ts.
 * The indexer reports the numeric value; a test asserts this table equals the core's enum.
 */
export const TX_TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'PAYMENT',
  2: 'ONS',
  6: 'ORACLE',
  7: 'MINING_CLAIM',
  9: 'TREASURY',
  10: 'GOVERNANCE',
  11: 'NODE_REGISTRY',
};
