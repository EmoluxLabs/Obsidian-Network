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
  consensus: { forkChoice: string; minValidatorBondObs: string; unbondingBlocks: number; maxReorgDepth: number };
  ons: { registrationFeeUsd: string; termSeconds: number; graceSeconds: number; minLength: number; maxLength: number };
  capsules: {
    minCommitmentObs: string;
    timeTravelMultiplier: string;
    previewSeconds: number;
    maxContentBytes: number;
  };
  circle: {
    parcelSquareMetres: number;
    appreciationStepBps: number;
    depreciationStepBps: number;
    minGlvObs: string;
    maxGlvObs: string;
  };
  social: {
    creatorShareBps: number;
    networkShareBps: number;
    businessPagePriceUsd: string;
    monetisationMinFollowers: number;
    monetisationMinMonthlyViews: number;
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
  qualifyingPlatformRevenueObs: string;
  split: {
    nodeRunnerPoolObs: string;
    treasuryObs: string;
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
  notPlatformRevenue: Array<{ kind: string; because: string }>;
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
  lockedInCapsules: string;
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

export interface CountrySummary {
  code: string;
  name: string;
  continent: string;
  divisionCount: number;
  /** Whole dollars, e.g. `"20403"` — not micro-USD. */
  glvObs: string;
}

export interface DivisionSummary {
  divisionId: string;
  name: string;
  level: number;
  weight: number;
  baseGlvObs: string;
  glvObs: string;
  protocolPurchases: number;
  protocolBuybacks: number;
  lastUpdatedAtHeight: number | null;
}

export interface LandSearchResult {
  divisionId: string;
  countryCode: string;
  name: string;
  continent: string;
  /** Micro-USD when the registry has an exact value. */
  glvSeals?: string;
  /** Decimal OBS, same source of truth as `glvSeals`. */
  glvObs?: string;
}

export interface LandSearchResponse {
  query: string;
  results: LandSearchResult[];
}

export interface LandParcelSummary {
  parcelId: string;
  divisionId: string;
  countryCode: string;
  squareMetres: number;
  status: string;
  owner: string;
  glvObs: string;
  ilvObs: string | null;
  mspObs: string | null;
  acquiredAtHeight: number;
  issuedAtHeight: number;
}

export interface LandParcelRecord {
  parcelId: string;
  divisionId: string;
  countryCode: string;
  squareMetres: number;
  status: string;
  owner: string;
  glvObs: string;
  ilvObs: string | null;
  glvSealsAtPurchase?: string;
  officialValueUsdMicro?: string;
  divisionGlvObs: string | null;
  mspObs: string | null;
  issuedAtHeight?: number;
  acquiredAtHeight?: number;
  plotIndex?: number;
  level?: string;
  subId?: string;
}

export interface LandQuote {
  divisionId: string;
  /** Node-formatted dollars, e.g. `"$20,403"`. */
  glvObs: string;
  /** Exact OBS decimal string, or null when the oracle is not usable. */
  priceObs: string | null;
  gasObs: string | null;
  oracleUsable: boolean;
  oracleStale: boolean;
  sourceCount: number;
  note: string;
}

export interface CapsuleSummary {
  capsuleId: string;
  owner: string;
  commitmentObs: string;
  teaser: string | null;
  unlockAt: number;
  createdAt: number;
  status: string;
  previewCount: number;
  timeTravelRevenue: string;
  timeTravelPriceObs: string;
  contentBytes: number;
}

export interface CapsuleStats {
  total: number;
  locked: number;
  unlocked: number;
  totalLockedObs: string;
  totalReturnedToPoolObs: string;
  totalTimeTravelRevenueObs: string;
  nearestUnlock: number | null;
  largestCommitmentObs: string;
  mostTimeTravelled: string | null;
  upcomingUnlocks: Array<{ capsuleId: string; unlockAt: number }>;
}

export interface CapsuleRecord extends CapsuleSummary {
  contentCommitment: string;
  createdAtHeight: number;
  unlockedAtHeight: number | null;
  pooledAtUnlockObs: string | null;
  previewSeconds: number;
  contentUnavailable: boolean;
  uri: string;
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

export interface SocialPost {
  postId: string;
  authorAccountId: string;
  author: string;
  content: string;
  parentPostId: string | null;
  createdAt: number;
  createdAtHeight: number;
  likes: number;
}

export interface SocialProfile {
  accountId: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarHash: string | null;
  owner: string;
  followers: number;
  following: number;
  posts: number;
  monthlyViews: number;
  earningsObs: string;
  tier: string;
  businessPage: boolean;
  monetisationEnabled: boolean;
  verificationPending: boolean;
  monetisationThresholds: { followers: number; monthlyViews: number };
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

  landCountries(): Promise<{ countries: CountrySummary[] }> {
    return this.request('/land/countries');
  }

  landDivisions(countryCode: string): Promise<{ country: string; divisions: DivisionSummary[]; count: number; note: string }> {
    return this.request(`/land/divisions?country=${encodeURIComponent(countryCode)}`);
  }

  landSearch(query: string): Promise<LandSearchResponse> {
    return this.request(`/land/search?q=${encodeURIComponent(query)}`);
  }

  landParcels(options: { divisionId?: string; owner?: string; limit?: number } = {}): Promise<{
    parcels: LandParcelSummary[];
    total: number;
    supplyCapNote: string;
  }> {
    const query = new URLSearchParams();
    if (options.divisionId) query.set('divisionId', options.divisionId);
    if (options.owner) query.set('owner', options.owner);
    query.set('limit', String(options.limit ?? 25));
    return this.request(`/land/parcels?${query.toString()}`);
  }

  landParcel(parcelId: string): Promise<LandParcelRecord> {
    return this.request(`/land/parcel/${encodeURIComponent(parcelId)}`);
  }

  landQuote(divisionId: string): Promise<LandQuote> {
    return this.request(`/land/quote/${encodeURIComponent(divisionId)}`);
  }

  capsules(options: { limit?: number; status?: string; owner?: string } = {}): Promise<{
    capsules: CapsuleSummary[];
    stats: CapsuleStats;
  }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 25) });
    if (options.status) query.set('status', options.status);
    if (options.owner) query.set('owner', options.owner);
    return this.request(`/capsules?${query.toString()}`);
  }

  capsule(id: string): Promise<CapsuleRecord> {
    return this.request(`/capsules/${encodeURIComponent(id)}`);
  }

  socialFeed(limit = 25): Promise<{ posts: SocialPost[]; onChain: boolean; note: string }> {
    return this.request(`/social/feed?limit=${limit}`);
  }

  socialProfile(accountId: string): Promise<SocialProfile> {
    return this.request(`/social/profile/${encodeURIComponent(accountId)}`);
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
