/**
 * On-disk blockchain storage.
 *
 * Layout (under the configured data directory):
 *
 *   chain/
 *     blocks/<height>-<hash>.blk   canonical block bytes, one file per block
 *     index.jsonl                  append-only header index (all known blocks)
 *     canonical.jsonl              append-only canonical chain log
 *     head.json                    current head pointer (atomic rename)
 *   state/
 *     checkpoint-<height>.json     periodic full state snapshots
 *     latest.json                  newest checkpoint pointer (atomic rename)
 *   meta.json                      chain metadata (genesis id, network, version)
 *
 * Design choices:
 *   - Append-only logs for the index and canonical chain: cheap, auditable and
 *     crash-safe, with torn tails dropped on load.
 *   - Full state checkpoints rather than a tree database: replaying a few
 *     thousand blocks from a checkpoint is fast, and correctness is easier to
 *     guarantee than with an incremental store. Nodes can prune old checkpoints.
 *   - Every file is written with the atomic helpers in storage/atomic.ts.
 */

import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Block, BlockHeader } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { atomicWriteFile, appendLineSync, ensureDir, readJsonLines } from './atomic.js';
import { parseState, stringifyState } from './json.js';
import { blockHash, decodeBlock, encodeBlock } from '../blockchain/block.js';
import type { StateSnapshot } from '../protocol/types.js';

export interface IndexEntry {
  height: number;
  hash: string;
  prevHash: string;
  timestamp: number;
  txCount: number;
  producer: string;
  cumulativePotWeight: string;
  size: number;
  file: string;
}

export interface HeadPointer {
  height: number;
  hash: string;
  updatedAt: string;
}

export interface ChainMeta {
  networkId: string;
  chainId: number;
  genesisId: string;
  genesisHash: string;
  protocolVersion: string;
  paramsHash: string;
  createdAt: string;
}

export class BlockStore {
  readonly chainDir: string;
  readonly blockDir: string;
  readonly stateDir: string;
  private readonly index = new Map<string, IndexEntry>();
  private readonly byHeight = new Map<number, IndexEntry>();
  /** Canonical chain, ordered by height. */
  private canonical: IndexEntry[] = [];
  private meta: ChainMeta | null = null;

  constructor(readonly dataDir: string) {
    this.chainDir = join(dataDir, 'chain');
    this.blockDir = join(this.chainDir, 'blocks');
    this.stateDir = join(dataDir, 'state');
    ensureDir(this.blockDir);
    ensureDir(this.stateDir);
    this.loadIndex();
    this.loadCanonical();
    this.loadMeta();
  }

  // ── Metadata ──────────────────────────────────────────────────────────────

  private loadMeta(): void {
    const path = join(this.chainDir, 'meta.json');
    if (existsSync(path)) {
      this.meta = JSON.parse(readFileSync(path, 'utf8')) as ChainMeta;
    }
  }

  getMeta(): ChainMeta | null {
    return this.meta;
  }

