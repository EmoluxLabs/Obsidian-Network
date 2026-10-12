import { describe, expect, it } from 'vitest';
import { loadInterfaceConfig } from '../server/config.js';
import { PrimaryDiscovery } from '../server/primary-discovery.js';

const load = (env: Record<string, string>) => loadInterfaceConfig([], { OBSIDIAN_NETWORK: 'devnet', ...env } as NodeJS.ProcessEnv, '/tmp');

describe('failover configuration', () => {
  it('reads the lease settings and applies safe defaults', () => {
    const { config } = load({ OBSIDIAN_INTERFACE_LEASE_DIR: '/shared/lease', OBSIDIAN_INTERFACE_ADVERTISE_URL: 'https://a.example/' });
    expect(config.lease).toEqual({ dir: '/shared/lease', ttlMs: 15_000, maxSkewMs: 2_000, advertiseUrl: 'https://a.example' });
  });

  it('is off unless a lease directory is given: a single primary stays a single primary', () => {
    expect(load({}).config.lease).toBeUndefined();
  });

  it('refuses a lease on an edge: an edge must never see the shared account volume', () => {
    expect(() => load({ OBSIDIAN_INTERFACE_ROLE: 'edge', OBSIDIAN_INTERFACE_LEASE_DIR: '/shared/lease' })).toThrow(/edge must never/);
  });

  it('refuses a ttl that is not safe for the stated clock skew, and out-of-range numbers', () => {
    expect(() => load({ OBSIDIAN_INTERFACE_LEASE_DIR: '/x', OBSIDIAN_INTERFACE_LEASE_TTL_MS: '4000', OBSIDIAN_INTERFACE_MAX_CLOCK_SKEW_MS: '1000' })).toThrow(/four times/);
    expect(() => load({ OBSIDIAN_INTERFACE_LEASE_DIR: '/x', OBSIDIAN_INTERFACE_LEASE_TTL_MS: '500' })).toThrow(/3000/);
    expect(() => load({ OBSIDIAN_INTERFACE_LEASE_DIR: '/x', OBSIDIAN_INTERFACE_LEASE_TTL_MS: 'soon' })).toThrow(/integer/);
  });

  it('validates the primary list and the advertised URL (no credentials, http(s) only)', () => {
    expect(() => load({ OBSIDIAN_INTERFACE_PRIMARY_URLS: 'https://u:p@a.example' })).toThrow(/without credentials/);
    expect(() => load({ OBSIDIAN_INTERFACE_PRIMARY_URLS: 'ftp://a.example' })).toThrow(/http\(s\)/);
    expect(() => load({ OBSIDIAN_INTERFACE_ADVERTISE_URL: 'https://a.example,https://b.example' })).toThrow(/one URL/);
    expect(load({ OBSIDIAN_INTERFACE_ROLE: 'edge', OBSIDIAN_INTERFACE_PRIMARY_URLS: 'https://a.example/, https://b.example' }).config.primaryUrls).toEqual(['https://a.example', 'https://b.example']);
  });
});

describe('edge discovery of the current primary', () => {
  const answer = (map: Record<string, { leader?: string } | 'down'>) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error'); // never followed
      const base = String(input).replace('/api/ready', '');
      const entry = map[base];
      if (!entry || entry === 'down') throw new Error('unreachable');
      return new Response(JSON.stringify({ leader: { state: entry.leader ?? 'standby' } }), { status: entry.leader === 'leader' ? 200 : 503 });
    }) as unknown as typeof fetch;

  it('names the one host that reports leader, ignores standbys and unreachable hosts', async () => {
    const d = new PrimaryDiscovery(['http://a', 'http://b', 'http://c'], { fetchImpl: answer({ 'http://a': 'down', 'http://b': { leader: 'leader' }, 'http://c': {} }) });
    await d.probe();
    expect(d.current().url).toBe('http://b');
    expect(d.current().candidates.find((c) => c.url === 'http://a')?.reachable).toBe(false);
  });

  it('names nobody when two hosts both claim leadership (a fault, not a tie to break) or none do', async () => {
    const two = new PrimaryDiscovery(['http://a', 'http://b'], { fetchImpl: answer({ 'http://a': { leader: 'leader' }, 'http://b': { leader: 'leader' } }) });
    await two.probe();
    expect(two.current().url).toBeNull();
    const none = new PrimaryDiscovery(['http://a'], { fetchImpl: answer({ 'http://a': {} }) });
    await none.probe();
    expect(none.current().url).toBeNull();
  });

  it('survives garbage and oversized answers', async () => {
    const evil = (async () => new Response('x'.repeat(100_000))) as unknown as typeof fetch;
    const d = new PrimaryDiscovery(['http://a'], { fetchImpl: evil });
    await d.probe();
    expect(d.current().url).toBeNull();
    expect(d.current().candidates[0]?.reachable).toBe(false);
  });
});
