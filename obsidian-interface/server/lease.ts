/**
 * Primary ownership for the account and gate services: a time-limited lease with fencing.
 *
 * WHAT THIS IS. Several interface hosts may be started as primary-capable. Exactly one of them holds the lease and
 * serves the stateful routes (accounts, sessions, wallet links, gate certificates, mining claims); the others are
 * STANDBYS that refuse those routes with a retryable 503 (they fail closed, they do not guess). When the leader dies or
 * is cut off, its lease runs out and a standby takes over, reloading the shared account store.
 *
 * WHAT MAKES IT SAFE.
 *  - A lease has a holder, a monotonically increasing FENCING TOKEN and an expiry.
 *  - Every durable write of the account store happens inside `guard.write`, which takes the lease lock and checks that
 *    the token is still current and unexpired BEFORE touching the file. A deposed leader's write is therefore rejected
 *    even if the leader does not know it was deposed (a paused process, a partition, a long GC): the check is made by
 *    the shared state, not by the writer's belief about itself.
 *  - A leader trusts its own leadership only for `ttl - 2*skew` of MONOTONIC time after the START of its last successful
 *    renewal; a follower takes over only after the lease's wall-clock expiry plus `skew`. For clocks that differ by up to
 *    `skew`, the old leader has stopped before the new one starts (the margin is at least 3*skew, and needs ttl > 4*skew).
 *  - If renewal fails (backend unreachable, lock timeout) the leader does NOT extend itself: it lapses on schedule.
 *
 * WHAT IT IS NOT. It is not a consensus system and not a database. The backend below is a POSIX directory with atomic
 * `mkdir` and `rename`, which is correct on one machine and on a shared block device with a real POSIX filesystem. It is
 * NOT safe on filesystems whose `mkdir`/`rename` are not atomic across hosts (some NFS configurations). Across independent
 * machines use a backend with real linearizable compare-and-set (etcd, Postgres advisory locks, a managed lock service):
 * implement `LeaseBackend`. Shipping that backend is infrastructure, not application code.
 * Gate certificates are verified by the CHAIN, which knows nothing about leases: a certificate issued just before a
 * takeover stays valid for up to 15 minutes. What the lease protects is the account state those certificates derive from.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

export interface LeaseRecord {
  holder: string;
  /** Where clients can reach the holder (public information only). */
  url?: string;
  /** Strictly increases every time leadership changes hands. */
  token: number;
  acquiredAt: number;
  renewedAt: number;
  /** Wall clock, milliseconds. */
  expiresAt: number;
}

export class FencingError extends Error {
  readonly code = 'ERR_NOT_LEADER';
  constructor(message: string) {
    super(message);
    this.name = 'FencingError';
  }
}

export class LeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LeaseUnavailableError';
  }
}

