/**
 * Browser client for Obsidian nodes.
 *
 * The browser talks to THIS origin only: reads go through `/api/rpc?path=…`,
 * which the interface server maps onto a healthy node, failing over
 * automatically. Direct node access is possible for self-hosters (a node with
 * CORS configured) but is never required and never the default.
 */

export interface NodeSummary {
  url: string;
  healthy: boolean;
  height: number;
  latestBlockHash: string;
  chainId: number;
  networkId: string;
  genesisId: string;
  peers: number;
  latencyMs: number;
}

export interface ChainStatus {
  height: number;
  headHash: string;
  genesisHash: string;
  genesisId: string;
  networkId: string;
  chainId: number;
  protocolVersion: string;
  paramsHash: string;
  totalBlocks: number;
  peers: number;
  syncing: boolean;
  supply: string;
  supplyObs: string;
  maxSupplyObs: string;
  lastBlockTimestamp: number;
  genesis?: {
    allocationClaimed: boolean;
    recipient: string;
    treasuryWallet: string;
    allocationObs: string;
    claimedAtHeight: number | null;
  };
}

export interface MiningStatus {
  address: string;
  eligible: boolean;
  reason?: string;
  protocolTime: number;
  nextEligibleAt: number;
  secondsRemaining: number;
  claimsThisCycle: number;
  claimsRemainingInCycle: number;
  nextClaimSequence: number;
  nextClaimId: string;
  rewardPerClaimObs: string;
  dailyRewardObs?: string;
  activeMiners?: number;
  schedule?: MiningSchedule;
}

/**
 * `/mining/schedule`, exactly as the node sends it.
 *
 * Older builds of the site read `rewardPerDayObs` / `rewardPerClaimObs`, which
 * the node never sent: the schedule amounts are `dailyReward*` and
 * `claimReward*`. Reading a field that does not exist is how a page ends up
 * showing "— OBS" next to a working protocol, so the fields are named here as
 * the node names them and the seal values (exact) are preferred for display.
 */
export interface MiningSchedule {
  activeMiners: number;
  dailyRewardSeals: string;
  dailyRewardObs: string;
  claimRewardSeals: string;
  claimRewardObs: string;
  reductionPercentPerStep: number;
  reductionStepMiners: number;
  floorDailySeals: string;
  floorDailyObs: string;
  claimsPerCycle: number;
  intervalSeconds: number;
  /** Kept optional for any node that still reports the older names. */
  rewardPerDayObs?: string;
  rewardPerClaimObs?: string;
  floorReached?: boolean;
  reductionSteps?: number;
}

export interface BlockSummary {
  height: number;
  hash: string;
  prevHash: string;
  timestamp: number;
  producer: string;
  transactionCount: number;
  sizeBytes: number;
}


/**
 * Every interface below describes a node response exactly as the node sends it.
 *
 * This is not documentation for its own sake: the web pages read these fields
 * by name, and the browser bundle is type-checked against these declarations
 * (`npm run typecheck`). When a field is renamed here or on the node, the build
 * fails instead of the page printing `undefined` at runtime.
 */

export interface OracleState {
  priceUsdMicro: string;
  priceUsd: string;
  updatedAt: number;
  sourceCount: number;
  stale: boolean;
  maxAgeSeconds: number;
  minSources: number;
  usable: boolean;
  sources: Array<{ source: string; priceUsd: string; observedAt: number; submitter: string; height: number }>;
}

