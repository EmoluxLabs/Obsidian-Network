/**
 * How far finality has got (the finalized height, its lag, the producer count behind it) is shown only to a caller on the
 * node's own machine, like the peer table. Everyone else is not told. Consensus is untouched: the node still computes it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  behindBy: () => 0,
  peerCount: 1,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obsidian-finality-privacy-'));
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


const FIELDS = ['finalizedHeight', 'finalizedHash', 'finalityLag', 'finalityAvailable', 'finalityEligibleProducers', 'finalityQuorum'];
const PROXIED = { 'x-forwarded-for': '203.0.113.50' };

describe('finality is operator detail', () => {
  it('GET /status leaves every finality field out for a proxied caller, and keeps the rest', async () => {
    const reply = await get('127.0.0.1', '/status', PROXIED);
    for (const field of FIELDS) expect(reply.body, field).not.toHaveProperty(field);
    expect(reply.body.height).toBeTypeOf('number');
    expect(reply.body.genesisId).toBeTypeOf('string');
    expect(reply.raw).not.toMatch(/finaliz|finality/i);
  });

  it('GET /status gives the operator on this machine the finality fields', async () => {
    const reply = await get('127.0.0.1', '/status');
    for (const field of FIELDS) expect(reply.body, field).toHaveProperty(field);
  });

  it('GET /finality is a 404 for a proxied caller and the checkpoint for the operator', async () => {
    const proxied = await get('127.0.0.1', '/finality', PROXIED);
    expect(proxied.status).toBe(404);
    expect(proxied.raw).not.toMatch(/finalizedHeight|lag/i);
    const operator = await get('127.0.0.1', '/finality');
    expect(operator.status).toBe(200);
    expect(operator.body).toHaveProperty('finalizedHeight');
  });

  it('GET /readyz drops the finality check and its advisory for a proxied caller, and still says whether the node is ready', async () => {
    const proxied = await get('127.0.0.1', '/readyz', PROXIED);
    expect(proxied.body.checks).not.toHaveProperty('finality');
    expect(proxied.body.advisories).not.toContain('finality-lagging');
    expect(proxied.body.checks.sync).toBeDefined();
    expect(proxied.body.status).toMatch(/ready/);
    expect((await get('127.0.0.1', '/readyz')).body.checks.finality.finalizedHeight).toBeTypeOf('number');
  });

  it('GET /producers leaves the finality block out for a proxied caller', async () => {
    expect((await get('127.0.0.1', '/producers', PROXIED)).body).not.toHaveProperty('finality');
    expect((await get('127.0.0.1', '/producers')).body).toHaveProperty('finality');
  });

  it('JSON-RPC getstatus and getfinality follow the same rule', async () => {
    const status = await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 1, method: 'getstatus' }, PROXIED);
    for (const field of FIELDS) expect(status.body.result, field).not.toHaveProperty(field);
    expect((await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 2, method: 'getfinality' }, PROXIED)).body.result).toBeNull();
    expect((await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 3, method: 'getfinality' })).body.result).toHaveProperty('finalizedHeight');
    expect((await post('127.0.0.1', '/rpc', { jsonrpc: '2.0', id: 4, method: 'getstatus' })).body.result).toHaveProperty('finalizedHeight');
  });

  it.each(['x-forwarded-for', 'x-real-ip', 'forwarded', 'via'])('a request carrying %s is not local, even from loopback', async (header) => {
    expect((await get('127.0.0.1', '/finality', { [header]: '203.0.113.50' })).status).toBe(404);
  });

  it('can be published on purpose, and only on purpose', async () => {
    config.rpcPublicPeerDetail = true;
    try {
      expect((await get('127.0.0.1', '/finality', PROXIED)).status).toBe(200);
      expect((await get('127.0.0.1', '/status', PROXIED)).body).toHaveProperty('finalizedHeight');
    } finally {
      config.rpcPublicPeerDetail = false;
    }
    expect((await get('127.0.0.1', '/finality', PROXIED)).status).toBe(404);
  });
});
