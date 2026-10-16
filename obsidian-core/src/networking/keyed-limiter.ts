/**
 * Per-client token buckets and the address a client is budgeted as.
 *
 * THIS FILE EXISTS IN TWO PACKAGES — obsidian-core/src/networking/ and obsidian-interface/server/ — and the two
 * copies must be identical: tests/scripts/repo-consistency.test.mjs fails if they differ. Change one and copy it
 * to the other.
 *
 * Anything a stranger can call for free is budgeted per client, and a budget is only worth something if the
 * client cannot trade it in for a new one. Two ways to do that are closed here: an IPv6 client rotating inside the
 * block it was given (see `clientBucket`), and a client that makes the table itself the weapon, by arriving as
 * many fresh keys as it can (the table is bounded and the work per request is constant: see `shrink`).
 *
 * Time is injected so the behaviour is deterministic under test.
 */

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * The bucket a client address is held to. An IPv4 address is its own bucket. An IPv6 address is NOT: a single
 * subscriber is routinely handed a whole /64 (and often a /56 or /48), which is 2^64 addresses, so keying on the
 * full address would give one attacker an unlimited supply of fresh budgets. IPv6 is therefore bucketed by its
 * /64, the smallest block an access network allocates to one customer; an IPv4-mapped address is the IPv4 address.
 */
export function clientBucket(address: string): string {
  const raw = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1]!;
  if (!raw.includes(':')) return raw;
  let head = raw;
  let tail = '';
  const gap = raw.indexOf('::');
  if (gap >= 0) {
    head = raw.slice(0, gap);
    tail = raw.slice(gap + 2);
  }
  const headGroups = head === '' ? [] : head.split(':');
  const tailGroups = tail === '' ? [] : tail.split(':');
  const missing = gap >= 0 ? Math.max(0, 8 - headGroups.length - tailGroups.length) : 0;
  const groups = [...headGroups, ...Array<string>(missing).fill('0'), ...tailGroups];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return raw;
  return `${groups.slice(0, 4).map((group) => group.padStart(4, '0')).join(':')}::/64`;
}

export class KeyedLimiter {
  /** Insertion order is least-recently-used first: a bucket is moved to the back each time it is touched. */
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 20_000,
  ) {}

  private refreshed(key: string, time: number): Bucket {
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: time };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + Math.max(0, (time - bucket.updatedAt) / 1000) * this.refillPerSecond);
    bucket.updatedAt = time;
    return bucket;
  }

  /** Spend `cost` tokens for `key`. Returns false (and spends nothing) when it has too few. */
  allow(key: string, cost = 1): boolean {
    const time = this.now();
    const bucket = this.refreshed(key, time);
    const allowed = bucket.tokens >= cost;
    if (allowed) bucket.tokens -= cost;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.shrink(time);
    return allowed;
  }

  /** Whether `key` could spend `cost` right now, without spending it. */
  available(key: string, cost = 1): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return this.capacity >= cost;
    return this.refreshed(key, this.now()).tokens >= cost;
  }

  /** Seconds until `key` could next spend `cost`. */
  retryAfterSeconds(key: string, cost = 1): number {
    const bucket = this.buckets.get(key);
    if (!bucket || this.refillPerSecond <= 0) return 1;
    const missing = Math.max(0, cost - bucket.tokens);
    return Math.max(1, Math.ceil(missing / this.refillPerSecond));
  }

  /**
   * Over the key bound. Forget the buckets that are full again (they carry no information), at most once a second
   * so that a flood of fresh keys cannot turn every request into a scan of the whole table; and if that was not
   * enough, drop the least recently used. Memory is therefore bounded no matter how many addresses a client can
   * reach, and the work per request is constant.
   */
  private shrink(time: number): void {
    if (time - this.lastSweep >= 1_000) {
      this.lastSweep = time;
      this.sweep();
    }
    while (this.buckets.size > this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
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
