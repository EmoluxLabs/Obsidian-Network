/**
 * Typed client for the Obsidian Core RPC.
 *
 * This is the only module that talks to the node. It adds no routes of its own: every
 * path below exists in obsidian-core/src/rpc/server.ts (checked against v1.6.1 and a
 * running node). It
 *   - bounds every request with a timeout and a response-size limit,
 *   - classifies failures (unavailable / timeout / http / malformed / too-large) so the UI
 *     can tell "node not running" from "node answered with an error" from "node sent junk",
 *   - validates each response against the shape the app depends on and returns only those
 *     fields, so a malformed answer can never reach the interface as data,
 *   - only ever targets a loopback address.
 */
import type {
  AddressHistory,
  BlockDetail,
  BlockSummary,
  FinalityInfo,
  HealthInfo,
  MempoolInfo,
  NetworkInfo,
  ParamsInfo,
  PeersInfo,
  PotInfo,
  SimulationResult,
  StatusInfo,
  SubmitResult,
  TxRecord,
  ValidatorsInfo,
  VersionInfoRpc,
  WalletBalance,
} from '../shared/chain-types.js';
import { TX_TYPE_NAMES } from '../shared/chain-types.js';
import { arr, bool, int, isRecord, num, obsAmount, optInt, optStr, rec, str, SchemaError, type Json } from './schema.js';

export type RpcFailureKind = 'unavailable' | 'timeout' | 'http' | 'malformed' | 'too-large' | 'refused';

export class RpcError extends Error {
  constructor(
    public readonly kind: RpcFailureKind,
    message: string,
    public readonly status?: number,
    /** The node's own error code (ERR_…), when it sent one. */
    public readonly code?: string,
    public readonly details?: Json,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface RpcClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function assertLoopback(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new RpcError('refused', `invalid RPC URL: ${baseUrl}`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
    throw new RpcError('refused', 'the app only talks to a node on this computer (127.0.0.1)');
  }
  return url;
}

export class RpcClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: RpcClientOptions) {
    assertLoopback(options.baseUrl);
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** Raw request with timeout, size limit and failure classification. */
  async request(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: 'error',
      });
    } catch (error) {
      clearTimeout(timer);
      if ((error as Error).name === 'AbortError') {
        throw new RpcError('timeout', `the node did not answer ${path} within ${Math.round(timeoutMs / 1000)} s`);
      }
      throw new RpcError('unavailable', `could not reach the node at ${this.baseUrl}: ${describeFetchError(error)}`);
    }
    try {
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > this.maxBytes) throw new RpcError('too-large', `${path} answered with ${declared} bytes`);
      const text = await readLimited(response, this.maxBytes, path);
      let json: unknown;
      try {
        json = text.length === 0 ? null : JSON.parse(text);
      } catch {
        throw new RpcError('malformed', `${path} did not answer with JSON`, response.status);
      }
      if (!response.ok) {
        const details = isRecord(json) ? json : undefined;
        const message = details && typeof details.error === 'string' ? details.error : `HTTP ${response.status}`;
        const code = details && typeof details.code === 'string' ? details.code : undefined;
        throw new RpcError('http', message, response.status, code, details);
      }
      return { status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string, parse: (json: unknown) => T): Promise<T> {
    const { json } = await this.request('GET', path);
    return this.parse(path, json, parse);
  }

  private async post<T>(path: string, body: unknown, parse: (json: unknown) => T): Promise<T> {
    const { json } = await this.request('POST', path, body);
    return this.parse(path, json, parse);
  }

  private parse<T>(path: string, json: unknown, parse: (json: unknown) => T): T {
    try {
      return parse(json);
    } catch (error) {
      if (error instanceof SchemaError) throw new RpcError('malformed', `${path} answered with an unexpected shape (${error.message})`);
      throw error;
    }
  }

  health = (): Promise<HealthInfo> => this.get('/health', parseHealth);
  status = (): Promise<StatusInfo> => this.get('/status', parseStatus);
  finality = (): Promise<FinalityInfo> => this.get('/finality', parseFinality);
  params = (): Promise<ParamsInfo> => this.get('/params', parseParams);
  network = (): Promise<NetworkInfo> => this.get('/network', parseNetwork);
  peers = (): Promise<PeersInfo> => this.get('/peers', parsePeers);
  pot = (): Promise<PotInfo> => this.get('/pot', parsePot);
  validators = (): Promise<ValidatorsInfo> => this.get('/validators', parseValidators);
  mempool = (): Promise<MempoolInfo> => this.get('/mempool', parseMempool);
  version = (): Promise<VersionInfoRpc> => this.get('/version', parseVersion);

  /** Newest first. With `from`, ascending from that height. */
  blocks(options: { limit: number; from?: number }): Promise<BlockSummary[]> {
    const q = new URLSearchParams({ limit: String(options.limit) });
    if (options.from !== undefined) q.set('from', String(options.from));
    return this.get(`/blocks?${q}`, (json) => arr(rec(json, 'blocks').blocks, 'blocks.blocks').map((b, i) => parseBlockSummary(b, `blocks[${i}]`)));
  }
  block(idOrHeight: string): Promise<BlockDetail> {
    return this.get(`/block/${encodeURIComponent(idOrHeight)}`, parseBlockDetail);
  }
  tx(txId: string): Promise<TxRecord> {
    return this.get(`/tx/${encodeURIComponent(txId)}`, (json) => parseTxRecord(json, 'tx'));
  }
  addressHistory(address: string, limit = 25): Promise<AddressHistory> {
    return this.get(`/address/${encodeURIComponent(address)}?limit=${limit}`, (json) => {
      const o = rec(json, 'address');
      return {
        address: str(o.address, 'address.address'),
        transactions: arr(o.transactions, 'address.transactions').map((t, i) => parseTxRecord(t, `address.transactions[${i}]`)),
      };
    });
  }
  walletBalance(address: string): Promise<WalletBalance> {
    return this.post('/wallet/balance', { address }, (json) => {
      const o = rec(json, 'balance');
      return {
        address: str(o.address, 'balance.address'),
        balanceObs: obsAmount(o.balanceObs, 'balance.balanceObs'),
        balanceSeals: str(o.balanceSeals, 'balance.balanceSeals', 80),
        nonce: int(o.nonce, 'balance.nonce', 0),
        txCount: int(o.txCount, 'balance.txCount', 0),
        atHeight: int(o.atHeight, 'balance.atHeight', 0),
      };
    });
  }
  /** The nonce the node expects next for this account (GET /wallet/<address>/next-nonce). */
  nextNonce(address: string): Promise<number> {
    return this.get(`/wallet/${encodeURIComponent(address)}/next-nonce`, (json) => int(rec(json, 'nonce').nextNonce, 'nonce.nextNonce', 0));
  }
  simulate(txHex: string): Promise<SimulationResult> {
    return this.post('/tx/simulate', { tx: txHex }, (json) => {
      const o = rec(json, 'simulation');
      return { valid: bool(o.valid, 'simulation.valid'), error: optStr(o.error, 'simulation.error') ?? null };
    });
  }
  submit(txHex: string): Promise<SubmitResult> {
    return this.post('/tx/submit', { tx: txHex }, (json) => {
      const o = rec(json, 'submit');
      return { accepted: bool(o.accepted, 'submit.accepted'), duplicate: o.duplicate === true, txId: str(o.txId, 'submit.txId', 80) };
    });
  }
}

