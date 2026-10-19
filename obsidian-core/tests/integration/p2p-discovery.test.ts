/**
 * Automatic peer discovery and reconnection, on real loopback sockets, with three (and more) real `P2PService`s.
 *
 * Each test is a way the network breaks in an ordinary week: one node boots before the one it follows, a seed is down,
 * a node is stopped without warning and comes back, two nodes dial each other in the same instant, a node learns
 * the others only through one seed. What they assert is what an operator cares about, not that a process is alive:
 * who is actually connected (a finished, authenticated handshake), and whether the chain moved.
 *
 * Time: the peer set is looked at every 15 s and a failed address waits 15 s × 2^n, which no test can sit through.
 * `maintainIntervalMs` shortens the first, and the PeerStore's clock is a variable the test advances for the second.
 * Nothing about a retry is faked beyond that: the sockets, the handshake and the chain are the real ones.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { generateKeyPair, nodeIdFromPublicKey } from '../../src/crypto/keys.js';
import { genesisDocumentFor } from '../../src/genesis/initialize.js';
import { P2PService } from '../../src/networking/p2p.js';
import { PeerStore } from '../../src/networking/peer-store.js';
import { getNetwork } from '../../src/protocol/networks.js';

const net = getNetwork('devnet');
const MAINTAIN_MS = 120;
const ADDR_MS = 300;

interface LogLine {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

interface Member {
  name: string;
  dir: string;
  keys: ReturnType<typeof generateKeyPair>;
  port: number;
  chain: ChainManager;
  p2p: P2PService;
  peers: PeerStore;
  clock: { t: number };
  logs: LogLine[];
  running: boolean;
  mine(): void;
  /** Peers that finished an authenticated handshake. */
  connected(): string[];
  address(): string;
}

