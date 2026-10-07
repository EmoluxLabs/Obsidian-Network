/**
 * Interface hardening, over real HTTP.
 *
 * Every test here corresponds to a way the interface could be abused or could
 * mislead, found by the pre-launch audit:
 *   - a proxy that checked one string and forwarded another;
 *   - password hashing that froze the whole process;
 *   - login that answered in a different TIME for registered and unregistered
 *     addresses, and that let a wrong TOTP code be retried without limit;
 *   - registration that told strangers which Gmail addresses have accounts;
 *   - a recovered account whose old sessions stayed signed in;
 *   - an interface that did not know which network it was serving.
 */

import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { InterfaceServer, isCleanProxyPath, type InterfaceConfig } from '../server/index.js';
import { AccountStore } from '../server/store.js';
import { newGenesisInvitation } from '../server/genesis-invite.js';
import { NodePool } from '../server/nodes.js';
import { loadInterfaceConfig, validateInterfaceConfig } from '../server/config.js';
import { INTERFACE_NETWORKS } from '../server/networks.js';
import { KeyedLimiter } from '../server/rate-limit.js';
import { NETWORKS } from '../web/core/protocol/networks.js';

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-hardening-'));
  dirs.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const PASSWORD = 'correct-horse-7-battery';
const mailbox = (name: string): string => `${name.toLowerCase().replace(/[^a-z0-9]/g, '')}-tester@gmail.com`;

