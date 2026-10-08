/**
 * Transaction pool.
 *
 * The mempool is a *hint*, never a source of truth: a transaction exists only
 * once a block includes it. Admission is therefore cheap and conservative, and
 * full validation happens when a block is built or received.
 *
 * Properties that matter for anti-abuse:
 *   - per-sender cap so one account cannot flood the pool;
 *   - global byte cap with lowest-fee eviction;
 *   - deterministic ordering (gas desc, then tx id) so any node building a block
 *     from the same pool produces the same transaction order;
 *   - nonce ordering per sender: only the next executable nonce is offered to
 *     the block builder.
 */

import { TxType, type TxEnvelope } from '../protocol/types.js';
import { encodeSignedTx } from '../transactions/encode.js';
import { slashEvidenceBytes } from '../transactions/executors/slash.js';

export interface MempoolEntry {
  tx: TxEnvelope;
  bytes: number;
  receivedAt: number;
  /** Monotonic local sequence, used only as a tie-break inside one node. */
  seq: number;
}

/**
 * Equivocation evidence is a resource class of its own.
 *
 * A SLASH transaction is free to submit (gas 0), costs the node public-key work
 * to verify, and is the one transaction type a peer can produce in unlimited
 * variety from unlimited addresses. The generic pool limits — count, bytes,
 * per-sender — do not cover it: 10,000 evidence transactions from 10,000 fresh
 * addresses fit inside them, and every one would be re-examined by every
 * producer, every slot. So evidence gets its own ceiling on how many may be
 * pending at once, how many one sender may hold, and how many bytes the class
 * may occupy — checked BEFORE the generic eviction path, so a flood of reports
 * can never push honest transactions out of the pool to make room for itself.
 */
export interface MempoolOptions {
  maxTransactions: number;
  maxBytes: number;
  maxPerSender: number;
  /** Equivocation reports pending at once, across all senders. */
  maxPendingEvidence: number;
  /** Equivocation reports pending from one sender. */
  maxEvidencePerSender: number;
  /** Total canonical evidence bytes the pool will hold. */
  maxEvidenceBytes: number;
}

export const DEFAULT_MEMPOOL_OPTIONS: MempoolOptions = {
  maxPendingEvidence: 256,
  maxEvidencePerSender: 8,
  maxEvidenceBytes: 4 * 1024 * 1024,
  maxTransactions: 10_000,
  maxBytes: 32 * 1024 * 1024,
  maxPerSender: 64,
};

export class Mempool {
  private readonly byId = new Map<string, MempoolEntry>();
  private readonly bySender = new Map<string, Set<string>>();
  private bytes = 0;
  private sequence = 0;
  /** Evidence accounting, kept alongside the generic counters. */
  private evidenceCount = 0;
  private evidenceBytes = 0;
  private readonly evidencePerSender = new Map<string, number>();

  constructor(private readonly options: MempoolOptions = DEFAULT_MEMPOOL_OPTIONS) {}

  get size(): number {
    return this.byId.size;
  }

  get byteSize(): number {
    return this.bytes;
  }

  add(tx: TxEnvelope, receivedAt = Date.now()): { accepted: boolean; reason?: string } {
    if (this.byId.has(tx.id)) return { accepted: false, reason: 'already in the pool' };
    const bytes = encodeSignedTx(tx).length;
    const senderSet = this.bySender.get(tx.sender) ?? new Set<string>();
    if (senderSet.size >= this.options.maxPerSender) {
      return { accepted: false, reason: `sender pool quota (${this.options.maxPerSender}) reached` };
    }
    if (bytes > this.options.maxBytes) return { accepted: false, reason: 'transaction exceeds mempool byte budget' };
    // Evidence first, and ahead of eviction: a report may not displace an honest
    // transaction to get in, and a flood may not fill the pool with reports.
    const evidenceSize = tx.type === TxType.SLASH ? slashEvidenceBytes(tx.body) : null;
    if (evidenceSize !== null) {
      const perSender = this.evidencePerSender.get(tx.sender) ?? 0;
      if (this.evidenceCount >= this.options.maxPendingEvidence) {
        return { accepted: false, reason: `pending equivocation evidence quota (${this.options.maxPendingEvidence}) reached` };
      }
      if (perSender >= this.options.maxEvidencePerSender) {
        return { accepted: false, reason: `sender equivocation evidence quota (${this.options.maxEvidencePerSender}) reached` };
      }
      if (this.evidenceBytes + evidenceSize > this.options.maxEvidenceBytes) {
        return { accepted: false, reason: 'equivocation evidence byte budget exhausted' };
      }
      this.evidenceCount += 1;
      this.evidenceBytes += evidenceSize;
      this.evidencePerSender.set(tx.sender, perSender + 1);
    }
    if (this.byId.size >= this.options.maxTransactions || this.bytes + bytes > this.options.maxBytes) {
      if (!this.evictFor(bytes, tx.gas)) {
        return {
          accepted: false,
          reason: this.byId.size >= this.options.maxTransactions ? 'mempool is full' : 'mempool byte budget exhausted',
        };
      }
    }
    this.sequence += 1;
    const entry: MempoolEntry = { tx, bytes, receivedAt, seq: this.sequence };
    this.byId.set(tx.id, entry);
    senderSet.add(tx.id);
    this.bySender.set(tx.sender, senderSet);
    this.bytes += bytes;
    return { accepted: true };
  }

