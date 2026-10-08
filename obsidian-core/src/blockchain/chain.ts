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
  BlockHeader,
  BlockSummary,
  ConsensusEvidenceContext,
  EquivocationEvidence,
  FinalityCertificate,
  FinalityVote,
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
  decodeSignedHeader,
  encodeBlock,
  encodeSignedHeader,
  transactionRootOf,
  verifyBlockSignature,
} from './block.js';
import { BlockStore, CHECKPOINT_INTERVAL_BLOCKS, type IndexEntry } from '../storage/blockstore.js';
import { DEFAULT_MEMPOOL_OPTIONS, Mempool } from './mempool.js';
import {
  checkBlockTimestamp,
  compareTips,
  isProposerAllowed,
  proposerDecision,
  medianTimePast,
  missedProposersFor,
  proposerRound,
  scheduledProposer,
} from '../consensus/proposer.js';
import { encodeSignedTx, validateTxStructure } from '../transactions/encode.js';
import { decodeSlashBody } from '../transactions/executors/slash.js';
import { buildGenesisBlock, createGenesisState, genesisId, normalizeBootstrapValidatorPublicKeys } from '../genesis/initialize.js';
import { committedBootstrapValidatorKeys } from '../genesis/bootstrap-keys.js';
import { assertNetworkSafety } from '../protocol/networks.js';
import { CORE_VERSION, PROTOCOL_VERSION, STATE_SNAPSHOT_VERSION } from '../version.js';
import { FinalityStore, type FinalityIdentity, type PersistedFinalityState } from '../storage/finality-store.js';
import {
  bootstrapFinalityValidators, certificateShape, evidenceSerializedBytes, finalityQuorum, finalityValidators,
  finalityVoteId, makeProposerEvidence, makeVoteEvidence,
  signFinalityVote, validatorSetHash,
} from '../consensus/finality.js';
import {
  validateCanonicalFinalityVote,
  type FinalityVoteVerdict,
} from '../consensus/finality-vote.js';
import { fromHex, toHex } from '../crypto/hash.js';

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

/**
 * Producer policy: how much equivocation evidence ONE block attempt will verify.
 *
 * Node policy, never consensus. A producer that leaves a report out loses
 * nothing — the report stays in the pool for the next slot — while a producer
 * that verified every evidence-carrying transaction an attacker could pool would
 * do unbounded public-key work per slot. The consensus per-block budget
 * (CONSENSUS_PARAMS.consensus.slashing) is deliberately SMALLER than this, so
 * the policy throttle can never be the reason a block cannot carry its full
 * allowance: it is a ceiling on VERIFICATION, not on inclusion.
 */
const MAX_SLASH_VERIFICATIONS_PER_BLOCK = 32;
const MAX_SLASH_VERIFICATION_BYTES_PER_BLOCK = 1024 * 1024;

export interface GenesisDocument {
  networkId: string;
  chainId: number;
  protocolVersion: string;
  /** Protocol time of the genesis block. */
  timestamp: number;
  /** Foundation note stored in genesis state (no allocation implied). */
  note: string;
  /** Sorted compressed validator public keys committed by the genesis state. */
  bootstrapValidatorPublicKeys?: string[];
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
  finalizedHeight:number;
  finalizedHash:string;
  finalityLag:number;
  finalityValidatorCount:number;
  finalityQuorum:number;
  finalityBootstrapConfigured:boolean;
}

