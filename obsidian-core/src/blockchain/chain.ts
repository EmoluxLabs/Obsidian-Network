/**
 * ChainManager — the node's blockchain engine.
 *
 * Responsibilities:
 *   - boot from genesis or from the newest state checkpoint + replay;
 *   - validate incoming blocks and apply them through the state machine;
 *   - maintain fork branches and switch the canonical chain by the deterministic
 *     fork-choice rule;
 *   - reorganise safely, recomputing state from the common ancestor;
 *   - build blocks for this node's producer slots (the schedule is derived from chain state);
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
import { TxType } from '../protocol/types.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { ErrCode, ProtocolError, reject } from '../protocol/errors.js';
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  applyBlock,
  applyTransactions,
  cloneBlockTally,
  newBlockTally,
  finalizeBlock,
  runBlockRoutines,
  type BlockContext,
} from './state-machine.js';
import { WorldState } from './state.js';
import { decodeMiningBody } from '../transactions/executors/mining.js';
import { assertNodeStatementAdmissible } from '../transactions/executors/node-registry.js';
import { assertMiningGate } from '../mining/gate.js';
import { assertMiningEligibility } from '../mining/rules.js';
import { PARAMS_HASH, computeStateRoot } from './state-root.js';
import {
  assertBlockSignature,
  assertBlockSize,
  blockHash,
  buildBlock,
  potWeight,
  decodeBlock,
  encodeBlock,
  encodeSignedHeader,
  transactionRootOf,
} from './block.js';
import { BlockStore, CHECKPOINT_INTERVAL_BLOCKS, type IndexEntry } from '../storage/blockstore.js';
import { DEFAULT_MEMPOOL_OPTIONS, Mempool } from './mempool.js';
import {
  assertProducerAllowed,
  checkBlockTimestamp,
  compareTips,
  isProducerAllowed,
  medianTimePast,
  missedProducersFor,
  producerDecision,
  producerSetFor,
  proposerRound,
  scheduledProducer,
  type ProducerDecision,
} from '../consensus/schedule.js';
import { finalityReport, type FinalityReport } from '../consensus/finality.js';
import { validateTxStructure } from '../transactions/encode.js';
import {
  buildGenesisBlock,
  createGenesisState,
  genesisId,
  normalizeMiningGatePublicKeys,
} from '../genesis/initialize.js';
import { committedMiningGateKeys } from '../genesis/gate-keys.js';
import { assertNetworkSafety } from '../protocol/networks.js';
import { decodeGateAuthorityBody, verifyGateUpdate } from '../mining/gate-authority.js';
import { CORE_VERSION, PROTOCOL_VERSION, STATE_SNAPSHOT_VERSION } from '../version.js';
import { SafetyStore, type SafetyIdentity, type SafetyRecord } from '../storage/safety-store.js';
import { toHex } from '../crypto/hash.js';

export interface ChainManagerOptions {
  dataDir: string;
  net: NetworkDefinition;
  /** Genesis document (fixed for the network). */
  genesisDocument: GenesisDocument;
  /** Enforce the producer schedule once nodes are registered. */
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
  /** Sorted compressed issuer public keys whose certificates open the mining gate (see mining/gate.ts). */
  miningGatePublicKeys?: string[];
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
  /** Registered, non-banned nodes: the candidates the producer schedule is drawn from. */
  nodes: number;
  /** Which tier of the schedule is in force for the next block (see consensus/schedule.ts). */
  scheduleTier: 'TIER1' | 'TIER2' | 'OPEN';
  lastBlockTimestamp: number;
  finalizedHeight: number;
  finalizedHash: string;
  finalityLag: number;
  finalityAvailable: boolean;
  finalityEligibleProducers: number;
  finalityQuorum: number;
}

export class ChainManager extends EventEmitter {
  readonly store: BlockStore;
  readonly mempool: Mempool;
  private state!: WorldState;
  /**
   * Recent states, keyed by BLOCK HASH.
   *
   * This used to be keyed by height. A losing sibling at the head's height then
   * overwrote the canonical state in the cache, and the next canonical block
   * was validated against the sibling's state and rejected with
   * ERR_BAD_STATE_ROOT — a node that merely HEARD a competing block stopped
   * accepting valid children of its own head. A state belongs to one block, so
   * it is stored under that block.
   */
  private readonly stateCache = new Map<string, { height: number; state: WorldState }>();
  /** States kept behind the head. Older ones are rebuilt from a snapshot on demand. */
  private static readonly STATE_CACHE_DEPTH = 64;
  /** Competing branches may not pin unbounded memory: a few siblings per height. */
  private static readonly MAX_SIDE_STATES_PER_HEIGHT = 3;
  /**
   * Protocol events produced by applying each recent block. The indexer and the
   * RPC layer read from here so both see exactly the events the state machine
   * emitted — never a re-derivation that could drift from consensus.
   */
  private readonly eventsByHash = new Map<string, ProtocolEvent[]>();
  private static readonly EVENTS_CACHE_LIMIT = 2048;
  /**
   * Blocks whose parent is not known yet. Bounded in number, bytes and how far
   * above the head they may sit: an unauthenticated peer can send these for
   * free, so an unbounded pool is a memory-exhaustion switch.
   */
  private readonly orphanPool = new Map<string, { block: Block; bytes: number }>();
  private orphanBytes = 0;
  private static readonly MAX_ORPHAN_BLOCKS = 64;
  private static readonly MAX_ORPHAN_BYTES = 16 * 1024 * 1024;
  private static readonly MAX_ORPHAN_LOOKAHEAD = 128;
  private readonly options: ChainManagerOptions;
  /** Corrupt/incompatible checkpoints ignored during recovery, exposed by integrity verification. */
  private readonly recoveryProblems: string[] = [];
  private syncing = false;
  private readonly safetyStore: SafetyStore;
  private safety!: SafetyRecord;

