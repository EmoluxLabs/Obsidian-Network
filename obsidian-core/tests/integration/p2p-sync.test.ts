/**
 * Block synchronisation, end to end over real WebSockets.
 *
 * The incident these pin down: a freshly initialised testnet node connected to an established peer, reached height 8 and
 * never moved again, then dropped the peer with "claimed a better chain but did not deliver it". 8 was the number of
 * blocks one `getblocks` carried. The requester restarted every request 16 blocks below its OWN height, so once a batch
 * (or the peer's answer) was shorter than that overlap the window ended below the local head: the peer returned blocks
 * we already had, nothing was accepted, and the loop gave up and punished an honest peer.
 *
 * Nothing here is mocked. Two or three real `P2PService`s mine real blocks and talk over loopback sockets.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ChainManager } from '../../src/blockchain/chain.js';
import { blockHash, decodeBlock, encodeBlock } from '../../src/blockchain/block.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { generateKeyPair, nodeIdFromPublicKey, signDigest } from '../../src/crypto/keys.js';
import { fromHex, toHex } from '../../src/crypto/hash.js';
import { randomBytes } from 'node:crypto';
import { CORE_VERSION, PROTOCOL_VERSION } from '../../src/version.js';
import { genesisDocumentFor } from '../../src/genesis/initialize.js';
import { P2PService, helloDigest, type HelloPayload } from '../../src/networking/p2p.js';
import { PeerStore } from '../../src/networking/peer-store.js';
import { getNetwork } from '../../src/protocol/networks.js';

const net = getNetwork('devnet');

interface LogEntry {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

interface TestNode {
  chain: ChainManager;
  p2p: P2PService;
  port: number;
  dir: string;
  logs: LogEntry[];
  mine(gossip?: boolean): void;
}

const nodes: TestNode[] = [];

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

async function startNode(options: { syncBatch?: number; syncTimeoutMs?: number } = {}): Promise<TestNode> {
  const dir = mkdtempSync(join(tmpdir(), 'obs-sync-'));
  const chain = new ChainManager({ dataDir: dir, net, genesisDocument: genesisDocumentFor(net), enforceProposerRotation: true });
  await chain.init();
  const keys = generateKeyPair(net.addressHrp);
  const port = await freePort();
  const logs: LogEntry[] = [];
  const peers = new PeerStore({ dataDir: dir, seeds: [], persist: false, allowLocalAddresses: true });
  const p2p = new P2PService({
    net,
    chain,
    peers,
    identity: { nodeId: nodeIdFromPublicKey(keys.publicKey), publicKey: keys.publicKey, privateKey: keys.privateKey, address: keys.address },
    genesisId: chain.genesisId,
    listenAddress: `127.0.0.1:${port}`,
    syncBatch: options.syncBatch,
    syncTimeoutMs: options.syncTimeoutMs,
    log: (level, message, fields) => {
      logs.push({ level, message, fields });
      if (process.env.P2P_DEBUG) console.log(`[${keys.address.slice(-4)}] ${level} ${message}`, JSON.stringify(fields ?? {}));
    },
  });
  await p2p.listen(port, '127.0.0.1');
  const node: TestNode = {
    chain,
    p2p,
    port,
    dir,
    logs,
    mine(gossip = false) {
      const block = chain.buildNextBlock({ address: keys.address, privateKey: keys.privateKey, publicKey: keys.publicKey });
      if (!block) throw new Error('node was not allowed to produce');
      const result = chain.addBlock(block);
      if (!result.accepted) throw new Error(`own block rejected: ${result.code} ${result.message}`);
      if (gossip) p2p.broadcastBlock(block);
    },
  };
  nodes.push(node);
  return node;
}

// Block times rise by at least a second per block and a node refuses blocks more than 60 s ahead of its clock, so a
// chain of hundreds of blocks cannot be mined in an instant. The tests move the process clock forward one second per
// block instead of waiting (every node here shares it, as the nodes of a real network share real time).
let skewSeconds = 0;
beforeEach(() => {
  skewSeconds = 0;
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + skewSeconds * 1000);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const node of nodes.splice(0)) {
    await node.p2p.stop();
    rmSync(node.dir, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean, ms = 20_000, label: string | (() => string) = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${typeof label === 'function' ? label() : label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const handshakeDone = (node: TestNode): boolean => node.p2p.activeConnections().filter((c) => c.nodeId !== '').length >= 1;
const sameTip = (a: TestNode, b: TestNode): boolean => a.chain.tip!.hash === b.chain.tip!.hash;
const mineMany = (node: TestNode, count: number): void => {
  for (let i = 0; i < count; i += 1) {
    skewSeconds += 1;
    node.mine(false);
  }
};
const ownLogs = (node: TestNode, message: string): LogEntry[] => node.logs.filter((entry) => entry.message === message);

// ── The incident ─────────────────────────────────────────────────────────────

describe('a fresh node catching up with an established peer (the testnet incident)', () => {
  it('reaches the head when BOTH nodes move 8 blocks per request', async () => {
    const established = await startNode({ syncBatch: 8 });
    mineMany(established, 100);
    const fresh = await startNode({ syncBatch: 8 });
    await fresh.p2p.connectTo(`127.0.0.1:${established.port}`, 'manual');
    await waitFor(() => fresh.chain.height === 100, 25_000, () => `the fresh node to reach 100 (stuck at ${fresh.chain.height})`);
    expect(sameTip(fresh, established)).toBe(true);
    expect(fresh.chain.verifyIntegrity()).toEqual({ ok: true, problems: [] });
  }, 40_000);

  it('reaches the head when the PEER serves fewer blocks than were asked for (mixed batch sizes)', async () => {
    const established = await startNode({ syncBatch: 8 }); // answers 8 whatever it is asked
    mineMany(established, 100);
    const fresh = await startNode(); // asks for 128
    await fresh.p2p.connectTo(`127.0.0.1:${established.port}`, 'manual');
    await waitFor(() => fresh.chain.height === 100, 25_000, () => `the fresh node to reach 100 (stuck at ${fresh.chain.height})`);
    expect(sameTip(fresh, established)).toBe(true);
  }, 40_000);

  it('reaches the head from height 8 on its own short fork, without dropping the peer', async () => {
    const established = await startNode({ syncBatch: 8 });
    mineMany(established, 100);
    const fresh = await startNode({ syncBatch: 8 });
    mineMany(fresh, 8); // the incident: "reached height 8" on a chain of its own
    expect(sameTip(fresh, established)).toBe(false);
    await fresh.p2p.connectTo(`127.0.0.1:${established.port}`, 'manual');
    await waitFor(() => fresh.chain.height === 100, 25_000, () => `the fresh node to reach 100 (stuck at ${fresh.chain.height})`);
    expect(sameTip(fresh, established)).toBe(true);
    expect(fresh.p2p.peerCount).toBe(1);
    expect(ownLogs(fresh, 'peer address refused for a while')).toHaveLength(0);
  }, 40_000);
});


// ── A scripted peer: a real handshake, then whatever answers a test wants to give ────────────────────────────────────

type Msg = Record<string, unknown>;

interface Scripted {
  socket: WebSocket;
  getblocks: Msg[];
  reply(request: Msg, blocks: string[], more: boolean, extra?: Msg): void;
  /** Serve `request` exactly as a correct node holding `source` would (its own batch size applies). */
  honest(request: Msg): void;
  send(message: Msg): void;
  closed(): boolean;
}