export interface FinalityStatus {
  finalizedHeight:number; finalizedHash:string; headHeight:number; confirmationsAfterFinality:number;
  validatorCount:number; quorum:number; pendingVotes:number; pendingUnknownVotes:number; evidence:number; bootstrap:boolean; bootstrapConfigured:boolean;
}
export interface FinalityAdmissionResult { accepted:boolean; duplicate?:boolean; finalized?:boolean; code:ErrCode; message:string; evidence?:EquivocationEvidence }

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
  private readonly finalityStore:FinalityStore;
  private finality!:PersistedFinalityState;
  private readonly pendingFinalityVotes=new Map<string,FinalityVote>();
  private readonly pendingCertifiedTargets=new Map<string,FinalityCertificate>();

  constructor(options: ChainManagerOptions) {
    super();
    this.options = options;
    this.store = new BlockStore(options.dataDir);
    this.finalityStore = new FinalityStore(options.dataDir);
    this.mempool = new Mempool({
      ...DEFAULT_MEMPOOL_OPTIONS,
      maxTransactions: options.mempoolSize ?? DEFAULT_MEMPOOL_OPTIONS.maxTransactions,
      maxBytes: 32 * 1024 * 1024,
      maxPerSender: 64,
    });
    assertNetworkSafety(options.net);
    // Defence in depth for the one value that must never be substituted: a
    // network with a committed bootstrap committee must be started with exactly
    // that committee. `genesisDocumentFor` already resolves it, so this catches
    // a caller that assembles a GenesisDocument by hand.
    const committed = committedBootstrapValidatorKeys(options.net);
    if (committed.length > 0) {
      const supplied = normalizeBootstrapValidatorPublicKeys(options.genesisDocument.bootstrapValidatorPublicKeys ?? []);
      if (supplied.length === 0 || supplied.join(',') !== normalizeBootstrapValidatorPublicKeys(committed).join(',')) {
        throw new Error(
          `${options.net.name} commits a fixed finality bootstrap committee; refusing to start with ` +
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
      this.state = createGenesisState(genesisBlock, this.options.net, this.options.genesisDocument.bootstrapValidatorPublicKeys ?? []);
      this.initializeFinality(genesisHash,genesisIdentifier);
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
    this.recoverFinality(genesisHash,genesisIdentifier);
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
      this.state = createGenesisState(genesisBlock, this.options.net, this.options.genesisDocument.bootstrapValidatorPublicKeys ?? []);
      this.initializeFinality(blockHash(genesisBlock.header),this.genesisId);
      this.persistCheckpoint(true);
      return;
    }
    this.state = this.stateOf(head);
  }

  private finalityIdentity(genesisIdentifier:string):FinalityIdentity { return {networkId:this.options.net.networkId,chainId:this.options.net.chainId,genesisId:genesisIdentifier,protocolVersion:PROTOCOL_VERSION,paramsHash:PARAMS_HASH}; }
  private initializeFinality(genesisHash:string,genesisIdentifier:string):void { this.finality={version:1,...this.finalityIdentity(genesisIdentifier),finalizedHeight:0,finalizedHash:genesisHash,certificate:null,votes:[],evidence:[],lastProposal:null}; this.finalityStore.save(this.finality); }
  private recoverFinality(genesisHash:string,genesisIdentifier:string):void {
    const loaded=this.finalityStore.load();
    if (!loaded) {
      // A missing finality journal is harmless only for a chain that has never
      // advanced beyond genesis. Resetting a non-empty chain to the genesis
      // anchor would erase an irreversible local safety lock and let fork
      // choice rewrite history after an accidental deletion or partial restore.
      if ((this.store.head?.height ?? 0) > 0) {
        throw new Error('finality state is missing for a non-genesis chain; refusing to forget a safety lock');
      }
      this.initializeFinality(genesisHash, genesisIdentifier);
      return;
    }
    const identity=this.finalityIdentity(genesisIdentifier);
    for (const key of ['networkId','chainId','genesisId','protocolVersion','paramsHash'] as const) if (loaded[key]!==identity[key]) throw new Error(`finality state ${key} mismatch`);
    if (loaded.version!==1 || !Number.isSafeInteger(loaded.finalizedHeight) || loaded.finalizedHeight<0 || !/^[0-9a-f]{64}$/.test(loaded.finalizedHash) || !Array.isArray(loaded.votes) || loaded.votes.length>CONSENSUS_PARAMS.consensus.finality.maxValidators || !Array.isArray(loaded.evidence) || loaded.evidence.length>CONSENSUS_PARAMS.consensus.finality.maxEvidenceRecords || (loaded.lastProposal!=null && (!Number.isSafeInteger(loaded.lastProposal.height) || loaded.lastProposal.height<0 || !Number.isSafeInteger(loaded.lastProposal.round) || loaded.lastProposal.round<0))) throw new Error('finality state is structurally invalid');
    if (loaded.finalizedHeight===0) {
      if (loaded.finalizedHash!==genesisHash || loaded.certificate!==null) throw new Error('genesis finality lock does not match chain');
      this.finality=loaded; this.validateRecoveredVotes(); this.validateRecoveredEvidence(); return;
    }
    if (!loaded.certificate || loaded.certificate.height!==loaded.finalizedHeight || loaded.certificate.blockHash!==loaded.finalizedHash) throw new Error('finality state is missing checkpoint certificate');
    this.finality={version:1,...identity,finalizedHeight:0,finalizedHash:genesisHash,certificate:null,votes:[],evidence:loaded.evidence,lastProposal:loaded.lastProposal??null};
    const verdict=this.validateFinalityCertificate(loaded.certificate); if (!verdict.ok) throw new Error(`stored finality certificate invalid: ${verdict.message}`);
    this.finality=loaded;
    if (this.store.getCanonicalHashAtHeight(loaded.finalizedHeight)!==loaded.finalizedHash) this.reorganise(loaded.finalizedHash,true);
    this.validateRecoveredVotes(); this.validateRecoveredEvidence();
  }

  private validateRecoveredVotes():void {
    const seen=new Set<string>();
    for (const vote of this.finality.votes) { const v=this.validateFinalityVote(vote,{allowUnknown:false,skipAnchorCheck:false}); if (!v.ok || seen.has(vote.validator)) throw new Error(`persisted finality vote invalid: ${v.ok?'duplicate validator':v.message}`); seen.add(vote.validator); }
  }
  private validateRecoveredEvidence():void {
    const recovered=[...this.finality.evidence]; this.finality={...this.finality,evidence:[]};
    for (const evidence of recovered) { const v=this.addEquivocationEvidence(evidence,false); if (!v.accepted) throw new Error(`persisted evidence invalid: ${v.message}`); }
  }

  private validateStoredProposal(block:Block):{ok:true}|{ok:false;message:string} {
    try {
      assertBlockSize(block);
      if (block.header.protocolVersion!==PROTOCOL_VERSION || block.header.chainId!==this.options.net.chainId || block.header.paramsHash!==PARAMS_HASH) return {ok:false,message:'proposal identity incompatible'};
      const parent=this.store.getIndexEntry(block.header.prevHash); if (!parent || block.header.height!==parent.height+1) return {ok:false,message:'proposal parent missing'};
      if (block.header.cumulativePotWeight!==BigInt(parent.cumulativePotWeight)+1n || !verifyBlockSignature(block,this.options.net.addressHrp)) return {ok:false,message:'proposal weight or signature invalid'};
      if (!isProposerAllowed(this.stateOf(parent),block.header.producer,block.header.height,proposerRound(parent.timestamp,block.header.timestamp))) return {ok:false,message:'proposal signer not scheduled'};
      this.stateOf(this.store.getIndexEntry(blockHash(block.header))!,true); return {ok:true};
    } catch(e) { return {ok:false,message:(e as Error).message}; }
  }

  private bootstrapKeys(): readonly string[] {
    return this.options.genesisDocument.bootstrapValidatorPublicKeys ?? [];
  }

  private validatorsForAnchor(state: WorldState, finalizedHeight: number): ReturnType<typeof finalityValidators> {
    return finalizedHeight === 0
      ? bootstrapFinalityValidators(state, this.bootstrapKeys())
      : finalityValidators(state);
  }

  private bootstrapCommitteeAtParent(parent: IndexEntry): ReturnType<typeof finalityValidators> {
    const keys = this.bootstrapKeys();
    if (keys.length === 0 || parent.height < CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks) return [];
    const committee = bootstrapFinalityValidators(this.stateOf(parent), keys);
    if (committee.length !== keys.length) return [];
    const expectedHash = validatorSetHash(committee);
    let cursor: IndexEntry | undefined = parent;
    for (let i = 0; i < CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks; i += 1) {
      if (!cursor) return [];
      const atHeight = bootstrapFinalityValidators(this.stateOf(cursor), keys);
      if (atHeight.length !== keys.length || validatorSetHash(atHeight) !== expectedHash) return [];
      cursor = cursor.height === 0 ? undefined : this.store.getIndexEntry(cursor.prevHash);
    }
    return committee;
  }

  private isBootstrapTarget(block: Block, setHash: string, historical = false): boolean {
    if ((!historical && this.finality.finalizedHeight !== 0) || block.header.height <= 1) return false;
    const parent = this.store.getIndexEntry(block.header.prevHash);
    if (!parent) return false;
    const committee = this.bootstrapCommitteeAtParent(parent);
    return committee.length > 0 && validatorSetHash(committee) === setHash;
  }

  private validateCertificateEnvelope(c:FinalityCertificate):{ok:true}|{ok:false;message:string} {
    const shape=certificateShape(c); if(!shape.ok)return {ok:false,message:shape.reason};
    const seen=new Set<string>();
    for(const vote of c.votes){
      // Not a second, shorter list of rules: the certificate's votes go through
      // the SAME canonical predicate as an admitted vote, so a certificate can
      // never be built out of votes this node would refuse individually. The
      // local anchor is deliberately not required (the certificate may certify
      // an anchor this node has not reached) and the target block may be one
      // this node does not hold yet — that is the ordinary case when a certified
      // branch arrives from a peer, and the quorum of signatures over a known
      // committee is what makes it safe.
      const verdict=this.validateFinalityVote(vote,{allowUnknown:true,skipAnchorCheck:true});
      if(!verdict.ok&&!verdict.unknown)return {ok:false,message:`certificate vote invalid: ${verdict.message}`};
      if(vote.finalizedHeight!==c.finalizedHeight||vote.finalizedHash!==c.finalizedHash||vote.height!==c.height||vote.blockHash!==c.blockHash||vote.parentHash!==c.parentHash||vote.validatorSetHash!==c.validatorSetHash||seen.has(vote.validator))return {ok:false,message:'certificate contains duplicate or mismatched vote'};
      seen.add(vote.validator);
    }
    return seen.size>=c.quorum?{ok:true}:{ok:false,message:'certificate has too few distinct validators'};
  }

  private validateCertificateCommittee(c: FinalityCertificate): { ok: true } | { ok: false; message: string } {
    const parent = this.store.getIndexEntry(c.parentHash);
    if (!parent || c.height !== parent.height + 1) return { ok: false, message: 'certificate parent is unknown or inconsistent' };
    const validators = this.validatorsForAnchor(this.stateOf(parent), c.finalizedHeight);
    if (validators.length !== c.validatorCount || validatorSetHash(validators) !== c.validatorSetHash) {
      return { ok: false, message: 'certificate validator set mismatch' };
    }
    const eligible = new Map(validators.map((validator) => [validator.address, validator.publicKey]));
    if (c.votes.some((vote) => eligible.get(vote.validator) !== vote.publicKey)) {
      return { ok: false, message: 'certificate includes an ineligible validator' };
    }
    return { ok: true };
  }

  private validateFinalityCertificate(c: FinalityCertificate): { ok: true } | { ok: false; message: string } {
    const envelope = this.validateCertificateEnvelope(c);
    if (!envelope.ok) return envelope;
    const committee = this.validateCertificateCommittee(c);
    if (!committee.ok) return committee;
    const block = this.store.getBlockByHash(c.blockHash);
    if (!block || block.header.height !== c.height || block.header.prevHash !== c.parentHash) {
      return { ok: false, message: 'certificate target missing or inconsistent' };
    }
    const proposal = this.validateStoredProposal(block);
    if (!proposal.ok) return proposal;
    const ordinary = c.finalizedHeight > 0 && c.height === c.finalizedHeight + 1 && c.parentHash === c.finalizedHash &&
      this.store.getIndexEntry(c.finalizedHash)?.height === c.finalizedHeight;
    const bootstrap = c.finalizedHeight === 0 && c.finalizedHash === this.store.genesis?.hash &&
      this.isBootstrapTarget(block, c.validatorSetHash, true);
    if (!ordinary && !bootstrap) return { ok: false, message: 'certificate does not extend finality anchor' };

    const parent = this.store.getIndexEntry(c.parentHash)!;
    const validators = this.validatorsForAnchor(this.stateOf(parent), c.finalizedHeight);
    const eligible = new Map(validators.map((validator) => [validator.address, validator.publicKey]));
    const seen = new Set<string>();
    for (const vote of c.votes) {
      const verdict = this.validateFinalityVote(vote, { allowUnknown: false, skipAnchorCheck: true });
      if (!verdict.ok) return verdict;
      if (vote.finalizedHeight !== c.finalizedHeight || vote.finalizedHash !== c.finalizedHash ||
          vote.height !== c.height || vote.blockHash !== c.blockHash || vote.parentHash !== c.parentHash ||
          vote.validatorSetHash !== c.validatorSetHash || eligible.get(vote.validator) !== vote.publicKey || seen.has(vote.validator)) {
        return { ok: false, message: 'certificate contains duplicate or mismatched vote' };
      }
      seen.add(vote.validator);
    }
    return seen.size >= c.quorum ? { ok: true } : { ok: false, message: 'certificate has too few distinct validators' };
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
      validators: this.state.s.validators.size,
      lastBlockTimestamp: head?.timestamp ?? 0,
      finalizedHeight: this.finality.finalizedHeight,
      finalizedHash: this.finality.finalizedHash,
      finalityLag: Math.max(0,(head?.height??0)-this.finality.finalizedHeight),
      finalityValidatorCount: finalityStatus.validatorCount,
      finalityQuorum: finalityStatus.quorum,
      finalityBootstrapConfigured: finalityStatus.bootstrapConfigured,
    };
  }

  finalityStatus(): FinalityStatus {
    const head = this.store.head;
    let validators: ReturnType<typeof finalityValidators> = [];
    try {
      const committeeParent = this.finality.votes[0]
        ? this.store.getIndexEntry(this.finality.votes[0].parentHash)
        : this.finality.finalizedHeight === 0
          ? head
          : this.store.getIndexEntry(this.finality.finalizedHash);
      if (committeeParent) {
        validators = this.finality.finalizedHeight === 0 && !this.finality.votes.length
          ? this.bootstrapCommitteeAtParent(committeeParent)
          : this.validatorsForAnchor(this.stateOf(committeeParent), this.finality.finalizedHeight);
      }
    } catch {
      validators = [];
    }
    return {
      finalizedHeight: this.finality.finalizedHeight,
      finalizedHash: this.finality.finalizedHash,
      headHeight: head?.height ?? 0,
      confirmationsAfterFinality: Math.max(0, (head?.height ?? 0) - this.finality.finalizedHeight),
      validatorCount: validators.length,
      quorum: finalityQuorum(validators.length),
      pendingVotes: this.finality.votes.length,
      pendingUnknownVotes: this.pendingFinalityVotes.size,
      evidence: this.finality.evidence.length,
      bootstrap: this.finality.finalizedHeight === 0,
      bootstrapConfigured: this.bootstrapKeys().length > 0,
    };
  }

  latestFinalityCertificate():FinalityCertificate|null { return this.finality.certificate?structuredClone(this.finality.certificate):null; }
  equivocationEvidence():EquivocationEvidence[] { return structuredClone(this.finality.evidence); }

  /** Unsigned payload a validator wallet can review and sign locally. */
  finalityVoteTemplate(address: string, requested?: string): Omit<FinalityVote, 'signature'> | null {
    let target = requested;
    if (!target && this.finality.finalizedHeight > 0) {
      target = this.store.getCanonicalHashAtHeight(this.finality.finalizedHeight + 1);
    }
    if (!target && this.finality.finalizedHeight === 0) {
      const keys = this.bootstrapKeys();
      if (keys.length === 0) return null;
      for (let height = CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks + 1; height <= this.height; height += 1) {
        const hash = this.store.getCanonicalHashAtHeight(height);
        const block = hash ? this.store.getBlockByHash(hash) : null;
        const parent = block ? this.store.getIndexEntry(block.header.prevHash) : undefined;
        if (!hash || !block || !parent) continue;
        const committee = bootstrapFinalityValidators(this.stateOf(parent), keys);
        if (committee.length === keys.length && this.isBootstrapTarget(block, validatorSetHash(committee))) {
          target = hash;
          break;
        }
      }
    }
    if (!target) return null;
    const block = this.store.getBlockByHash(target);
    const parent = block ? this.store.getIndexEntry(block.header.prevHash) : undefined;
    if (!block || !parent || this.store.getCanonicalHashAtHeight(block.header.height) !== target) return null;

    const validators = this.validatorsForAnchor(this.stateOf(parent), this.finality.finalizedHeight);
    const validator = validators.find((member) => member.address === address);
    if (!validator) return null;
    const setHash = validatorSetHash(validators);
    const ordinary = block.header.height === this.finality.finalizedHeight + 1 && block.header.prevHash === this.finality.finalizedHash;
    const bootstrap = this.finality.finalizedHeight === 0 && this.isBootstrapTarget(block, setHash);
    if (!ordinary && !bootstrap) return null;
    if (this.finality.votes.some((vote) => vote.validator === address && vote.finalizedHash === this.finality.finalizedHash)) return null;

    return {
      protocolVersion: PROTOCOL_VERSION,
      networkId: this.options.net.networkId,
      chainId: this.options.net.chainId,
      genesisId: this.genesisId,
      paramsHash: PARAMS_HASH,
      type: 'POT_FINALITY',
      finalizedHeight: this.finality.finalizedHeight,
      finalizedHash: this.finality.finalizedHash,
      height: block.header.height,
      round: proposerRound(parent.timestamp, block.header.timestamp),
      blockHash: target,
      parentHash: block.header.prevHash,
      validatorSetHash: setHash,
      validator: address,
      publicKey: validator.publicKey,
    };
  }

  createFinalityVote(identity: { address: string; publicKey: string; privateKey: string }, requested?: string): FinalityVote | null {
    const template = this.finalityVoteTemplate(identity.address, requested);
    if (!template || template.publicKey !== identity.publicKey) return null;
    return signFinalityVote(template, identity.privateKey);
  }

  /**
   * The historical lookups the canonical finality predicate needs, bound to
   * THIS chain's storage and state.
   *
   * One factory, so every consumer — vote admission, vote restoration after a
   * restart, certificate verification, the equivocation detector and slash
   * evidence in a block being executed — asks the same question of the same
   * data. Nothing here is node-local opinion: each lookup answers from stored
   * blocks and from the state committed at a given block, and returns null when
   * this node genuinely does not have the answer.
   */
  private finalityVoteContext(): ConsensusEvidenceContext {
    return {
      networkId: this.options.net.networkId,
      chainId: this.options.net.chainId,
      genesisId: this.genesisId,
      paramsHash: PARAMS_HASH,
      addressHrp: this.options.net.addressHrp,
      anchorFor: (hash) => {
        const entry = this.store.getIndexEntry(hash);
        return entry ? { height: entry.height, timestamp: entry.timestamp } : null;
      },
      blockByHash: (hash) => this.store.getBlockByHash(hash) ?? null,
      committeeFor: (parentHash, finalizedHeight) => {
        const parent = this.store.getIndexEntry(parentHash);
        if (!parent) return null;
        return this.validatorsForAnchor(this.stateOf(parent), finalizedHeight);
      },
      isBootstrapTarget: (block, setHash, historical) => this.isBootstrapTarget(block, setHash, historical),
      scheduledProposerFor: (parentHash, height, round, timestamp) => {
        const parent = this.store.getIndexEntry(parentHash);
        if (!parent) return null;
        return scheduledProposer(this.stateOf(parent), height, round, timestamp);
      },
    };
  }

  /**
   * The same context, handed to the state transition so a SLASH transaction is
   * verified against history rather than against whatever this node holds now.
   *
   * Public on purpose: a caller that applies a block itself — a test, a
   * migration tool, an offline verifier — must supply the same history the chain
   * would, or evidence inside that block cannot be judged at all.
   */
  consensusEvidenceContext(): ConsensusEvidenceContext {
    return this.finalityVoteContext();
  }

  /**
   * Is this vote valid? Delegates to the canonical predicate in
   * consensus/finality-vote.ts — the chain holds no rules of its own, so the
   * answer cannot drift from the one the evidence verifier or a certificate
   * gives. `skipAnchorCheck` is what separates ADMISSION (the vote must extend
   * this node's own anchor) from judging a vote that arrived inside evidence or
   * a certificate, where the offence may predate this node's anchor.
   */
  private validateFinalityVote(
    vote: FinalityVote,
    options: { allowUnknown: boolean; skipAnchorCheck: boolean },
  ): FinalityVoteVerdict {
    return validateCanonicalFinalityVote(vote, this.finalityVoteContext(), {
      requireLocalAnchor: options.skipAnchorCheck
        ? false
        : { height: this.finality.finalizedHeight, hash: this.finality.finalizedHash },
      requireTargetBlock: true,
      allowUnknownTarget: options.allowUnknown,
      allowBootstrapTarget: true,
    });
  }

  addFinalityVote(vote:FinalityVote):FinalityAdmissionResult {
    let id:string; try{id=finalityVoteId(vote);}catch{return {accepted:false,code:ErrCode.MALFORMED,message:'vote cannot be encoded'};}
    if (this.finality.votes.some(v=>finalityVoteId(v)===id)||this.pendingFinalityVotes.has(id)) return {accepted:false,duplicate:true,code:ErrCode.REPLAY,message:'vote already known'};
    const certifiedPrior=this.finality.certificate?.votes.find(v=>v.validator===vote.validator&&v.finalizedHeight===vote.finalizedHeight&&v.finalizedHash===vote.finalizedHash);
    if (certifiedPrior) { if(certifiedPrior.blockHash===vote.blockHash&&certifiedPrior.height===vote.height)return {accepted:false,duplicate:true,code:ErrCode.REPLAY,message:'vote is already certified'}; const late=this.validateFinalityVote(vote,{allowUnknown:false,skipAnchorCheck:true}); if(!late.ok)return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:late.message}; const evidence=makeVoteEvidence(certifiedPrior,vote); this.persistEvidence(evidence); return {accepted:true,code:ErrCode.OK,message:'late conflicting vote retained as evidence only',evidence}; }
    const verdict=this.validateFinalityVote(vote,{allowUnknown:true,skipAnchorCheck:false});
    if (!verdict.ok) { if (verdict.unknown&&this.pendingFinalityVotes.size<CONSENSUS_PARAMS.consensus.finality.maxPendingVotes) { if([...this.pendingFinalityVotes.values()].some(v=>v.validator===vote.validator&&v.finalizedHeight===vote.finalizedHeight&&v.finalizedHash===vote.finalizedHash))return {accepted:false,code:ErrCode.RATE_LIMITED,message:'validator already has a pending vote for this anchor'}; this.pendingFinalityVotes.set(id,vote); return {accepted:false,code:ErrCode.ORPHAN_BLOCK,message:'vote queued until block arrives'}; } return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:verdict.message}; }
    const prior=this.finality.votes.find(v=>v.validator===vote.validator&&v.finalizedHash===vote.finalizedHash);
    if (prior&&(prior.blockHash!==vote.blockHash||prior.height!==vote.height)) { const evidence=makeVoteEvidence(prior,vote); this.persistEvidence(evidence); return {accepted:true,code:ErrCode.OK,message:'conflicting vote retained as evidence only',evidence}; }
    const votes=[...this.finality.votes,vote]; this.finalityStore.save({...this.finality,votes}); this.finality={...this.finality,votes};
    const matching=votes.filter(v=>v.blockHash===vote.blockHash&&v.height===vote.height&&v.validatorSetHash===vote.validatorSetHash); const parent=this.store.getIndexEntry(vote.parentHash)!; const validators=this.validatorsForAnchor(this.stateOf(parent),vote.finalizedHeight), quorum=finalityQuorum(validators.length);
    if (matching.length<quorum) { this.emit('finality-vote',vote); return {accepted:true,code:ErrCode.OK,message:'finality vote accepted'}; }
    const certificate:FinalityCertificate={version:1,finalizedHeight:vote.finalizedHeight,finalizedHash:vote.finalizedHash,height:vote.height,blockHash:vote.blockHash,parentHash:vote.parentHash,validatorSetHash:vote.validatorSetHash,quorum,validatorCount:validators.length,votes:matching.sort((a,b)=>a.validator.localeCompare(b.validator))}; this.commitFinalityCertificate(certificate); return {accepted:true,finalized:true,code:ErrCode.OK,message:'checkpoint finalized'};
  }

  addFinalityCertificate(c:FinalityCertificate):FinalityAdmissionResult {
    if (!c||!Number.isSafeInteger(c.height)) return {accepted:false,code:ErrCode.MALFORMED,message:'certificate is malformed'};
    const envelope=this.validateCertificateEnvelope(c);if(!envelope.ok)return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:envelope.message};
    if (c.height<this.finality.finalizedHeight||(c.height===this.finality.finalizedHeight&&c.blockHash===this.finality.finalizedHash)) return {accepted:false,duplicate:true,code:ErrCode.REPLAY,message:'certificate already known or older'};
    if (c.height===this.finality.finalizedHeight || c.finalizedHeight<this.finality.finalizedHeight || (c.finalizedHeight===this.finality.finalizedHeight&&c.finalizedHash!==this.finality.finalizedHash)) return {accepted:false,code:ErrCode.FINALITY_CONFLICT,message:'certificate conflicts with local finality'};
    if (c.finalizedHeight>this.finality.finalizedHeight&&this.store.getCanonicalHashAtHeight(c.finalizedHeight)!==c.finalizedHash) return {accepted:false,code:ErrCode.FINALITY_CONFLICT,message:'certificate anchor is not on the local canonical descendant'};
    if(!this.store.getBlockByHash(c.blockHash)){
      const committee=this.validateCertificateCommittee(c);if(!committee.ok)return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:committee.message};
      if(this.pendingCertifiedTargets.size>=CONSENSUS_PARAMS.consensus.finality.maxCandidatesPerHeight*2&&!this.pendingCertifiedTargets.has(c.blockHash))return {accepted:false,code:ErrCode.RATE_LIMITED,message:'pending certified target limit reached'};
      this.pendingCertifiedTargets.set(c.blockHash,c);
      return {accepted:false,code:ErrCode.ORPHAN_BLOCK,message:'certificate target is not stored'};
    }
    const v=this.validateFinalityCertificate(c); if (!v.ok) return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:v.message}; this.commitFinalityCertificate(c); return {accepted:true,finalized:true,code:ErrCode.OK,message:'certificate accepted'};
  }
  private commitFinalityCertificate(c:FinalityCertificate):void { const next={...this.finality,finalizedHeight:c.height,finalizedHash:c.blockHash,certificate:c,votes:[]}; this.finalityStore.save(next); this.finality=next; this.pendingFinalityVotes.clear(); this.pendingCertifiedTargets.delete(c.blockHash); if (this.store.getCanonicalHashAtHeight(c.height)!==c.blockHash) this.reorganise(c.blockHash,true); this.pruneStateCache(); this.emit('finalized',c); }

  private persistEvidence(e:EquivocationEvidence):boolean { if (evidenceSerializedBytes(e)>CONSENSUS_PARAMS.consensus.finality.maxEvidenceBytes||this.finality.evidence.some(x=>x.id===e.id)) return false; const evidence=[...this.finality.evidence,e].slice(-CONSENSUS_PARAMS.consensus.finality.maxEvidenceRecords); this.finalityStore.save({...this.finality,evidence}); this.finality={...this.finality,evidence}; this.emit('equivocation',e); return true; }
  addEquivocationEvidence(e:EquivocationEvidence,persist=true):FinalityAdmissionResult {
    if (!e||e.version!==1||evidenceSerializedBytes(e)>CONSENSUS_PARAMS.consensus.finality.maxEvidenceBytes) return {accepted:false,code:ErrCode.MALFORMED,message:'evidence malformed or oversized'};
    if (this.finality.evidence.some(x=>x.id===e.id)) return {accepted:false,duplicate:true,code:ErrCode.REPLAY,message:'evidence already known'};
    if (e.type==='VOTE_EQUIVOCATION') { const a=this.validateFinalityVote(e.firstVote,{allowUnknown:false,skipAnchorCheck:true}), b=this.validateFinalityVote(e.secondVote,{allowUnknown:false,skipAnchorCheck:true}); if (!a.ok||!b.ok||e.firstVote.validator!==e.secondVote.validator||e.firstVote.finalizedHash!==e.secondVote.finalizedHash||(e.firstVote.blockHash===e.secondVote.blockHash&&e.firstVote.height===e.secondVote.height)) return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:'vote evidence does not prove conflict'}; let rebuilt:EquivocationEvidence; try{rebuilt=makeVoteEvidence(e.firstVote,e.secondVote);}catch{return {accepted:false,code:ErrCode.MALFORMED,message:'vote evidence cannot be canonicalized'};} if(rebuilt.id!==e.id)return {accepted:false,code:ErrCode.MALFORMED,message:'vote evidence identity noncanonical'}; }
    else if (e.type==='PROPOSER_EQUIVOCATION') { let first:BlockHeader,second:BlockHeader; try{first=decodeSignedHeader(fromHex(e.firstHeader));second=decodeSignedHeader(fromHex(e.secondHeader));}catch{return {accepted:false,code:ErrCode.MALFORMED,message:'proposal headers cannot decode'};} const fp=this.store.getIndexEntry(first.prevHash),sp=this.store.getIndexEntry(second.prevHash); if (!fp||!sp||!verifyBlockSignature({header:first,transactions:[]},this.options.net.addressHrp)||!verifyBlockSignature({header:second,transactions:[]},this.options.net.addressHrp)||first.protocolVersion!==PROTOCOL_VERSION||second.protocolVersion!==PROTOCOL_VERSION||first.chainId!==this.options.net.chainId||second.chainId!==this.options.net.chainId||first.paramsHash!==PARAMS_HASH||second.paramsHash!==PARAMS_HASH||first.height!==fp.height+1||second.height!==sp.height+1||first.cumulativePotWeight!==BigInt(fp.cumulativePotWeight)+1n||second.cumulativePotWeight!==BigInt(sp.cumulativePotWeight)+1n||!isProposerAllowed(this.stateOf(fp),first.producer,first.height,proposerRound(fp.timestamp,first.timestamp))||!isProposerAllowed(this.stateOf(sp),second.producer,second.height,proposerRound(sp.timestamp,second.timestamp))||first.producer!==second.producer||first.height!==second.height||blockHash(first)===blockHash(second)||proposerRound(fp.timestamp,first.timestamp)!==proposerRound(sp.timestamp,second.timestamp)) return {accepted:false,code:ErrCode.BAD_SIGNATURE,message:'proposal evidence does not prove same-round equivocation'}; const rebuilt=makeProposerEvidence({validator:first.producer,height:first.height,round:proposerRound(fp.timestamp,first.timestamp),firstId:blockHash(first),secondId:blockHash(second),firstHeader:toHex(encodeSignedHeader(first)),secondHeader:toHex(encodeSignedHeader(second))}); if (rebuilt.id!==e.id) return {accepted:false,code:ErrCode.MALFORMED,message:'proposal evidence identity noncanonical'}; }
    else return {accepted:false,code:ErrCode.MALFORMED,message:'unknown evidence type'};
    if (persist) this.persistEvidence(e); else this.finality={...this.finality,evidence:[...this.finality.evidence,e]}; return {accepted:true,code:ErrCode.OK,message:'evidence accepted'};
  }

  private detectProposerEquivocation(block:Block,round:number):void { const hash=blockHash(block.header); for (const siblingEntry of this.store.entriesAtHeight(block.header.height)) { if (siblingEntry.hash===hash||siblingEntry.producer!==block.header.producer) continue; const sibling=this.store.getBlockByHash(siblingEntry.hash),parent=sibling?this.store.getIndexEntry(sibling.header.prevHash):undefined; if (!sibling||!parent||proposerRound(parent.timestamp,sibling.header.timestamp)!==round) continue; this.persistEvidence(makeProposerEvidence({validator:block.header.producer,height:block.header.height,round,firstId:siblingEntry.hash,secondId:hash,firstHeader:toHex(encodeSignedHeader(sibling.header)),secondHeader:toHex(encodeSignedHeader(block.header))})); break; } }
  private retryPendingFinalityVotes(hash:string):void { for (const [id,vote] of [...this.pendingFinalityVotes]) if (vote.blockHash===hash) { this.pendingFinalityVotes.delete(id); this.addFinalityVote(vote); } }
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
    if (header.height <= this.finality.finalizedHeight) {
      if (this.store.getCanonicalHashAtHeight(header.height) !== hash) reject(ErrCode.FINALITY_CONFLICT, `block at height ${header.height} conflicts with finalized history`);
    } else if (this.store.ancestorHashAt(parentEntry,this.finality.finalizedHeight)!==this.finality.finalizedHash) {
      reject(ErrCode.FINALITY_CONFLICT,'block parent branch omits finalized checkpoint');
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
    if (currentHead && currentHead.height - parentEntry.height > CONSENSUS_PARAMS.consensus.maxReorgDepth && !this.pendingCertifiedTargets.has(hash)) {
      reject(
        ErrCode.STALE_BLOCK,
        `block forks at height ${parentEntry.height}, more than ${CONSENSUS_PARAMS.consensus.maxReorgDepth} blocks behind the head (${currentHead.height})`,
      );
    }
    if (this.store.entriesAtHeight(header.height).length >= CONSENSUS_PARAMS.consensus.finality.maxCandidatesPerHeight && !this.pendingCertifiedTargets.has(hash)) reject(ErrCode.RATE_LIMITED,`candidate limit reached at height ${header.height}`);
    assertBlockSignature(block, this.options.net.addressHrp);

    const ancestorTimestamps = this.store.ancestorTimestamps(header.prevHash, CONSENSUS_PARAMS.block.medianTimePastWindow);
    const timestampCheck = checkBlockTimestamp(header.timestamp, ancestorTimestamps, Math.floor(Date.now() / 1000));
    if (!timestampCheck.ok) {
      reject(ErrCode.BAD_TIMESTAMP, timestampCheck.reason ?? 'invalid block timestamp');
    }

    // Apply on top of the PARENT state, not the current head: this is what makes
    // fork branches validatable without trusting this node's own view.
    const parentState = this.stateOf(parentEntry);
    // The round comes from the two timestamps the headers already commit to, so
    // a block produced after the scheduled validator let its slot lapse is
    // accepted from whoever the rotation hands the turn to next.
    const round = proposerRound(parentEntry.timestamp, header.timestamp);
    if (this.options.enforceProposerRotation !== false) {
      // One decision function, so a validating node and a producing node answer
      // the same question the same way. It is read against the PARENT state at
      // the BLOCK's own protocol time: a jail is a duration of time, so the set
      // that names the proposer for this height is the set as it stands at this
      // timestamp — which is what lets a validator whose term lapses exactly at
      // this block be the one that produces it.
      const decision = proposerDecision(parentState, header.height, round, header.timestamp);
      if (decision.kind === 'HALTED') {
        // Not "expecting somebody else": expecting NOBODY. An established chain
        // with no active validator stops instead of accepting a block from any
        // key that can sign one, because "no validators registered" is not
        // distinguishable on-chain from "every validator left".
        reject(
          ErrCode.NOT_PRODUCER_TURN,
          `the chain is halted for want of validators at height ${header.height}: ${decision.reason}`,
        );
      }
      if (decision.kind === 'SCHEDULED' && decision.proposer !== header.producer) {
        reject(
          ErrCode.NOT_PRODUCER_TURN,
          `proposer ${header.producer} is not scheduled for height ${header.height} round ${round}`,
        );
      }
    }

    const applied = applyBlock(parentState, block, {
      net: this.options.net,
      // Evidence inside this block is verified against history: the committee
      // and the anchor as they were when the offence happened, never this node's
      // current view. Every node applying the block builds the same context from
      // the same stored blocks, so the verdict is identical everywhere.
      evidence: this.consensusEvidenceContext(),
    });

    this.store.putBlock(block);
    const entry = this.store.getIndexEntry(hash)!;
    this.rememberState(entry, applied.state);
    this.rememberEvents(entry.hash, applied.events);
    this.detectProposerEquivocation(block,round);

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
      this.retryPendingFinalityVotes(hash);
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
    this.retryPendingFinalityVotes(hash);
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
      const applied = applyBlock(state, block, { net: this.options.net, evidence: this.consensusEvidenceContext() });
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
  private reorganise(newHeadHash: string, finalityAdoption = false): { forkHeight: number; abandoned: number; adopted: number } {
    const branch = this.store.branchFromCanonical(newHeadHash);
    if (!branch) throw new Error('reorg failed: new head is not connected to the canonical chain');
    const { forkHeight, entries } = branch;
    const oldHead = this.store.head!;
    const abandoned = oldHead.height - forkHeight;
    if (!finalityAdoption && forkHeight < this.finality.finalizedHeight) reject(ErrCode.FINALITY_CONFLICT,`reorg fork ${forkHeight} below finalized ${this.finality.finalizedHeight}`);
    if (finalityAdoption && newHeadHash !== this.finality.finalizedHash) reject(ErrCode.FINALITY_CONFLICT,'only newly certified target may use certified adoption');
    if (!finalityAdoption && (abandoned > CONSENSUS_PARAMS.consensus.maxReorgDepth || entries.length > CONSENSUS_PARAMS.consensus.maxReorgDepth)) {
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
    const orphanScanStart=finalityAdoption?Math.max(forkHeight+1,oldHead.height-CONSENSUS_PARAMS.consensus.maxReorgDepth+1):forkHeight+1;
    for (let height = orphanScanStart; height <= oldHead.height; height += 1) {
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
      const applied = applyBlock(state, block, { net: this.options.net, evidence: this.consensusEvidenceContext() });
      state = applied.state;
      this.rememberState(entry, state);
      this.rememberEvents(entry.hash, applied.events);
    }
    this.store.reorganiseCanonical(forkHeight, entries);
    this.state = state;

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
        base = createGenesisState(genesisBlock, this.options.net, this.options.genesisDocument.bootstrapValidatorPublicKeys ?? []);
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
      state = applyBlock(state, block, { net: this.options.net, evidence: this.consensusEvidenceContext() }).state;
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
   * Who is entitled to produce the next block at this node's current protocol
   * time, or null when any node may. Shares its round arithmetic with
   * `buildNextBlock` so the production loop and the builder can never disagree
   * about whose turn it is.
   */
  scheduledProposerNow(): string | null {
    const head = this.store.head;
    if (!head) return null;
    return scheduledProposer(this.state, head.height + 1, proposerRound(head.timestamp, this.protocolTime));
  }

  /**
   * Build the next block for this slot. Returns null when this node is not the
   * scheduled proposer (validator rotation) — nodes never race to produce.
   */
  buildNextBlock(producer: { address: string; privateKey: string; publicKey: string }): Block | null {
    const head = this.store.head;
    if (!head) return null;

    const height = head.height + 1;
    const timestamp = this.protocolTime;
    // Same round the verifiers will recompute from the finished header.
    const round = proposerRound(head.timestamp, timestamp);
    if (!isProposerAllowed(this.state, producer.address, height, round)) return null;

    // ── The double-sign lock ────────────────────────────────────────────────
    // A proposer signs at most ONE proposal for a given (height, round). Two
    // different signed headers for one slot are exactly what the equivocation
    // penalty is for, so a slot this node has already signed is never signed
    // again: not after a locally rejected block, not after a restart. The lock
    // is armed and PERSISTED before the header is built, because the signature
    // is the irreversible act — a crash between the two leaves the slot closed,
    // which costs one turn instead of the bond. A later round of the same height
    // is a different slot and stays available, so the liveness backstop
    // (anyone may produce once every validator's slot has lapsed) still works.
    const signed = this.finality.lastProposal ?? null;
    if (signed && signed.height === height && signed.round === round) {
      this.emit('proposal-lock', { height, round });
      return null;
    }
    this.finality = { ...this.finality, lastProposal: { height, round } };
    this.finalityStore.save(this.finality);

    const ctx: BlockContext = {
      height,
      timestamp,
      chainId: this.options.net.chainId,
      producer: producer.address,
      // A producer verifies the evidence it is about to include with exactly the
      // context a validating node will use, so the two cannot reach different
      // verdicts about the same transaction.
      evidence: this.consensusEvidenceContext(),
    };
    // Derived from the PARENT state before the working copy advances, exactly as
    // every validating node derives it from the finished block.
    const missedProposers = missedProposersFor(this.state, height, head.timestamp, timestamp, producer.address);

    const candidates = this.mempool.selectForBlock(
      CONSENSUS_PARAMS.block.maxBlockTransactions,
      Mempool.nonceMapFrom(this.state),
    );

    // Simulate candidate by candidate. A transaction that fails at this height
    // is dropped from the block rather than poisoning it; each attempt runs on a
    // clone so a failure leaves the working state untouched.
    const assemble = (checkEachTransaction: boolean): { accepted: TxEnvelope[]; finalized: ReturnType<typeof finalizeBlock> } => {
      let working = this.state.clone();
      working.advanceBlock(height, timestamp);
      const events: ProtocolEvent[] = [];
      const accepted: TxEnvelope[] = [];
      let evidenceAttempted = 0;
      let evidenceAttemptBytes = 0;
      for (const tx of candidates) {
        if (tx.type === TxType.SLASH) {
          const size = encodeSignedTx(tx).length;
          if (
            evidenceAttempted >= MAX_SLASH_VERIFICATIONS_PER_BLOCK ||
            evidenceAttemptBytes + size > MAX_SLASH_VERIFICATION_BYTES_PER_BLOCK
          ) {
            // Left in the pool on purpose: this is a candidate for a later slot,
            // not a rejected transaction. Dropping it here would let one peer
            // decide which accusations a node is willing to look at.
            continue;
          }
          evidenceAttempted += 1;
          evidenceAttemptBytes += size;
        }
        const trial = working.clone();
        trial.advanceBlock(height, timestamp);
        try {
          const outcome = applyTransactions(trial, [tx], ctx, this.options.net);
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
          working = outcome.state;
          events.push(...outcome.events);
          accepted.push(tx);
        } catch (error) {
          // A transaction that is invalid against the current state must not be
          // retried forever. In particular, a peer could otherwise advertise a
          // large gas value without the balance/body to support it, win mempool
          // eviction priority, and make every producer re-execute it each slot.
          this.mempool.remove(tx.id);
          this.emit('rejected-transaction', { txId: tx.id, reason: (error as Error).message });
          continue;
        }
      }
      events.push(...runBlockRoutines(working, ctx, this.options.net, { missedProposers }));
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
        const events = runBlockRoutines(working, ctx, this.options.net, { missedProposers });
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
      // A SLASH transaction *is* the evidence, so its body has to decode into
      // the shape the state transition will verify. An undecodable body can
      // never apply to any state, and relaying it spends bandwidth, pool space
      // and verification work for nothing — so it is refused at gossip, where
      // the penalty falls on the peer that relayed it. Structural only: no state
      // is read and no verdict about the offence is formed here, because that
      // stays a consensus decision.
      if (tx.type === TxType.SLASH) decodeSlashBody(tx.body);
      // Gas is the mempool's eviction priority. Refuse a peer's priority claim
      // unless the current state proves the sender can fund at least that much;
      // full type-specific validity is still decided at block execution.
      if ((account?.balance ?? 0n) < tx.gas) {
        reject(ErrCode.INSUFFICIENT_FUNDS, 'sender cannot fund the gas used for mempool priority');
      }
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
    if (this.store.getCanonicalHashAtHeight(this.finality.finalizedHeight)!==this.finality.finalizedHash) problems.push('finality lock is not canonical');
    if (this.finality.certificate) { const v=this.validateFinalityCertificate(this.finality.certificate); if (!v.ok) problems.push(`finality certificate invalid: ${v.message}`); }
    return { ok: problems.length === 0, problems };
  }

  /** Core version advertised to peers and the interface. */
  get version(): string {
    return CORE_VERSION;
  }
}