const members: Member[] = [];
const dirs: string[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

interface Identity {
  name: string;
  dir: string;
  keys: ReturnType<typeof generateKeyPair>;
  port: number;
}

async function identity(name: string): Promise<Identity> {
  const dir = mkdtempSync(join(tmpdir(), `obs-disc-${name}-`));
  dirs.push(dir);
  return { name, dir, keys: generateKeyPair(net.addressHrp), port: await freePort() };
}

/** Start (or restart: same Identity, same data directory, same keys, same port) one node. */
async function start(who: Identity, seeds: Identity[] = [], extra: { seedStrings?: string[]; clock?: { t: number }; random?: () => number; maxPeers?: number } = {}): Promise<Member> {
  const chain = new ChainManager({ dataDir: who.dir, net, genesisDocument: genesisDocumentFor(net), enforceProposerRotation: true });
  await chain.init();
  const clock = extra.clock ?? { t: 1_800_000_000_000 };
  const seedList = [...seeds.map((seed) => `127.0.0.1:${seed.port}`), ...(extra.seedStrings ?? [])];
  const peers = new PeerStore({ dataDir: who.dir, seeds: seedList, persist: false, allowLocalAddresses: true, now: () => clock.t, random: () => 0.5, maxPeers: extra.maxPeers });
  const logs: LogLine[] = [];
  const p2p = new P2PService({
    net,
    chain,
    peers,
    identity: { nodeId: nodeIdFromPublicKey(who.keys.publicKey), publicKey: who.keys.publicKey, privateKey: who.keys.privateKey, address: who.keys.address },
    genesisId: chain.genesisId,
    listenAddress: `127.0.0.1:${who.port}`,
    maintainIntervalMs: MAINTAIN_MS,
    addrRefreshMs: ADDR_MS,
    log: (level, message, fields) => void logs.push({ level, message, fields }),
  });
  await p2p.listen(who.port, '127.0.0.1');
  const member: Member = {
    name: who.name,
    dir: who.dir,
    keys: who.keys,
    port: who.port,
    chain,
    p2p,
    peers,
    clock,
    logs,
    running: true,
    mine() {
      const block = chain.buildNextBlock({ address: who.keys.address, privateKey: who.keys.privateKey, publicKey: who.keys.publicKey });
      if (!block) throw new Error('not allowed to produce');
      const result = chain.addBlock(block);
      if (!result.accepted) throw new Error(`own block rejected: ${result.code}`);
      p2p.broadcastBlock(block);
    },
    connected: () => p2p.activeConnections().filter((connection) => connection.nodeId !== '').map((connection) => connection.nodeId),
    address: () => `127.0.0.1:${who.port}`,
  };
  members.push(member);
  // What node.ts does at boot: dial every configured seed once, and never let one bad seed stop the node.
  for (const seed of seedList) p2p.connectTo(seed, 'seed').catch(() => undefined);
  return member;
}

async function stop(member: Member): Promise<void> {
  if (!member.running) return;
  member.running = false;
  await member.p2p.stop();
}

afterEach(async () => {
  for (const member of members.splice(0)) await stop(member);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, ms = 10_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const nodeIdOf = (who: Identity | Member): string => nodeIdFromPublicKey(who.keys.publicKey);

describe('three nodes find each other', () => {
  it('B and C know only A, and still end up connected to each other (discovery through one seed)', async () => {
    const [a, b, c] = [await identity('a'), await identity('b'), await identity('c')];
    const A = await start(a);
    const B = await start(b, [a]);
    await waitFor(() => B.connected().length === 1, 8_000, 'B to reach A');
    await pause(ADDR_MS + 200); // B's first question to A is long answered, and A knew nobody else then
    const C = await start(c, [a]);
    // From here B can learn about C only by asking A again later: discovery does not end with the handshake.
    await waitFor(() => B.connected().includes(nodeIdOf(C)) && C.connected().includes(nodeIdOf(B)), 12_000, 'B and C to meet through A');
    // Every node is connected to both others, exactly once each.
    for (const member of [A, B, C]) expect(new Set(member.connected()).size).toBe(2);
    for (const member of [A, B, C]) expect(member.connected()).toHaveLength(2);
  }, 20_000);

  it('start order does not matter: B boots before A exists and joins when A appears', async () => {
    const [a, b] = [await identity('a'), await identity('b')];
    const B = await start(b, [a]); // A is not running: the first dial is refused
    await waitFor(() => (B.peers.get(`127.0.0.1:${a.port}`)?.failureCount ?? 0) >= 1, 5_000, 'the first refusal to be recorded');
    const A = await start(a);
    // Inside the backoff window B does not hammer A...
    const failuresBefore = B.peers.get(`127.0.0.1:${a.port}`)?.failureCount ?? 0;
    await pause(MAINTAIN_MS * 4);
    expect(B.peers.get(`127.0.0.1:${a.port}`)?.failureCount ?? 0).toBe(failuresBefore);
    expect(B.connected()).toHaveLength(0);
    // ...and when the window has passed, it connects with no operator action.
    B.clock.t += 20_000;
    await waitFor(() => B.connected().includes(nodeIdOf(A)) && A.connected().includes(nodeIdOf(B)), 8_000, 'B to join A after the backoff');
  }, 20_000);

  it('node 3 starts while node 1 is down: it joins through node 2, then node 1 comes back and everyone meets', async () => {
    const [a, b, c] = [await identity('a'), await identity('b'), await identity('c')];
    const A = await start(a);
    const B = await start(b, [a]);
    await waitFor(() => B.connected().length === 1, 8_000, 'B to reach A');
    await stop(A);
    await waitFor(() => B.connected().length === 0, 8_000, 'B to notice A is gone');
    // C knows both addresses, A first. A refuses; B answers.
    const C = await start(c, [a, b]);
    await waitFor(() => C.connected().includes(nodeIdOf(B)), 8_000, 'C to join through B');
    expect(C.connected()).not.toContain(nodeIdOf(A));
    // A returns on the same address, with its own data directory and keys.
    const A2 = await start(a, [b]);
    for (const member of [B, C]) member.clock.t += 20_000;
    await waitFor(() => [A2, B, C].every((member) => new Set(member.connected()).size === 2), 12_000, 'the three to be fully connected again');
  }, 30_000);
});

describe('discovery continues after the handshake', () => {
  it('a peer that appears later is found by nodes that were already connected', async () => {
    const [a, b, d] = [await identity('a'), await identity('b'), await identity('d')];
    const A = await start(a);
    const B = await start(b, [a]);
    await waitFor(() => B.connected().length === 1, 8_000, 'B to reach A');
    await pause(ADDR_MS + 200);
    const D = await start(d); // knows nobody and is known by nobody
    A.peers.addGossiped([{ host: '127.0.0.1', port: d.port }]); // A hears of D
    await waitFor(() => A.connected().includes(nodeIdOf(D)), 8_000, 'A to connect to D');
    // B's only source for D is A, and B's first question to A was long ago. (Either side may make the connection: D asks
    // A for addresses when it meets A, and B asks A again every few seconds. This asserts the outcome, not which one.)
    await waitFor(() => B.connected().includes(nodeIdOf(D)), 10_000, 'B to learn of D from A and connect');
  }, 25_000);
});

describe('a node that is stopped without warning', () => {
  it('is redialled when it comes back, resumes from its own database, and catches up on what it missed', async () => {
    const [a, b, c] = [await identity('a'), await identity('b'), await identity('c')];
    const A = await start(a);
    const B = await start(b, [a]);
    const C = await start(c, [a]);
    await waitFor(() => [A, B, C].every((member) => member.connected().length === 2), 12_000, 'the mesh');
    A.mine();
    A.mine();
    await waitFor(() => B.chain.tip?.height === 2 && C.chain.tip?.height === 2, 8_000, 'B and C to follow A to height 2');

    await stop(B); // gone, no goodbye
    await waitFor(() => A.connected().length === 1 && C.connected().length === 1, 8_000, 'A and C to notice');
    A.mine();
    A.mine();
    A.mine();
    await waitFor(() => C.chain.tip?.height === 5, 8_000, 'C to follow while B is down');
    // Consensus health is not process liveness: the two live nodes agree on the head, not just on being up.
    expect(C.chain.tip?.hash).toBe(A.chain.tip?.hash);

    const B2 = await start(b, [a]); // same keys, same data directory
    expect(B2.chain.tip?.height).toBe(2); // resumed from its own database, not from genesis
    A.clock.t += 20_000;
    C.clock.t += 20_000;
    B2.clock.t += 20_000;
    await waitFor(() => B2.connected().length === 2, 12_000, 'B to be connected to both again');
    await waitFor(() => B2.chain.tip?.height === 5, 12_000, 'B to catch up');
    expect(B2.chain.tip?.hash).toBe(A.chain.tip?.hash);
  }, 40_000);

  it('a lost connection is rediscovered: the link is cut, and the nodes reconnect on their own', async () => {
    const [a, b] = [await identity('a'), await identity('b')];
    const A = await start(a);
    const B = await start(b, [a]);
    await waitFor(() => A.connected().length === 1 && B.connected().length === 1, 8_000, 'the first connection');
    // Cut every socket on B's side the way a dropped route does: no close frame.
    const links = (B.p2p as unknown as { links: Map<string, { socket: { terminate(): void } }> }).links;
    for (const link of links.values()) link.socket.terminate();
    await waitFor(() => B.connected().length === 0, 5_000, 'the cut to be noticed');
    B.clock.t += 20_000;
    A.clock.t += 20_000;
    await waitFor(() => A.connected().length === 1 && B.connected().length === 1, 10_000, 'the nodes to reconnect');
  }, 25_000);
});

describe('failures that must not loop, storm or stop the node', () => {
  it('two nodes that dial each other in the same instant settle on ONE connection, every time', async () => {
    for (let round = 0; round < 4; round += 1) {
      const [a, b] = [await identity(`a${round}`), await identity(`b${round}`)];
      // Both are listening before either dials: the dials cross on the wire.
      const A = await start(a);
      const B = await start(b);
      await Promise.all([A.p2p.connectTo(B.address(), 'seed'), B.p2p.connectTo(A.address(), 'seed')]);
      await waitFor(() => A.connected().length >= 1 && B.connected().length >= 1, 8_000, `round ${round}: a connection`);
      // Long enough for a duplicate to be created and torn down, if that were going to happen. The connection must never
      // drop to zero on the way: a node that lost its only link and redialled would pass a check made only at the end.
      for (let sample = 0; sample < 48; sample += 1) {
        expect(A.connected(), `round ${round}, sample ${sample}: A`).toHaveLength(1);
        expect(B.connected(), `round ${round}, sample ${sample}: B`).toHaveLength(1);
        await pause(25);
      }
      await stop(A);
      await stop(B);
    }
  }, 40_000);

  it('a seed whose name does not resolve is a recorded failure, not a crash, and the other seed still works', async () => {
    const [a, b] = [await identity('a'), await identity('b')];
    const A = await start(a);
    const B = await start(b, [a], { seedStrings: ['no-such-host.invalid:38631'] });
    await waitFor(() => B.connected().includes(nodeIdOf(A)), 8_000, 'B to reach the seed that works');
    const bad = B.peers.get('no-such-host.invalid:38631');
    await waitFor(() => (B.peers.get('no-such-host.invalid:38631')?.failureCount ?? 0) >= 1, 8_000, 'the DNS failure to be recorded');
    expect(bad).toBeDefined();
    expect(B.connected()).toHaveLength(1);
  }, 20_000);

  it('a refused address is retried with growing, bounded delays, not on every sweep', async () => {
    const [a, b] = [await identity('a'), await identity('b')];
    const B = await start(b, [a]); // nobody listens at A's port
    const key = `127.0.0.1:${a.port}`;
    await waitFor(() => (B.peers.get(key)?.failureCount ?? 0) === 1, 5_000, 'first failure');
    const first = B.peers.get(key)!.bannedUntil - B.clock.t;
    expect(first).toBe(15_000); // jitter source fixed at 0.5 => exactly the base delay
    await pause(MAINTAIN_MS * 8); // 8 sweeps inside the window: no further attempt
    expect(B.peers.get(key)!.failureCount).toBe(1);
    for (let i = 2; i <= 12; i += 1) {
      B.clock.t = B.peers.get(key)!.bannedUntil + 1;
      await waitFor(() => (B.peers.get(key)?.failureCount ?? 0) === i, 5_000, `failure ${i}`);
      const wait = B.peers.get(key)!.bannedUntil - B.clock.t;
      expect(wait).toBeLessThanOrEqual(5 * 60 * 1000); // the cap: an unreachable peer is retried at least every five minutes
      expect(wait).toBeGreaterThanOrEqual(15_000);
    }
  }, 40_000);

  it('a node never dials its own advertised address, even when a peer hands it over', async () => {
    const a = await identity('a');
    const A = await start(a);
    // A peer tells A to dial A (a gossiped copy of A's own address).
    A.peers.addGossiped([{ host: '127.0.0.1', port: a.port }]);
    await pause(MAINTAIN_MS * 6);
    expect(A.connected()).toHaveLength(0);
    expect(A.p2p.activeConnections()).toHaveLength(0);
    // It was never attempted: no failure was recorded against it, because no dial happened.
    expect(A.peers.get(`127.0.0.1:${a.port}`)?.failureCount ?? 0).toBe(0);
    expect(A.logs.filter((line) => line.message.includes('own address'))).toHaveLength(0);
  }, 15_000);

  it('the peer set and the connection count stay bounded in a crowd that all know one seed', async () => {
    const ids = await Promise.all(Array.from({ length: 7 }, (_, i) => identity(`n${i}`)));
    const hub = await start(ids[0]!);
    const rest: Member[] = [];
    for (const who of ids.slice(1)) rest.push(await start(who, [ids[0]!], { maxPeers: 16 }));
    await waitFor(() => rest.every((member) => member.connected().length >= 2), 20_000, 'everyone to have at least two peers');
    await pause(1_500);
    for (const member of [hub, ...rest]) {
      const connections = member.p2p.activeConnections();
      // Never two links to the same node, and the outbound side stays under the dial target (8).
      expect(new Set(connections.map((connection) => connection.nodeId)).size).toBe(connections.length);
      expect(connections.filter((connection) => !connection.inbound).length).toBeLessThanOrEqual(8);
      expect(member.p2p.knownPeers().length).toBeLessThanOrEqual(16);
    }
  }, 40_000);
});

describe('a background failure does not end the process', () => {
  it('a sync that throws is logged and swallowed: it cannot become an unhandled rejection', async () => {
    const [a, b] = [await identity('a'), await identity('b')];
    const A = await start(a);
    const B = await start(b, [a]);
    await waitFor(() => B.connected().length === 1, 8_000, 'a connection');
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => void rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const service = B.p2p as unknown as { runSync: () => Promise<void>; syncFrom: (link: unknown) => Promise<void>; links: Map<string, unknown> };
      service.runSync = async () => {
        throw new Error('synthetic failure inside sync');
      };
      const link = [...service.links.values()][0];
      await expect(service.syncFrom(link)).resolves.toBeUndefined();
      B.p2p.requestSyncFromPeers(); // the fire-and-forget path
      await pause(200);
      expect(rejections).toEqual([]);
      expect(B.logs.some((line) => line.message.includes('background task failed') || line.level === 'warn' || line.level === 'error')).toBe(true);
      expect(A.connected()).toHaveLength(1); // and the node is still serving its peer
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  }, 15_000);
});

describe('a peer is not trusted for appearing in a discovery answer', () => {
  it('an address handed over by a peer is only a hint: the node dials it, and refuses it if it is another network', async () => {
    const other = getNetwork('testnet');
    const a = await identity('a');
    const stranger = await identity('stranger');
    const dir = stranger.dir;
    const chain = new ChainManager({ dataDir: dir, net: other, genesisDocument: genesisDocumentFor(other) });
    await chain.init();
    const keys = generateKeyPair(other.addressHrp);
    const strangerPeers = new PeerStore({ dataDir: dir, seeds: [], persist: false, allowLocalAddresses: true });
    const strangerNode = new P2PService({
      net: other,
      chain,
      peers: strangerPeers,
      identity: { nodeId: nodeIdFromPublicKey(keys.publicKey), publicKey: keys.publicKey, privateKey: keys.privateKey, address: keys.address },
      genesisId: chain.genesisId,
      listenAddress: `127.0.0.1:${stranger.port}`,
    });
    await strangerNode.listen(stranger.port, '127.0.0.1');
    try {
      const A = await start(a);
      // Hand A the stranger's address the way a peer's `addr` message would.
      A.peers.addGossiped([{ host: '127.0.0.1', port: stranger.port }]);
      await waitFor(() => (A.peers.get(`127.0.0.1:${stranger.port}`)?.failureCount ?? 0) >= 1, 8_000, 'A to try and be refused');
      expect(A.connected()).toHaveLength(0);
      expect(strangerNode.activeConnections().filter((connection) => connection.nodeId !== '')).toHaveLength(0);
    } finally {
      await strangerNode.stop();
    }
  }, 20_000);
});
