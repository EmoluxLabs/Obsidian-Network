/**
 * Peer-to-peer networking (protocol v1).
 *
 * Two nodes are on the same network if and only if they agree on:
 *   networkId, chainId, protocolVersion, paramsHash and genesisId —
 * and both prove control of their identity key with a signature over the
 * handshake. Anything else is refused before a single block is exchanged.
 *
 * Message flow
 *   connect → `hello` → `hello_ack` → `status`
 *   sync    → `getblocks {from,limit}` → `blocks {blocks[]}`
 *   gossip  → `newblock`, `newtx` (relayed once, deduplicated by hash)
 *   health  → `ping` / `pong`, `getaddr` / `addr`
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
import { CORE_VERSION, MIN_CORE_VERSION, PROTOCOL_VERSION, compareVersions } from '../version.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import { parsePeerAddress, PeerStore, type PeerRecord } from './peer-store.js';
import type { Block, TxEnvelope } from '../protocol/types.js';

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
  if (!/^[0-9a-f]{64}$/.test(descriptor.publicKey ?? '')) return { ok: false, reason: 'publicKey is not compressed hex' };
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
const SYNC_BATCH = 128;

export interface P2PMessage {
  v: number;
  t: string;
  [key: string]: unknown;
}

interface PeerLink {
  address: string;
  inbound: boolean;
  socket: WebSocket;
  nodeId: string;
  identity: string;
  hello: HelloPayload | null;
  height: number;
  headHash: string;
  score: number;
  lastPong: number;
  handshakeTimer: NodeJS.Timeout | null;
  syncing: boolean;
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
  capabilities: string[];
  timestamp: number;
  nonce: string;
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
    [...hello.capabilities].sort().join(','),
    String(hello.timestamp),
    hello.nonce,
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
  private readonly nodeId: string;
  private readonly nodeName: string;
  private readonly now: () => number;
  private readonly sink: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  private host = '0.0.0.0';
  private port = 0;
  private advertiseHost = '';
  private advertisePort = 0;
  private maxInbound: number;
  private maxOutbound: number;
  private connecting = false;
  private server: WebSocketServer | null = null;
  private timers: NodeJS.Timeout[] = [];
  private stopping = false;
  private readonly relayedBlocks = new Set<string>();
  private readonly relayedTxs = new Set<string>();
  private readonly onTransaction?: (tx: TxEnvelope) => void;

  constructor(options: P2PServiceOptions) {
    super();
    this.chain = options.chain;
    this.net = options.net;
    this.peers = options.peers;
    this.onTransaction = options.onTransaction;
    this.now = options.now ?? (() => Date.now());
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
    if (this.server) return this.port;
    await this.listenInternal();
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

  /** Ask every connected peer for anything we are missing. */
  requestSyncFromPeers(): void {
    const best = [...this.links.values()]
      .filter((link) => link.hello && link.height > this.chain.height)
      .sort((a, b) => b.height - a.height)[0];
    if (best) void this.syncFrom(best);
  }

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

  /** Start the peer-maintenance loops without opening a listener. */
  async start(port?: number, host?: string): Promise<void> {
    if (port) this.port = port;
    if (host) this.host = host;
    await this.listenInternal();
    this.scheduleLoops();
    void this.maintainPeers();
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
        const port = 0;
        this.accept(socket, `${remote}:${port}`, true);
      });
    });
  }

  private scheduleLoops(): void {
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
        const candidates = this.peers
          .dialable(32)
          .filter((record) => ![...this.links.values()].some((link) => link.address === record.address))
          .slice(0, target - outbound);
        for (const record of candidates) void this.dial(record);
      }
    }

    // Keep in touch with the best peer and pull anything we are missing.
    const best = [...this.links.values()]
      .filter((link) => link.hello && link.height > this.chain.height)
      .sort((a, b) => b.height - a.height)[0];
    if (best) void this.syncFrom(best);
  }

  private async dial(record: PeerRecord): Promise<void> {
    const url = `ws://${record.host}:${record.port}`;
    this.peers.recordAttempt(record.address);
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
      socket.on('open', () => {
        this.accept(socket, record.address, false);
        done();
      });
      socket.on('error', (error) => {
        this.peers.recordFailure(record.address, 'handshake');
        this.log.debug('dial error', { address: record.address, message: (error as Error).message });
        done();
      });
    });
  }

  // ── Connection handling ────────────────────────────────────────────────────

  private accept(socket: WebSocket, address: string, inbound: boolean): void {
    if (inbound && this.links.size >= this.maxInbound + this.maxOutbound) {
      try {
        socket.close(1013, 'connection limit reached');
      } catch {
        /* ignore */
      }
      return;
    }
    const key = `${address}#${randomBytes(4).toString('hex')}`;
    const link: PeerLink = {
      address,
      inbound,
      socket,
      nodeId: '',
      identity: '',
      hello: null,
      height: 0,
      headHash: '',
      score: 0,
      lastPong: this.now(),
      handshakeTimer: setTimeout(() => {
        this.log.debug('handshake timeout', { address });
        socket.close(1002, 'handshake timeout');
      }, HANDSHAKE_TIMEOUT_MS),
      syncing: false,
    };
    this.links.set(key, link);

    socket.on('message', (data: RawData) => this.onMessage(key, link, data));
    socket.on('close', () => this.dropLink(key, link));
    socket.on('error', () => this.dropLink(key, link));

    if (!inbound) this.send(link, this.helloMessage());
  }

  private dropLink(key: string, link: PeerLink): void {
    if (link.handshakeTimer) clearTimeout(link.handshakeTimer);
    this.links.delete(key);
    if (link.hello) {
      this.log.debug('peer disconnected', { address: link.address, nodeId: link.nodeId });
    }
  }

  private helloMessage(): P2PMessage {
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
      headHash: this.chain.tip?.hash ?? '',
      capabilities: ['sync', 'gossip'],
      timestamp: Math.floor(this.now() / 1000),
      nonce: randomBytes(16).toString('hex'),
    };
    const signature = toHex(signDigest(helloDigest(hello), this.identity.privateKey));
    return { v: WIRE_VERSION, t: 'hello', hello, signature };
  }

  private send(link: PeerLink, message: P2PMessage): void {
    try {
      link.socket.send(JSON.stringify(message));
    } catch (error) {
      this.log.debug('send failed', { address: link.address, message: (error as Error).message });
    }
  }

  private reject(link: PeerLink, code: ErrCode | string, message: string, fatal = true): void {
    this.send(link, { v: WIRE_VERSION, t: 'reject', code, message });
    if (fatal) {
      link.socket.close(1008, String(code).slice(0, 100));
    }
  }

  // ── Message dispatch ───────────────────────────────────────────────────────

  private onMessage(key: string, link: PeerLink, data: RawData): void {
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

    try {
      switch (message.t) {
        case 'hello':
          this.handleHello(link, message);
          break;
        case 'hello_ack':
          this.handleHello(link, message);
          this.send(link, { v: WIRE_VERSION, t: 'status', height: this.chain.height, headHash: this.chain.tip?.hash ?? '' });
          break;
        case 'ping':
          this.send(link, { v: WIRE_VERSION, t: 'pong', ts: Math.floor(this.now() / 1000) });
          break;
        case 'pong':
          link.lastPong = this.now();
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
        case 'getaddr':
          this.send(link, { v: WIRE_VERSION, t: 'addr', peers: this.peers.gossipSample(32) });
          break;
        case 'addr':
          this.handleAddr(link, message);
          break;
        case 'reject':
          this.log.debug('peer rejected us', { address: link.address, code: message.code, message: message.message });
          break;
        default:
          this.penalise(link, 'malformed', `unknown message type "${message.t}"`);
      }
    } catch (error) {
      this.penalise(link, 'malformed', (error as Error).message);
    }
    void key;
  }

  private penalise(link: PeerLink, kind: 'invalid-block' | 'malformed' | 'handshake', reason: string): void {
    link.score -= kind === 'invalid-block' ? 40 : 25;
    this.peers.recordFailure(link.address, kind);
    this.log.debug('peer penalised', { address: link.address, kind, reason, score: link.score });
    if (link.score < -100) this.reject(link, ErrCode.RATE_LIMITED, 'too many protocol violations');
  }

  private handleHello(link: PeerLink, message: P2PMessage): void {
    const hello = message.hello as HelloPayload | undefined;
    const signature = String(message.signature ?? '');
    if (!hello || typeof hello !== 'object') {
      this.penalise(link, 'handshake', 'missing hello payload');
      return;
    }
    if (!Number.isFinite(hello.timestamp) || Math.abs(Math.floor(this.now() / 1000) - hello.timestamp) > 300) {
      this.reject(link, ErrCode.BAD_TIMESTAMP, 'handshake timestamp outside ±300s');
      return;
    }
    if (hello.genesisId !== this.chain.genesisId) {
      this.reject(link, ErrCode.WRONG_NETWORK, 'genesis id mismatch');
      return;
    }
    if (hello.chainId !== this.net.chainId || hello.networkId !== this.net.networkId) {
      this.reject(link, ErrCode.WRONG_CHAIN_ID, 'chain/network id mismatch');
      return;
    }
    if (hello.paramsHash !== PARAMS_HASH) {
      this.reject(link, ErrCode.VERSION_MISMATCH, 'consensus parameter set mismatch');
      return;
    }
    if (compareVersions(hello.protocolVersion, PROTOCOL_VERSION) !== 0) {
      this.reject(link, ErrCode.VERSION_MISMATCH, `protocol version ${hello.protocolVersion} is incompatible`);
      return;
    }
    if (compareVersions(hello.version, MIN_CORE_VERSION) < 0) {
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
    const derived = addressFromPublicKey(hello.publicKey, this.net.addressHrp);
    if (derived !== hello.identity || !verifyDigest(helloDigest(hello), signature, hello.publicKey)) {
      this.reject(link, ErrCode.BAD_SIGNATURE, 'handshake signature invalid');
      return;
    }

    if (link.handshakeTimer) {
      clearTimeout(link.handshakeTimer);
      link.handshakeTimer = null;
    }
    const address = hello.listenPort > 0 ? `${hello.listenHost}:${hello.listenPort}` : link.address;
    link.hello = hello;
    link.nodeId = hello.nodeId;
    link.identity = hello.identity;
    link.address = address;
    link.height = hello.height;
    link.headHash = hello.headHash;

    const record = this.peers.recordSuccess(address, {
      nodeId: hello.nodeId,
      identity: hello.identity,
      genesisId: hello.genesisId,
      version: hello.version,
      height: hello.height,
      capabilities: hello.capabilities,
    });
    if (!record) this.peers.addGossiped([{ host: hello.listenHost, port: hello.listenPort }]);
    this.log.info('peer connected', {
      address,
      nodeId: hello.nodeId,
      version: hello.version,
      height: hello.height,
      direction: link.inbound ? 'in' : 'out',
    });

    if (message.t === 'hello') {
      this.send(link, { ...this.helloMessage(), t: 'hello_ack' });
      this.send(link, { v: WIRE_VERSION, t: 'status', height: this.chain.height, headHash: this.chain.tip?.hash ?? '' });
      this.send(link, { v: WIRE_VERSION, t: 'getaddr' });
    }

    if (hello.height > this.chain.height) void this.syncFrom(link);
    this.emit('peer', { address, nodeId: hello.nodeId, height: hello.height });
  }

  private handleStatus(link: PeerLink, message: P2PMessage): void {
    const height = Number(message.height ?? 0);
    const headHash = String(message.headHash ?? '');
    if (!Number.isInteger(height) || height < 0) {
      this.penalise(link, 'malformed', 'invalid height in status');
      return;
    }
    const previous = link.height;
    link.height = Math.max(link.height, height);
    link.headHash = headHash;
    this.peers.recordHeight(link.address, link.height);
    if (link.height > this.chain.height && (previous < link.height || headHash !== this.chain.tip?.hash)) {
      void this.syncFrom(link);
    }
  }

  private handleAddr(link: PeerLink, message: P2PMessage): void {
    const peers = Array.isArray(message.peers) ? (message.peers as Array<{ host: string; port: number }>) : [];
    const added = this.peers.addGossiped(peers.slice(0, 64));
    if (added > 0) this.log.debug('peer exchange', { from: link.address, added });
  }

  // ── Synchronisation ────────────────────────────────────────────────────────

  private async syncFrom(link: PeerLink): Promise<void> {
    if (link.syncing || this.stopping) return;
    if (!link.hello) return;
    link.syncing = true;
    this.chain.setSyncing(true);
    try {
      let guard = 0;
      while (!this.stopping && link.height > this.chain.height && guard < 64) {
        guard += 1;
        // Ask for a little overlap so a competing branch can be resolved by the
        // normal fork-choice rules instead of being treated as an orphan.
        const from = Math.max(1, this.chain.height - 16);
        this.send(link, { v: WIRE_VERSION, t: 'getblocks', from, limit: SYNC_BATCH });
        const received = await this.waitForBatch(link);
        if (received === 0) break;
      }
    } finally {
      link.syncing = false;
      this.chain.setSyncing(false);
      if (this.chain.tip) this.emit('synced', { height: this.chain.height, hash: this.chain.tip.hash });
    }
  }

  private waitForBatch(link: PeerLink): Promise<number> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeListener(`blocks:${link.nodeId}`, onBlocks);
        resolve(0);
      }, 15_000);
      const onBlocks = (count: number) => {
        clearTimeout(timeout);
        this.removeListener(`blocks:${link.nodeId}`, onBlocks);
        resolve(count);
      };
      this.once(`blocks:${link.nodeId}`, onBlocks);
    });
  }

  private handleGetBlocks(link: PeerLink, message: P2PMessage): void {
    const from = Number(message.from ?? 0);
    const limit = Math.min(SYNC_BATCH, Math.max(1, Number(message.limit ?? SYNC_BATCH)));
    if (!Number.isInteger(from) || from < 0) {
      this.penalise(link, 'malformed', 'invalid getblocks range');
      return;
    }
    const result = this.chain.blocksForSync(from, limit);
    this.send(link, {
      v: WIRE_VERSION,
      t: 'blocks',
      blocks: result.blocks.map((bytes) => Buffer.from(bytes).toString('hex')),
      more: result.more,
    });
  }

  private handleBlocks(link: PeerLink, message: P2PMessage): void {
    const raw = Array.isArray(message.blocks) ? (message.blocks as string[]) : [];
    if (raw.length > SYNC_BATCH) {
      this.penalise(link, 'malformed', 'batch larger than requested');
      return;
    }
    let accepted = 0;
    for (const hex of raw) {
      let block: Block;
      try {
        block = decodeBlock(fromHex(hex));
      } catch (error) {
        this.penalise(link, 'malformed', `undecodable block: ${(error as Error).message}`);
        break;
      }
      const hash = blockHash(block.header);
      if (this.chain.getBlockByHash(hash)) continue; // already have it
      const result = this.chain.addBlock(block);
      if (result.accepted) {
        accepted += 1;
        this.peers.recordValidBlock(link.address);
        this.emit('block', block);
      } else if (result.code !== ErrCode.ORPHAN_BLOCK && result.code !== ErrCode.DUPLICATE_BLOCK) {
        this.penalise(link, 'invalid-block', `${result.code}: ${result.message}`);
        break;
      }
    }
    this.emit(`blocks:${link.nodeId}`, accepted);
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
      this.peers.recordValidBlock(link.address);
      this.relayedBlocks.add(hash);
      this.emit('block', block);
      this.broadcast({ v: WIRE_VERSION, t: 'newblock', block: toHex(encodeBlock(block)) }, link);
    } else if (result.code !== ErrCode.ORPHAN_BLOCK) {
      this.penalise(link, 'invalid-block', `${result.code}: ${result.message}`);
      if (result.code === ErrCode.BAD_TIMESTAMP || result.code === ErrCode.BAD_STATE_ROOT) void this.syncFrom(link);
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
    const result = this.chain.mempool.add(tx);
    if (!result.accepted) {
      // A full or stale mempool is not a protocol violation.
      this.log.debug('peer transaction not accepted', { from: link.address, reason: result.reason });
      return;
    }
    this.relayedTxs.add(tx.id);
    if (this.onTransaction) this.onTransaction(tx);
    this.broadcast({ v: WIRE_VERSION, t: 'newtx', tx: toHex(encodeSignedTx(tx)) }, link);
  }

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

  private pruneRelaySets(): void {
    const cap = 20_000;
    if (this.relayedBlocks.size > cap) this.relayedBlocks.clear();
    if (this.relayedTxs.size > cap) this.relayedTxs.clear();
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
      this.send(link, { v: WIRE_VERSION, t: 'ping', ts: Math.floor(now / 1000) });
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

export { parsePeerAddress };