  get(txId: string): MempoolEntry | undefined {
    return this.byId.get(txId);
  }

  /**
   * The pooled transaction, if any, that already uses this sender's `nonce`.
   * Only one transaction per (sender, nonce) can ever be mined; a second one
   * used to be pooled anyway and then vanished once the first was included,
   * which is exactly what a double-clicked "Send" looked like to the user.
   */
  findBySenderNonce(sender: string, nonce: number): MempoolEntry | undefined {
    for (const txId of this.bySender.get(sender) ?? []) {
      const entry = this.byId.get(txId);
      if (entry && entry.tx.nonce === nonce) return entry;
    }
    return undefined;
  }

  has(txId: string): boolean {
    return this.byId.has(txId);
  }

  remove(txId: string): void {
    const entry = this.byId.get(txId);
    if (!entry) return;
    this.byId.delete(txId);
    this.bytes -= entry.bytes;
    // Release the evidence reservation with the transaction, or the class would
    // slowly fill up with reports that are no longer here.
    const released = slashEvidenceBytes(entry.tx.body);
    if (entry.tx.type === TxType.SLASH && released !== null) {
      this.evidenceCount = Math.max(0, this.evidenceCount - 1);
      this.evidenceBytes = Math.max(0, this.evidenceBytes - released);
      const perSender = this.evidencePerSender.get(entry.tx.sender) ?? 0;
      if (perSender <= 1) this.evidencePerSender.delete(entry.tx.sender);
      else this.evidencePerSender.set(entry.tx.sender, perSender - 1);
    }
    const senderSet = this.bySender.get(entry.tx.sender);
    senderSet?.delete(txId);
    if (senderSet && senderSet.size === 0) this.bySender.delete(entry.tx.sender);
  }

  /** Remove transactions that a block has already included. */
  removeMany(txIds: string[]): void {
    for (const txId of txIds) this.remove(txId);
  }

  /** Drop transactions that have expired at `protocolTime`. */
  pruneExpired(protocolTime: number): number {
    let removed = 0;
    for (const [txId, entry] of [...this.byId.entries()]) {
      if (entry.tx.validUntil < protocolTime) {
        this.remove(txId);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Deterministic candidate ordering for block building. Transactions are
   * selected in (gas desc, tx id asc) order, filtered by nonce sequencing so a
   * block never contains a gap in a sender's nonce chain.
   */
  selectForBlock(limit: number, startingNonces: Map<string, number>): TxEnvelope[] {
    const ordered = [...this.byId.values()].sort((a, b) => {
      if (a.tx.gas !== b.tx.gas) return a.tx.gas > b.tx.gas ? -1 : 1;
      if (a.tx.id === b.tx.id) return 0;
      return a.tx.id < b.tx.id ? -1 : 1;
    });
    const nextNonce = new Map(startingNonces);
    const out: TxEnvelope[] = [];
    for (const entry of ordered) {
      if (out.length >= limit) break;
      const expected = nextNonce.get(entry.tx.sender) ?? 0;
      if (entry.tx.nonce !== expected) continue;
      out.push(entry.tx);
      nextNonce.set(entry.tx.sender, expected + 1);
    }
    return out;
  }

  /** Sender-nonce map derived from current state, for selectForBlock(). */
  static nonceMapFrom(state: { s: { accounts: Map<string, { nonce: number }> } }): Map<string, number> {
    const map = new Map<string, number>();
    for (const [address, account] of state.s.accounts) map.set(address, account.nonce);
    return map;
  }

  private evictFor(bytes: number, incomingGas: bigint): boolean {
    // A new transaction may evict only transactions with STRICTLY lower gas.
    // The previous implementation evicted first and compared nothing, so a
    // zero-gas Sybil transaction could displace a paid transaction from a full
    // pool. Equal-gas entries are first-seen-wins; arrival timing never becomes
    // an implicit replacement policy.
    const ordered = [...this.byId.values()]
      .filter((entry) => entry.tx.gas < incomingGas)
      .sort((a, b) => {
        if (a.tx.gas !== b.tx.gas) return a.tx.gas < b.tx.gas ? -1 : 1;
        return a.seq - b.seq;
      });
    let projectedBytes = this.bytes;
    let projectedCount = this.byId.size;
    const evictions: MempoolEntry[] = [];
    for (const entry of ordered) {
      projectedBytes -= entry.bytes;
      projectedCount -= 1;
      evictions.push(entry);
      if (projectedBytes + bytes <= this.options.maxBytes && projectedCount < this.options.maxTransactions) break;
    }
    // Plan first, mutate second. An oversized/high-gas arrival that still cannot
    // fit must not destroy lower-priority entries before being rejected itself.
    if (projectedBytes + bytes > this.options.maxBytes || projectedCount >= this.options.maxTransactions) return false;
    for (const entry of evictions) this.remove(entry.tx.id);
    return true;
  }

  snapshot(): Array<{ txId: string; sender: string; type: number; gas: string; receivedAt: number }> {
    return [...this.byId.values()].map((entry) => ({
      txId: entry.tx.id,
      sender: entry.tx.sender,
      type: entry.tx.type,
      gas: entry.tx.gas.toString(),
      receivedAt: entry.receivedAt,
    }));
  }
}
