/**
 * Interface server, over real HTTP.
 *
 * Nothing here is mocked at the transport layer: the tests start the actual
 * server on an ephemeral port, point it at a stub Obsidian node that is also a
 * real HTTP server, and drive it with real requests. That is the only way to
 * prove the two things this process promises — that the browser never needs to
 * reach a node directly, and that no unauthenticated caller can create accounts.
 */

import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InterfaceServer, type InterfaceConfig } from '../server/index.js';
import { AccountStore } from '../server/store.js';
import { newGenesisInvitation } from '../server/genesis-invite.js';

interface Harness {
  origin: string;
  config: InterfaceConfig;
  /** The plaintext Genesis Invitation this harness was configured with. */
  genesisCode: string;
  fakeNode: Server;
  nodeUrl: string;
  /**
   * Register an account. Names are turned into real Gmail addresses because
   * the server only accepts Gmail — see server/identity.ts.
   */
  signIn: (name: string, options?: { inviteCode?: string; password?: string; email?: string }) => Promise<Response>;
  /** The Gmail address `signIn(name)` would use. */
  mailbox: (name: string) => string;
  /** Force a health sweep so the proxy has an opinion about the stub node. */
  poolCheck: () => Promise<void>;
  close: () => Promise<void>;
}

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-interface-'));
  dirs.push(dir);
  return dir;
}

/** Test accounts need a valid Gmail address and a policy-compliant password. */
function mailbox(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9-]/g, '')}-tester@gmail.com`;
}
const TEST_PASSWORD = 'correct-horse-7-battery';

/**
 * An independent RFC 6238 implementation, deliberately not imported from the
 * server: a test that reuses the code under test proves only self-consistency.
 */
function totpNow(secret: string, offsetSteps = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase()) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`not base32: ${char}`);
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetSteps;
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', bytes).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 1_000_000).padStart(6, '0');
}

async function startHarness(options: { stubStatusFails?: number; nodeUrls?: string[] } = {}): Promise<Harness> {
  // Every harness gets its own Genesis Invitation: the first account on a
  // deployment must present one, so the tests need the plaintext.
  const genesis = newGenesisInvitation();
  const publicDir = join(scratch(), 'public');
  const coreDir = join(scratch(), 'core');
  const siteRoot = scratch();
  for (const dir of [publicDir, coreDir, join(siteRoot, 'landing'), join(siteRoot, 'app'), join(siteRoot, 'explorer')]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(siteRoot, 'landing', 'index.html'), '<!doctype html><title>landing</title>', 'utf8');
  writeFileSync(join(siteRoot, 'app', 'index.html'), '<!doctype html><title>app</title>', 'utf8');
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>root</title>', 'utf8');
  writeFileSync(join(coreDir, 'protocol.js'), 'export const version = "1.0.0";\n', 'utf8');

  const requests: string[] = [];
  let statusFailures = options.stubStatusFails ?? 0;
  const fakeNode = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/status' && statusFailures > 0) {
      statusFailures -= 1;
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end('{"error":"boom"}');
      return;
    }
    if (request.url === '/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          height: 42,
          headHash: 'abc123',
          genesisId: 'genesis-test',
          chainId: 7780,
          networkId: 'obsidian-devnet-1',
          syncing: false,
          peers: 2,
        }),
      );
      return;
    }
    if (request.url?.startsWith('/blocks') || request.url?.startsWith('/mining/status') || request.url?.startsWith('/names?prefix')) {
      // Echo the URL so a test can prove the query reached the node.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ receivedUrl: request.url }));
      return;
    }
    if (request.url === '/names') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"names":[],"count":0}');
      return;
    }
    if (request.url === '/secret' || request.url === '/admin/keys') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"secret":"should never be proxied"}');
      return;
    }
    if (request.url === '/tx/submit') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ accepted: true, txId: 'tx-from-fake-node', receivedBytes: body.length }));
      });
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not found","code":"ERR_NOT_FOUND"}');
  });
  await new Promise<void>((resolvePromise) => fakeNode.listen(0, '127.0.0.1', () => resolvePromise()));
  const address = fakeNode.address();
  const nodeUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const config: InterfaceConfig = {
    host: '127.0.0.1',
    port: 0,
    siteRoot,
    publicDir,
    coreDir,
    dataDir: scratch(),
    nodeUrls: options.nodeUrls ?? [nodeUrl],
    googleClientId: 'test-client-id',
    allowedOrigins: [],
    maxInvitesPerAccount: 5,
    genesisInviteHash: genesis.hash,
    trustProxy: false,
    logLevel: 'error',
  };

  const store = new AccountStore({ dataDir: config.dataDir });
  const server = new InterfaceServer({ config, store });
  const port = await server.listen();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    config,
    fakeNode,
    nodeUrl,
    genesisCode: genesis.code,
    mailbox,
    signIn: (name: string, signInOptions: { inviteCode?: string; password?: string; email?: string } = {}) =>
      fetch(`${origin}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: signInOptions.email ?? mailbox(name),
          password: signInOptions.password ?? TEST_PASSWORD,
          inviteCode: signInOptions.inviteCode,
          displayName: name,
        }),
      }),
    poolCheck: async () => {
      await server.pool.checkNow();
    },
    close: () => server.close(),
  };
}