function totpNow(secret: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Math.floor(Date.now() / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

interface Harness {
  origin: string;
  config: InterfaceConfig;
  store: AccountStore;
  server: InterfaceServer;
  nodeRequests: string[];
  genesisCode: string;
  register: (name: string, extra?: Record<string, unknown>) => Promise<Response>;
  json: (path: string, body: unknown, headers?: Record<string, string>) => Promise<Response>;
}

const running: Array<{ close: () => Promise<void>; node: Server }> = [];

async function start(overrides: Partial<InterfaceConfig> = {}, nodeNetwork = { networkId: 'obsidian-devnet-1', chainId: 7780 }): Promise<Harness> {
  const genesis = newGenesisInvitation();
  const publicDir = join(scratch(), 'public');
  const coreDir = join(scratch(), 'core');
  const siteRoot = scratch();
  for (const dir of [publicDir, coreDir, join(siteRoot, 'landing')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(siteRoot, 'landing', 'index.html'), '<!doctype html><title>landing</title>', 'utf8');
  writeFileSync(join(publicDir, 'app.js'), 'export {};', 'utf8');

  const nodeRequests: string[] = [];
  const node = createServer((request, response) => {
    nodeRequests.push(`${request.method} ${request.url}`);
    const send = (status: number, body: unknown): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (request.url === '/status') {
      send(200, { height: 7, headHash: 'ab', genesisId: 'genesis-x', ...nodeNetwork, syncing: false, peers: 1 });
    } else if (request.url === '/names') {
      send(200, { names: [], count: 0 });
    } else if (request.url?.startsWith('/names/')) {
      send(200, { receivedUrl: request.url });
    } else if (request.url === '/secret' || request.url === '/metrics') {
      send(200, { leaked: request.url });
    } else {
      send(404, { error: 'not found' });
    }
  });
  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', () => resolve()));
  const nodePort = (node.address() as { port: number }).port;

  const config: InterfaceConfig = {
    network: 'devnet',
    host: '127.0.0.1',
    port: 0,
    siteRoot,
    publicDir,
    coreDir,
    dataDir: scratch(),
    nodeUrls: [`http://127.0.0.1:${nodePort}`],
    allowedOrigins: [],
    maxInvitesPerAccount: 5,
    genesisInviteHash: genesis.hash,
    trustProxy: false,
    logLevel: 'error',
    ...overrides,
  };
  const store = new AccountStore({ dataDir: config.dataDir });
  const server = new InterfaceServer({ config, store });
  const port = await server.listen();
  await server.pool.checkNow();
  const origin = `http://127.0.0.1:${port}`;
  running.push({ close: () => server.close(), node });
  const json = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return {
    origin,
    config,
    store,
    server,
    nodeRequests,
    genesisCode: genesis.code,
    json,
    register: (name, extra = {}) => json('/api/auth/register', { email: mailbox(name), password: PASSWORD, displayName: name, ...extra }),
  };
}

afterEach(async () => {
  while (running.length > 0) {
    const item = running.pop()!;
    await item.close();
    await new Promise<void>((resolve) => item.node.close(() => resolve()));
  }
});

const cookieOf = (response: Response): string => (response.headers.get('set-cookie') ?? '').split(';')[0]!;

// ── the proxy ────────────────────────────────────────────────────────────────

describe('the node proxy forwards what it checked', () => {
  it('decides on the path a node will actually resolve', () => {
    for (const bad of [
      '/tx/../metrics',
      '/names/../secret',
      '/names/%2e%2e/secret',
      '/names/%2E%2E/secret',
      '/names/..%2fsecret',
      '/names/..%5csecret',
      '/names//secret',
      '/names\\secret',
      '/names/a\u0000b',
      'names',
      '',
    ]) {
      expect(isCleanProxyPath(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const good of ['/status', '/names', '/names/alice', '/names/hello%20world', '/block/12', '/wallet/dobs1qqqqqqqq/next-nonce', '/nodes/registry']) {
      expect(isCleanProxyPath(good), good).toBe(true);
    }
  });

  it('never lets a dot segment turn an allowed prefix into a route the interface does not expose', async () => {
    const h = await start();
    for (const path of ['/tx/../secret', '/names/../metrics', '/names/%2e%2e/secret', '/block/..%2fsecret']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(path)}`);
      expect(response.status, path).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_REJECTED');
    }
    expect(h.nodeRequests.filter((line) => /secret|metrics/.test(line))).toEqual([]);
  });

  it('still forwards ordinary reads, including ones that need percent-encoding', async () => {
    const h = await start();
    const names = await fetch(`${h.origin}/api/rpc?path=/names`);
    expect(names.status).toBe(200);
    const encoded = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent('/names/hello%20world')}`);
    expect(encoded.status).toBe(200);
    expect(((await encoded.json()) as { receivedUrl: string }).receivedUrl).toBe('/names/hello%20world');
  });
});

// ── rate limits ──────────────────────────────────────────────────────────────

describe('costly routes are rationed per client', () => {
  it('limits sign-in attempts per address, and the answer says when to retry', async () => {
    const h = await start({ rateLimits: { auth: [3, 0.001] } });
    const attempt = () => h.json('/api/auth/login', { email: mailbox('nobody'), password: PASSWORD });
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(((await blocked.json()) as { code: string }).code).toBe('ERR_RATE_LIMITED');
  });

  it('limits the node proxy, and lets an operator-visible refresh through only occasionally', async () => {
    const h = await start({ rateLimits: { proxy: [4, 0.001], refresh: [1, 0.001] } });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await fetch(`${h.origin}/api/rpc?path=/names`)).status);
    expect(statuses.slice(0, 4)).toEqual([200, 200, 200, 200]);
    expect(statuses.slice(4)).toEqual([429, 429]);
    const first = await fetch(`${h.origin}/api/nodes/refresh`, { method: 'POST' });
    const second = await fetch(`${h.origin}/api/nodes/refresh`, { method: 'POST' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(429);
  });

  it('behind a trusted proxy each real client has its own budget, and prepending addresses buys nothing', async () => {
    const h = await start({ trustProxy: true, rateLimits: { auth: [2, 0.001] } });
    const attempt = (xff: string) => h.json('/api/auth/login', { email: mailbox('nobody'), password: PASSWORD }, { 'x-forwarded-for': xff });
    expect((await attempt('198.51.100.1')).status).toBe(401);
    expect((await attempt('198.51.100.1')).status).toBe(401);
    expect((await attempt('198.51.100.1')).status).toBe(429);
    expect((await attempt('198.51.100.2')).status).toBe(401); // somebody else is unaffected
    expect((await attempt('203.0.113.9, 198.51.100.1')).status).toBe(429); // the LAST entry is the proxy's
  });

  it('the limiter itself refills with time and forgets clients that are quiet', () => {
    const clock = { now: 0 };
    const limiter = new KeyedLimiter(2, 1, () => clock.now);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
    expect(limiter.retryAfterSeconds('a')).toBe(1);
    clock.now += 1_000;
    expect(limiter.allow('a')).toBe(true);
    clock.now += 60_000;
    limiter.sweep();
    expect(limiter.size).toBe(0);
  });
});

// ── hashing must not freeze the process ──────────────────────────────────────

describe('password hashing does not block the interface', () => {
  it('keeps the event loop responsive while an account is being registered', async () => {
    const h = await start();
    // Eleven scrypt hashes per registration. Run blocking, that is most of a
    // second in which this process answers nobody. Sample the event loop's lag
    // while one registration is in flight.
    let worst = 0;
    let last = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      worst = Math.max(worst, now - last - 10);
      last = now;
    }, 10);
    const started = Date.now();
    const response = await h.register('founder', { inviteCode: h.genesisCode });
    const elapsed = Date.now() - started;
    clearInterval(timer);
    expect(response.status).toBe(200);
    // Hosted runners can deschedule a healthy process for several hundred
    // milliseconds (532 ms was observed while the async implementation was in
    // use). Keep an absolute ceiling, but also compare with total registration
    // time: a synchronous regression blocks for almost the entire operation.
    expect(worst, `the event loop stalled for ${worst} ms`).toBeLessThan(750);
    expect(worst / elapsed, `event-loop stall ${worst} ms of ${elapsed} ms`).toBeLessThan(0.8);
  }, 30_000);
});

// ── login: timing, MFA lockout, enumeration ──────────────────────────────────

describe('sign-in', () => {
  it('takes as long for an address that has no account as for a wrong password', async () => {
    const h = await start();
    await h.register('founder', { inviteCode: h.genesisCode });
    const time = async (email: string): Promise<number> => {
      const started = performance.now();
      await h.json('/api/auth/login', { email, password: 'definitely-the-wrong-1' });
      return performance.now() - started;
    };
    await time(mailbox('founder')); // warm up
    const real: number[] = [];
    const missing: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      real.push(await time(mailbox('founder')));
      missing.push(await time(mailbox(`ghost${i}`)));
    }
    const average = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    // An unknown address used to be refused instantly (~1 ms) while a wrong
    // password cost a full scrypt (~70 ms): the response time listed the
    // registered addresses even though the response text did not.
    expect(average(missing), `unknown ${average(missing)} ms vs registered ${average(real)} ms`).toBeGreaterThan(average(real) * 0.5);
    expect(average(missing)).toBeGreaterThan(15);
  }, 60_000);

  it('counts a wrong MFA code as a failed attempt and locks the account — it used to cost the guesser nothing', async () => {
    const h = await start();
    const registered = await h.register('founder', { inviteCode: h.genesisCode });
    const cookie = cookieOf(registered);
    const setup = (await (await fetch(`${h.origin}/api/auth/mfa/setup`, { method: 'POST', headers: { cookie } })).json()) as { secret: string };
    const confirm = await h.json('/api/auth/mfa/confirm', { totp: totpNow(setup.secret) }, { cookie });
    expect(confirm.status).toBe(200);

    // Someone who HAS the password tries codes.
    const guess = (code: string) => h.json('/api/auth/login', { email: mailbox('founder'), password: PASSWORD, totp: code });
    let lastStatus = 0;
    for (let i = 0; i < 10; i += 1) lastStatus = (await guess(String(100_000 + i))).status;
    expect(lastStatus).toBe(401);
    const locked = await guess('123456');
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { code: string }).code).toBe('ERR_TOO_MANY_ATTEMPTS');
    // ...and even the correct code is refused while it is locked.
    expect((await guess(totpNow(setup.secret))).status).toBe(429);
  }, 120_000);
});

