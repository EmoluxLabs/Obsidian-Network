/**
 * Leader lease and fencing (server/lease.ts). Time is injected, so expiry, renewal, skew and pauses are exercised
 * exactly, not with sleeps.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FencingError, FileLeaseBackend, LeaderElector, LeaseUnavailableError, type LeaseBackend, type LeaseRecord } from '../server/lease.js';
import { AccountStore } from '../server/store.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'obs-lease-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** One host's clocks. `wall` may be skewed against other hosts; `mono` only ever moves with real elapsed time. */
function clocks(skew = 0) {
  const state = { t: 1_000_000 };
  return { state, now: () => state.t + skew, mono: () => state.t };
}
const TTL = 10_000;
const SKEW = 1_000;
const elector = (backend: LeaseBackend, name: string, c: ReturnType<typeof clocks>, extra: Partial<ConstructorParameters<typeof LeaderElector>[0]> = {}) =>
  new LeaderElector({ backend, holder: name, ttlMs: TTL, maxSkewMs: SKEW, now: c.now, mono: c.mono, ...extra });

describe('lease: election', () => {
  it('the first host takes the lease with token 1; the second stays standby', () => {
    const backend = new FileLeaseBackend(scratch());
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    b.tick();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    expect(a.status().token).toBe(1);
    expect(b.status().state).toBe('standby');
    expect(b.status().leader?.holder).toBe('a');
  });

  it('a leader that keeps renewing keeps the lease; a standby never steals a live one', () => {
    const backend = new FileLeaseBackend(scratch());
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    for (let i = 0; i < 40; i += 1) {
      c.state.t += 2_500;
      a.tick();
      b.tick();
      expect(a.isLeader()).toBe(true);
      expect(b.isLeader()).toBe(false);
    }
    expect(a.status().token).toBe(1);
  });

  it('takeover needs expiry PLUS the skew allowance, and bumps the fencing token', () => {
    const backend = new FileLeaseBackend(scratch());
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    c.state.t += TTL + SKEW - 1;
    b.tick();
    expect(b.isLeader()).toBe(false);
    c.state.t += 2;
    b.tick();
    expect(b.isLeader()).toBe(true);
    expect(b.status().token).toBe(2);
    expect(a.isLeader()).toBe(false); // its own conservative window ended long before
  });

  it('a clean stop releases the lease at once', () => {
    const backend = new FileLeaseBackend(scratch());
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    a.stop();
    c.state.t += SKEW + 1;
    b.tick();
    expect(b.isLeader()).toBe(true);
    expect(b.status().token).toBe(2);
  });

  it('the promotion hook runs outside the lease lock, so it can write through the guard (regression: it used to deadlock for the lock timeout)', () => {
    const data = scratch();
    const backend = new FileLeaseBackend(join(data, 'lease'), { lockTimeoutMs: 300 });
    const c = clocks();
    let store: AccountStore | undefined;
    const a = elector(backend, 'a', c, {
      onPromote: () => {
        store!.reload();
        store!.configureGenesisInvite('installed-on-promotion');
      },
    });
    store = new AccountStore({ dataDir: data, fence: a.guard });
    const started = Date.now();
    a.tick();
    expect(Date.now() - started).toBeLessThan(250);
    expect(a.isLeader()).toBe(true);
    expect(JSON.parse(readFileSync(join(data, 'interface-accounts.json'), 'utf8')).genesisInvite.hash).toBe('installed-on-promotion');
  });

  it('a promotion hook that throws demotes the host instead of leaving it leading on an unloaded store', () => {
    const backend = new FileLeaseBackend(scratch());
    const c = clocks();
    const a = elector(backend, 'a', c, {
      onPromote: () => {
        throw new Error('disk gone');
      },
    });
    a.tick();
    expect(a.isLeader()).toBe(false);
    expect(a.status().lastError).toMatch(/promotion failed/);
  });

  it('rejects a ttl that cannot be safe for the stated skew', () => {
    const backend = new FileLeaseBackend(scratch());
    expect(() => new LeaderElector({ backend, ttlMs: 4_000, maxSkewMs: 1_000 })).toThrow(/four times/);
  });
});