function describeFetchError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  return cause?.code ?? cause?.message ?? (error as Error).message;
}

async function readLimited(response: Response, maxBytes: number, path: string): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new RpcError('too-large', `${path} answered with more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ── response validators ─────────────────────────────────────────────────────

export function parseHealth(json: unknown): HealthInfo {
  const o = rec(json, 'health');
  return {
    status: str(o.status, 'health.status', 32),
    coreVersion: str(o.coreVersion, 'health.coreVersion', 32),
    protocolVersion: str(o.protocolVersion, 'health.protocolVersion', 32),
    network: str(o.network, 'health.network', 32),
    networkId: str(o.networkId, 'health.networkId', 64),
    chainId: int(o.chainId, 'health.chainId', 0),
    genesisId: str(o.genesisId, 'health.genesisId', 80),
    paramsHash: str(o.paramsHash, 'health.paramsHash', 80),
    height: int(o.height, 'health.height', 0),
    headHash: str(o.headHash, 'health.headHash', 80),
    peers: int(o.peers, 'health.peers', 0),
    syncing: bool(o.syncing, 'health.syncing'),
    supplyOk: bool(o.supplyOk, 'health.supplyOk'),
    uptimeSeconds: int(o.uptimeSeconds, 'health.uptimeSeconds', 0),
    timestamp: int(o.timestamp, 'health.timestamp', 0),
  };
}

export function parseStatus(json: unknown): StatusInfo {
  const o = rec(json, 'status');
  const mempool = rec(o.mempool, 'status.mempool');
  return {
    height: int(o.height, 'status.height', 0),
    headHash: str(o.headHash, 'status.headHash', 80),
    genesisHash: str(o.genesisHash, 'status.genesisHash', 80),
    totalBlocks: int(o.totalBlocks, 'status.totalBlocks', 0),
    diskBytes: int(o.diskBytes, 'status.diskBytes', 0),
    mempoolTransactions: int(mempool.transactions, 'status.mempool.transactions', 0),
    mempoolBytes: int(mempool.bytes, 'status.mempool.bytes', 0),
    peers: int(o.peers, 'status.peers', 0),
    syncing: bool(o.syncing, 'status.syncing'),
    supplyObs: obsAmount(o.supplyObs, 'status.supplyObs'),
    maxSupplyObs: obsAmount(o.maxSupplyObs, 'status.maxSupplyObs'),
    validators: int(o.validators, 'status.validators', 0),
    activeMiners: int(o.activeMiners, 'status.activeMiners', 0),
    lastBlockTimestamp: int(o.lastBlockTimestamp, 'status.lastBlockTimestamp', 0),
    finalizedHeight: int(o.finalizedHeight, 'status.finalizedHeight', 0),
    finalizedHash: str(o.finalizedHash, 'status.finalizedHash', 80),
    finalityLag: int(o.finalityLag, 'status.finalityLag', 0),
    finalityValidatorCount: int(o.finalityValidatorCount, 'status.finalityValidatorCount', 0),
    finalityQuorum: int(o.finalityQuorum, 'status.finalityQuorum', 0),
    genesisAllocationClaimed: bool(o.genesisAllocationClaimed, 'status.genesisAllocationClaimed'),
  };
}

export function parseFinality(json: unknown): FinalityInfo {
  const o = rec(json, 'finality');
  return {
    finalizedHeight: int(o.finalizedHeight, 'finality.finalizedHeight', 0),
    finalizedHash: str(o.finalizedHash, 'finality.finalizedHash', 80),
    headHeight: int(o.headHeight, 'finality.headHeight', 0),
    validatorCount: int(o.validatorCount, 'finality.validatorCount', 0),
    quorum: int(o.quorum, 'finality.quorum', 0),
    pendingVotes: int(o.pendingVotes, 'finality.pendingVotes', 0),
    evidenceCount: arr(o.evidence, 'finality.evidence').length,
    bootstrap: bool(o.bootstrap, 'finality.bootstrap'),
    bootstrapConfigured: bool(o.bootstrapConfigured, 'finality.bootstrapConfigured'),
  };
}

export function parseParams(json: unknown): ParamsInfo {
  const o = rec(json, 'params');
  const consensus = rec(o.consensus, 'params.consensus');
  const finality = rec(consensus.finality, 'params.consensus.finality');
  const block = rec(o.block, 'params.block');
  const gas = rec(o.gas, 'params.gas');
  return {
    protocolVersion: str(o.protocolVersion, 'params.protocolVersion', 32),
    paramsHash: str(o.paramsHash, 'params.paramsHash', 80),
    validatorBondObs: obsAmount(consensus.validatorBondObs, 'params.consensus.validatorBondObs'),
    unbondingBlocks: int(consensus.unbondingBlocks, 'params.consensus.unbondingBlocks', 0),
    maxValidators: int(finality.maxValidators, 'params.consensus.finality.maxValidators', 0),
    blockTargetSeconds: int(block.targetSeconds, 'params.block.targetSeconds', 1),
    gasBasisPoints: int(gas.basisPoints, 'params.gas.basisPoints', 0),
    maxGasObs: obsAmount(gas.maxGasObs, 'params.gas.maxGasObs'),
    maxSupplyObs: obsAmount(o.maximumSupplyObs, 'params.maximumSupplyObs'),
  };
}

export function parseNetwork(json: unknown): NetworkInfo {
  const o = rec(json, 'network');
  const net = rec(o.network, 'network.network');
  return {
    name: str(net.name, 'network.network.name', 32),
    networkId: str(net.networkId, 'network.network.networkId', 64),
    chainId: int(net.chainId, 'network.network.chainId', 0),
    addressHrp: str(net.addressHrp, 'network.network.addressHrp', 16),
    displayName: str(net.displayName, 'network.network.displayName', 64),
    isProduction: bool(net.isProduction, 'network.network.isProduction'),
    genesisId: str(o.genesisId, 'network.genesisId', 80),
    paramsHash: str(o.paramsHash, 'network.paramsHash', 80),
    coreVersion: str(o.coreVersion, 'network.coreVersion', 32),
    protocolVersion: str(o.protocolVersion, 'network.protocolVersion', 32),
  };
}

export function parsePeers(json: unknown): PeersInfo {
  const o = rec(json, 'peers');
  const p2p = rec(o.p2p, 'peers.p2p');
  const counts = rec(p2p.peers, 'peers.p2p.peers');
  return {
    nodeId: str(p2p.nodeId, 'peers.p2p.nodeId', 80),
    name: str(p2p.name, 'peers.p2p.name', 128),
    identity: str(p2p.identity, 'peers.p2p.identity', 96),
    listening: bool(p2p.listening, 'peers.p2p.listening'),
    endpoint: str(p2p.endpoint, 'peers.p2p.endpoint', 256),
    connected: int(counts.connected, 'peers.p2p.peers.connected', 0),
    inbound: int(counts.inbound, 'peers.p2p.peers.inbound', 0),
    outbound: int(counts.outbound, 'peers.p2p.peers.outbound', 0),
    known: int(counts.known, 'peers.p2p.peers.known', 0),
    bestPeerHeight: int(counts.height, 'peers.p2p.peers.height', 0),
    connectedPeers: arr(o.connected, 'peers.connected', 1000).map((entry, i) => {
      const e = rec(entry, `peers.connected[${i}]`);
      return {
        address: str(e.address, `peers.connected[${i}].address`, 256),
        nodeId: str(e.nodeId, `peers.connected[${i}].nodeId`, 80),
        height: int(e.height, `peers.connected[${i}].height`, 0),
        inbound: bool(e.inbound, `peers.connected[${i}].inbound`),
        version: str(e.version, `peers.connected[${i}].version`, 32),
      };
    }),
    knownPeers: arr(o.known, 'peers.known', 5000).map((entry, i) => {
      const e = rec(entry, `peers.known[${i}]`);
      return {
        address: str(e.address, `peers.known[${i}].address`, 256),
        nodeId: str(e.nodeId, `peers.known[${i}].nodeId`, 80),
        identity: str(e.identity, `peers.known[${i}].identity`, 96),
        height: int(e.height, `peers.known[${i}].height`, 0),
        version: str(e.version, `peers.known[${i}].version`, 32),
        lastSeen: num(e.lastSeen, `peers.known[${i}].lastSeen`),
        successCount: int(e.successCount, `peers.known[${i}].successCount`, 0),
        failureCount: int(e.failureCount, `peers.known[${i}].failureCount`, 0),
      };
    }),
  };
}

export function parsePot(json: unknown): PotInfo {
  const o = rec(json, 'pot');
  const difficulty = rec(o.difficulty, 'pot.difficulty');
  const rate = rec(o.timeRate, 'pot.timeRate');
  return {
    consensus: str(o.consensus, 'pot.consensus', 64),
    height: int(o.height, 'pot.height', 0),
    protocolTime: int(o.protocolTime, 'pot.protocolTime', 0),
    medianTimePast: int(o.medianTimePast, 'pot.medianTimePast', 0),
    cumulativePotWeight: str(o.cumulativePotWeight, 'pot.cumulativePotWeight', 80),
    difficultyBps: num(difficulty.difficultyBps, 'pot.difficulty.difficultyBps'),
    observedSpacingMs: num(difficulty.observedSpacingMs, 'pot.difficulty.observedSpacingMs'),
    warmingUp: bool(difficulty.warmingUp, 'pot.difficulty.warmingUp'),
    blocksPerMinute: num(rate.blocksPerMinute, 'pot.timeRate.blocksPerMinute'),
    transactionsPerMinute: num(rate.transactionsPerMinute, 'pot.timeRate.transactionsPerMinute'),
  };
}

export function parseValidators(json: unknown): ValidatorsInfo {
  const o = rec(json, 'validators');
  const slashing = rec(o.slashing, 'validators.slashing');
  return {
    activeCount: int(o.count, 'validators.count', 0),
    registered: arr(o.registered, 'validators.registered', 1000).map((entry, i) => {
      const e = rec(entry, `validators.registered[${i}]`);
      return {
        address: str(e.address, `validators.registered[${i}].address`, 96),
        status: str(e.status, `validators.registered[${i}].status`, 32),
        bond: obsAmount(e.bond, `validators.registered[${i}].bond`),
        commissionBps: int(e.commissionBps, `validators.registered[${i}].commissionBps`, 0),
        registeredAtHeight: int(e.registeredAtHeight, `validators.registered[${i}].registeredAtHeight`, 0),
        missedSlots: int(e.missedSlots, `validators.registered[${i}].missedSlots`, 0),
        slashedAtHeight: optInt(e.slashedAtHeight, `validators.registered[${i}].slashedAtHeight`) ?? null,
      };
    }),
    slashBps: int(slashing.slashBps, 'validators.slashing.slashBps', 0),
    slashObs: obsAmount(slashing.slashObs, 'validators.slashing.slashObs'),
    bondObs: obsAmount(slashing.bondObs, 'validators.slashing.bondObs'),
    slashCount: int(slashing.count, 'validators.slashing.count', 0),
  };
}

export function parseMempool(json: unknown): MempoolInfo {
  const o = rec(json, 'mempool');
  return {
    size: int(o.size, 'mempool.size', 0),
    bytes: int(o.bytes, 'mempool.bytes', 0),
    transactions: arr(o.transactions, 'mempool.transactions', 1000).map((entry, i) => {
      const e = rec(entry, `mempool.transactions[${i}]`);
      return {
        txId: str(e.txId, `mempool.transactions[${i}].txId`, 80),
        type: str(e.type, `mempool.transactions[${i}].type`, 32),
        sender: str(e.sender, `mempool.transactions[${i}].sender`, 96),
        gas: str(e.gas, `mempool.transactions[${i}].gas`, 80),
      };
    }),
  };
}

export function parseVersion(json: unknown): VersionInfoRpc {
  const o = rec(json, 'version');
  return {
    coreVersion: str(o.coreVersion, 'version.coreVersion', 32),
    protocolVersion: str(o.protocolVersion, 'version.protocolVersion', 32),
    wireProtocolVersion: int(o.wireProtocolVersion, 'version.wireProtocolVersion', 0),
    buildId: str(o.buildId, 'version.buildId', 64),
  };
}

export function parseBlockSummary(json: unknown, path: string): BlockSummary {
  const o = rec(json, path);
  return {
    hash: str(o.hash, `${path}.hash`, 80),
    height: int(o.height, `${path}.height`, 0),
    timestamp: int(o.timestamp, `${path}.timestamp`, 0),
    txCount: int(o.txCount, `${path}.txCount`, 0),
    producer: str(o.producer, `${path}.producer`, 128),
    size: int(o.size, `${path}.size`, 0),
    prevHash: str(o.prevHash, `${path}.prevHash`, 80),
  };
}

export function parseBlockDetail(json: unknown): BlockDetail {
  const o = rec(json, 'block');
  const header = rec(o.header, 'block.header');
  return {
    summary: parseBlockSummary(o.summary, 'block.summary'),
    stateRoot: str(header.stateRoot, 'block.header.stateRoot', 80),
    txRoot: str(header.txRoot, 'block.header.txRoot', 80),
    producer: str(header.producer, 'block.header.producer', 128),
    protocolVersion: str(header.protocolVersion, 'block.header.protocolVersion', 32),
    confirmations: int(o.confirmations, 'block.confirmations', 0),
    transactions: arr(o.transactions, 'block.transactions', 5000).map((entry, i) => {
      const e = rec(entry, `block.transactions[${i}]`);
      return {
        id: str(e.id, `block.transactions[${i}].id`, 80),
        type: str(e.type, `block.transactions[${i}].type`, 32),
        sender: str(e.sender, `block.transactions[${i}].sender`, 96),
        nonce: int(e.nonce, `block.transactions[${i}].nonce`, 0),
        gas: str(e.gas, `block.transactions[${i}].gas`, 80),
      };
    }),
  };
}

export function parseTxRecord(json: unknown, path: string): TxRecord {
  const o = rec(json, path);
  const pending = o.status === 'PENDING';
  const typeName = typeof o.type === 'number' ? (TX_TYPE_NAMES[o.type] ?? String(o.type)) : str(o.type, `${path}.type`, 32);
  return {
    txId: str(o.txId, `${path}.txId`, 80),
    status: pending ? 'PENDING' : 'INCLUDED',
    type: typeName,
    kind: optStr(o.kind, `${path}.kind`),
    sender: str(o.sender, `${path}.sender`, 96),
    recipient: optStr(o.recipient, `${path}.recipient`),
    amount: optStr(o.amount, `${path}.amount`),
    gas: str(o.gas, `${path}.gas`, 80),
    height: pending ? undefined : int(o.height, `${path}.height`, 0),
    blockHash: pending ? undefined : str(o.blockHash, `${path}.blockHash`, 80),
    timestamp: pending ? undefined : int(o.timestamp, `${path}.timestamp`, 0),
    confirmations: pending ? undefined : int(o.confirmations, `${path}.confirmations`, 0),
    memo: optStr(o.memo, `${path}.memo`),
  };
}