describe('registration', () => {
  it('does not tell a stranger which Gmail addresses already have an account', async () => {
    const h = await start();
    await h.register('founder', { inviteCode: h.genesisCode });
    // No invitation, a made-up one, and a Genesis-shaped one: none of them may be
    // told "that address is taken".
    for (const inviteCode of [undefined, 'NOT-A-REAL-CODE-1234', 'OBS-GENESIS-AAAA']) {
      const response = await h.register('founder', { inviteCode });
      const body = (await response.json()) as { code: string };
      expect(body.code, `invite ${String(inviteCode)}`).not.toBe('ERR_EMAIL_IN_USE');
      expect(response.status).toBe(403);
    }
  }, 60_000);

  it('does not hash a password for a request that was never going to be admitted', async () => {
    const h = await start();
    const started = performance.now();
    for (let i = 0; i < 6; i += 1) {
      const response = await h.register(`stranger${i}`, { inviteCode: 'NOT-A-REAL-CODE-1234' });
      expect(response.status).toBe(403);
    }
    // Six refused registrations used to cost ~66 hashes (~5 s). Refused before hashing they are instant.
    expect(performance.now() - started).toBeLessThan(1_500);
  }, 30_000);

  it('still tells someone who holds a usable invitation that the address is taken', async () => {
    const h = await start();
    const founder = await h.register('founder', { inviteCode: h.genesisCode });
    const cookie = cookieOf(founder);
    const invite = (await (await h.json('/api/auth/invites', {}, { cookie })).json()) as { invite: { code: string } };
    const response = await h.register('founder', { inviteCode: invite.invite.code });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_EMAIL_IN_USE');
  }, 60_000);
});

