/**
 * An unreachable peer is retried with a growing delay that is capped and jittered.
 *
 * Capped, because a peer that was down for an hour must be found again within minutes of coming back, not an hour
 * later. Jittered, because nodes restarted together (a power cut, an upgrade, a shared link coming back) would otherwise
 * all retry on the same tick, every time. Misbehaviour is a different matter and keeps its full ban window.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handshakeRetryDelayMs, PeerStore, RETRY_CAP_MS, RETRY_JITTER } from '../../src/networking/peer-store.js';

function store(random: () => number, maxPeers?: number): { peers: PeerStore; clock: { now: number } } {
  const clock = { now: 5_000_000 };
  const peers = new PeerStore({ dataDir: mkdtempSync(join(tmpdir(), 'obs-jitter-')), seeds: [], persist: false, allowLocalAddresses: true, now: () => clock.now, random, maxPeers });
  return { peers, clock };
}

describe('retry delay for an unreachable peer', () => {
  it('doubles from 15 s and never exceeds the cap, however many times it has failed', () => {
    const { peers, clock } = store(() => 0.5); // the middle of the jitter range: exactly the nominal delay
    const record = peers.addSeed('198.51.100.20:38631');
    const seen: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      peers.recordFailure(record.address, 'handshake');
      seen.push(peers.get(record.address)!.bannedUntil - clock.now);
    }
    expect(seen.slice(0, 5)).toEqual([15_000, 30_000, 60_000, 120_000, 240_000]);
    expect(Math.max(...seen)).toBe(RETRY_CAP_MS);
    expect(RETRY_CAP_MS).toBe(5 * 60_000);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it('spreads the delay by ±20 %, at both ends of the random source', () => {
    for (const [random, factor] of [[() => 0, 1 - RETRY_JITTER], [() => 0.999999, 1 + RETRY_JITTER * 0.999998]] as const) {
      const { peers, clock } = store(random);
      const record = peers.addSeed('198.51.100.21:38631');
      peers.recordFailure(record.address, 'handshake');
      expect(peers.get(record.address)!.bannedUntil - clock.now).toBeCloseTo(15_000 * factor, -1);
    }
    expect(RETRY_JITTER).toBe(0.2);
  });

  it('gives different peers different delays: nodes restarted together do not retry on the same tick', () => {
    let n = 0;
    const { peers, clock } = store(() => ((n += 1) * 0.37) % 1);
    const delays = new Set<number>();
    for (let i = 0; i < 12; i += 1) {
      const record = peers.addSeed(`198.51.100.${30 + i}:38631`);
      peers.recordFailure(record.address, 'handshake');
      delays.add(peers.get(record.address)!.bannedUntil - clock.now);
    }
    expect(delays.size).toBeGreaterThan(6);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(15_000 * (1 - RETRY_JITTER) - 1);
      expect(delay).toBeLessThanOrEqual(15_000 * (1 + RETRY_JITTER) + 1);
    }
  });

  it('a hostile random source cannot push the delay outside its bounds', () => {
    for (const bad of [Number.NaN, -5, 7, Number.POSITIVE_INFINITY]) {
      const { peers, clock } = store(() => bad);
      const record = peers.addSeed('198.51.100.22:38631');
      peers.recordFailure(record.address, 'handshake');
      const delay = peers.get(record.address)!.bannedUntil - clock.now;
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(15_000 * (1 - RETRY_JITTER) - 1);
      expect(delay).toBeLessThanOrEqual(15_000 * (1 + RETRY_JITTER) + 1);
    }
  });

  it('misbehaviour keeps the one-hour ban: only unreachability got the short cap', () => {
    const { peers, clock } = store(() => 0.5);
    const record = peers.addSeed('198.51.100.23:38631');
    for (let i = 0; i < 6; i += 1) peers.recordFailure(record.address, 'invalid-block');
    expect(peers.get(record.address)!.bannedUntil - clock.now).toBe(60 * 60 * 1000);
  });

  it('keeps the shared delay function unchanged', () => {
    expect(handshakeRetryDelayMs(1, 3_600_000)).toBe(15_000);
    expect(handshakeRetryDelayMs(9, 3_600_000)).toBe(3_600_000);
  });
});

describe('the address book', () => {
  it('stays within its limit however many addresses are gossiped', () => {
    const { peers } = store(() => 0.5, 20);
    const entries = Array.from({ length: 500 }, (_, i) => ({ host: `198.51.100.${(i % 200) + 1}`, port: 10_000 + i }));
    peers.addGossiped(entries);
    peers.addGossiped(entries);
    expect(peers.all().length).toBeLessThanOrEqual(20);
  });

  it('does not accept loopback or link-local hints on a public network, and can forget an address', () => {
    const clock = { now: 1 };
    const peers = new PeerStore({ dataDir: mkdtempSync(join(tmpdir(), 'obs-forget-')), seeds: [], persist: false, allowLocalAddresses: false, now: () => clock.now });
    expect(peers.addGossiped([{ host: '127.0.0.1', port: 8631 }, { host: '169.254.1.1', port: 8631 }, { host: '0.0.0.0', port: 8631 }, { host: '198.51.100.9', port: 8631 }])).toBe(1);
    expect(peers.forget('198.51.100.9:8631')).toBe(true);
    expect(peers.forget('198.51.100.9:8631')).toBe(false);
    expect(peers.all()).toHaveLength(0);
  });
});
