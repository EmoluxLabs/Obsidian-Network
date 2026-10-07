/**
 * Token buckets for peer traffic.
 *
 * A peer on the wire is unauthenticated until proven otherwise and, even once
 * authenticated, free: it costs an attacker nothing to send a valid message a
 * million times. Every message a node accepts makes the node do work (parse,
 * verify a signature, re-validate a block), so the work a single peer can
 * demand per second has to be bounded by the receiver, not left to the sender's
 * good manners.
 *
 * Time is injected so the behaviour is deterministic under test.
 */

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  /** Try to spend `cost` tokens. Returns false (and spends nothing) when there are not enough. */
  take(cost = 1): boolean {
    const time = this.now();
    const elapsedSeconds = Math.max(0, (time - this.updatedAt) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.updatedAt = time;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Tokens currently available (for tests and diagnostics). */
  get available(): number {
    const elapsedSeconds = Math.max(0, (this.now() - this.updatedAt) / 1000);
    return Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
  }
}

/** The three budgets a link is held to; sized so honest traffic never notices them. */
export interface LinkBudgets {
  /** hello, ping, status, getaddr, addr, getblocks … */
  control: TokenBucket;
  /** One block validation costs a signature check plus a state transition. */
  block: TokenBucket;
  /** Gossiped transactions: a busy network relays hundreds per second. */
  tx: TokenBucket;
}

export function newLinkBudgets(now: () => number = () => Date.now()): LinkBudgets {
  return {
    control: new TokenBucket(40, 4, now),
    block: new TokenBucket(40, 4, now),
    tx: new TokenBucket(1_500, 400, now),
  };
}
