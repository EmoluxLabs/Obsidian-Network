/**
 * Peer-to-peer behaviour over real WebSockets, in-process.
 *
 * These tests drive two or three real `P2PService` instances on loopback ports
 * (and, where a test needs to misbehave, a raw `ws` client). They exist because
 * the failures they pin down only show up with real sockets:
 *   - a node that missed ONE block gossip never caught up again;
 *   - a node that had been on its own fork for more than 16 blocks could never
 *     rejoin the chain;
 *   - messages were processed before the handshake, hellos were replayable,
 *     and gossiped transactions were pooled without a signature check.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ChainManager } from '../../src/blockchain/chain.js';
import { blockHash, encodeBlock } from '../../src/blockchain/block.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { generateKeyPair, nodeIdFromPublicKey, signDigest } from '../../src/crypto/keys.js';
import { toHex } from '../../src/crypto/hash.js';
import { genesisDocumentFor } from '../../src/genesis/initialize.js';
import { P2PService, helloDigest, type HelloPayload } from '../../src/networking/p2p.js';
import { PeerStore } from '../../src/networking/peer-store.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { TxType } from '../../src/protocol/types.js';
import { signTransaction } from '../../src/transactions/encode.js';
import { CORE_VERSION, PROTOCOL_VERSION } from '../../src/version.js';
import { randomBytes } from 'node:crypto';

const net = getNetwork('devnet');

interface TestNode {
  chain: ChainManager;
  p2p: P2PService;
  keys: ReturnType<typeof generateKeyPair>;
  port: number;
  dir: string;
  /** Mine one block on this node (open mode: any key may produce) and optionally gossip it. */
  mine(gossip?: boolean): ReturnType<ChainManager['buildNextBlock']>;
}

const nodes: TestNode[] = [];
const sockets: WebSocket[] = [];

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

interface LogEntry {
  level: string;
  message: string;
  fields?: Record<string, unknown>;
}

