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
import { formatObs, MAX_SUPPLY_SEALS, parseObs } from '../protocol/amount.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { evaluateMining } from '../mining/rules.js';
import { scheduleView, dailyRewardForActiveMiners, claimRewardForActiveMiners } from '../mining/schedule.js';
import { decodeSignedTxFromBytes, encodeSignedTx } from '../transactions/encode.js';
import { simulateTransactions } from '../blockchain/state-machine.js';
import { blockHash, summarizeBlock } from '../blockchain/block.js';
import { paramsHashUtf8, PARAMS_HASH } from '../blockchain/state-root.js';
import { genesisDocumentFor } from '../genesis/initialize.js';
import { divisionSeed, listCountries, searchDivisions } from '../land/registry.js';
import { CORE_VERSION, MIN_CORE_VERSION, PROTOCOL_VERSION, versionInfo } from '../version.js';
import { isValidAddress, ID_HRP } from '../crypto/keys.js';
import { encodeCapsuleBody, decodeCapsuleBody } from '../transactions/executors/capsule.js';
import { encodeLandBody, decodeLandBody, computeParcelId } from '../transactions/executors/land.js';
import { encodeSocialBody, decodeSocialBody } from '../transactions/executors/social.js';
import { encodeOnsBody, decodeOnsBody } from '../transactions/executors/ons.js';
import { encodeMiningBody, decodeMiningBody, computeClaimId } from '../transactions/executors/mining.js';
import { encodePaymentBody, decodePaymentBody, paymentBaseAmount } from '../transactions/executors/payment.js';
import { expectedGas, usdMicroToSeals } from '../transactions/helpers.js';
import { decodeValidatorBody, encodeValidatorBody } from '../transactions/executors/validator.js';
import { decodeTreasuryBody, encodeTreasuryBody } from '../transactions/executors/treasury.js';
import { decodeOracleBody, encodeOracleBody } from '../transactions/executors/oracle.js';
import { TxType } from '../protocol/types.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { NodeConfig } from '../config/config.js';

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

export class RpcServer {
  private server?: Server;
  private readonly buckets = new Map<string, RateBucket>();

  constructor(private readonly options: RpcOptions) {}

