/**
 * Node-side indexer.
 *
 * The indexer is a CACHE. It can be deleted and rebuilt from blocks at any
 * time, and nothing in the protocol depends on it. It exists so the explorer,
 * wallets and applications can answer "where is this transaction", "what
 * happened to this address" and "what events did this block emit" quickly.
 *
 * Records are appended as JSON lines and folded back into memory at startup;
 * a torn tail is dropped, so an unclean shutdown costs at most the last block's
 * index entries, which are re-added when the node replays that block.
 */

import { appendLineSync, readJsonLines } from '../storage/atomic.js';
import { join } from 'node:path';
import type { Block, ProtocolEvent, TxEnvelope } from '../protocol/types.js';
import { TxType } from '../protocol/types.js';
import type { WorldState } from '../blockchain/state.js';
import { blockHash } from '../blockchain/block.js';
import { shortHash } from '../blockchain/state-root.js';
import { formatObs } from '../protocol/amount.js';
import { decodePaymentBody } from '../transactions/executors/payment.js';
import { decodeMiningBody } from '../transactions/executors/mining.js';
import { decodeOnsBody } from '../transactions/executors/ons.js';
import { decodeCapsuleBody } from '../transactions/executors/capsule.js';
import { decodeLandBody } from '../transactions/executors/land.js';
import { decodeSocialBody } from '../transactions/executors/social.js';
import { decodeOracleBody } from '../transactions/executors/oracle.js';
import { decodeValidatorBody } from '../transactions/executors/validator.js';
import { decodeTreasuryBody } from '../transactions/executors/treasury.js';

export interface TxIndexRecord {
  txId: string;
  height: number;
  blockHash: string;
  index: number;
  type: number;
  sender: string;
  /** Partial recipient for display; the full address lives in the transaction. */
  recipient?: string;
  amount?: string;
  gas: string;
  timestamp: number;
  memo?: string;
  status: 'INCLUDED';
  /** Human-facing classification for the explorer (never authoritative). */
  kind?: string;
  /** The on-chain object this transaction acted on (parcel id, name, claim id…). */
  reference?: string;
  /** Short human-readable note (oracle sources, treasury purpose…). */
  note?: string;
}

export interface EventIndexRecord extends ProtocolEvent {
  blockHash: string;
}

export interface MiningClaimIndexRecord {
  txId: string;
  height: number;
  miner: string;
  reward: string;
  claimId: string;
  genesisAwarded: boolean;
  timestamp: number;
}

export interface IndexSummary {
  transactions: number;
  events: number;
  miningClaims: number;
  blocks: number;
  lastHeight: number;
  diskBytes: number;
}

const MAX_ADDRESS_HISTORY = 5_000;

export class Indexer {
  private readonly directory: string;
  private readonly txByHeight = new Map<number, TxIndexRecord[]>();
  private readonly txById = new Map<string, TxIndexRecord>();
  private readonly txByAddress = new Map<string, TxIndexRecord[]>();
  private readonly claims: MiningClaimIndexRecord[] = [];
  private readonly recentEvents: EventIndexRecord[] = [];
  private lastIndexedHeight = -1;
  private blockCounter = 0;

  constructor(dataDir: string) {
    this.directory = join(dataDir, 'index');
    this.load();
  }

  private get txPath(): string {
    return join(this.directory, 'transactions.jsonl');
  }
  private get eventPath(): string {
    return join(this.directory, 'events.jsonl');
  }
  private get claimPath(): string {
    return join(this.directory, 'mining-claims.jsonl');
  }

  private load(): void {
    for (const record of readJsonLines<TxIndexRecord>(this.txPath)) {
      this.addTxRecord(record, false);
    }
    for (const record of readJsonLines<EventIndexRecord>(this.eventPath)) {
      this.addEventRecord(record, false);
    }
    for (const record of readJsonLines<MiningClaimIndexRecord>(this.claimPath)) {
      this.claims.push(record);
    }
    const heights = [...this.txByHeight.keys()];
    this.lastIndexedHeight = heights.length > 0 ? Math.max(...heights) : -1;
    this.blockCounter = this.lastIndexedHeight + 1;
  }

  get height(): number {
    return this.lastIndexedHeight;
  }