const running: Harness[] = [];

async function harness(options: { stubStatusFails?: number; nodeUrls?: string[] } = {}): Promise<Harness> {
  const created = await startHarness(options);
  running.push(created);
  return created;
}

afterEach(async () => {
  while (running.length > 0) {
    const item = running.pop()!;
    await item.close();
    await new Promise<void>((resolvePromise) => item.fakeNode.close(() => resolvePromise()));
  }
});

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('browser origin handling', () => {
  /**
   * A browser sends `Origin` on its own same-origin POSTs. The interface used
   * to compare that header against an allowlist that is empty by default and
   * reject anything not in it, so every real sign-in from the account page
   * failed with "origin not allowed" while curl — which sends no Origin —
   * worked perfectly. These tests drive the API the way a browser does.
   */
  it('accepts the page\'s own same-origin POST, with an empty allowlist', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.origin },
      body: JSON.stringify({
        email: 'emoluxlabs@gmail.com',
        password: 'a-long-enough-pass-9',
        inviteCode: h.genesisCode,
      }),
    });
    expect(response.status).toBe(200);
    expect(h.config.allowedOrigins).toEqual([]);
  });

  it('accepts every account route from the page, not just registration', async () => {
    const h = await harness();
    const created = await fetch(`${h.origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: h.origin },
      body: JSON.stringify({ email: 'efagbemi91@gmail.com', password: 'a-long-enough-pass-9', inviteCode: h.genesisCode }),
    });
    expect(created.status).toBe(200);
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0]!;

    for (const [path, body] of [
      ['/api/auth/mfa/setup', '{}'],
      ['/api/auth/invites', '{}'],
      ['/api/wallet/link', JSON.stringify({ address: 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' })],
      ['/api/auth/logout', '{}'],
    ] as const) {
      const response = await fetch(`${h.origin}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: h.origin, cookie },
        body,
      });
      expect(response.status, `${path} answered ${response.status}`).not.toBe(403);
    }
  });

  it('still refuses a genuinely foreign origin', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'attacker-tester@gmail.com', password: 'a-long-enough-pass-9', inviteCode: h.genesisCode }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_FORBIDDEN');
    // and it must not have burned the Genesis Invitation on the way out
    const config = (await (await fetch(`${h.origin}/api/auth/config`)).json()) as {
      genesisInvite: { redeemed: boolean };
    };
    expect(config.genesisInvite.redeemed).toBe(false);
  });

  it('does not send CORS headers to a same-origin caller', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/api/auth/config`, { headers: { origin: h.origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('site serving', () => {
  it('serves each product from its own directory and never caches the shell', async () => {
    const h = await harness();
    const root = await fetch(`${h.origin}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('landing');
    expect(root.headers.get('cache-control')).toBe('no-store');

    const app = await fetch(`${h.origin}/app/`);
    expect(app.status).toBe(200);
    expect(await app.text()).toContain('app');

    const core = await fetch(`${h.origin}/core/protocol.js`);
    expect(core.status).toBe(200);
    expect(core.headers.get('cache-control')).toContain('max-age');
  });

  it('serves a strict Content-Security-Policy everywhere, and only widens it for the account page', async () => {
    const h = await harness();
    const landing = await fetch(`${h.origin}/`);
    const csp = landing.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).not.toContain('accounts.google.com');
    expect(landing.headers.get('x-content-type-options')).toBe('nosniff');
    expect(landing.headers.get('x-frame-options')).toBe('DENY');

    // The account page used to be the one exception, because Google Identity
    // Services needed an iframe. Sign-in is first-party now, so there is no
    // third-party origin anywhere in the policy.
    const app = await fetch(`${h.origin}/app/`);
    const appCsp = app.headers.get('content-security-policy') ?? '';
    expect(appCsp).toBe(csp);
    expect(appCsp).toContain("frame-src 'none'");
    expect(appCsp).not.toContain('google');
    expect(appCsp).not.toContain("script-src 'unsafe-inline'");
  });

  it('refuses a raw request that tries to escape the site root', async () => {
    const h = await harness();
    // fetch() would normalise the path client-side, so the traversal is sent as
    // a raw HTTP request on purpose: the server must reject it, not the client.
    const raw = await new Promise<string>((resolvePromise, reject) => {
      const socket = connect(Number(new URL(h.origin).port), '127.0.0.1', () => {
        socket.write('GET /landing/../../../../etc/passwd HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
      });
      let data = '';
      socket.on('data', (chunk) => (data += chunk.toString('utf8')));
      socket.on('end', () => resolvePromise(data));
      socket.on('error', reject);
      socket.setTimeout(5000, () => {
        socket.destroy();
        resolvePromise(data);
      });
    });
    expect(raw).not.toContain('root:');
    expect(raw.split('\r\n')[0]).toMatch(/40[0-9]/);
  });

  it('answers an unknown path with an honest 404 instead of a mismatched page', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/definitely-not-a-site`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_NOT_FOUND');
  });
});

describe('registration is invite-only', () => {
  it('requires the Genesis Invitation for the first account, then member invites', async () => {
    const h = await harness();

    const config = await (await fetch(`${h.origin}/api/auth/config`)).json();
    expect(config).toMatchObject({ inviteOnly: true, accountsExist: false, maxInvitesPerAccount: 5 });
    // The config route advertises that a genesis invitation exists and is
    // unspent, but never any part of it.
    expect(config.genesisInvite).toEqual({ configured: true, redeemed: false });
    expect(JSON.stringify(config)).not.toContain(h.genesisCode);

    // The very first account cannot simply walk in without the invitation.
    const walkIn = await h.signIn('opportunist');
    expect(walkIn.status).toBe(403);
    expect(((await walkIn.json()) as { code: string }).code).toBe('ERR_GENESIS_INVITE_REQUIRED');

    // Nor with a wrong one.
    const wrong = await h.signIn('opportunist', { inviteCode: 'OBS-GENESIS-AAAA-AAAA-AAAA-AAAA' });
    expect(wrong.status).toBe(403);
    expect(((await wrong.json()) as { code: string }).code).toBe('ERR_GENESIS_INVITE_INVALID_OR_USED');

    const first = await h.signIn('founder', { inviteCode: h.genesisCode });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { account: { accountId: string }; bootstrapped: boolean };
    expect(firstBody.bootstrapped).toBe(true);

    const cookie = first.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('obsidian_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure'); // trustProxy is off in this harness

    const second = await h.signIn('stranger');
    expect(second.status).toBe(403);
    expect(((await second.json()) as { code: string }).code).toBe('ERR_INVITE_REQUIRED');

    const badInvite = await h.signIn('stranger', { inviteCode: 'OBS-NOT-REAL' });
    expect(((await badInvite.json()) as { code: string }).code).toBe('ERR_INVITE_INVALID');
    void config;
  });

  it('spends the Genesis Invitation exactly once, over real HTTP', async () => {
    const h = await harness();

    const first = await h.signIn('founder', { inviteCode: h.genesisCode });
    expect(first.status).toBe(200);

    // A second person with the same code, on a fresh account, is refused —
    // and is told nothing that distinguishes "used" from "wrong".
    const replay = await h.signIn('latecomer', { inviteCode: h.genesisCode });
    expect(replay.status).toBe(403);
    const body = (await replay.json()) as { code: string; error: string };
    expect(body.code).toBe('ERR_GENESIS_INVITE_INVALID_OR_USED');
    expect(body.error).toMatch(/invalid or has already been used/);

    // The config route now reports it spent.
    const config = await (await fetch(`${h.origin}/api/auth/config`)).json();
    expect(config.genesisInvite).toEqual({ configured: true, redeemed: true });
  });

  it('cannot be redeemed twice by simultaneous requests', async () => {
    const h = await harness();

    // Eight registrations racing for one invitation, all in flight together.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) => h.signIn(`racer-${i}`, { inviteCode: h.genesisCode })),
    );
    const accepted = attempts.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1);
    for (const rejected of attempts.filter((r) => r.status !== 200)) {
      expect(rejected.status).toBe(403);
    }
  });

  it('leaves no half-registered account behind when the invitation is wrong', async () => {
    const h = await harness();
    const failed = await h.signIn('ghost', { inviteCode: 'OBS-GENESIS-BBBB-BBBB-BBBB-BBBB' });
    expect(failed.status).toBe(403);

    // The rejected attempt must not have consumed the bootstrap slot: the real
    // founder can still register with the real invitation.
    const founder = await h.signIn('founder', { inviteCode: h.genesisCode });
    expect(founder.status).toBe(200);
    expect(((await founder.json()) as { bootstrapped: boolean }).bootstrapped).toBe(true);
  });

  it('does not accept the Genesis Invitation as a member invite later on', async () => {
    const h = await harness();
    await h.signIn('founder', { inviteCode: h.genesisCode });

    // Once spent, offering it again is an ordinary invalid invite: it must not
    // fall through into the member-invite path and admit anybody.
    const later = await h.signIn('stranger', { inviteCode: h.genesisCode });
    expect(later.status).toBe(403);
    expect(((await later.json()) as { code: string }).code).toBe('ERR_GENESIS_INVITE_INVALID_OR_USED');
  });

  it('refuses the first registration when no Genesis Invitation is configured', async () => {
    const h = await startHarness();
    // Rebuild the server without a genesis hash: a deployment that never set
    // one must be closed, not open.
    await h.close();
    const bare = await startHarness();
    bare.config.genesisInviteHash = undefined;
    await bare.close();

    const store = new AccountStore({ dataDir: mkdtempSync(join(tmpdir(), 'obsidian-bare-')) });
    expect(store.genesisInviteStatus().configured).toBe(false);
    expect(store.redeemGenesisInvite('OBS-GENESIS-CCCC-CCCC-CCCC-CCCC', 'nobody')).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
  });

  it('accepts an invite exactly once and counts it against the issuer', async () => {
    const h = await harness();
    const first = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;

    const created = await fetch(`${h.origin}/api/auth/invites`, { method: 'POST', headers: { cookie } });
    expect(created.status).toBe(201);
    const invite = ((await created.json()) as { invite: { code: string }; issued: number }).invite.code;

    const guest = await h.signIn('guest', { inviteCode: invite });
    expect(guest.status).toBe(200);

    const reuse = await h.signIn('second-guest', { inviteCode: invite });
    expect(reuse.status).toBe(403);
    expect(((await reuse.json()) as { code: string }).code).toBe('ERR_INVITE_USED');

    const listed = await (await fetch(`${h.origin}/api/auth/invites`, { headers: { cookie } })).json();
    expect(listed.issued).toBe(1);
    expect(listed.invites[0].acceptedBy).toBeTruthy();
  });

  it('enforces the five-invite cap on the server, not in the page', async () => {
    const h = await harness();
    const first = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;

    for (let i = 0; i < 5; i += 1) {
      const response = await fetch(`${h.origin}/api/auth/invites`, { method: 'POST', headers: { cookie } });
      expect(response.status).toBe(201);
    }
    const sixth = await fetch(`${h.origin}/api/auth/invites`, { method: 'POST', headers: { cookie } });
    expect(sixth.status).toBe(403);
    expect(((await sixth.json()) as { code: string }).code).toBe('ERR_INVITE_LIMIT');
  });

  it('never trusts client-supplied account flags', async () => {
    const h = await harness();
    await h.signIn('founder', { inviteCode: h.genesisCode });
    // A client that simply asserts it is already admitted, already MFA'd and
    // already allowed to mine still has to present an invite.
    const forged = await fetch(`${h.origin}/api/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'intruder-tester@gmail.com',
        password: TEST_PASSWORD,
        isGoogleUser: true,
        mfaEnabled: true,
        miningEnabled: true,
        accountId: 'whatever',
      }),
    });
    expect(forged.status).toBe(403);
    expect((await forged.json()) as { code: string }).toMatchObject({ code: 'ERR_INVITE_REQUIRED' });
  });

  it('treats dots and +tags in a Gmail address as the same mining account', async () => {
    const h = await harness();
    const first = await h.signIn('founder', { inviteCode: h.genesisCode, email: 'john.smith@gmail.com' });
    expect(first.status).toBe(200);

    const cookie = (first.headers.get('set-cookie') ?? '').split(';')[0]!;
    const invite = ((await (
      await fetch(`${h.origin}/api/auth/invites`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    ).json()) as { invite: { code: string } }).invite.code;

    // Same inbox, dressed up three ways. The server, not the page, decides.
    const duplicate = await h.signIn('dup', { inviteCode: invite, email: 'johnsmith+mining@googlemail.com' });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as { code: string }).code).toBe('ERR_EMAIL_IN_USE');

    // A failed duplicate must not have spent the invite.
    const genuine = await h.signIn('other', { inviteCode: invite, email: 'someone.else@gmail.com' });
    expect(genuine.status).toBe(200);
  });

  it('rejects non-Gmail addresses and weak passwords, and will not reset a password', async () => {
    const h = await harness();
    const notGmail = await h.signIn('founder', { inviteCode: h.genesisCode, email: 'founder@example.com' });
    expect(notGmail.status).toBe(400);
    expect(((await notGmail.json()) as { code: string }).code).toBe('ERR_EMAIL_INVALID');

    const weak = await h.signIn('founder', { inviteCode: h.genesisCode, password: 'short1' });
    expect(weak.status).toBe(400);
    expect(((await weak.json()) as { code: string }).code).toBe('ERR_PASSWORD_WEAK');

    // There is no reset endpoint at all — recovery codes are the only route.
    const reset = await fetch(`${h.origin}/api/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(reset.status).toBe(404);
  });

  it('issues single-use recovery codes and opens mining only after MFA', async () => {
    const h = await harness();
    const created = await h.signIn('founder', { inviteCode: h.genesisCode });
    expect(created.status).toBe(200);
    const body = (await created.json()) as {
      account: { mfaEnabled: boolean; miningEnabled: boolean; recoveryCodesRemaining: number };
      recoveryCodes: string[];
    };
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);
    for (const code of body.recoveryCodes) expect(code).toMatch(/^OBS-RECOVERY-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // Mining stays shut until MFA is confirmed.
    expect(body.account.mfaEnabled).toBe(false);
    expect(body.account.miningEnabled).toBe(false);

    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0]!;
    const setup = (await (
      await fetch(`${h.origin}/api/auth/mfa/setup`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' })
    ).json()) as { secret: string };

    const code = totpNow(setup.secret);
    const confirmed = await fetch(`${h.origin}/api/auth/mfa/confirm`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ totp: code }),
    });
    expect(confirmed.status).toBe(200);
    expect((await confirmed.json()) as { miningEnabled: boolean }).toMatchObject({ miningEnabled: true });

    // The same TOTP code cannot be replayed on the login route.
    const replay = await fetch(`${h.origin}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: h.mailbox('founder'), password: TEST_PASSWORD, totp: code }),
    });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { code: string }).code).toBe('ERR_MFA_INVALID');

    // A recovery code sets a new password, once.
    const recoveryCode = body.recoveryCodes[0]!;
    const recovered = await fetch(`${h.origin}/api/auth/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: h.mailbox('founder'), recoveryCode, newPassword: 'a-brand-new-passphrase-9' }),
    });
    expect(recovered.status).toBe(200);
    expect((await recovered.json()) as { recoveryCodesRemaining: number }).toMatchObject({ recoveryCodesRemaining: 9 });

    const reuse = await fetch(`${h.origin}/api/auth/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: h.mailbox('founder'), recoveryCode, newPassword: 'another-passphrase-11' }),
    });
    // A spent code is simply not a credential any more.
    expect(reuse.status).toBe(403);
  });
});

