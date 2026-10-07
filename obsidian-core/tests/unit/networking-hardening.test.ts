/**
 * Peer-facing hardening: token buckets, gossip address validation and the
 * penalty kinds. Everything here is deterministic (time is injected).
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TokenBucket, newLinkBudgets } from '../../src/networking/rate-limit.js';
import { PEER_SCORE, PeerStore, isDialableHost } from '../../src/networking/peer-store.js';
import { isLoopback, normaliseIp, verifyNodeDescriptor, signNodeDescriptor } from '../../src/networking/p2p.js';
import { generateKeyPair, addressFromPublicKey } from '../../src/crypto/keys.js';
import { getNetwork } from '../../src/protocol/networks.js';

function store(options: { allowLocalAddresses?: boolean } = {}): PeerStore {
  return new PeerStore({
    dataDir: mkdtempSync(join(tmpdir(), 'obs-peers-')),
    seeds: [],
    persist: false,
    ...options,
  });
}

describe('token bucket', () => {
  it('allows a burst up to capacity, then refuses until time has refilled it', () => {
    const clock = { now: 0 };
    const bucket = new TokenBucket(5, 2, () => clock.now);
    for (let i = 0; i < 5; i += 1) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    clock.now += 500; // half a second at 2/s = 1 token
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  it('never refills past capacity and never goes negative on a refusal', () => {
    const clock = { now: 0 };
    const bucket = new TokenBucket(3, 100, () => clock.now);
    clock.now += 60_000;
    expect(bucket.available).toBe(3);
    expect(bucket.take(4)).toBe(false); // costs more than the bucket can hold
    expect(bucket.available).toBe(3); // and a refusal spends nothing
  });

  it('charges big messages more', () => {
    const clock = { now: 0 };
    const bucket = new TokenBucket(10, 0, () => clock.now);
    expect(bucket.take(8)).toBe(true);
    expect(bucket.take(8)).toBe(false);
    expect(bucket.take(2)).toBe(true);
  });

  it('gives each link three independent budgets sized for honest traffic', () => {
    const budgets = newLinkBudgets(() => 0);
    // A busy network relays hundreds of transactions a second...
    for (let i = 0; i < 1_000; i += 1) expect(budgets.tx.take()).toBe(true);
    // ...which must not starve control traffic or block validation.
    expect(budgets.control.take()).toBe(true);
    expect(budgets.block.take()).toBe(true);
    // But a flood of control messages runs dry quickly.
    let allowed = 0;
    for (let i = 0; i < 1_000; i += 1) if (budgets.control.take()) allowed += 1;
    expect(allowed).toBeLessThan(60);
  });
});

describe('peer addresses learned from strangers', () => {
  it('refuses what can never be a remote peer, and keeps what can', () => {
    expect(isDialableHost('203.0.113.9', false)).toBe(true);
    expect(isDialableHost('seed1.example.org', false)).toBe(true);
    expect(isDialableHost('10.1.2.3', false)).toBe(true); // private LANs are legitimate on test networks
    expect(isDialableHost('0.0.0.0', true)).toBe(false);
    expect(isDialableHost('::', true)).toBe(false);
    expect(isDialableHost('224.0.0.1', true)).toBe(false);
    expect(isDialableHost('evil host/../x', true)).toBe(false);
    expect(isDialableHost('', true)).toBe(false);
    expect(isDialableHost('a'.repeat(300), true)).toBe(false);
    // Loopback and link-local only where every node lives on one machine.
    expect(isDialableHost('127.0.0.1', false)).toBe(false);
    expect(isDialableHost('localhost', false)).toBe(false);
    expect(isDialableHost('169.254.169.254', false)).toBe(false);
    expect(isDialableHost('127.0.0.1', true)).toBe(true);
  });

  it('applies those rules, and the port range, when merging gossip', () => {
    const strict = store({ allowLocalAddresses: false });
    const added = strict.addGossiped([
      { host: '203.0.113.9', port: 8631 },
      { host: '127.0.0.1', port: 8631 },
      { host: '0.0.0.0', port: 8631 },
      { host: '203.0.113.10', port: 0 },
      { host: '203.0.113.11', port: 99_999 },
      { host: '203.0.113.12', port: 1.5 },
      { host: 'not a host', port: 8631 },
      { host: 42 as unknown as string, port: 8631 },
    ]);
    expect(added).toBe(1);
    expect(strict.all().map((record) => record.address)).toEqual(['203.0.113.9:8631']);

    const dev = store({ allowLocalAddresses: true });
    expect(dev.addGossiped([{ host: '127.0.0.1', port: 38631 }])).toBe(1);
  });

  it('scores a bad transaction or a clock-skew slip far more gently than a bad block', () => {
    expect(PEER_SCORE.invalidTxPenalty).toBeGreaterThan(PEER_SCORE.malformedPenalty);
    expect(PEER_SCORE.minorPenalty).toBeGreaterThan(PEER_SCORE.invalidBlockPenalty);
    const peers = store();
    const record = peers.addManual('203.0.113.9:8631');
    peers.recordFailure(record.address, 'invalid-tx');
    expect(peers.get(record.address)!.score).toBe(PEER_SCORE.invalidTxPenalty);
    peers.recordFailure(record.address, 'minor');
    expect(peers.get(record.address)!.score).toBe(PEER_SCORE.invalidTxPenalty + PEER_SCORE.minorPenalty);
  });
});

describe('addresses on the wire', () => {
  it('treats ::ffff:a.b.c.d as a.b.c.d and recognises loopback in every spelling', () => {
    expect(normaliseIp('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(normaliseIp('203.0.113.9')).toBe('203.0.113.9');
    expect(normaliseIp('2001:db8::1')).toBe('2001:db8::1');
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('203.0.113.9')).toBe(false);
  });
});

describe('signed node descriptors (the discovery list must be unforgeable)', () => {
  const net = getNetwork('devnet');
  function descriptorFor(keys: ReturnType<typeof generateKeyPair>, timestamp = Math.floor(Date.now() / 1000)) {
    return {
      nodeId: 'ab'.repeat(20),
      identity: addressFromPublicKey(keys.publicKey, net.addressHrp),
      publicKey: keys.publicKey,
      networkId: net.networkId,
      chainId: net.chainId,
      genesisId: 'cd'.repeat(20),
      protocolVersion: '1.3.0',
      version: '1.3.0',
      endpoints: { p2p: '203.0.113.9:38631', rpc: 'http://203.0.113.9:38630' },
      height: 10,
      headHash: 'ef'.repeat(32),
      capabilities: ['sync', 'gossip', 'rpc'],
      timestamp,
    };
  }

  it('verifies a genuine descriptor — a compressed secp256k1 key is 66 hex characters, not 64', () => {
    const keys = generateKeyPair(net.addressHrp);
    expect(keys.publicKey).toHaveLength(66);
    const descriptor = descriptorFor(keys);
    const signature = signNodeDescriptor({ address: descriptor.identity, publicKey: keys.publicKey, privateKey: keys.privateKey }, descriptor);
    expect(verifyNodeDescriptor(descriptor, signature, net)).toEqual({ ok: true });
  });

  it('rejects a tampered field, a foreign signer, a stale timestamp and the wrong network', () => {
    const keys = generateKeyPair(net.addressHrp);
    const descriptor = descriptorFor(keys);
    const signature = signNodeDescriptor({ address: descriptor.identity, publicKey: keys.publicKey, privateKey: keys.privateKey }, descriptor);
    expect(verifyNodeDescriptor({ ...descriptor, height: 11 }, signature, net).ok).toBe(false);
    const other = generateKeyPair(net.addressHrp);
    const forged = signNodeDescriptor({ address: descriptor.identity, publicKey: other.publicKey, privateKey: other.privateKey }, descriptor);
    expect(verifyNodeDescriptor(descriptor, forged, net).ok).toBe(false);
    const old = descriptorFor(keys, Math.floor(Date.now() / 1000) - 10_000);
    const oldSig = signNodeDescriptor({ address: old.identity, publicKey: keys.publicKey, privateKey: keys.privateKey }, old);
    expect(verifyNodeDescriptor(old, oldSig, net).ok).toBe(false);
    expect(verifyNodeDescriptor(descriptor, signature, getNetwork('testnet')).ok).toBe(false);
  });
});
