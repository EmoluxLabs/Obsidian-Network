/**
 * Peer-to-peer networking (protocol v1).
 *
 * Two nodes are on the same network if and only if they agree on:
 *   networkId, chainId, protocolVersion, paramsHash and genesisId —
 * and both prove control of their identity key with a signature over the
 * handshake. Anything else is refused before a single block is exchanged.
 *
 * Message flow
 *   connect → `challenge` (acceptor) → `hello` (dialer, signs the challenge)
 *           → `hello_ack` (acceptor, signs the dialer's nonce) → `status`
 *   sync    → `getblocks {from,limit}` → `blocks {blocks[]}` (only when asked for)
 *   gossip  → `newblock`, `newtx` (relayed once, deduplicated by hash)
 *   health  → `ping` / `pong` (both carry the sender's chain tip), `getaddr` / `addr`
 *
 * The handshake is challenge–response in BOTH directions, so a recorded hello
 * cannot be replayed to impersonate a node: the acceptor issues a fresh
 * challenge per connection and the dialer's signature covers it; the acceptor's
 * answer in turn covers the dialer's nonce. Nothing except `hello`, `hello_ack`
 * and `reject` is processed before the handshake completes.
 *
 * The transport is a WebSocket carrying JSON envelopes with hex-encoded
 * canonical block/transaction bytes. Payloads are bounded, every message is
 * schema-checked, and a peer that sends garbage or invalid blocks is penalised
 * and finally banned by the peer store.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { ChainManager } from '../blockchain/chain.js';
import { encodeBlock, decodeBlock, blockHash } from '../blockchain/block.js';
import { encodeSignedTx, decodeSignedTxFromBytes } from '../transactions/encode.js';
import { domainHash, utf8, toHex, fromHex, sha256Hex } from '../crypto/hash.js';
import { addressFromPublicKey, verifyDigest, signDigest } from '../crypto/keys.js';
import { DOMAIN } from '../protocol/domains.js';
import { ErrCode } from '../protocol/errors.js';
import { PARAMS_HASH } from '../blockchain/state-root.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { CORE_VERSION, MIN_CORE_VERSION, PROTOCOL_VERSION, compareVersions } from '../version.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import { parsePeerAddress, PeerStore, type PeerRecord } from './peer-store.js';
import { newLinkBudgets, type LinkBudgets } from './rate-limit.js';
import { compareTips } from '../consensus/proposer.js';
import type { Block, EquivocationEvidence, FinalityCertificate, FinalityVote, TxEnvelope } from '../protocol/types.js';
import { certificateShape, finalityVoteId } from '../consensus/finality.js';

export interface NodeIdentity {
  address: string;
  publicKey: string;
  privateKey: string;
}

export interface NodeDescriptor {
  nodeId: string;
  identity: string;
  publicKey: string;
  networkId: string;
  chainId: number;
  genesisId: string;
  protocolVersion: string;
  version: string;
  endpoints: { p2p: string; rpc: string };
  height: number;
  headHash: string;
  capabilities: string[];
  timestamp: number;
}

/** Canonical, order-stable preimage for the node descriptor signature. */
function descriptorPreimage(descriptor: NodeDescriptor): string {
  return [
    descriptor.nodeId,
    descriptor.identity,
    descriptor.publicKey,
    descriptor.networkId,
    String(descriptor.chainId),
    descriptor.genesisId,
    descriptor.protocolVersion,
    descriptor.version,
    descriptor.endpoints.p2p,
    descriptor.endpoints.rpc,
    String(descriptor.height),
    descriptor.headHash,
    [...descriptor.capabilities].sort().join(','),
    String(descriptor.timestamp),
  ].join('|');
}

export function signNodeDescriptor(identity: NodeIdentity, descriptor: NodeDescriptor): string {
  const digest = domainHash(DOMAIN.NODE_METADATA, utf8(descriptorPreimage(descriptor)));
  return toHex(signDigest(digest, identity.privateKey));
}

/**
 * Verify a node descriptor without trusting the transport it arrived on.
 * Used by the interface so a gateway (Cloudflare, nginx or anything else) can
 * never inject a fake node into the discovery list.
 */
export function verifyNodeDescriptor(
  descriptor: NodeDescriptor,
  signature: string,
  net: NetworkDefinition,
  options: { maxAgeSeconds?: number; now?: number } = {},
): { ok: boolean; reason?: string } {
  if (!descriptor || typeof descriptor !== 'object') return { ok: false, reason: 'descriptor is not an object' };
  if (descriptor.networkId !== net.networkId) return { ok: false, reason: `wrong networkId ${descriptor.networkId}` };
  if (descriptor.chainId !== net.chainId) return { ok: false, reason: `wrong chainId ${descriptor.chainId}` };
  // A compressed secp256k1 key is 33 bytes = 66 hex characters.
  if (!/^0[23][0-9a-f]{64}$/.test(descriptor.publicKey ?? '')) return { ok: false, reason: 'publicKey is not a compressed secp256k1 key' };
  const derived = addressFromPublicKey(descriptor.publicKey, net.addressHrp);
  if (derived !== descriptor.identity) return { ok: false, reason: 'identity does not match public key' };
  const maxAge = options.maxAgeSeconds ?? 900;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(descriptor.timestamp) || Math.abs(now - descriptor.timestamp) > maxAge) {
    return { ok: false, reason: 'descriptor is outside its validity window' };
  }
  if (!descriptor.genesisId || !/^[0-9a-f]{8,}$/.test(descriptor.genesisId)) {
    return { ok: false, reason: 'missing genesisId' };
  }
  const digest = domainHash(DOMAIN.NODE_METADATA, utf8(descriptorPreimage(descriptor)));
  if (!verifyDigest(digest, signature, descriptor.publicKey)) return { ok: false, reason: 'signature does not verify' };
  return { ok: true };
}

// ── Wire protocol ─────────────────────────────────────────────────────────────

const WIRE_VERSION = 1;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 12_000;
const PING_INTERVAL_MS = 20_000;
/** Most blocks one `blocks` message may carry (the wire's own bound: 128 blocks stay far under MAX_PAYLOAD_BYTES). */
const MAX_SYNC_BATCH = 128;
/** A node that keeps dialling a peer of another network is told once per this long, not on every retry. */
const IDENTITY_REPORT_WINDOW_MS = 10 * 60_000;

/** Before the handshake completes a peer may only send a hello: nothing needs more than this. */
const MAX_PRE_HANDSHAKE_BYTES = 64 * 1024;
/** Inbound connections one remote address may hold at once (loopback is exempt: devnet runs on one host). */
const MAX_INBOUND_PER_IP = 8;
/** How long an address that kept violating the protocol stays refused. */
const IP_BAN_MS = 10 * 60 * 1000;
/** Minimum gap between two sync attempts against one peer that produced nothing. */
const SYNC_RETRY_GAP_MS = 3_000;
/** The per-batch fields of a sync log line. */
function batchFields(outcome: BatchOutcome): Record<string, unknown> {
  return {
    requestedFrom: outcome.from,
    limit: outcome.limit,
    returned: outcome.returned,
    more: outcome.more,
    firstHeight: outcome.firstHeight,
    firstHash: outcome.firstHash,
    lastHeight: outcome.lastHeight,
    lastHash: outcome.lastHash,
    accepted: outcome.accepted,
    duplicates: outcome.duplicates,
    stale: outcome.stale,
    orphans: outcome.orphans,
    rejectedCode: outcome.rejected?.code ?? null,
    rejectedMessage: outcome.rejected?.message ?? null,
    malformed: outcome.malformed,
    timedOut: outcome.timedOut,
    disconnected: outcome.disconnected,
  };
}

/** How long a `getblocks` waits for its answer. */
const DEFAULT_SYNC_TIMEOUT_MS = 15_000;
/** How long the id of an answered or abandoned request is remembered, so a late repeat is recognised. */
const SETTLED_BATCH_TTL_MS = 120_000;
const MAX_SETTLED_BATCHES = 32;

function emptyOutcome(request: { id: string; from: number; limit: number }): BatchOutcome {
  return {
    id: request.id,
    from: request.from,
    limit: request.limit,
    returned: 0,
    more: false,
    firstHeight: null,
    firstHash: null,
    lastHeight: null,
    lastHash: null,
    accepted: 0,
    duplicates: 0,
    stale: 0,
    orphans: 0,
    rejected: null,
    malformed: null,
    timedOut: false,
    disconnected: false,
  };
}

export interface P2PMessage {
  v: number;
  t: string;
  [key: string]: unknown;
}

