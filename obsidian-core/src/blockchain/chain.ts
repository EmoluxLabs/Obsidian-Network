/**
 * ChainManager — the node's blockchain engine.
 *
 * Responsibilities:
 *   - boot from genesis or from the newest state checkpoint + replay;
 *   - validate incoming blocks and apply them through the state machine;
 *   - maintain fork branches and switch the canonical chain by the deterministic
 *     fork-choice rule;
 *   - reorganise safely, recomputing state from the common ancestor;
 *   - build blocks for this node's proposer slots;
 *   - expose chain queries for RPC, the explorer and the sync protocol.
 *
 * Nothing in this file trusts a peer: every block is re-validated and every
 * state root is recomputed locally.
 */

import { EventEmitter } from 'node:events';
import type {
  Block,
  BlockSummary,
  GenesisState,
  ProtocolEvent,
  StateSnapshot,
  TxEnvelope,
} from '../protocol/types.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { ErrCode, ProtocolError, reject } from '../protocol/errors.js';
import {
  applyBlock,
  applyTransactions,
  finalizeBlock,
  runBlockRoutines,
  type BlockContext,
} from './state-machine.js';
import { WorldState } from './state.js';
import { PARAMS_HASH, computeStateRoot } from './state-root.js';
import {
  assertBlockSignature,
  assertBlockSize,
  blockHash,
  buildBlock,
  potWeight,
  decodeBlock,
  encodeBlock,
  transactionRootOf,
} from './block.js';
import { BlockStore, CHECKPOINT_INTERVAL_BLOCKS, type IndexEntry } from '../storage/blockstore.js';
import { Mempool } from './mempool.js';
import {
  checkBlockTimestamp,
  compareTips,
  isProposerAllowed,
  medianTimePast,
} from '../consensus/proposer.js';
import { buildGenesisBlock, createGenesisState, genesisId } from '../genesis/initialize.js';
import { assertNetworkSafety } from '../protocol/networks.js';
import { CORE_VERSION, PROTOCOL_VERSION } from '../version.js';

export interface ChainManagerOptions {
  dataDir: string;
  net: NetworkDefinition;
  /** Genesis document (fixed for the network). */
  genesisDocument: GenesisDocument;
  /** Enforce proposer rotation once validators are registered. */
  enforceProposerRotation?: boolean;
  /** How many recent states to keep in memory for fast reorgs. */
  stateHistoryDepth?: number;
  mempoolSize?: number;
}

export interface GenesisDocument {
  networkId: string;
  chainId: number;
  protocolVersion: string;
  /** Protocol time of the genesis block. */
  timestamp: number;
  /** Foundation note stored in genesis state (no allocation implied). */
  note: string;
}

export interface AddBlockResult {
  accepted: boolean;
  code: ErrCode;
  message: string;
  hash: string;
  height: number;
  reorged?: boolean;
  connected?: boolean;
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
  diskBytes: number;
  mempool: { transactions: number; bytes: number };
  peers: number;
  syncing: boolean;
  supply: string;
  activeMiners: number;
  oraclePriceUsdMicro: string;
  oracleStale: boolean;
  treasuryWallet: string;
  genesisAllocationClaimed: boolean;
  validators: number;
  lastBlockTimestamp: number;
}

export class ChainManager extends EventEmitter {
  readonly store: BlockStore;
  readonly mempool: Mempool;
  private state!: WorldState;
  private readonly stateHistory = new Map<number, WorldState>();
  /**
   * Protocol events produced by applying each recent block. The indexer and the
   * RPC layer read from here so both see exactly the events the state machine
   * emitted — never a re-derivation that could drift from consensus.
   */
  private readonly eventsByHash = new Map<string, ProtocolEvent[]>();
  private static readonly EVENTS_CACHE_LIMIT = 2048;
  private readonly orphanPool = new Map<string, Block>();
  private readonly options: ChainManagerOptions;
  private syncing = false;