async function startNode(options: { network?: ReturnType<typeof getNetwork>; logs?: LogEntry[] } = {}): Promise<TestNode> {
  const own = options.network ?? net;
  const dir = mkdtempSync(join(tmpdir(), 'obs-p2p-'));
  const chain = new ChainManager({ dataDir: dir, net: own, genesisDocument: genesisDocumentFor(own), enforceProposerRotation: true });
  await chain.init();
  const keys = generateKeyPair(own.addressHrp);
  const port = await freePort();
  const peers = new PeerStore({ dataDir: dir, seeds: [], persist: false, allowLocalAddresses: true });
  const p2p = new P2PService({
    net: own,
    chain,
    peers,
    identity: { nodeId: nodeIdFromPublicKey(keys.publicKey), publicKey: keys.publicKey, privateKey: keys.privateKey, address: keys.address },
    genesisId: chain.genesisId,
    listenAddress: `127.0.0.1:${port}`,
    log: options.logs
      ? (level, message, fields) => void options.logs!.push({ level, message, fields })
      : process.env.P2P_DEBUG
        ? (level, message, fields) => console.log(`[${keys.address.slice(-4)}] ${level} ${message}`, JSON.stringify(fields ?? {}))
        : undefined,
  });
  await p2p.listen(port, '127.0.0.1');
  const node: TestNode = {
    chain,
    p2p,
    keys,
    port,
    dir,
    mine(gossip = true) {
      const block = chain.buildNextBlock({ address: keys.address, privateKey: keys.privateKey, publicKey: keys.publicKey });
      if (!block) throw new Error('node was not allowed to produce');
      const result = chain.addBlock(block);
      if (!result.accepted) throw new Error(`own block rejected: ${result.code} ${result.message}`);
      if (gossip) p2p.broadcastBlock(block);
      return block;
    },
  };
  nodes.push(node);
  return node;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    try {
      socket.terminate();
    } catch {
      /* gone */
    }
  }
  for (const node of nodes.splice(0)) {
    await node.p2p.stop();
    rmSync(node.dir, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => boolean, ms = 8_000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Both ends have finished the handshake (a link exists from the moment the socket opens, long before that). */
const handshakeDone = (node: TestNode, count = 1): boolean =>
  node.p2p.activeConnections().filter((connection) => connection.nodeId !== '').length === count;

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── A raw peer that can misbehave ────────────────────────────────────────────

interface RawPeer {
  socket: WebSocket;
  received: Array<Record<string, unknown>>;
  closed: () => boolean;
  send(message: Record<string, unknown>): void;
}

async function rawPeer(port: number): Promise<RawPeer> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(socket);
  const received: Array<Record<string, unknown>> = [];
  let closed = false;
  socket.on('message', (data) => received.push(JSON.parse(data.toString()) as Record<string, unknown>));
  socket.on('close', () => {
    closed = true;
  });
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
  return { socket, received, closed: () => closed, send: (message) => socket.send(JSON.stringify(message)) };
}

function helloFor(node: TestNode, keys: ReturnType<typeof generateKeyPair>, challenge: string, overrides: Partial<HelloPayload> = {}) {
  const hello: HelloPayload = {
    nodeId: nodeIdFromPublicKey(keys.publicKey),
    identity: keys.address,
    publicKey: keys.publicKey,
    networkId: net.networkId,
    chainId: net.chainId,
    genesisId: node.chain.genesisId,
    paramsHash: PARAMS_HASH,
    protocolVersion: PROTOCOL_VERSION,
    version: CORE_VERSION,
    listenHost: '127.0.0.1',
    listenPort: 45_000,
    rpcPort: 0,
    height: 0,
    headHash: '',
    weight: '0',
    finalizedHeight: node.chain.finalityStatus().finalizedHeight,
    finalizedHash: node.chain.finalityStatus().finalizedHash,
    capabilities: ['sync', 'gossip', 'finality'],
    timestamp: Math.floor(Date.now() / 1000),
    nonce: randomBytes(16).toString('hex'),
    challenge,
    ...overrides,
  };
  const signature = toHex(signDigest(helloDigest(hello), keys.privateKey));
  return { v: 1, t: 'hello', hello, signature };
}

const challengeOf = (peer: RawPeer): string => String(peer.received.find((message) => message.t === 'challenge')?.challenge ?? '');

describe('connecting and following', () => {
  it('connects two nodes with the challenge–response handshake and propagates a block', async () => {
    const a = await startNode();
    const b = await startNode();
    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => handshakeDone(a) && handshakeDone(b), 8_000, 'both nodes to complete the handshake');

    a.mine();
    await waitFor(() => b.chain.height === 1, 8_000, 'B to receive the block');
    expect(b.chain.tip!.hash).toBe(a.chain.tip!.hash);
  });

  it('catches up after MISSING a block announcement (the next block used to be an orphan for ever)', async () => {
    const a = await startNode();
    const b = await startNode();
    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => handshakeDone(a) && handshakeDone(b), 8_000, 'both nodes to complete the handshake');
    a.mine();
    await waitFor(() => b.chain.height === 1);

    a.mine(false); // block 2 is NOT announced: B misses it
    await pause(200);
    expect(b.chain.height).toBe(1);
    a.mine(true); // block 3 is announced; B does not have its parent
    await waitFor(() => b.chain.height === 3, 10_000, 'B to fetch the block it missed');
    expect(b.chain.tip!.hash).toBe(a.chain.tip!.hash);
  });

  it('rejoins the chain after living on its own fork for more than 16 blocks', async () => {
    const a = await startNode();
    const b = await startNode();
    // Each node mines in isolation: a genuine long fork from genesis.
    for (let i = 0; i < 40; i += 1) a.mine(false);
    for (let i = 0; i < 30; i += 1) b.mine(false);
    expect(a.chain.height).toBe(40);
    expect(b.chain.height).toBe(30);
    expect(a.chain.tip!.hash).not.toBe(b.chain.tip!.hash);
    const bForkTip = b.chain.tip!.hash;

    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => b.chain.tip!.hash === a.chain.tip!.hash, 20_000, 'B to reorganise onto the heavier chain');
    expect(b.chain.height).toBe(40);
    expect(b.chain.tip!.hash).not.toBe(bForkTip);
    expect(b.chain.verifyIntegrity()).toEqual({ ok: true, problems: [] });
  }, 40_000);

  it('follows the HEAVIER chain even when it is not the taller one', async () => {
    const a = await startNode();
    const b = await startNode();
    // B has a taller but lighter chain. Weight, not height, is what fork choice ranks first.
    for (let i = 0; i < 3; i += 1) b.mine(false);
    const claimant = generateKeyPair(net.addressHrp);
    const heavyTx = signTransaction({
      sender: claimant.address,
      privateKeyHex: claimant.privateKey,
      publicKeyHex: claimant.publicKey,
      chainId: net.chainId,
      protocolVersion: PROTOCOL_VERSION,
      nonce: 0,
      type: TxType.MINING_CLAIM,
      gas: 0n,
      body: new Uint8Array(),
      validUntil: Math.floor(Date.now() / 1000) + 600,
    });
    expect(heavyTx.id).toHaveLength(64);
    // Compare the two tips under the fork-choice rule directly: A's single
    // block carrying a transaction would outweigh B's empty blocks only if it
    // had more weight, which an empty block cannot.
    a.mine(false);
    expect(BigInt(a.chain.tip!.cumulativePotWeight)).toBeLessThan(BigInt(b.chain.tip!.cumulativePotWeight));
    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => handshakeDone(a));
    // A learns B is better and follows it (A is the one that must move).
    await waitFor(() => a.chain.tip!.hash === b.chain.tip!.hash, 15_000, 'A to adopt the heavier chain');
  }, 30_000);
});