  constructor(options: ChainManagerOptions) {
    super();
    this.options = options;
    this.store = new BlockStore(options.dataDir);
    this.safetyStore = new SafetyStore(options.dataDir);
    this.mempool = new Mempool({
      ...DEFAULT_MEMPOOL_OPTIONS,
      maxTransactions: options.mempoolSize ?? DEFAULT_MEMPOOL_OPTIONS.maxTransactions,
      maxBytes: 32 * 1024 * 1024,
      maxPerSender: 64,
    });
    assertNetworkSafety(options.net);
    // Defence in depth for the one value that must never be substituted: a
    // network with a committed mining gate issuer set must be started with exactly
    // that set. `genesisDocumentFor` already resolves it, so this catches
    // a caller that assembles a GenesisDocument by hand.
    const committedGate = committedMiningGateKeys(options.net);
    if (committedGate.length > 0) {
      const supplied = normalizeMiningGatePublicKeys(options.genesisDocument.miningGatePublicKeys ?? []);
      if (supplied.join(',') !== normalizeMiningGatePublicKeys(committedGate).join(',')) {
        throw new Error(
          `${options.net.name} commits a fixed mining gate issuer set; refusing to start with ` +
            `${supplied.length === 0 ? 'an empty' : 'a different'} set.`,
        );
      }
    }
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
      this.state = createGenesisState(
        genesisBlock,
        this.options.net,
        this.options.genesisDocument.miningGatePublicKeys ?? [],
      );
      this.initializeSafety(genesisIdentifier);
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
    if (meta.protocolVersion !== PROTOCOL_VERSION || meta.paramsHash !== PARAMS_HASH) {
      throw new Error(
        `protocol metadata mismatch: data uses ${meta.protocolVersion}/${meta.paramsHash}, ` +
          `node requires ${PROTOCOL_VERSION}/${PARAMS_HASH}`,
      );
    }
    if (this.store.genesis?.hash !== genesisHash) {
      throw new Error('canonical chain does not start with the expected genesis block');
    }
    await this.reload();
    this.recoverSafety(genesisIdentifier);
    this.emit('ready', { genesisHash, genesisId: genesisIdentifier });
  }

  /**
   * Rebuild the head state: start from the nearest snapshot that belongs to THIS
   * chain (its block hash is on the canonical branch) and replay forward.
   */
  private async reload(): Promise<void> {
    const head = this.store.head;
    if (!head) {
      const genesisBlock = buildGenesisBlock(this.options.genesisDocument, this.options.net);
      this.store.putBlock(genesisBlock);
      this.store.setCanonical([this.store.getIndexEntry(blockHash(genesisBlock.header))!]);
      this.state = createGenesisState(
        genesisBlock,
        this.options.net,
        this.options.genesisDocument.miningGatePublicKeys ?? [],
      );
      this.initializeSafety(this.genesisId);
      this.persistCheckpoint(true);
      return;
    }
    this.state = this.stateOf(head);
  }

  // ── Safety record and finality ────────────────────────────────────────────

  private safetyIdentity(genesisIdentifier: string): SafetyIdentity {
    return {
      networkId: this.options.net.networkId,
      chainId: this.options.net.chainId,
      genesisId: genesisIdentifier,
      protocolVersion: PROTOCOL_VERSION,
      paramsHash: PARAMS_HASH,
    };
  }

  private initializeSafety(genesisIdentifier: string): void {
    this.safety = {
      version: 1,
      ...this.safetyIdentity(genesisIdentifier),
      finalizedHeight: 0,
      finalizedHash: '',
      lastSigned: null,
    };
    this.safetyStore.save(this.safety);
  }

  /**
   * Restart recovery. The head state carries the finalized checkpoint (it is consensus state), and the safety record
   * remembers the highest one this node ever saw. They must agree: a head whose finalized height is LOWER than the
   * remembered one means the data directory was rolled back or replaced, and a remembered checkpoint that is no
   * longer on the canonical chain means the chain was swapped under us. Either way the node stops instead of
   * quietly accepting history it had already treated as final.
   */
  private recoverSafety(genesisIdentifier: string): void {
    const identity = this.safetyIdentity(genesisIdentifier);
    const loaded = this.safetyStore.load();
    if (loaded) {
      for (const key of Object.keys(identity) as (keyof SafetyIdentity)[]) {
        if (loaded[key] !== identity[key]) {
          throw new Error(`safety record belongs to a different network or protocol (${key} differs); refusing to start`);
        }
      }
      this.safety = loaded;
    } else {
      this.safety = { version: 1, ...identity, finalizedHeight: 0, finalizedHash: '', lastSigned: null };
    }
    const fin = this.state.s.finality;
    if (fin.finalizedHeight < this.safety.finalizedHeight) {
      throw new Error(
        `finality regressed: this node recorded height ${this.safety.finalizedHeight} as final but its chain ` +
          `reports ${fin.finalizedHeight}; the data directory was rolled back or replaced. Refusing to start.`,
      );
    }
    if (
      this.safety.finalizedHeight > 0 &&
      this.store.getCanonicalHashAtHeight(this.safety.finalizedHeight) !== this.safety.finalizedHash
    ) {
      throw new Error(
        `the canonical chain no longer contains the block this node recorded as final (height ${this.safety.finalizedHeight}). Refusing to start.`,
      );
    }
    this.recordFinality();
  }

  /** Persist a newly advanced finalized checkpoint. Monotonic: it never moves backwards. */
  private recordFinality(): void {
    const fin = this.state.s.finality;
    if (fin.finalizedHeight <= this.safety.finalizedHeight) return;
    this.safety = { ...this.safety, finalizedHeight: fin.finalizedHeight, finalizedHash: fin.finalizedHash };
    try {
      this.safetyStore.save(this.safety);
    } catch (error) {
      // The chain state is authoritative and carries the checkpoint itself; losing this write only weakens the
      // restart cross-check, so it is reported and never turns a committed block into a rejection.
      this.noteRecoveryProblem(`safety record write failed: ${(error as Error).message}`);
    }
  }

  /** The finalized checkpoint of the canonical head: a value read from consensus state, never a local timer. */
  finalizedCheckpoint(): { height: number; hash: string } {
    const fin = this.state.s.finality;
    if (fin.finalizedHeight === 0) return { height: 0, hash: this.store.getMeta()?.genesisHash ?? '' };
    return { height: fin.finalizedHeight, hash: fin.finalizedHash };
  }

  finalityStatus(): FinalityReport {
    const report = finalityReport(this.state);
    return { ...report, finalizedHash: this.finalizedCheckpoint().hash };
  }

