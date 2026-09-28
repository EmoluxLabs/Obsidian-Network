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

export interface MiningSchedule {
  activeMiners: number;
  rewardPerDayObs: string;
  rewardPerClaimObs: string;
  floorReached: boolean;
  reductionSteps: number;
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

  params(): Promise<Record<string, unknown>> {
    return this.request('/params');
  }

  supply(): Promise<Record<string, unknown>> {
    return this.request('/supply');
  }

  oracle(): Promise<{ prices?: unknown; medianPriceUsd?: string; sources?: unknown[] } & Record<string, unknown>> {
    return this.request('/oracle');
  }

  network(): Promise<{ network: { name: string; chainId: number; addressHrp: string; p2pMagic?: string } }> {
    return this.request('/network');
  }

  miningSchedule(): Promise<MiningSchedule> {
    return this.request('/mining/schedule');
  }

  miningStatus(address: string): Promise<MiningStatus> {
    return this.request(`/mining/status?address=${encodeURIComponent(address)}`);
  }

  miningClaims(address?: string, limit = 25): Promise<{ claims: Array<Record<string, unknown>> }> {
    const query = new URLSearchParams({ limit: String(limit) });
    if (address) query.set('address', address);
    return this.request(`/mining/claims?${query.toString()}`);
  }

  blocks(limit = 20): Promise<{ blocks: BlockSummary[] }> {
    return this.request(`/blocks?limit=${limit}`);
  }

  block(idOrHeight: string): Promise<Record<string, unknown>> {
    return this.request(`/block/${encodeURIComponent(idOrHeight)}`);
  }

  transaction(txId: string): Promise<Record<string, unknown>> {
    return this.request(`/tx/${encodeURIComponent(txId)}`);
  }

  addressHistory(address: string, limit = 25): Promise<Record<string, unknown>> {
    return this.request(`/address/${encodeURIComponent(address)}?limit=${limit}`);
  }

  balance(address: string): Promise<{ address: string; balanceObs: string; balanceSeals: string; nonce: number }> {
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

  names(prefix = ''): Promise<{ names: Array<Record<string, unknown>> }> {
    return this.request(`/names${prefix ? `?prefix=${encodeURIComponent(prefix)}` : ''}`);
  }

  name(name: string): Promise<Record<string, unknown>> {
    return this.request(`/names/${encodeURIComponent(name)}`);
  }

  landCountries(): Promise<{ countries: Array<Record<string, unknown>> }> {
    return this.request('/land/countries');
  }

  landSearch(query: string): Promise<Record<string, unknown>> {
    return this.request(`/land/search?q=${encodeURIComponent(query)}`);
  }

  landParcels(options: { divisionId?: string; owner?: string; limit?: number } = {}): Promise<{ parcels: Array<Record<string, unknown>> }> {
    const query = new URLSearchParams();
    if (options.divisionId) query.set('divisionId', options.divisionId);
    if (options.owner) query.set('owner', options.owner);
    query.set('limit', String(options.limit ?? 25));
    return this.request(`/land/parcels?${query.toString()}`);
  }

  landParcel(parcelId: string): Promise<Record<string, unknown>> {
    return this.request(`/land/parcel/${encodeURIComponent(parcelId)}`);
  }

  landQuote(divisionId: string): Promise<Record<string, unknown>> {
    return this.request(`/land/quote/${encodeURIComponent(divisionId)}`);
  }

  capsules(options: { limit?: number; status?: string } = {}): Promise<{ capsules: Array<Record<string, unknown>> }> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 25) });
    if (options.status) query.set('status', options.status);
    return this.request(`/capsules?${query.toString()}`);
  }

  capsule(id: string): Promise<Record<string, unknown>> {
    return this.request(`/capsules/${encodeURIComponent(id)}`);
  }

  socialFeed(limit = 25): Promise<{ posts: Array<Record<string, unknown>>; events?: unknown[] }> {
    return this.request(`/social/feed?limit=${limit}`);
  }

  socialProfile(accountId: string): Promise<Record<string, unknown>> {
    return this.request(`/social/profile/${encodeURIComponent(accountId)}`);
  }

  validators(): Promise<Record<string, unknown>> {
    return this.request('/validators');
  }

  nodes(): Promise<{ nodes: NodeSummary[]; consensusHeight: number | null; genesisMismatch: boolean }> {
    return fetch(`${this.base}/api/nodes`).then((response) => response.json() as Promise<{ nodes: NodeSummary[]; consensusHeight: number | null; genesisMismatch: boolean }>);
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