export interface ChainParams {
  protocolVersion: string;
  paramsHash: string;
  maximumSupplyObs: string;
  genesisAllocationObs: string;
  legacyGenesisAllocationObs: string;
  mining: {
    claimIntervalSeconds: number;
    maxClaimsPerCycle: number;
    cycleSeconds: number;
    initialDailyRewardObs: string;
    dailyRewardFloorObs: string;
    reductionPercentPerStep: number;
    reductionStepMiners: number;
    activeMinerWindowSeconds: number;
  };
  gas: { basisPoints: number; maxGasObs: string; destination: string };
  block: {
    targetSeconds: number;
    maxBytes: number;
    maxTransactions: number;
    confirmationDepthSoft: number;
    confirmationDepthHard: number;
  };
  consensus: { forkChoice: string; validatorBondObs: string; unbondingBlocks: number; maxReorgDepth: number; finality?: Record<string, unknown> };
  ons: {
    // OBS-denominated since 1.2.0. The node sends `registrationFeeObs` and
    // `renewalFeeObs`; there is no dollar price and no oracle in this path.
    registrationFeeObs: string;
    renewalFeeObs: string;
    termSeconds: number;
    graceSeconds: number;
    minLength: number;
    maxLength: number;
  };
  oracle: { maxAgeSeconds: number; minSources: number; maxDeviationBps: number };
  registry: {
    maxInvitesPerAccount: number;
    newAccountBalanceObs: string;
    wacEnabled: boolean;
    miningKycRequired: boolean;
    nativeExchangeEnabled: boolean;
  };
  paramsHashBytes: number;
}

/** GET /pot — the chain's Proof of Time state, recomputable from /blocks. */
export interface ProofOfTimeState {
  consensus: string;
  shortName: string;
  weightRule: string;
  explanation: string;
  height: number;
  protocolTime: number;
  medianTimePast: number;
  cumulativePotWeight: string;
  difficulty: {
    difficultyBps: number;
    requiredSpacingMs: number;
    observedSpacingMs: number;
    targetSeconds: number;
    windowBlocks: number;
    warmingUp: boolean;
    role: string;
    note: string;
  };
  timeRate: {
    blocksPerMinute: number;
    transactionsPerMinute: number;
    blocks: number;
    transactions: number;
    windowSeconds: number;
    observedSpacingMs: number;
    difficultyBps: number;
    unit: string;
    method: string;
  };
  timeAuthority: {
    authoritative: string;
    neverAuthoritative: string[];
    maxFutureDriftSeconds: number;
    medianTimePastWindow: number;
  };
}

export interface NodeRunnerRecord {
  nodeId: string;
  rewardWallet: string;
  endpoint: string | null;
  registeredAtHeight: number;
  bondObs: string;
  lifetimeRewardObs: string;
  pendingWallet: string | null;
  pendingWalletEffectivePeriod: number | null;
  currentPeriod: {
    period: number;
    heartbeats: number;
    attesters: number;
    blocksProduced: number;
    attestationsMade: number;
    faults: number;
    staleHeartbeats: number;
  };
}

export interface NodeRegistryResponse {
  period: number;
  count: number;
  registeredNodes: number;
  nodes: NodeRunnerRecord[];
  note: string;
}

export interface NodeRewardsResponse {
  split: { nodePoolBps: number; treasuryBps: number; description: string };
  pool: {
    balanceObs: string;
    bondedObs: string;
    lifetimeInflowObs: string;
    lifetimeDistributedObs: string;
    unclaimedTreasuryRevenueObs: string;
    lastSettledPeriod: number;
    currentPeriod: number;
    periodSeconds: number;
    /** Protocol time at which the period closes and the next settlement runs. */
    nextSettlementAt?: number;
  };
  scoring: {
    nodePoolBps: number;
    treasuryBps: number;
    periodSeconds: number;
    minUptimeBps: number;
    minScoreBps: number;
    maxNodeShareBps: number;
    minAttesters: number;
    walletChangeDelayPeriods: number;
    evidenceWindowPeriods: number;
    scoreWeights: { uptimeBps: number; participationBps: number; reliabilityBps: number; responsivenessBps: number };
  };
  settlements: Array<{
    period: number;
    atHeight: number;
    poolObs: string;
    distributedObs: string;
    carriedObs: string;
    eligibleNodes: number;
    scoredNodes: number;
    payouts: Array<{ nodeId: string; rewardWallet: string; amountObs: string; scoreBps: number; shareBps: number }>;
  }>;
}

