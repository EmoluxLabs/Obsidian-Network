/**
 * /livez and /readyz: the two questions a load balancer, a failover script or an operator asks, kept apart.
 *
 *   /livez   is the process answering?  Always 200 while it can answer at all.
 *   /readyz  should traffic be sent here?  200 only when the node has a chain tip, is not catching up and (when it
 *            is meant to) is listening for peers. Zero peers is reported but is not, by itself, "not ready": a
 *            first node of a new network has none and is exactly where the chain starts.
 *
 * The RPC server is real; only the P2P service is a stub, because the point is how the endpoint reads it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { genesisDocumentFor, genesisId } from '../../src/genesis/initialize.js';
import { Indexer } from '../../src/indexer/indexer.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { RpcServer } from '../../src/rpc/server.js';
import type { P2PService } from '../../src/networking/p2p.js';

const NET = getNetwork('devnet');
let dir: string;
let chain: ChainManager;

interface Stub {
  listening: boolean;
  connected: number;
  behindBy: number;
}

async function serve(stub: Stub | undefined, overrides: Partial<NodeConfig> = {}): Promise<{ base: string; close: () => Promise<void> }> {
  const p2p = stub
    ? ({
        status: () => ({ listening: stub.listening, peers: { connected: stub.connected } }),
        behindBy: () => stub.behindBy,
        peerCount: stub.connected,
        activeConnections: () => [],
        knownPeers: () => [],
      } as unknown as P2PService)
    : undefined;
  const server = new RpcServer({
    chain,
    indexer: new Indexer(dir),
    net: NET,
    config: { ...DEFAULT_CONFIG, network: 'devnet', rpcPort: 0, rpcHost: '127.0.0.1', rpcRateLimitPerMinute: 0, dataDir: dir, ...overrides },
    genesisId: genesisId(chain.genesisDocument, NET),
    log: () => undefined,
    p2p,
  });
  const port = await server.listen();
  return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
}

async function get(base: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obsidian-ready-'));
  chain = new ChainManager({ dataDir: dir, net: NET, genesisDocument: genesisDocumentFor(NET) });
  await chain.init();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('/livez', () => {
  it('answers 200 with no chain, peer or database dependency in the body', async () => {
    const s = await serve({ listening: false, connected: 0, behindBy: 99 });
    try {
      const { status, body } = await get(s.base, '/livez');
      expect(status).toBe(200);
      expect(body.status).toBe('alive');
      expect(Object.keys(body).sort()).toEqual(['status', 'timestamp', 'uptimeSeconds']);
    } finally {
      await s.close();
    }
  });
});

describe('/readyz', () => {
  it('is ready when the chain is up, in sync and listening with peers', async () => {
    const s = await serve({ listening: true, connected: 3, behindBy: 0 });
    try {
      const { status, body } = await get(s.base, '/readyz');
      expect(status).toBe(200);
      expect(body.status).toBe('ready');
      expect(body.degraded).toEqual([]);
      expect(body.checks.p2p.connectedPeers).toBe(3);
    } finally {
      await s.close();
    }
  });

  it('is ready but DEGRADED with zero peers: the first node of a network starts there', async () => {
    const s = await serve({ listening: true, connected: 0, behindBy: 0 });
    try {
      const { status, body } = await get(s.base, '/readyz');
      expect(status).toBe(200);
      expect(body.status).toBe('ready-degraded');
      expect(body.degraded).toEqual(['no-peers']);
    } finally {
      await s.close();
    }
  });

  it('is NOT ready while it is behind its peers, and /livez still answers', async () => {
    const s = await serve({ listening: true, connected: 2, behindBy: 40 });
    try {
      const { status, body } = await get(s.base, '/readyz');
      expect(status).toBe(503);
      expect(body.status).toBe('not-ready');
      expect(body.checks.sync).toMatchObject({ ok: false, syncing: true, behindBy: 40 });
      expect((await get(s.base, '/livez')).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('is NOT ready when the P2P listener failed to start (an isolated node must not receive traffic)', async () => {
    const s = await serve({ listening: false, connected: 0, behindBy: 0 });
    try {
      const { status, body } = await get(s.base, '/readyz');
      expect(status).toBe(503);
      expect(body.checks.p2p).toMatchObject({ ok: false, enabled: true, listening: false });
    } finally {
      await s.close();
    }
  });

  it('does not demand a P2P listener from a node configured without P2P', async () => {
    const s = await serve(undefined, { p2pEnabled: false });
    try {
      const { status, body } = await get(s.base, '/readyz');
      expect(status).toBe(200);
      expect(body.checks.p2p.enabled).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('exposes no address, key or peer list', async () => {
    const s = await serve({ listening: true, connected: 1, behindBy: 0 });
    try {
      const { body } = await get(s.base, '/readyz');
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/obs1|tobs1|privateKey|passphrase|mnemonic/i);
      expect(text).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
    } finally {
      await s.close();
    }
  });
});