// ── recovery and sessions ────────────────────────────────────────────────────

describe('recovering an account', () => {
  it('ends every session that was open before, and keeps only the new one', async () => {
    const h = await start();
    const registered = await h.register('founder', { inviteCode: h.genesisCode });
    const oldCookie = cookieOf(registered);
    const { recoveryCodes } = (await registered.json()) as { recoveryCodes: string[] };
    expect((await fetch(`${h.origin}/api/auth/me`, { headers: { cookie: oldCookie } })).status).toBe(200);

    const recovered = await h.json('/api/auth/recover', {
      email: mailbox('founder'),
      recoveryCode: recoveryCodes[0],
      newPassword: 'a-brand-new-password-42',
    });
    expect(recovered.status).toBe(200);
    const newCookie = cookieOf(recovered);

    // The person who recovers is often the person who lost the account to someone
    // else; whatever session that someone holds must stop working.
    expect((await fetch(`${h.origin}/api/auth/me`, { headers: { cookie: oldCookie } })).status).toBe(401);
    expect((await fetch(`${h.origin}/api/auth/me`, { headers: { cookie: newCookie } })).status).toBe(200);
  }, 60_000);

  it('does not let two simultaneous requests spend the same recovery code', async () => {
    const h = await start();
    const registered = await h.register('founder', { inviteCode: h.genesisCode });
    const { recoveryCodes } = (await registered.json()) as { recoveryCodes: string[] };
    const attempt = (password: string) =>
      h.json('/api/auth/recover', { email: mailbox('founder'), recoveryCode: recoveryCodes[1], newPassword: password });
    const results = await Promise.all([attempt('first-new-password-1'), attempt('second-new-password-2')]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 403]);
  }, 60_000);
});

describe('suspended accounts', () => {
  it('lose a live session as well as the ability to sign in', async () => {
    const h = await start();
    const registered = await h.register('founder', { inviteCode: h.genesisCode });
    const cookie = cookieOf(registered);
    expect((await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } })).status).toBe(200);
    const accountId = h.store.listAccounts()[0]!.accountId;
    h.store.setSuspended(accountId, true);
    const after = await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } });
    expect(after.status).toBe(403);
    expect(((await after.json()) as { code: string }).code).toBe('ERR_ACCOUNT_SUSPENDED');
  }, 60_000);
});