export interface NodeStatusResponse {
  nodeId: string;
  rewardWallet: string;
  registered: boolean;
  deregisteredAtHeight: number | null;
  registeredAtHeight: number;
  endpoint: string | null;
  bondObs: string;
  lifetimeRewardObs: string;
  pendingWalletChange: { wallet: string; effectivePeriod: number | null } | null;
  currentPeriod: number;
  score: {
    uptimeBps: number;
    participationBps: number;
    reliabilityBps: number;
    responsivenessBps: number;
    scoreBps: number;
    weight: number;
    eligible: boolean;
    reasons: string[];
  };
  evidence: {
    heartbeats: number;
    expectedHeartbeats: number;
    attesters: string[];
    blocksProduced: number;
    attestationsMade: number;
    faults: number;
    faultReporters: string[];
    staleHeartbeats: number;
    lastReportedHeight: number;
  };
  settledRewards: Array<{
    period: number;
    atHeight: number;
    amountObs: string;
    scoreBps: number;
    shareBps: number;
    rewardWallet: string;
  }>;
  note: string;
}

export interface RevenueResponse {
  /** ONS registration and renewal fees only: the protocol's sole revenue source. */
  onsRevenueObs: string;
  split: {
    nodeRunnerPoolObs: string;
    /** The full 10% obligation, credited to the treasury wallet or still owed. */
    treasuryObs: string;
    treasuryCreditedObs: string;
    treasuryUnclaimedObs: string;
    nodePoolBps: number;
    treasuryBps: number;
    sumsBack: boolean;
  };
  bySource: Array<{ source: string; totalObs: string }>;
  accounts: {
    miningPoolObs: string;
    nodeRunnerPoolObs: string;
    nodeBondsObs: string;
    unclaimedTreasuryRevenueObs: string;
    treasuryWallet: string | null;
  };
  /** Where the 10% goes and what it holds. Absent on a node older than this field. */
  treasury?: {
    designated: boolean;
    wallet: string | null;
    lifetimeCreditedObs: string;
    credited: string;
  };
  /** When each share is paid. Absent on a node older than this field. */
  timing?: {
    treasuryShare: { paid: string; bps: number };
    nodeRunnerShare: {
      paid: string;
      bps: number;
      periodSeconds: number;
      currentPeriod: number;
      lastSettledPeriod: number;
      nextSettlementAt: number;
      secondsUntilNextSettlement: number;
      registeredNodes: number;
      poolBalanceObs: string;
      carriedWhenNoNodes: boolean;
      note: string;
    };
  };
  notOnsRevenue: Array<{ kind: string; because: string }>;
  gas: { destination: string; note: string; lifetimeObs: string };
}

export interface SupplyState {
  totalSupplyObs: string;
  totalSupplySeals: string;
  maxSupplyObs: string;
  maximumRespected: boolean;
  invariantOk: boolean;
  genesisIssuedObs: string;
  minedSupplyObs: string;
  validatorBonds: string;
  poolBalanceObs: string;
  issuanceSources: string[];
}

export interface BlockSummary {
  height: number;
  hash: string;
  prevHash: string;
  timestamp: number;
  producer: string;
  /** The node names these `txCount` and `size` (bytes). */
  txCount: number;
  size: number;
}

export interface BlockDetail {
  summary: BlockSummary;
  header: {
    protocolVersion: string;
    chainId: number;
    height: number;
    prevHash: string;
    txRoot: string;
    stateRoot: string;
    paramsHash: string;
    timestamp: number;
    producer: string;
    cumulativePotWeight: string;
    producerSignature: { publicKey: string; signature: string };
  };
  transactions: Array<{ id: string; type: string; sender: string; nonce: number; gas: string; validUntil: number; size: number }>;
  events: Array<{ type: string; height: number; reference?: string; note?: string }>;
  confirmations: number;
  hash: string;
}