/** Atomic read-modify-write of the single lease record. Implementations must serialize `transact` across ALL hosts. */
export interface LeaseBackend {
  read(): LeaseRecord | undefined;
  transact<T>(fn: (current: LeaseRecord | undefined, commit: (next: LeaseRecord) => void) => T): T;
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

function writeDurable(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/** Lease in a directory. Lock = `mkdir` (atomic); a lock whose owner died is broken after `staleLockMs`. */
export class FileLeaseBackend implements LeaseBackend {
  private readonly file: string;
  private readonly lock: string;

  constructor(
    dir: string,
    private readonly options: { lockTimeoutMs?: number; staleLockMs?: number } = {},
  ) {
    this.file = join(dir, 'lease.json');
    this.lock = join(dir, 'lease.lock');
    mkdirSync(dir, { recursive: true });
  }

  read(): LeaseRecord | undefined {
    if (!existsSync(this.file)) return undefined;
    try {
      const record = JSON.parse(readFileSync(this.file, 'utf8')) as LeaseRecord;
      if (typeof record.holder !== 'string' || !Number.isSafeInteger(record.token) || !Number.isFinite(record.expiresAt)) throw new Error('shape');
      return record;
    } catch {
      // A damaged lease file must not be trusted as "nobody holds it" by a reader that then acts on that: surface it.
      throw new LeaseUnavailableError('the lease file is unreadable or damaged');
    }
  }

  private acquireLock(): void {
    const timeout = this.options.lockTimeoutMs ?? 2_000;
    const stale = this.options.staleLockMs ?? 10_000;
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        mkdirSync(this.lock);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new LeaseUnavailableError(`cannot take the lease lock: ${(error as Error).message}`);
      }
      try {
        // Critical sections are a few milliseconds. A lock far older than that belongs to a process that died inside it.
        if (Date.now() - statSync(this.lock).mtimeMs > stale) {
          rmSync(this.lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // released between our mkdir and our stat
      }
      if (Date.now() > deadline) throw new LeaseUnavailableError('timed out waiting for the lease lock');
      sleepSync(5 + Math.floor(Math.random() * 10));
    }
  }

  transact<T>(fn: (current: LeaseRecord | undefined, commit: (next: LeaseRecord) => void) => T): T {
    this.acquireLock();
    try {
      const current = this.read();
      return fn(current, (next) => writeDurable(this.file, `${JSON.stringify(next)}\n`));
    } finally {
      rmSync(this.lock, { recursive: true, force: true });
    }
  }
}

export interface ElectorOptions {
  backend: LeaseBackend;
  holder?: string;
  url?: string;
  ttlMs?: number;
  /** The largest clock difference between any two hosts that you are willing to be correct under. */
  maxSkewMs?: number;
  /** Test seams: wall clock (ms) and monotonic clock (ms). */
  now?: () => number;
  mono?: () => number;
  onPromote?: (token: number) => void;
  onDemote?: (reason: string) => void;
  log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

export type LeaderState = 'leader' | 'standby' | 'fenced';

export interface LeaderStatus {
  state: LeaderState;
  holder: string;
  token: number | null;
  /** Milliseconds of leadership this host still trusts (0 unless leader). */
  validForMs: number;
  /** The current leader as last observed (public fields only). */
  leader: { holder: string; url?: string; token: number; expiresInMs: number } | null;
  lastError: string | null;
}

export class LeaderElector {
  readonly holder: string;
  private readonly ttl: number;
  private readonly skew: number;
  private readonly now: () => number;
  private readonly mono: () => number;
  private token: number | undefined;
  private validUntilMono = 0;
  private observed: LeaseRecord | undefined;
  private lastError: string | null = null;
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly options: ElectorOptions) {
    this.holder = options.holder ?? `${process.pid}-${randomBytes(6).toString('hex')}`;
    this.ttl = options.ttlMs ?? 15_000;
    this.skew = options.maxSkewMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.mono = options.mono ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    if (this.ttl <= 4 * this.skew) throw new Error(`the lease ttl (${this.ttl} ms) must exceed four times the allowed clock skew (${this.skew} ms)`);
  }

  /** True only while this host's own, conservative view of its lease has not run out. */
  isLeader(): boolean {
    if (this.token === undefined) return false;
    if (this.mono() >= this.validUntilMono) {
      this.demote('lease lapsed (not renewed in time)');
      return false;
    }
    return true;
  }

  private demote(reason: string): void {
    if (this.token === undefined) return;
    this.token = undefined;
    this.validUntilMono = 0;
    this.options.log?.('warn', 'lost leadership', { reason, holder: this.holder });
    this.options.onDemote?.(reason);
  }

  /** One election round: renew if ours, take over if free or expired, otherwise observe. Never throws. */
  tick(): void {
    const startedMono = this.mono();
    let promotedToken: number | undefined;
    try {
      this.options.backend.transact((current, commit) => {
        const wall = this.now();
        this.observed = current;
        if (current && current.holder === this.holder && this.token !== undefined && current.token === this.token) {
          commit({ ...current, url: this.options.url ?? current.url, renewedAt: wall, expiresAt: wall + this.ttl });
          this.validUntilMono = startedMono + this.ttl - 2 * this.skew;
          return;
        }
        if (this.token !== undefined) this.demote(`the lease is now held by ${current?.holder ?? 'nobody'} (token ${current?.token ?? '-'})`);
        if (!current || wall > current.expiresAt + this.skew) {
          const next: LeaseRecord = { holder: this.holder, url: this.options.url, token: (current?.token ?? 0) + 1, acquiredAt: wall, renewedAt: wall, expiresAt: wall + this.ttl };
          commit(next);
          this.observed = next;
          this.token = next.token;
          this.validUntilMono = startedMono + this.ttl - 2 * this.skew;
          this.options.log?.('info', 'took leadership', { holder: this.holder, token: next.token });
          promotedToken = next.token;
        }
      });
      this.lastError = null;
    } catch (error) {
      // Could not talk to the shared state. Do NOT extend: if we were leader we lapse on schedule.
      this.lastError = (error as Error).message;
    }
    // Outside the lease lock: the promotion hook writes through `guard`, which takes the same (non-reentrant) lock.
    if (promotedToken !== undefined && this.token === promotedToken) {
      try {
        this.options.onPromote?.(promotedToken);
      } catch (error) {
        // Leading on a store that could not be loaded would be worse than not leading.
        this.lastError = `promotion failed: ${(error as Error).message}`;
        this.demote('the promotion hook failed');
      }
    }
  }

  /** Gate/issuance precondition: leader by our own clock AND the shared record still names us, unexpired. */
  assertLeader(): void {
    if (!this.isLeader()) throw new FencingError('this host is not the leader');
    let record: LeaseRecord | undefined;
    try {
      record = this.options.backend.read();
    } catch {
      throw new FencingError('the lease cannot be read: refusing to act as leader');
    }
    if (!record || record.holder !== this.holder || record.token !== this.token || this.now() > record.expiresAt) {
      this.demote('the shared lease no longer names this host');
      throw new FencingError('the lease no longer names this host');
    }
  }

  /** The guard handed to the account store: every durable write runs inside the lease lock, after the token check. */
  readonly guard = {
    write: (fn: () => void): void => {
      if (!this.isLeader()) throw new FencingError('write refused: this host is not the leader');
      try {
        this.options.backend.transact((current) => {
          if (!current || current.holder !== this.holder || current.token !== this.token || this.now() > current.expiresAt) {
            throw new FencingError('write refused: the lease no longer names this host (stale token)');
          }
          fn();
        });
      } catch (error) {
        if (error instanceof FencingError) this.demote('a write was fenced off');
        else if (error instanceof LeaseUnavailableError) throw new FencingError(`write refused: ${error.message}`);
        throw error;
      }
    },
  };

  status(): LeaderStatus {
    const leader = this.isLeader();
    const observed = this.observed;
    return {
      state: leader ? 'leader' : this.lastError && !observed ? 'fenced' : 'standby',
      holder: this.holder,
      token: leader ? (this.token ?? null) : null,
      validForMs: leader ? Math.max(0, this.validUntilMono - this.mono()) : 0,
      leader: observed ? { holder: observed.holder, url: observed.url, token: observed.token, expiresInMs: observed.expiresAt - this.now() } : null,
      lastError: this.lastError,
    };
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.tick();
    const every = Math.max(250, Math.floor(this.ttl / 4));
    this.timer = setInterval(() => this.tick(), every);
    this.timer.unref?.();
  }

  /** Give the lease up on a clean stop so a standby does not wait out the ttl. Best effort; expiry covers a crash. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const token = this.token;
    if (token === undefined) return;
    try {
      this.options.backend.transact((current, commit) => {
        if (current && current.holder === this.holder && current.token === token) commit({ ...current, expiresAt: 0, renewedAt: this.now() });
      });
    } catch {
      /* expiry will release it */
    }
    this.demote('stopped');
  }
}
