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

/** Extract the display-relevant fields of a transaction, without trusting them. */
function describeTx(tx: TxEnvelope): Partial<TxIndexRecord> {
  try {
    switch (tx.type) {
      case TxType.PAYMENT: {
        return { recipient: undefined, amount: undefined };
      }
      default:
        return {};
    }
  } catch {
    return {};
  }
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