export interface TransactionRecord {
  txId: string;
  height?: number;
  blockHash?: string;
  index?: number;
  type: number;
  sender: string;
  recipient?: string;
  /** Exact OBS decimal strings. */
  amount?: string;
  gas: string;
  timestamp?: number;
  memo?: string;
  status: string;
  kind?: string;
  reference?: string;
  note?: string;
  confirmations?: number;
  confirmed?: boolean;
}

export interface NameSummary {
  name: string;
  owner: string;
  address: string;
  expiresAt: number;
  registeredAtHeight: number;
}

export interface NameRecord {
  name: string;
  owner: string;
  address: string;
  registeredAt: number;
  registeredAtHeight: number;
  expiresAt: number;
  transferCount: number;
  resolved: boolean;
}

/**
 * One mining claim as the node indexes it. The chain identifies a claim by its
 * claim id (the replay guard) and its transaction; there is no per-address
 * sequence number on chain, so the UI must not invent one.
 */
export interface MiningClaim {
  txId: string;
  claimId: string;
  height: number;
  miner: string;
  /** Exact OBS decimal string. */
  rewardObs: string;
  /** Seal count, same value as `rewardObs`. */
  reward: string;
  genesisAwarded: boolean;
  timestamp: number;
}

export interface WalletBalance {
  address: string;
  balanceObs: string;
  balanceSeals: string;
  spendableObs: string;
  nonce: number;
  txCount: number;
  receivedObs: string;
  sentObs: string;
  createdAtHeight: number | null;
  mining: { totalClaims: number; totalRewardObs: string; lastClaimAt: number; claimSequence: number } | null;
  names: string[];
  atHeight: number;
  custodial: false;
}

