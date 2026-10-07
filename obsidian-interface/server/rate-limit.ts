/**
 * Per-client token buckets for the interface.
 *
 * The interface is the public face of a deployment, and several of its
 * endpoints cost real CPU on purpose (password hashing is slow so that a stolen
 * file is hard to crack). Slow-by-design plus unthrottled is a denial-of-service
 * switch, so every costly route is held to a budget per client address.
 *
 * Time is injected so the behaviour is deterministic under test.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class KeyedLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 20_000,
  ) {}

  /** Spend `cost` tokens for `key`. Returns false (and spends nothing) when it has too few. */
  allow(key: string, cost = 1): boolean {
    const time = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: time };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, (time - bucket.updatedAt) / 1000) * this.refillPerSecond);
    bucket.updatedAt = time;
    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.sweep();
    return allowed;
  }

  /** Seconds until `key` could next spend `cost`. */
  retryAfterSeconds(key: string, cost = 1): number {
    const bucket = this.buckets.get(key);
    if (!bucket || this.refillPerSecond <= 0) return 1;
    const missing = Math.max(0, cost - bucket.tokens);
    return Math.max(1, Math.ceil(missing / this.refillPerSecond));
  }

  /** Forget buckets that are full again: they carry no information. */
  sweep(): void {
    const time = this.now();
    for (const [key, bucket] of this.buckets) {
      const refilled = bucket.tokens + Math.max(0, (time - bucket.updatedAt) / 1000) * this.refillPerSecond;
      if (refilled >= this.capacity) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}