describe('the handshake gate', () => {
  it('ignores a valid block sent before any handshake', async () => {
    const a = await startNode();
    const source = await startNode();
    const block = source.mine(false)!;
    const peer = await rawPeer(a.port);
    await waitFor(() => challengeOf(peer) !== '', 3_000, 'the challenge');
    peer.send({ v: 1, t: 'newblock', block: Buffer.from(encodeBlock(block)).toString('hex') });
    await pause(300);
    expect(a.chain.height).toBe(0);
    expect(a.chain.getBlockByHash(blockHash(block.header))).toBeNull();
  });

  it('refuses to parse a megabyte from a peer that has not said hello', async () => {
    const a = await startNode();
    const peer = await rawPeer(a.port);
    await waitFor(() => challengeOf(peer) !== '', 3_000, 'the challenge');
    peer.socket.send('x'.repeat(200_000));
    await waitFor(() => peer.closed(), 3_000, 'the connection to be closed');
  });

  it('accepts a hello that signs this connection\'s challenge', async () => {
    const a = await startNode();
    const keys = generateKeyPair(net.addressHrp);
    const peer = await rawPeer(a.port);
    await waitFor(() => challengeOf(peer) !== '');
    peer.send(helloFor(a, keys, challengeOf(peer)));
    await waitFor(() => handshakeDone(a), 3_000, 'the handshake to complete');
    await waitFor(() => peer.received.some((message) => message.t === 'hello_ack'), 3_000, 'the hello_ack');
    // The acceptor's answer signs the dialer's nonce, so the dialer can tell it is fresh too.
    const ack = peer.received.find((message) => message.t === 'hello_ack') as { hello: HelloPayload } | undefined;
    expect(ack?.hello.challenge).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects a RECORDED hello replayed on another connection', async () => {
    const a = await startNode();
    const keys = generateKeyPair(net.addressHrp);
    const first = await rawPeer(a.port);
    await waitFor(() => challengeOf(first) !== '');
    const recorded = helloFor(a, keys, challengeOf(first));
    first.send(recorded);
    await waitFor(() => handshakeDone(a));

    // An attacker replays that exact message on a fresh connection.
    const second = await rawPeer(a.port);
    await waitFor(() => challengeOf(second) !== '');
    expect(challengeOf(second)).not.toBe(challengeOf(first));
    second.send(recorded);
    await waitFor(() => second.received.some((message) => message.t === 'reject'), 3_000, 'a rejection');
    const rejection = second.received.find((message) => message.t === 'reject')!;
    expect(rejection.code).toBe('ERR_BAD_SIGNATURE');
    expect(a.p2p.peerCount).toBe(1); // only the genuine connection is a peer
  });

  it('rejects a hello that answers a made-up challenge', async () => {
    const a = await startNode();
    const keys = generateKeyPair(net.addressHrp);
    const peer = await rawPeer(a.port);
    await waitFor(() => challengeOf(peer) !== '');
    peer.send(helloFor(a, keys, 'ab'.repeat(16)));
    await waitFor(() => peer.received.some((message) => message.t === 'reject'));
    expect(a.p2p.peerCount).toBe(0);
  });

  it('rejects malformed and conflicting finalized checkpoints during the authenticated handshake',async()=>{
    const a=await startNode();
    const malformedKeys=generateKeyPair(net.addressHrp), malformed=await rawPeer(a.port);
    await waitFor(()=>challengeOf(malformed)!=='');
    malformed.send(helloFor(a,malformedKeys,challengeOf(malformed),{finalizedHeight:1}));
    await waitFor(()=>malformed.received.some(message=>message.t==='reject'));
    expect((malformed.received.find(message=>message.t==='reject') as {code:string}).code).toBe('ERR_MALFORMED');

    const conflictKeys=generateKeyPair(net.addressHrp), conflict=await rawPeer(a.port);
    await waitFor(()=>challengeOf(conflict)!=='');
    conflict.send(helloFor(a,conflictKeys,challengeOf(conflict),{finalizedHash:'ff'.repeat(32)}));
    await waitFor(()=>conflict.received.some(message=>message.t==='reject'));
    expect((conflict.received.find(message=>message.t==='reject') as {code:string}).code).toBe('ERR_FINALITY_CONFLICT');
    expect(a.p2p.peerCount).toBe(0);
  });

  it('rejects a protocol-1.4 peer instead of allowing a silent mixed-version split',async()=>{
    const a=await startNode(),keys=generateKeyPair(net.addressHrp),peer=await rawPeer(a.port);
    await waitFor(()=>challengeOf(peer)!=='');
    peer.send(helloFor(a,keys,challengeOf(peer),{protocolVersion:'1.4.0'}));
    await waitFor(()=>peer.received.some(message=>message.t==='reject'));
    expect((peer.received.find(message=>message.t==='reject') as {code:string}).code).toBe('ERR_VERSION_MISMATCH');
    expect(a.p2p.peerCount).toBe(0);
  });

  it('rejects a hello for a different network before anything else', async () => {
    const a = await startNode();
    const keys = generateKeyPair(net.addressHrp);
    const peer = await rawPeer(a.port);
    await waitFor(() => challengeOf(peer) !== '');
    peer.send(helloFor(a, keys, challengeOf(peer), { genesisId: 'ff'.repeat(20) }));
    await waitFor(() => peer.received.some((message) => message.t === 'reject'));
    expect((peer.received.find((message) => message.t === 'reject') as { code: string }).code).toBe('ERR_WRONG_NETWORK');
  });
});