describe('malformed requests', () => {
  it('answers a Host header that cannot form a URL with 400, not a 500', async () => {
    const h = await start();
    const result = await new Promise<number>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const url = new URL(h.origin);
        const req = request({ host: url.hostname, port: url.port, path: '/api/health', headers: { Host: 'bad host with spaces' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end();
      });
    });
    expect(result).toBe(400);
  });
});

// ── one interface, one network ───────────────────────────────────────────────

describe('an interface serves exactly one network', () => {
  it('excludes a healthy node that follows a different network, and says why', async () => {
    const h = await start({ network: 'mainnet' }); // the stub node reports devnet
    const health = (await (await fetch(`${h.origin}/api/health`)).json()) as { network: string; healthyNodes: number };
    expect(health.network).toBe('mainnet');
    expect(health.healthyNodes).toBe(0);
    const nodes = (await (await fetch(`${h.origin}/api/nodes`)).json()) as { nodes: Array<{ healthy: boolean; lastError?: string }> };
    expect(nodes.nodes[0]!.healthy).toBe(false);
    expect(nodes.nodes[0]!.lastError).toMatch(/wrong network.*obsidian-devnet-1.*obsidian-mainnet-1/);
  });

  it('refuses to forward reads to it, rather than showing another chain\'s data', async () => {
    const h = await start({ network: 'mainnet' });
    const before = h.nodeRequests.length;
    const response = await fetch(`${h.origin}/api/rpc?path=/names`);
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_WRONG_NETWORK');
    expect(h.nodeRequests.slice(before).filter((line) => line.includes('/names'))).toEqual([]);
  });

  it('serves a node that follows the right one', async () => {
    const h = await start({ network: 'devnet' });
    const response = await fetch(`${h.origin}/api/rpc?path=/names`);
    expect(response.status).toBe(200);
    expect(((await (await fetch(`${h.origin}/api/health`)).json()) as { network: string }).network).toBe('devnet');
  });

  it('keeps the pool honest on its own: a wrong-network node is never usable, not even as a last resort', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ height: 5, genesisId: 'g', networkId: 'obsidian-mainnet-1', chainId: 7777 }), { status: 200 })) as unknown as typeof fetch;
    const pool = new NodePool({ nodes: ['http://127.0.0.1:1'], fetchImpl, expect: { networkId: 'obsidian-devnet-1', chainId: 7780 } });
    await pool.checkAll();
    expect(pool.pick()).toBeUndefined();
    expect(pool.ordered()).toEqual([]);
  });
});

describe('the network table matches the node', () => {
  it('has the same ids, chain ids, prefixes and ports as obsidian-core', () => {
    for (const [name, definition] of Object.entries(NETWORKS)) {
      const mine = INTERFACE_NETWORKS[name as keyof typeof INTERFACE_NETWORKS];
      expect(mine, name).toBeDefined();
      expect(mine.networkId).toBe(definition.networkId);
      expect(mine.chainId).toBe(definition.chainId);
      expect(mine.addressHrp).toBe(definition.addressHrp);
      expect(mine.nodeRpcPort).toBe(definition.defaultRpcPort);
      // The interface port follows the node's port scheme, anchored at 8788.
      expect(mine.interfacePort).toBe(definition.defaultRpcPort + (8788 - 8630));
    }
    expect(Object.keys(INTERFACE_NETWORKS).sort()).toEqual(Object.keys(NETWORKS).sort());
  });
});