  constructor(options: ChainManagerOptions) {
    super();
    this.options = options;
    this.store = new BlockStore(options.dataDir);
    this.mempool = new Mempool({
      maxTransactions: options.mempoolSize ?? 10_000,
      maxBytes: 32 * 1024 * 1024,
      maxPerSender: 64,
    });
    assertNetworkSafety(options.net);
  }

  // ── Boot ──────────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    const meta = this.store.getMeta();
    const genesisBlock = buildGenesisBlock(this.options.genesisDocument, this.options.net);
    const genesisHash = blockHash(genesisBlock.header);
    const genesisIdentifier = genesisId(this.options.genesisDocument, this.options.net);

    if (!meta) {
      if (this.store.size > 0) {
        throw new Error('chain data exists but metadata is missing: refusing to start on an unknown chain');
      }
      this.store.setMeta({
        networkId: this.options.net.networkId,
        chainId: this.options.net.chainId,
        genesisId: genesisIdentifier,
        genesisHash,
        protocolVersion: PROTOCOL_VERSION,
        paramsHash: PARAMS_HASH,
        createdAt: new Date().toISOString(),
      });
      this.store.putBlock(genesisBlock);
      this.store.setCanonical([this.store.getIndexEntry(genesisHash)!]);
      this.state = createGenesisState(genesisBlock, this.options.net);
      this.persistCheckpoint(true);
      this.emit('ready', { genesisHash, genesisId: genesisIdentifier });
      return;
    }

