/**
 * Crash-safe local safety record.
 *
 * Two facts must survive a restart and cannot be re-derived from the blocks alone:
 *
 *   1. The highest FINALIZED checkpoint this node has ever seen (height + block hash). Finality is a monotone value
 *      in chain state; this file is the node's memory of it. On startup the canonical chain must still contain that
 *      block, and the head state must not report a lower finalized height — otherwise the data directory was
 *      rolled back, swapped for another branch or tampered with, and the node refuses to start rather than silently
 *      accept a chain that rewrites what it already treated as final.
 *
 *   2. The last (height, parent) this node SIGNED a block for. A producer signs at most one block per parent: two
 *      different signed headers on one parent are the equivocation that bans a node. The lock is written BEFORE the
 *      signature exists, because the signature is the irreversible act. A crash between the two costs one turn.
 *
 * The file is bound to the network identity, written atomically and carries a checksum. It holds no secret.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex, utf8 } from '../crypto/hash.js';
import { atomicWriteFile, ensureDir } from './atomic.js';

export interface SafetyIdentity {
  networkId: string;
  chainId: number;
  genesisId: string;
  protocolVersion: string;
  paramsHash: string;
}

export interface SafetyRecord extends SafetyIdentity {
  version: 1;
  /** Highest finalized checkpoint ever observed. Height 0 means "genesis only" and carries an empty hash. */
  finalizedHeight: number;
  finalizedHash: string;
  /** The last parent this node signed a block on. */
  lastSigned: { height: number; parentHash: string } | null;
}

interface Envelope {
  checksum: string;
  record: SafetyRecord;
}

const MAX_BYTES = 16 * 1024;

const bodyOf = (record: SafetyRecord): string => JSON.stringify(record);

export class SafetyStore {
  readonly directory: string;
  readonly path: string;

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'safety');
    this.path = join(this.directory, 'state.json');
    ensureDir(this.directory);
  }

  load(): SafetyRecord | null {
    if (!existsSync(this.path)) return null;
    if (statSync(this.path).size > MAX_BYTES) throw new Error('safety record exceeds its storage bound');
    let envelope: Envelope;
    try {
      envelope = JSON.parse(readFileSync(this.path, 'utf8')) as Envelope;
    } catch {
      throw new Error('safety record is not valid JSON; refusing to forget a finality checkpoint or signing lock');
    }
    if (!envelope || typeof envelope.checksum !== 'string' || !envelope.record) {
      throw new Error('safety record envelope is malformed');
    }
    if (sha256Hex(utf8(bodyOf(envelope.record))) !== envelope.checksum) {
      throw new Error('safety record checksum mismatch; refusing to forget a finality checkpoint or signing lock');
    }
    return envelope.record;
  }

  save(record: SafetyRecord): void {
    const body = bodyOf(record);
    atomicWriteFile(this.path, `${JSON.stringify({ checksum: sha256Hex(utf8(body)), record }, null, 2)}\n`);
  }
}
