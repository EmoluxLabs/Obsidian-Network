/**
 * Obsidian Core RPC / API gateway.
 *
 * Security posture (spec §66):
 *   - read APIs are HTTP GET with strict input validation;
 *   - the single write API (transaction submission) validates the transaction
 *     fully against protocol rules before it reaches the mempool;
 *   - per-IP token-bucket rate limiting, request size caps, no directory
 *     listing, no stack traces in responses;
 *   - CORS is an explicit allowlist (empty by default);
 *   - private keys and recovery phrases never appear in any response or log;
 *   - balances are served only from the wallet API, never from explorer routes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { ChainManager } from '../blockchain/chain.js';
import type { P2PService } from '../networking/p2p.js';
import type { Indexer } from '../indexer/indexer.js';
import { serializeTransaction, maskAddress } from '../indexer/indexer.js';
import { AmountError, formatObs, MAX_SUPPLY_SEALS, parseObs } from '../protocol/amount.js';
import { ProtocolError } from '../protocol/errors.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { slashAmountFor } from '../consensus/slash-evidence.js';
import { evaluateMining } from '../mining/rules.js';
import { scheduleView, dailyRewardForActiveMiners, claimRewardForActiveMiners } from '../mining/schedule.js';
import { decodeSignedTxFromBytes, encodeSignedTx } from '../transactions/encode.js';
import { simulateTransactions } from '../blockchain/state-machine.js';
import { blockHash, summarizeBlock } from '../blockchain/block.js';
import { paramsHashUtf8, PARAMS_HASH } from '../blockchain/state-root.js';
import { genesisDocumentFor } from '../genesis/initialize.js';
import { CORE_VERSION, MIN_CORE_VERSION, PROTOCOL_VERSION, versionInfo } from '../version.js';
import { isValidAddress } from '../crypto/keys.js';
import { encodeOnsBody, decodeOnsBody } from '../transactions/executors/ons.js';
import { encodeMiningBody, decodeMiningBody, computeClaimId } from '../transactions/executors/mining.js';
import { encodePaymentBody, decodePaymentBody, paymentBaseAmount } from '../transactions/executors/payment.js';
import { expectedGas, usdMicroToSeals } from '../transactions/helpers.js';
import { decodeValidatorBody, encodeValidatorBody } from '../transactions/executors/validator.js';
import { decodeTreasuryBody, encodeTreasuryBody } from '../transactions/executors/treasury.js';
import { decodeNodeRegistryBody, encodeNodeRegistryBody } from '../transactions/executors/node-registry.js';
import { decodeSlashBody, encodeSlashBody } from '../transactions/executors/slash.js';
import { medianTimePast, potDifficulty, timeRate } from '../consensus/time.js';
import { nodeRewardParams, rewardPeriodAt, rewardPeriodEnd, scoreNode } from '../economy/node-rewards.js';
import { NOT_ONS_REVENUE } from '../economy/accounting.js';
import { decodeOracleBody, encodeOracleBody } from '../transactions/executors/oracle.js';
import { TxType } from '../protocol/types.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { NodeConfig } from '../config/config.js';
import { OFFICIAL_HOSTS, OFFICIAL_PATTERNS, compileOrigins, originMatches, type NetworkKey } from '../config/trusted-origins.js';

export interface RpcOptions {
  chain: ChainManager;
  p2p?: P2PService;
  indexer: Indexer;
  net: NetworkDefinition;
  config: NodeConfig;
  genesisId: string;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

const MAX_BODY_BYTES = 512 * 1024;

/** Endpoints that take a request body. Every other route is a read and answers GET/HEAD only. */
const POST_ONLY_PATHS: ReadonlySet<string> = new Set([
  '/tx/submit',
  '/tx/simulate',
  '/tx/encode',
  '/tx/gas',
  '/wallet/balance',
  '/wallet/quote',
  '/rpc',
]);

/**
 * How many applied slashes `/validators` returns. The ledger in consensus state
 * grows by one entry per applied slash and is never truncated — that is the
 * audit trail — but an HTTP response must not grow with it, so the endpoint
 * returns the most recent page and reports the exact total separately.
 */
const SLASH_LIST_LIMIT = 64;

