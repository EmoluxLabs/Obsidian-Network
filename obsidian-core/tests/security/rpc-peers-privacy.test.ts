/**
 * `/peers` shows who a node is connected to. That is a map of the network, so it is shown only to a caller on the
 * node's own machine (what `obsidian peers` and the desktop app are), and everyone else gets counts.
 * `/gate` is the public description of the live mining gate issuer set.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ChainManager } from '../../src/blockchain/chain.js';
import { Indexer } from '../../src/indexer/indexer.js';
import { RpcServer } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { GATE_ISSUER } from '../helpers/harness.js';

const NET = getNetwork('devnet');
const SECRET_ADDRESS = 'ws://198.51.100.7:38631';
let dir: string;
let chain: ChainManager;
let server: RpcServer;
let port: number;
let config: NodeConfig;

const fakeP2p = {
  status: () => ({
    nodeId: 'n'.repeat(40),
    name: 'test',
    identity: 'tobs1x',
    listening: true,
    endpoint: 'ws://203.0.113.9:38631',
    peers: { connected: 1, inbound: 0, outbound: 1, pendingHandshakes: 0, known: 1, height: 3 },
    lastError: `dial ${SECRET_ADDRESS} failed`,
  }),
  activeConnections: () => [{ address: SECRET_ADDRESS, nodeId: 'p'.repeat(40), inbound: false, height: 3, version: '1.8.0' }],
  knownPeers: () => [{ address: SECRET_ADDRESS, nodeId: 'p'.repeat(40), identity: 'x', height: 3, version: '1.8.0', lastSeen: 1, score: 0 }],
  announcement: () => ({ descriptor: { endpoint: SECRET_ADDRESS }, signature: 'sig' }),
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obsidian-peers-privacy-'));
  chain = new ChainManager({
    dataDir: dir,
    net: NET,
    genesisDocument: { networkId: NET.networkId, chainId: NET.chainId, protocolVersion: PROTOCOL_VERSION, timestamp: 1_767_225_600, note: 'peers privacy', miningGatePublicKeys: [GATE_ISSUER.publicKey] },
  });
  await chain.init();
  config = { ...DEFAULT_CONFIG, network: 'devnet', rpcPort: 0, rpcHost: '0.0.0.0', rpcCorsOrigins: [], rpcRateLimitPerMinute: 0, dataDir: dir };
  server = new RpcServer({
    chain,
    indexer: new Indexer(dir),
    net: NET,
    config,
    genesisId: computeGenesisId(chain.genesisDocument, NET),
    log: () => undefined,
    p2p: fakeP2p as never,
  });
  port = await server.listen();
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function post(host: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({ host, port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function get(host: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, path, headers }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw), raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('/peers', () => {
  it('shows full detail to a caller on this machine', async () => {
    const reply = await get('127.0.0.1', '/peers');
    expect(reply.body.detail).toBe('full');
    expect(reply.body.connected[0].address).toBe(SECRET_ADDRESS);
    expect(reply.body.known).toHaveLength(1);
  });

  it.each(['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via'])(
    'shows counts only when the request carries %s, even from loopback (a proxy on the same host)',
    async (header) => {
      const reply = await get('127.0.0.1', '/peers', { [header]: '203.0.113.50' });
      expect(reply.body.detail).toBe('counts-only');
      expect(reply.body.connected).toEqual([]);
      expect(reply.body.known).toEqual([]);
      expect(reply.body.p2p.peers.connected).toBe(1);
      expect(reply.raw).not.toContain('198.51.100.7');
      expect(reply.raw).not.toContain('p'.repeat(40));
      expect(reply.body.p2p.lastError).toBe('withheld');
    },
  );

  const external = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  it.skipIf(!external)('shows counts only to a caller from another address', async () => {
    const reply = await get(external!, '/peers');
    expect(reply.body.detail).toBe('counts-only');
    expect(reply.raw).not.toContain('198.51.100.7');
  });

  it('can be published on purpose, and only on purpose', async () => {
    config.rpcPublicPeerDetail = true;
    try {
      const reply = await get('127.0.0.1', '/peers', { 'x-forwarded-for': '203.0.113.50' });
      expect(reply.body.detail).toBe('full');
      expect(reply.body.connected).toHaveLength(1);
    } finally {
      config.rpcPublicPeerDetail = false;
    }
    expect((await get('127.0.0.1', '/peers', { 'x-forwarded-for': '203.0.113.50' })).body.detail).toBe('counts-only');
  });
});

// Everything that could hand a stranger the network's topology: the address of a peer, a peer's node id, this node's own
// advertised endpoint or the text of a recent connection error (which names an address).
const LEAKS = ['198.51.100.7', '203.0.113.9', 'p'.repeat(40), 'n'.repeat(40)];
const PROXIED = { 'x-forwarded-for': '203.0.113.50' };

describe('no public route lists, or leaks, a peer', () => {
  it.each(['/nodes', '/peers', '/status', '/health', '/', '/readyz', '/livez', '/network', '/version', '/params', '/metrics'])(
    '%s carries no peer address, node id or advertised endpoint for a proxied caller',
    async (path) => {
      const reply = await new Promise<string>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, headers: PROXIED }, (res) => {
          let raw = '';
          res.on('data', (d) => (raw += d));
          res.on('end', () => resolve(raw));
        });
        req.on('error', reject);
        req.end();
      });
      for (const leak of LEAKS) expect(reply, `${path} must not contain ${leak}`).not.toContain(leak);
    },
  );

  it('GET /nodes answers a proxied caller with an empty directory, not an error', async () => {
    const reply = await get('127.0.0.1', '/nodes', PROXIED);
    expect(reply.status).toBe(200);
    expect(reply.body.self).toBeNull();
    expect(reply.body.peers).toEqual([]);
    expect(reply.body.detail).toBe('counts-only');
  });

  it('GET /nodes still serves the operator on this machine, so internal discovery keeps working', async () => {
    const reply = await get('127.0.0.1', '/nodes');
    expect(reply.status).toBe(200);
    expect(reply.body.self.descriptor.endpoint).toBe(SECRET_ADDRESS);
    expect(reply.body.peers).toHaveLength(1);
    expect(reply.body.peers[0].address).toBe(SECRET_ADDRESS);
  });

  it('GET /status gives a proxied caller peer COUNTS and nothing else about the P2P layer', async () => {
    const reply = await get('127.0.0.1', '/status', PROXIED);
    expect(reply.body.p2p.peers.connected).toBe(1);
    expect(reply.body.p2p.nodeId).toBeUndefined();
    expect(reply.body.p2p.endpoint).toBeUndefined();
    expect(reply.body.p2p.identity).toBeUndefined();
    expect(reply.body.p2p.lastError).toBe('withheld');
  });

  it('GET /status still gives the operator the full P2P status (the health tooling reads it)', async () => {
    const reply = await get('127.0.0.1', '/status');
    expect(reply.body.p2p.endpoint).toBe('ws://203.0.113.9:38631');
    expect(reply.body.p2p.lastError).toContain(SECRET_ADDRESS);
  });

  it.each(['getpeers', 'getnodes'])('JSON-RPC %s is empty for a proxied caller and full for the operator', async (method) => {
    const proxied = await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 1, method }, PROXIED);
    expect(proxied.status).toBe(200);
    expect(proxied.body.error).toBeUndefined();
    expect(proxied.body.result === null || (Array.isArray(proxied.body.result) && proxied.body.result.length === 0)).toBe(true);
    for (const leak of LEAKS) expect(proxied.raw).not.toContain(leak);
    const operator = await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 2, method });
    expect(operator.raw).toContain('198.51.100.7');
  });

  it('can be published on purpose, for every peer route at once, and only on purpose', async () => {
    config.rpcPublicPeerDetail = true;
    try {
      expect((await get('127.0.0.1', '/nodes', PROXIED)).body.peers).toHaveLength(1);
      expect((await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 3, method: 'getpeers' }, PROXIED)).body.result).toHaveLength(1);
      expect((await get('127.0.0.1', '/status', PROXIED)).body.p2p.endpoint).toBe('ws://203.0.113.9:38631');
    } finally {
      config.rpcPublicPeerDetail = false;
    }
    expect((await get('127.0.0.1', '/nodes', PROXIED)).body.peers).toEqual([]);
  });
});

describe('/gate', () => {
  it('publishes the live issuer set, the epoch, the quorum and the revoked keys to everyone', async () => {
    const reply = await get('127.0.0.1', '/gate', { 'x-forwarded-for': '203.0.113.50' });
    expect(reply.status).toBe(200);
    expect(reply.body.issuerKeys).toEqual([GATE_ISSUER.publicKey]);
    expect(reply.body.genesisKeys).toEqual([GATE_ISSUER.publicKey]);
    expect(reply.body.revokedKeys).toEqual([]);
    expect(reply.body.epoch).toBe(0);
    expect(reply.body.quorum).toBe(1);
    expect(reply.body.open).toBe(true);
    expect(reply.body.networkId).toBe(NET.networkId);
    expect(reply.body.chainId).toBe(NET.chainId);
    expect(typeof reply.body.protocolTime).toBe('number');
    expect(reply.raw).not.toMatch(/privateKey|secret/i);
  });
});