interface PeerLink {
  address: string;
  inbound: boolean;
  /** IP we actually see this peer at — used when it advertises a wildcard host. */
  remoteIp: string;
  socket: WebSocket;
  nodeId: string;
  identity: string;
  hello: HelloPayload | null;
  height: number;
  headHash: string;
  /** PoT weight the peer last reported for its tip (fork choice compares weight first). */
  weight: bigint;
  score: number;
  lastPong: number;
  handshakeTimer: NodeJS.Timeout | null;
  syncing: boolean;
  /** Challenge WE issued on an inbound link; the dialer's hello must sign it. */
  challenge: string;
  /** Nonce WE put in our hello on an outbound link; the acceptor's answer must sign it. */
  sentNonce: string;
  /** The one `getblocks` request in flight on this link, or null. Registered BEFORE the request is sent. */
  pending: PendingBatch | null;
  /** Ids of requests already answered or given up on, so a late or repeated answer is dropped, not punished. */
  settledBatches: Map<string, number>;
  /** An uncorrelated (old-peer) `blocks` message is ignored without penalty until this time. */
  lateBatchUntil: number;
  /** When the last unproductive sync attempt against this peer happened. */
  lastSyncMiss: number;
  budgets: LinkBudgets;
}

/** What one `getblocks` round trip came to. Everything here is local fact, nothing is taken from the peer unverified. */
export interface BatchOutcome {
  id: string;
  from: number;
  limit: number;
  /** Blocks the peer sent. */
  returned: number;
  /** The peer's own `more` flag. */
  more: boolean;
  firstHeight: number | null;
  firstHash: string | null;
  lastHeight: number | null;
  lastHash: string | null;
  accepted: number;
  duplicates: number;
  stale: number;
  orphans: number;
  /** The first block that failed validation, if any. The peer was already penalised for it. */
  rejected: { code: string; message: string; height: number; hash: string } | null;
  /** Why the whole reply was unusable (undecodable, oversized), if it was. The peer was already penalised. */
  malformed: string | null;
  timedOut: boolean;
  disconnected: boolean;
}

interface PendingBatch {
  id: string;
  from: number;
  limit: number;
  settle: (outcome: BatchOutcome) => void;
}

export interface HelloPayload {
  nodeId: string;
  identity: string;
  publicKey: string;
  networkId: string;
  chainId: number;
  genesisId: string;
  paramsHash: string;
  protocolVersion: string;
  version: string;
  listenHost: string;
  listenPort: number;
  rpcPort: number;
  height: number;
  headHash: string;
  /** PoT weight of the sender's tip, as a decimal string (bigint does not survive JSON). */
  weight: string;
  finalizedHeight: number;
  finalizedHash: string;
  capabilities: string[];
  timestamp: number;
  nonce: string;
  /**
   * The value being answered: on a `hello`, the challenge the acceptor issued;
   * on a `hello_ack`, the nonce from the dialer's hello. Inside the signed
   * preimage, so a recorded handshake is useless on any other connection.
   */
  challenge: string;
}

function helloPreimage(hello: HelloPayload): string {
  return [
    hello.nodeId,
    hello.identity,
    hello.publicKey,
    hello.networkId,
    String(hello.chainId),
    hello.genesisId,
    hello.paramsHash,
    hello.protocolVersion,
    hello.version,
    hello.listenHost,
    String(hello.listenPort),
    String(hello.rpcPort),
    String(hello.height),
    hello.headHash,
    hello.weight,
    String(hello.finalizedHeight),
    hello.finalizedHash,
    [...hello.capabilities].sort().join(','),
    String(hello.timestamp),
    hello.nonce,
    hello.challenge,
  ].join('|');
}

export function helloDigest(hello: HelloPayload): Uint8Array {
  return domainHash(DOMAIN.PEER_HELLO, utf8(helloPreimage(hello)));
}

export interface P2PServiceOptions {
  chain: ChainManager;
  net: NetworkDefinition;
  peers: PeerStore;
  identity: { nodeId: string; publicKey: string; privateKey: string; address?: string };
  nodeName?: string;
  maxPeers?: number;
  maxInboundPeers?: number;
  /** `host:port` this node advertises to the network. */
  listenAddress?: string;
  genesisId?: string;
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** Called when a peer sends a transaction we accept into the mempool. */
  onTransaction?: (tx: TxEnvelope) => void;
  now?: () => number;
  /**
   * Blocks asked for, and served, per `getblocks` (1..128, default 128). A smaller value is for tests and for
   * constrained nodes: the sync loop is correct for ANY value on either side, which the tests prove with 8.
   */
  syncBatch?: number;
  /** How long to wait for the answer to one `getblocks` (default 15 s, minimum 50 ms). */
  syncTimeoutMs?: number;
}

export interface PeerView {
  address: string;
  nodeId: string;
  identity: string;
  version: string;
  height: number;
  inbound: boolean;
  score: number;
  direction: 'in' | 'out';
}

export class P2PService extends EventEmitter {
  private readonly chain: ChainManager;
  private readonly net: NetworkDefinition;
  private readonly identity: NodeIdentity;
  private readonly peers: PeerStore;
  private readonly links = new Map<string, PeerLink>();
  /** When each (address, refusal) was last reported to the operator, so a bad seed warns once, not on every retry. */
  private readonly identityReported = new Map<string, number>();
  private readonly nodeId: string;
  private readonly nodeName: string;
  private readonly now: () => number;
  private readonly syncBatch: number;
  private readonly syncTimeoutMs: number;
  private readonly sink: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  private host = '0.0.0.0';
  private port = 0;
  private advertiseHost = '';
  private advertisePort = 0;
  private maxInbound: number;
  private maxOutbound: number;
  private readonly dialing = new Set<string>();
  private server: WebSocketServer | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private readonly relayedBlocks = new Set<string>();
  private readonly relayedTxs = new Set<string>();
  private readonly relayedFinalityVotes = new Set<string>();
  private readonly relayedCertificates = new Set<string>();
  private readonly relayedEvidence = new Set<string>();
  private readonly pendingFinalityCertificates = new Map<string,{certificate:FinalityCertificate;link:PeerLink}>();
  /** Remote addresses refused for a while after they kept violating the protocol. */
  private readonly bannedIps = new Map<string, number>();
  private readonly onTransaction?: (tx: TxEnvelope) => void;

  constructor(options: P2PServiceOptions) {
    super();
    this.chain = options.chain;
    this.net = options.net;
    this.peers = options.peers;
    this.onTransaction = options.onTransaction;
    this.now = options.now ?? (() => Date.now());
    this.syncBatch = Number.isInteger(options.syncBatch) ? Math.min(MAX_SYNC_BATCH, Math.max(1, options.syncBatch as number)) : MAX_SYNC_BATCH;
    this.syncTimeoutMs = Number.isFinite(options.syncTimeoutMs) ? Math.max(50, options.syncTimeoutMs as number) : DEFAULT_SYNC_TIMEOUT_MS;
    const address = options.identity.address ?? addressFromPublicKey(options.identity.publicKey, options.net.addressHrp);
    this.identity = { address, publicKey: options.identity.publicKey, privateKey: options.identity.privateKey };
    this.nodeId = options.identity.nodeId || nodeIdFor(address, options.chain.genesisId);
    this.nodeName = options.nodeName ?? `obsidian-${address.slice(-6)}`;
    this.sink = options.log ?? (() => undefined);
    const advertised = (options.listenAddress ?? '').trim();
    if (advertised) {
      try {
        const parsed = parsePeerAddress(advertised);
        this.advertiseHost = parsed.host === '0.0.0.0' ? '' : parsed.host;
        this.advertisePort = parsed.port;
      } catch {
        this.sink('warn', 'ignoring malformed listenAddress', { listenAddress: advertised });
      }
    }
    this.maxInbound = options.maxInboundPeers ?? 64;
    this.maxOutbound = Math.max(2, Math.min(options.maxPeers ?? 16, 32));
    this.chain.on('finality-vote',(vote:FinalityVote)=>this.announceFinalityVote(vote));
    this.chain.on('block',(block:Block)=>this.castFinalityVote(blockHash(block.header)));
    this.chain.on('finalized',(certificate:FinalityCertificate)=>{this.announceFinalityCertificate(certificate);this.castFinalityVote();});
    this.chain.on('equivocation',(evidence:EquivocationEvidence)=>this.announceEvidence(evidence));
    this.castFinalityVote();
  }

  /** Tiny adapter so the service can log through a plain callback. */
  private readonly log = {
    debug: (message: string, fields?: Record<string, unknown>) => this.sink('debug', message, fields),
    info: (message: string, fields?: Record<string, unknown>) => this.sink('info', message, fields),
    warn: (message: string, fields?: Record<string, unknown>) => this.sink('warn', message, fields),
    error: (message: string, fields?: Record<string, unknown>) => this.sink('error', message, fields),
  };

  get identityAddress(): string {
    return this.identity.address;
  }

  /** Number of live peer connections (bounded by maxInbound + maxOutbound). */
  get peerCount(): number {
    return this.links.size;
  }

  /** Live connections, newest state first — used by the API and the operator UI. */
  activeConnections(): Array<{ address: string; nodeId: string; height: number; inbound: boolean; version: string }> {
    return [...this.links.values()].map((link) => ({
      address: link.address,
      nodeId: link.nodeId,
      height: link.height,
      inbound: link.inbound,
      version: link.hello?.version ?? '',
    }));
  }

  /** Every peer hint this node knows, including ones it is not connected to. */
  knownPeers(): PeerRecord[] {
    return this.peers.all();
  }