  /** Index one applied block. Called by the node for every connected block. */
  indexBlock(block: Block, events: ProtocolEvent[], state: WorldState): void {
    const hash = blockHash(block.header);
    block.transactions.forEach((tx, index) => {
      const record: TxIndexRecord = {
        txId: tx.id,
        height: block.header.height,
        blockHash: hash,
        index,
        type: tx.type,
        sender: tx.sender,
        gas: tx.gas.toString(),
        timestamp: block.header.timestamp,
        memo: tx.memo,
        status: 'INCLUDED',
        ...describeTx(tx),
      };
      this.addTxRecord(record, true);
    });
    for (const event of events) {
      this.addEventRecord({ ...event, blockHash: hash }, true);
    }
    for (const event of events) {
      if (event.type === 'MINING_CLAIM') {
        const record: MiningClaimIndexRecord = {
          txId: String(event.txId ?? ''),
          height: event.height,
          miner: String(event.data.miner ?? ''),
          reward: String(event.data.reward ?? '0'),
          claimId: String(event.data.claimId ?? ''),
          genesisAwarded: Boolean(event.data.genesisAwarded),
          timestamp: Number(event.data.protocolTime ?? block.header.timestamp),
        };
        this.claims.push(record);
        appendLineSync(this.claimPath, JSON.stringify(record));
      }
    }
    this.lastIndexedHeight = block.header.height;
    this.blockCounter += 1;
    void state;
  }

  private addTxRecord(record: TxIndexRecord, persist: boolean): void {
    this.txById.set(record.txId, record);
    const atHeight = this.txByHeight.get(record.height) ?? [];
    atHeight.push(record);
    this.txByHeight.set(record.height, atHeight);
    const forSender = this.txByAddress.get(record.sender) ?? [];
    forSender.push(record);
    if (forSender.length > MAX_ADDRESS_HISTORY) forSender.splice(0, forSender.length - MAX_ADDRESS_HISTORY);
    this.txByAddress.set(record.sender, forSender);
    if (record.recipient) {
      const forRecipient = this.txByAddress.get(record.recipient) ?? [];
      forRecipient.push(record);
      if (forRecipient.length > MAX_ADDRESS_HISTORY) {
        forRecipient.splice(0, forRecipient.length - MAX_ADDRESS_HISTORY);
      }
      this.txByAddress.set(record.recipient, forRecipient);
    }
    if (persist) appendLineSync(this.txPath, JSON.stringify(record));
  }