export class RpcServer {
  private server?: Server;
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly options: RpcOptions) {}

  async listen(): Promise<number> {
    const { config } = this.options;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    // Bound slowloris/header-drip and idle-socket resource use independently of
    // application rate limits. These limits apply before a route handler sees a
    // request, including clients that never finish sending headers or a body.
    this.server.headersTimeout = 10_000;
    this.server.requestTimeout = 15_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxHeadersCount = 100;
    this.server.maxConnections = 1_024;
    this.server.setTimeout(20_000);
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(config.rpcPort, config.rpcHost, () => {
        const address = this.server!.address();
        const bound = typeof address === 'object' && address ? address.port : config.rpcPort;
        this.options.log('info', 'rpc listening', { host: config.rpcHost, port: bound });
        resolve();
      });
    });
    const address = this.server.address();
    return typeof address === 'object' && address ? address.port : config.rpcPort;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const ip = this.clientIp(request);
    try {
      if (!this.allowRequest(ip)) {
        this.json(response, 429, { error: 'rate limit exceeded', code: 'ERR_RATE_LIMITED' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && !this.isSameOrigin(origin, request) && !this.isOriginAllowed(origin)) {
        this.json(response, 403, { error: 'origin not allowed', code: 'ERR_FORBIDDEN' });
        return;
      }
      this.applyCorsHeaders(response, origin);
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
      await this.route(request, response, url);
    } catch (error) {
      const message = (error as Error).message;
      if (message === 'request body too large') {
        // The rest of the oversized body is never read, so this connection cannot carry another request: say so, or a
        // keep-alive client reuses it and gets a reset on its next call.
        if (!response.headersSent) response.setHeader('Connection', 'close');
        this.json(response, 413, { error: message, code: 'ERR_BODY_TOO_LARGE' });
        return;
      }
      // What the CALLER got wrong is a 400, never a 500: a 500 blames the node
      // for the client's typo and hides real internal failures among them. The
      // status code is part of the API contract clients branch on.
      if (error instanceof URIError) {
        this.respondIfOpen(response, 400, { error: 'malformed percent-encoding in the request path', code: 'ERR_MALFORMED' });
        return;
      }
      if (error instanceof TypeError && /invalid url/i.test(message)) {
        this.respondIfOpen(response, 400, { error: 'malformed request target or Host header', code: 'ERR_MALFORMED' });
        return;
      }
      if (error instanceof AmountError) {
        this.respondIfOpen(response, 400, { error: message, code: 'ERR_MALFORMED' });
        return;
      }
      if (error instanceof ProtocolError) {
        this.respondIfOpen(response, 400, { error: message, code: error.code });
        return;
      }
      this.options.log('error', 'rpc handler failed', { path: request.url, error: message });
      this.respondIfOpen(response, 500, { error: 'internal error', code: 'ERR_INTERNAL' });
    } finally {
      this.options.log('debug', 'rpc request', {
        path: request.url,
        method: request.method,
        status: response.statusCode,
        ms: Date.now() - started,
      });
    }
  }

  private respondIfOpen(response: ServerResponse, status: number, body: unknown): void {
    if (!response.headersSent) this.json(response, status, body);
  }

  /**
   * The address a request should be rate-limited as. Behind a reverse proxy every
   * connection arrives from the proxy, so without this ONE client's burst
   * exhausted the bucket for everybody. With `rpcTrustProxy` the LAST
   * X-Forwarded-For entry is used: it is the address the trusted proxy itself
   * appended, whereas anything earlier in the header is client-supplied.
   */
  private clientIp(request: IncomingMessage): string {
    const socketIp = (request.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/i, '');
    if (!this.options.config.rpcTrustProxy) return socketIp;
    const header = request.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(',').pop()?.trim() ?? '';
    return /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last.replace(/^::ffff:/i, '') : socketIp;
  }

  /** A browser always sends Origin on a POST, even to the site it was loaded from. */
  private isSameOrigin(origin: string, request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host) return false;
    try {
      return new URL(origin).host.toLowerCase() === host.toLowerCase();
    } catch {
      return false;
    }
  }

  // ── Security helpers ──────────────────────────────────────────────────────

  private allowRequest(ip: string): boolean {
    const limit = this.options.config.rpcRateLimitPerMinute;
    if (limit <= 0) return true;
    const now = Date.now();
    const bucket = this.buckets.get(ip) ?? { tokens: limit, updatedAt: now };
    const elapsedMinutes = (now - bucket.updatedAt) / 60_000;
    bucket.tokens = Math.min(limit, bucket.tokens + elapsedMinutes * limit);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      this.buckets.set(ip, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(ip, bucket);
    if (this.buckets.size > 10_000) {
      // Opportunistic cleanup so a scan cannot grow this map without bound.
      for (const [key, value] of this.buckets) {
        if (now - value.updatedAt > 10 * 60_000) this.buckets.delete(key);
      }
    }
    return true;
  }

  /**
   * Whether a browser page on `origin` may read this node: the operator's own list (exact origins and
   * whole-subdomain patterns, or `*` if they said so on purpose), or the project's official domain.
   * Read from the live config on each request, so a change to the list takes effect without a restart
   * of the server object, and a malformed entry can only mean "no match" here (the loader already
   * refused to start with one).
   */
  private isOriginAllowed(origin: string): boolean {
    const { rpcCorsOrigins, rpcTrustOfficialDomains } = this.options.config;
    if (rpcCorsOrigins.includes('*')) return true;
    try {
      if (originMatches(origin, compileOrigins(rpcCorsOrigins))) return true;
    } catch {
      /* an invalid entry matches nothing */
    }
    return rpcTrustOfficialDomains !== false && originMatches(origin, OFFICIAL_PATTERNS);
  }

  private applyCorsHeaders(response: ServerResponse, origin?: string): void {
    if (origin && this.isOriginAllowed(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      response.setHeader('Access-Control-Max-Age', '600');
    }
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    response.end(payload);
  }

  /** Prometheus text exposition format (version 0.0.4). */
  private metricsText(response: ServerResponse, body: string): void {
    response.writeHead(200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    response.end(body);
  }

  private async readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new Error('request body too large');
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  /**
   * Read and parse a JSON request body, answering 400 when the client sent
   * something that is not JSON.
   *
   * Returns `undefined` after having already written the error response, so the
   * caller just returns. Three handlers used to call `JSON.parse` on the raw
   * body inline: a client typo — or an empty body — came back as
   * `500 ERR_INTERNAL`, which blames the node for the caller's syntax error and
   * makes a genuine internal failure indistinguishable from a malformed one.
   * The status code is part of the API contract clients branch on.
   */
  private async jsonBody<T>(request: IncomingMessage, response: ServerResponse): Promise<T | undefined> {
    // The oversize case is deliberately not caught here: the central error
    // handler already maps it to 413 ERR_BODY_TOO_LARGE, and duplicating that
    // mapping here would let the two drift apart.
    const raw = await this.readBody(request);
    try {
      // `JSON.parse` never returns `undefined`, so it is safe as the sentinel.
      const parsed: unknown = JSON.parse(raw);
      // `null`, an array or a bare scalar parses but is not a request object;
      // letting it through would have the handler read a field off `null`.
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.json(response, 400, { error: 'invalid JSON body: expected an object', code: 'ERR_MALFORMED' });
        return undefined;
      }
      return parsed as T;
    } catch {
      this.json(response, 400, { error: 'invalid JSON body', code: 'ERR_MALFORMED' });
      return undefined;
    }
  }

  // ── Router ────────────────────────────────────────────────────────────────

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method ?? 'GET';
    // The verb is part of the API contract. Reads answer GET and HEAD only; the few
    // mutating or body-carrying endpoints answer POST only. Anything else is refused
    // before routing, so a read endpoint never silently accepts PUT/DELETE/PATCH and a
    // write endpoint is never reachable by a verb a cache or proxy treats as safe.
    if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') {
      return this.methodNotAllowed(response, 'GET, HEAD, POST, OPTIONS');
    }
    const postOnly = POST_ONLY_PATHS.has(path);
    if (method === 'POST' && !postOnly) return this.methodNotAllowed(response, 'GET, HEAD, OPTIONS');
    if (method !== 'POST' && postOnly) return this.methodNotAllowed(response, 'POST, OPTIONS');
    // Decode identifiers only after a registered route prefix has matched.
    const after = (prefix: string): string => decodeURIComponent(path.slice(prefix.length));

    if (path === '/' || path === '/health') return this.health(response);
    if (path === '/status') return this.status(response);
    if (path === '/finality') return this.finality(response);
    if (path === '/metrics') return this.metrics(response);
    if (path === '/params') return this.params(response);
    if (path === '/version') return this.json(response, 200, versionInfo());
    if (path === '/genesis') return this.genesis(response);
    if (path === '/supply') return this.supply(response);
    if (path === '/nodes') return this.nodes(response);
    if (path === '/peers') return this.peers(response);
    if (path === '/oracle') return this.oracle(response);
    if (path === '/validators') return this.validators(response);
    if (path === '/blocks') return this.blocks(response, url);
    if (path.startsWith('/block/')) return this.block(response, after('/block/'));
    // Write paths are matched BEFORE the /tx/:id read route on purpose: a
    // prefix match must never shadow a mutating endpoint.
    if (path === '/tx/submit' && method === 'POST') return this.submitTransaction(request, response);
    if (path === '/tx/simulate' && method === 'POST') return this.simulate(request, response);
    if (path === '/tx/encode' && method === 'POST') return this.encodeTx(request, response);
    if (path === '/tx/gas' && method === 'POST') return this.gasQuote(request, response);
    if (path.startsWith('/tx/')) return this.transaction(response, after('/tx/'));
    if (path.startsWith('/address/')) return this.addressHistory(response, after('/address/'), url);
    if (path === '/mempool') return this.mempool(response);
    if (path === '/pot') return this.proofOfTime(response);
    if (path === '/nodes/registry') return this.nodeRegistry(response, url);
    if (path === '/nodes/rewards') return this.nodeRewards(response, url);
    if (path.startsWith('/nodes/status/')) return this.nodeStatus(response, after('/nodes/status/'));
    if (path === '/revenue') return this.revenue(response);
    if (path === '/mining/schedule') return this.miningSchedule(response);
    if (path === '/mining/status') return this.miningStatus(response, url);
    if (path === '/mining/claims') return this.miningClaims(response, url);
    if (path === '/names') return this.names(response, url);
    if (path.startsWith('/names/')) return this.name(response, after('/names/'));
    if (path === '/wallet/balance' && method === 'POST') return this.walletBalance(request, response);
    if (path.startsWith('/wallet/') && path.endsWith('/next-nonce')) {
      return this.walletNonce(response, decodeURIComponent(path.slice(8, -11)));
    }
    if (path === '/wallet/quote' && method === 'POST') return this.walletQuote(request, response);
    if (path === '/network') return this.network(response);
    if (path === '/audit/decentralization') return this.decentralizationAudit(response);
    if (path === '/audit/compliance') return this.complianceAudit(response);
    if (path === '/rpc' && method === 'POST') return this.jsonRpc(request, response);

    this.json(response, 404, { error: 'not found', code: 'ERR_NOT_FOUND', path });
  }

  private methodNotAllowed(response: ServerResponse, allow: string): void {
    response.setHeader('Allow', allow);
    this.json(response, 405, { error: 'method not allowed', code: 'ERR_METHOD_NOT_ALLOWED', allow });
  }

  // ── Read endpoints ────────────────────────────────────────────────────────

  private health(response: ServerResponse): void {
    const status = this.options.chain.status({ peers: this.options.p2p?.peerCount ?? 0 });
    const invariant = this.options.chain.world.verifySupplyInvariant();
    this.json(response, invariant.ok ? 200 : 500, {
      status: invariant.ok ? 'ok' : 'degraded',
      coreVersion: CORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      minCoreVersion: MIN_CORE_VERSION,
      network: this.options.net.name,
      networkId: this.options.net.networkId,
      chainId: this.options.net.chainId,
      genesisId: this.options.genesisId,
      paramsHash: PARAMS_HASH,
      height: status.height,
      headHash: status.headHash,
      peers: status.peers,
      syncing: status.syncing,
      supplyOk: invariant.ok,
      supplyProblem: invariant.ok ? undefined : invariant.reason,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  private status(response: ServerResponse): void {
    const status = this.options.chain.status({ peers: this.options.p2p?.peerCount ?? 0 });
    const state = this.options.chain.world;
    this.json(response, 200, {
      ...status,
      supplyObs: formatObs(BigInt(status.supply)),
      maxSupplyObs: formatObs(MAX_SUPPLY_SEALS),
      supplyPercentUsed: Number((BigInt(status.supply) * 10_000n) / MAX_SUPPLY_SEALS) / 100,
      genesis: {
        allocationClaimed: state.s.genesis.allocationClaimed,
        recipient: state.s.genesis.recipient ? maskAddress(state.s.genesis.recipient) : '',
        treasuryWallet: state.s.genesis.treasuryWallet ? maskAddress(state.s.genesis.treasuryWallet) : '',
        allocationObs: formatObs(state.s.genesis.amount),
        claimedAtHeight: state.s.genesis.claimedAtHeight ?? null,
      },
      mining: scheduleView(state.s.metrics.activeMiners),
      metrics: {
        accounts: state.s.metrics.totalAccounts,
        transactions: state.s.metrics.totalTransactions,
        miningClaims: state.s.metrics.totalMiningClaims,
        names: state.s.metrics.totalNamesRegistered,
        treasuryRevenue: formatObs(state.s.metrics.totalTreasuryRevenue),
      },
      pool: {
        balance: formatObs(state.s.pool.balance),
        lifetimeInflow: formatObs(state.s.pool.lifetimeInflow),
        lifetimeDistributed: formatObs(state.s.pool.lifetimeDistributed),
        settledClaims: state.s.pool.settledClaims,
      },
      indexer: this.options.indexer.summary(),
      p2p: this.options.p2p?.status(),
    });
  }

  private finality(response:ServerResponse):void { this.json(response,200,{...this.options.chain.finalityStatus(),certificate:this.options.chain.latestFinalityCertificate(),evidence:this.options.chain.equivocationEvidence()}); }

  /**
   * GET /metrics — Prometheus text exposition.
   *
   * Operators had no way to alert on a node falling behind, losing peers or
   * stalling its mempool without scraping and parsing `/status` themselves.
   * This exposes the same numbers the node already publishes, in the format
   * every monitoring stack reads.
   *
   * It deliberately exposes no address, no balance and no identity: a metrics
   * port is the one most likely to be left open to a whole network, so it
   * carries only aggregates that `/status` and `/supply` already make public.
   * Supply figures are emitted in OBS as floating point, which is the only
   * type Prometheus has; the authoritative integer seal amounts stay on
   * `/supply`, and nothing in consensus ever reads this route.
   */
  private metrics(response: ServerResponse): void {
    const status = this.options.chain.status({ peers: this.options.p2p?.peerCount ?? 0 });
    const state = this.options.chain.world;
    const net = this.options.net;
    const labels = `network="${net.name}",chain_id="${net.chainId}"`;
    const lines: string[] = [];
    const metric = (name: string, type: 'gauge' | 'counter', help: string, value: number | bigint): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name}{${labels}} ${value}`);
    };
    // Seals are 18-decimal integers; Prometheus only has float64, so publish
    // OBS and keep the exact integers on /supply.
    const obs = (seals: bigint): number => Number(formatObs(seals));

    metric('obsidian_chain_height', 'gauge', 'Height of the node\'s current head block.', status.height);
    metric('obsidian_finalized_height','gauge','Latest locally verified PoT finality checkpoint.',status.finalizedHeight);
    metric('obsidian_finality_lag_blocks','gauge','Canonical blocks after the finalized checkpoint.',status.finalityLag);
    metric('obsidian_finality_validators','gauge','Eligible validators in the current finality committee.',status.finalityValidatorCount);
    metric('obsidian_peers', 'gauge', 'Connected p2p peers.', this.options.p2p?.peerCount ?? 0);
    metric('obsidian_mempool_transactions', 'gauge', 'Transactions waiting in the mempool.', this.options.chain.mempool.size);
    metric('obsidian_supply_obs', 'gauge', 'Total OBS in existence.', obs(BigInt(status.supply)));
    metric('obsidian_max_supply_obs', 'gauge', 'Protocol maximum supply in OBS.', obs(MAX_SUPPLY_SEALS));
    metric('obsidian_pool_balance_obs', 'gauge', 'OBS held by the Mining Pool.', obs(state.s.pool.balance));
    metric('obsidian_active_miners', 'gauge', 'Miners active in the current cycle.', state.s.metrics.activeMiners);
    metric('obsidian_accounts_total', 'gauge', 'Accounts known to the chain state.', state.s.metrics.totalAccounts);
    metric('obsidian_transactions_total', 'counter', 'Transactions applied since genesis.', state.s.metrics.totalTransactions);
    metric('obsidian_mining_claims_total', 'counter', 'Mining claims applied since genesis.', state.s.metrics.totalMiningClaims);
    metric('obsidian_names_total', 'gauge', 'Registered .obs names.', state.s.metrics.totalNamesRegistered);
    metric('obsidian_validators', 'gauge', 'Registered validators.', state.s.validators.size);
    metric('obsidian_genesis_allocation_claimed', 'gauge', 'One if the genesis allocation has been claimed.', state.s.genesis.allocationClaimed ? 1 : 0);
    metric('obsidian_supply_invariant_ok', 'gauge', 'One while total supply is within the protocol maximum.', BigInt(status.supply) <= MAX_SUPPLY_SEALS ? 1 : 0);
    metric('obsidian_syncing', 'gauge', 'One while the node believes it is behind its peers.', status.syncing ? 1 : 0);
    metric('obsidian_uptime_seconds', 'gauge', 'Seconds since this process started.', Math.floor(process.uptime()));

    this.metricsText(response, `${lines.join('\n')}\n`);
  }

  private params(response: ServerResponse): void {
    this.json(response, 200, {
      protocolVersion: PROTOCOL_VERSION,
      paramsHash: PARAMS_HASH,
      maximumSupplyObs: formatObs(MAX_SUPPLY_SEALS),
      genesisAllocationObs: formatObs(CONSENSUS_PARAMS.genesisAllocation),
      legacyGenesisAllocationObs: formatObs(CONSENSUS_PARAMS.legacyGenesisAllocationRemoved),
      mining: {
        claimIntervalSeconds: CONSENSUS_PARAMS.mining.claimIntervalSeconds,
        maxClaimsPerCycle: CONSENSUS_PARAMS.mining.maxClaimsPerCycle,
        cycleSeconds: CONSENSUS_PARAMS.mining.cycleSeconds,
        initialDailyRewardObs: formatObs(CONSENSUS_PARAMS.mining.initialDailyReward),
        dailyRewardFloorObs: formatObs(CONSENSUS_PARAMS.mining.dailyRewardFloor),
        reductionPercentPerStep: CONSENSUS_PARAMS.mining.reductionBasisPointsPerStep / 100,
        reductionStepMiners: CONSENSUS_PARAMS.mining.reductionStepMiners,
        activeMinerWindowSeconds: CONSENSUS_PARAMS.mining.activeMinerWindowSeconds,
      },
      gas: {
        basisPoints: CONSENSUS_PARAMS.gas.basisPoints,
        maxGasObs: formatObs(CONSENSUS_PARAMS.gas.maxGas),
        destination: CONSENSUS_PARAMS.gas.destination,
      },
      block: {
        targetSeconds: CONSENSUS_PARAMS.block.targetBlockSeconds,
        maxBytes: CONSENSUS_PARAMS.block.maxBlockBytes,
        maxTransactions: CONSENSUS_PARAMS.block.maxBlockTransactions,
        confirmationDepthSoft: CONSENSUS_PARAMS.block.confirmationDepthSoft,
        confirmationDepthHard: CONSENSUS_PARAMS.block.confirmationDepthHard,
      },
      proofOfTime: {
        consensus: CONSENSUS_PARAMS.proofOfTime.consensus,
        shortName: CONSENSUS_PARAMS.proofOfTime.shortName,
        weightRule: CONSENSUS_PARAMS.proofOfTime.weightRule,
        difficultyTargetSeconds: CONSENSUS_PARAMS.proofOfTime.difficultyTargetSeconds,
        difficultyWindowBlocks: CONSENSUS_PARAMS.proofOfTime.difficultyWindowBlocks,
        timeRateWindowSeconds: CONSENSUS_PARAMS.proofOfTime.timeRateWindowSeconds,
        timeRateUnit: CONSENSUS_PARAMS.proofOfTime.timeRateUnit,
      },
      nodeRewards: nodeRewardParams(),
      consensus: {
        forkChoice: CONSENSUS_PARAMS.consensus.forkChoice,
        validatorBondObs: formatObs(CONSENSUS_PARAMS.consensus.validatorBond),
        unbondingBlocks: CONSENSUS_PARAMS.consensus.unbondingBlocks,
        maxReorgDepth: CONSENSUS_PARAMS.consensus.maxReorgDepth,
        finality: CONSENSUS_PARAMS.consensus.finality,
      },
      ons: {
        registrationFeeObs: formatObs(CONSENSUS_PARAMS.ons.registrationFee),
        renewalFeeObs: formatObs(CONSENSUS_PARAMS.ons.renewalFee),
        termSeconds: CONSENSUS_PARAMS.ons.termSeconds,
        graceSeconds: CONSENSUS_PARAMS.ons.graceSeconds,
        minLength: CONSENSUS_PARAMS.ons.minLength,
        maxLength: CONSENSUS_PARAMS.ons.maxLength,
      },
      oracle: {
        maxAgeSeconds: CONSENSUS_PARAMS.oracle.maxAgeSeconds,
        minSources: CONSENSUS_PARAMS.oracle.minSources,
        maxDeviationBps: CONSENSUS_PARAMS.oracle.maxDeviationBps,
      },
      registry: {
        maxInvitesPerAccount: CONSENSUS_PARAMS.registry.maxInvitesPerAccount,
        newAccountBalanceObs: formatObs(CONSENSUS_PARAMS.registry.newAccountBalance),
        wacEnabled: CONSENSUS_PARAMS.registry.wacEnabled,
        miningKycRequired: CONSENSUS_PARAMS.registry.miningKycRequired,
        nativeExchangeEnabled: CONSENSUS_PARAMS.registry.nativeExchangeEnabled,
      },
      paramsHashBytes: paramsHashUtf8().length,
    });
  }

  private genesis(response: ServerResponse): void {
    const document = genesisDocumentFor(this.options.net, this.options.config.bootstrapValidatorPublicKeys);
    const genesisBlock = this.options.chain.getBlockByHeight(0);
    this.json(response, 200, {
      document,
      genesisId: this.options.genesisId,
      genesisHash: genesisBlock ? blockHash(genesisBlock.header) : '',
      chainId: this.options.net.chainId,
      networkId: this.options.net.networkId,
      state: this.options.chain.genesisState(),
      note: 'The genesis block contains no premine. 100,000 OBS is reserved for the first protocol-valid mining claim.',
    });
  }

  private supply(response: ServerResponse): void {
    const state = this.options.chain.world;
    const invariant = state.verifySupplyInvariant();
    this.json(response, 200, {
      totalSupplyObs: formatObs(state.s.metrics.totalSupply),
      totalSupplySeals: state.s.metrics.totalSupply.toString(),
      maxSupplyObs: formatObs(MAX_SUPPLY_SEALS),
      maximumRespected: state.s.metrics.totalSupply <= MAX_SUPPLY_SEALS,
      invariantOk: invariant.ok,
      invariantProblem: invariant.ok ? undefined : invariant.reason,
      genesisIssuedObs: formatObs(state.s.metrics.issuedGenesis),
      minedSupplyObs: formatObs(state.s.metrics.minedSupply),
      validatorBonds: formatObs(
        [...state.s.accounts.values()].reduce((sum, account) => sum + (account.validator?.bond ?? 0n), 0n),
      ),
      poolBalanceObs: formatObs(state.s.pool.balance),
      issuanceSources: ['GENESIS_ALLOCATION', 'MINING_REWARD'],
    });
  }

  private nodes(response: ServerResponse): void {
    const announcement = this.options.p2p?.announcement(
      this.options.config.rpcPublicUrl || undefined,
      this.options.config.publicHost ? `ws://${this.options.config.publicHost}:${this.options.config.p2pPort}` : undefined,
    );
    const peers = this.options.p2p?.knownPeers() ?? [];
    this.json(response, 200, {
      self: announcement ?? null,
      peers: peers.filter((peer) => peer.nodeId).map((peer) => ({
        address: peer.address,
        nodeId: peer.nodeId,
        height: peer.height ?? null,
        lastSeen: peer.lastSeen,
        score: peer.score,
      })),
      discovery: {
        protocol: 'p2p-v1',
        note: 'Peer addresses are hints only. Interfaces must verify each node by handshake and query.',
      },
    });
  }

  private peers(response: ServerResponse): void {
    this.json(response, 200, {
      p2p: this.options.p2p?.status(),
      connected: this.options.p2p?.activeConnections() ?? [],
      known: this.options.p2p?.knownPeers() ?? [],
    });
  }

  private oracle(response: ServerResponse): void {
    const oracle = this.options.chain.world.s.oracle;
    this.json(response, 200, {
      priceUsdMicro: oracle.medianPriceUsdMicro.toString(),
      priceUsd: formatUsd(oracle.medianPriceUsdMicro),
      updatedAt: oracle.medianUpdatedAt,
      sourceCount: oracle.sourceCount,
      stale: oracle.stale,
      maxAgeSeconds: CONSENSUS_PARAMS.oracle.maxAgeSeconds,
      minSources: CONSENSUS_PARAMS.oracle.minSources,
      usable: !oracle.stale && oracle.medianPriceUsdMicro > 0n,
      sources: Object.values(oracle.observations).map((observation) => ({
        source: observation.source,
        priceUsd: formatUsd(observation.priceUsdMicro),
        observedAt: observation.observedAt,
        submitter: maskAddress(observation.submitter),
        height: observation.height,
      })),
    });
  }

  private validators(response: ServerResponse): void {
    const state = this.options.chain.world;
    // The ledger itself is consensus state and grows one entry per applied
    // slash; the *response* must not. A reader gets the most recent page plus
    // the exact total, so the size of an HTTP answer is bounded by the server and
    // not by how many validators the chain has punished over its lifetime.
    const slashes = [...state.s.slashes.values()].sort((a, b) => (a.slashedAtHeight - b.slashedAtHeight || (a.evidenceId < b.evidenceId ? -1 : 1)));
    const slashPage = slashes.slice(-SLASH_LIST_LIMIT);
    this.json(response, 200, {
      count: state.activeValidators().length,
      registered: [...state.s.validators].sort().map((address) => {
        const validator = state.getAccount(address)?.validator;
        return {
          address: maskAddress(address),
          status: validator?.status ?? 'UNKNOWN',
          bond: formatObs(validator?.bond ?? 0n),
          commissionBps: validator?.commissionBps ?? 0,
          registeredAtHeight: validator?.registeredAtHeight ?? 0,
          missedSlots: validator?.missedSlots ?? 0,
          slashedAtHeight: validator?.slashedAtHeight ?? null,
        };
      }),
      rotation: 'proposer(height, round) = activeValidators[(height + round) mod count]',
      round: 'round = max(0, floor((block.timestamp - parent.timestamp) / targetBlockSeconds) - 1)',
      liveness:
        'a validator that misses its slot costs the network one slot while the turn passes to the next ' +
        'active validator; rounds cycle inside the registered set and never open to an unbonded key',
      slashing: {
        rule:
          'a validator is slashed only for objectively provable equivocation: two conflicting signed block ' +
          'proposals for one height and round, or two conflicting finality votes for one anchor. Being ' +
          'offline, missing a slot or failing to vote is never slashable — that is the missed-slot jail.',
        slashBps: CONSENSUS_PARAMS.consensus.equivocationSlashBps,
        slashObs: formatObs(slashAmountFor(CONSENSUS_PARAMS.consensus.validatorBond)),
        bondObs: formatObs(CONSENSUS_PARAMS.consensus.validatorBond),
        destination: 'MINING_POOL',
        treasuryShareObs: '0',
        evidenceRequired: 'signatures by the validator’s own registered key, verified by every node',
        submitter: 'any account may submit a SLASH transaction; the evidence, the bond and the ratio decide the amount',
        count: slashes.length,
        shown: slashPage.length,
      },
      appliedSlashes: slashPage.map((record) => ({
        evidenceId: record.evidenceId,
        evidenceType: record.type,
        validator: maskAddress(record.validator),
        equivocationHeight: record.height,
        round: record.round,
        bondBeforeObs: formatObs(record.bondBefore),
        slashedObs: formatObs(record.amount),
        remainingBondObs: formatObs(record.bondAfter),
        destination: 'MINING_POOL',
        appliedAtHeight: record.slashedAtHeight,
      })),
    });
  }

  private blocks(response: ServerResponse, url: URL): void {
    const limit = clampInt(url.searchParams.get('limit'), 10, 1, 100);
    const from = url.searchParams.get('from');
    if (from !== null) {
      const height = clampInt(from, 0, 0, Number.MAX_SAFE_INTEGER);
      const entries = this.options.chain.store.canonicalRange(height, limit);
      this.json(response, 200, {
        blocks: entries.map((entry) => ({
          hash: entry.hash,
          height: entry.height,
          prevHash: entry.prevHash,
          timestamp: entry.timestamp,
          txCount: entry.txCount,
          producer: maskAddress(entry.producer),
          size: entry.size,
        })),
      });
      return;
    }
    this.json(response, 200, {
      blocks: this.options.chain.recentBlocks(limit).map((summary) => ({
        ...summary,
        producer: maskAddress(summary.producer),
      })),
    });
  }

  private block(response: ServerResponse, idOrHeight: string): void {
    const block = /^\d+$/.test(idOrHeight)
      ? this.options.chain.getBlockByHeight(Number.parseInt(idOrHeight, 10))
      : this.options.chain.getBlockByHash(idOrHeight.toLowerCase());
    if (!block) {
      this.json(response, 404, { error: 'block not found', code: 'ERR_NOT_FOUND' });
      return;
    }
    const hash = blockHash(block.header);
    const events = this.options.indexer.events(200).filter((event) => event.height === block.header.height);
    this.json(response, 200, {
      summary: summarizeBlock(block, 0),
      header: {
        ...block.header,
        cumulativePotWeight: block.header.cumulativePotWeight.toString(),
        producer: block.header.producer,
        producerSignature: {
          publicKey: block.header.producerSignature.publicKey,
          signature: block.header.producerSignature.signature,
        },
      },
      transactions: block.transactions.map((tx) => ({
        id: tx.id,
        type: TxType[tx.type] ?? String(tx.type),
        sender: tx.sender,
        nonce: tx.nonce,
        gas: tx.gas.toString(),
        validUntil: tx.validUntil,
        size: encodeSignedTx(tx).length,
      })),
      events,
      confirmations: Math.max(0, this.options.chain.height - block.header.height + 1),
      hash,
    });
  }

  private transaction(response: ServerResponse, txId: string): void {
    if (!/^[0-9a-f]{64}$/i.test(txId)) {
      // Transaction ids are 32-byte domain-separated SHA-256 digests, never
      // wallet addresses: the shapes must not be interchanged.
      this.json(response, 400, { error: 'invalid transaction id', code: 'ERR_MALFORMED' });
      return;
    }
    const record = this.options.indexer.getTransaction(txId.toLowerCase());
    if (!record) {
      const pending = this.options.chain.mempool.get(txId.toLowerCase());
      if (pending) {
        this.json(response, 200, {
          status: 'PENDING',
          txId,
          type: TxType[pending.tx.type] ?? String(pending.tx.type),
          sender: maskAddress(pending.tx.sender),
          gas: pending.tx.gas.toString(),
        });
        return;
      }
      this.json(response, 404, { error: 'transaction not found', code: 'ERR_NOT_FOUND' });
      return;
    }
    this.json(response, 200, {
      ...serializeTransaction(record),
      confirmations: Math.max(0, this.options.chain.height - record.height + 1),
      confirmed: true,
    });
  }

  /**
   * Public address history. Counterparties are masked (spec §32) and no balance
   * is ever exposed here — balances are only available through /wallet/balance,
   * which the wallet calls for the user's own account.
   */
  private addressHistory(response: ServerResponse, address: string, url: URL): void {
    if (!address) {
      this.json(response, 400, { error: 'an address is required', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    if (!isValidAddress(address, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'not a valid address for this network', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 25) || 25, 100);
    const history = this.options.indexer.addressHistory(address, limit);
    // Explorer output is public: claim records must be masked exactly like
    // `/mining/claims` does, otherwise the query echo the caller already knows
    // would be the only masked field while `miner` leaked the full address.
    const claims = this.options.indexer.miningClaims(limit, address).map((claim) => ({
      ...claim,
      miner: maskAddress(claim.miner),
      rewardObs: formatObs(BigInt(claim.reward)),
    }));
    this.json(response, 200, {
      address: maskAddress(address),
      maskNote: 'Public explorer output: counterparties and this address are partially masked. Balances are never exposed.',
      transactions: history,
      miningClaims: claims,
      counts: { transactions: history.length, miningClaims: claims.length },
    });
  }

  private mempool(response: ServerResponse): void {
    this.json(response, 200, {
      size: this.options.chain.mempool.size,
      bytes: this.options.chain.mempool.byteSize,
      transactions: this.options.chain.mempool.snapshot().slice(0, 100).map((entry) => ({
        txId: entry.txId,
        type: TxType[entry.type] ?? String(entry.type),
        sender: maskAddress(entry.sender),
        gas: entry.gas,
      })),
    });
  }

  /**
   * GET /pot — the Proof of Time state of this chain.
   *
   * Everything here is derived from blocks this node holds, so a client can
   * recompute it from /blocks and disagree if the node lies.
   */
  private proofOfTime(response: ServerResponse): void {
    const chain = this.options.chain;
    const head = chain.store.head;
    const ancestors = head
      ? chain.store.ancestorBlocks(head.hash, CONSENSUS_PARAMS.proofOfTime.difficultyWindowBlocks)
      : [];
    const difficulty = potDifficulty(ancestors, head?.height ?? 0);
    const rate = timeRate(ancestors);
    this.json(response, 200, {
      consensus: CONSENSUS_PARAMS.proofOfTime.consensus,
      shortName: CONSENSUS_PARAMS.proofOfTime.shortName,
      weightRule: CONSENSUS_PARAMS.proofOfTime.weightRule,
      explanation:
        'Obsidian is a Proof of Time chain: block production is scheduled by the validator rotation and gated by protocol time, ' +
        'not by a computational race. Hashing secures identity and integrity; it is not the consensus competition.',
      height: head?.height ?? 0,
      protocolTime: chain.protocolTime,
      medianTimePast: medianTimePast(ancestors),
      cumulativePotWeight: (head?.cumulativePotWeight ?? '0').toString(),
      difficulty: {
        difficultyBps: difficulty.difficultyBps,
        requiredSpacingMs: difficulty.requiredSpacingMs,
        observedSpacingMs: difficulty.observedSpacingMs,
        targetSeconds: CONSENSUS_PARAMS.proofOfTime.difficultyTargetSeconds,
        windowBlocks: difficulty.windowBlocks,
        warmingUp: difficulty.warmingUp,
        role: 'MEASUREMENT',
        note: 'PoT Difficulty reports how block spacing tracks the protocol target. Block acceptance is gated by median time past, strict monotonicity and the future-drift bound.',
      },
      timeRate: rate,
      timeAuthority: {
        authoritative: 'PROTOCOL_TIME_FROM_CHAIN',
        neverAuthoritative: ['BROWSER_CLOCK', 'DEVICE_CLOCK', 'WEBSITE_SERVER', 'CLOUDFLARE', 'DATABASE_INSERT_ORDER'],
        maxFutureDriftSeconds: CONSENSUS_PARAMS.block.maxFutureDriftSeconds,
        medianTimePastWindow: CONSENSUS_PARAMS.block.medianTimePastWindow,
      },
    });
  }

  /**
   * GET /nodes/registry — registered node runners and their verified evidence.
   * No wallet balances are exposed; the reward wallet is public because the
   * payout itself is public chain data.
   */
  private nodeRegistry(response: ServerResponse, url: URL): void {
    const state = this.options.chain.world;
    const period = rewardPeriodAt(this.options.chain.protocolTime);
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '100') || 100));
    const nodes = state.registeredNodes().slice(0, limit).map((node) => {
      const evidence = state.s.nodeEvidence.get(`${period}:${node.nodeId}`);
      return {
        nodeId: node.nodeId,
        rewardWallet: node.rewardWallet,
        endpoint: node.endpoint || null,
        registeredAtHeight: node.registeredAtHeight,
        lifetimeRewardObs: formatObs(node.lifetimeReward),
        pendingWallet: node.pendingWallet ?? null,
        pendingWalletEffectivePeriod: node.pendingWalletEffectivePeriod ?? null,
        currentPeriod: {
          period,
          heartbeats: evidence?.heartbeats ?? 0,
          attesters: evidence?.attesters.length ?? 0,
          blocksProduced: evidence?.blocksProduced ?? 0,
          attestationsMade: evidence?.attested.length ?? 0,
          faults: evidence?.faults ?? 0,
          staleHeartbeats: evidence?.staleHeartbeats ?? 0,
        },
      };
    });
    this.json(response, 200, {
      period,
      count: nodes.length,
      registeredNodes: state.s.metrics.registeredNodes,
      nodes,
      note: 'every field is recomputed from chain state; nodes cannot self-report uptime, participation or efficiency',
    });
  }

  /** GET /nodes/rewards — the ONS-funded pool, the split and settled periods. */
  private nodeRewards(response: ServerResponse, url: URL): void {
    const state = this.options.chain.world;
    const pool = state.s.nodeRewards;
    const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit') ?? '10') || 10));
    const settlements = pool.recentSettlements.slice(-limit).reverse();
    this.json(response, 200, {
      split: {
        nodePoolBps: CONSENSUS_PARAMS.nodeRewards.nodePoolShareBps,
        treasuryBps: CONSENSUS_PARAMS.nodeRewards.treasuryShareBps,
        description: 'ONS fees are split exactly 90% to the Node Runner Reward Pool and 10% to the protocol treasury wallet',
      },
      pool: {
        balanceObs: formatObs(pool.balance),
        lifetimeInflowObs: formatObs(pool.lifetimeInflow),
        lifetimeDistributedObs: formatObs(pool.lifetimeDistributed),
        unclaimedTreasuryRevenueObs: formatObs(pool.unclaimedRevenue),
        lastSettledPeriod: pool.lastSettledPeriod,
        currentPeriod: rewardPeriodAt(this.options.chain.protocolTime),
        periodSeconds: CONSENSUS_PARAMS.nodeRewards.periodSeconds,
        nextSettlementAt: rewardPeriodEnd(rewardPeriodAt(this.options.chain.protocolTime)),
      },
      scoring: nodeRewardParams(),
      settlements: settlements.map((settlement) => ({
        period: settlement.period,
        atHeight: settlement.atHeight,
        poolObs: formatObs(settlement.poolSeals),
        distributedObs: formatObs(settlement.distributedSeals),
        carriedObs: formatObs(settlement.carriedSeals),
        eligibleNodes: settlement.eligibleNodes,
        scoredNodes: settlement.scoredNodes,
        payouts: settlement.payouts.map((payout) => ({
          nodeId: payout.nodeId,
          rewardWallet: payout.rewardWallet,
          amountObs: formatObs(payout.amount),
          scoreBps: payout.scoreBps,
          shareBps: payout.shareBps,
        })),
      })),
    });
  }

  /** GET /nodes/status/:nodeId — one operator's own view, all of it verified. */
  private nodeStatus(response: ServerResponse, nodeId: string): void {
    const state = this.options.chain.world;
    const node = state.node(nodeId);
    if (!node) {
      this.json(response, 404, { error: 'node is not registered', code: 'ERR_NODE_NOT_REGISTERED', nodeId });
      return;
    }
    const period = rewardPeriodAt(this.options.chain.protocolTime);
    const nodes = state.registeredNodes();
    const evidence = state.s.nodeEvidence.get(`${period}:${nodeId}`);
    const peerUniverse = nodes.length;
    const heartbeats = evidence?.heartbeats ?? 0;
    const score = scoreNode({
      liveness: {
        registered: node.deregisteredAtHeight === undefined,
        heartbeats,
        distinctAttesters: evidence?.attesters.length ?? 0,
        peerUniverse,
      },
      participation: {
        blocksProduced: evidence?.blocksProduced ?? 0,
        blocksExpected: Math.max(1, Math.floor(state.s.nodeRewards.blockCount / Math.max(1, peerUniverse))),
        attestationsMade: evidence?.attested.length ?? 0,
      },
      reliability: { faults: evidence?.faults ?? 0, invalidAttestations: evidence?.invalidAttestations ?? 0 },
      responsiveness: {
        responsiveHeartbeats: heartbeats - (evidence?.staleHeartbeats ?? 0),
        staleHeartbeats: evidence?.staleHeartbeats ?? 0,
      },
    });
    const settled = state.s.nodeRewards.recentSettlements
      .filter((settlement) => settlement.payouts.some((payout) => payout.nodeId === nodeId))
      .map((settlement) => {
        const payout = settlement.payouts.find((entry) => entry.nodeId === nodeId)!;
        return {
          period: settlement.period,
          atHeight: settlement.atHeight,
          amountObs: formatObs(payout.amount),
          scoreBps: payout.scoreBps,
          shareBps: payout.shareBps,
          rewardWallet: payout.rewardWallet,
        };
      });
    this.json(response, 200, {
      nodeId,
      rewardWallet: node.rewardWallet,
      registered: node.deregisteredAtHeight === undefined,
      deregisteredAtHeight: node.deregisteredAtHeight ?? null,
      registeredAtHeight: node.registeredAtHeight,
      endpoint: node.endpoint || null,
      lifetimeRewardObs: formatObs(node.lifetimeReward),
      pendingWalletChange: node.pendingWallet
        ? { wallet: node.pendingWallet, effectivePeriod: node.pendingWalletEffectivePeriod ?? null }
        : null,
      currentPeriod: period,
      score,
      evidence: {
        heartbeats,
        expectedHeartbeats: CONSENSUS_PARAMS.nodeRewards.heartbeatsPerPeriod,
        attesters: evidence?.attesters ?? [],
        blocksProduced: evidence?.blocksProduced ?? 0,
        attestationsMade: evidence?.attested.length ?? 0,
        faults: evidence?.faults ?? 0,
        faultReporters: evidence?.faultReporters ?? [],
        staleHeartbeats: evidence?.staleHeartbeats ?? 0,
        lastReportedHeight: evidence?.lastReportedHeight ?? 0,
      },
      settledRewards: settled,
      note: 'the score above is recomputed by every node from this same evidence; nothing here is self-reported',
    });
  }

  /** When the node-runner share is paid next, from chain state and protocol time alone. */
  private revenueTiming(): Record<string, unknown> {
    const state = this.options.chain.world;
    const pool = state.s.nodeRewards;
    const now = this.options.chain.protocolTime;
    const period = rewardPeriodAt(now);
    const nextSettlementAt = rewardPeriodEnd(period);
    const treasuryDesignated = Boolean(state.s.genesis.treasuryWallet);
    return {
      treasuryShare: {
        paid: treasuryDesignated
          ? 'credited to the designated treasury wallet in the same block as the ONS fee'
          : 'held as an unclaimed treasury obligation in the Mining Pool until the first valid miner designates the treasury',
        bps: CONSENSUS_PARAMS.nodeRewards.treasuryShareBps,
      },
      nodeRunnerShare: {
        paid: 'once per protocol period, in the first block after the period closes',
        bps: CONSENSUS_PARAMS.nodeRewards.nodePoolShareBps,
        periodSeconds: CONSENSUS_PARAMS.nodeRewards.periodSeconds,
        currentPeriod: period,
        lastSettledPeriod: pool.lastSettledPeriod,
        nextSettlementAt,
        secondsUntilNextSettlement: Math.max(0, nextSettlementAt - now),
        registeredNodes: state.s.metrics.registeredNodes,
        poolBalanceObs: formatObs(pool.balance),
        carriedWhenNoNodes: state.s.metrics.registeredNodes === 0,
        note: state.s.metrics.registeredNodes === 0
          ? 'no node runner is registered yet, so the pool is carried forward and paid out once nodes register and earn a score'
          : 'each registered node is paid in proportion to the score its recorded evidence earned in the period that closed',
      },
    };
  }

  /** GET /revenue — ONS revenue accounting, by source and destination. */
  private revenue(response: ServerResponse): void {
    const state = this.options.chain.world;
    const metrics = state.s.metrics;
    const pool = state.s.nodeRewards;
    // `totalOnsTreasuryShare` counts the amount already credited. Before a
    // treasury wallet exists, the same 10% allocation is held as an explicit
    // obligation in `unclaimedRevenue`; include both in the split while keeping
    // the credited and unclaimed portions separately visible.
    const treasuryShare = metrics.totalOnsTreasuryShare + pool.unclaimedRevenue;
    this.json(response, 200, {
      onsRevenueObs: formatObs(metrics.totalOnsRevenue),
      split: {
        nodeRunnerPoolObs: formatObs(metrics.totalOnsRunnerShare),
        treasuryObs: formatObs(treasuryShare),
        treasuryCreditedObs: formatObs(metrics.totalOnsTreasuryShare),
        treasuryUnclaimedObs: formatObs(pool.unclaimedRevenue),
        nodePoolBps: CONSENSUS_PARAMS.nodeRewards.nodePoolShareBps,
        treasuryBps: CONSENSUS_PARAMS.nodeRewards.treasuryShareBps,
        sumsBack: metrics.totalOnsRunnerShare + treasuryShare === metrics.totalOnsRevenue,
      },
      bySource: pool.revenueBySource
        .map((entry) => ({ source: entry.source, totalObs: formatObs(entry.total) }))
        .sort((a, b) => (a.source < b.source ? -1 : 1)),
      accounts: {
        miningPoolObs: formatObs(state.s.pool.balance),
        nodeRunnerPoolObs: formatObs(pool.balance),
        unclaimedTreasuryRevenueObs: formatObs(pool.unclaimedRevenue),
        treasuryWallet: state.s.genesis.treasuryWallet || null,
      },
      // Where the 10% goes. The wallet is shown in full: a masked address cannot be looked up, which
      // made the destination of platform revenue impossible to check. What it has been credited is a
      // protocol metric. Its balance is not here, on purpose: no balance leaks through this route, and
      // anyone who wants it asks for the (now public) address through /wallet/balance like any other.
      treasury: {
        designated: Boolean(state.s.genesis.treasuryWallet),
        wallet: state.s.genesis.treasuryWallet || null,
        lifetimeCreditedObs: formatObs(metrics.totalTreasuryRevenue),
        credited: state.s.genesis.treasuryWallet
          ? 'each designated share is credited in the same block as its ONS fee; any earlier unclaimed share is credited when the first miner designates the treasury'
          : 'no treasury wallet is designated yet; the 10% share is held as an unclaimed obligation in the Mining Pool',
      },
      // When each share is paid. The treasury share is instant; the node-runner share is held in
      // the pool and paid once per protocol period, by the first block after the period closes.
      timing: this.revenueTiming(),
      notOnsRevenue: NOT_ONS_REVENUE.map((entry) => ({ kind: entry.name, because: entry.because })),
      gas: {
        destination: CONSENSUS_PARAMS.gas.destination,
        note: 'transaction gas funds the Mining Pool and is never counted as ONS revenue',
        lifetimeObs: formatObs(metrics.totalGasBurnedToPool),
      },
    });
  }

  private miningSchedule(response: ServerResponse): void {
    const activeMiners = this.options.chain.world.s.metrics.activeMiners;
    this.json(response, 200, {
      ...scheduleView(activeMiners),
      dailyRewardSeals: dailyRewardForActiveMiners(activeMiners).toString(),
      claimRewardSeals: claimRewardForActiveMiners(activeMiners).toString(),
    });
  }

  private miningStatus(response: ServerResponse, url: URL): void {
    const address = url.searchParams.get('address');
    if (!address || !isValidAddress(address, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'a valid wallet address is required', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    const state = this.options.chain.world;
    const account = state.getAccount(address);
    const protocolTime = this.options.chain.protocolTime;
    const eligibility = evaluateMining(
      account,
      protocolTime,
      state.s.metrics.activeMiners,
      state.s.genesis.allocationClaimed,
    );
    this.json(response, 200, {
      address,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      /** Protocol time used by the node — the UI countdown is derived from this. */
      protocolTime,
      nextEligibleAt: eligibility.nextEligibleAt,
      secondsRemaining: eligibility.secondsRemaining,
      claimsThisCycle: eligibility.claimsThisCycle,
      claimsRemainingInCycle: eligibility.claimsRemainingInCycle,
      cycleStartAt: eligibility.cycleStartAt,
      cycleEndsAt: eligibility.cycleEndsAt,
      nextClaimSequence: eligibility.nextClaimSequence,
      rewardPerClaimObs: formatObs(eligibility.rewardPerClaim),
      nextClaimId: computeClaimId(
        this.options.net.chainId,
        address,
        eligibility.nextClaimSequence,
        account?.mining?.lastClaimHeight ?? 0,
      ),
      activeMiners: state.s.metrics.activeMiners,
      genesisEligible: eligibility.genesisEligible,
      genesisAllocationObs: formatObs(CONSENSUS_PARAMS.genesisAllocation),
      totalClaims: account?.mining?.totalClaims ?? 0,
      totalRewardObs: formatObs(account?.mining?.totalReward ?? 0n),
      note: 'Eligibility is computed by the protocol. A device clock cannot change it.',
    });
  }

  private miningClaims(response: ServerResponse, url: URL): void {
    const limit = clampInt(url.searchParams.get('limit'), 25, 1, 200);
    const miner = url.searchParams.get('miner') ?? undefined;
    if (miner && !isValidAddress(miner, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'invalid miner address', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    this.json(response, 200, {
      claims: this.options.indexer.miningClaims(limit, miner).map((claim) => ({
        ...claim,
        miner: maskAddress(claim.miner),
        rewardObs: formatObs(BigInt(claim.reward)),
      })),
      activeMiners: this.options.chain.world.s.metrics.activeMiners,
    });
  }

  private names(response: ServerResponse, url: URL): void {
    const owner = url.searchParams.get('owner');
    const names = [...this.options.chain.world.s.names.values()]
      .filter((record) => !owner || record.owner === owner)
      .slice(0, 200)
      .map((record) => ({
        name: `${record.name}.obs`,
        owner: maskAddress(record.owner),
        address: record.address,
        expiresAt: record.expiresAt,
        registeredAtHeight: record.registeredAtHeight,
      }));
    this.json(response, 200, { names, count: this.options.chain.world.s.names.size });
  }

  private name(response: ServerResponse, rawName: string): void {
    const name = rawName.toLowerCase().replace(/\.obs$/, '');
    const record = this.options.chain.world.s.names.get(name);
    if (!record) {
      this.json(response, 404, { error: 'name not registered', code: 'ERR_NOT_FOUND', name: `${name}.obs` });
      return;
    }
    this.json(response, 200, {
      name: `${record.name}.obs`,
      owner: record.owner,
      address: record.address,
      registeredAt: record.registeredAt,
      registeredAtHeight: record.registeredAtHeight,
      expiresAt: record.expiresAt,
      transferCount: record.transferCount,
      resolved: true,
    });
  }

  /**
   * First-level divisions of one country. Reads the shipped registry table and
   * overlays the current GLV from chain state, so a division that has moved
   * (appreciation on protocol purchases, depreciation on buy-backs) reports the
   * live value rather than the static seed.
   */
  private async walletBalance(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.jsonBody<{ address?: string }>(request, response);
    if (payload === undefined) return;
    const address = payload.address ?? '';
    if (!isValidAddress(address, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'invalid wallet address', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    const state = this.options.chain.world;
    const account = state.getAccount(address);
    const names = [...state.s.names.values()].filter((record) => record.owner === address).map((record) => `${record.name}.obs`);
    this.json(response, 200, {
      address,
      balanceObs: formatObs(account?.balance ?? 0n),
      balanceSeals: (account?.balance ?? 0n).toString(),
      spendableObs: formatObs(account?.balance ?? 0n),
      nonce: account?.nonce ?? 0,
      txCount: account?.txCount ?? 0,
      receivedObs: formatObs(account?.totalReceived ?? 0n),
      sentObs: formatObs(account?.totalSent ?? 0n),
      createdAtHeight: account?.createdAtHeight ?? null,
      mining: account?.mining
        ? {
            totalClaims: account.mining.totalClaims,
            totalRewardObs: formatObs(account.mining.totalReward),
            lastClaimAt: account.mining.lastClaimAt,
            claimSequence: account.mining.claimSequence,
          }
        : null,
      names,
      atHeight: this.options.chain.height,
      /** The node never sees this wallet's private key or recovery phrase. */
      custodial: false,
    });
  }

  private walletNonce(response: ServerResponse, addressEncoded: string): void {
    const address = addressEncoded.replace(/\/$/, '');
    if (!isValidAddress(address, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'invalid wallet address', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    const account = this.options.chain.world.getAccount(address);
    this.json(response, 200, { address, nextNonce: account?.nonce ?? 0, atHeight: this.options.chain.height });
  }

  private async walletQuote(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.jsonBody<{
      address?: string;
      kind?: string;
      amountObs?: string;
      usd?: string;
    }>(request, response);
    if (body === undefined) return;
    const address = body.address ?? '';
    if (!isValidAddress(address, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'invalid wallet address', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    const state = this.options.chain.world;
    const account = state.getAccount(address);
    const amount = body.amountObs ? parseObs(body.amountObs) : 0n;
    const gas = expectedGas(amount);
    const usdMicro = body.usd ? usdToMicro(body.usd) : 0n;
    const price = state.s.oracle.medianPriceUsdMicro;
    const usdPrice = usdMicro > 0n && price > 0n ? usdMicroToSeals(usdMicro, price) : 0n;
    this.json(response, 200, {
      address,
      balanceObs: formatObs(account?.balance ?? 0n),
      amountObs: formatObs(amount),
      gasObs: formatObs(gas),
      totalObs: formatObs(amount + gas),
      sufficient: (account?.balance ?? 0n) >= amount + gas,
      usdQuoteObs: usdPrice > 0n ? formatObs(usdPrice) : null,
      obsPriceUsd: formatUsd(price),
      oracleUsable: !state.s.oracle.stale && price > 0n,
      nextNonce: account?.nonce ?? 0,
      protocolTime: this.options.chain.protocolTime,
    });
  }

  // ── Write endpoints ───────────────────────────────────────────────────────

  private async submitTransaction(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.options.config.rpcAllowSubmit) {
      this.json(response, 403, { error: 'transaction submission is disabled on this node', code: 'ERR_FORBIDDEN' });
      return;
    }
    const payload = await this.jsonBody<{ tx?: string }>(request, response);
    if (payload === undefined) return;
    if (!payload.tx || !/^[0-9a-f]+$/i.test(payload.tx)) {
      this.json(response, 400, { error: 'tx must be a hex-encoded signed transaction', code: 'ERR_MALFORMED' });
      return;
    }
    let tx;
    try {
      tx = decodeSignedTxFromBytes(Buffer.from(payload.tx, 'hex'));
    } catch (error) {
      this.json(response, 400, { error: `cannot decode transaction: ${(error as Error).message}`, code: 'ERR_MALFORMED' });
      return;
    }
    if (tx.chainId !== this.options.net.chainId) {
      this.json(response, 400, {
        error: `ERR_WRONG_CHAIN_ID: this node follows ${this.options.net.name} (chain id ${this.options.net.chainId}); the transaction targets chain id ${tx.chainId}`,
        code: 'ERR_WRONG_CHAIN_ID',
      });
      return;
    }
    // Sending the very same transaction again is not an error: a client that
    // never saw the first answer must be able to retry safely.
    const known = this.options.chain.mempool.get(tx.id);
    if (known) {
      this.json(response, 200, {
        accepted: true,
        duplicate: true,
        txId: tx.id,
        type: TxType[tx.type] ?? String(tx.type),
        sender: tx.sender,
        note: 'This transaction is already waiting for the next block.',
      });
      return;
    }
    // A DIFFERENT transaction with the same sender and nonce can never both be
    // mined. Say so now, instead of accepting it and losing it silently later.
    const clash = this.options.chain.mempool.findBySenderNonce(tx.sender, tx.nonce);
    if (clash) {
      this.json(response, 409, {
        error: `this account already has a transaction with nonce ${tx.nonce} waiting for the next block (${clash.tx.id.slice(0, 16)}…); wait for it to be confirmed, then send again`,
        code: 'ERR_NONCE_PENDING',
        pendingTxId: clash.tx.id,
        txId: tx.id,
      });
      return;
    }
    // Provisional simulation against current state: this is what the interface
    // uses for immediate feedback. Final validity is decided at block inclusion.
    const height = this.options.chain.height + 1;
    const timestamp = this.options.chain.protocolTime;
    const simulation = simulateTransactions(
      this.options.chain.world,
      [tx],
      { height, timestamp, chainId: this.options.net.chainId, producer: '' },
      this.options.net,
    );
    const outcome = simulation.results[0];
    if (!outcome?.ok) {
      this.json(response, 400, { error: outcome?.error ?? 'transaction rejected', code: 'ERR_REJECTED', txId: tx.id });
      return;
    }
    const admission = this.options.chain.mempool.add(tx);
    if (!admission.accepted) {
      this.json(response, 429, { error: admission.reason ?? 'not accepted', code: 'ERR_RATE_LIMITED', txId: tx.id });
      return;
    }
    this.options.p2p?.broadcastTransaction(tx);
    this.json(response, 200, {
      accepted: true,
      txId: tx.id,
      type: TxType[tx.type] ?? String(tx.type),
      sender: tx.sender,
      stateRootPreview: simulation.root,
      note: 'The transaction is admitted and broadcast for a scheduled proposer to consider. Admission does not guarantee inclusion, and inclusion is not irreversible; monitor reorgs and use confirmation depth only as an advisory risk signal.',
    });
  }

  private async simulate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const payload = await this.jsonBody<{ tx?: string }>(request, response);
    if (payload === undefined) return;
    if (!payload.tx || !/^[0-9a-f]+$/i.test(payload.tx)) {
      this.json(response, 400, { error: 'tx must be a hex-encoded signed transaction', code: 'ERR_MALFORMED' });
      return;
    }
    let tx;
    try {
      tx = decodeSignedTxFromBytes(Buffer.from(payload.tx, 'hex'));
    } catch (error) {
      this.json(response, 400, { error: `cannot decode transaction: ${(error as Error).message}`, code: 'ERR_MALFORMED' });
      return;
    }
    const height = this.options.chain.height + 1;
    const timestamp = this.options.chain.protocolTime;
    const simulation = simulateTransactions(
      this.options.chain.world,
      [tx],
      { height, timestamp, chainId: this.options.net.chainId, producer: '' },
      this.options.net,
    );
    this.json(response, 200, {
      valid: simulation.results[0]?.ok ?? false,
      error: simulation.results[0]?.error ?? null,
      projectedStateRoot: simulation.root,
      events: simulation.events.map((event) => ({ type: event.type, data: event.data })),
    });
  }

  private async encodeTx(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.jsonBody<{
      type?: string;
      payload?: Record<string, unknown>;
      body?: string;
    }>(request, response);
    if (body === undefined) return;
    if (body.body) {
      // Decode mode: turn canonical body bytes into a readable object.
      const bytes = Buffer.from(body.body, 'hex');
      try {
        this.json(response, 200, { decoded: decodeBodyFor(body.type ?? '', bytes) });
      } catch (error) {
        this.json(response, 400, { error: (error as Error).message, code: 'ERR_MALFORMED' });
      }
      return;
    }
    try {
      const encoded = encodeBodyFor(body.type ?? '', body.payload ?? {});
      this.json(response, 200, { body: Buffer.from(encoded).toString('hex'), type: body.type });
    } catch (error) {
      this.json(response, 400, { error: (error as Error).message, code: 'ERR_MALFORMED' });
    }
  }

  private async gasQuote(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.jsonBody<{ amountObs?: string; usd?: string }>(request, response);
    if (body === undefined) return;
    const state = this.options.chain.world;
    const amount = parseObs(body.amountObs ?? '0');
    const price = state.s.oracle.medianPriceUsdMicro;
    const usdMicro = body.usd ? usdToMicro(body.usd) : 0n;
    const obsForUsd = usdMicro > 0n && price > 0n ? usdMicroToSeals(usdMicro, price) : 0n;
    this.json(response, 200, {
      amountObs: formatObs(amount),
      gasObs: formatObs(expectedGas(amount)),
      usdObs: obsForUsd > 0n ? formatObs(obsForUsd) : null,
      usdGasObs: usdMicro > 0n && obsForUsd > 0n ? formatObs(expectedGas(obsForUsd)) : null,
      obsPriceUsd: formatUsd(price),
      gasFormula: 'gas = min(floor(amount * 2 / 10000), 0.01 OBS), destination = MINING_POOL',
    });
  }

  private network(response: ServerResponse): void {
    this.json(response, 200, {
      network: this.options.net,
      genesisId: this.options.genesisId,
      paramsHash: PARAMS_HASH,
      coreVersion: CORE_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      discovery: {
        /** Interfaces use this to expand their node list without a central server. */
        hint: 'Query /nodes on several known nodes and cross-check genesisId, chainId and paramsHash.',
      },
      // Each network names its own hostnames and no other's. A devnet, staging or testnet node used to
      // advertise mainnet's too, which told anyone asking a practice chain "this is the official
      // interface" — and those names are what people use to check a wallet address.
      domains: OFFICIAL_HOSTS[this.options.net.name as NetworkKey] ?? [],
      // Which browsers this node answers beyond its operator's own list.
      trust: { officialDomains: this.options.config.rpcTrustOfficialDomains !== false, patterns: this.options.config.rpcTrustOfficialDomains !== false ? OFFICIAL_PATTERNS.map((pattern) => `${pattern.scheme}://${pattern.wildcard ? '*.' : ''}${pattern.host}`) : [] },
    });
  }

  private decentralizationAudit(response: ServerResponse): void {
    this.json(response, 200, {
      questions: [
        { question: 'Can one server shut down the blockchain?', answer: 'NO', evidence: 'Any number of independent nodes store and validate the chain; the interface discovers several and fails over.' },
        { question: 'Can Cloudflare shut down consensus?', answer: 'NO', evidence: 'Cloudflare hosts interfaces and a gateway only. Nodes peer directly over P2P.' },
        { question: 'Can Google shut down consensus?', answer: 'NO', evidence: 'There is no Google sign-in: interface accounts are an email address, a password and TOTP, and the node never talks to Google.' },
        { question: 'Can the platform database alter balances?', answer: 'NO', evidence: 'Balances exist only in protocol state; the node has no external database dependency at all.' },
        { question: 'Can an administrator mint arbitrary OBS?', answer: 'NO', evidence: 'issue() accepts only GENESIS_ALLOCATION and MINING_REWARD and enforces the 21,000,000 cap.' },
        { question: 'Can one node rewrite the ledger?', answer: 'NO', evidence: 'Every block carries a state root that each node recomputes; a divergent block is rejected.' },
        { question: 'Can one interface control ownership?', answer: 'NO', evidence: 'Ownership changes require a signed transaction validated by consensus.' },
        { question: 'Can the platform steal user wallet funds?', answer: 'NO', evidence: 'The node never holds private keys; wallets are non-custodial and signing happens client-side.' },
        { question: 'Can browser clock manipulation create OBS?', answer: 'NO', evidence: 'Eligibility is computed from block timestamps and protocol state only.' },
        { question: 'Can the payment gateway mint OBS?', answer: 'NO', evidence: 'External payments never touch issuance; they only trigger application-level state.' },
      ],
      centralisedDependencies: [
        { component: 'Gmail address format', scope: 'interface accounts are named by a Gmail address; it is checked for shape and never verified with Google', consensusImpact: 'none' },
        { component: 'Cloudflare hosting', scope: 'interface delivery and API gateway', consensusImpact: 'none' },
        { component: 'External price sources', scope: 'supplies oracle observations that are bounded, median-aggregated and fail-closed', consensusImpact: 'bounded; cannot reprice beyond protocol limits and cannot corrupt state' },
        { component: 'External exchanges', scope: 'OBS price discovery outside the protocol', consensusImpact: 'none' },
        { component: 'Payment providers', scope: 'ecosystem service payments', consensusImpact: 'none; cannot mint' },
      ],
    });
  }

  private complianceAudit(response: ServerResponse): void {
    const params = CONSENSUS_PARAMS;
    this.json(response, 200, {
      wac: { present: params.registry.wacEnabled, priceUsd: params.registry.wacPriceUsd.toString() },
      legacyGenesisAllocation: { present: params.legacyGenesisAllocationRemoved !== 0n, amount: params.legacyGenesisAllocationRemoved.toString() },
      signupAllocation: { present: params.registry.newAccountBalance !== 0n, amount: params.registry.newAccountBalance.toString() },
      miningKyc: { present: params.registry.miningKycRequired },
      miningWithdrawalRequiresWac: { present: params.registry.miningWithdrawalRequiresWac },
      nativeExchange: { present: params.registry.nativeExchangeEnabled },
      explorerExposesBalances: { present: false, evidence: 'balance queries live under /wallet/balance only' },
      browserClockControlsMining: { present: false, evidence: 'evaluateMining uses block timestamps' },
      serverStoresPrivateKeys: { present: false, evidence: 'core persists only an encrypted node identity keystore' },
      adminMintPath: { present: false, evidence: 'issue() restricts sources to GENESIS_ALLOCATION and MINING_REWARD' },
      // Proof of Time and node runner rewards: the same style of claim, checked
      // against the running parameters rather than against a document.
      proofOfWorkConsensus: {
        present: CONSENSUS_PARAMS.proofOfTime.consensus !== 'PROOF_OF_TIME',
        evidence: `consensus is ${CONSENSUS_PARAMS.proofOfTime.consensus} with fork choice ${CONSENSUS_PARAMS.consensus.forkChoice}`,
      },
      blockHeaderNonce: {
        present: false,
        evidence: 'the header commits to version, chain, height, prevHash, roots, paramsHash, timestamp, producer, PoT weight, txCount and signature — there is no nonce to grind',
      },
      selfReportedNodeMetrics: {
        present: false,
        evidence: 'NODE_REGISTRY carries no uptime, efficiency or hash-rate field; uptime requires attestations signed by other registered nodes',
      },
      adminRewardOverride: {
        present: false,
        evidence: 'node rewards are settled by a block routine from chain evidence; no route, flag or parameter accepts an operator-supplied payout',
      },
      revenueSplitEnforced: {
        present: true,
        evidence: `${CONSENSUS_PARAMS.nodeRewards.nodePoolShareBps / 100}% node runners / ${CONSENSUS_PARAMS.nodeRewards.treasuryShareBps / 100}% treasury of ONS fees, applied in the state transition`,
      },
      // The name is part of the published contract (docs, CI and the 1.5
      // compliance record all use it): gas is remitted to the mining pool and is
      // not platform revenue, so it must never be routed through the ONS split.
      gasCountedAsPlatformRevenue: {
        present: false,
        evidence: `gas destination is ${CONSENSUS_PARAMS.gas.destination}; gas is not platform revenue and is never routed through the ONS revenue split`,
      },
      nodeIdentityIsIpAddress: {
        present: false,
        evidence: 'a node identity is the hash of a secp256k1 public key; the endpoint is an unverified hint and is never used for scoring',
      },
    });
  }

  private async jsonRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // The shared reader: an oversized body is 413, anything that is not a single JSON object (`null`, a number, an
    // array) is 400. The inline JSON.parse this replaces turned `null` into a 500 and an oversized body into a 400.
    const parsed = await this.jsonBody<Record<string, unknown>>(request, response);
    if (parsed === undefined) return;
    const payload = parsed as { method?: unknown; params?: unknown; id?: unknown };
    const method = typeof payload.method === 'string' ? payload.method : '';
    const params = (payload.params !== null && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {}) as Record<string, unknown>;
    const id = typeof payload.id === 'number' || typeof payload.id === 'string' ? payload.id : null;
    try {
      const result = await this.invokeJsonRpc(method, params);
      this.json(response, 200, { jsonrpc: '2.0', id, result });
    } catch (error) {
      this.json(response, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: (error as Error).message, data: { code: 'ERR_METHOD' } },
      });
    }
  }

  private async invokeJsonRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const state = this.options.chain.world;
    switch (method) {
      case 'getstatus':
        return this.options.chain.status({ peers: this.options.p2p?.peerCount ?? 0 });
      case 'getfinality':
        return {...this.options.chain.finalityStatus(),certificate:this.options.chain.latestFinalityCertificate(),evidence:this.options.chain.equivocationEvidence()};
      case 'getblock':
        return this.options.chain.getBlockByHeight(Number(params.height ?? 0))?.header ?? null;
      case 'getblocks':
        // Bounded like the REST list: an unbounded `limit` is an unbounded response, on a public endpoint.
        return (this.options.chain.store.canonicalRange(clampNumber(params.from, 0, 0, Number.MAX_SAFE_INTEGER), clampNumber(params.limit, 10, 1, 500)) ?? []).map(
          (entry) => entry.hash,
        );
      case 'gettransaction':
        return this.options.indexer.getTransaction(String(params.txId ?? '')) ?? null;
      case 'getbalance': {
        const address = String(params.address ?? '');
        if (!isValidAddress(address, this.options.net.addressHrp)) throw new Error('invalid address');
        const account = state.getAccount(address);
        return { address, balanceObs: formatObs(account?.balance ?? 0n), nonce: account?.nonce ?? 0 };
      }
      case 'getminingstatus': {
        const address = String(params.address ?? '');
        const eligibility = evaluateMining(
          state.getAccount(address),
          this.options.chain.protocolTime,
          state.s.metrics.activeMiners,
          state.s.genesis.allocationClaimed,
        );
        return { ...eligibility, rewardPerClaimObs: formatObs(eligibility.rewardPerClaim) };
      }
      case 'getparams':
        return { protocolVersion: PROTOCOL_VERSION, paramsHash: PARAMS_HASH };
      case 'getoracle':
        return {
          priceUsd: formatUsd(state.s.oracle.medianPriceUsdMicro),
          sourceCount: state.s.oracle.sourceCount,
          stale: state.s.oracle.stale,
        };
      case 'getnames':
        return [...state.s.names.keys()].map((name) => `${name}.obs`);
      case 'submittransaction':
        throw new Error('use POST /tx/submit (raw signed transaction hex)');
      case 'getpeers':
        return this.options.p2p?.knownPeers() ?? [];
      case 'getnodes':
        return this.options.p2p?.announcement(this.options.config.rpcPublicUrl || undefined) ?? null;
      default:
        throw new Error(`unknown method ${method}`);
    }
  }
}

function clampNumber(raw: unknown, fallback: number, min: number, max: number): number {
  const value = Math.trunc(Number(raw));
  if (raw === undefined || raw === null || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Exact decimal USD -> micro-USD. Going through a float (`Number(x) * 1e6`) both
 * mis-rounds and, for text that is not a number, produced NaN, which BigInt()
 * rejects with a RangeError — a 500 for what is plainly a bad request.
 */
export function usdToMicro(input: unknown): bigint {
  const raw = String(input ?? '').trim();
  if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new AmountError(`invalid USD amount: ${raw.slice(0, 40)} (expected up to 6 decimal places)`);
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole!) * 1_000_000n + BigInt((fraction + '000000').slice(0, 6));
}

export function formatUsd(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  const body = frac.length ? `${whole}.${frac}` : whole.toString();
  return negative ? `-$${body}` : `$${body}`;
}

/** Body encoders/decoders exposed so interfaces and SDKs build exact bytes. */
export function encodeBodyFor(type: string, payload: Record<string, unknown>): Uint8Array {
  switch (type.toUpperCase()) {
    case 'PAYMENT':
      return encodePaymentBodyRaw(payload as { to: string; amount: string | bigint; memo?: string });
    case 'ONS':
      return encodeOnsBody(payload as never);
    case 'MINING_CLAIM':
      return encodeMiningBody(payload as never);
    case 'VALIDATOR':
      return encodeValidatorBody(payload as never);
    case 'TREASURY':
      return encodeTreasuryBody(payload as never);
    case 'ORACLE':
      return encodeOracleBody(payload as never);
    case 'NODE_REGISTRY':
      return encodeNodeRegistryBody(payload as never);
    case 'SLASH':
      return encodeSlashBody(payload as never);
    default:
      throw new Error(type ? `unknown transaction type ${type}` : 'transaction type is required');
  }
}

export function decodeBodyFor(type: string, bytes: Uint8Array): unknown {
  switch (type.toUpperCase()) {
    case 'PAYMENT':
      return decodePaymentBody(bytes);
    case 'ONS':
      return decodeOnsBody(bytes);
    case 'MINING_CLAIM':
      return decodeMiningBody(bytes);
    case 'VALIDATOR':
      return decodeValidatorBody(bytes);
    case 'TREASURY':
      return decodeTreasuryBody(bytes);
    case 'NODE_REGISTRY':
      return decodeNodeRegistryBody(bytes);
    case 'SLASH':
      return decodeSlashBody(bytes);
    case 'ORACLE':
      return decodeOracleBody(bytes);
    default:
      throw new Error(type ? `unknown transaction type ${type}` : 'transaction type is required');
  }
}

function encodePaymentBodyRaw(payload: { to: string; amount: string | bigint; memo?: string }): Uint8Array {
  return encodePaymentBody({
    to: payload.to,
    amount: typeof payload.amount === 'bigint' ? payload.amount : BigInt(payload.amount),
    memo: payload.memo,
  });
}

export function encodePaymentBodyForSdk(payload: { to: string; amount: bigint; memo?: string }): Uint8Array {
  return encodePaymentBodyRaw(payload);
}

export function paymentGasBaseForSdk(body: Uint8Array): bigint {
  return paymentBaseAmount(decodePaymentBody(body));
}