    // Existing data directory: verify it belongs to this network and genesis.
    if (meta.networkId !== this.options.net.networkId || meta.chainId !== this.options.net.chainId) {
      throw new Error(
        `data directory belongs to ${meta.networkId} (chain ${meta.chainId}), not ${this.options.net.networkId}`,
      );
    }
    if (meta.genesisId !== genesisIdentifier || meta.genesisHash !== genesisHash) {
      throw new Error(
        'genesis mismatch: this data directory was created from a different genesis document. ' +
          'Refusing to start (that would be a silent chain split).',
      );
    }
    await this.reload();
    this.emit('ready', { genesisHash, genesisId: genesisIdentifier });
  }

  /** Reload state from the newest checkpoint and replay to the head. */
  private async reload(): Promise<void> {
    const checkpoint = this.store.loadLatestState();
    const head = this.store.head;
    if (!head) {
      const genesisBlock = buildGenesisBlock(this.options.genesisDocument, this.options.net);
      this.store.putBlock(genesisBlock);
      this.store.setCanonical([this.store.getIndexEntry(blockHash(genesisBlock.header))!]);
      this.state = createGenesisState(genesisBlock, this.options.net);
      this.persistCheckpoint(true);
      return;
    }

    let baseState: WorldState;
    let fromHeight = 0;
    if (checkpoint && checkpoint.height <= head.height) {
      baseState = WorldState.fromSnapshot(checkpoint);
      fromHeight = checkpoint.height + 1;
    } else {
      const genesisBlock = this.store.getBlockByHash(this.store.genesis!.hash);
      if (!genesisBlock) throw new Error('genesis block missing from storage: the data directory is corrupt');
      baseState = createGenesisState(genesisBlock, this.options.net);
      fromHeight = 1;
    }

    for (let height = fromHeight; height <= head.height; height += 1) {
      const block = this.store.getBlockByHash(this.store.getCanonicalHashAtHeight(height)!);
      if (!block) throw new Error(`canonical block at height ${height} is missing from storage`);
      const result = applyBlock(baseState, block, { net: this.options.net });
      baseState = result.state;
      this.rememberState(height, baseState);
    }
    this.state = baseState;
  }

  private rememberState(height: number, state: WorldState): void {
    const depth = this.options.stateHistoryDepth ?? 256;
    this.stateHistory.set(height, state);
    for (const key of this.stateHistory.keys()) {
      if (height - key > depth) this.stateHistory.delete(key);
    }
  }

  private persistCheckpoint(force = false): void {
    const head = this.store.head;
    if (!head) return;
    if (!force && head.height % CHECKPOINT_INTERVAL_BLOCKS !== 0) return;
    this.store.saveState(this.state.toSnapshot(head.hash));
    if (head.height > CHECKPOINT_INTERVAL_BLOCKS * 3) this.store.pruneCheckpoints(3);
  }

  // ── Accessors ─────────────────────────────────────────────────────────────

  get world(): WorldState {
    return this.state;
  }

  /** Network this chain belongs to (chain id, HRP, ports, protocol magic). */
  get net(): NetworkDefinition {
    return this.options.net;
  }

  /** Genesis document this chain was started from. */
  get genesisDocument(): GenesisDocument {
    return this.options.genesisDocument;
  }

  /**
   * Canonical genesis identifier: the only value nodes exchange to prove they
   * are on the same chain. Two nodes with the same genesisId agree on the
   * network id, chain id, protocol version, genesis timestamp and address HRP.
   */
  get genesisId(): string {
    return genesisId(this.options.genesisDocument, this.options.net);
  }

  get stateRoot(): string {
    return computeStateRoot(this.state.s);
  }

  get tip(): IndexEntry | undefined {
    return this.store.head;
  }

  get height(): number {
    return this.store.head?.height ?? 0;
  }

  get lastBlockTimestamp(): number {
    return this.store.head?.timestamp ?? this.options.genesisDocument.timestamp;
  }

  /**
   * Protocol time for the NEXT block.
   *
   * This is the local clock, but it is only a *proposal*: the protocol accepts a
   * block timestamp only when it is strictly greater than the median time past
   * of recent blocks and no more than params.block.maxFutureDriftSeconds ahead
   * of the validating node's clock. The chain therefore starts at the genesis
   * instant and may legitimately jump forward to wall-clock time after a launch,
   * while a producer can never rewind or run away from the network.
   */
  get protocolTime(): number {
    const head = this.store.head;
    const ancestors = this.store.ancestorTimestamps(head?.hash ?? '', CONSENSUS_PARAMS.block.medianTimePastWindow);
    const median = medianTimePast(ancestors.map((timestamp) => ({ timestamp })));
    const local = Math.floor(Date.now() / 1000);
    // Wall clock, but never behind the parent (timestamps are strictly
    // increasing) and never below median time past. Validating nodes still
    // enforce `timestamp <= theirOwnClock + drift`, so no producer can run away.
    return Math.max(local, (head?.timestamp ?? 0) + 1, median + 1);
  }

  setSyncing(value: boolean): void {
    this.syncing = value;
  }

  get isSyncing(): boolean {
    return this.syncing;
  }

  status(extra: { peers?: number } = {}): ChainStatus {
    const head = this.store.head;
    return {
      height: head?.height ?? 0,
      headHash: head?.hash ?? '',
      genesisHash: this.store.getMeta()?.genesisHash ?? '',
      genesisId: this.store.getMeta()?.genesisId ?? '',
      networkId: this.options.net.networkId,
      chainId: this.options.net.chainId,
      protocolVersion: PROTOCOL_VERSION,
      paramsHash: PARAMS_HASH,
      totalBlocks: this.store.size,
      diskBytes: this.store.diskUsageBytes(),
      mempool: { transactions: this.mempool.size, bytes: this.mempool.byteSize },
      peers: extra.peers ?? 0,
      syncing: this.syncing,
      supply: this.state.s.metrics.totalSupply.toString(),
      activeMiners: this.state.s.metrics.activeMiners,
      oraclePriceUsdMicro: this.state.s.oracle.medianPriceUsdMicro.toString(),
      oracleStale: this.state.s.oracle.stale,
      treasuryWallet: this.state.s.genesis.treasuryWallet,
      genesisAllocationClaimed: this.state.s.genesis.allocationClaimed,
      validators: this.state.s.validators.size,
      lastBlockTimestamp: head?.timestamp ?? 0,
    };
  }

  // ── Block ingestion ───────────────────────────────────────────────────────

  /**
   * Validate and (if it belongs) connect a block. Blocks whose parent is
   * unknown are queued as orphans and retried when the parent arrives.
   */
  addBlock(block: Block): AddBlockResult {
    const hash = blockHash(block.header);
    if (this.store.hasBlock(hash) && this.store.getCanonicalHashAtHeight(block.header.height) === hash) {
      return {
        accepted: false,
        code: ErrCode.DUPLICATE_BLOCK,
        message: 'block is already part of the canonical chain',
        hash,
        height: block.header.height,
      };
    }

    const parentEntry = this.store.getIndexEntry(block.header.prevHash);
    if (!parentEntry) {
      this.orphanPool.set(hash, block);
      return {
        accepted: false,
        code: ErrCode.ORPHAN_BLOCK,
        message: 'parent block is unknown; queued as an orphan',
        hash,
        height: block.header.height,
      };
    }

    let result: {
      state: WorldState;
      reorged: boolean;
      connected: boolean;
    };
    try {
      result = this.connectBlock(block, parentEntry);
    } catch (error) {
      const protocolError =
        error instanceof ProtocolError
          ? error
          : new ProtocolError(ErrCode.INTERNAL, (error as Error).message);
      return {
        accepted: false,
        code: protocolError.code,
        message: protocolError.message,
        hash,
        height: block.header.height,
      };
    }

    // Retry orphans that were waiting for this block.
    for (const [orphanHash, orphan] of [...this.orphanPool.entries()]) {
      if (orphan.header.prevHash === hash) {
        this.orphanPool.delete(orphanHash);
        const child = this.addBlock(orphan);
        if (child.accepted) this.emit('block', orphan, this.eventsForBlock(blockHash(orphan.header)));
      }
    }

    return {
      accepted: true,
      code: ErrCode.OK,
      message: result.reorged ? 'block accepted (reorg)' : 'block accepted',
      hash,
      height: block.header.height,
      reorged: result.reorged,
      connected: result.connected,
    };
  }

  /** Structural + state validation, then fork choice and possible reorg. */
  private connectBlock(block: Block, parentEntry: IndexEntry): { state: WorldState; reorged: boolean; connected: boolean } {
    const header = block.header;
    assertBlockSize(block);
    if (header.chainId !== this.options.net.chainId) {
      reject(ErrCode.WRONG_CHAIN_ID, `block chain id ${header.chainId} != ${this.options.net.chainId}`);
    }
    if (header.protocolVersion !== PROTOCOL_VERSION) {
      reject(ErrCode.VERSION_MISMATCH, `block protocol version ${header.protocolVersion} != ${PROTOCOL_VERSION}`);
    }
    if (header.paramsHash !== PARAMS_HASH) {
      reject(ErrCode.VERSION_MISMATCH, 'block was produced with a different consensus parameter set');
    }
    if (header.height !== parentEntry.height + 1) {
      reject(ErrCode.BAD_HEIGHT, `block height ${header.height} does not follow parent ${parentEntry.height}`);
    }
    const expectedWork = BigInt(parentEntry.cumulativePotWeight) + potWeight(block.transactions.length);
    if (header.cumulativePotWeight !== expectedWork) {
      reject(ErrCode.BAD_DIFFICULTY, 'cumulative work does not match the parent plus this block');
    }
    assertBlockSignature(block, this.options.net.addressHrp);

    const ancestorTimestamps = this.store.ancestorTimestamps(header.prevHash, CONSENSUS_PARAMS.block.medianTimePastWindow);
    const timestampCheck = checkBlockTimestamp(header.timestamp, ancestorTimestamps, Math.floor(Date.now() / 1000));
    if (!timestampCheck.ok) {
      reject(ErrCode.BAD_TIMESTAMP, timestampCheck.reason ?? 'invalid block timestamp');
    }

    // Apply on top of the PARENT state, not the current head: this is what makes
    // fork branches validatable without trusting this node's own view.
    const parentState = this.stateAtHeight(parentEntry.height, parentEntry.hash);
    if (this.options.enforceProposerRotation !== false && !isProposerAllowed(parentState, header.producer, header.height)) {
      reject(ErrCode.NOT_PRODUCER_TURN, `proposer ${header.producer} is not scheduled for height ${header.height}`);
    }

    const applied = applyBlock(parentState, block, { net: this.options.net });

    this.store.putBlock(block);
    const entry = this.store.getIndexEntry(blockHash(header))!;
    this.rememberState(entry.height, applied.state);
    this.rememberEvents(entry.hash, applied.events);

    const tipEntry = this.store.head;
    const currentTip =
      tipEntry && tipEntry.hash === entry.hash
        ? null
        : tipEntry
          ? { height: tipEntry.height, cumulativePotWeight: BigInt(tipEntry.cumulativePotWeight), hash: tipEntry.hash }
          : null;
    const candidate = { height: entry.height, cumulativePotWeight: BigInt(entry.cumulativePotWeight), hash: entry.hash };

    if (!currentTip) {
      // Already the tip (idempotent put) — nothing to reconnect.
      return { state: this.state, reorged: false, connected: false };
    }
    if (compareTips(candidate, currentTip) <= 0) {
      // Valid but not the heaviest chain: keep it as a stored side branch.
      this.emit('sidechain', { hash: entry.hash, height: entry.height });
      return { state: this.state, reorged: false, connected: false };
    }

    const reorged = parentEntry.hash !== currentTip.hash;
    if (reorged) {
      this.reorganise(entry.hash);
      this.emit('reorg', { to: entry.hash, height: entry.height, from: currentTip.hash });
    } else {
      this.state = applied.state;
      this.rememberState(entry.height, applied.state);
      this.store.setCanonical(this.store.rebuildCanonicalFrom(entry.hash));
      this.persistCheckpoint();
    }
    this.emit('block', block, applied.events);
    return { state: this.state, reorged, connected: true };
  }

  /** Protocol events emitted by the given block (empty when it was pruned). */
  eventsForBlock(hash: string): ProtocolEvent[] {
    return this.eventsByHash.get(hash) ?? [];
  }

  private rememberEvents(hash: string, events: ProtocolEvent[]): void {
    this.eventsByHash.set(hash, events);
    if (this.eventsByHash.size <= ChainManager.EVENTS_CACHE_LIMIT) return;
    const oldest = this.eventsByHash.keys().next().value;
    if (oldest !== undefined) this.eventsByHash.delete(oldest);
  }

  /** Deterministic reorganiser: recompute state from the common ancestor up. */
  private reorganise(newHeadHash: string): void {
    const chain = this.store.rebuildCanonicalFrom(newHeadHash);
    if (chain.length === 0) throw new Error('reorg failed: new head is not connected to genesis');
    const forkHeight = this.commonAncestorHeight(chain);
    const depth = chain[chain.length - 1].height - forkHeight;
    if (depth > CONSENSUS_PARAMS.consensus.maxReorgDepth) {
      reject(ErrCode.ORPHAN_BLOCK, `reorg depth ${depth} exceeds the protocol maximum ${CONSENSUS_PARAMS.consensus.maxReorgDepth}`);
    }
    const forkEntry = chain[forkHeight];
    let state = this.stateAtHeight(forkHeight, forkEntry.hash, true);
    for (let height = forkHeight + 1; height < chain.length; height += 1) {
      const block = this.store.getBlockByHash(chain[height].hash);
      if (!block) throw new Error(`reorg failed: missing block at height ${height}`);
      const applied = applyBlock(state, block, { net: this.options.net });
      state = applied.state;
      this.rememberState(height, state);
      this.rememberEvents(chain[height].hash, applied.events);
    }
    this.state = state;
    this.stateHistory.clear();
    this.rememberState(chain.length - 1, state);
    this.store.setCanonical(chain);
    this.persistCheckpoint(true);
    this.revalidateMempool();
  }

  private commonAncestorHeight(chain: IndexEntry[]): number {
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      const canonicalAtHeight = this.store.getCanonicalHashAtHeight(chain[i].height);
      if (canonicalAtHeight === chain[i].hash) return chain[i].height;
    }
    return 0;
  }

  /** State at `height`/`hash`, using history, checkpoints or replay. */
  stateAtHeight(height: number, hash: string, forceReplay = false): WorldState {
    if (!forceReplay) {
      const cached = this.stateHistory.get(height);
      if (cached && this.store.getCanonicalHashAtHeight(height) === hash) return cached;
    }
    const checkpoint = this.store.loadLatestState();
    let state: WorldState;
    let from: number;
    if (checkpoint && checkpoint.height <= height) {
      state = WorldState.fromSnapshot(checkpoint);
      from = checkpoint.height + 1;
    } else {
      const genesisEntry = this.store.genesis;
      if (!genesisEntry) throw new Error('no genesis block stored');
      const genesisBlock = this.store.getBlockByHash(genesisEntry.hash);
      if (!genesisBlock) throw new Error('genesis block missing');
      state = createGenesisState(genesisBlock, this.options.net);
      from = 1;
    }
    for (let h = from; h <= height; h += 1) {
      // Walk down from the target hash through its own ancestors.
      const entry = this.entryAtHeightOnBranch(hash, h);
      if (!entry) throw new Error(`cannot resolve block at height ${h} on the requested branch`);
      const block = this.store.getBlockByHash(entry.hash);
      if (!block) throw new Error(`missing block ${entry.hash} at height ${h}`);
      state = applyBlock(state, block, { net: this.options.net }).state;
    }
    this.stateHistory.set(height, state);
    return state;
  }

  private entryAtHeightOnBranch(headHash: string, height: number): IndexEntry | undefined {
    let cursor: string | undefined = headHash;
    while (cursor) {
      const entry = this.store.getIndexEntry(cursor);
      if (!entry) return undefined;
      if (entry.height === height) return entry;
      cursor = entry.height === 0 ? undefined : entry.prevHash || undefined;
    }
    return undefined;
  }

  /** Drop mempool transactions that no longer validate after a reorg. */
  private revalidateMempool(): void {
    for (const entry of this.mempool.snapshot()) {
      const poolEntry = this.mempool.get(entry.txId);
      if (!poolEntry) continue;
      const expectedNonce = this.state.getAccount(poolEntry.tx.sender)?.nonce ?? 0;
      if (poolEntry.tx.nonce < expectedNonce) this.mempool.remove(entry.txId);
      if (this.state.hasTxId(entry.txId)) this.mempool.remove(entry.txId);
    }
  }

  // ── Block production ──────────────────────────────────────────────────────

  /**
   * Build the next block for this slot. Returns null when this node is not the
   * scheduled proposer (validator rotation) — nodes never race to produce.
   */
  buildNextBlock(producer: { address: string; privateKey: string; publicKey: string }): Block | null {
    const head = this.store.head;
    if (!head) return null;
    if (!isProposerAllowed(this.state, producer.address, head.height + 1)) return null;

    const height = head.height + 1;
    const timestamp = this.protocolTime;
    const ctx: BlockContext = {
      height,
      timestamp,
      chainId: this.options.net.chainId,
      producer: producer.address,
    };

    const candidates = this.mempool.selectForBlock(
      CONSENSUS_PARAMS.block.maxBlockTransactions,
      Mempool.nonceMapFrom(this.state),
    );

    // Simulate candidate by candidate. A transaction that fails at this height
    // is dropped from the block rather than poisoning it; each attempt runs on a
    // clone so a failure leaves the working state untouched.
    let working = this.state.clone();
    working.advanceBlock(height, timestamp);
    const events: ProtocolEvent[] = [];
    const accepted: TxEnvelope[] = [];

    for (const tx of candidates) {
      const trial = working.clone();
      trial.advanceBlock(height, timestamp);
      try {
        const outcome = applyTransactions(trial, [tx], ctx, this.options.net);
        working = outcome.state;
        events.push(...outcome.events);
        accepted.push(tx);
      } catch {
        continue;
      }
    }

    events.push(...runBlockRoutines(working, ctx, this.options.net));
    const finalized = finalizeBlock(working, events);

    return buildBlock({
      protocolVersion: PROTOCOL_VERSION,
      chainId: this.options.net.chainId,
      height,
      prevHash: head.hash,
      stateRoot: finalized.stateRoot,
      eventsRoot: finalized.eventsRoot,
      timestamp,
      producer: producer.address,
      producerPrivateKey: producer.privateKey,
      producerPublicKey: producer.publicKey,
      parentCumulativePotWeight: BigInt(head.cumulativePotWeight),
      transactions: accepted,
    });
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getBlockByHash(hash: string): Block | null {
    return this.store.getBlockByHash(hash);
  }

  getBlockByHeight(height: number): Block | null {
    const hash = this.store.getCanonicalHashAtHeight(height);
    return hash ? this.store.getBlockByHash(hash) : null;
  }

  recentBlocks(limit: number): BlockSummary[] {
    const out: BlockSummary[] = [];
    const head = this.store.head;
    if (!head) return out;
    for (let height = head.height; height >= 0 && out.length < limit; height -= 1) {
      const entry = this.store.getCanonicalAtHeight(height);
      if (!entry) continue;
      out.push({
        hash: entry.hash,
        height: entry.height,
        timestamp: entry.timestamp,
        txCount: entry.txCount,
        producer: entry.producer,
        size: entry.size,
        prevHash: entry.prevHash,
      });
    }
    return out;
  }

  /** Serialized blocks for the sync protocol, oldest first. */
  blocksForSync(fromHeight: number, limit: number): { blocks: Uint8Array[]; more: boolean } {
    const entries = this.store.canonicalRange(fromHeight, limit);
    const blocks = entries.map((entry) => {
      const block = this.store.getBlockByHash(entry.hash)!;
      return encodeBlock(block);
    });
    return { blocks, more: this.height >= fromHeight + limit };
  }

  blockFromBytes(bytes: Uint8Array): Block {
    return decodeBlock(bytes);
  }

  addBlockFromBytes(bytes: Uint8Array): AddBlockResult {
    return this.addBlock(decodeBlock(bytes));
  }

  genesisState(): GenesisState {
    return { ...this.state.s.genesis };
  }

  snapshot(): StateSnapshot {
    return this.state.toSnapshot(this.store.head?.hash ?? '');
  }

  /**
   * Verify a paused/restored node against its own storage.
   *
   * This is the check an operator runs after a crash, a full disk or suspected
   * bit rot, so "the file exists" is not the question: the question is whether
   * the bytes still *are* that block. Each stored block is therefore re-hashed
   * from its header and its body is re-merkle'd against the header's `txRoot`,
   * and the result must equal the hash it is filed under. Without that step a
   * corrupt or edited block file passed as `ok: true` — the node would keep
   * serving it to peers and to `/block/<hash>` as if it were chain data.
   */
  verifyIntegrity(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const head = this.store.head;
    if (!head) return { ok: false, problems: ['no blocks stored'] };
    for (let height = 1; height <= head.height; height += 1) {
      const entry = this.store.getCanonicalAtHeight(height);
      if (!entry) {
        problems.push(`missing canonical entry at height ${height}`);
        break;
      }
      const block = this.store.getBlockByHash(entry.hash);
      if (!block) {
        problems.push(`missing block file for height ${height}`);
        break;
      }
      if (block.header.prevHash !== this.store.getCanonicalHashAtHeight(height - 1)) {
        problems.push(`parent link broken at height ${height}`);
        break;
      }
      const recomputed = blockHash(block.header);
      if (recomputed !== entry.hash) {
        problems.push(`block ${height} does not hash to its canonical id (stored ${entry.hash.slice(0, 16)}…, recomputed ${recomputed.slice(0, 16)}…)`);
        break;
      }
      const bodyRoot = transactionRootOf(block.transactions);
      if (bodyRoot !== block.header.txRoot) {
        problems.push(`block ${height} body does not match its transaction root (header ${block.header.txRoot.slice(0, 16)}…, body ${bodyRoot.slice(0, 16)}…)`);
        break;
      }
    }
    const invariant = this.state.verifySupplyInvariant();
    if (!invariant.ok) problems.push(invariant.reason);
    return { ok: problems.length === 0, problems };
  }

  /** Core version advertised to peers and the interface. */
  get version(): string {
    return CORE_VERSION;
  }
}