  private addEventRecord(record: EventIndexRecord, persist: boolean): void {
    this.recentEvents.push(record);
    if (this.recentEvents.length > 20_000) this.recentEvents.splice(0, this.recentEvents.length - 20_000);
    if (persist) appendLineSync(this.eventPath, JSON.stringify(record));
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getTransaction(txId: string): TxIndexRecord | undefined {
    return this.txById.get(txId);
  }

  transactionsInBlock(height: number): TxIndexRecord[] {
    return this.txByHeight.get(height) ?? [];
  }

  /** Address history with partially masked counterparties, for public pages. */
  addressHistory(address: string, limit = 25): Array<Omit<TxIndexRecord, 'recipient'> & { recipient?: string }> {
    const records = this.txByAddress.get(address) ?? [];
    return records
      .slice(-limit)
      .reverse()
      .map((record) => ({
        ...record,
        recipient: record.recipient ? maskAddress(record.recipient) : undefined,
        sender: maskAddress(record.sender),
      }));
  }

  miningClaims(limit = 25, miner?: string): MiningClaimIndexRecord[] {
    const filtered = miner ? this.claims.filter((claim) => claim.miner === miner) : this.claims;
    return filtered.slice(-limit).reverse();
  }

  events(limit = 50, type?: string): EventIndexRecord[] {
    const filtered = type ? this.recentEvents.filter((event) => event.type === type) : this.recentEvents;
    return filtered.slice(-limit).reverse();
  }

  summary(): IndexSummary {
    return {
      transactions: this.txById.size,
      events: this.recentEvents.length,
      miningClaims: this.claims.length,
      blocks: this.blockCounter,
      lastHeight: this.lastIndexedHeight,
      diskBytes: 0,
    };
  }
}

/**
 * Extract the display-relevant fields of a transaction for the explorer.
 *
 * Every decoder is total: a body this build cannot understand yields an empty
 * summary rather than an exception, so one unknown transaction can never stop a
 * node from indexing a block.
 */
function describeTx(tx: TxEnvelope): Partial<TxIndexRecord> {
  try {
    switch (tx.type) {
      case TxType.PAYMENT: {
        const body = decodePaymentBody(tx.body);
        return { recipient: body.to, amount: body.amount.toString() };
      }
      case TxType.MINING_CLAIM: {
        const body = decodeMiningBody(tx.body);
        return { recipient: undefined, amount: undefined, kind: 'MINING_CLAIM', reference: body.claimId, note: `claim #${body.claimSequence}` };
      }
      case TxType.ONS: {
        const body = decodeOnsBody(tx.body);
        return {
          recipient: body.to || body.address || undefined,
          amount: body.fee > 0n ? body.fee.toString() : undefined,
          kind: `ONS_${onsOpName(body.op)}`,
          reference: `${body.name}.obs`,
        };
      }
      case TxType.CAPSULE: {
        const body = decodeCapsuleBody(tx.body);
        const amount = body.payment && body.payment > 0n ? body.payment : body.commitment;
        return {
          recipient: undefined,
          amount: amount && amount > 0n ? amount.toString() : undefined,
          kind: `CAPSULE_${capsuleOpName(body.op)}`,
          reference: body.capsuleId,
        };
      }
      case TxType.LAND: {
        const body = decodeLandBody(tx.body);
        return {
          recipient: body.to || undefined,
          amount: body.price && body.price > 0n ? body.price.toString() : undefined,
          kind: `LAND_${landOpName(body.op)}`,
          reference: `${body.divisionId}${body.subId ? `/${body.subId}` : ''}#${body.plotIndex}`,
        };
      }
      case TxType.SOCIAL: {
        const body = decodeSocialBody(tx.body);
        return {
          recipient: body.target || undefined,
          amount: body.amount && body.amount > 0n ? body.amount.toString() : undefined,
          kind: `SOCIAL_${body.op}`,
          reference: body.postId || body.accountId || body.handle || undefined,
        };
      }
      case TxType.ORACLE: {
        const body = decodeOracleBody(tx.body);
        const sources = body.observations.map((observation) => observation.source).join(', ');
        return { recipient: undefined, amount: undefined, kind: 'ORACLE', reference: body.submissionId, note: sources };
      }
      case TxType.VALIDATOR: {
        const body = decodeValidatorBody(tx.body);
        return {
          recipient: undefined,
          amount: body.bond > 0n ? body.bond.toString() : undefined,
          kind: `VALIDATOR_${body.op}`,
          reference: body.validatorKey.slice(0, 16),
        };
      }
      case TxType.TREASURY: {
        const body = decodeTreasuryBody(tx.body);
        return {
          recipient: body.to || undefined,
          amount: body.amount > 0n ? body.amount.toString() : undefined,
          kind: `TREASURY_${body.op}`,
          note: body.purpose,
        };
      }
      default:
        return {};
    }
  } catch {
    return {};
  }
}

function onsOpName(op: number): string {
  return ['REGISTER', 'UPDATE_ADDRESS', 'TRANSFER', 'RENEW'][op - 1] ?? `OP_${op}`;
}

function capsuleOpName(op: number): string {
  return ['CREATE', 'PREVIEW', 'CLAIM', 'OPEN'][op - 1] ?? `OP_${op}`;
}

function landOpName(op: number): string {
  return ['PROTOCOL_BUY', 'PROTOCOL_SELL', 'LIST', 'DELIST', 'BUY_LISTED', 'GIFT'][op - 1] ?? `OP_${op}`;
}

/**
 * Explorer privacy rule (spec §32): public pages show partial addresses only.
 * The full address is available through the wallet API, which the wallet calls
 * for the user's own account.
 */
export function maskAddress(address: string): string {
  if (address.length <= 14) return shortHash(address, 6);
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

export function serializeTransaction(record: TxIndexRecord): Record<string, unknown> {
  return {
    ...record,
    sender: maskAddress(record.sender),
    recipient: record.recipient ? maskAddress(record.recipient) : undefined,
  };
}

export function formatReward(seals: string): string {
  try {
    return formatObs(BigInt(seals));
  } catch {
    return seals;
  }
}