describe('choosing the network from the command line and the environment', () => {
  it('derives the port and the node address from the network, and lets flags override both', () => {
    const devnet = loadInterfaceConfig(['--network', 'devnet'], {}).config;
    expect(devnet.network).toBe('devnet');
    expect(devnet.port).toBe(38788);
    expect(devnet.nodeUrls).toEqual(['http://127.0.0.1:38630']);
    const mainnet = loadInterfaceConfig(['--network', 'mainnet'], {}).config;
    expect(mainnet.port).toBe(8788);
    expect(mainnet.nodeUrls).toEqual(['http://127.0.0.1:8630']);
    const custom = loadInterfaceConfig(['--network', 'testnet', '--port', '9000', '--nodes', 'http://10.0.0.5:18630'], {}).config;
    expect(custom.port).toBe(9000);
    expect(custom.nodeUrls).toEqual(['http://10.0.0.5:18630']);
  });

  it('reads the environment, and falls back to the node\'s OBSIDIAN_NETWORK so a compose file sets it once', () => {
    expect(loadInterfaceConfig([], { OBSIDIAN_INTERFACE_NETWORK: 'staging' }).config.port).toBe(28788);
    expect(loadInterfaceConfig([], { OBSIDIAN_NETWORK: 'testnet' }).config.network).toBe('testnet');
    // The same network named twice is not a conflict: a compose file may legitimately set both.
    expect(loadInterfaceConfig([], { OBSIDIAN_INTERFACE_NETWORK: 'staging', OBSIDIAN_NETWORK: 'staging' }).config.network).toBe('staging');
    expect(loadInterfaceConfig(['--network', 'devnet'], { OBSIDIAN_NETWORK: 'devnet' }).config.network).toBe('devnet');
  });

  it('refuses to guess when the flag, the interface variable and the node variable name different networks', () => {
    // A settings file that says mainnet under a unit that says testnet is a mistake to surface, not to resolve
    // quietly in somebody's favour. The node refuses in exactly the same way.
    expect(() => loadInterfaceConfig([], { OBSIDIAN_INTERFACE_NETWORK: 'staging', OBSIDIAN_NETWORK: 'mainnet' })).toThrow(
      /conflicting networks: OBSIDIAN_INTERFACE_NETWORK says staging, but OBSIDIAN_NETWORK says mainnet/,
    );
    expect(() => loadInterfaceConfig(['--network', 'testnet'], { OBSIDIAN_INTERFACE_NETWORK: 'mainnet' })).toThrow(
      /conflicting networks: --network says testnet, but OBSIDIAN_INTERFACE_NETWORK says mainnet/,
    );
    // Empty values are unset, not a second opinion.
    expect(loadInterfaceConfig(['--network', 'testnet'], { OBSIDIAN_INTERFACE_NETWORK: '', OBSIDIAN_NETWORK: '  ' }).config.network).toBe('testnet');
  });

  it('rejects a network that does not exist, and refuses to start without one', () => {
    expect(() => loadInterfaceConfig(['--network', 'moonnet'], {})).toThrow(/unknown network "moonnet"/);
    const unset = loadInterfaceConfig([], {});
    expect(unset.config.network).toBeUndefined();
    expect(validateInterfaceConfig(unset).join('\n')).toMatch(/no network selected/);
  });

  it('listens on loopback unless told otherwise', () => {
    expect(loadInterfaceConfig(['--network', 'devnet'], {}).config.host).toBe('127.0.0.1');
    expect(loadInterfaceConfig(['--network', 'devnet', '--host', '0.0.0.0'], {}).config.host).toBe('0.0.0.0');
  });
});

describe('behind a gateway on another hostname', () => {
  const signIn = (h: Harness, headers: Record<string, string>) =>
    h.json('/api/auth/login', { email: mailbox('nobody'), password: PASSWORD }, headers);

  it('recognises the browser\'s own origin when a trusted proxy says which host it used', async () => {
    const h = await start({ trustProxy: true });
    // The browser loaded https://app.example/ and posts with that Origin; the
    // gateway reaches this process under a different Host.
    const viaGateway = await signIn(h, { origin: 'https://app.example', 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' });
    expect(viaGateway.status, 'the site must not refuse its own sign-in form').toBe(401); // credentials are wrong; the ORIGIN was fine
    const wrongHost = await signIn(h, { origin: 'https://evil.example', 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' });
    expect(wrongHost.status).toBe(403);
  });

  it('ignores forwarded headers entirely when no proxy is trusted', async () => {
    const h = await start({ trustProxy: false });
    const spoofed = await signIn(h, { origin: 'https://app.example', 'x-forwarded-host': 'app.example', 'x-forwarded-proto': 'https' });
    expect(spoofed.status).toBe(403);
  });
});
