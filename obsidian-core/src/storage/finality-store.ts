/** Crash-safe bounded storage for local finality locks, votes and evidence. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { EquivocationEvidence, FinalityCertificate, FinalityVote } from '../protocol/types.js';
import { sha256Hex, utf8 } from '../crypto/hash.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { atomicWriteFile, ensureDir } from './atomic.js';

export interface FinalityIdentity { networkId:string; chainId:number; genesisId:string; protocolVersion:string; paramsHash:string }
export interface PersistedFinalityState extends FinalityIdentity {
  version:1; finalizedHeight:number; finalizedHash:string; certificate:FinalityCertificate|null;
  votes:FinalityVote[]; evidence:EquivocationEvidence[];
  /**
   * The last (height, round) this node signed a block proposal for. A proposer
   * signs at most ONE proposal per slot, so this lock is what stops a retry — or
   * a restart — from producing the two conflicting headers an equivocation slash
   * is made of. It is written before the signature exists, because the signature
   * is the thing that cannot be taken back, and it is stored in the same
   * crash-safe, identity-bound seal as the finality locks: on another network,
   * another chain or another genesis the file is refused outright, so a lock can
   * never be mistaken for one taken on a different chain.
   */
  lastProposal?:{height:number;round:number}|null;
}
interface Envelope { checksum:string; state:PersistedFinalityState }
function bodyOf(state:PersistedFinalityState):string { return JSON.stringify(state); }
const MAX_BYTES = CONSENSUS_PARAMS.consensus.finality.maxEvidenceRecords * CONSENSUS_PARAMS.consensus.finality.maxEvidenceBytes + CONSENSUS_PARAMS.consensus.finality.maxValidators * 4096 + 1024*1024;

export class FinalityStore {
  readonly directory:string; readonly path:string;
  constructor(dataDir:string) { this.directory=join(dataDir,'finality'); this.path=join(this.directory,'state.json'); ensureDir(this.directory); }
  load():PersistedFinalityState|null {
    if (!existsSync(this.path)) return null;
    if (statSync(this.path).size > MAX_BYTES) throw new Error('finality state exceeds bounded storage limit');
    let envelope:Envelope;
    try { envelope=JSON.parse(readFileSync(this.path,'utf8')) as Envelope; } catch(e) { throw new Error(`finality state is not valid JSON: ${(e as Error).message}`); }
    if (!envelope || typeof envelope.checksum!=='string' || !envelope.state) throw new Error('finality state envelope is malformed');
    if (sha256Hex(utf8(bodyOf(envelope.state)))!==envelope.checksum) throw new Error('finality state checksum mismatch; refusing to forget a safety lock');
    return envelope.state;
  }
  save(state:PersistedFinalityState):void {
    const body=bodyOf(state); if (Buffer.byteLength(body,'utf8')>MAX_BYTES) throw new Error('finality state exceeds bounded storage limit');
    atomicWriteFile(this.path,`${JSON.stringify({checksum:sha256Hex(utf8(body)),state},null,2)}\n`);
  }
}
