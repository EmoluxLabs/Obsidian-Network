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
    if (this.buckets.size > this.maxKeys) this.enforceKeyLimit();
    return allowed;
  }

  /**
   * Keep the map to `maxKeys` entries, whatever the traffic looks like.
   *
   * `sweep()` alone is not a bound. It only forgets buckets that have refilled
   * completely, and under a flood of new client addresses none of them have:
   * every new key survives the sweep, so the map grows with every address an
   * attacker can present, and every call past the limit then pays an O(n)
   * sweep over it. Sweep first (it is cheap when it works), then drop the
   * least-recently-inserted entries until the map is within the limit again.
   * Shedding the oldest budget means a very busy deployment throttles a little
   * early instead of running out of memory, which is the right way round.
   */
  private enforceKeyLimit(): void {
    this.sweep();
    let excess = this.buckets.size - this.maxKeys;
    if (excess <= 0) return;
    for (const key of this.buckets.keys()) {
      this.buckets.delete(key);
      excess -= 1;
      if (excess <= 0) return;
    }
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