  private rememberState(entry: { hash: string; height: number }, state: WorldState): void {
    this.stateCache.set(entry.hash, { height: entry.height, state });
    this.pruneStateCache();
  }

  /** Keep a window behind the head, and only a few competing states per height. */
  private pruneStateCache(): void {
    const depth = this.options.stateHistoryDepth ?? ChainManager.STATE_CACHE_DEPTH;
    const floor = (this.store.head?.height ?? 0) - depth;
    const sideStates = new Map<number, string[]>();
    for (const [hash, cached] of this.stateCache) {
      if (cached.height < floor) {
        this.stateCache.delete(hash);
        continue;
      }
      if (this.store.getCanonicalHashAtHeight(cached.height) === hash) continue;
      const atHeight = sideStates.get(cached.height) ?? [];
      atHeight.push(hash);
      sideStates.set(cached.height, atHeight);
    }
    for (const hashes of sideStates.values()) {
      // A Map iterates in insertion order, so the front of the list is the oldest.
      while (hashes.length > ChainManager.MAX_SIDE_STATES_PER_HEIGHT) this.stateCache.delete(hashes.shift()!);
    }
  }

  private persistCheckpoint(force = false): void {
    const head = this.store.head;
    if (!head) return;
    if (!force && head.height % CHECKPOINT_INTERVAL_BLOCKS !== 0) return;
    this.store.saveState(this.snapshotFor(head.hash));
    if (head.height > CHECKPOINT_INTERVAL_BLOCKS * 3) this.store.pruneCheckpoints(3);
  }