const sockets: WebSocket[] = [];
afterEach(() => {
  for (const socket of sockets.splice(0)) socket.terminate();
});

/** Connects to `target` as a peer that claims `source`'s tip (or the given one) and hands every `getblocks` to `script`. */
async function scriptedPeer(
  target: TestNode,
  source: TestNode,
  script: (request: Msg, peer: Scripted) => void,
  claim: { height?: number; weight?: string; headHash?: string } = {},
  sourceBatch = 128,
): Promise<Scripted> {
  const keys = generateKeyPair(net.addressHrp);
  const socket = new WebSocket(`ws://127.0.0.1:${target.port}`);
  sockets.push(socket);
  let closed = false;
  const getblocks: Msg[] = [];
  const received: Msg[] = [];
  const peer: Scripted = {
    socket,
    getblocks,
    send: (message) => socket.send(JSON.stringify(message)),
    closed: () => closed,
    reply: (request, blocks, more, extra = {}) =>
      peer.send({ v: 1, t: 'blocks', ...(request.id === undefined ? {} : { id: request.id }), blocks, more, ...extra }),
    honest: (request) => {
      const limit = Math.min(sourceBatch, Math.max(1, Number(request.limit ?? sourceBatch)));
      const result = source.chain.blocksForSync(Number(request.from), limit);
      peer.reply(request, result.blocks.map((bytes) => Buffer.from(bytes).toString('hex')), result.more);
    },
  };
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => undefined);
  socket.on('message', (data) => {
    const message = JSON.parse(data.toString()) as Msg;
    received.push(message);
    if (process.env.P2P_DEBUG) console.log('SCRIPTED got', JSON.stringify(message).slice(0, 300));
    if (message.t === 'getblocks') {
      getblocks.push(message);
      script(message, peer);
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  await waitFor(() => received.some((message) => message.t === 'challenge'), 3_000, 'the challenge');
  const challenge = String(received.find((message) => message.t === 'challenge')!.challenge);
  const tip = source.chain.tip!;
  const hello: HelloPayload = {
    nodeId: nodeIdFromPublicKey(keys.publicKey),
    identity: keys.address,
    publicKey: keys.publicKey,
    networkId: net.networkId,
    chainId: net.chainId,
    genesisId: source.chain.genesisId,
    paramsHash: PARAMS_HASH,
    protocolVersion: PROTOCOL_VERSION,
    version: CORE_VERSION,
    listenHost: '127.0.0.1',
    listenPort: 45_000,
    rpcPort: 0,
    height: claim.height ?? tip.height,
    headHash: claim.headHash ?? tip.hash,
    weight: claim.weight ?? tip.cumulativePotWeight,
    finalizedHeight: target.chain.finalityStatus().finalizedHeight,
    finalizedHash: target.chain.finalityStatus().finalizedHash,
    capabilities: ['sync', 'gossip', 'finality'],
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(16).toString('hex'),
    challenge,
  };
  peer.send({ v: 1, t: 'hello', hello, signature: toHex(signDigest(helloDigest(hello), keys.privateKey)) });
  return peer;
}

const blockHex = (node: TestNode, height: number): string => Buffer.from(node.chain.blocksForSync(height, 1).blocks[0]!).toString('hex');
const scoreOf = (node: TestNode): number => node.p2p.peerViews()[0]?.score ?? 0;
const batchLogs = (node: TestNode): Record<string, unknown>[] => ownLogs(node, 'sync batch').map((entry) => entry.fields!);

describe('range semantics and consecutive batches', () => {
  it('asks for consecutive, gap-free, duplicate-free ranges and reads the peer\'s `more`', async () => {
    const established = await startNode();
    mineMany(established, 100);
    const fresh = await startNode();
    const asked: Array<{ from: number; limit: number; id: unknown }> = [];
    const peer = await scriptedPeer(
      fresh,
      established,
      (request, p) => {
        asked.push({ from: Number(request.from), limit: Number(request.limit), id: request.id });
        p.honest(request);
      },
      {},
      8, // the peer serves 8 per reply whatever it is asked
    );
    await waitFor(() => fresh.chain.height === 100, 25_000, () => `height 100 (stuck at ${fresh.chain.height})`);
    expect(peer.closed()).toBe(false);
    // 8-block replies from height 0: 1, 9, 17, ... — each request starts where the previous reply ended.
    expect(asked.slice(0, 12).map((request) => request.from)).toEqual([1, 9, 17, 25, 33, 41, 49, 57, 65, 73, 81, 89]);
    for (const request of asked) expect(typeof request.id).toBe('string');
    const logs = batchLogs(fresh);
    const connected = logs.filter((fields) => (fields.accepted as number) > 0);
    expect(connected.reduce((sum, fields) => sum + (fields.accepted as number), 0)).toBe(100);
    expect(logs.every((fields) => fields.duplicates === 0 || (fields.requestedFrom as number) > 96)).toBe(true);
    const first = logs[0]!;
    expect(first).toMatchObject({ requestedFrom: 1, returned: 8, more: true, firstHeight: 1, lastHeight: 8, accepted: 8, orphans: 0, rejectedCode: null });
    expect(first.firstHash).toBe(blockHash(decodeBlock(fromHex(blockHex(established, 1))).header));
    expect(first.lastHash).toBe(blockHash(decodeBlock(fromHex(blockHex(established, 8))).header));
    expect(first.remoteHeight).toBe(100);
    expect(ownLogs(fresh, 'sync started')[0]!.fields).toMatchObject({ localHeight: 0, remoteHeight: 100, remoteHead: established.chain.tip!.hash });
    expect(scoreOf(fresh)).toBe(0);
  }, 40_000);

  it('handles a batch boundary that falls exactly on the peer\'s head (`more` is false, nothing is missing)', async () => {
    const established = await startNode({ syncBatch: 8 });
    mineMany(established, 24); // 3 full batches
    const fresh = await startNode({ syncBatch: 8 });
    await fresh.p2p.connectTo(`127.0.0.1:${established.port}`, 'manual');
    await waitFor(() => fresh.chain.height === 24, 15_000, () => `height 24 (stuck at ${fresh.chain.height})`);
    await pause(400);
    expect(sameTip(fresh, established)).toBe(true);
    expect(fresh.p2p.peerCount).toBe(1);
    expect(scoreOf(fresh)).toBe(0);
  }, 30_000);

  it('keeps following a peer that mines while this node is syncing', async () => {
    const established = await startNode({ syncBatch: 8 });
    mineMany(established, 40);
    const fresh = await startNode({ syncBatch: 8 });
    await fresh.p2p.connectTo(`127.0.0.1:${established.port}`, 'manual');
    await waitFor(() => fresh.chain.height >= 8, 15_000, 'the first batch');
    mineMany(established, 20);
    established.p2p.broadcastBlock(decodeBlock(fromHex(blockHex(established, 60)))); // announce the new head
    await waitFor(() => fresh.chain.height === 60, 20_000, () => `height 60 (stuck at ${fresh.chain.height})`);
    expect(sameTip(fresh, established)).toBe(true);
  }, 30_000);
});

describe('replies that are empty, wrong, out of order or in the wrong place', () => {
  it('an EMPTY reply to a peer that advertised a higher chain costs the peer a minor penalty and is explained in the log', async () => {
    const established = await startNode();
    mineMany(established, 100);
    const fresh = await startNode();
    const peer = await scriptedPeer(fresh, established, (request, p) => p.reply(request, [], false));
    await waitFor(() => ownLogs(fresh, 'peer claimed a better chain but delivered nothing').length === 1, 10_000, 'the failed sync to be logged');
    expect(fresh.chain.height).toBe(0);
    const failed = ownLogs(fresh, 'peer claimed a better chain but delivered nothing')[0]!;
    expect(failed.fields).toMatchObject({ reason: 'empty reply', remoteHeight: 100, localHeight: 0 });
    expect(batchLogs(fresh)[0]).toMatchObject({ requestedFrom: 1, returned: 0, accepted: 0, more: false });
    expect(scoreOf(fresh)).toBe(-10); // one minor penalty, not a ban
    expect(peer.closed()).toBe(false);
    expect(ownLogs(fresh, 'peer address refused for a while')).toHaveLength(0);
  }, 30_000);

  it('a BAD FIRST BLOCK is rejected with its own code, the rest of the batch is not applied, and the peer pays for it', async () => {
    const established = await startNode();
    mineMany(established, 20);
    const fresh = await startNode();
    const tampered = decodeBlock(fromHex(blockHex(established, 1)));
    tampered.header.stateRoot = 'ab'.repeat(32);
    const bad = Buffer.from(encodeBlock(tampered)).toString('hex');
    await scriptedPeer(fresh, established, (request, p) => {
      p.reply(request, [bad, blockHex(established, 2), blockHex(established, 3)], true);
    });
    await waitFor(() => batchLogs(fresh).length > 0, 10_000, 'the batch to be logged');
    const fields = batchLogs(fresh)[0]!;
    expect(fields.rejectedCode).toBeTruthy();
    expect(fields.rejectedCode).not.toBe('ERR_ORPHAN_BLOCK');
    expect(String(fields.rejectedMessage).length).toBeGreaterThan(0);
    expect(fields).toMatchObject({ returned: 3, accepted: 0, firstHeight: 1 });
    expect(fresh.chain.height).toBe(0); // consensus was not weakened: nothing from that batch was accepted
    expect(scoreOf(fresh)).toBeLessThan(0);
    expect(scoreOf(fresh)).toBeLessThanOrEqual(-25);
  }, 30_000);

  it('a batch in the WRONG ORDER still connects, one block at a time, without penalty', async () => {
    const established = await startNode();
    mineMany(established, 30);
    const fresh = await startNode();
    let first = true;
    await scriptedPeer(fresh, established, (request, p) => {
      if (first) {
        first = false;
        // blocks 3, 2, 1: only block 1 connects at that moment
        p.reply(request, [blockHex(established, 3), blockHex(established, 2), blockHex(established, 1)], true);
        return;
      }
      p.honest(request);
    });
    await waitFor(() => fresh.chain.height === 30, 20_000, () => `height 30 (stuck at ${fresh.chain.height})`);
    expect(batchLogs(fresh)[0]).toMatchObject({ returned: 3, accepted: 1, orphans: 2 });
    expect(scoreOf(fresh)).toBe(0);
  }, 30_000);

  it('ORPHANS (a branch we do not share) make the requester reach further back until it finds the common ancestor', async () => {
    const established = await startNode();
    mineMany(established, 120);
    const fresh = await startNode();
    // The fresh node shares the first 40 blocks, then they part ways: it has 30 blocks of its own.
    for (let height = 1; height <= 40; height += 1) expect(fresh.chain.addBlock(decodeBlock(fromHex(blockHex(established, height)))).accepted).toBe(true);
    mineMany(fresh, 30);
    expect(fresh.chain.height).toBe(70);
    const asked: number[] = [];
    await scriptedPeer(fresh, established, (request, p) => {
      asked.push(Number(request.from));
      p.honest(request);
    });
    await waitFor(() => fresh.chain.height === 120 && sameTip(fresh, established), 25_000, () => `the canonical head (stuck at ${fresh.chain.height})`);
    // 54 (=70-16) is all orphans, then the window doubles back to 38 (=70-32) which reaches the shared blocks.
    expect(asked[0]).toBe(54);
    expect(asked[1]).toBeLessThan(asked[0]!);
    expect(batchLogs(fresh)[0]!.orphans).toBeGreaterThan(0);
    expect(scoreOf(fresh)).toBe(0);
  }, 40_000);
});

describe('listener races, duplicate and late answers', () => {
  it('registers the request BEFORE sending it, so an answer in the same tick is never lost', async () => {
    const node = await startNode();
    const internals = node.p2p as unknown as {
      requestBatch(link: unknown, from: number): Promise<{ returned: number; timedOut: boolean; disconnected: boolean }>;
      handleBlocks(link: unknown, message: Msg): void;
    };
    const link = {
      address: 'test:1',
      score: 0,
      pending: null as unknown,
      settledBatches: new Map<string, number>(),
      lateBatchUntil: 0,
      socket: {
        readyState: WebSocket.OPEN,
        // The "peer" answers from inside send(): before requestBatch has returned to its caller.
        send: (raw: string) => {
          const request = JSON.parse(raw) as Msg;
          internals.handleBlocks(link, { t: 'blocks', id: request.id, blocks: [], more: false });
        },
      },
    };
    const outcome = await internals.requestBatch(link, 1);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.disconnected).toBe(false);
    expect(link.score).toBe(0);
  });

  it('a DUPLICATED answer (same request id twice) is dropped without penalty', async () => {
    const established = await startNode();
    mineMany(established, 40);
    const fresh = await startNode();
    await scriptedPeer(fresh, established, (request, p) => {
      p.honest(request);
      p.honest(request); // the repeat
    }, {}, 8);
    await waitFor(() => fresh.chain.height === 40, 20_000, () => `height 40 (stuck at ${fresh.chain.height})`);
    await waitFor(() => ownLogs(fresh, 'late or repeated block batch ignored').length > 0, 5_000, 'the repeat to be recognised');
    expect(scoreOf(fresh)).toBe(0);
  }, 30_000);

  it('a LATE answer (after the request timed out) is not "unsolicited"; the timeout alone is a minor penalty and the next attempt succeeds', async () => {
    const established = await startNode();
    mineMany(established, 30);
    const fresh = await startNode({ syncTimeoutMs: 300 });
    let slow = true;
    const peer = await scriptedPeer(fresh, established, (request, p) => {
      if (slow) {
        slow = false;
        setTimeout(() => p.honest(request), 900); // far later than the 300 ms the requester waits
        return;
      }
      p.honest(request);
    });
    await waitFor(() => ownLogs(fresh, 'peer claimed a better chain but delivered nothing').length === 1, 10_000, 'the timeout to be reported');
    expect(ownLogs(fresh, 'peer claimed a better chain but delivered nothing')[0]!.fields).toMatchObject({ reason: 'timeout' });
    await waitFor(() => ownLogs(fresh, 'late or repeated block batch ignored').length === 1, 5_000, 'the late answer to be recognised');
    expect(fresh.chain.height).toBe(0); // the late answer was not applied
    expect(scoreOf(fresh)).toBe(-10); // only the timeout, nothing for the late answer
    // The peer announces itself again (a status does that every 20 s) once the retry gap has passed.
    skewSeconds += 10;
    const tip = established.chain.tip!;
    peer.send({ v: 1, t: 'status', height: tip.height, headHash: tip.hash, weight: tip.cumulativePotWeight });
    await waitFor(() => fresh.chain.height === 30, 15_000, () => `height 30 (stuck at ${fresh.chain.height})`);
    expect(scoreOf(fresh)).toBeGreaterThan(-10); // blocks delivered earn credit back, never above zero
    expect(scoreOf(fresh)).toBeLessThanOrEqual(0);
  }, 40_000);

  it('a batch nobody asked for is STILL penalised', async () => {
    const established = await startNode();
    mineMany(established, 5);
    const fresh = await startNode();
    const peer = await scriptedPeer(fresh, established, () => undefined, { height: 0, weight: '0', headHash: '' });
    await waitFor(() => handshakeDone(fresh), 5_000, 'the handshake');
    peer.send({ v: 1, t: 'blocks', id: 'deadbeefdeadbeef', blocks: [blockHex(established, 1)], more: false });
    await waitFor(() => scoreOf(fresh) < 0, 5_000, 'the penalty');
    expect(fresh.chain.height).toBe(0);
    expect(ownLogs(fresh, 'late or repeated block batch ignored')).toHaveLength(0);
  });
});

describe('disconnect and reconnect in the middle of a sync', () => {
  it('resumes from where it stopped, and a dropped link is not blamed on the peer', async () => {
    const established = await startNode({ syncBatch: 8 });
    mineMany(established, 100);
    const fresh = await startNode({ syncBatch: 8 });
    let served = 0;
    const flaky = await scriptedPeer(
      fresh,
      established,
      (request, p) => {
        served += 1;
        if (served <= 2) p.honest(request);
        else p.socket.close(); // vanish while the third request is in flight
      },
      {},
      8,
    );
    await waitFor(() => flaky.closed(), 15_000, 'the scripted peer to disconnect');
    await waitFor(() => ownLogs(fresh, 'sync finished').length > 0, 5_000, 'the sync to end');
    expect(fresh.chain.height).toBe(16);
    expect(ownLogs(fresh, 'sync finished')[0]!.fields).toMatchObject({ failure: 'disconnected', startHeight: 0 });
    expect(ownLogs(fresh, 'peer claimed a better chain but delivered nothing')).toHaveLength(0);
    // Reconnect to a real node: it continues from 16, it does not start over or get stuck.
    skewSeconds += 10;
    await fresh.p2p.connectTo(`127.0.0.1:${established.port}`, 'manual');
    await waitFor(() => fresh.chain.height === 100, 25_000, () => `height 100 (stuck at ${fresh.chain.height})`);
    expect(sameTip(fresh, established)).toBe(true);
    expect(fresh.chain.verifyIntegrity()).toEqual({ ok: true, problems: [] });
    expect(ownLogs(fresh, 'sync started').at(-1)!.fields).toMatchObject({ localHeight: 16 });
  }, 40_000);
});

describe('fork choice', () => {
  it('two nodes on their own forks of EQUAL height converge on the same tip', async () => {
    const a = await startNode({ syncBatch: 8 });
    const b = await startNode({ syncBatch: 8 });
    mineMany(a, 12);
    mineMany(b, 12);
    expect(sameTip(a, b)).toBe(false);
    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => sameTip(a, b), 20_000, 'both nodes to settle on one tip');
    expect(a.chain.height).toBe(12);
  }, 40_000);

  it('a taller fork wins, however far the shorter one has run', async () => {
    const a = await startNode({ syncBatch: 8 });
    const b = await startNode({ syncBatch: 8 });
    mineMany(a, 60);
    mineMany(b, 25);
    const loserTip = b.chain.tip!.hash;
    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => sameTip(a, b), 25_000, 'B to adopt the taller chain');
    expect(b.chain.height).toBe(60);
    expect(b.chain.tip!.hash).not.toBe(loserTip);
  }, 40_000);

  it('a peer advertising a HIGHER chain of LESS weight is not asked for anything; a heavier one is asked, and nothing is adopted unverified', async () => {
    const established = await startNode();
    mineMany(established, 20);
    const fresh = await startNode();
    mineMany(fresh, 10);
    const tip = established.chain.tip!;

    const taller = await scriptedPeer(fresh, established, () => undefined, { height: 500, weight: '1', headHash: 'cd'.repeat(32) });
    await waitFor(() => handshakeDone(fresh), 5_000, 'the handshake');
    await pause(500);
    expect(taller.getblocks).toHaveLength(0); // taller, but lighter than our 10: ignored
    expect(fresh.chain.height).toBe(10);

    const heavier = await scriptedPeer(fresh, established, (request, p) => p.reply(request, [], false), { height: 5, weight: '9999', headHash: 'ef'.repeat(32) });
    await waitFor(() => heavier.getblocks.length > 0, 5_000, 'the request to the heavier claimant');
    await waitFor(() => ownLogs(fresh, 'peer claimed a better chain but delivered nothing').length > 0, 5_000, 'the failed claim to be logged');
    expect(fresh.chain.height).toBe(10);
    expect(fresh.chain.tip!.hash).not.toBe(tip.hash);
  }, 30_000);
});