describe('sessions', () => {
  it('requires a session for account endpoints and clears it on logout', async () => {
    const h = await harness();
    const anonymous = await fetch(`${h.origin}/api/auth/me`);
    expect(anonymous.status).toBe(401);

    const signedIn = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { account: { email: string } }).account.email).toBe(h.mailbox('founder'));

    const out = await fetch(`${h.origin}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    const after = await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } });
    expect(after.status).toBe(401);
  });

  it('links an advisory wallet address but never stores key material', async () => {
    const h = await harness();
    const signedIn = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!;

    const linked = await fetch(`${h.origin}/api/wallet/link`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }),
    });
    expect(linked.status).toBe(200);

    const storeFile = join(h.config.dataDir, 'interface-accounts.json');
    const raw = (await import('node:fs')).readFileSync(storeFile, 'utf8');
    expect(raw).toContain('dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq');
    expect(raw).not.toContain('privateKey');
  });
});

describe('node proxy', () => {
  it('proxies an allowlisted read and says which node answered', async () => {
    const h = await harness();
    await h.poolCheck();
    const response = await fetch(`${h.origin}/api/rpc?path=/names`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-obsidian-node')).toContain('http://127.0.0.1:');
    expect(await response.json()).toMatchObject({ count: 0 });
  });

  it('refuses to proxy anything outside the allowlist', async () => {
    const h = await harness();
    for (const path of ['/secret', '/admin/keys', '../../etc/passwd', '/etc/passwd']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_REJECTED');
    }
  });

  it('forwards a query-carrying read with its query intact', async () => {
    // Regression: the allowlist used to match the whole `path` value, so every
    // parameterised read (/blocks?limit=, /mining/status?address=, /names?prefix=,
    // /land/search?q=…) was refused by an interface that looked healthy.
    const h = await harness();
    await h.poolCheck();
    for (const path of ['/blocks?limit=15', '/names?prefix=emo', '/mining/status?address=obs1abc']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(200);
      expect((await response.json()) as { receivedUrl?: string }).toMatchObject({ receivedUrl: path });
    }
  });

  it('still refuses a disallowed route that carries a query', async () => {
    const h = await harness();
    await h.poolCheck();
    for (const path of ['/secret?x=1', '/admin/keys?token=1', '../../etc/passwd?x=1']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_REJECTED');
    }
  });

  it('refuses an absurdly long proxied path instead of forwarding it', async () => {
    const h = await harness();
    await h.poolCheck();
    const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(`/names?prefix=${'a'.repeat(600)}`)}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_REJECTED');
  });

  it('fails over to another node instead of returning an error page', async () => {
    // One endpoint answers, the other is a closed port: the read must still work.
    const healthy = await startHarness();
    const h = await harness({ nodeUrls: [healthy.nodeUrl, 'http://127.0.0.1:1'] });
    await h.poolCheck();
    const response = await fetch(`${h.origin}/api/rpc?path=/names`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-obsidian-node')).toBe(healthy.nodeUrl);
  });

  it('says "no nodes" honestly when nothing is configured', async () => {
    const h = await harness({ nodeUrls: [] });
    const response = await fetch(`${h.origin}/api/rpc?path=/names`);
    expect([503]).toContain(response.status);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_NO_NODES');
  });

  it('forwards a transaction submission as a POST', async () => {
    const h = await harness();
    await h.poolCheck();
    const response = await fetch(`${h.origin}/api/rpc?path=/tx/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx: '00' }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true, txId: 'tx-from-fake-node' });
  });

  it('reports node health to the browser without leaking internal counters', async () => {
    const h = await harness();
    await h.poolCheck();
    const nodes = await (await fetch(`${h.origin}/api/nodes`)).json();
    expect(nodes.nodes[0]).toMatchObject({ healthy: true, height: 42 });
    expect(JSON.stringify(nodes)).not.toContain('successes');
    const health = await (await fetch(`${h.origin}/api/health`)).json();
    expect(health).toMatchObject({ status: 'ok', healthyNodes: 1 });
  });

  it('rejects an oversized body instead of buffering it', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/api/rpc?path=/tx/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(300 * 1024),
    });
    expect(response.status).toBe(413);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_BODY_TOO_LARGE');
  });
});