  private snapshotFor(blockHashValue: string): StateSnapshot {
    return this.state.toSnapshot(blockHashValue, {
      networkId: this.options.net.networkId,
      genesisId: this.genesisId,
      paramsHash: PARAMS_HASH,
      stateRoot: computeStateRoot(this.state.s),
    });
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
    const finalityStatus = this.finalityStatus();
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
      nodes: this.state.registeredNodes().filter((node) => node.bannedAtHeight === undefined).length,
      scheduleTier: producerSetFor(this.state, (head?.height ?? 0) + 1, this.protocolTime).tier,
      lastBlockTimestamp: head?.timestamp ?? 0,
      finalizedHeight: finalityStatus.finalizedHeight,
      finalizedHash: finalityStatus.finalizedHash,
      finalityLag: finalityStatus.lag,
      finalityAvailable: finalityStatus.available,
      finalityEligibleProducers: finalityStatus.eligibleProducers,
      finalityQuorum: finalityStatus.quorum,
    };
  }

  /**
   * Two different signed blocks by one producer on one parent are an equivocation. Seeing the second one raises an
   * event carrying both signed headers; the node agent turns it into a REPORT_EQUIVOCATION transaction. The chain
   * itself never signs anything: it has no key.
   */
  private detectEquivocation(block: Block): void {
    const hash = blockHash(block.header);
    for (const sibling of this.store.entriesAtHeight(block.header.height)) {
      if (sibling.hash === hash || sibling.producer !== block.header.producer) continue;
      const other = this.store.getBlockByHash(sibling.hash);
      if (!other || other.header.prevHash !== block.header.prevHash) continue;
      this.emit('equivocation', {
        producer: block.header.producer,
        height: block.header.height,
        firstId: sibling.hash,
        secondId: hash,
        firstHeader: toHex(encodeSignedHeader(other.header)),
        secondHeader: toHex(encodeSignedHeader(block.header)),
      });
      return;
    }
  }

  private forkChoiceInput(entry: IndexEntry) {
    return { height: entry.height, cumulativePotWeight: BigInt(entry.cumulativePotWeight), hash: entry.hash };
  }

  // ── Block ingestion ───────────────────────────────────────────────────────

  /**
   * Validate and (if it belongs) connect a block. Blocks whose parent is
   * unknown are queued as orphans and retried when the parent arrives.
   */
  addBlock(block: Block): AddBlockResult {
    const hash = blockHash(block.header);
    const known = this.store.getIndexEntry(hash);
    if (known) {
      const canonical = this.store.getCanonicalHashAtHeight(known.height) === hash;
      const tip = this.store.head;
      // A stored side-chain block was validated when it first arrived; sending
      // it again costs a peer nothing and would cost us a full re-validation
      // every time. The one exception is a block that is now heavier than the
      // tip (a crash can leave a valid block stored but never connected).
      const heavierThanTip =
        tip !== undefined &&
        compareTips(this.forkChoiceInput(known), this.forkChoiceInput(tip)) > 0;
      if (canonical || !heavierThanTip) {
        return {
          accepted: false,
          code: ErrCode.DUPLICATE_BLOCK,
          message: canonical ? 'block is already part of the canonical chain' : 'block is already known (side branch)',
          hash,
          height: block.header.height,
        };
      }
    }

    const parentEntry = this.store.getIndexEntry(block.header.prevHash);
    if (!parentEntry) {
      return this.queueOrphan(hash, block);
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
      if (orphan.block.header.prevHash === hash) {
        this.dropOrphan(orphanHash);
        // connectBlock raises the `block` event itself when the child joins the
        // chain; raising it again here indexed the same block twice.
        this.addBlock(orphan.block);
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

  /**
   * Hold a block whose parent has not arrived. Only blocks that could plausibly
   * connect soon are kept, and the pool is capped by count and bytes with the
   * oldest evicted first.
   */
  private queueOrphan(hash: string, block: Block): AddBlockResult {
    const result: AddBlockResult = {
      accepted: false,
      code: ErrCode.ORPHAN_BLOCK,
      message: 'parent block is unknown; queued as an orphan',
      hash,
      height: block.header.height,
    };
    const head = this.store.head;
    const plausible =
      block.header.chainId === this.options.net.chainId &&
      block.header.height > 0 &&
      (!head || block.header.height <= head.height + ChainManager.MAX_ORPHAN_LOOKAHEAD);
    if (!plausible || this.orphanPool.has(hash)) return { ...result, message: 'parent block is unknown; not queued' };
    const bytes = encodeBlock(block).length;
    this.orphanPool.set(hash, { block, bytes });
    this.orphanBytes += bytes;
    while (
      this.orphanPool.size > ChainManager.MAX_ORPHAN_BLOCKS ||
      this.orphanBytes > ChainManager.MAX_ORPHAN_BYTES
    ) {
      const oldest = this.orphanPool.keys().next().value;
      if (oldest === undefined) break;
      this.dropOrphan(oldest);
    }
    return result;
  }

  private dropOrphan(hash: string): void {
    const held = this.orphanPool.get(hash);
    if (!held) return;
    this.orphanPool.delete(hash);
    this.orphanBytes -= held.bytes;
  }

  /** How many blocks are waiting for a missing parent (diagnostics and tests). */
  get orphanCount(): number {
    return this.orphanPool.size;
  }

  /** Structural + state validation, then fork choice and possible reorg. */
  private connectBlock(block: Block, parentEntry: IndexEntry): { state: WorldState; reorged: boolean; connected: boolean } {
    const header = block.header;
    assertBlockSize(block);
    const hash = blockHash(header);
    // Finality is a value in the HEAD state. A block is only worth validating if it extends the finalized prefix:
    // anything that forks below it can never win fork choice here, so it is refused before any state work.
    const finalized = this.finalizedCheckpoint();
    if (header.height <= finalized.height) {
      if (this.store.getCanonicalHashAtHeight(header.height) !== hash) {
        reject(ErrCode.FINALITY_CONFLICT, `block at height ${header.height} conflicts with finalized history`);
      }
    } else if (this.store.ancestorHashAt(parentEntry, finalized.height) !== finalized.hash) {
      reject(ErrCode.FINALITY_CONFLICT, 'block parent branch omits the finalized checkpoint');
    }
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
      reject(ErrCode.BAD_DIFFICULTY, 'cumulative PoT weight does not match the parent plus one valid block');
    }
    // A block that forks more than maxReorgDepth behind the head can never join
    // this chain, and checking it would mean rebuilding the state that far
    // back. Refuse it here, before any of that work: otherwise one cheap message
    // naming an old parent could make a node replay its chain from a snapshot.
    const currentHead = this.store.head;
    if (currentHead && currentHead.height - parentEntry.height > CONSENSUS_PARAMS.consensus.maxReorgDepth ) {
      reject(
        ErrCode.STALE_BLOCK,
        `block forks at height ${parentEntry.height}, more than ${CONSENSUS_PARAMS.consensus.maxReorgDepth} blocks behind the head (${currentHead.height})`,
      );
    }
    if (this.store.entriesAtHeight(header.height).length >= CONSENSUS_PARAMS.consensus.maxCandidatesPerHeight) {
      reject(ErrCode.RATE_LIMITED, `candidate limit reached at height ${header.height}`);
    }
    assertBlockSignature(block, this.options.net.addressHrp);

    const ancestorTimestamps = this.store.ancestorTimestamps(header.prevHash, CONSENSUS_PARAMS.block.medianTimePastWindow);
    const timestampCheck = checkBlockTimestamp(header.timestamp, ancestorTimestamps, Math.floor(Date.now() / 1000));
    if (!timestampCheck.ok) {
      reject(ErrCode.BAD_TIMESTAMP, timestampCheck.reason ?? 'invalid block timestamp');
    }

    // Apply on top of the PARENT state, not the current head: this is what makes
    // fork branches validatable without trusting this node's own view.
    const parentState = this.stateOf(parentEntry);
    // The round comes from the two timestamps the headers already commit to, so a block produced after the scheduled
    // producer let its slot lapse is accepted from whoever the schedule hands the turn to next.
    const round = proposerRound(parentEntry.timestamp, header.timestamp);
    if (this.options.enforceProposerRotation !== false) {
      // One decision function (consensus/schedule.ts), read against the PARENT state at the BLOCK's own protocol
      // time, so a validating node and a producing node answer the same question the same way.
      try {
        assertProducerAllowed(parentState, block, parentEntry.timestamp);
      } catch (error) {
        reject(ErrCode.NOT_PRODUCER_TURN, (error as Error).message);
      }
    }

    const applied = applyBlock(parentState, block, { net: this.options.net });

    this.store.putBlock(block);
    const entry = this.store.getIndexEntry(hash)!;
    this.rememberState(entry, applied.state);
    this.rememberEvents(entry.hash, applied.events);
    this.detectEquivocation(block);
    void round;

    const tipEntry = this.store.head;
    if (!tipEntry || tipEntry.hash === entry.hash) {
      // Already the tip (idempotent put) — nothing to reconnect.
      return { state: this.state, reorged: false, connected: false };
    }
    const currentTip = this.forkChoiceInput(tipEntry);
    const candidate = this.forkChoiceInput(entry);
    if (compareTips(candidate, currentTip) <= 0) {
      // Valid but not the heaviest chain: keep it as a stored side branch.
      this.emit('sidechain', { hash: entry.hash, height: entry.height });
      return { state: this.state, reorged: false, connected: false };
    }

    const reorged = parentEntry.hash !== currentTip.hash;
    if (reorged) {
      const change = this.reorganise(entry.hash);
      this.emit('reorg', {
        to: entry.hash,
        height: entry.height,
        from: currentTip.hash,
        fromHeight: currentTip.height,
        forkHeight: change.forkHeight,
        abandoned: change.abandoned,
        adopted: change.adopted,
      });
    } else {
      this.store.appendCanonical(entry);
      this.state = applied.state;
      this.recordFinality();
      try {
        this.persistCheckpoint();
      } catch (error) {
        // The canonical log is already durable and authoritative. A failed
        // acceleration checkpoint must never turn a committed block into an API
        // rejection; startup can replay from an older valid checkpoint.
        const problem = `checkpoint write failed at height ${entry.height}: ${(error as Error).message}`;
        this.noteRecoveryProblem(problem);
        this.emit('checkpoint-error', { height: entry.height, error: (error as Error).message });
      }
      // Everything this block mined is settled, so it must leave the pool.
      // Only the producer used to drop its own transactions, which meant a
      // follower kept every transaction it had ever heard about until the
      // transaction expired: re-gossiped to its peers, re-offered to the block
      // builder and re-rejected, for the whole expiry window. `removeMany` was
      // written for exactly this and was never called.
      this.mempool.removeMany(block.transactions.map((tx) => tx.id));
      this.revalidateMempool();
    }
    this.pruneStateCache();
    this.emit('block', block, applied.events);
    return { state: this.state, reorged, connected: true };
  }

  /** Hash of the canonical block at `height` (the index repairs itself against this). */
  canonicalHashAt(height: number): string | undefined {
    return this.store.getCanonicalHashAtHeight(height);
  }

  /**
   * Canonical blocks from `fromHeight` to the head, each with the events it
   * emitted. Events come from the cache when they are still there and are
   * otherwise re-derived by replaying the block, so the indexer is always fed
   * what the state machine actually produced — never a re-implementation of it.
   */
  *replayCanonical(fromHeight: number): Generator<{ block: Block; events: ProtocolEvent[] }> {
    const head = this.store.head;
    if (!head) return;
    let state: WorldState | undefined;
    for (let height = Math.max(0, fromHeight); height <= head.height; height += 1) {
      const entry = this.store.getCanonicalAtHeight(height);
      if (!entry) return;
      const block = this.store.getBlockByHash(entry.hash);
      if (!block) throw new Error(`canonical block at height ${height} is missing from storage`);
      if (height === 0) {
        yield { block, events: [] };
        continue;
      }
      const cached = this.eventsByHash.get(entry.hash);
      if (cached) {
        state = undefined;
        yield { block, events: cached };
        continue;
      }
      if (!state) state = this.stateOf(this.store.getCanonicalAtHeight(height - 1)!);
      const applied = applyBlock(state, block, { net: this.options.net });
      state = applied.state;
      yield { block, events: applied.events };
    }
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

  /**
   * Deterministic reorganiser: adopt the branch ending at `newHeadHash`.
   *
   * Cost is the depth of the reorganisation, not the length of the chain: it
   * walks back to the fork point, reuses the state of every adopted block it
   * has already validated, and records the change as a marker plus the new tail
   * in the canonical log.
   */
  private reorganise(newHeadHash: string): { forkHeight: number; abandoned: number; adopted: number } {
    const branch = this.store.branchFromCanonical(newHeadHash);
    if (!branch) throw new Error('reorg failed: new head is not connected to the canonical chain');
    const { forkHeight, entries } = branch;
    const oldHead = this.store.head!;
    const abandoned = oldHead.height - forkHeight;
    // The reorg guard: a fork below the finalized checkpoint is refused outright, whatever its weight.
    const finalizedAt = this.finalizedCheckpoint().height;
    if (forkHeight < finalizedAt) {
      reject(ErrCode.FINALITY_CONFLICT, `reorg fork ${forkHeight} is below the finalized height ${finalizedAt}`);
    }
    if (abandoned > CONSENSUS_PARAMS.consensus.maxReorgDepth || entries.length > CONSENSUS_PARAMS.consensus.maxReorgDepth) {
      reject(
        ErrCode.STALE_BLOCK,
        `reorg depth ${Math.max(abandoned, entries.length)} exceeds the protocol maximum ${CONSENSUS_PARAMS.consensus.maxReorgDepth}`,
      );
    }
    // Everything the abandoned branch had mined, captured before the branch
    // stops being canonical. A reorg is not a reason for an honest, fully paid
    // transaction to disappear: it was only ever in a block that lost, and the
    // sender has no way to know that or to resend it. Without this the chain
    // silently drops those transactions on the floor — observed live, where a
    // depth-1 reorg erased a mining claim and the miner's balance with it.
    const orphaned: TxEnvelope[] = [];
    for (let height = forkHeight + 1; height <= oldHead.height; height += 1) {
      const hash = this.store.getCanonicalHashAtHeight(height);
      const block = hash ? this.store.getBlockByHash(hash) : null;
      if (!block) break;
      orphaned.push(...block.transactions);
    }

    const forkEntry = this.store.getCanonicalAtHeight(forkHeight)!;
    let state = this.stateOf(forkEntry);
    const adoptedTxIds = new Set<string>();
    for (const entry of entries) {
      const block = this.store.getBlockByHash(entry.hash);
      if (!block) throw new Error(`reorg failed: missing block at height ${entry.height}`);
      for (const tx of block.transactions) adoptedTxIds.add(tx.id);
      const cached = this.stateCache.get(entry.hash);
      if (cached && this.eventsByHash.has(entry.hash)) {
        // Validated when it first arrived; no need to run it a second time.
        state = cached.state;
        continue;
      }
      const applied = applyBlock(state, block, { net: this.options.net });
      state = applied.state;
      this.rememberState(entry, state);
      this.rememberEvents(entry.hash, applied.events);
    }
    this.store.reorganiseCanonical(forkHeight, entries);
    this.state = state;
    this.recordFinality();

    // Return the orphaned transactions the winning branch did not already
    // re-include. `revalidateMempool` immediately below drops any that the new
    // branch made stale (nonce already consumed), so what survives is exactly
    // the set that is still valid and still unmined.
    let requeued = 0;
    for (const tx of orphaned) {
      if (adoptedTxIds.has(tx.id)) continue;
      if (this.mempool.add(tx).accepted) requeued += 1;
    }
    if (requeued > 0) this.emit('mempool-requeued', { count: requeued, fromHeight: forkHeight + 1 });
    this.mempool.removeMany([...adoptedTxIds]);

    try {
      this.persistCheckpoint();
    } catch (error) {
      const problem = `checkpoint write failed after reorg to height ${this.height}: ${(error as Error).message}`;
      this.noteRecoveryProblem(problem);
      this.emit('checkpoint-error', { height: this.height, error: (error as Error).message });
    }
    this.revalidateMempool();
    return { forkHeight, abandoned, adopted: entries.length };
  }

  /**
   * State after `height`/`hash`, from the cache, a snapshot or replay.
   * Kept for callers outside this class (tests, tooling); inside, `stateOf`.
   */
  stateAtHeight(height: number, hash: string, forceReplay = false): WorldState {
    const entry = this.store.getIndexEntry(hash);
    if (!entry || entry.height !== height) {
      throw new Error(`block ${hash} is not known at height ${height}`);
    }
    return this.stateOf(entry, forceReplay);
  }

  private noteRecoveryProblem(problem: string): void {
    if (!this.recoveryProblems.includes(problem)) this.recoveryProblems.push(problem);
  }

  /**
   * The state a block leaves behind.
   *
   * Looks for the nearest ancestor (the block itself included) whose state is
   * cached or has a snapshot saved FOR THAT EXACT BLOCK, then replays forward
   * along the block's own branch. Both conditions are checked by block hash: a
   * snapshot from the other side of a fork, or a cached state for a sibling,
   * is never mistaken for this branch's state.
   */
  private stateOf(entry: IndexEntry, forceReplay = false): WorldState {
    if (!forceReplay) {
      const cached = this.stateCache.get(entry.hash);
      if (cached) return cached.state;
    }
    const snapshots = new Map(this.store.checkpoints().map((checkpoint) => [checkpoint.blockHash, checkpoint]));
    const path: IndexEntry[] = [];
    let base: WorldState | undefined;
    let cursor: IndexEntry | undefined = entry;
    while (cursor) {
      if (!(forceReplay && cursor === entry)) {
        const cached = this.stateCache.get(cursor.hash);
        if (cached) {
          base = cached.state;
          break;
        }
        const snapshot = snapshots.get(cursor.hash);
        if (snapshot && snapshot.height === cursor.height) {
          const loaded = this.store.loadStateAt(snapshot.height);
          if (!loaded) {
            this.noteRecoveryProblem(`checkpoint ${snapshot.height} failed parsing or checksum verification`);
          } else if (
            loaded.blockHash !== cursor.hash ||
            loaded.height !== cursor.height ||
            loaded.snapshotVersion !== STATE_SNAPSHOT_VERSION ||
            loaded.chainId !== this.options.net.chainId ||
            loaded.protocolVersion !== PROTOCOL_VERSION ||
            loaded.networkId !== this.options.net.networkId ||
            loaded.genesisId !== this.genesisId ||
            loaded.paramsHash !== PARAMS_HASH ||
            typeof loaded.stateRoot !== 'string'
          ) {
            this.noteRecoveryProblem(`checkpoint ${snapshot.height} has incompatible chain identity`);
          } else {
            const candidate = WorldState.fromSnapshot(loaded);
            const candidateRoot = computeStateRoot(candidate.s);
            const checkpointBlock = this.store.getBlockByHash(cursor.hash);
            if (
              !checkpointBlock ||
              candidateRoot !== checkpointBlock.header.stateRoot ||
              (loaded.stateRoot !== undefined && loaded.stateRoot !== candidateRoot) ||
              !candidate.verifySupplyInvariant().ok
            ) {
              this.noteRecoveryProblem(`checkpoint ${snapshot.height} does not reproduce its block state root`);
            } else {
              base = candidate;
              break;
            }
          }
        }
      }
      if (cursor.height === 0) {
        const genesisBlock = this.store.getBlockByHash(cursor.hash);
        if (!genesisBlock) throw new Error('genesis block missing from storage: the data directory is corrupt');
        base = createGenesisState(
        genesisBlock,
        this.options.net,
        this.options.genesisDocument.miningGatePublicKeys ?? [],
      );
        break;
      }
      path.push(cursor);
      const parent: IndexEntry | undefined = this.store.getIndexEntry(cursor.prevHash);
      if (!parent) throw new Error(`cannot resolve the ancestry of ${entry.hash}: parent ${cursor.prevHash} is not stored`);
      cursor = parent;
    }
    if (!base) throw new Error(`cannot rebuild the state of ${entry.hash}`);
    let state = base;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const step = path[index]!;
      const block = this.store.getBlockByHash(step.hash);
      if (!block) throw new Error(`missing block ${step.hash} at height ${step.height}`);
      state = applyBlock(state, block, { net: this.options.net }).state;
      this.rememberState(step, state);
    }
    return state;
  }

  /** Drop mempool transactions that no longer validate after a reorg. */
  private revalidateMempool(): void {
    for (const entry of this.mempool.snapshot()) {
      const poolEntry = this.mempool.get(entry.txId);
      if (!poolEntry) continue;
      const expectedNonce = this.state.getAccount(poolEntry.tx.sender)?.nonce ?? 0;
      if (poolEntry.tx.nonce < expectedNonce) this.mempool.remove(entry.txId);
    }
  }

  // ── Block production ──────────────────────────────────────────────────────

  /**
   * Who is entitled to produce the next block at this node's current protocol time, or null in OPEN mode (no node is
   * registered yet). Shares its round arithmetic with `buildNextBlock`, so the production loop and the builder can
   * never disagree about whose turn it is.
   */
  scheduledProducerNow(): string | null {
    const head = this.store.head;
    if (!head) return null;
    const timestamp = this.protocolTime;
    return scheduledProducer(this.state, head.height + 1, proposerRound(head.timestamp, timestamp), timestamp);
  }

  /**
   * Which production state this chain is in for the height this node would build next: OPEN (no registered node, any
   * key may produce) or SCHEDULED (exactly one address may, per round). The same `producerDecision` that block
   * validation calls, evaluated on the same head, height, round and protocol time that `buildNextBlock` uses. There is
   * no HALTED state: when every node is unavailable the schedule falls back to the registered set rather than stopping.
   */
  productionDecisionNow(): ProducerDecision {
    const head = this.store.head;
    if (!head) return { kind: 'OPEN' };
    const timestamp = this.protocolTime;
    return producerDecision(this.state, head.height + 1, proposerRound(head.timestamp, timestamp), timestamp);
  }

  /**
   * Build the next block for this slot. Returns null when this node is not the
   * scheduled producer — nodes never race to produce.
   */
  buildNextBlock(producer: { address: string; privateKey: string; publicKey: string }): Block | null {
    const head = this.store.head;
    if (!head) return null;

    const height = head.height + 1;
    const timestamp = this.protocolTime;
    // Same round the verifiers will recompute from the finished header.
    const round = proposerRound(head.timestamp, timestamp);
    if (!isProducerAllowed(this.state, producer.address, height, round, timestamp)) return null;

    // ── The double-sign lock ────────────────────────────────────────────────
    // A producer signs at most ONE block on a given parent. Two different signed headers on one parent are exactly
    // what the equivocation ban is for, so a parent this node has already signed on is never signed on again: not
    // after a locally rejected block, not after a restart. The lock is armed and PERSISTED before the header is built,
    // because the signature is the irreversible act — a crash between the two leaves the slot closed, which costs one
    // turn instead of the node's standing. A different parent is a different slot and stays available.
    const signed = this.safety.lastSigned;
    if (signed && signed.height === height && signed.parentHash === head.hash) {
      this.emit('proposal-lock', { height, parentHash: head.hash });
      return null;
    }
    this.safety = { ...this.safety, lastSigned: { height, parentHash: head.hash } };
    this.safetyStore.save(this.safety);

    const ctx: BlockContext = {
      height,
      timestamp,
      chainId: this.options.net.chainId,
      producer: producer.address,
      parentHash: head.hash,
    };
    // Derived from the PARENT state before the working copy advances, exactly as
    // every validating node derives it from the finished block.
    const missedProducers = missedProducersFor(this.state, height, head.timestamp, timestamp, producer.address);

    const candidates = this.mempool.selectForBlock(
      CONSENSUS_PARAMS.block.maxBlockTransactions,
      // Looked up per candidate: copying every account's nonce into a map made each block cost as much as the state is big.
      (sender) => this.state.getAccount(sender)?.nonce ?? 0,
    );

    // Simulate candidate by candidate. A transaction that fails at this height
    // is dropped from the block rather than poisoning it; each attempt runs on a
    // clone so a failure leaves the working state untouched.
    const assemble = (checkEachTransaction: boolean): { accepted: TxEnvelope[]; finalized: ReturnType<typeof finalizeBlock> } => {
      let working = this.state.clone();
      working.advanceBlock(height, timestamp);
      const events: ProtocolEvent[] = [];
      const accepted: TxEnvelope[] = [];
      // One tally for the whole block: the per-block limits (node registrations, equivocation reports, claims per
      // wallet) are rules about the block, and a validator applies the block in one pass with one tally.
      let tally = newBlockTally();
      for (const tx of candidates) {
        const trial = working.clone();
        trial.advanceBlock(height, timestamp);
        try {
          const trialTally = cloneBlockTally(tally);
          const outcome = applyTransactions(trial, [tx], ctx, this.options.net, trialTally);
          if (checkEachTransaction) {
            // Slow path: find the transaction that breaks the supply invariant
            // and evict it, so it cannot stall assembly on every later attempt.
            const invariant = outcome.state.verifySupplyInvariant();
            if (!invariant.ok) {
              this.mempool.remove(tx.id);
              this.emit('rejected-transaction', { txId: tx.id, reason: invariant.reason });
              continue; // `working` is untouched: only the discarded trial saw this tx
            }
          }
          tally = trialTally;
          working = outcome.state;
          events.push(...outcome.events);
          accepted.push(tx);
        } catch (error) {
          // A transaction that is invalid against the current state must not be
          // retried forever. In particular, a peer could otherwise advertise a
          // large gas value without the balance/body to support it, win mempool
          // eviction priority, and make every producer re-execute it each slot.
          //
          // The exception is a transaction that is fine and merely does not fit THIS block: the block's own
          // admission limit is already used up by transactions ahead of it. It stays pooled for a later block.
          const P = CONSENSUS_PARAMS.consensus.producers;
          const code = error instanceof ProtocolError ? error.code : undefined;
          const deferred =
            (code === ErrCode.NODE_REGISTRATION_LIMIT && tally.counters.registrations >= P.maxRegistrationsPerBlock) ||
            (code === ErrCode.EVIDENCE_LIMIT && tally.counters.equivocationReports >= P.maxEquivocationReportsPerBlock);
          if (deferred) continue;
          this.mempool.remove(tx.id);
          this.emit('rejected-transaction', { txId: tx.id, reason: (error as Error).message });
          continue;
        }
      }
      events.push(...runBlockRoutines(working, ctx, this.options.net, { missedProducers }));
      return { accepted, finalized: finalizeBlock(working, events) };
    };

    let built: { accepted: TxEnvelope[]; finalized: ReturnType<typeof finalizeBlock> };
    try {
      // The invariant is checked once, by finalizeBlock, however many
      // transactions the block carries.
      built = assemble(false);
    } catch (error) {
      this.emit('block-assembly-failed', { height, transactions: candidates.length, error });
      try {
        built = assemble(true);
      } catch {
        // Every transaction passed on its own, yet the assembled block does not
        // finalise. Producing nothing would stall this node for as long as the
        // mempool held the offending combination, so drop the batch and fall
        // back to an empty block: the chain keeps moving and the next slot is
        // clean. (If even an empty block cannot finalise, the chain state itself
        // is broken and the throw below is the right answer.)
        for (const tx of candidates) this.mempool.remove(tx.id);
        const working = this.state.clone();
        working.advanceBlock(height, timestamp);
        const events = runBlockRoutines(working, ctx, this.options.net, { missedProducers });
        built = { accepted: [], finalized: finalizeBlock(working, events) };
      }
    }

    // Defence in depth, before the irreversible act: replay the assembled list exactly as every validator will (one
    // pass, one tally, the same routines) and require the same roots. The double-sign lock is already armed, so a block
    // this node signs but its own validation then rejects would keep it, and with it every node that reached the same
    // conclusion, from ever producing on this parent. If the replay disagrees, sign an empty block instead: the chain
    // moves, the transactions stay pooled, and the disagreement is reported.
    if (built.accepted.length > 0) {
      try {
        const replay = this.state.clone();
        replay.advanceBlock(height, timestamp);
        replay.clearDeltas();
        const applied = applyTransactions(replay, built.accepted, ctx, this.options.net);
        const replayEvents = [...applied.events, ...runBlockRoutines(replay, ctx, this.options.net, { missedProducers })];
        const replayed = finalizeBlock(replay, replayEvents);
        if (replayed.stateRoot !== built.finalized.stateRoot || replayed.eventsRoot !== built.finalized.eventsRoot) {
          throw new Error('the replay of the assembled block produced different roots');
        }
      } catch (error) {
        this.emit('block-assembly-failed', { height, transactions: built.accepted.length, error });
        const working = this.state.clone();
        working.advanceBlock(height, timestamp);
        const events = runBlockRoutines(working, ctx, this.options.net, { missedProducers });
        built = { accepted: [], finalized: finalizeBlock(working, events) };
      }
    }

    return buildBlock({
      protocolVersion: PROTOCOL_VERSION,
      chainId: this.options.net.chainId,
      height,
      prevHash: head.hash,
      stateRoot: built.finalized.stateRoot,
      eventsRoot: built.finalized.eventsRoot,
      timestamp,
      producer: producer.address,
      producerPrivateKey: producer.privateKey,
      producerPublicKey: producer.publicKey,
      parentCumulativePotWeight: BigInt(head.cumulativePotWeight),
      transactions: built.accepted,
    });
  }

  // ── Transaction admission ─────────────────────────────────────────────────

  /**
   * Cheap admission check for a transaction a PEER sent us: protocol version,
   * chain id, expiry, size, nonce, signature and a current-state balance check
   * for advertised gas priority. It does not clone/execute the state. A peer's
   * gossip must not be able to fill the pool with garbage: the pool ranks by
   * declared gas, and gas is only a number a sender writes down, so an unfunded
   * claim must never crowd honest transactions out for free.
   *
   * Full type-specific state simulation stays on the RPC submit path, where the
   * caller is a wallet, not an unauthenticated peer.
   */
  /**
   * Is this transaction worth a place in the pool at all? Each node decides for itself, from its own state and with no
   * coordinator (so it is a local policy, not a consensus rule: execution still decides what a block may contain).
   *
   * The pool is shared by everybody and anybody may fill it with keys made for free, so a transaction that can never
   * apply must not take a place. Only three kinds may legitimately come from an account that does not exist yet:
   * a mining claim (a first claim creates the account), a node statement (a node key holds no funds) and a gate
   * authority update (signed by gate keys, not by its sender). Everything else needs an account, because it spends or
   * owns something. A claim must carry a certificate the chain's gate keys really issued, and a node statement must be
   * about a node that exists. Failures that depend only on how far this node has synced are reported with a code that
   * is not held against the peer that relayed them.
   */
  private assertPoolAdmissible(tx: TxEnvelope): void {
    const state = this.state;
    const behind = (error: unknown): never => {
      if (error instanceof ProtocolError) reject(ErrCode.NOT_YET_VALID, `${error.code}: ${error.message}`);
      throw error;
    };
    switch (tx.type) {
      case TxType.GATE_AUTHORITY:
        return;
      case TxType.MINING_CLAIM: {
        const decoded = decodeMiningBody(tx.body);
        assertMiningGate(
          state.s.genesis.gateKeysActive,
          decoded.gate,
          {
            networkId: this.options.net.networkId,
            chainId: this.options.net.chainId,
            address: tx.sender,
            claimId: decoded.claimId,
          },
          this.protocolTime,
        );
        try {
          assertMiningEligibility(
            state.getAccount(tx.sender),
            this.protocolTime,
            state.s.metrics.activeMiners,
            state.s.genesis.allocationClaimed,
          );
        } catch (error) {
          behind(error);
        }
        return;
      }
      case TxType.NODE_REGISTRY:
        try {
          assertNodeStatementAdmissible(state, tx, this.options.net.addressHrp);
        } catch (error) {
          if (
            error instanceof ProtocolError &&
            [ErrCode.NODE_NOT_REGISTERED, ErrCode.NODE_ALREADY_REGISTERED, ErrCode.NODE_WALLET_IN_USE, ErrCode.NODE_BANNED].includes(error.code)
          ) {
            behind(error);
          }
          throw error;
        }
        return;
      default:
        if (!state.getAccount(tx.sender)) {
          reject(ErrCode.NOT_YET_VALID, 'the sender has no account on this chain (yet)');
        }
    }
  }

  checkGossipedTransaction(tx: TxEnvelope): { ok: true } | { ok: false; code: ErrCode; message: string } {
    try {
      const account = this.state.getAccount(tx.sender);
      validateTxStructure(tx, {
        chainId: this.options.net.chainId,
        supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        protocolTime: this.protocolTime,
        expectedNonce: account?.nonce ?? 0,
        height: this.height + 1,
        addressHrp: this.options.net.addressHrp,
      });
      // A gate authority update is relayed only if it is valid against the state this node has: it carries no gas,
      // so a stale or unauthorised one costs the network pool space and signature checks for nothing. A node a block
      // behind may refuse a genuinely new update for a moment; the submitter's own node, and the next gossip, retry.
      if (tx.type === TxType.GATE_AUTHORITY) {
        const g = this.state.s.genesis;
        verifyGateUpdate(
          { active: g.gateKeysActive, revoked: g.gateKeysRevoked, epoch: g.gateEpoch },
          decodeGateAuthorityBody(tx.body),
          { networkId: this.options.net.networkId, chainId: this.options.net.chainId },
        );
      }
      // Gas is the mempool's eviction priority. Refuse a peer's priority claim
      // unless the current state proves the sender can fund at least that much;
      // full type-specific validity is still decided at block execution.
      if ((account?.balance ?? 0n) < tx.gas) {
        reject(ErrCode.INSUFFICIENT_FUNDS, 'sender cannot fund the gas used for mempool priority');
      }
      this.assertPoolAdmissible(tx);
      return { ok: true };
    } catch (error) {
      if (error instanceof ProtocolError) return { ok: false, code: error.code, message: error.message };
      throw error;
    }
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
    return this.snapshotFor(this.store.head?.hash ?? '');
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
    const problems: string[] = [...this.recoveryProblems];
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
    const finalized = this.finalizedCheckpoint();
    if (this.store.getCanonicalHashAtHeight(finalized.height) !== finalized.hash) {
      problems.push('the finalized checkpoint is not on the canonical chain');
    }
    if (this.safety.finalizedHeight > finalized.height) {
      problems.push('the head state reports a lower finalized height than this node recorded');
    }
    return { ok: problems.length === 0, problems };
  }

  /** Core version advertised to peers and the interface. */
  get version(): string {
    return CORE_VERSION;
  }
}