  setMeta(meta: ChainMeta): void {
    this.meta = meta;
    atomicWriteFile(join(this.chainDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  }

  // ── Blocks ────────────────────────────────────────────────────────────────

  private loadIndex(): void {
    for (const entry of readJsonLines<IndexEntry>(join(this.chainDir, 'index.jsonl'))) {
      this.index.set(entry.hash, entry);
      const existing = this.byHeight.get(entry.height);
      if (!existing) this.byHeight.set(entry.height, entry);
    }
  }

  private loadCanonical(): void {
    this.canonical = readJsonLines<IndexEntry>(join(this.chainDir, 'canonical.jsonl'));
    // Rebuild the height map with canonical preference.
    for (const entry of this.canonical) {
      this.byHeight.set(entry.height, entry);
      this.index.set(entry.hash, entry);
    }
  }

  get size(): number {
    return this.canonical.length;
  }

  get head(): IndexEntry | undefined {
    return this.canonical[this.canonical.length - 1];
  }

  get genesis(): IndexEntry | undefined {
    return this.canonical[0];
  }

  hasBlock(hash: string): boolean {
    return this.index.has(hash);
  }

  getIndexEntry(hash: string): IndexEntry | undefined {
    return this.index.get(hash);
  }

  getBlockByHash(hash: string): Block | null {
    const entry = this.index.get(hash);
    if (!entry) return null;
    const path = join(this.blockDir, entry.file);
    if (!existsSync(path)) return null;
    return decodeBlock(new Uint8Array(readFileSync(path)));
  }

  getCanonicalAtHeight(height: number): IndexEntry | undefined {
    return this.canonical[height];
  }

  getCanonicalHashAtHeight(height: number): string | undefined {
    return this.canonical[height]?.hash;
  }

  canonicalRange(fromHeight: number, limit: number): IndexEntry[] {
    return this.canonical.slice(fromHeight, fromHeight + limit);
  }

  /** Store a block. Returns the index entry. Idempotent for known hashes. */
  putBlock(block: Block): IndexEntry {
    const hash = blockHash(block.header);
    const existing = this.index.get(hash);
    if (existing) return existing;
    const bytes = encodeBlock(block);
    const file = `${block.header.height}-${hash.slice(0, 16)}.blk`;
    atomicWriteFile(join(this.blockDir, file), bytes);
    const entry: IndexEntry = {
      height: block.header.height,
      hash,
      prevHash: block.header.prevHash,
      timestamp: block.header.timestamp,
      txCount: block.transactions.length,
      producer: block.header.producer,
      cumulativePotWeight: block.header.cumulativePotWeight.toString(),
      size: bytes.length,
      file,
    };
    this.index.set(hash, entry);
    appendLineSync(join(this.chainDir, 'index.jsonl'), JSON.stringify(entry));
    const atHeight = this.byHeight.get(block.header.height);
    // Keep the canonical entry for a height if we already have one; otherwise
    // remember this block as the best known candidate for that height.
    if (!atHeight || this.canonical[block.header.height]?.hash !== atHeight.hash) {
      if (!atHeight) this.byHeight.set(block.header.height, entry);
    }
    return entry;
  }

  /**
   * Rewrite the canonical chain log. Called on startup normalisation and on
   * reorgs, both of which are infrequent; the log is rewritten atomically.
   */
  setCanonical(entries: IndexEntry[]): void {
    this.canonical = [...entries];
    this.byHeight.clear();
    for (const entry of this.canonical) this.byHeight.set(entry.height, entry);
    const body = this.canonical.map((entry) => JSON.stringify(entry)).join('\n');
    atomicWriteFile(join(this.chainDir, 'canonical.jsonl'), body.length ? `${body}\n` : '');
    this.writeHead();
  }

  /** Rebuild the canonical chain by walking parent links from a new head. */
  rebuildCanonicalFrom(headHash: string): IndexEntry[] {
    const chain: IndexEntry[] = [];
    let cursor: string | undefined = headHash;
    while (cursor) {
      const entry = this.index.get(cursor);
      if (!entry) break;
      chain.push(entry);
      cursor = entry.prevHash === entry.hash ? undefined : entry.prevHash || undefined;
      if (entry.height === 0) break;
    }
    chain.reverse();
    return chain;
  }

  private writeHead(): void {
    const head = this.head;
    const pointer: HeadPointer = head
      ? { height: head.height, hash: head.hash, updatedAt: new Date().toISOString() }
      : { height: -1, hash: '', updatedAt: new Date().toISOString() };
    atomicWriteFile(join(this.chainDir, 'head.json'), `${JSON.stringify(pointer, null, 2)}\n`);
  }

  // ── State checkpoints ─────────────────────────────────────────────────────

  saveState(snapshot: StateSnapshot): void {
    const path = join(this.stateDir, `checkpoint-${snapshot.height}.json`);
    atomicWriteFile(path, `${stringifyState(snapshot)}\n`);
    atomicWriteFile(
      join(this.stateDir, 'latest.json'),
      `${JSON.stringify({ height: snapshot.height, blockHash: snapshot.blockHash, file: `checkpoint-${snapshot.height}.json`, savedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  loadLatestState(): StateSnapshot | null {
    const pointerPath = join(this.stateDir, 'latest.json');
    if (!existsSync(pointerPath)) return null;
    const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as {
      height: number;
      blockHash: string;
      file: string;
    };
    const path = join(this.stateDir, pointer.file);
    if (!existsSync(path)) return null;
    return parseState<StateSnapshot>(readFileSync(path, 'utf8'));
  }

  /** Every stored checkpoint height, newest first (used for recovery). */
  listCheckpoints(): number[] {
    return readdirSync(this.stateDir)
      .map((name) => /^checkpoint-(\d+)\.json$/.exec(name)?.[1])
      .filter((value): value is string => Boolean(value))
      .map((value) => Number.parseInt(value, 10))
      .sort((a, b) => b - a);
  }

  pruneCheckpoints(keep: number): string[] {
    const removed: string[] = [];
    const checkpoints = this.listCheckpoints();
    for (const height of checkpoints.slice(keep)) {
      const path = join(this.stateDir, `checkpoint-${height}.json`);
      try {
        unlinkSync(path);
        removed.push(path);
      } catch {
        /* ignore */
      }
    }
    return removed;
  }

  /** Total bytes of stored block files (used by the health endpoint). */
  diskUsageBytes(): number {
    let total = 0;
    for (const entry of this.index.values()) total += entry.size;
    return total;
  }

  /** Fork-aware ancestor walk used by timestamp and difficulty checks. */
  /**
   * The `count` most recent ancestors of `hash` (nearest parent first) with the
   * fields Proof of Time needs: timestamp and transaction count.
   *
   * PoT Difficulty and Time-Rate are computed from chain history every node
   * already stores, so this is a read, never a network call and never a
   * self-report.
   */
  ancestorBlocks(hash: string, count: number): Array<{ hash: string; height: number; timestamp: number; txCount: number }> {
    const out: Array<{ hash: string; height: number; timestamp: number; txCount: number }> = [];
    let cursor: string | undefined = hash;
    while (cursor && out.length < count) {
      const entry: IndexEntry | undefined = this.index.get(cursor);
      if (!entry) break;
      out.push({ hash: entry.hash, height: entry.height, timestamp: entry.timestamp, txCount: entry.txCount });
      cursor = entry.height === 0 ? undefined : entry.prevHash || undefined;
    }
    return out;
  }

  ancestorTimestamps(hash: string, count: number): number[] {
    const out: number[] = [];
    let cursor: string | undefined = hash;
    while (cursor && out.length < count) {
      const entry: IndexEntry | undefined = this.index.get(cursor);
      if (!entry) break;
      out.push(entry.timestamp);
      cursor = entry.height === 0 ? undefined : entry.prevHash || undefined;
    }
    return out;
  }

  headerFromEntry(entry: IndexEntry): BlockHeader | null {
    const block = this.getBlockByHash(entry.hash);
    return block ? block.header : null;
  }
}

export const CHECKPOINT_INTERVAL_BLOCKS = (() => {
  // Checkpoint often enough that recovery replay is short, rarely enough that
  // writing never dominates block processing.
  return Math.max(100, Math.min(5_000, CONSENSUS_PARAMS.block.confirmationDepthHard * 8));
})();