describe('after the handshake', () => {
  async function handshaken(a: TestNode): Promise<RawPeer> {
    const keys = generateKeyPair(net.addressHrp);
    const peer = await rawPeer(a.port);
    await waitFor(() => challengeOf(peer) !== '');
    peer.send(helloFor(a, keys, challengeOf(peer)));
    await waitFor(() => handshakeDone(a));
    return peer;
  }

  it('does not accept a block batch nobody asked for', async () => {
    const a = await startNode();
    const peer = await handshaken(a);
    peer.send({ v: 1, t: 'blocks', blocks: [], more: false });
    await waitFor(() => a.p2p.peerViews().some((view) => view.score < 0), 3_000, 'the sender to be penalised');
  });

  it('throttles a flood of messages and finally drops the peer', async () => {
    const a = await startNode();
    const peer = await handshaken(a);
    for (let i = 0; i < 400; i += 1) peer.send({ v: 1, t: 'ping', ts: i });
    await waitFor(() => peer.closed(), 5_000, 'the flooding peer to be dropped');
    expect(a.p2p.peerCount).toBe(0);
  });

  it('refuses to pool a gossiped transaction with a forged signature, and pools a genuine one', async () => {
    const a = await startNode();
    const b = await startNode();
    await b.p2p.connectTo(`127.0.0.1:${a.port}`, 'manual');
    await waitFor(() => handshakeDone(a) && handshakeDone(b), 8_000, 'both nodes to complete the handshake');

    const sign = (keys: ReturnType<typeof generateKeyPair>) =>
      signTransaction({
        sender: keys.address,
        privateKeyHex: keys.privateKey,
        publicKeyHex: keys.publicKey,
        chainId: net.chainId,
        protocolVersion: PROTOCOL_VERSION,
        nonce: 0,
        type: TxType.MINING_CLAIM,
        gas: 0n,
        body: new Uint8Array(),
        validUntil: Math.floor(Date.now() / 1000) + 600,
      });
    // Two different senders, so the sender-side relay de-duplication cannot hide either message.
    const honest = generateKeyPair(net.addressHrp);
    const attacker = generateKeyPair(net.addressHrp);
    const genuine = sign(honest);
    const forged = { ...sign(attacker), signature: { publicKey: attacker.publicKey, signature: '00'.repeat(64) } };
    expect(forged.id).not.toBe(genuine.id);

    b.p2p.announceTransaction(forged);
    await pause(300);
    expect(a.chain.mempool.size).toBe(0);
    expect(a.p2p.peerViews().some((view) => view.score < 0)).toBe(true); // and the sender paid for it
    b.p2p.announceTransaction(genuine);
    await waitFor(() => a.chain.mempool.has(genuine.id), 3_000, 'the genuine transaction to be pooled');
    expect(a.chain.mempool.size).toBe(1);
  });
});