describe('lease: two hosts must never both act as leader', () => {
  it('holds over a sweep of clock skews and renewal failures (seeded)', () => {
    let seed = 20261012;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let run = 0; run < 60; run += 1) {
      const backend = new FileLeaseBackend(scratch());
      const skewA = Math.round((rand() * 2 - 1) * SKEW);
      const skewB = Math.round((rand() * 2 - 1) * SKEW);
      // Both hosts share real elapsed time, but their wall clocks disagree by up to the allowed skew each.
      const real = { t: 5_000_000 };
      const mk = (skew: number) => ({ now: () => real.t + skew, mono: () => real.t });
      const ca = mk(skewA);
      const cb = mk(skewB);
      const a = new LeaderElector({ backend, holder: 'a', ttlMs: TTL, maxSkewMs: SKEW, ...ca });
      const b = new LeaderElector({ backend, holder: 'b', ttlMs: TTL, maxSkewMs: SKEW, ...cb });
      let aDown = false;
      for (let step = 0; step < 400; step += 1) {
        real.t += 500 + Math.floor(rand() * 1500);
        if (rand() < 0.02) aDown = !aDown; // A's process freezes / partitions, then returns
        if (!aDown && rand() < 0.8) a.tick();
        if (rand() < 0.8) b.tick();
        // The only claim that matters: at every instant at most one host believes it may act.
        expect(a.isLeader() && b.isLeader()).toBe(false);
      }
    }
  });

  it('a paused leader that wakes up is fenced: its write is refused and the file is untouched', () => {
    const dir = scratch();
    const backend = new FileLeaseBackend(join(dir, 'lease'));
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    // Freeze A. Wall time passes for everyone else, and B takes over.
    c.state.t += TTL + SKEW + 10;
    b.tick();
    expect(b.isLeader()).toBe(true);
    // A wakes up believing the old monotonic window still holds (as after a VM suspend, which stops CLOCK_MONOTONIC).
    const stale = elector(backend, 'a', { ...c, mono: () => 1_000_000 });
    // Rebuild A's belief: it holds token 1 in memory.
    (stale as unknown as { token: number }).token = 1;
    (stale as unknown as { validUntilMono: number }).validUntilMono = 1_000_000 + TTL;
    expect(stale.isLeader()).toBe(true); // it BELIEVES it leads
    let wrote = false;
    expect(() => stale.guard.write(() => (wrote = true))).toThrow(FencingError);
    expect(wrote).toBe(false);
    expect(stale.isLeader()).toBe(false); // and learns it
    expect(() => stale.assertLeader()).toThrow(FencingError);
    // the real leader still writes
    let ok = false;
    b.guard.write(() => (ok = true));
    expect(ok).toBe(true);
  });

  it('a backend that fails does not extend the leader: it lapses on schedule and its writes are refused', () => {
    const real = new FileLeaseBackend(scratch());
    let broken = false;
    const flaky: LeaseBackend = {
      read: () => {
        if (broken) throw new LeaseUnavailableError('down');
        return real.read();
      },
      transact: (fn) => {
        if (broken) throw new LeaseUnavailableError('down');
        return real.transact(fn);
      },
    };
    const c = clocks();
    const a = elector(flaky, 'a', c);
    a.tick();
    broken = true;
    c.state.t += 1_000;
    a.tick();
    expect(a.status().lastError).toMatch(/down/);
    expect(a.isLeader()).toBe(true); // still inside the window it earned
    expect(() => a.guard.write(() => undefined)).toThrow(FencingError); // but it cannot prove the lease, so it cannot write
    c.state.t += TTL; // the window runs out without a renewal
    expect(a.isLeader()).toBe(false);
  });

  it('a damaged lease file is never read as "nobody holds it"', () => {
    const dir = scratch();
    const backend = new FileLeaseBackend(dir);
    const c = clocks();
    const a = elector(backend, 'a', c);
    a.tick();
    writeFileSync(join(dir, 'lease.json'), '{ not json');
    const b = elector(backend, 'b', c);
    c.state.t += TTL * 3;
    b.tick();
    expect(b.isLeader()).toBe(false);
    expect(b.status().lastError).toMatch(/unreadable/);
  });

  it('a lock left by a crashed process is broken, a fresh one is respected', () => {
    const dir = scratch();
    const backend = new FileLeaseBackend(dir, { lockTimeoutMs: 150, staleLockMs: 200 });
    mkdirSync(join(dir, 'lease.lock'));
    expect(() => backend.transact(() => 1)).toThrow(/timed out|waiting/);
    const old = new Date(Date.now() - 5_000);
    utimesSync(join(dir, 'lease.lock'), old, old);
    expect(backend.transact(() => 7)).toBe(7);
    expect(existsSync(join(dir, 'lease.lock'))).toBe(false);
  });
});

