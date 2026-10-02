/**
 * Peer table.
 *
 * Tracks every peer this node knows about, how well it has behaved, and when to
 * try it again. Peers are scored from observable protocol behaviour only:
 * a peer that sends valid blocks gains score, a peer that sends invalid blocks
 * or malformed messages loses it, and peers that keep failing are pruned.
 *
 * The store is a hint, never a source of truth: a peer address in this file has
 * no authority over consensus. Nothing here can make a node accept a block it
 * would otherwise reject.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type PeerSource = 'seed' | 'gossip' | 'manual' | 'inbound';

export interface PeerRecord {
  /** `host:port` — the dial key. */
  address: string;
  host: string;
  port: number;
  nodeId: string;
  /** Identity address (`obs1…`) proven by the handshake signature. */
  identity: string;
  genesisId: string;
  version: string;
  height: number;
  source: PeerSource;
  firstSeen: number;
  lastSeen: number;
  lastAttempt: number;
  successCount: number;
  failureCount: number;
  score: number;
  bannedUntil: number;
  /** Informational capabilities advertised by the peer. */
  capabilities: string[];
}

export interface PeerStoreOptions {
  dataDir: string;
  seeds: string[];
  /** Upper bound on remembered peer hints. */
  maxPeers?: number;
  /** Persist to `<dataDir>/peers.json`. Defaults to true. */
  persist?: boolean;
  now?: () => number;
}

/** Score thresholds. */
export const PEER_SCORE = {
  banBelow: -100,
  successGain: 4,
  validBlockGain: 3,
  invalidBlockPenalty: -40,
  malformedPenalty: -25,
  handshakeFailurePenalty: -10,
  max: 200,
} as const;

/**
 * How long to wait before dialling a peer that refused our connection.
 *
 * A refused socket is not evidence of misbehaviour: seeds come online late,
 * operators restart nodes, and a laptop dials its seed while the seed is still
 * booting. Treating that as a ban used to lock a node out of the network for an
 * hour on a single transient `ECONNREFUSED`. Instead we back off exponentially
 * — 15s, 30s, 1m, 2m … — capped at {@link PeerStore.banWindowMs}, so a seed
 * that appears moments later is picked up on the next sweep while a peer that
 * is genuinely gone stops being dialled constantly.
 *
 * Dishonest behaviour (invalid blocks, malformed messages) is *not* covered by
 * this curve: it still earns the full ban window.
 */
export function handshakeRetryDelayMs(failureCount: number, capMs: number, baseMs = 15_000): number {
  const attempt = Math.max(1, Math.min(Math.floor(failureCount) || 1, 20));
  return Math.min(baseMs * 2 ** (attempt - 1), capMs);
}