describe('what stays enforced', () => {
  it('a block with the wrong chain id, parameters hash or transaction root in a synced batch is refused', async () => {
    const established = await startNode();
    mineMany(established, 12);
    const cases: Array<[string, (block: ReturnType<typeof decodeBlock>) => void]> = [
      ['wrong chain id', (block) => (block.header.chainId = 999_999)],
      ['wrong parameters hash', (block) => (block.header.paramsHash = 'cd'.repeat(16))],
      ['tampered transaction root', (block) => (block.header.txRoot = 'ef'.repeat(32))],
    ];
    for (const [label, tamper] of cases) {
      const fresh = await startNode();
      const block = decodeBlock(fromHex(blockHex(established, 1)));
      tamper(block);
      const bad = Buffer.from(encodeBlock(block)).toString('hex');
      await scriptedPeer(fresh, established, (request, p) => p.reply(request, [bad], true));
      await waitFor(() => batchLogs(fresh).length > 0, 10_000, `the ${label} batch to be logged`);
      expect(fresh.chain.height, label).toBe(0);
      expect(batchLogs(fresh)[0]!.rejectedCode, label).toBeTruthy();
    }
  }, 40_000);

  it('a reply larger than the request is malformed, and nothing from it is applied', async () => {
    const established = await startNode();
    mineMany(established, 30);
    const fresh = await startNode({ syncBatch: 8 });
    await scriptedPeer(fresh, established, (request, p) => {
      p.reply(request, Array.from({ length: 9 }, (_, i) => blockHex(established, i + 1)), true);
    });
    await waitFor(() => batchLogs(fresh).length > 0, 10_000, 'the batch to be logged');
    expect(batchLogs(fresh)[0]!.malformed).toBe('batch larger than requested');
    expect(fresh.chain.height).toBe(0);
    expect(scoreOf(fresh)).toBeLessThan(0);
  }, 30_000);

  it('a non-integer `limit` in getblocks is malformed, not NaN', async () => {
    const established = await startNode();
    mineMany(established, 5);
    const peer = await scriptedPeer(established, established, () => undefined, { height: 0, weight: '0', headHash: '' });
    await waitFor(() => handshakeDone(established), 5_000, 'the handshake');
    peer.send({ v: 1, t: 'getblocks', from: 1, limit: 'many' });
    await waitFor(() => scoreOf(established) < 0, 5_000, 'the penalty');
  });
});