  async listen(): Promise<number> {
    const { config } = this.options;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(config.rpcPort, config.rpcHost, () => {
        this.options.log('info', 'rpc listening', { host: config.rpcHost, port: config.rpcPort });
        resolve();
      });
    });
    return config.rpcPort;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const ip = request.socket.remoteAddress ?? 'unknown';
    try {
      if (!this.allowRequest(ip)) {
        this.json(response, 429, { error: 'rate limit exceeded', code: 'ERR_RATE_LIMITED' });
        return;
      }
      const origin = request.headers.origin;
      if (origin && !this.isOriginAllowed(origin)) {
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
      this.options.log('error', 'rpc handler failed', { path: request.url, error: (error as Error).message });
      this.json(response, 500, { error: 'internal error', code: 'ERR_INTERNAL' });
    } finally {
      this.options.log('debug', 'rpc request', {
        path: request.url,
        method: request.method,
        status: response.statusCode,
        ms: Date.now() - started,
      });
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

  private isOriginAllowed(origin: string): boolean {
    const allowed = this.options.config.rpcCorsOrigins;
    if (allowed.length === 0) return false;
    return allowed.includes('*') || allowed.includes(origin);
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

  // ── Router ────────────────────────────────────────────────────────────────

  private async route(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method ?? 'GET';

    if (path === '/' || path === '/health') return this.health(response);
    if (path === '/status') return this.status(response);
    if (path === '/params') return this.params(response);
    if (path === '/version') return this.json(response, 200, versionInfo());
    if (path === '/genesis') return this.genesis(response);
    if (path === '/supply') return this.supply(response);
    if (path === '/nodes') return this.nodes(response);
    if (path === '/peers') return this.peers(response);
    if (path === '/oracle') return this.oracle(response);
    if (path === '/validators') return this.validators(response);
    if (path === '/blocks') return this.blocks(response, url);
    if (path.startsWith('/block/')) return this.block(response, decodeURIComponent(path.slice(7)));
    // Write paths are matched BEFORE the /tx/:id read route on purpose: a
    // prefix match must never shadow a mutating endpoint.
    if (path === '/tx/submit' && method === 'POST') return this.submitTransaction(request, response);
    if (path === '/tx/simulate' && method === 'POST') return this.simulate(request, response);
    if (path === '/tx/encode' && method === 'POST') return this.encodeTx(request, response);
    if (path === '/tx/gas' && method === 'POST') return this.gasQuote(request, response);
    if (path.startsWith('/tx/')) return this.transaction(response, decodeURIComponent(path.slice(4)));
    if (path === '/mempool') return this.mempool(response);
    if (path === '/mining/schedule') return this.miningSchedule(response);
    if (path === '/mining/status') return this.miningStatus(response, url);
    if (path === '/mining/claims') return this.miningClaims(response, url);
    if (path === '/names') return this.names(response, url);
    if (path.startsWith('/names/')) return this.name(response, decodeURIComponent(path.slice(7)));
    if (path === '/land/countries') return this.json(response, 200, { countries: listCountries() });
    if (path === '/land/search') return this.landSearch(response, url);
    if (path.startsWith('/land/division/')) return this.landDivision(response, decodeURIComponent(path.slice(15)));
    if (path === '/land/parcels') return this.landParcels(response, url);
    if (path.startsWith('/land/parcel/')) return this.landParcel(response, decodeURIComponent(path.slice(13)));
    if (path.startsWith('/land/quote/')) return this.landQuote(response, decodeURIComponent(path.slice(12)));
    if (path.startsWith('/land/parcelid/')) return this.landParcelId(response, decodeURIComponent(path.slice(14)));
    if (path === '/capsules') return this.capsules(response, url);
    if (path.startsWith('/capsules/')) return this.capsule(response, decodeURIComponent(path.slice(9)));
    if (path === '/social/feed') return this.socialFeed(response, url);
    if (path.startsWith('/social/profile/')) return this.socialProfile(response, decodeURIComponent(path.slice(15)));
    if (path.startsWith('/social/post/')) return this.socialPost(response, decodeURIComponent(path.slice(12)));
    if (path.startsWith('/social/following/')) return this.socialFollowing(response, decodeURIComponent(path.slice(18)));
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
        parcels: state.s.metrics.totalParcelsIssued,
        names: state.s.metrics.totalNamesRegistered,
        capsules: state.s.metrics.totalCapsulesCreated,
        tips: formatObs(state.s.metrics.totalTips),
        treasuryRevenue: formatObs(state.s.metrics.totalTreasuryRevenue),
        creatorEarnings: formatObs(state.s.metrics.totalCreatorEarnings),
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
      consensus: {
        forkChoice: CONSENSUS_PARAMS.consensus.forkChoice,
        minValidatorBondObs: formatObs(CONSENSUS_PARAMS.consensus.minValidatorBond),
        unbondingBlocks: CONSENSUS_PARAMS.consensus.unbondingBlocks,
        maxReorgDepth: CONSENSUS_PARAMS.consensus.maxReorgDepth,
      },
      ons: {
        registrationFeeUsd: formatObs(CONSENSUS_PARAMS.ons.registrationFeeUsd * 10n ** 12n, 6),
        termSeconds: CONSENSUS_PARAMS.ons.termSeconds,
        graceSeconds: CONSENSUS_PARAMS.ons.graceSeconds,
        minLength: CONSENSUS_PARAMS.ons.minLength,
        maxLength: CONSENSUS_PARAMS.ons.maxLength,
      },
      capsules: {
        minCommitmentObs: formatObs(CONSENSUS_PARAMS.capsules.minCommitment),
        timeTravelMultiplier: CONSENSUS_PARAMS.capsules.timeTravelMultiplier.toString(),
        previewSeconds: CONSENSUS_PARAMS.capsules.previewSeconds,
        maxContentBytes: CONSENSUS_PARAMS.capsules.maxContentBytes,
      },
      circle: {
        parcelSquareMetres: CONSENSUS_PARAMS.circle.parcelSquareMetres,
        appreciationStepBps: CONSENSUS_PARAMS.circle.appreciationStepBps,
        depreciationStepBps: CONSENSUS_PARAMS.circle.depreciationStepBps,
        minGlvUsd: formatObs(CONSENSUS_PARAMS.circle.minGlvUsd * 10n ** 12n, 2),
        maxGlvUsd: formatObs(CONSENSUS_PARAMS.circle.maxGlvUsd * 10n ** 12n, 2),
      },
      social: {
        creatorShareBps: CONSENSUS_PARAMS.social.creatorShareBps,
        networkShareBps: CONSENSUS_PARAMS.social.networkShareBps,
        businessPagePriceUsd: formatObs(CONSENSUS_PARAMS.social.businessPagePriceUsd * 10n ** 12n, 2),
        monetisationMinFollowers: CONSENSUS_PARAMS.social.monetisationMinFollowers,
        monetisationMinMonthlyViews: CONSENSUS_PARAMS.social.monetisationMinMonthlyViews,
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
    const document = genesisDocumentFor(this.options.net);
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
      lockedInCapsules: formatObs(
        [...state.s.capsules.values()]
          .filter((capsule) => capsule.status === 'LOCKED')
          .reduce((sum, capsule) => sum + capsule.creatorCommitment, 0n),
      ),
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
        };
      }),
      rotation: 'proposer(height) = activeValidators[height mod count]',
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
        cumulativeWork: block.header.cumulativeWork.toString(),
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

  private landSearch(response: ServerResponse, url: URL): void {
    const query = url.searchParams.get('q') ?? '';
    const limit = clampInt(url.searchParams.get('limit'), 20, 1, 50);
    this.json(response, 200, { query, results: searchDivisions(query, limit) });
  }

  private landDivision(response: ServerResponse, divisionId: string): void {
    const seed = divisionSeed(divisionId);
    const record = this.options.chain.world.s.divisions.get(seed.divisionId);
    this.json(response, 200, {
      divisionId: seed.divisionId,
      country: seed.countryCode,
      countryName: seed.countryName,
      continent: seed.continent,
      baseGlvUsd: formatUsd(seed.glvUsdMicro),
      currentGlvUsd: formatUsd(record?.glvUsdMicro ?? seed.glvUsdMicro),
      protocolPurchases: record?.protocolPurchases ?? 0,
      protocolBuybacks: record?.protocolBuybacks ?? 0,
      lastUpdatedAtHeight: record?.lastUpdatedAtHeight ?? null,
    });
  }

  private landParcels(response: ServerResponse, url: URL): void {
    const owner = url.searchParams.get('owner');
    const divisionId = url.searchParams.get('division');
    const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
    const parcels = [...this.options.chain.world.s.parcels.values()]
      .filter((parcel) => !owner || parcel.owner === owner)
      .filter((parcel) => !divisionId || parcel.divisionId === divisionId.toUpperCase())
      .slice(0, limit)
      .map((parcel) => ({
        parcelId: parcel.parcelId,
        divisionId: parcel.divisionId,
        countryCode: parcel.countryCode,
        squareMetres: parcel.squareMetres,
        status: parcel.status,
        owner: maskAddress(parcel.owner),
        glvUsd: formatUsd(parcel.glvUsdMicro),
        ilvUsd: parcel.ilvUsdMicro ? formatUsd(parcel.ilvUsdMicro) : null,
        mspObs: parcel.mspObs ? formatObs(parcel.mspObs) : null,
        acquiredAtHeight: parcel.acquiredAtHeight,
        issuedAtHeight: parcel.issuedAtHeight,
      }));
    this.json(response, 200, {
      parcels,
      total: this.options.chain.world.s.parcels.size,
      supplyCapNote: 'One square metre per protocol transaction.',
    });
  }

  private landParcel(response: ServerResponse, parcelId: string): void {
    const parcel = this.options.chain.world.s.parcels.get(parcelId);
    if (!parcel) {
      this.json(response, 404, { error: 'parcel not found', code: 'ERR_PARCEL_NOT_FOUND' });
      return;
    }
    const division = this.options.chain.world.s.divisions.get(parcel.divisionId);
    this.json(response, 200, {
      ...parcel,
      glvUsd: formatUsd(parcel.glvUsdMicro),
      ilvUsd: parcel.ilvUsdMicro ? formatUsd(parcel.ilvUsdMicro) : null,
      mspObs: parcel.mspObs ? formatObs(parcel.mspObs) : null,
      divisionGlvUsd: division ? formatUsd(division.glvUsdMicro) : null,
    });
  }

  private landQuote(response: ServerResponse, divisionId: string): void {
    const state = this.options.chain.world;
    const seed = divisionSeed(divisionId);
    const record = state.s.divisions.get(seed.divisionId);
    const glv = record?.glvUsdMicro ?? seed.glvUsdMicro;
    const priceUsdMicro = state.s.oracle.medianPriceUsdMicro;
    const usable = !state.s.oracle.stale && priceUsdMicro > 0n && state.s.oracle.sourceCount >= CONSENSUS_PARAMS.oracle.minSources;
    const priceObs = usable ? usdMicroToSeals(glv, priceUsdMicro) : null;
    this.json(response, usable ? 200 : 503, {
      divisionId: seed.divisionId,
      glvUsd: formatUsd(glv),
      obsPriceUsd: formatUsd(priceUsdMicro),
      priceObs: priceObs ? formatObs(priceObs) : null,
      gasObs: priceObs ? formatObs(expectedGas(priceObs)) : null,
      oracleUsable: usable,
      oracleStale: state.s.oracle.stale,
      sourceCount: state.s.oracle.sourceCount,
      note: usable
        ? 'Quote is derived from on-chain protocol state.'
        : 'USD pricing is unavailable because the protocol price feed is stale or lacks sources.',
    });
  }

  private landParcelId(response: ServerResponse, encoded: string): void {
    try {
      const payload = JSON.parse(decodeURIComponent(encoded)) as {
        divisionId: string;
        level: number;
        subId: string;
        plotIndex: string | number;
      };
      const parcelId = computeParcelId({
        divisionId: payload.divisionId,
        level: payload.level,
        subId: payload.subId,
        plotIndex: BigInt(payload.plotIndex),
      });
      const exists = this.options.chain.world.s.parcels.has(parcelId);
      this.json(response, 200, { parcelId, exists });
    } catch {
      this.json(response, 400, { error: 'invalid parcel descriptor', code: 'ERR_MALFORMED' });
    }
  }

  private capsules(response: ServerResponse, url: URL): void {
    const owner = url.searchParams.get('owner');
    const status = url.searchParams.get('status');
    const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
    const all = [...this.options.chain.world.s.capsules.values()];
    const filtered = all
      .filter((capsule) => !owner || capsule.owner === owner)
      .filter((capsule) => !status || capsule.status === status.toUpperCase())
      .slice(-limit)
      .reverse()
      .map((capsule) => ({
        capsuleId: capsule.capsuleId,
        owner: maskAddress(capsule.owner),
        commitmentObs: formatObs(capsule.creatorCommitment),
        /** Teasers are the only content the protocol can release without a party online. */
        teaser: capsule.teaser ?? null,
        unlockAt: capsule.unlockAt,
        createdAt: capsule.createdAt,
        status: capsule.status,
        previewCount: capsule.previewCount,
        timeTravelRevenue: formatObs(capsule.totalTimeTravelRevenue),
        timeTravelPriceObs: formatObs(capsule.creatorCommitment * CONSENSUS_PARAMS.capsules.timeTravelMultiplier),
        contentBytes: capsule.contentBytes,
      }));
    const locked = all.filter((capsule) => capsule.status === 'LOCKED');
    const nextUnlock = locked.length > 0 ? Math.min(...locked.map((capsule) => capsule.unlockAt)) : null;
    this.json(response, 200, {
      capsules: filtered,
      stats: {
        total: all.length,
        locked: locked.length,
        unlocked: all.length - locked.length,
        totalLockedObs: formatObs(locked.reduce((sum, capsule) => sum + capsule.creatorCommitment, 0n)),
        totalReturnedToPoolObs: formatObs(
          all.reduce((sum, capsule) => sum + (capsule.status === 'UNLOCKED' ? capsule.poolContribution ?? 0n : 0n), 0n),
        ),
        totalTimeTravelRevenueObs: formatObs(all.reduce((sum, capsule) => sum + capsule.totalTimeTravelRevenue, 0n)),
        nearestUnlock: nextUnlock,
        largestCommitmentObs: formatObs(
          all.reduce((max, capsule) => (capsule.creatorCommitment > max ? capsule.creatorCommitment : max), 0n),
        ),
        mostTimeTravelled: all.length
          ? all.reduce((best, capsule) => (capsule.previewCount > best.previewCount ? capsule : best), all[0]).capsuleId
          : null,
        upcomingUnlocks: locked
          .map((capsule) => ({ capsuleId: capsule.capsuleId, unlockAt: capsule.unlockAt }))
          .sort((a, b) => a.unlockAt - b.unlockAt)
          .slice(0, 10),
      },
    });
  }

  private capsule(response: ServerResponse, capsuleId: string): void {
    const capsule = this.options.chain.world.s.capsules.get(capsuleId);
    if (!capsule) {
      this.json(response, 404, { error: 'capsule not found', code: 'ERR_CAPSULE_NOT_FOUND' });
      return;
    }
    const locked = capsule.status === 'LOCKED';
    this.json(response, 200, {
      capsuleId: capsule.capsuleId,
      owner: capsule.owner,
      commitmentObs: formatObs(capsule.creatorCommitment),
      contentCommitment: capsule.contentCommitment,
      contentBytes: capsule.contentBytes,
      createdAt: capsule.createdAt,
      createdAtHeight: capsule.createdAtHeight,
      unlockAt: capsule.unlockAt,
      status: capsule.status,
      unlockedAtHeight: capsule.unlockedAtHeight ?? null,
      pooledAtUnlockObs: capsule.poolContribution ? formatObs(capsule.poolContribution) : null,
      previewCount: capsule.previewCount,
      timeTravelRevenueObs: formatObs(capsule.totalTimeTravelRevenue),
      timeTravelPriceObs: formatObs(capsule.creatorCommitment * CONSENSUS_PARAMS.capsules.timeTravelMultiplier),
      previewSeconds: CONSENSUS_PARAMS.capsules.previewSeconds,
      teaser: capsule.teaser ?? null,
      /** The encrypted payload itself is never served before unlock. */
      contentUnavailable: locked,
      uri: `${ID_HRP}:capsule:${capsule.capsuleId}`,
    });
  }

  private socialFeed(response: ServerResponse, url: URL): void {
    const limit = clampInt(url.searchParams.get('limit'), 25, 1, 100);
    const account = url.searchParams.get('account');
    const posts = [...this.options.chain.world.s.posts.values()]
      .filter((post) => !post.deleted)
      .filter((post) => !account || post.authorAccountId === account)
      .slice(-limit)
      .reverse()
      .map((post) => ({
        postId: post.postId,
        authorAccountId: post.authorAccountId,
        author: maskAddress(post.authorAddress),
        content: post.content,
        parentPostId: post.parentPostId ?? null,
        createdAt: post.createdAt,
        createdAtHeight: post.createdAtHeight,
        likes: post.likes,
      }));
    this.json(response, 200, {
      posts,
      onChain: true,
      note: 'Feed caches may exist in interfaces; this list is derived from blockchain state.',
    });
  }

  private socialProfile(response: ServerResponse, accountId: string): void {
    const profile = this.options.chain.world.s.social.get(accountId);
    if (!profile) {
      this.json(response, 404, { error: 'profile not found', code: 'ERR_NOT_FOUND' });
      return;
    }
    const request = this.options.chain.world.s.verificationRequests.get(accountId);
    this.json(response, 200, {
      accountId: profile.accountId,
      handle: profile.handle,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarHash: profile.avatarHash ?? null,
      owner: maskAddress(profile.owner),
      followers: profile.followers,
      following: profile.following,
      posts: profile.postCount,
      monthlyViews: profile.monthlyViews,
      earningsObs: formatObs(profile.earnings),
      tier: profile.tier,
      businessPage: profile.businessPage,
      monetisationEnabled: profile.monetisationEnabled,
      verificationPending: Boolean(request),
      monetisationThresholds: {
        followers: CONSENSUS_PARAMS.social.monetisationMinFollowers,
        monthlyViews: CONSENSUS_PARAMS.social.monetisationMinMonthlyViews,
      },
    });
  }

  private socialPost(response: ServerResponse, postId: string): void {
    const post = this.options.chain.world.s.posts.get(postId);
    if (!post) {
      this.json(response, 404, { error: 'post not found', code: 'ERR_NOT_FOUND' });
      return;
    }
    this.json(response, 200, {
      ...post,
      authorAddress: maskAddress(post.authorAddress),
    });
  }

  private socialFollowing(response: ServerResponse, accountId: string): void {
    const edges = [...this.options.chain.world.s.socialFollowing]
      .filter((edge) => edge.startsWith(`${accountId}->`))
      .map((edge) => edge.split('->')[1]);
    this.json(response, 200, { accountId, following: edges, count: edges.length });
  }

  // ── Wallet API (never used by explorer pages) ─────────────────────────────

  private async walletBalance(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request);
    let payload: { address?: string };
    try {
      payload = JSON.parse(body) as { address?: string };
    } catch {
      this.json(response, 400, { error: 'invalid JSON body', code: 'ERR_MALFORMED' });
      return;
    }
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
    const body = JSON.parse(await this.readBody(request)) as {
      address?: string;
      kind?: string;
      amountObs?: string;
      usd?: string;
    };
    const address = body.address ?? '';
    if (!isValidAddress(address, this.options.net.addressHrp)) {
      this.json(response, 400, { error: 'invalid wallet address', code: 'ERR_BAD_ADDRESS' });
      return;
    }
    const state = this.options.chain.world;
    const account = state.getAccount(address);
    const amount = body.amountObs ? parseObs(body.amountObs) : 0n;
    const gas = expectedGas(amount);
    const usdMicro = body.usd ? BigInt(Math.round(Number(body.usd) * 1_000_000)) : 0n;
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
    const body = await this.readBody(request);
    let payload: { tx?: string };
    try {
      payload = JSON.parse(body) as { tx?: string };
    } catch {
      this.json(response, 400, { error: 'invalid JSON body', code: 'ERR_MALFORMED' });
      return;
    }
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
      this.json(response, 400, { error: 'transaction belongs to a different network', code: 'ERR_WRONG_CHAIN_ID' });
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
      note: 'The transaction is broadcast and will be included by the next scheduled proposer. Only block inclusion is final.',
    });
  }

  private async simulate(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readBody(request);
    let payload: { tx?: string };
    try {
      payload = JSON.parse(body) as { tx?: string };
    } catch {
      this.json(response, 400, { error: 'invalid JSON body', code: 'ERR_MALFORMED' });
      return;
    }
    if (!payload.tx) {
      this.json(response, 400, { error: 'tx is required', code: 'ERR_MALFORMED' });
      return;
    }
    const tx = decodeSignedTxFromBytes(Buffer.from(payload.tx, 'hex'));
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
    const body = JSON.parse(await this.readBody(request)) as {
      type?: string;
      payload?: Record<string, unknown>;
      body?: string;
    };
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
    const body = JSON.parse(await this.readBody(request)) as { amountObs?: string; usd?: string };
    const state = this.options.chain.world;
    const amount = parseObs(body.amountObs ?? '0');
    const price = state.s.oracle.medianPriceUsdMicro;
    const usdMicro = body.usd ? BigInt(Math.round(Number(body.usd) * 1_000_000)) : 0n;
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
      domains: [
        'obsmainnet.us.ci',
        'mine.obsmainnet.us.ci',
        'wallet.obsmainnet.us.ci',
        'explorer.obsmainnet.us.ci',
        'social.obsmainnet.us.ci',
        'capsule.obsmainnet.us.ci',
        'ons.obsmainnet.us.ci',
        'circle.obsmainnet.us.ci',
        'developer.obsmainnet.us.ci',
        'interface.obsmainnet.us.ci',
      ],
    });
  }

  private decentralizationAudit(response: ServerResponse): void {
    this.json(response, 200, {
      questions: [
        { question: 'Can one server shut down the blockchain?', answer: 'NO', evidence: 'Any number of independent nodes store and validate the chain; the interface discovers several and fails over.' },
        { question: 'Can Cloudflare shut down consensus?', answer: 'NO', evidence: 'Cloudflare hosts interfaces and a gateway only. Nodes peer directly over P2P.' },
        { question: 'Can Google shut down consensus?', answer: 'NO', evidence: 'OAuth exists only in the application layer; the node never validates Google tokens.' },
        { question: 'Can the platform database alter balances?', answer: 'NO', evidence: 'Balances exist only in protocol state; the node has no external database dependency at all.' },
        { question: 'Can an administrator mint arbitrary OBS?', answer: 'NO', evidence: 'issue() accepts only GENESIS_ALLOCATION and MINING_REWARD and enforces the 21,000,000 cap.' },
        { question: 'Can one node rewrite the ledger?', answer: 'NO', evidence: 'Every block carries a state root that each node recomputes; a divergent block is rejected.' },
        { question: 'Can one interface control ownership?', answer: 'NO', evidence: 'Ownership changes require a signed transaction validated by consensus.' },
        { question: 'Can the platform steal user wallet funds?', answer: 'NO', evidence: 'The node never holds private keys; wallets are non-custodial and signing happens client-side.' },
        { question: 'Can browser clock manipulation create OBS?', answer: 'NO', evidence: 'Eligibility is computed from block timestamps and protocol state only.' },
        { question: 'Can the payment gateway mint OBS?', answer: 'NO', evidence: 'External payments never touch issuance; they only trigger application-level state.' },
      ],
      centralisedDependencies: [
        { component: 'Google OAuth', scope: 'application registration only', consensusImpact: 'none' },
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
    });
  }

  private async jsonRpc(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let payload: { method?: string; params?: unknown; id?: number | string };
    try {
      payload = JSON.parse(await this.readBody(request)) as { method?: string; params?: unknown; id?: number | string };
    } catch {
      this.json(response, 400, { error: 'invalid JSON body', code: 'ERR_MALFORMED' });
      return;
    }
    const method = payload.method ?? '';
    const params = (payload.params ?? {}) as Record<string, unknown>;
    const id = payload.id ?? null;
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
      case 'getblock':
        return this.options.chain.getBlockByHeight(Number(params.height ?? 0))?.header ?? null;
      case 'getblocks':
        return (this.options.chain.store.canonicalRange(Number(params.from ?? 0), Number(params.limit ?? 10)) ?? []).map(
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

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
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
    case 'CAPSULE':
      return encodeCapsuleBody(payload as never);
    case 'LAND':
      return encodeLandBody(payload as never);
    case 'SOCIAL':
      return encodeSocialBody(payload as never);
    case 'MINING_CLAIM':
      return encodeMiningBody(payload as never);
    case 'VALIDATOR':
      return encodeValidatorBody(payload as never);
    case 'TREASURY':
      return encodeTreasuryBody(payload as never);
    case 'ORACLE':
      return encodeOracleBody(payload as never);
    default:
      throw new Error(`unknown transaction type ${type}`);
  }
}

export function decodeBodyFor(type: string, bytes: Uint8Array): unknown {
  switch (type.toUpperCase()) {
    case 'PAYMENT':
      return decodePaymentBody(bytes);
    case 'ONS':
      return decodeOnsBody(bytes);
    case 'CAPSULE':
      return decodeCapsuleBody(bytes);
    case 'LAND':
      return decodeLandBody(bytes);
    case 'SOCIAL':
      return decodeSocialBody(bytes);
    case 'MINING_CLAIM':
      return decodeMiningBody(bytes);
    case 'VALIDATOR':
      return decodeValidatorBody(bytes);
    case 'TREASURY':
      return decodeTreasuryBody(bytes);
    case 'ORACLE':
      return decodeOracleBody(bytes);
    default:
      throw new Error(`unknown transaction type ${type}`);
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
