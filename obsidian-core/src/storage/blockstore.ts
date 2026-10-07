/**
 * On-disk blockchain storage.
 *
 * Layout (under the configured data directory):
 *
 *   chain/
 *     blocks/<height>-<hash>.blk   canonical block bytes, one file per block
 *     index.jsonl                  append-only header index (all known blocks)
 *     canonical.jsonl              append-only canonical chain log: one record
 *                                  per block that joins the chain, plus a
 *                                  {"reorgTo":h} marker whenever the chain is
 *                                  cut back to height h
 *     head.json                    current head pointer (atomic rename)
 *   state/
 *     checkpoint-<height>.json     periodic full state snapshots
 *     checkpoints.json             index of snapshots with the block each belongs to
 *     latest.json                  newest checkpoint pointer (atomic rename)
 *   meta.json                      chain metadata (genesis id, network, version)
 *
 * Design choices:
 *   - Append-only logs for the index and canonical chain: cheap, auditable and
 *     crash-safe, with torn tails dropped on load. Extending the chain appends
 *     ONE line; a reorganisation appends a marker and the new tail. Nothing
 *     rewrites the whole log per block, so block-processing cost does not grow
 *     with chain length. The log is compacted when the node starts.
 *   - Full state checkpoints rather than a tree database: replaying a few
 *     thousand blocks from a checkpoint is fast, and correctness is easier to
 *     guarantee than with an incremental store. Nodes can prune old checkpoints.
 *   - Every file is written with the atomic helpers in storage/atomic.ts.
 */

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Block, BlockHeader } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { atomicWriteFile, appendLineSync, appendLinesSync, ensureDir, readJsonLines } from './atomic.js';
import { parseState, stringifyState } from './json.js';
import { blockHash, decodeBlock, encodeBlock, transactionRootOf } from '../blockchain/block.js';
import { sha256Hex, utf8 } from '../crypto/hash.js';
import type { StateSnapshot } from '../protocol/types.js';
import { STATE_SNAPSHOT_VERSION } from '../version.js';

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

/** A saved state snapshot and the block it is the state AFTER. */
export interface CheckpointEntry {
  height: number;
  blockHash: string;
  file: string;
  savedAt: string;
  /** SHA-256 of the canonical lossless JSON snapshot body. */
  checksum?: string;
}

/** Written to canonical.jsonl when the chain is cut back to `reorgTo`. */
interface CanonicalMarker {
  reorgTo: number;
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
  /** Every stored candidate at a height, including side branches. */
  private readonly candidatesByHeight = new Map<number, Map<string, IndexEntry>>();
  /** Canonical chain, ordered by height. */
  private canonical: IndexEntry[] = [];
  private meta: ChainMeta | null = null;
  private checkpointEntries: CheckpointEntry[] = [];
  /** Running total of stored block bytes (the health endpoint reads it per request). */
  private diskBytes = 0;

  constructor(readonly dataDir: string) {
    this.chainDir = join(dataDir, 'chain');
    this.blockDir = join(this.chainDir, 'blocks');
    this.stateDir = join(dataDir, 'state');
    ensureDir(this.blockDir);
    ensureDir(this.stateDir);
    this.removeStaleTempFiles();
    this.loadIndex();
    this.loadCanonical();
    this.loadMeta();
    this.loadCheckpointIndex();
    this.validateLoadedData();
  }

