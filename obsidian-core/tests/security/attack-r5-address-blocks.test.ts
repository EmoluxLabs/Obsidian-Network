/**
 * ATTACK ROUND 5 — one machine, many addresses.
 *
 * Every per-address defence a node has (the RPC rate limit, the cap on inbound sockets per address, the ban on an
 * address that misbehaved) keys on the peer's IP. An IPv4 address is one subscriber. An IPv6 address is not: an
 * access network hands each subscriber a whole /64 (2^64 addresses), so a single attacker could present a fresh
 * "address" for every request, every socket and every ban. The defences are now keyed on the /64.
 *
 * The same round measured the bookkeeping itself: the RPC limiter scanned its whole table on every request once
 * the table held 10,000 entries that were less than ten minutes old, so a flood of fresh addresses turned each
 * request into 10,000 steps of work.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { P2PService } from '../../src/networking/p2p.js';
import { PeerStore } from '../../src/networking/peer-store.js';
import { KeyedLimiter, clientBucket } from '../../src/networking/keyed-limiter.js';
import { generateKeyPair, nodeIdFromPublicKey } from '../../src/crypto/keys.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

interface FakeSocket {
  closed?: { code: number; reason: string };
  readyState: number;
  on(): void;
  send(): void;
  close(code: number, reason: string): void;
  terminate(): void;
}
const fakeSocket = (): FakeSocket => ({
  readyState: 1,
  on() {},
  send() {},
  close(code, reason) {
    this.closed = { code, reason };
  },
  terminate() {},
});

describe('round 5: addresses are grouped the way subscribers are', () => {
  it('buckets IPv6 by /64 and leaves IPv4 alone', () => {
    expect(clientBucket('2001:db8:1:2::1')).toBe(clientBucket('2001:db8:1:2:ffff:eeee:dddd:cccc'));
    expect(clientBucket('2001:DB8:1:2:0:0:0:7')).toBe(clientBucket('2001:db8:1:2::7'));
    expect(clientBucket('2001:db8:1:3::1')).not.toBe(clientBucket('2001:db8:1:2::1'));
    expect(clientBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(clientBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(clientBucket('::1')).toBe(clientBucket('0:0:0:0:0:0:0:2'));
  });

  it('caps inbound sockets per address BLOCK, not per address', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const keys = generateKeyPair(h.net.addressHrp);
    const p2p = new P2PService({
      net: h.net,
      chain: h.chain,
      peers: new PeerStore({ dataDir: h.dir, seeds: [], persist: false, allowLocalAddresses: true }),
      identity: { nodeId: nodeIdFromPublicKey(keys.publicKey), publicKey: keys.publicKey, privateKey: keys.privateKey, address: keys.address },
      genesisId: h.chain.genesisId,
      listenAddress: '127.0.0.1:0',
      log: () => undefined,
    });
    const accept = (ip: string): FakeSocket => {
      const socket = fakeSocket();
      (p2p as unknown as { accept(s: unknown, a: string, inbound: boolean, ip: string): void }).accept(socket, `${ip}:5000`, true, ip);
      return socket;
    };
    const sockets = Array.from({ length: 20 }, (_, i) => accept(`2001:db8:aaaa:1::${(i + 1).toString(16)}`));
    const refused = sockets.filter((socket) => socket.closed?.reason === 'too many connections from this address');
    expect(sockets.length - refused.length).toBeLessThanOrEqual(8);
    expect(refused.length).toBeGreaterThanOrEqual(12);
    // A different subscriber is not affected.
    expect(accept('2001:db8:bbbb:1::1').closed).toBeUndefined();
    // A ban on one address of a block is a ban on the block.
    (p2p as unknown as { banIp(ip: string, reason: string): void }).banIp('2001:db8:cccc:1::1', 'test');
    expect(accept('2001:db8:cccc:1::99').closed?.reason).toBe('address temporarily refused');
    for (const socket of sockets) socket.terminate();
  });
});

describe('round 5: the limiter that polices clients cannot be made into the weapon', () => {
  it('keeps memory bounded and per-request work constant under a flood of fresh addresses', () => {
    const clock = { now: 0 };
    const limiter = new KeyedLimiter(5, 5 / 60, () => clock.now, 5_000);
    const started = process.hrtime.bigint();
    for (let i = 0; i < 60_000; i += 1) {
      limiter.allow(`198.51.${i >> 8}.${i & 255}`);
      if (i % 1000 === 0) clock.now += 1_000;
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(limiter.size).toBeLessThanOrEqual(5_000);
    expect(elapsedMs).toBeLessThan(1_500);
  });
});