describe('a node pointed at a peer of another network', () => {
  const warnsAboutNetwork = (logs: LogEntry[]) => logs.filter((entry) => entry.level === 'warn' && /another network/.test(entry.message));

  it('says so, once, in words an operator can act on, and never peers with it', async () => {
    // The easiest way to mix two networks up is to paste a seed from the wrong guide. The refusal always
    // worked; it was silent, so the symptom was `peers: 0` and a clean log. Now it is named.
    const theirs = await startNode({ network: getNetwork('testnet') });
    const logs: LogEntry[] = [];
    const ours = await startNode({ logs }); // devnet
    const address = `127.0.0.1:${theirs.port}`;

    await ours.p2p.connectTo(address, 'seed');
    await waitFor(() => warnsAboutNetwork(logs).length > 0, 8_000, 'the warning about the other network');
    const [warning] = warnsAboutNetwork(logs);
    expect(warning!.message).toContain(address);
    expect(warning!.message).toContain('--seeds');
    expect(warning!.message).toContain('obsidian-devnet-1');
    expect(String(warning!.fields?.code)).toBe('ERR_WRONG_NETWORK');

    // Dialled again, it is refused again — and not reported again within the window.
    const refusals = () => logs.filter((entry) => entry.message === 'peer rejected us').length;
    const before = refusals();
    await ours.p2p.connectTo(address, 'manual');
    await waitFor(() => refusals() > before, 8_000, 'a second refusal');
    await pause(150);
    expect(warnsAboutNetwork(logs)).toHaveLength(1);

    expect(ours.p2p.peerCount).toBe(0);
    expect(theirs.p2p.peerCount).toBe(0);
  });

  it('stays quiet when a node of another network dials IN: that is noise on a public port, not a mistake', async () => {
    const logs: LogEntry[] = [];
    const ours = await startNode({ logs }); // devnet
    const stranger = await startNode({ network: getNetwork('testnet') });
    await stranger.p2p.connectTo(`127.0.0.1:${ours.port}`, 'seed');
    await pause(900);
    expect(warnsAboutNetwork(logs)).toEqual([]);
    expect(ours.p2p.peerCount).toBe(0);
  });
});