describe('lease: the account store is fenced', () => {
  const account = (store: AccountStore, email: string) =>
    // The public mutation surface that persists immediately.
    (store as unknown as { persist(): void; accounts: Map<string, unknown> }).persist.call(store);

  it('a deposed leader cannot write the shared file; the new leader sees the old leader\'s committed data and not the rejected one', () => {
    const data = scratch();
    const backend = new FileLeaseBackend(join(data, 'lease'));
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    const storeA = new AccountStore({ dataDir: data, fence: a.guard });
    storeA.configureGenesisInvite('hash-one');
    const file = join(data, 'interface-accounts.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).genesisInvite.hash).toBe('hash-one');

    // A is deposed while still believing otherwise.
    c.state.t += TTL + SKEW + 10;
    b.tick();
    const before = readFileSync(file, 'utf8');
    (a as unknown as { token: number }).token = 1;
    (a as unknown as { validUntilMono: number }).validUntilMono = c.state.t + TTL;
    expect(() => account(storeA, 'x')).toThrow(FencingError);
    storeA.configureGenesisInvite('hash-two-from-stale-leader'); // swallowed by persistIfLeader; must not reach disk
    expect(readFileSync(file, 'utf8')).toBe(before);

    const storeB = new AccountStore({ dataDir: data, fence: b.guard });
    expect(storeB.genesisInviteStatus().configured).toBe(true);
    expect(readdirSync(data).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('a standby that loads a corrupt shared file does not move it aside; the leader does', () => {
    const data = scratch();
    const backend = new FileLeaseBackend(join(data, 'lease'));
    const c = clocks();
    const a = elector(backend, 'a', c);
    const b = elector(backend, 'b', c);
    a.tick();
    writeFileSync(join(data, 'interface-accounts.json'), '{broken');
    new AccountStore({ dataDir: data, fence: b.guard }); // b is standby
    expect(existsSync(join(data, 'interface-accounts.json'))).toBe(true);
    new AccountStore({ dataDir: data, fence: a.guard });
    expect(existsSync(join(data, 'interface-accounts.json'))).toBe(false);
    expect(readdirSync(data).some((name) => name.startsWith('interface-accounts.json.corrupt-'))).toBe(true);
  });

  it('a deferred (debounced) flush after losing the lease is dropped, never thrown from a timer', async () => {
    const data = scratch();
    const backend = new FileLeaseBackend(join(data, 'lease'));
    const c = clocks();
    const a = elector(backend, 'a', c);
    a.tick();
    const store = new AccountStore({ dataDir: data, fence: a.guard });
    store.configureGenesisInvite('h');
    a.stop(); // lease gone
    (store as unknown as { persistSoon(): void }).persistSoon();
    expect(() => store.flush()).not.toThrow();
    expect((store as unknown as { dirty: boolean }).dirty).toBe(false);
  });
});
