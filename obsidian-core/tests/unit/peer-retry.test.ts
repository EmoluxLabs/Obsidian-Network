/**
 * Unit tests for peer retry behaviour (spec §96–§100: peer exchange, health
 * checks, scoring, stale-peer removal and failover).
 *
 * A refused TCP/WebSocket connection is a reachability fact, not evidence of
 * misbehaviour. Node operators start seeds after the nodes that depend on them,
 * so a single `ECONNREFUSED` at boot must never lock a node out of the network
 * for the full ban window. Dishonest peers (invalid blocks, malformed
 * messages) must still be banned.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { handshakeRetryDelayMs, PEER_SCORE, PeerStore } from '../../src/networking/peer-store.js';

function store(seeds: string[] = [], start = 1_000_000): { peers: PeerStore; clock: { now: number } } {
  const clock = { now: start };
  const peers = new PeerStore({
    dataDir: mkdtempSync(join(tmpdir(), 'obs-peers-')),
    seeds,
    persist: false,
    now: () => clock.now,
  });
  return { peers, clock };
}

describe('handshake retry backoff', () => {
  it('starts at fifteen seconds and doubles up to the ban window', () => {
    const cap = 3_600_000;
    expect(handshakeRetryDelayMs(1, cap)).toBe(15_000);
    expect(handshakeRetryDelayMs(2, cap)).toBe(30_000);
    expect(handshakeRetryDelayMs(3, cap)).toBe(60_000);
    expect(handshakeRetryDelayMs(4, cap)).toBe(120_000);
    expect(handshakeRetryDelayMs(9, cap)).toBe(cap);
    // Never returns NaN/Infinity for absurd counters, never below the base.
    expect(handshakeRetryDelayMs(0, cap)).toBe(15_000);
    expect(handshakeRetryDelayMs(Number.NaN, cap)).toBe(15_000);
    expect(handshakeRetryDelayMs(1_000, cap)).toBe(cap);
  });

  it('keeps an unreachable seed retryable instead of banning it for an hour', () => {
    const { peers, clock } = store(['127.0.0.1:39631']);
    const seed = peers.addSeed('127.0.0.1:39631');
    expect(peers.dialable().map((record) => record.address)).toContain('127.0.0.1:39631');

    // The seed is not listening yet: one refused connection.
    peers.recordFailure(seed.address, 'handshake');
    expect(peers.isBanned(seed.address)).toBe(true);

    // …but it is back in the dial set seconds later, not an hour later.
    clock.now += 15_000;
    expect(peers.isBanned(seed.address)).toBe(false);
    expect(peers.dialable().map((record) => record.address)).toContain('127.0.0.1:39631');

    // Repeated failures back off further, still bounded by the ban window.
    peers.recordFailure(seed.address, 'handshake');
    clock.now += 29_000;
    expect(peers.isBanned(seed.address)).toBe(true);
    clock.now += 2_000;
    expect(peers.isBanned(seed.address)).toBe(false);

    // The address survives the whole ordeal: a seed is never pruned.
    for (let attempt = 0; attempt < 20; attempt += 1) peers.recordFailure(seed.address, 'handshake');
    expect(peers.pruneStale()).toBe(0);
    expect(peers.all().some((record) => record.address === seed.address)).toBe(true);
  });

  it('floors the score of an unreachable peer instead of accumulating debt', () => {
    const { peers, clock } = store();
    const seed = peers.addSeed('10.0.0.9:8631');
    for (let attempt = 0; attempt < 30; attempt += 1) peers.recordFailure(seed.address, 'handshake');
    const stored = peers.all().find((record) => record.address === seed.address);
    expect(stored?.failureCount).toBe(30);
    expect(stored?.score).toBe(PEER_SCORE.banBelow);
    // Reachability problems must never look like dishonesty: the retry window
    // stays bounded by the ban window, and the address comes back.
    expect((stored?.bannedUntil ?? 0) - clock.now).toBeLessThanOrEqual(60 * 60 * 1000);
    clock.now += 60 * 60 * 1000;
    expect(peers.dialable().map((record) => record.address)).toContain('10.0.0.9:8631');
  });

  it('never prunes operator-configured addresses', () => {
    const { peers, clock } = store();
    const manual = peers.addManual('198.51.100.7:8631');
    for (let attempt = 0; attempt < 30; attempt += 1) peers.recordFailure(manual.address, 'handshake');
    clock.now += 7 * 24 * 60 * 60 * 1000;
    expect(peers.pruneStale()).toBe(0);
    expect(peers.all().map((record) => record.address)).toContain('198.51.100.7:8631');
  });

  it('forgets gossiped peers that never work', () => {
    const { peers, clock } = store();
    expect(peers.addGossiped([{ host: '203.0.113.99', port: 8631 }])).toBe(1);
    for (let attempt = 0; attempt < 6; attempt += 1) peers.recordFailure('203.0.113.99:8631', 'handshake');
    clock.now += 8 * 24 * 60 * 60 * 1000;
    expect(peers.pruneStale()).toBe(1);
    expect(peers.all().map((record) => record.address)).not.toContain('203.0.113.99:8631');
  });

  it('still bans peers that send malformed or invalid data', () => {
    const { peers } = store();
    const gossip = peers.addManual('198.51.100.7:8631');
    // Two malformed messages (-25 each) plus one invalid block (-40) put the
    // peer at -90: suspicious, not yet banned.
    peers.recordFailure(gossip.address, 'malformed');
    peers.recordFailure(gossip.address, 'malformed');
    peers.recordFailure(gossip.address, 'invalid-block');
    expect(peers.isBanned(gossip.address)).toBe(false);
    // One more invalid block crosses the threshold: a full ban window.
    peers.recordFailure(gossip.address, 'invalid-block');
    expect(peers.isBanned(gossip.address)).toBe(true);
    expect(peers.dialable().map((record) => record.address)).not.toContain(gossip.address);
  });

  it('clears the retry counter after a successful handshake', () => {
    const { peers, clock } = store();
    const seed = peers.addSeed('203.0.113.5:8631');
    peers.recordFailure(seed.address, 'handshake');
    peers.recordFailure(seed.address, 'handshake');
    peers.recordSuccess(seed.address, { nodeId: 'a'.repeat(40), height: 12 });
    const stored = peers.all().find((record) => record.address === seed.address);
    expect(stored?.failureCount).toBe(0);
    expect(stored?.successCount).toBe(1);
    expect(stored?.height).toBe(12);
    expect(peers.isBanned(seed.address)).toBe(false);
    clock.now += 1_000;
    expect(peers.healthy().map((record) => record.address)).toContain('203.0.113.5:8631');
  });
});
