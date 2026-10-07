/**
 * Trusted origins: which browsers a node will answer.
 *
 * The project's own domain (obsmainnet.us.ci and everything beneath it) is trusted by default, and an
 * operator can add more — exact origins or whole-subdomain patterns. The matching is where this goes
 * wrong if it goes wrong, so the lookalikes people actually try are listed here one by one.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { RpcServer } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG, configFromEnv, validateConfig, type NodeConfig } from '../../src/config/config.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { getNetwork } from '../../src/protocol/networks.js';
import {
  OFFICIAL_DOMAIN,
  OFFICIAL_HOSTS,
  OFFICIAL_PATTERNS,
  compileOrigins,
  originMatches,
  parseOriginPattern,
} from '../../src/config/trusted-origins.js';
import { createHarness, type Harness } from '../helpers/harness.js';

const official = (origin: string | undefined) => originMatches(origin, OFFICIAL_PATTERNS);
const listed = (entries: string[], origin: string | undefined) => originMatches(origin, compileOrigins(entries));

describe('the official domain', () => {
  it('trusts the domain, and every subdomain beneath it, over https', () => {
    for (const origin of [
      'https://obsmainnet.us.ci',
      'https://api.obsmainnet.us.ci',
      'https://devnet.obsmainnet.us.ci',
      'https://testnet.obsmainnet.us.ci',
      'https://staging.obsmainnet.us.ci',
      'https://wallet.obsmainnet.us.ci',
      'https://explorer.obsmainnet.us.ci',
      'https://a.b.c.obsmainnet.us.ci',
      'https://x1.obsmainnet.us.ci',
      'HTTPS://API.OBSMAINNET.US.CI', // case does not matter; browsers send it lowercase anyway
      'https://api.obsmainnet.us.ci:443', // the default port, written out
    ]) {
      expect(official(origin), origin).toBe(true);
    }
  });

  it('is not fooled by a lookalike', () => {
    for (const origin of [
      'http://obsmainnet.us.ci', // not https
      'http://api.obsmainnet.us.ci',
      'https://obsmainnet.us.ci.evil.test', // the domain as a prefix
      'https://evilobsmainnet.us.ci', // glued on, no dot
      'https://xobsmainnet.us.ci',
      'https://obsmainnet.us.ci@evil.test', // a user name, not a host
      'https://evil.test/obsmainnet.us.ci', // a path
      'https://obsmainnet.us.ci/',
      'https://obsmainnet.us.ci?x=1',
      'https://obsmainnet.us.ci:8443', // another port is another origin
      'https://obsmainnet.us.ci.',
      'https://.obsmainnet.us.ci',
      'https://-bad.obsmainnet.us.ci',
      'https://a..obsmainnet.us.ci',
      'https://us.ci', // the suffix itself
      'https://ci',
      'https://evil.test',
      'https://%2e.obsmainnet.us.ci',
      'null', // a sandboxed iframe or a file: page
      'not an origin',
      '',
      undefined,
      null,
    ]) {
      expect(official(origin as string | undefined), String(origin)).toBe(false);
    }
  });

  it('lists the five names the project hosts, among the hostnames mainnet advertises', () => {
    expect(OFFICIAL_DOMAIN).toBe('obsmainnet.us.ci');
    expect(OFFICIAL_HOSTS.mainnet).toEqual(expect.arrayContaining(['obsmainnet.us.ci', 'api.obsmainnet.us.ci']));
    expect(OFFICIAL_HOSTS.devnet).toEqual(['devnet.obsmainnet.us.ci']);
    expect(OFFICIAL_HOSTS.testnet).toEqual(['testnet.obsmainnet.us.ci']);
    expect(OFFICIAL_HOSTS.staging).toEqual(['staging.obsmainnet.us.ci']);
    // Every advertised name is one the node trusts, and a network lists none of another's.
    const all = new Set(Object.values(OFFICIAL_HOSTS).flat());
    for (const host of all) expect(official(`https://${host}`), host).toBe(true);
    for (const [network, hosts] of Object.entries(OFFICIAL_HOSTS)) {
      for (const [other, otherHosts] of Object.entries(OFFICIAL_HOSTS)) {
        if (network !== other) expect(hosts.filter((host) => otherHosts.includes(host)), `${network} vs ${other}`).toEqual([]);
      }
    }
  });
});

describe('an operator\'s own list', () => {
  it('matches exact origins, and whole subdomains for a wildcard — never the bare domain, never a prefix', () => {
    const entries = ['https://wallet.example.org', 'https://*.apps.example.org'];
    expect(listed(entries, 'https://wallet.example.org')).toBe(true);
    expect(listed(entries, 'https://one.apps.example.org')).toBe(true);
    expect(listed(entries, 'https://one.two.apps.example.org')).toBe(true);
    expect(listed(entries, 'https://apps.example.org')).toBe(false); // the wildcard is for what is BENEATH it
    expect(listed(entries, 'https://example.org')).toBe(false);
    expect(listed(entries, 'https://other.example.org')).toBe(false);
    expect(listed(entries, 'https://wallet.example.org.evil.test')).toBe(false);
    expect(listed(entries, 'https://notapps.example.org')).toBe(false);
    expect(listed(entries, 'http://wallet.example.org')).toBe(false);
    expect(listed(entries, 'https://wallet.example.org:8443')).toBe(false);
  });

  it('keeps ports and http for exact entries, as it always did', () => {
    expect(listed(['http://localhost:3000'], 'http://localhost:3000')).toBe(true);
    expect(listed(['http://localhost:3000'], 'http://localhost:3001')).toBe(false);
    expect(listed(['http://127.0.0.1:5173'], 'http://127.0.0.1:5173')).toBe(true);
    expect(listed(['https://[::1]:8443'], 'https://[::1]:8443')).toBe(true);
  });

  it('refuses, when the configuration is read, anything that would trust strangers or misread a typo', () => {
    for (const entry of [
      'https://*', // everyone
      'https://*.com', // a whole top-level domain
      'https://*.us.ci', // a domain strangers register under
      'https://*.co.uk',
      'https://*.github.io',
      'https://*.vercel.app',
      'http://*.example.org', // a wildcard is https only
      'https://*.example.*',
      'https://a*.example.org',
      'https://wal*.example.org',
      'https://*.127.0.0.1',
      'https://example.org/path',
      'https://example.org?x=1',
      'https://user@example.org',
      'example.org', // no scheme
      'ftp://example.org',
      'https://',
      'https://bad host.example.org',
      '*',
    ]) {
      expect(() => parseOriginPattern(entry), entry).toThrow(/invalid origin/);
    }
    // ...while a wildcard on a name you own, however deep, is fine.
    expect(() => parseOriginPattern('https://*.example.org')).not.toThrow();
    expect(() => parseOriginPattern('https://*.sub.us.ci')).not.toThrow();
    expect(() => parseOriginPattern('https://*.example.org:8443')).not.toThrow();
  });
});

describe('configuration', () => {
  const base: NodeConfig = { ...DEFAULT_CONFIG, network: 'devnet' };

  it('accepts wildcard origins and rejects a bad one with the reason, not a silent skip', () => {
    expect(() => validateConfig({ ...base, rpcCorsOrigins: ['https://*.example.org', 'https://wallet.example.org', '*'] })).not.toThrow();
    expect(() => validateConfig({ ...base, rpcCorsOrigins: ['https://*.us.ci'] })).toThrow(/invalid CORS origin "https:\/\/\*\.us\.ci".*strangers/);
    expect(() => validateConfig({ ...base, rpcCorsOrigins: ['https://example.org/app'] })).toThrow(/invalid CORS origin/);
  });

  it('trusts the official domain unless told not to', () => {
    expect(DEFAULT_CONFIG.rpcTrustOfficialDomains).toBe(true);
    expect(configFromEnv({ OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS: 'false' }).rpcTrustOfficialDomains).toBe(false);
    expect(configFromEnv({ OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS: 'true' }).rpcTrustOfficialDomains).toBe(true);
    expect(configFromEnv({}).rpcTrustOfficialDomains).toBeUndefined();
  });
});

describe('a node over real HTTP', () => {
  const open: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (open.length > 0) await open.pop()!();
  });

  async function serve(h: Harness, patch: Partial<NodeConfig> = {}) {
    const net = h.net;
    const config: NodeConfig = { ...DEFAULT_CONFIG, network: net.name, rpcPort: 0, rpcHost: '127.0.0.1', rpcRateLimitPerMinute: 0, dataDir: h.dir, ...patch };
    const server = new RpcServer({ chain: h.chain, indexer: new Indexer(h.dir), net, config, genesisId: computeGenesisId(h.chain.genesisDocument, net), log: () => undefined });
    const base = `http://127.0.0.1:${await server.listen()}`;
    open.push(() => server.close());
    return {
      config,
      call: (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init),
    };
  }
  async function harness(network = 'devnet'): Promise<Harness> {
    const h = await createHarness({ network });
    open.push(() => h.close());
    return h;
  }

  it('lets the official domain read it, with no credentials, and says which origin it answered', async () => {
    const { call } = await serve(await harness());
    const response = await call('/status', { headers: { origin: 'https://wallet.obsmainnet.us.ci' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://wallet.obsmainnet.us.ci');
    expect(response.headers.get('vary')).toContain('Origin');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('answers the preflight of an official page', async () => {
    const { call } = await serve(await harness());
    const preflight = await call('/tx/submit', {
      method: 'OPTIONS',
      headers: { origin: 'https://api.obsmainnet.us.ci', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://api.obsmainnet.us.ci');
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('still refuses a stranger, and every lookalike of the official domain', async () => {
    const { call } = await serve(await harness());
    for (const origin of ['https://evil.test', 'https://obsmainnet.us.ci.evil.test', 'https://evilobsmainnet.us.ci', 'http://wallet.obsmainnet.us.ci', 'null']) {
      const response = await call('/status', { headers: { origin } });
      expect(response.status, origin).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_FORBIDDEN');
      expect(response.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('answers a request with no Origin at all, as before (curl, the interface server, a node)', async () => {
    const { call } = await serve(await harness());
    expect((await call('/status')).status).toBe(200);
  });

  it('can be told to trust nobody it was not told about', async () => {
    const { call } = await serve(await harness(), { rpcTrustOfficialDomains: false });
    expect((await call('/status', { headers: { origin: 'https://wallet.obsmainnet.us.ci' } })).status).toBe(403);
  });

  it('adds an operator\'s wildcard to the official domain, and nothing more', async () => {
    const { call } = await serve(await harness(), { rpcCorsOrigins: ['https://*.example.org'] });
    expect((await call('/status', { headers: { origin: 'https://app.example.org' } })).status).toBe(200);
    expect((await call('/status', { headers: { origin: 'https://example.org' } })).status).toBe(403);
    expect((await call('/status', { headers: { origin: 'https://wallet.obsmainnet.us.ci' } })).status).toBe(200);
  });

  it('keeps "*" for the operator who wrote it on purpose', async () => {
    const { call } = await serve(await harness(), { rpcCorsOrigins: ['*'] });
    const response = await call('/status', { headers: { origin: 'https://anything.test' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://anything.test');
  });

  it('answers its own origin without consulting any list', async () => {
    const h = await harness();
    const { call, config } = await serve(h, { rpcTrustOfficialDomains: false });
    void config;
    const port = new URL((await call('/status')).url).port;
    expect((await call('/status', { headers: { origin: `http://127.0.0.1:${port}` } })).status).toBe(200);
  });

  it('names, for each network, its own hostnames and no other network\'s', async () => {
    for (const network of ['devnet', 'testnet', 'staging', 'mainnet']) {
      const { call } = await serve(await harness(network));
      const body = (await (await call('/network')).json()) as { network: { name: string }; domains: string[]; trust: { officialDomains: boolean; patterns: string[] } };
      expect(body.network.name).toBe(network);
      expect(body.domains, network).toEqual([...OFFICIAL_HOSTS[network as keyof typeof OFFICIAL_HOSTS]]);
      for (const other of ['devnet', 'testnet', 'staging', 'mainnet'].filter((name) => name !== network)) {
        for (const host of OFFICIAL_HOSTS[other as keyof typeof OFFICIAL_HOSTS]) expect(body.domains, `${network} must not advertise ${host}`).not.toContain(host);
      }
      expect(body.trust.officialDomains).toBe(true);
      expect(body.trust.patterns).toEqual(['https://obsmainnet.us.ci', 'https://*.obsmainnet.us.ci']);
    }
    expect(getNetwork('mainnet').name).toBe('mainnet');
  });
});