describe('origin policy', () => {
  it('refuses a cross-origin API call from an origin nobody allowlisted', async () => {
    const h = await harness();
    const response = await fetch(`${h.origin}/api/nodes`, { headers: { origin: 'https://evil.example' } });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_FORBIDDEN');
  });
});

void beforeAll;

describe('site directories', () => {
  it('serves exactly the sites the build generates — no more, no fewer', async () => {
    // Three lists have to agree or a product silently 404s: the generator, the
    // server's allowlist and the navigation. This test is what caught /node/
    // returning 404 while its directory existed on disk.
    const generator = await readFile(new URL('../scripts/build-sites.mjs', import.meta.url), 'utf8');
    const generated = [...generator.matchAll(/^\s*id: '([a-z]+)',$/gm)].map((match) => match[1]);
    const source = await readFile(new URL('../server/index.ts', import.meta.url), 'utf8');
    const block = /const SITES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
    const served = [...block.matchAll(/'([a-z]+)'/g)].map((match) => match[1]);

    expect(generated.length).toBeGreaterThan(0);
    expect([...served].sort()).toEqual([...generated].sort());
  });

  it('ships every generated site in the release archives', async () => {
    // A fourth list: the packaging script stages site directories by name. When
    // /node/ was added it was missed here, so the interface and self-host
    // archives shipped without the node runner site even though the repo and
    // the running server both had it. Landing is generated into the archive
    // root rather than staged as a directory of its own, so it is exempt.
    const generator = await readFile(new URL('../scripts/build-sites.mjs', import.meta.url), 'utf8');
    const generated = [...generator.matchAll(/^\s*id: '([a-z]+)',$/gm)].map((match) => match[1]);
    const script = await readFile(new URL('../../scripts/package-releases.sh', import.meta.url), 'utf8');
    const stageLines = [...script.matchAll(/^\s*landing [a-z ]+\\$/gm)].map((match) => match[0]);

    expect(stageLines.length).toBeGreaterThan(0);
    for (const line of stageLines) {
      const staged = new Set(line.trim().replace(/\\$/, '').trim().split(/\s+/));
      for (const site of generated) expect(staged.has(site)).toBe(true);
    }
  });
});