  /**
   * Index and canonical logs are untrusted persistent input. Cross-check every
   * field against the canonical block encoding before ChainManager can use it.
   */
  private validateLoadedData(): void {
    for (const [hash, entry] of this.index) {
      if (
        !/^[0-9a-f]{64}$/.test(hash) ||
        entry.hash !== hash ||
        !Number.isSafeInteger(entry.height) ||
        entry.height < 0 ||
        !Number.isSafeInteger(entry.size) ||
        entry.size <= 0 ||
        !/^\d+-[0-9a-f]{16}\.blk$/.test(entry.file)
      ) {
        throw new Error(`invalid block index entry for ${hash}`);
      }
      const path = join(this.blockDir, entry.file);
      if (!existsSync(path)) throw new Error(`indexed block ${hash} is missing (${entry.file})`);
      const bytes = new Uint8Array(readFileSync(path));
      if (bytes.length !== entry.size) throw new Error(`indexed block ${hash} has incorrect size metadata`);
      let block: Block;
      try {
        block = decodeBlock(bytes);
      } catch (error) {
        throw new Error(`indexed block ${hash} cannot be decoded: ${(error as Error).message}`);
      }
      const actualHash = blockHash(block.header);
      if (
        actualHash !== hash ||
        block.header.height !== entry.height ||
        block.header.prevHash !== entry.prevHash ||
        block.header.timestamp !== entry.timestamp ||
        block.header.producer !== entry.producer ||
        block.header.cumulativePotWeight.toString() !== entry.cumulativePotWeight ||
        block.transactions.length !== entry.txCount ||
        transactionRootOf(block.transactions) !== block.header.txRoot
      ) {
        throw new Error(`block index metadata does not match encoded block ${hash}`);
      }
      if (entry.height > 0 && !this.index.has(entry.prevHash)) {
        throw new Error(`indexed block ${hash} has unknown parent ${entry.prevHash}`);
      }
    }

    for (let height = 0; height < this.canonical.length; height += 1) {
      const entry = this.canonical[height]!;
      const indexed = this.index.get(entry.hash);
      if (
        !indexed ||
        indexed.height !== entry.height ||
        indexed.hash !== entry.hash ||
        indexed.prevHash !== entry.prevHash ||
        indexed.timestamp !== entry.timestamp ||
        indexed.txCount !== entry.txCount ||
        indexed.producer !== entry.producer ||
        indexed.cumulativePotWeight !== entry.cumulativePotWeight ||
        indexed.size !== entry.size ||
        indexed.file !== entry.file
      ) {
        throw new Error(`canonical entry at height ${height} does not match the block index`);
      }
      if (height > 0 && (entry.prevHash !== this.canonical[height - 1]!.hash || entry.height !== height)) {
        throw new Error(`canonical parent link is broken at height ${height}`);
      }
    }

    // canonical.jsonl is authoritative; head.json is a fast, derived pointer.
    // Repair a stale/ahead pointer left by a crash between its write and a log
    // append instead of trusting it or refusing an otherwise complete chain.
    const headPath = join(this.chainDir, 'head.json');
    let pointerMatches = false;
    if (existsSync(headPath)) {
      try {
        const pointer = JSON.parse(readFileSync(headPath, 'utf8')) as HeadPointer;
        const head = this.head;
        pointerMatches = head
          ? pointer.height === head.height && pointer.hash === head.hash
          : pointer.height === -1 && pointer.hash === '';
      } catch {
        pointerMatches = false;
      }
    }
    if (!pointerMatches) this.writeHead();
  }

