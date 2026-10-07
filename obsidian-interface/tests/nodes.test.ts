/**
 * Node pool.
 *
 * The interface reads whatever a node tells it, so the pool is the component
 * that decides *which* node gets to answer. These tests pin the behaviour that
 * matters when something is wrong: prefer the tallest healthy node, fail over
 * instead of failing, notice when two nodes are on different chains, and never
 * present a dead node as a live one.
 */

import { describe, expect, it } from 'vitest';
import { NodePool, normaliseNodeUrl, type NodeStatusSummary } from '../server/nodes.js';

function status(overrides: Partial<NodeStatusSummary> = {}): NodeStatusSummary {
  return {
    genesisId: 'genesis-abc',
    chainId: 7780,
    networkId: 'obsidian-devnet-1',
    height: 100,
    headHash: 'head-hash',
    syncing: false,
    peers: 3,
    ...overrides,
  };
}

function poolWith(nodes: string[], responses: Record<string, () => Promise<Response>>, options: { failures?: number } = {}) {
  return new NodePool({
    nodes,
    failureThreshold: options.failures ?? 1,
    fetchImpl: (async (input: string | URL | Request) => {
      const url = String(input);
      for (const [prefix, responder] of Object.entries(responses)) {
        if (url.startsWith(prefix)) return responder();
      }
      throw new Error(`no stub for ${url}`);
    }) as typeof fetch,
  });
}

function ok(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }));
}

describe('NodePool', () => {
  it('normalises URLs so the same node cannot be counted twice', () => {
    expect(normaliseNodeUrl('http://127.0.0.1:8630/')).toBe('http://127.0.0.1:8630');
    expect(normaliseNodeUrl('HTTP://NODE.EXAMPLE:8630')).toBe('http://node.example:8630');
    expect(normaliseNodeUrl('node.example:8630')).toBe('http://node.example:8630');
    const pool = new NodePool({ nodes: ['http://a:1', 'http://a:1/', 'http://a:1'] });
    expect(pool.all()).toHaveLength(1);
  });

  it('refuses to treat a non-http scheme as a node', () => {
    expect(() => new NodePool({ nodes: ['file:///etc/passwd'] })).toThrow();
    expect(() => new NodePool({ nodes: ['javascript:alert(1)'] })).toThrow();
  });

  it('marks a node healthy only after a real health check', async () => {
    const pool = poolWith(['http://a:1'], { 'http://a:1': () => ok(status({ height: 250 })) });
    expect(pool.all()[0]!.healthy).toBe(false);
    await pool.checkNow();
    expect(pool.all()[0]!.healthy).toBe(true);
    expect(pool.all()[0]!.height).toBe(250);
  });

  it('prefers the tallest healthy node when several answer', async () => {
    const pool = poolWith(['http://a:1', 'http://b:1', 'http://c:1'], {
      'http://a:1': () => ok(status({ height: 100 })),
      'http://b:1': () => ok(status({ height: 380 })),
      'http://c:1': () => ok(status({ height: 379 })),
    });
    await pool.checkNow();
    expect(pool.pick()?.url).toBe('http://b:1');
    expect(pool.ordered().map((node) => node.url)).toEqual(['http://b:1', 'http://c:1', 'http://a:1']);
  });

  it('honours a preferred node for a single read but does not blacklist the rest', async () => {
    const pool = poolWith(['http://a:1', 'http://b:1'], {
      'http://a:1': () => ok(status({ height: 100 })),
      'http://b:1': () => ok(status({ height: 200 })),
    });
    await pool.checkNow();
    expect(pool.pick({ prefer: 'http://a:1' })?.url).toBe('http://a:1');
    expect(pool.pick({ exclude: ['http://a:1', 'http://b:1'] })).toBeUndefined();
  });

  it('takes a node out of rotation after repeated failures and reports the error', async () => {
    const pool = poolWith(['http://good:1', 'http://broken:1'], {
      'http://good:1': () => ok(status()),
      'http://broken:1': () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await pool.checkNow();
    await pool.checkNow();
    const broken = pool.all().find((node) => node.url === 'http://broken:1')!;
    expect(broken.healthy).toBe(false);
    expect(broken.lastError).toMatch(/ECONNREFUSED/);
    expect(pool.ordered().map((node) => node.url)).not.toContain('http://broken:1');
    expect(pool.pick()?.url).toBe('http://good:1');
  });

  it('rejects an HTTP error response as unhealthy rather than trusting its body', async () => {
    const pool = poolWith(['http://a:1'], {
      'http://a:1': () => Promise.resolve(new Response('{"height":9999999}', { status: 500 })),
    });
    await pool.checkNow();
    expect(pool.all()[0]!.healthy).toBe(false);
    expect(pool.all()[0]!.height).toBe(0);
  });

  it('reports the consensus height as the majority, not the maximum', async () => {
    const pool = poolWith(['http://a:1', 'http://b:1', 'http://c:1'], {
      'http://a:1': () => ok(status({ height: 500 })),
      'http://b:1': () => ok(status({ height: 500 })),
      'http://c:1': () => ok(status({ height: 501 })),
    });
    await pool.checkNow();
    expect(pool.consensusHeight()).toBe(500);
    expect(pool.lagging().map((node) => node.url)).toEqual([]);
  });

  it('flags a node whose genesis id differs instead of silently mixing two chains', async () => {
    const pool = poolWith(['http://a:1', 'http://b:1'], {
      'http://a:1': () => ok(status({ height: 100 })),
      'http://b:1': () => ok(status({ height: 400, genesisId: 'a-different-chain' })),
    });
    await pool.checkNow();
    expect(pool.genesisMismatch).toBe(true);
    // The majority genesis still wins so reads do not silently follow the wrong chain.
    expect(pool.pick()?.url).toBe('http://a:1');
    expect(pool.consensusHeight()).toBe(100);
  });

  it('hides internals from the summary it hands to the browser', async () => {
    const pool = poolWith(['http://a:1'], { 'http://a:1': () => ok(status()) });
    await pool.checkNow();
    const summary = pool.summary()[0]!;
    expect(summary).not.toHaveProperty('successes');
    expect(summary).not.toHaveProperty('failures');
    expect(summary.url).toBe('http://a:1');
  });

  it('reports nothing healthy when every node is down, so the interface can say so', async () => {
    const pool = poolWith(['http://a:1', 'http://b:1'], {
      'http://a:1': () => Promise.reject(new Error('down')),
      'http://b:1': () => Promise.reject(new Error('down')),
    });
    await pool.checkNow();
    expect(pool.pick()).toBeUndefined();
    expect(pool.consensusHeight()).toBeUndefined();
  });

  it('starts and stops its background checks without keeping the process alive', async () => {
    const pool = poolWith(['http://a:1'], { 'http://a:1': () => ok(status()) });
    pool.start(60_000);
    await pool.checkNow();
    expect(pool.all()[0]!.healthy).toBe(true);
    pool.stop();
    pool.stop(); // idempotent
  });
});