  status(): Record<string, unknown> {
    const connected = this.activeConnections();
    return {
      nodeId: this.nodeId,
      name: this.nodeName,
      identity: this.identity.address,
      genesisId: this.chain.genesisId,
      listening: Boolean(this.server),
      endpoint: this.server ? `ws://${this.advertiseHost || this.host}:${this.port}` : 'not listening',
      peers: {
        connected: connected.length,
        inbound: connected.filter((peer) => peer.inbound).length,
        outbound: connected.filter((peer) => !peer.inbound).length,
        known: this.peers.size,
        height: connected.reduce((max, peer) => Math.max(max, peer.height), 0),
      },
      wireProtocol: WIRE_VERSION,
    };
  }

  /**
   * Signed self-description of this node, verifiable by anyone who knows the
   * network. A gateway can relay it, but it cannot forge it.
   */
  announcement(rpcUrl?: string, p2pUrl?: string): { descriptor: NodeDescriptor; signature: string } {
    const descriptor = this.descriptor(rpcUrl, p2pUrl);
    return { descriptor, signature: signNodeDescriptor(this.identity, descriptor) };
  }

  /** Listen for inbound peers. Called by the node; safe to skip (isolated mode). */
  async listen(port?: number, host?: string): Promise<number> {
    if (port) this.port = port;
    if (host) this.host = host;
    if (!this.server) {
      await this.listenInternal();
      // The maintenance loops must start with the listener, not only with
      // `start()`: without them a node never re-dials a seed that came online
      // late, never prunes stale peers and never pings (so it cannot detect a
      // half-open connection to a crashed peer). Idempotent: a second call is a
      // no-op because the interval list is already populated.
      this.scheduleLoops();
      void this.maintainPeers();
    }
    return this.port;
  }

  /**
   * Dial a peer. `source` only affects bookkeeping: seeds and operator-supplied
   * nodes are never pruned, gossiped peers can be.
   */
  async connectTo(address: string, source: 'seed' | 'manual' | 'gossip' = 'gossip'): Promise<void> {
    const record = source === 'seed' || source === 'manual' ? this.peers.addSeed(address) : this.peers.addManual(address);
    if (record) await this.dial(record);
  }

  /** Ask the connected peer with the best chain for anything we are missing. */
  requestSyncFromPeers(): void {
    const best = this.bestPeer();
    if (best) void this.syncFrom(best);
  }

  /**
   * Does this peer hold a chain that beats ours under the fork-choice rule?
   * Comparing HEIGHT alone is wrong: fork choice ranks PoT weight first, so a
   * peer with a heavier chain at a lower height is the one to follow.
   */
  private peerIsBetter(link: PeerLink): boolean {
    if (!link.hello) return false;
    const tip = this.chain.tip;
    if (!tip) return link.height > 0;
    return (
      compareTips(
        { height: link.height, cumulativePotWeight: link.weight, hash: link.headHash || '~' },
        { height: tip.height, cumulativePotWeight: BigInt(tip.cumulativePotWeight), hash: tip.hash },
      ) > 0
    );
  }

  /**
   * How many blocks the best connected peer is ahead of us (0 when none is).
   * The node's producer loop reads this: a node that is still catching up must
   * not mint blocks on top of a stale head.
   */
  behindBy(): number {
    const best = this.bestPeer();
    return best ? Math.max(0, best.height - this.chain.height) : 0;
  }

  private bestPeer(): PeerLink | undefined {
    return [...this.links.values()]
      .filter((link) => this.peerIsBetter(link))
      .sort((a, b) => (a.weight === b.weight ? b.height - a.height : a.weight > b.weight ? -1 : 1))[0];
  }

  /** Fold a tip a peer reported (status, pong, an announced block) into what we know of it. */
  private noteTip(link: PeerLink, height: number, weight: bigint, headHash: string): void {
    if (!Number.isInteger(height) || height < 0) return;
    link.height = height;
    link.weight = weight;
    link.headHash = headHash;
    this.peers.recordHeight(link.address, height);
  }

  private castFinalityVote(target?:string):void { if(this.chain.isSyncing)return; const vote=this.chain.createFinalityVote(this.identity,target); if(vote)this.chain.addFinalityVote(vote); }

  broadcastBlock(block: Block): void {
    this.announceBlock(block);
  }

  broadcastTransaction(tx: TxEnvelope): void {
    this.announceTransaction(tx);
  }

  get id(): string {
    return this.nodeId;
  }

  listenerCountPeers(): number {
    return this.links.size;
  }

  peerViews(): PeerView[] {
    return [...this.links.values()].map((link) => ({
      address: link.address,
      nodeId: link.nodeId,
      identity: link.identity,
      version: link.hello?.version ?? '',
      height: link.height,
      inbound: link.inbound,
      score: link.score,
      direction: link.inbound ? ('in' as const) : ('out' as const),
    }));
  }

  /** Signed, self-describing node record served over RPC for discovery. */
  descriptor(rpcEndpoint = '', p2pEndpoint = ''): NodeDescriptor {
    return {
      nodeId: this.nodeId,
      identity: this.identity.address,
      publicKey: this.identity.publicKey,
      networkId: this.net.networkId,
      chainId: this.net.chainId,
      genesisId: this.chain.genesisId,
      protocolVersion: PROTOCOL_VERSION,
      version: CORE_VERSION,
      endpoints: {
        p2p: p2pEndpoint || `${this.advertiseHost || this.host}:${this.advertisePort || this.port}`,
        rpc: rpcEndpoint ?? '',
      },
      height: this.chain.height,
      headHash: this.chain.tip?.hash ?? '',
      capabilities: ['sync', 'gossip', 'rpc'],
      timestamp: Math.floor(this.now() / 1000),
    };
  }

  /** Open the listener and start the peer-maintenance loops. */
  async start(port?: number, host?: string): Promise<void> {
    await this.listen(port, host);
  }