  /**
   * A crash between "write temp file" and "rename it" leaves a `.tmp-<pid>-<ms>`
   * file behind. They are never read, but without this they accumulate for the
   * life of the data directory. Only files older than a minute are removed, so a
   * second process that opens the directory can never delete a live write.
   */
  private removeStaleTempFiles(): void {
    for (const directory of [this.chainDir, this.blockDir, this.stateDir, this.dataDir]) {
      let names: string[];
      try {
        names = readdirSync(directory);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/\.tmp(-\d+-\d+)?$/.test(name)) continue;
        try {
          const path = join(directory, name);
          if (Date.now() - statSync(path).mtimeMs < 60_000) continue;
          unlinkSync(path);
        } catch {
          /* already gone */
        }
      }
    }
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
    atomicWriteFile(join(this.chainDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
    this.meta = meta;
  }

  // ── Blocks ────────────────────────────────────────────────────────────────

  private loadIndex(): void {
    for (const entry of readJsonLines<IndexEntry>(join(this.chainDir, 'index.jsonl'), { strict: true })) {
      if (this.index.has(entry.hash)) continue;
      this.index.set(entry.hash, entry);
      this.diskBytes += entry.size;
      const existing = this.byHeight.get(entry.height);
      if (!existing) this.byHeight.set(entry.height, entry);
      const candidates=this.candidatesByHeight.get(entry.height)??new Map<string,IndexEntry>();
      candidates.set(entry.hash,entry); this.candidatesByHeight.set(entry.height,candidates);
    }
  }

  private loadCanonical(): void {
    const records = readJsonLines<IndexEntry | CanonicalMarker>(join(this.chainDir, 'canonical.jsonl'), {
      strict: true,
    });
    const chain: IndexEntry[] = [];
    let markers = 0;
    for (const record of records) {
      if ('reorgTo' in record) {
        markers += 1;
        if (!Number.isInteger(record.reorgTo) || record.reorgTo < 0 || record.reorgTo >= chain.length) {
          throw new Error(`canonical.jsonl: reorg marker to height ${record.reorgTo} is outside the chain (${chain.length} blocks)`);
        }
        chain.length = record.reorgTo + 1;
        continue;
      }
      if (record.height !== chain.length) {
        throw new Error(
          `canonical.jsonl is not contiguous: expected height ${chain.length}, found ${record.height}. ` +
            'Restore the data directory from a backup or re-sync.',
        );
      }
      chain.push(record);
    }
    this.canonical = chain;
    // Rebuild the height map with canonical preference.
    for (const entry of this.canonical) {
      this.byHeight.set(entry.height, entry);
      if (!this.index.has(entry.hash)) {
        this.index.set(entry.hash, entry);
        this.diskBytes += entry.size;
        const candidates=this.candidatesByHeight.get(entry.height)??new Map<string,IndexEntry>();
        candidates.set(entry.hash,entry); this.candidatesByHeight.set(entry.height,candidates);
      }
    }
    // Compaction: a log that has been cut back is rewritten once, at start-up,
    // so it never grows without bound and the next boot reads a plain list.
    if (markers > 0) this.setCanonical(chain);
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

  entriesAtHeight(height:number):IndexEntry[] {
    return [...(this.candidatesByHeight.get(height)?.values()??[])];
  }

  /** Hash of `entry`'s ancestor at `height`, or undefined if disconnected. */
  ancestorHashAt(entry:IndexEntry,height:number):string|undefined {
    if (!Number.isSafeInteger(height)||height<0||height>entry.height) return undefined;
    let cursor:IndexEntry|undefined=entry;
    while(cursor&&cursor.height>height) cursor=this.index.get(cursor.prevHash);
    return cursor?.height===height?cursor.hash:undefined;
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
    // Publish in memory only after both the block and its durable index record
    // exist. A write error therefore cannot make callers observe a block that
    // will disappear on restart.
    appendLineSync(join(this.chainDir, 'index.jsonl'), JSON.stringify(entry));
    this.index.set(hash, entry);
    this.diskBytes += entry.size;
    const candidates=this.candidatesByHeight.get(entry.height)??new Map<string,IndexEntry>();
    candidates.set(hash,entry); this.candidatesByHeight.set(entry.height,candidates);
    const atHeight = this.byHeight.get(block.header.height);
    // Keep the canonical entry for a height if we already have one; otherwise
    // remember this block as the best known candidate for that height.
    if (!atHeight || this.canonical[block.header.height]?.hash !== atHeight.hash) {
      if (!atHeight) this.byHeight.set(block.header.height, entry);
    }
    return entry;
  }

  /**
   * Rewrite the canonical chain log from scratch. Used for genesis and for
   * start-up compaction. The hot paths — extending the chain and reorganising
   * it — append instead (see {@link appendCanonical} / {@link reorganiseCanonical}).
   */
  setCanonical(entries: IndexEntry[]): void {
    const next = [...entries];
    const body = next.map((entry) => JSON.stringify(entry)).join('\n');
    // head.json is a derived pointer. Write it before the authoritative log so
    // a failed log write cannot expose an uncommitted chain in memory. Startup
    // validates/repairs a stale or ahead pointer from canonical.jsonl.
    this.writeHead(next[next.length - 1]);
    atomicWriteFile(join(this.chainDir, 'canonical.jsonl'), body.length ? `${body}\n` : '');
    this.canonical = next;
    this.byHeight.clear();
    for (const entry of this.canonical) this.byHeight.set(entry.height, entry);
  }

  /**
   * Extend the canonical chain by exactly one block. O(1): one appended line and
   * the head pointer, whatever the chain's length.
   */
  appendCanonical(entry: IndexEntry): void {
    const tip = this.canonical[this.canonical.length - 1];
    if (!tip || entry.height !== tip.height + 1 || entry.prevHash !== tip.hash) {
      throw new Error(`cannot append ${entry.hash} at height ${entry.height}: it does not extend the canonical tip`);
    }
    this.writeHead(entry);
    appendLineSync(join(this.chainDir, 'canonical.jsonl'), JSON.stringify(entry));
    this.canonical.push(entry);
    this.byHeight.set(entry.height, entry);
  }

  /**
   * Cut the canonical chain back to `forkHeight` and continue along `entries`
   * (oldest first). Recorded as one marker plus the new tail in a single
   * append, so the cost is the depth of the reorganisation, not the chain.
   */
  reorganiseCanonical(forkHeight: number, entries: IndexEntry[]): void {
    if (!Number.isInteger(forkHeight) || forkHeight < 0 || forkHeight >= this.canonical.length) {
      throw new Error(`cannot reorganise to height ${forkHeight}: canonical chain has ${this.canonical.length} blocks`);
    }
    let parent = this.canonical[forkHeight]!;
    for (const entry of entries) {
      if (entry.height !== parent.height + 1 || entry.prevHash !== parent.hash) {
        throw new Error(`reorganisation is not a contiguous branch at height ${entry.height}`);
      }
      parent = entry;
    }
    const marker: CanonicalMarker = { reorgTo: forkHeight };
    const nextHead = entries[entries.length - 1] ?? this.canonical[forkHeight];
    this.writeHead(nextHead);
    appendLinesSync(join(this.chainDir, 'canonical.jsonl'), [
      JSON.stringify(marker),
      ...entries.map((entry) => JSON.stringify(entry)),
    ]);
    for (let height = forkHeight + 1; height < this.canonical.length; height += 1) this.byHeight.delete(height);
    this.canonical.length = forkHeight + 1;
    for (const entry of entries) {
      this.canonical.push(entry);
      this.byHeight.set(entry.height, entry);
    }
  }

  /**
   * Walk back from `headHash` to the first block that is already canonical.
   * Returns the fork height and the NEW blocks above it (oldest first), or null
   * when the branch never meets the canonical chain (a different genesis).
   * Costs the length of the branch, not the length of the chain.
   */
  branchFromCanonical(headHash: string): { forkHeight: number; entries: IndexEntry[] } | null {
    const entries: IndexEntry[] = [];
    let cursor: string | undefined = headHash;
    while (cursor) {
      const entry = this.index.get(cursor);
      if (!entry) return null;
      if (this.canonical[entry.height]?.hash === entry.hash) {
        entries.reverse();
        return { forkHeight: entry.height, entries };
      }
      if (entry.height === 0) return null;
      entries.push(entry);
      cursor = entry.prevHash || undefined;
    }
    return null;
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

  private writeHead(head = this.head): void {
    const pointer: HeadPointer = head
      ? { height: head.height, hash: head.hash, updatedAt: new Date().toISOString() }
      : { height: -1, hash: '', updatedAt: new Date().toISOString() };
    atomicWriteFile(join(this.chainDir, 'head.json'), `${JSON.stringify(pointer, null, 2)}\n`);
  }

  // ── State checkpoints ─────────────────────────────────────────────────────

  private loadCheckpointIndex(): void {
    const path = join(this.stateDir, 'checkpoints.json');
    let entries: CheckpointEntry[] = [];
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as { checkpoints?: CheckpointEntry[] };
        entries = (parsed.checkpoints ?? []).filter(
          (entry) =>
            Number.isSafeInteger(entry?.height) &&
            entry.height >= 0 &&
            typeof entry.blockHash === 'string' &&
            /^[0-9a-f]{64}$/.test(entry.blockHash) &&
            entry.file === `checkpoint-${entry.height}.json` &&
            (entry.checksum === undefined || /^[0-9a-f]{64}$/.test(entry.checksum)) &&
            existsSync(join(this.stateDir, entry.file)),
        );
      } catch {
        entries = [];
      }
    }
    if (entries.length === 0) {
      // A data directory written before the index existed still has its newest
      // snapshot pointer; that one entry is enough to resume from.
      const pointer = join(this.stateDir, 'latest.json');
      if (existsSync(pointer)) {
        try {
          const latest = JSON.parse(readFileSync(pointer, 'utf8')) as CheckpointEntry;
          if (
            Number.isSafeInteger(latest.height) &&
            latest.height >= 0 &&
            /^[0-9a-f]{64}$/.test(latest.blockHash) &&
            latest.file === `checkpoint-${latest.height}.json` &&
            (latest.checksum === undefined || /^[0-9a-f]{64}$/.test(latest.checksum)) &&
            existsSync(join(this.stateDir, latest.file))
          ) {
            entries = [{ ...latest, savedAt: latest.savedAt ?? '' }];
          }
        } catch {
          /* no usable snapshot: replay from genesis */
        }
      }
    }
    this.checkpointEntries = entries.sort((a, b) => b.height - a.height);
  }

  private writeCheckpointIndex(entries = this.checkpointEntries): void {
    atomicWriteFile(
      join(this.stateDir, 'checkpoints.json'),
      `${JSON.stringify({ version: 1, checkpoints: entries }, null, 2)}\n`,
    );
  }

  saveState(snapshot: StateSnapshot): void {
    if (
      snapshot.snapshotVersion !== STATE_SNAPSHOT_VERSION ||
      !Number.isSafeInteger(snapshot.height) ||
      snapshot.height < 0 ||
      !Number.isSafeInteger(snapshot.chainId) ||
      snapshot.chainId < 0 ||
      typeof snapshot.protocolVersion !== 'string' ||
      snapshot.protocolVersion.length === 0 ||
      typeof snapshot.networkId !== 'string' ||
      snapshot.networkId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(snapshot.blockHash) ||
      !/^[0-9a-f]{40}$/.test(snapshot.genesisId ?? '') ||
      !/^[0-9a-f]{32}$/.test(snapshot.paramsHash ?? '') ||
      !/^[0-9a-f]{64}$/.test(snapshot.stateRoot ?? '')
    ) {
      throw new Error('refusing to save a checkpoint without complete versioned chain identity');
    }
    const file = `checkpoint-${snapshot.height}.json`;
    const body = stringifyState(snapshot);
    const checksum = sha256Hex(utf8(body));
    const savedAt = new Date().toISOString();
    const entry: CheckpointEntry = { height: snapshot.height, blockHash: snapshot.blockHash, file, savedAt, checksum };
    const next = [
      entry,
      ...this.checkpointEntries.filter((candidate) => candidate.height !== snapshot.height),
    ].sort((a, b) => b.height - a.height);
    atomicWriteFile(join(this.stateDir, file), `${body}\n`);
    atomicWriteFile(
      join(this.stateDir, 'checkpoints.json'),
      `${JSON.stringify({ version: 1, checkpoints: next }, null, 2)}\n`,
    );
    atomicWriteFile(join(this.stateDir, 'latest.json'), `${JSON.stringify(entry, null, 2)}\n`);
    this.checkpointEntries = next;
  }

  /** Saved snapshots, newest first, each with the block it belongs to. */
  checkpoints(): CheckpointEntry[] {
    return [...this.checkpointEntries];
  }

  /** Load one specific snapshot by height (null when missing or unreadable). */
  loadStateAt(height: number): StateSnapshot | null {
    const entry = this.checkpointEntries.find((candidate) => candidate.height === height);
    if (!entry) return null;
    const path = join(this.stateDir, entry.file);
    if (!existsSync(path)) return null;
    try {
      const snapshot = parseState<StateSnapshot>(readFileSync(path, 'utf8'));
      if (entry.checksum) {
        const computed = sha256Hex(utf8(stringifyState(snapshot)));
        if (computed !== entry.checksum) return null;
      }
      return snapshot;
    } catch {
      return null;
    }
  }

  loadLatestState(): StateSnapshot | null {
    const newest = this.checkpointEntries[0];
    return newest ? this.loadStateAt(newest.height) : null;
  }

  /** Every stored checkpoint height, newest first (used for recovery). */
  listCheckpoints(): number[] {
    return this.checkpointEntries.map((entry) => entry.height);
  }

  pruneCheckpoints(keep: number): string[] {
    const removed: string[] = [];
    const doomed = this.checkpointEntries.slice(keep);
    if (doomed.length === 0) return removed;
    const next = this.checkpointEntries.slice(0, keep);
    // Commit the durable index and then publish the new in-memory view. Old
    // snapshot files are unreferenced leftovers if unlinking fails, which is
    // safer than an index that names a file already deleted before a write error.
    this.writeCheckpointIndex(next);
    this.checkpointEntries = next;
    for (const entry of doomed) {
      const path = join(this.stateDir, entry.file);
      try {
        unlinkSync(path);
        removed.push(path);
      } catch {
        /* unreferenced file; retrying a future prune is optional */
      }
    }
    return removed;
  }

  /** Total bytes of stored block files (used by the health endpoint). */
  diskUsageBytes(): number {
    return this.diskBytes;
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