export class ChainError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export class ObsidianClient {
  constructor(private readonly base = '') {}

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}/api/rpc?path=${encodeURIComponent(path)}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      credentials: 'same-origin',
    });
    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { error: text };
    }
    if (!response.ok) {
      const error = (payload as { error?: string }).error ?? `request failed (${response.status})`;
      const code = (payload as { code?: string }).code;
      throw new ChainError(error, response.status, code);
    }
    return payload as T;
  }

  /** Same as `request`, but returns undefined instead of throwing (for optional panels). */
  async requestSafe<T>(path: string): Promise<T | undefined> {
    try {
      return await this.request<T>(path);
    } catch {
      return undefined;
    }
  }

  status(): Promise<ChainStatus> {
    return this.request('/status');
  }

  params(): Promise<ChainParams> {
    return this.request('/params');
  }

  supply(): Promise<SupplyState> {
    return this.request('/supply');
  }

  oracle(): Promise<OracleState> {
    return this.request('/oracle');
  }

  network(): Promise<{ network: { name: string; chainId: number; addressHrp: string; p2pMagic?: string } }> {
    return this.request('/network');
  }

  /**
   * GET /pot. A node that answers with a partial body is treated as not
   * supporting the route: half a PoT state would render as `undefined` in the
   * interface, which is exactly the kind of invented output this project
   * refuses to ship.
   */
  async proofOfTime(): Promise<ProofOfTimeState> {
    const payload = await this.request<Partial<ProofOfTimeState>>('/pot');
    if (
      !payload ||
      typeof payload.consensus !== 'string' ||
      typeof payload.shortName !== 'string' ||
      !payload.difficulty ||
      !payload.timeRate ||
      !payload.timeAuthority
    ) {
      throw new ChainError('this node did not return a Proof of Time state', 502, 'ERR_MALFORMED');
    }
    return payload as ProofOfTimeState;
  }

  nodeRegistry(limit = 100): Promise<NodeRegistryResponse> {
    return this.request(`/nodes/registry?limit=${limit}`);
  }

  nodeRewards(limit = 10): Promise<NodeRewardsResponse> {
    return this.request(`/nodes/rewards?limit=${limit}`);
  }

  nodeStatus(nodeId: string): Promise<NodeStatusResponse> {
    return this.request(`/nodes/status/${encodeURIComponent(nodeId)}`);
  }

  revenue(): Promise<RevenueResponse> {
    return this.request('/revenue');
  }

  miningSchedule(): Promise<MiningSchedule> {
    return this.request('/mining/schedule');
  }

  miningStatus(address: string): Promise<MiningStatus> {
    return this.request(`/mining/status?address=${encodeURIComponent(address)}`);
  }

  miningClaims(address?: string, limit = 25): Promise<{ claims: MiningClaim[]; activeMiners: number }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (address) query.set('address', address);
    return this.request(`/mining/claims?${query.toString()}`);
  }

  blocks(limit = 20): Promise<{ blocks: BlockSummary[] }> {
    return this.request(`/blocks?limit=${limit}`);
  }

  block(idOrHeight: string): Promise<BlockDetail> {
    return this.request(`/block/${encodeURIComponent(idOrHeight)}`);
  }

  transaction(txId: string): Promise<TransactionRecord> {
    return this.request(`/tx/${encodeURIComponent(txId)}`);
  }

  addressHistory(
    address: string,
    limit = 25,
  ): Promise<{
    address: string;
    balancesExposed: false;
    transactions: TransactionRecord[];
    miningClaims: MiningClaim[];
    counts: { transactions: number; miningClaims: number };
    note: string;
  }> {
    return this.request(`/address/${encodeURIComponent(address)}?limit=${limit}`);
  }

  balance(address: string): Promise<WalletBalance> {
    return this.request('/wallet/balance', { method: 'POST', body: JSON.stringify({ address }) });
  }

  quote(address: string): Promise<Record<string, unknown>> {
    return this.request('/wallet/quote', { method: 'POST', body: JSON.stringify({ address }) });
  }

  nextNonce(address: string): Promise<{ nonce: number }> {
    return this.request(`/wallet/${encodeURIComponent(address)}/next-nonce`);
  }

  async submit(signedTx: Uint8Array | string): Promise<{ accepted: boolean; txId: string; [key: string]: unknown }> {
    const tx = typeof signedTx === 'string' ? signedTx : toHex(signedTx);
    return this.request('/tx/submit', { method: 'POST', body: JSON.stringify({ tx }) });
  }

  names(prefix = ''): Promise<{ names: NameSummary[]; count: number }> {
    return this.request(`/names${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`);
  }

  name(name: string): Promise<NameRecord> {
    return this.request(`/names/${encodeURIComponent(name)}`);
  }

  validators(): Promise<Record<string, unknown>> {
    return this.request('/validators');
  }

  /**
   * The interface's own node list (which nodes it is reading from and how far
   * each has synced). A missing or malformed answer is reported as an error with
   * a readable message: an empty node list and a broken one are different states,
   * and the banner must not print a `TypeError` at the user.
   */
  async nodes(): Promise<{ nodes: NodeSummary[]; consensusHeight: number | null; genesisMismatch: boolean }> {
    const response = await fetch(`${this.base}/api/nodes`);
    if (!response.ok) throw new Error(`the interface could not list its nodes (HTTP ${response.status})`);
    const payload = (await response.json().catch(() => undefined)) as
      | { nodes?: NodeSummary[]; consensusHeight?: number | null; genesisMismatch?: boolean }
      | undefined;
    if (!payload || !Array.isArray(payload.nodes)) throw new Error('the interface returned an unexpected node list');
    return {
      nodes: payload.nodes,
      consensusHeight: payload.consensusHeight ?? null,
      genesisMismatch: payload.genesisMismatch === true,
    };
  }

  peers(): Promise<Record<string, unknown>> {
    return this.request('/peers');
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}