  private async listenInternal(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.host,
        port: this.port,
        maxPayload: MAX_PAYLOAD_BYTES,
        perMessageDeflate: false,
        clientTracking: true,
      });
      server.on('listening', () => {
        this.server = server;
        this.log.info('p2p listening', {
          host: this.host,
          port: this.port,
          nodeId: this.nodeId,
          identity: this.identity.address,
          genesisId: this.chain.genesisId,
        });
        resolve();
      });
      server.on('error', (error) => {
        if (!this.server) reject(error);
        else this.log.warn('p2p server error', { message: (error as Error).message });
      });
      server.on('connection', (socket, request) => {
        const remote = request.socket.remoteAddress ?? 'unknown';
        const port = request.socket.remotePort ?? 0;
        this.accept(socket, `${remote}:${port}`, true, remote);
      });
    });
  }

  private scheduleLoops(): void {
    if (this.timers.length > 0) return;
    this.timers.push(setInterval(() => void this.maintainPeers(), 15_000).unref());
    this.timers.push(setInterval(() => this.pingAll(), PING_INTERVAL_MS).unref());
    this.timers.push(setInterval(() => this.pruneRelaySets(), 60_000).unref());
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const link of this.links.values()) {
      if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
      try {
        link.socket.close(1001, 'node shutting down');
      } catch {
        /* ignore */
      }
    }
    this.links.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    this.peers.persist();
  }

  // ── Peer maintenance ───────────────────────────────────────────────────────

  private async maintainPeers(): Promise<void> {
    if (this.stopping) return;
    this.peers.pruneStale();
    this.peers.persist();

    {
      const outbound = [...this.links.values()].filter((link) => !link.inbound).length;
      const target = Math.max(2, Math.min(this.maxOutbound, 8));
      if (outbound < target) {
        const connected = new Set([...this.links.values()].map((link) => link.address));
        // Operator-configured seeds come first: if a seed was offline when this
        // node booted it must still be retried once it comes back, even when
        // gossip has already supplied us with plenty of other peers.
        const seeds = this.peers
          .dialable(64)
          .filter((record) => record.source === 'seed' && !connected.has(record.address));
        const rest = this.peers.dialable(32).filter((record) => record.source !== 'seed' && !connected.has(record.address));
        const candidates = [...seeds, ...rest].slice(0, target - outbound);
        for (const record of candidates) void this.dial(record);
      }
    }

    // Keep in touch with the best peer and pull anything we are missing.
    const best = this.bestPeer();
    if (best) void this.syncFrom(best);
  }

  private async dial(record: PeerRecord): Promise<void> {
    // Never dial an address we are already dialling or already connected to:
    // the boot-time seed dial and the first maintenance sweep would otherwise
    // open two sockets to the same peer and double-count failures against it.
    if (this.dialing.has(record.address)) return;
    if (this.links.size > 0) {
      const connected = [...this.links.values()];
      if (connected.some((link) => link.address === record.address)) return;
      // A peer we know by nodeId is already connected, whatever address we
      // learned for it this time.
      if (record.nodeId && connected.some((link) => link.nodeId === record.nodeId)) return;
    }

    const url = `ws://${record.host}:${record.port}`;
    this.dialing.add(record.address);
    this.peers.recordAttempt(record.address);
    try {
      await this.dialOnce(record, url);
    } finally {
      this.dialing.delete(record.address);
    }
  }

  private async dialOnce(record: PeerRecord, url: string): Promise<void> {
    await new Promise<void>((resolve) => {
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, { handshakeTimeout: 8_000, maxPayload: MAX_PAYLOAD_BYTES });
      } catch (error) {
        this.peers.recordFailure(record.address, 'handshake');
        this.log.debug('dial failed', { address: record.address, message: (error as Error).message });
        resolve();
        return;
      }
      const done = () => resolve();
      let opened = false;
      socket.on('open', () => {
        opened = true;
        this.accept(socket, record.address, false, record.host);
        done();
      });
      socket.on('error', (error) => {
        // Only a failure to CONNECT counts against the address. A reset on a
        // link that was working is the link ending, not the peer misbehaving.
        if (!opened) {
          this.peers.recordFailure(record.address, 'handshake');
          this.log.debug('dial error', { address: record.address, message: (error as Error).message });
        }
        done();
      });
    });
  }

  // ── Connection handling ────────────────────────────────────────────────────

  private accept(socket: WebSocket, address: string, inbound: boolean, remoteIp = ''): void {
    const ip = normaliseIp(remoteIp);
    if (inbound) {
      const refuse = (reason: string): void => {
        try {
          socket.close(1013, reason);
        } catch {
          /* ignore */
        }
      };
      if (this.isIpBanned(ip)) return refuse('address temporarily refused');
      if (this.links.size >= this.maxInbound + this.maxOutbound) return refuse('connection limit reached');
      if (!isLoopback(ip) && [...this.links.values()].filter((other) => other.inbound && other.remoteIp === ip).length >= MAX_INBOUND_PER_IP) {
        return refuse('too many connections from this address');
      }
    }
    const key = `${address}#${randomBytes(4).toString('hex')}`;
    const link: PeerLink = {
      address,
      inbound,
      remoteIp: ip,
      socket,
      nodeId: '',
      identity: '',
      hello: null,
      height: 0,
      headHash: '',
      weight: 0n,
      score: 0,
      lastPong: this.now(),
      handshakeTimer: setTimeout(() => {
        this.log.debug('handshake timeout', { address });
        socket.close(1002, 'handshake timeout');
      }, HANDSHAKE_TIMEOUT_MS),
      syncing: false,
      challenge: randomBytes(16).toString('hex'),
      sentNonce: '',
      pending: null,
      settledBatches: new Map(),
      lateBatchUntil: 0,
      lastSyncMiss: 0,
      budgets: newLinkBudgets(this.now),
    };
    this.links.set(key, link);

    socket.on('message', (data: RawData) => this.onMessage(key, link, data));
    socket.on('close', () => this.dropLink(key, link));
    socket.on('error', () => this.dropLink(key, link));

    // The acceptor speaks first with a fresh challenge. The dialer's hello must
    // sign it, which is what makes a recorded hello worthless on any other
    // connection. (The dialer sends nothing until it has the challenge.)
    if (inbound) this.send(link, { v: WIRE_VERSION, t: 'challenge', challenge: link.challenge });
  }

  private isIpBanned(ip: string): boolean {
    const until = this.bannedIps.get(ip);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.bannedIps.delete(ip);
      return false;
    }
    return true;
  }

  private banIp(ip: string, reason: string): void {
    if (!ip || isLoopback(ip)) return;
    this.bannedIps.set(ip, this.now() + IP_BAN_MS);
    if (this.bannedIps.size > 2_000) {
      for (const [address, until] of this.bannedIps) if (until <= this.now()) this.bannedIps.delete(address);
    }
    this.log.info('peer address refused for a while', { ip, reason, minutes: IP_BAN_MS / 60_000 });
  }

  private dropLink(key: string, link: PeerLink): void {
    if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
    this.links.delete(key);
    if (link.pending) {
      const pending = link.pending;
      link.pending = null;
      this.rememberBatch(link, pending.id);
      pending.settle({ ...emptyOutcome(pending), disconnected: true });
    }
    if (link.hello) {
      this.log.debug('peer disconnected', { address: link.address, nodeId: link.nodeId });
    }
  }

  /**
   * Our signed hello. `answering` is the value this message responds to: the
   * acceptor's challenge when we are dialling, or the dialer's nonce when we are
   * the acceptor answering its hello. It is inside the signed preimage.
   */
  private helloMessage(answering: string): P2PMessage {
    const tip = this.chain.tip;
    const hello: HelloPayload = {
      nodeId: this.nodeId,
      identity: this.identity.address,
      publicKey: this.identity.publicKey,
      networkId: this.net.networkId,
      chainId: this.net.chainId,
      genesisId: this.chain.genesisId,
      paramsHash: PARAMS_HASH,
      protocolVersion: PROTOCOL_VERSION,
      version: CORE_VERSION,
      listenHost: this.advertiseHost || this.host,
      listenPort: this.advertisePort || this.port,
      rpcPort: 0,
      height: this.chain.height,
      headHash: tip?.hash ?? '',
      weight: tip?.cumulativePotWeight ?? '0',
      finalizedHeight: this.chain.finalityStatus().finalizedHeight,
      finalizedHash: this.chain.finalityStatus().finalizedHash,
      capabilities: ['sync', 'gossip', 'finality'],
      timestamp: Math.floor(this.now() / 1000),
      nonce: randomBytes(16).toString('hex'),
      challenge: answering,
    };
    const signature = toHex(signDigest(helloDigest(hello), this.identity.privateKey));
    return { v: WIRE_VERSION, t: 'hello', hello, signature };
  }

  /** Our current tip, as carried by `status`, `ping` and `pong`. */
  private tipFields(): { height: number; headHash: string; weight: string; finalizedHeight:number; finalizedHash:string } {
    const tip = this.chain.tip, finality=this.chain.finalityStatus();
    return { height: this.chain.height, headHash: tip?.hash ?? '', weight: tip?.cumulativePotWeight ?? '0', finalizedHeight:finality.finalizedHeight, finalizedHash:finality.finalizedHash };
  }

  private send(link: PeerLink, message: P2PMessage): void {
    try {
      link.socket.send(JSON.stringify(message));
    } catch (error) {
      this.log.debug('send failed', { address: link.address, message: (error as Error).message });
    }
  }

  /**
   * Say, where an operator will see it, that a node this one DIALLED follows another network or version.
   *
   * The refusal itself has always worked, but it was invisible: the rejected side logged at debug and the
   * rejecting side logged nothing, so a node whose `--seeds` named a node of another network (the easiest way
   * to mix two networks up: paste a seed from the wrong guide) sat at `peers: 0` with a clean log and no
   * hint why. An inbound refusal stays quiet: on a public port it is other networks and scanners, not a
   * mistake of the operator's. An outbound one is reported once per address and refusal per ten minutes.
   */
  private reportIdentityMismatch(link: PeerLink, code: ErrCode | string, detail: string): void {
    if (link.inbound) return;
    const key = `${link.address}|${code}`;
    const now = this.now();
    const last = this.identityReported.get(key);
    if (last !== undefined && now - last < IDENTITY_REPORT_WINDOW_MS) return;
    this.identityReported.set(key, now);
    this.log.warn(
      `the node at ${link.address} is on another network or version than this one (${this.net.networkId}), so it was not accepted as a peer: ` +
        'check that --seeds / OBSIDIAN_SEED_NODES name nodes on THIS network, using their P2P port',
      { address: link.address, code, detail, ourNetwork: this.net.networkId, ourVersion: CORE_VERSION },
    );
  }

  private reject(link: PeerLink, code: ErrCode | string, message: string, fatal = true): void {
    this.send(link, { v: WIRE_VERSION, t: 'reject', code, message });
    if (fatal) {
      link.socket.close(1008, String(code).slice(0, 100));
    }
  }

  // ── Message dispatch ───────────────────────────────────────────────────────

  private onMessage(key: string, link: PeerLink, data: RawData): void {
    const size = rawSize(data);
    // Before the handshake completes a peer may only introduce itself. Nothing
    // legitimate needs more than a few kilobytes for that, and an
    // unauthenticated peer must not be able to make this node parse megabytes.
    if (!link.hello && size > MAX_PRE_HANDSHAKE_BYTES) {
      this.penalise(link, 'malformed', 'oversized message before the handshake');
      link.socket.close(1009, 'message too large before handshake');
      return;
    }
    let message: P2PMessage;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      message = JSON.parse(text) as P2PMessage;
      if (!message || typeof message !== 'object' || typeof message.t !== 'string') {
        throw new Error('malformed envelope');
      }
    } catch {
      this.penalise(link, 'malformed', 'message is not a valid JSON envelope');
      return;
    }

    // Handshake gate: until `hello`/`hello_ack` has been verified the only
    // messages that mean anything are the handshake itself and `reject`.
    if (!link.hello && message.t !== 'hello' && message.t !== 'hello_ack' && message.t !== 'challenge' && message.t !== 'reject') {
      this.penalise(link, 'malformed', `"${message.t}" before the handshake completed`);
      return;
    }

    // Per-link budgets. Each message makes this node do work, and a peer's
    // messages are free to send, so the work one peer may demand per second is
    // capped here, by the receiver.
    const bucket =
      message.t === 'newtx' ? link.budgets.tx : message.t === 'newblock' || message.t === 'blocks' ? link.budgets.block : link.budgets.control;
    const signatureCost=message.t==='finality_certificate'?Math.max(1,Math.ceil((Array.isArray((message.certificate as {votes?:unknown[]}|undefined)?.votes)?(message.certificate as {votes:unknown[]}).votes.length:1)/8)):message.t==='equivocation'?2:1;
    if (!bucket.take(signatureCost + Math.floor(size / 65_536))) {
      link.score -= 3;
      this.log.debug('peer over its message budget; message dropped', { address: link.address, type: message.t, score: link.score });
      if (link.score < -100) this.dropAbusiveLink(link, 'message flood');
      return;
    }

    try {
      switch (message.t) {
        case 'challenge':
          this.handleChallenge(link, message);
          break;
        case 'hello':
          this.handleHello(link, message);
          break;
        case 'hello_ack':
          this.handleHello(link, message);
          this.send(link, { v: WIRE_VERSION, t: 'status', ...this.tipFields() });
          break;
        case 'ping':
          this.send(link, { v: WIRE_VERSION, t: 'pong', ts: Math.floor(this.now() / 1000), ...this.tipFields() });
          this.handleTipFields(link, message);
          break;
        case 'pong':
          link.lastPong = this.now();
          this.handleTipFields(link, message);
          break;
        case 'status':
          this.handleStatus(link, message);
          break;
        case 'getblocks':
          this.handleGetBlocks(link, message);
          break;
        case 'blocks':
          this.handleBlocks(link, message);
          break;
        case 'newblock':
          this.handleNewBlock(link, message);
          break;
        case 'newtx':
          this.handleNewTx(link, message);
          break;
        case 'finality_vote':
          this.handleFinalityVote(link,message);
          break;
        case 'finality_certificate':
          this.handleFinalityCertificate(link,message);
          break;
        case 'equivocation':
          this.handleEvidence(link,message);
          break;
        case 'getfinality': { const certificate=this.chain.latestFinalityCertificate(); if(certificate) this.send(link,{v:WIRE_VERSION,t:'finality_certificate',certificate}); break; }
        case 'getaddr':
          this.send(link, { v: WIRE_VERSION, t: 'addr', peers: this.peers.gossipSample(32) });
          break;
        case 'addr':
          this.handleAddr(link, message);
          break;
        case 'reject': {
          const code = String(message.code ?? '');
          if (code === ErrCode.WRONG_NETWORK || code === ErrCode.WRONG_CHAIN_ID || code === ErrCode.VERSION_MISMATCH) {
            this.reportIdentityMismatch(link, code, `it refused this node: ${String(message.message ?? code)}`);
          }
          this.log.debug('peer rejected us', { address: link.address, code: message.code, message: message.message });
          break;
        }
        default:
          this.penalise(link, 'malformed', `unknown message type "${message.t}"`);
      }
    } catch (error) {
      this.penalise(link, 'malformed', (error as Error).message);
    }
    void key;
  }

  private penalise(
    link: PeerLink,
    kind: 'invalid-block' | 'malformed' | 'handshake' | 'invalid-tx' | 'minor',
    reason: string,
  ): void {
    link.score -= kind === 'invalid-block' ? 40 : kind === 'invalid-tx' || kind === 'minor' ? 10 : 25;
    this.peers.recordFailure(link.address, kind);
    this.log.debug('peer penalised', { address: link.address, kind, reason, score: link.score });
    if (link.score < -100) this.dropAbusiveLink(link, reason);
  }

  /** Close a link that has run out of credit, and refuse its address for a while. */
  private dropAbusiveLink(link: PeerLink, reason: string): void {
    this.banIp(link.remoteIp, reason);
    this.reject(link, ErrCode.RATE_LIMITED, 'too many protocol violations');
  }

  /** Dialer side: the acceptor spoke first; answer with a hello that signs its challenge. */
  private handleChallenge(link: PeerLink, message: P2PMessage): void {
    if (link.inbound || link.sentNonce) {
      this.penalise(link, 'malformed', 'unexpected challenge');
      return;
    }
    const challenge = String(message.challenge ?? '');
    if (!/^[0-9a-f]{32}$/.test(challenge)) {
      this.penalise(link, 'handshake', 'malformed challenge');
      return;
    }
    const hello = this.helloMessage(challenge);
    link.sentNonce = (hello.hello as HelloPayload).nonce;
    this.send(link, hello);
  }

  private handleHello(link: PeerLink, message: P2PMessage): void {
    const hello = message.hello as HelloPayload | undefined;
    const signature = String(message.signature ?? '');
    if (!hello || typeof hello !== 'object') {
      this.penalise(link, 'handshake', 'missing hello payload');
      return;
    }
    if (message.t === 'hello' && !link.inbound) {
      this.penalise(link, 'handshake', 'unexpected hello on an outbound link');
      return;
    }
    if (message.t === 'hello_ack' && link.inbound) {
      this.penalise(link, 'handshake', 'unexpected hello_ack on an inbound link');
      return;
    }
    if (!Number.isInteger(hello.finalizedHeight)||hello.finalizedHeight<0||hello.finalizedHeight>hello.height||typeof hello.finalizedHash!=='string'||!/^[0-9a-f]{64}$/.test(hello.finalizedHash)) {
      this.reject(link,ErrCode.MALFORMED,'invalid finality checkpoint in handshake'); return;
    }
    if (!Number.isFinite(hello.timestamp) || Math.abs(Math.floor(this.now() / 1000) - hello.timestamp) > 300) {
      this.reject(link, ErrCode.BAD_TIMESTAMP, 'handshake timestamp outside ±300s');
      return;
    }
    if (hello.genesisId !== this.chain.genesisId) {
      this.reportIdentityMismatch(link, ErrCode.WRONG_NETWORK, `it follows network ${String(hello.networkId)} (genesis ${String(hello.genesisId).slice(0, 12)}…)`);
      this.reject(link, ErrCode.WRONG_NETWORK, 'genesis id mismatch');
      return;
    }
    if (hello.chainId !== this.net.chainId || hello.networkId !== this.net.networkId) {
      this.reportIdentityMismatch(link, ErrCode.WRONG_CHAIN_ID, `it follows network ${String(hello.networkId)}, chain ${String(hello.chainId)}`);
      this.reject(link, ErrCode.WRONG_CHAIN_ID, 'chain/network id mismatch');
      return;
    }
    if (hello.paramsHash !== PARAMS_HASH) {
      this.reportIdentityMismatch(link, ErrCode.VERSION_MISMATCH, 'its consensus parameter set differs');
      this.reject(link, ErrCode.VERSION_MISMATCH, 'consensus parameter set mismatch');
      return;
    }
    if (compareVersions(hello.protocolVersion, PROTOCOL_VERSION) !== 0) {
      this.reportIdentityMismatch(link, ErrCode.VERSION_MISMATCH, `its protocol version is ${String(hello.protocolVersion)}`);
      this.reject(link, ErrCode.VERSION_MISMATCH, `protocol version ${hello.protocolVersion} is incompatible`);
      return;
    }
    if (compareVersions(hello.version, MIN_CORE_VERSION) < 0) {
      this.reportIdentityMismatch(link, ErrCode.VERSION_MISMATCH, `its core version is ${String(hello.version)}`);
      this.reject(link, ErrCode.VERSION_MISMATCH, `peer core ${hello.version} is older than the minimum ${MIN_CORE_VERSION}`);
      return;
    }
    if (compareVersions(hello.version, CORE_VERSION) > 0) {
      this.log.debug('peer runs a newer core', { address: link.address, version: hello.version });
    }
    if (hello.identity === this.identity.address) {
      this.reject(link, ErrCode.MALFORMED, 'self connection refused');
      return;
    }
    if (typeof hello.publicKey !== 'string') {
      this.reject(link, ErrCode.BAD_SIGNATURE, 'handshake signature invalid');
      return;
    }
    let derived: string;
    try {
      derived = addressFromPublicKey(hello.publicKey, this.net.addressHrp);
    } catch {
      this.reject(link, ErrCode.BAD_SIGNATURE, 'handshake signature invalid');
      return;
    }
    if (derived !== hello.identity || !verifyDigest(helloDigest(hello), signature, hello.publicKey)) {
      this.reject(link, ErrCode.BAD_SIGNATURE, 'handshake signature invalid');
      return;
    }
    // Freshness: the signature must cover THIS connection's challenge. A hello
    // recorded from another connection (or another node) signs a different one.
    const expected = message.t === 'hello' ? link.challenge : link.sentNonce;
    if (!expected || hello.challenge !== expected) {
      this.reject(link, ErrCode.BAD_SIGNATURE, 'handshake does not answer this connection (stale or replayed)');
      return;
    }

    const localFinality=this.chain.finalityStatus();
    if (hello.finalizedHeight<=localFinality.finalizedHeight && this.chain.canonicalHashAt(hello.finalizedHeight)!==hello.finalizedHash) {
      this.reject(link,ErrCode.FINALITY_CONFLICT,'peer finalized checkpoint conflicts with local history'); return;
    }
    // One connection per peer: both ends dialled each other, or a gossiped hint
    // led us back to a peer we already talk to. Both sides keep their OLDEST
    // link for this nodeId and close the newer socket, so exactly one of the two
    // duplicates survives on each end and they are the two ends of the same
    // socket. Without this a three-node network keeps opening links until the
    // connection limits are hit.
    const duplicate = [...this.links.values()].find((other) => other !== link && other.nodeId && other.nodeId === hello.nodeId);
    if (duplicate) {
      this.log.debug('duplicate connection dropped', { address: link.address, nodeId: hello.nodeId, kept: duplicate.address });
      try {
        link.socket.close(1000, 'duplicate connection');
      } catch {
        /* the socket is already gone */
      }
      return;
    }

    if (link.handshakeTimer) {
      clearTimeout(link.handshakeTimer);
      link.handshakeTimer = null;
    }
    // How we know this peer. For a link we dialled it is the address we chose to
    // dial. For one that dialled us it is the IP we actually SEE plus the port
    // it says it listens on — never the host it claims: a peer that could name
    // any host:port could make us score, ban and gossip somebody else's address.
    const listenPort = Number.isInteger(hello.listenPort) && hello.listenPort > 0 && hello.listenPort <= 65535 ? hello.listenPort : 0;
    const address = link.inbound ? (listenPort > 0 && link.remoteIp ? `${link.remoteIp}:${listenPort}` : link.address) : link.address;
    link.hello = hello;
    link.nodeId = hello.nodeId;
    link.identity = hello.identity;
    link.address = address;
    let weight = 0n;
    try {
      weight = BigInt(String(hello.weight ?? '0'));
    } catch {
      weight = 0n;
    }
    this.noteTip(link, Number.isInteger(hello.height) ? hello.height : 0, weight, String(hello.headHash ?? ''));

    let record = this.peers.recordSuccess(address, {
      nodeId: hello.nodeId,
      identity: hello.identity,
      genesisId: hello.genesisId,
      version: hello.version,
      height: hello.height,
      capabilities: hello.capabilities,
    });
    if (!record && listenPort > 0 && link.remoteIp) {
      this.peers.addGossiped([{ host: link.remoteIp, port: listenPort }]);
      record = this.peers.recordSuccess(address, { nodeId: hello.nodeId, identity: hello.identity, genesisId: hello.genesisId, version: hello.version, height: hello.height, capabilities: hello.capabilities });
    }
    this.log.info('peer connected', {
      address,
      nodeId: hello.nodeId,
      version: hello.version,
      height: hello.height,
      direction: link.inbound ? 'in' : 'out',
    });

    if (message.t === 'hello') {
      // Answer with a hello that signs THE DIALER's nonce.
      this.send(link, { ...this.helloMessage(hello.nonce), t: 'hello_ack' });
      this.send(link, { v: WIRE_VERSION, t: 'status', ...this.tipFields() });
      this.send(link, { v: WIRE_VERSION, t: 'getaddr' });
    }
    if (hello.finalizedHeight>localFinality.finalizedHeight) this.send(link,{v:WIRE_VERSION,t:'getfinality'});
    else if (hello.finalizedHeight<localFinality.finalizedHeight) { const certificate=this.chain.latestFinalityCertificate(); if(certificate) this.send(link,{v:WIRE_VERSION,t:'finality_certificate',certificate}); }

    if (this.peerIsBetter(link)) void this.syncFrom(link);
    this.emit('peer', { address, nodeId: hello.nodeId, height: hello.height });
  }

  /** Read the tip a peer attached to a status/ping/pong, and follow it if it is better than ours. */
  private handleTipFields(link: PeerLink, message: P2PMessage): void {
    if (message.height === undefined) return;
    const height = Number(message.height);
    let weight: bigint;
    try {
      weight = BigInt(String(message.weight ?? '0'));
    } catch {
      this.penalise(link, 'malformed', 'invalid weight');
      return;
    }
    if (!Number.isInteger(height) || height < 0) {
      this.penalise(link, 'malformed', 'invalid height');
      return;
    }
    this.noteTip(link, height, weight, String(message.headHash ?? ''));
    if (this.peerIsBetter(link)) void this.syncFrom(link);
  }

  private handleStatus(link: PeerLink, message: P2PMessage): void {
    if (!Number.isInteger(Number(message.height ?? 0)) || Number(message.height ?? 0) < 0) {
      this.penalise(link, 'malformed', 'invalid height in status');
      return;
    }
    this.handleTipFields(link, message);
  }

  private handleAddr(link: PeerLink, message: P2PMessage): void {
    const peers = Array.isArray(message.peers) ? (message.peers as Array<{ host: string; port: number }>) : [];
    const added = this.peers.addGossiped(peers.slice(0, 64));
    if (added > 0) this.log.debug('peer exchange', { from: link.address, added });
  }

  // ── Synchronisation ────────────────────────────────────────────────────────

  /**
   * Pull blocks from `link` until we are level with it.
   *
   * Two separate questions are answered by two separate mechanisms:
   *
   *  - WHERE does the peer's chain meet ours? The first request starts a little behind our head (`back`, 16
   *    blocks). When a reply arrives and none of it connects (every block an orphan: the peer is on a branch we
   *    do not share) `back` doubles and we ask again, until the replies reach the common ancestor or the
   *    protocol's reorg limit, beyond which no reorganisation is accepted anyway.
   *
   *  - HOW MUCH is there still to fetch? A cursor. While the peer says `more`, the next request starts right
   *    after the last block it sent (`from + returned`), whatever the peer's batch size and wherever our own
   *    head is. The cursor never depends on our head, so a batch that lies below our head (the overlap, or a
   *    peer that serves fewer blocks than our overlap is wide) still moves the sync forward.
   *
   * The loop used to re-derive `from` from our head on every round (`height - back`). With a peer serving
   * N <= back blocks per reply, the round after reaching height N asked for blocks 1..N again, got nothing but
   * duplicates, counted that as "no progress" and left the peer to be punished for "claiming a better chain but
   * not delivering it". The peer's `more` flag was never read.
   *
   * A peer is only punished when its WHOLE attempt delivered nothing we did not already have.
   */
  private async syncFrom(link: PeerLink, forceCertificateFetch = false): Promise<void> {
    if (link.syncing || this.stopping) return;
    if (!link.hello) return;
    if (this.now() - link.lastSyncMiss < SYNC_RETRY_GAP_MS) return;
    link.syncing = true;
    this.chain.setSyncing(true);
    let progressed = false;
    let failure: string | null = null;
    /** True when the failure already cost the peer a penalty (a bad block, a malformed reply) or the link is gone. */
    let alreadyHandled = false;
    const startHeight = this.chain.height;
    let requests = 0;
    let acceptedTotal = 0;
    try {
      const maxBack = CONSENSUS_PARAMS.consensus.maxReorgDepth + this.syncBatch;
      const maxRequests = 64 + 2 * Math.ceil((Math.max(link.height, this.chain.height) + maxBack) / this.syncBatch);
      let back = 16;
      let cursor = Math.max(1, this.chain.height - back);
      let mustFetchCertificateTarget = forceCertificateFetch;
      this.log.debug('sync started', this.syncView(link, { from: cursor, limit: this.syncBatch }));
      while (!this.stopping && (mustFetchCertificateTarget || this.peerIsBetter(link))) {
        mustFetchCertificateTarget = false;
        if (requests >= maxRequests) {
          failure = 'request budget exhausted';
          break;
        }
        requests += 1;
        const outcome = await this.requestBatch(link, cursor);
        this.log.debug('sync batch', this.syncView(link, batchFields(outcome)));
        acceptedTotal += outcome.accepted;
        if (outcome.accepted > 0) progressed = true;
        if (outcome.disconnected) {
          failure = 'disconnected';
          alreadyHandled = true;
          break;
        }
        if (outcome.timedOut) {
          failure = 'timeout';
          break;
        }
        if (outcome.malformed || outcome.rejected) {
          failure = outcome.malformed ?? `rejected ${outcome.rejected!.code}: ${outcome.rejected!.message}`;
          alreadyHandled = true;
          break;
        }
        if (outcome.returned === 0) {
          failure = 'empty reply';
          break;
        }
        if (outcome.accepted === 0 && outcome.duplicates === 0 && outcome.stale === 0 && outcome.orphans > 0) {
          // Nothing connected: the peer's branch parted from ours further back. Reach back further.
          if (cursor <= 1 || back >= maxBack) {
            failure = 'no common ancestor within the reorg limit';
            break;
          }
          back = Math.min(back * 2, maxBack);
          cursor = Math.max(1, this.chain.height - back);
          continue;
        }
        if (!outcome.more) {
          // The peer has sent everything it has from `cursor` on. If that brought something new, one more look from
          // just behind our new head catches anything it mined meanwhile; otherwise we are as level as it can make us.
          if (outcome.accepted === 0) {
            failure = failure ?? 'peer has nothing further to send';
            break;
          }
          back = 16;
          cursor = Math.max(1, this.chain.height - back);
          continue;
        }
        const next = outcome.from + outcome.returned;
        if (next <= cursor) {
          failure = 'cursor did not advance';
          break;
        }
        cursor = next;
        back = 16;
      }
    } finally {
      link.pending = null;
      link.syncing = false;
      this.log.debug('sync finished', this.syncView(link, { startHeight, requests, accepted: acceptedTotal, progressed, failure }));
      if (!progressed && !alreadyHandled) {
        link.lastSyncMiss = this.now();
        if (this.peerIsBetter(link)) {
          // It claimed a better chain and could not deliver it. Believe the
          // claim no longer, or one liar keeps this node "syncing" for ever.
          const tip = this.chain.tip;
          this.log.warn('peer claimed a better chain but delivered nothing', this.syncView(link, { reason: failure ?? 'no new blocks', requests }));
          this.noteTip(link, this.chain.height, BigInt(tip?.cumulativePotWeight ?? '0'), tip?.hash ?? '');
          this.penalise(link, 'minor', `claimed a better chain but did not deliver it (${failure ?? 'no new blocks'})`);
        }
      } else if (!progressed) {
        link.lastSyncMiss = this.now();
      }
      this.chain.setSyncing(false);
      this.castFinalityVote();
      if (this.chain.tip) this.emit('synced', { height: this.chain.height, hash: this.chain.tip.hash });
    }
  }

  /** The fields every sync log line carries: what we know of the peer, and of ourselves. No secrets, no keys. */
  private syncView(link: PeerLink, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      address: link.address,
      remoteHeight: link.height,
      remoteHead: link.headHash,
      localHeight: this.chain.height,
      localHead: this.chain.tip?.hash ?? '',
      ...extra,
    };
  }

  private rememberBatch(link: PeerLink, id: string): void {
    const now = this.now();
    for (const [known, until] of link.settledBatches) if (until <= now) link.settledBatches.delete(known);
    while (link.settledBatches.size >= MAX_SETTLED_BATCHES) {
      const oldest = link.settledBatches.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      link.settledBatches.delete(oldest);
    }
    link.settledBatches.set(id, now + SETTLED_BATCH_TTL_MS);
    // An old peer's answers carry no id. For a while after a request ends, an uncorrelated one is a late answer.
    link.lateBatchUntil = now + this.syncTimeoutMs * 2;
  }

  /**
   * Ask `link` for blocks from height `from` and wait for the answer.
   *
   * The request is registered on the link BEFORE it is sent, so an answer that arrives in the very next event
   * cannot find nothing waiting for it. Each request carries an id that the reply echoes, which is what lets a
   * late or repeated answer be told from a fresh one.
   */
  private requestBatch(link: PeerLink, from: number): Promise<BatchOutcome> {
    return new Promise((resolve) => {
      const id = randomBytes(8).toString('hex');
      const request = { id, from, limit: this.syncBatch };
      if (link.socket.readyState !== WebSocket.OPEN) {
        resolve({ ...emptyOutcome(request), disconnected: true });
        return;
      }
      const timer = setTimeout(() => {
        if (link.pending !== pending) return;
        link.pending = null;
        this.rememberBatch(link, id);
        resolve({ ...emptyOutcome(request), timedOut: true });
      }, this.syncTimeoutMs);
      const pending: PendingBatch = {
        ...request,
        settle: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        },
      };
      link.pending = pending;
      this.send(link, { v: WIRE_VERSION, t: 'getblocks', from, limit: request.limit, id });
    });
  }

  private handleGetBlocks(link: PeerLink, message: P2PMessage): void {
    const from = Number(message.from ?? 0);
    const asked = message.limit === undefined ? this.syncBatch : Number(message.limit);
    if (!Number.isInteger(from) || from < 0) {
      this.penalise(link, 'malformed', 'invalid getblocks range');
      return;
    }
    if (!Number.isInteger(asked)) {
      this.penalise(link, 'malformed', 'invalid getblocks limit');
      return;
    }
    const limit = Math.min(this.syncBatch, Math.max(1, asked));
    const id = typeof message.id === 'string' && /^[0-9a-f]{1,32}$/.test(message.id) ? message.id : undefined;
    const result = this.chain.blocksForSync(from, limit);
    this.log.debug('serving blocks', { address: link.address, from, limit, returned: result.blocks.length, more: result.more, localHeight: this.chain.height });
    this.send(link, {
      v: WIRE_VERSION,
      t: 'blocks',
      ...(id === undefined ? {} : { id }),
      blocks: result.blocks.map((bytes) => Buffer.from(bytes).toString('hex')),
      more: result.more,
    });
  }

  private handleBlocks(link: PeerLink, message: P2PMessage): void {
    // A batch is up to 128 block validations in one message. It is only
    // accepted as the answer to a request this node made.
    const id = typeof message.id === 'string' ? message.id : null;
    const pending = link.pending;
    if (!pending || (id !== null && id !== pending.id)) {
      const late = id !== null ? link.settledBatches.has(id) : this.now() < link.lateBatchUntil;
      if (late) {
        // The answer to a request that already timed out, or a repeat of one already handled. Nothing is
        // wrong with the peer; the blocks are simply not what this node is waiting for now.
        this.log.debug('late or repeated block batch ignored', { address: link.address, id });
        return;
      }
      this.penalise(link, 'malformed', 'unsolicited block batch');
      return;
    }
    link.pending = null;
    this.rememberBatch(link, pending.id);
    const outcome = emptyOutcome(pending);
    const finish = (): void => {
      if (outcome.accepted > 0) link.score = Math.min(0, link.score + outcome.accepted);
      pending.settle(outcome);
    };
    const raw = Array.isArray(message.blocks) ? (message.blocks as string[]) : [];
    outcome.returned = raw.length;
    outcome.more = message.more === true;
    if (raw.length > pending.limit) {
      outcome.malformed = 'batch larger than requested';
      this.penalise(link, 'malformed', outcome.malformed);
      finish();
      return;
    }
    for (const hex of raw) {
      let block: Block;
      try {
        block = decodeBlock(fromHex(hex));
      } catch (error) {
        outcome.malformed = `undecodable block: ${(error as Error).message}`;
        this.penalise(link, 'malformed', outcome.malformed);
        break;
      }
      const hash = blockHash(block.header);
      if (outcome.firstHeight === null) {
        outcome.firstHeight = block.header.height;
        outcome.firstHash = hash;
      }
      outcome.lastHeight = block.header.height;
      outcome.lastHash = hash;
      if (this.chain.getBlockByHash(hash)) {
        outcome.duplicates += 1; // already have it
        continue;
      }
      const result = this.chain.addBlock(block);
      if (result.accepted) {
        outcome.accepted += 1;
        this.retryPendingCertificate(hash);
        this.peers.recordValidBlock(link.address);
        this.emit('block', block);
      } else if (result.code === ErrCode.ORPHAN_BLOCK) {
        outcome.orphans += 1;
      } else if (result.code === ErrCode.DUPLICATE_BLOCK) {
        outcome.duplicates += 1;
      } else if (result.code === ErrCode.STALE_BLOCK) {
        outcome.stale += 1;
      } else {
        outcome.rejected = { code: result.code, message: result.message, height: block.header.height, hash };
        this.penalise(link, result.code === ErrCode.BAD_TIMESTAMP ? 'minor' : 'invalid-block', `${result.code}: ${result.message}`);
        break;
      }
    }
    finish();
  }

  private handleNewBlock(link: PeerLink, message: P2PMessage): void {
    let block: Block;
    try {
      block = decodeBlock(fromHex(String(message.block ?? '')));
    } catch (error) {
      this.penalise(link, 'malformed', `undecodable block: ${(error as Error).message}`);
      return;
    }
    const hash = blockHash(block.header);
    if (this.chain.getBlockByHash(hash)) return;
    const result = this.chain.addBlock(block);
    if (result.accepted) {
      this.retryPendingCertificate(hash);
      this.peers.recordValidBlock(link.address);
      this.relayedBlocks.add(hash);
      this.emit('block', block);
      this.broadcast({ v: WIRE_VERSION, t: 'newblock', block: toHex(encodeBlock(block)) }, link);
      return;
    }
    switch (result.code) {
      case ErrCode.ORPHAN_BLOCK:
        // We do not have its parent, so we missed something. Waiting for the
        // parent to turn up never works (nobody re-sends it): ask for it.
        // The header is unverified, so it only SUGGESTS the peer is ahead; the
        // sync it triggers is bounded and verifies everything it receives.
        if (Number.isInteger(block.header.height) && block.header.height > link.height) {
          this.noteTip(link, block.header.height, block.header.cumulativePotWeight, hash);
        }
        if (this.peerIsBetter(link)) void this.syncFrom(link);
        break;
      case ErrCode.DUPLICATE_BLOCK:
      case ErrCode.STALE_BLOCK:
        break; // nothing wrong with the peer, nothing for us to do
      case ErrCode.BAD_TIMESTAMP:
        // Clock skew is something an honest peer can do by accident.
        this.penalise(link, 'minor', `${result.code}: ${result.message}`);
        void this.syncFrom(link);
        break;
      case ErrCode.BAD_STATE_ROOT:
        this.penalise(link, 'invalid-block', `${result.code}: ${result.message}`);
        void this.syncFrom(link);
        break;
      default:
        this.penalise(link, 'invalid-block', `${result.code}: ${result.message}`);
    }
  }

  private handleNewTx(link: PeerLink, message: P2PMessage): void {
    let tx: TxEnvelope;
    try {
      tx = decodeSignedTxFromBytes(fromHex(String(message.tx ?? '')));
    } catch (error) {
      this.penalise(link, 'malformed', `undecodable transaction: ${(error as Error).message}`);
      return;
    }
    if (this.chain.mempool.has(tx.id)) return;
    // Check it before it is pooled or relayed. The pool evicts the lowest
    // DECLARED gas first and a sender writes the gas down itself, so an
    // unchecked transaction is a free way to crowd honest ones out of every
    // node's pool.
    const verdict = this.chain.checkGossipedTransaction(tx);
    if (!verdict.ok) {
      // A stale nonce or an expired transaction is what an honest peer relays
      // when it is a block ahead or behind us; a bad signature never is.
      if (
        verdict.code !== ErrCode.BAD_NONCE &&
        verdict.code !== ErrCode.EXPIRED &&
        verdict.code !== ErrCode.NOT_YET_VALID
      ) {
        this.penalise(link, 'invalid-tx', `${verdict.code}: ${verdict.message}`);
      }
      return;
    }
    // First seen wins: a second transaction for the same sender and nonce can
    // never also be mined, so pooling and relaying it would only waste space.
    // Not the sender's fault as far as this peer is concerned, so no penalty.
    if (this.chain.mempool.findBySenderNonce(tx.sender, tx.nonce)) return;
    const result = this.chain.mempool.add(tx);
    if (!result.accepted) {
      // A full mempool is not a protocol violation.
      this.log.debug('peer transaction not accepted', { from: link.address, reason: result.reason });
      return;
    }
    this.relayedTxs.add(tx.id);
    if (this.onTransaction) this.onTransaction(tx);
    this.broadcast({ v: WIRE_VERSION, t: 'newtx', tx: toHex(encodeSignedTx(tx)) }, link);
  }

  private handleFinalityVote(link:PeerLink,message:P2PMessage):void { const vote=message.vote as FinalityVote; let id:string; try{id=finalityVoteId(vote);}catch{this.penalise(link,'malformed','invalid finality vote encoding');return;} if(this.relayedFinalityVotes.has(id))return; const r=this.chain.addFinalityVote(vote); if(r.accepted){this.rememberRelay(this.relayedFinalityVotes,id);this.broadcast({v:WIRE_VERSION,t:'finality_vote',vote},link);} else if(!r.duplicate&&r.code!==ErrCode.ORPHAN_BLOCK)this.penalise(link,r.code===ErrCode.BAD_SIGNATURE?'invalid-block':'minor',`${r.code}: ${r.message}`); }
  private handleFinalityCertificate(link:PeerLink,message:P2PMessage):void {
    const certificate=message.certificate as FinalityCertificate, shape=certificateShape(certificate);
    if(!shape.ok){this.penalise(link,'malformed',shape.reason);return;}
    const id=`${certificate.height}:${certificate.blockHash}`; if(this.relayedCertificates.has(id))return;
    const result=this.chain.addFinalityCertificate(certificate);
    if(result.code===ErrCode.ORPHAN_BLOCK){
      if([...this.pendingFinalityCertificates.values()].some(item=>item.link===link)){this.penalise(link,'minor','peer already has a pending certificate');return;}
      if(this.pendingFinalityCertificates.size>=CONSENSUS_PARAMS.consensus.finality.maxCandidatesPerHeight*2){this.penalise(link,'minor','pending certificate limit reached');return;}
      this.pendingFinalityCertificates.set(id,{certificate,link}); void this.syncFrom(link,true); return;
    }
    if(result.accepted){this.rememberRelay(this.relayedCertificates,id);this.broadcast({v:WIRE_VERSION,t:'finality_certificate',certificate},link);}
    else if(!result.duplicate)this.penalise(link,result.code===ErrCode.BAD_SIGNATURE||result.code===ErrCode.FINALITY_CONFLICT?'invalid-block':'minor',`${result.code}: ${result.message}`);
  }
  private retryPendingCertificate(hash:string):void { for(const [id,item] of [...this.pendingFinalityCertificates])if(item.certificate.blockHash===hash){this.pendingFinalityCertificates.delete(id);this.handleFinalityCertificate(item.link,{v:WIRE_VERSION,t:'finality_certificate',certificate:item.certificate});} }
  private handleEvidence(link:PeerLink,message:P2PMessage):void { const evidence=message.evidence as EquivocationEvidence; if(evidence&&this.relayedEvidence.has(evidence.id))return; const r=this.chain.addEquivocationEvidence(evidence);if(r.accepted){this.rememberRelay(this.relayedEvidence,evidence.id);this.broadcast({v:WIRE_VERSION,t:'equivocation',evidence},link);}else if(!r.duplicate)this.penalise(link,r.code===ErrCode.BAD_SIGNATURE?'invalid-block':'malformed',r.message); }
  private rememberRelay(set:Set<string>,id:string):void { set.add(id);if(set.size>CONSENSUS_PARAMS.consensus.finality.maxPendingVotes){const oldest=set.values().next().value;if(oldest!==undefined)set.delete(oldest);} }

  // ── Gossip ─────────────────────────────────────────────────────────────────

  broadcast(message: P2PMessage, except?: PeerLink): void {
    for (const link of this.links.values()) {
      if (link === except || !link.hello) continue;
      this.send(link, message);
    }
  }

  announceTransaction(tx: TxEnvelope): void {
    if (this.relayedTxs.has(tx.id)) return;
    this.relayedTxs.add(tx.id);
    this.broadcast({ v: WIRE_VERSION, t: 'newtx', tx: toHex(encodeSignedTx(tx)) });
  }

  announceBlock(block: Block): void {
    const hash = blockHash(block.header);
    if (this.relayedBlocks.has(hash)) return;
    this.relayedBlocks.add(hash);
    this.broadcast({ v: WIRE_VERSION, t: 'newblock', block: toHex(encodeBlock(block)) });
  }

  announceFinalityVote(vote:FinalityVote):void { const id=finalityVoteId(vote);if(this.relayedFinalityVotes.has(id))return;this.rememberRelay(this.relayedFinalityVotes,id);this.broadcast({v:WIRE_VERSION,t:'finality_vote',vote}); }
  announceFinalityCertificate(certificate:FinalityCertificate):void { const id=`${certificate.height}:${certificate.blockHash}`;if(this.relayedCertificates.has(id))return;this.rememberRelay(this.relayedCertificates,id);this.broadcast({v:WIRE_VERSION,t:'finality_certificate',certificate}); }
  announceEvidence(evidence:EquivocationEvidence):void { if(this.relayedEvidence.has(evidence.id))return;this.rememberRelay(this.relayedEvidence,evidence.id);this.broadcast({v:WIRE_VERSION,t:'equivocation',evidence}); }

  private pruneRelaySets(): void {
    const cap = 20_000;
    const retain = cap / 2;
    // Sets preserve insertion order. Drop only the oldest half: clearing the
    // whole set at the cap created a predictable window in which every recent
    // transaction and block could be replay-relayed through this node again.
    for (const seen of [this.relayedBlocks, this.relayedTxs, this.relayedFinalityVotes, this.relayedCertificates, this.relayedEvidence]) {
      if (seen.size <= cap) continue;
      while (seen.size > retain) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    }
  }

  private pingAll(): void {
    const now = this.now();
    for (const link of this.links.values()) {
      if (!link.hello) continue;
      if (now - link.lastPong > PING_INTERVAL_MS * 4) {
        this.log.debug('peer is unresponsive, dropping', { address: link.address });
        link.socket.close(1001, 'unresponsive');
        continue;
      }
      this.send(link, { v: WIRE_VERSION, t: 'ping', ts: Math.floor(now / 1000), ...this.tipFields() });
    }
  }

  /** Connect to a peer address supplied by an operator (`addnode`). */
  async addNode(address: string): Promise<void> {
    const record = this.peers.addManual(address);
    await this.dial(record);
  }
}

/** Hash used for the node id: stable across restarts, not a secret. */
export function nodeIdFor(identityAddress: string, genesisId: string): string {
  return sha256Hex(utf8(`${identityAddress}|${genesisId}`)).slice(0, 32);
}

/** Byte length of a raw WebSocket frame, whatever shape `ws` hands us. */
function rawSize(data: RawData | string): number {
  if (typeof data === 'string') return Buffer.byteLength(data);
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return (data as Buffer | ArrayBuffer).byteLength;
}

/** `::ffff:1.2.3.4` is just 1.2.3.4 on a dual-stack socket. */
export function normaliseIp(ip: string): string {
  const value = (ip ?? '').trim();
  return value.toLowerCase().startsWith('::ffff:') && value.includes('.') ? value.slice(7) : value;
}

export function isLoopback(ip: string): boolean {
  const value = normaliseIp(ip);
  return value === '::1' || value === 'localhost' || /^127\./.test(value);
}

export function isWildcardHost(host: string): boolean {
  const value = (host ?? '').trim().replace(/^\[|\]$/g, '');
  return value === '' || value === '0.0.0.0' || value === '::';
}

export { parsePeerAddress };