export function parsePeerAddress(address: string): { host: string; port: number } {
  const trimmed = address.trim().replace(/^wss?:\/\//, '').replace(/\/+$/, '');
  const match = /^\[?([a-zA-Z0-9._:\-]+?)\]?:(\d{1,5})$/.exec(trimmed);
  if (!match) {
    const plain = /^([a-zA-Z0-9._\-]+)$/.exec(trimmed);
    if (plain) return { host: plain[1]!, port: 0 };
    throw new Error(`invalid peer address "${address}" (expected host:port)`);
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid peer port in "${address}"`);
  }
  return { host: match[1]!, port };
}

export class PeerStore {
  private readonly records = new Map<string, PeerRecord>();
  private readonly options: PeerStoreOptions;
  private readonly now: () => number;
  private dirty = false;

  constructor(options: PeerStoreOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.load();
    for (const seed of options.seeds) this.addSeed(seed);
  }

  private get file(): string {
    return join(this.options.dataDir, 'peers.json');
  }

  private load(): void {
    if (this.options.persist === false) return;
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { peers?: PeerRecord[] };
      for (const record of parsed.peers ?? []) {
        if (record?.address) this.records.set(record.address, { ...record, capabilities: record.capabilities ?? [] });
      }
    } catch {
      // A corrupt peer file only costs us peer hints; never fail to boot on it.
      this.records.clear();
    }
  }

  persist(force = false): void {
    if (this.options.persist === false) return;
    if (!force && !this.dirty) return;
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ version: 1, savedAt: new Date(this.now()).toISOString(), peers: [...this.records.values()] }, null, 2);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, payload, { mode: 0o600 });
    renameSync(temp, this.file);
    this.dirty = false;
  }

  private touch(record: PeerRecord): PeerRecord {
    this.records.set(record.address, record);
    this.dirty = true;
    return record;
  }

  private blank(host: string, port: number, source: PeerSource): PeerRecord {
    const time = this.now();
    return {
      address: `${host}:${port}`,
      host,
      port,
      nodeId: '',
      identity: '',
      genesisId: '',
      version: '',
      height: 0,
      source,
      firstSeen: time,
      lastSeen: 0,
      lastAttempt: 0,
      successCount: 0,
      failureCount: 0,
      score: 0,
      bannedUntil: 0,
      capabilities: [],
    };
  }

  addSeed(seed: string): PeerRecord {
    const { host, port } = parsePeerAddress(seed);
    const existing = this.records.get(`${host}:${port}`);
    if (existing) {
      existing.source = 'seed';
      return this.touch(existing);
    }
    return this.touch(this.blank(host, port, 'seed'));
  }

  addManual(address: string): PeerRecord {
    const { host, port } = parsePeerAddress(address);
    const existing = this.records.get(`${host}:${port}`);
    if (existing) return existing;
    return this.touch(this.blank(host, port, 'manual'));
  }

  /** Merge peers learned from a `addr` message. */
  addGossiped(entries: Array<{ host: string; port: number }>, maxEntries = this.options.maxPeers ?? 500): number {
    let added = 0;
    for (const entry of entries) {
      if (this.records.size >= maxEntries) break;
      if (!entry?.host || !Number.isInteger(entry.port)) continue;
      const address = `${entry.host}:${entry.port}`;
      if (this.records.has(address)) continue;
      this.touch(this.blank(entry.host, entry.port, 'gossip'));
      added += 1;
    }
    return added;
  }

  all(): PeerRecord[] {
    return [...this.records.values()];
  }

  get(address: string): PeerRecord | undefined {
    return this.records.get(address);
  }

  get size(): number {
    return this.records.size;
  }

  isBanned(address: string): boolean {
    const record = this.records.get(address);
    return Boolean(record && record.bannedUntil > this.now());
  }

  ban(address: string, milliseconds: number): void {
    const record = this.records.get(address);
    if (!record) return;
    record.bannedUntil = this.now() + milliseconds;
    record.score = PEER_SCORE.banBelow;
    this.touch(record);
  }

  /** Peers worth dialling right now, best score first. */
  dialable(limit = 64): PeerRecord[] {
    const time = this.now();
    return this.all()
      .filter((record) => record.port > 0 && record.bannedUntil <= time)
      .sort((a, b) => b.score - a.score || a.lastAttempt - b.lastAttempt)
      .slice(0, limit);
  }

  /** Peers currently considered healthy (successful handshake, not banned). */
  healthy(): PeerRecord[] {
    const time = this.now();
    return this.all()
      .filter((record) => record.nodeId && record.bannedUntil <= time && record.height > 0)
      .sort((a, b) => b.height - a.height || b.score - a.score);
  }

  /** Highest peer height among healthy peers. */
  bestHeight(): number {
    return this.healthy().reduce((max, record) => Math.max(max, record.height), 0);
  }

  recordAttempt(address: string): void {
    const record = this.records.get(address);
    if (!record) return;
    record.lastAttempt = this.now();
    this.touch(record);
  }

  recordSuccess(
    address: string,
    details: { nodeId?: string; identity?: string; genesisId?: string; version?: string; height?: number; capabilities?: string[] } = {},
  ): PeerRecord | undefined {
    const record = this.records.get(address);
    if (!record) return undefined;
    record.lastSeen = this.now();
    record.successCount += 1;
    record.failureCount = 0;
    // A peer we just completed a handshake with is demonstrably reachable, so
    // any pending retry/ban window is stale — clear it.
    record.bannedUntil = 0;
    record.score = Math.min(PEER_SCORE.max, record.score + PEER_SCORE.successGain);
    if (details.nodeId) record.nodeId = details.nodeId;
    if (details.identity) record.identity = details.identity;
    if (details.genesisId) record.genesisId = details.genesisId;
    if (details.version) record.version = details.version;
    if (typeof details.height === 'number') record.height = details.height;
    if (details.capabilities) record.capabilities = details.capabilities;
    return this.touch(record);
  }

  recordHeight(address: string, height: number): void {
    const record = this.records.get(address);
    if (!record) return;
    if (height !== record.height) {
      record.height = height;
      record.lastSeen = this.now();
      this.touch(record);
    }
  }

  recordValidBlock(address: string): void {
    const record = this.records.get(address);
    if (!record) return;
    record.score = Math.min(PEER_SCORE.max, record.score + PEER_SCORE.validBlockGain);
    this.touch(record);
  }

  recordFailure(address: string, kind: 'invalid-block' | 'malformed' | 'handshake' = 'malformed'): void {
    const record = this.records.get(address);
    if (!record) return;
    record.failureCount += 1;
    const penalty =
      kind === 'invalid-block'
        ? PEER_SCORE.invalidBlockPenalty
        : kind === 'handshake'
          ? PEER_SCORE.handshakeFailurePenalty
          : PEER_SCORE.malformedPenalty;
    record.score += penalty;

    if (kind === 'handshake') {
      // Reachability, not honesty: a short exponential retry window. The score
      // still drops (an unreachable address should rank below a reachable one)
      // but it is floored, because repeated network errors must not look like
      // repeated protocol misbehaviour in the operator's peer list.
      record.bannedUntil = this.now() + handshakeRetryDelayMs(record.failureCount, this.banWindowMs);
      record.score = Math.max(PEER_SCORE.banBelow, record.score);
    } else if (record.score < PEER_SCORE.banBelow) {
      record.bannedUntil = this.now() + this.banWindowMs;
    }
    this.touch(record);
  }

  private get banWindowMs(): number {
    return 60 * 60 * 1000;
  }

  /**
   * Drop peers that have failed repeatedly and never succeeded.
   *
   * Operator-configured addresses (`--seeds`, `--peer`) are never forgotten:
   * they are re-added at boot anyway, so pruning them only loses the score and
   * backoff history the operator's node accumulated for them.
   */
  pruneStale(maxIdleMs = 7 * 24 * 60 * 60 * 1000, keepScore = -20): number {
    const time = this.now();
    let removed = 0;
    for (const [address, record] of [...this.records.entries()]) {
      if (record.source === 'seed' || record.source === 'manual') continue;
      const idleTooLong = record.lastSeen > 0 && time - record.lastSeen > maxIdleMs;
      const failing = record.failureCount >= 5 && record.score <= keepScore;
      if (idleTooLong || failing) {
        this.records.delete(address);
        this.dirty = true;
        removed += 1;
      }
    }
    return removed;
  }

  /** Peers to gossip to other nodes (never our own address, never banned peers). */
  gossipSample(limit = 32): Array<{ host: string; port: number }> {
    const time = this.now();
    return this.all()
      .filter((record) => record.port > 0 && record.bannedUntil <= time && record.lastSeen > 0)
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, limit)
      .map((record) => ({ host: record.host, port: record.port }));
  }

  toJSON(): PeerRecord[] {
    return this.all();
  }
}
