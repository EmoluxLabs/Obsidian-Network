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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { InterfaceServer, WALLET_LINK_DOMAIN, type InterfaceConfig } from '../server/index.js';
import { loadInterfaceConfig } from '../server/config.js';
import { AccountStore } from '../server/store.js';
import { newGenesisInvitation } from '../server/genesis-invite.js';
import { loadGateIssuer, gatePassphraseFromEnv, type GateIssuer } from '../server/gate-issuer.js';
// The node's own keystore writer and the chain's own certificate verifier: the platform's issuer must interoperate with them.
// @ts-expect-error — compiled core (built by `npm run build:core`), no declaration path from here
import { Keystore } from '../../obsidian-core/dist/crypto/keystore.js';
// @ts-expect-error — plain JS module
import { assertMiningGate } from '../web/core/mining/gate.js';
// The real compiled core (synced into web/core by `npm run build:core`): the
// tests sign genuine transactions with it, and the server decodes them with the
// same code.
// @ts-expect-error — plain JS module without a declaration file in the test tree
import { signTransaction, encodeSignedTx } from '../web/core/transactions/encode.js';
// @ts-expect-error — plain JS module
import { keyPairFromPrivateKey, signMessage } from '../web/core/crypto/keys.js';
// @ts-expect-error — plain JS module
import { TxType } from '../web/core/protocol/types.js';

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
  /** Every request the stub node received, as `METHOD /path`. */
  requests: string[];
  /** The gate issuer this harness serves with (only when started with `gate: true`). */
  gateIssuer?: GateIssuer;
  /** Make the server's transaction decoder fail to load, as if web/core were missing. */
  breakCore: () => void;
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

const here2 = dirname(fileURLToPath(import.meta.url));
const REAL_CORE = resolve(here2, '..', 'web', 'core');

/** Two deterministic devnet wallets: the account's own, and somebody else's. */
const KEYS = {
  mine: keyPairFromPrivateKey('11'.repeat(32), 'dobs') as { address: string; publicKey: string; privateKey: string },
  other: keyPairFromPrivateKey('22'.repeat(32), 'dobs') as { address: string; publicKey: string; privateKey: string },
};

type Keys = { address: string; publicKey: string; privateKey: string };
const jsonHeaders = (cookie?: string) => ({ 'content-type': 'application/json', ...(cookie ? { cookie } : {}) });

/** Ask for a link challenge the way the wallet does. */
async function challengeFor(h: { origin: string }, cookie: string, address: string) {
  const response = await fetch(`${h.origin}/api/wallet/link/challenge`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ address }) });
  return { response, body: (await response.json()) as { message?: string; expiresAt?: number; domain?: string; alreadyLinked?: boolean; code?: string } };
}

/** Link `keys` to the account behind `cookie`, with a real signature over the server's challenge. */
async function proveLink(h: { origin: string }, cookie: string, keys: Keys, tamper: { signWith?: Keys; publicKey?: string; signature?: string } = {}): Promise<Response> {
  const { response, body } = await challengeFor(h, cookie, keys.address);
  // Nothing to sign (refused, or already linked): hand back what the server said.
  if (response.status !== 200 || !body.message) return new Response(JSON.stringify(body), { status: response.status });
  const signer = tamper.signWith ?? keys;
  const signature = tamper.signature ?? signMessage(WALLET_LINK_DOMAIN, new TextEncoder().encode(body.message), signer.privateKey);
  return fetch(`${h.origin}/api/wallet/link`, {
    method: 'POST',
    headers: jsonHeaders(cookie),
    body: JSON.stringify({ address: keys.address, publicKey: tamper.publicKey ?? signer.publicKey, signature }),
  });
}

/** Register a second account through an invite from `inviterCookie`; returns its cookie. */
async function secondAccount(h: Harness, inviterCookie: string, name = 'guest'): Promise<string> {
  const created = await fetch(`${h.origin}/api/auth/invites`, { method: 'POST', headers: { cookie: inviterCookie } });
  const invite = ((await created.json()) as { invite: { code: string } }).invite.code;
  const guest = await h.signIn(name, { inviteCode: invite });
  expect(guest.status).toBe(200);
  return (guest.headers.get('set-cookie') ?? '').split(';')[0]!;
}

/** A genuinely signed transaction, as hex, the way a wallet would send it. */
function signedTxHex(type: number, signer: { address: string; publicKey: string; privateKey: string }, nonce = 0): string {
  const tx = signTransaction({
    sender: signer.address,
    privateKeyHex: signer.privateKey,
    publicKeyHex: signer.publicKey,
    chainId: 7780,
    protocolVersion: '1.0.0',
    nonce,
    type,
    gas: 0n,
    body: new Uint8Array([1, 2, 3]),
    validUntil: 4_000_000_000,
  });
  return Buffer.from(encodeSignedTx(tx)).toString('hex');
}

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

const GATE_PASSPHRASE = 'gate-test-passphrase-001';
const GATE_PRIVATE_KEY = '33'.repeat(32);

/** Write an encrypted issuer keystore the way `generate-mining-gate-key.mjs` does, and open it the way the platform does. */
async function testGateIssuer(): Promise<{ issuer: GateIssuer; path: string }> {
  const path = join(scratch(), 'gate.keystore.json');
  Keystore.write(path, GATE_PRIVATE_KEY, GATE_PASSPHRASE);
  return { issuer: await loadGateIssuer({ keystorePath: path, passphrase: GATE_PASSPHRASE, coreDir: REAL_CORE }), path };
}

async function startHarness(options: { stubStatusFails?: number; nodeUrls?: string[]; dataDir?: string; gate?: boolean } = {}): Promise<Harness> {
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
  writeFileSync(join(coreDir, 'protocol.js'), 'export const version = "1.3.0";\n', 'utf8');
  // The directories the transaction decoder imports: linked, not copied.
  for (const entry of ['transactions', 'protocol', 'crypto', 'economy', 'mining', 'consensus', 'genesis']) {
    symlinkSync(join(REAL_CORE, entry), join(coreDir, entry), 'dir');
  }

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
    if (request.url === '/wallet/balance' || request.url === '/wallet/quote') {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ receivedUrl: request.url, receivedBody: body, balanceObs: '0' }));
      });
      return;
    }
    if (request.url?.startsWith('/wallet/') && request.url.endsWith('/next-nonce')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ receivedUrl: request.url, nextNonce: 0 }));
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
    dataDir: options.dataDir ?? scratch(),
    nodeUrls: options.nodeUrls ?? [nodeUrl],
    googleClientId: 'test-client-id',
    allowedOrigins: [],
    maxInvitesPerAccount: 5,
    genesisInviteHash: genesis.hash,
    trustProxy: false,
    logLevel: 'error',
  };

  const store = new AccountStore({ dataDir: config.dataDir });
  const gateIssuer = options.gate ? (await testGateIssuer()).issuer : undefined;
  if (options.gate) config.network = 'devnet';
  const server = new InterfaceServer({ config, store, gateIssuer });
  const port = await server.listen();
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    config,
    fakeNode,
    nodeUrl,
    genesisCode: genesis.code,
    gateIssuer,
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
    requests,
    breakCore: () => {
      const failed = Promise.reject(new Error('core is missing'));
      failed.catch(() => undefined);
      (server as unknown as { txCore: Promise<unknown> }).txCore = failed;
    },
    close: () => server.close(),
  };
}

const running: Harness[] = [];

async function harness(options: { stubStatusFails?: number; nodeUrls?: string[]; gate?: boolean } = {}): Promise<Harness> {
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
    // Asked for without a content hash, so it must be revalidated.
    expect(core.headers.get('cache-control')).toBe('no-store');
  });

  /**
   * A browser that kept an old `/js/wallet.js` carried on deriving mainnet
   * addresses on devnet after its owner had upgraded. Stable asset URLs plus a
   * positive max-age is what allowed that, so the markup now points at
   * content-hashed URLs and only those may be cached.
   */
  it('references content-hashed bundles in the markup it ships', () => {
    // The real generated shell, not a fixture: this is the file a self-hoster
    // actually serves.
    const shell = readFileSync(resolve(here, '../../wallet/index.html'), 'utf8');
    expect(/<script type="module" src="\/js\/wallet\.js\?v=[0-9a-f]{16}"><\/script>/.test(shell), shell.slice(0, 400)).toBe(true);
    expect(/<link rel="stylesheet" href="\/css\/obsidian\.css\?v=[0-9a-f]{16}">/.test(shell)).toBe(true);
  });

  it('caches an asset only when it is asked for by content hash', async () => {
    const h = await harness();
    mkdirSync(join(h.config.publicDir, 'js'), { recursive: true });
    writeFileSync(join(h.config.publicDir, 'js', 'wallet.js'), 'export const x = 1;\n', 'utf8');

    // With a hash: immutable, because the URL changes when the bytes do.
    const hashed = await fetch(`${h.origin}/js/wallet.js?v=0123456789abcdef`);
    expect(hashed.status).toBe(200);
    expect(hashed.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');

    // Without one: never cached, so an upgrade can never be ignored. A browser
    // holding an old wallet bundle is how a fixed page carried on deriving
    // mainnet addresses on devnet.
    const bare = await fetch(`${h.origin}/js/wallet.js`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get('cache-control')).toBe('no-store');
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

  it('links a proven wallet address but never stores key material', async () => {
    const h = await harness();
    const signedIn = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (signedIn.headers.get('set-cookie') ?? '').split(';')[0]!;

    const linked = await proveLink(h, cookie, KEYS.mine);
    expect(linked.status).toBe(200);
    expect(await linked.json()).toMatchObject({ linked: true, address: KEYS.mine.address, account: { walletAddress: KEYS.mine.address, walletLocked: true } });

    const storeFile = join(h.config.dataDir, 'interface-accounts.json');
    const raw = (await import('node:fs')).readFileSync(storeFile, 'utf8');
    expect(raw).toContain(KEYS.mine.address);
    expect(raw).toContain(KEYS.mine.publicKey);
    expect(raw).not.toContain(KEYS.mine.privateKey);
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

  it('does not drop loose query parameters written beside path', async () => {
    // Regression: `?path=/names&prefix=emo` is how a human writes a read when
    // hand-checking with curl, and the parameters beside `path` used to be read
    // past and dropped — an unfiltered answer wearing the shape of a filtered
    // one. Every spelling must reach the node as the same read.
    const h = await harness();
    await h.poolCheck();

    const loose = await fetch(`${h.origin}/api/rpc?path=/blocks&limit=15&offset=30`);
    expect(loose.status).toBe(200);
    expect(await loose.json()).toMatchObject({ receivedUrl: '/blocks?limit=15&offset=30' });

    const encoded = await fetch(
      `${h.origin}/api/rpc?path=${encodeURIComponent('/blocks?limit=15&offset=30')}`,
    );
    expect(await encoded.json()).toMatchObject({ receivedUrl: '/blocks?limit=15&offset=30' });

    // Mixed, and with the loose parameter written before `path`.
    const mixed = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent('/blocks?limit=15')}&offset=30`);
    expect(await mixed.json()).toMatchObject({ receivedUrl: '/blocks?limit=15&offset=30' });

    const reordered = await fetch(`${h.origin}/api/rpc?limit=15&path=/blocks`);
    expect(await reordered.json()).toMatchObject({ receivedUrl: '/blocks?limit=15' });
  });

  it('forwards a query-carrying read with its query intact', async () => {
    // Regression: the allowlist used to match the whole `path` value, so every
    // parameterised read (/blocks?limit=, /mining/status?address=, /names?prefix=)
    // was refused by an interface that looked healthy.
    const h = await harness();
    await h.poolCheck();
    for (const path of ['/blocks?limit=15', '/names?prefix=emo', '/mining/status?address=obs1abc']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(200);
      expect((await response.json()) as { receivedUrl?: string }).toMatchObject({ receivedUrl: path });
    }
  });

  /**
   * The wallet and mining pages are useless without these three. They were
   * missing from the allowlist, so a correctly installed interface answered
   * `route "/wallet/balance" is not exposed by the interface proxy` and no
   * balance could be shown and no claim could be made.
   */
  it('proxies the wallet routes the wallet and mining pages depend on', async () => {
    const h = await harness();
    await h.poolCheck();

    const balance = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent('/wallet/balance')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dobs1w9jdkqpg5ls3sgds4nfgqwu7t9zwxqcfngsm38' }),
    });
    expect(balance.status, await balance.text()).toBe(200);

    const quote = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent('/wallet/quote')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: 'dobs1w9jdkqpg5ls3sgds4nfgqwu7t9zwxqcfngsm38' }),
    });
    expect(quote.status).toBe(200);

    const nonce = await fetch(
      `${h.origin}/api/rpc?path=${encodeURIComponent('/wallet/dobs1w9jdkqpg5ls3sgds4nfgqwu7t9zwxqcfngsm38/next-nonce')}`,
    );
    expect(nonce.status).toBe(200);
    expect((await nonce.json()) as { receivedUrl?: string }).toMatchObject({
      receivedUrl: '/wallet/dobs1w9jdkqpg5ls3sgds4nfgqwu7t9zwxqcfngsm38/next-nonce',
    });
  });

  it('does not open the whole /wallet/ namespace', async () => {
    // The fix is three routes, not a prefix: `/wallet/` must not become a
    // door to anything the node may add there later.
    const h = await harness();
    await h.poolCheck();
    for (const path of ['/wallet/keys', '/wallet/export', '/wallet/', '/wallet/abc/next-nonce/../../admin']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(path)}`);
      expect(response.status, `${path} should be refused`).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_REJECTED');
    }
  });

  /**
   * Static contract: every RPC path the browser client can call must be on the
   * proxy allowlist. `/wallet/balance` was missing for several releases and the
   * only symptom was a product that could not show a balance, so this reads the
   * two files and compares them rather than trusting anyone to remember.
   */
  it('allowlists every route the browser client can call', () => {
    const client = readFileSync(resolve(here, '../web/src/lib/client.ts'), 'utf8');
    const server = readFileSync(resolve(here, '../server/index.ts'), 'utf8');
    const allowlist = server.slice(server.indexOf('const allowed ='), server.indexOf('if (!allowed)'));
    expect(allowlist.length, 'could not locate the proxy allowlist').toBeGreaterThan(100);

    const called = [
      ...new Set(
        [
          // Single-quoted paths, and backtick templates read to their closing
          // backtick so an inline `${x ? '?a' : ''}` cannot truncate the match.
          ...[...client.matchAll(/request(?:Safe)?(?:<[^>]*>)?\(\s*'([^']+)'/g)].map((m) => m[1]),
          ...[...client.matchAll(/request(?:Safe)?(?:<[^>]*>)?\(\s*`([^`]+)`/g)].map((m) => m[1]),
        ]
          // A nested template (`/names${x ? `?a=${b}` : ''}`) cannot be parsed
          // with a regex, so reduce any interpolation to a parameter marker and
          // keep only the static prefix — which is all the allowlist matches on.
          .map((path) => path.replace(/\$\{[^}]*\}/g, ':param'))
          .map((path) => (path.includes('${') ? path.slice(0, path.indexOf('${')) : path))
          .map((path) => path.split('?')[0])
          .map((path) => (path.endsWith(':param') && !path.endsWith('/:param') ? path.slice(0, path.lastIndexOf(':param')) : path))
          .map((path) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path))
          .filter((path) => path.startsWith('/')),
      ),
    ].sort();

    expect(called.length, 'no client paths were parsed — the regex has rotted').toBeGreaterThan(20);

    const covered = (path: string): boolean => {
      if (allowlist.includes(`'${path}'`)) return true;
      const first = path.split('/').filter(Boolean)[0];
      if (allowlist.includes(`startsWith('/${first}/`)) return true;
      // Pattern-matched routes, e.g. /wallet/:param/next-nonce.
      if (path.includes(':param') && allowlist.includes(`\\/${first}\\/`)) return true;
      return false;
    };

    const missing = called.filter((path) => !covered(path));
    expect(missing, `these client routes are not on the proxy allowlist: ${missing.join(', ')}`).toEqual([]);
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
      body: JSON.stringify({ tx: signedTxHex(TxType.PAYMENT, KEYS.mine) }),
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

describe('the mining gate', () => {
  const claim = (h: Harness, hex: string, cookie?: string) =>
    fetch(`${h.origin}/api/rpc?path=/tx/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ tx: hex }),
    });
  const code = async (response: Response) => ((await response.json()) as { code?: string }).code;
  const submitsSeenByNode = (h: Harness) => h.requests.filter((r) => r === 'POST /tx/submit').length;

  /** Register the founder; optionally link a wallet and confirm MFA. */
  async function founder(h: Harness, steps: { link?: string; mfa?: boolean }) {
    const created = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0]!;
    const json = { cookie, 'content-type': 'application/json' };
    if (steps.link) {
      const keys = Object.values(KEYS).find((candidate) => candidate.address === steps.link)!;
      const linked = await proveLink(h, cookie, keys);
      expect(linked.status).toBe(200);
    }
    if (steps.mfa) {
      const setup = (await (await fetch(`${h.origin}/api/auth/mfa/setup`, { method: 'POST', headers: json, body: '{}' })).json()) as { secret: string };
      const confirmed = await fetch(`${h.origin}/api/auth/mfa/confirm`, { method: 'POST', headers: json, body: JSON.stringify({ totp: totpNow(setup.secret) }) });
      expect(confirmed.status).toBe(200);
    }
    return cookie;
  }

  it('refuses a claim from a caller who is not signed in, and never reaches the node', async () => {
    const h = await harness();
    await h.poolCheck();
    const before = submitsSeenByNode(h);
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine));
    expect(response.status).toBe(401);
    expect(await code(response)).toBe('ERR_UNAUTHORIZED');
    expect(submitsSeenByNode(h)).toBe(before);
  });

  it('refuses a claim with a forged or stale session cookie', async () => {
    const h = await harness();
    await h.poolCheck();
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine), 'obsidian_session=not-a-real-session');
    expect(response.status).toBe(401);
  });

  it('refuses a signed-in account that has no wallet linked', async () => {
    const h = await harness();
    await h.poolCheck();
    const cookie = await founder(h, { mfa: true });
    const before = submitsSeenByNode(h);
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine), cookie);
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('ERR_WALLET_NOT_LINKED');
    expect(submitsSeenByNode(h)).toBe(before);
  });

  it('refuses a linked account whose mining is still closed because MFA is not confirmed', async () => {
    const h = await harness();
    await h.poolCheck();
    const cookie = await founder(h, { link: KEYS.mine.address });
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine), cookie);
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('ERR_MINING_NOT_ENABLED');
  });

  it('refuses a claim signed by a wallet other than the linked one', async () => {
    const h = await harness();
    await h.poolCheck();
    const cookie = await founder(h, { link: KEYS.mine.address, mfa: true });
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.other), cookie);
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('ERR_WALLET_MISMATCH');
  });

  it('relays a claim from a signed-in, linked, MFA-confirmed account signing with its linked wallet', async () => {
    const h = await harness();
    await h.poolCheck();
    const cookie = await founder(h, { link: KEYS.mine.address, mfa: true });
    const before = submitsSeenByNode(h);
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine), cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(submitsSeenByNode(h)).toBe(before + 1);
  });

  it('stops relaying claims the moment the session ends', async () => {
    const h = await harness();
    await h.poolCheck();
    const cookie = await founder(h, { link: KEYS.mine.address, mfa: true });
    await fetch(`${h.origin}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    expect((await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine), cookie)).status).toBe(401);
  });

  it('does not make payments or names depend on an account: only mining is gated', async () => {
    const h = await harness();
    await h.poolCheck();
    for (const type of [TxType.PAYMENT, TxType.ONS]) {
      expect((await claim(h, signedTxHex(type, KEYS.mine))).status, `type ${type}`).toBe(200);
    }
  });

  it('classifies by the decoded transaction, not by anything the caller says about it', async () => {
    const h = await harness();
    await h.poolCheck();
    const hex = signedTxHex(TxType.MINING_CLAIM, KEYS.mine);
    // Extra fields, different casing and a query string change nothing.
    const variants: Array<[string, string]> = [
      ['/api/rpc?path=/tx/submit&type=payment', JSON.stringify({ tx: hex, type: 'PAYMENT' })],
      ['/api/rpc?path=%2Ftx%2Fsubmit', JSON.stringify({ tx: hex.toUpperCase() })],
      ['/api/rpc?path=/tx/submit?x=1', JSON.stringify({ tx: hex, sender: 'someone' })],
    ];
    for (const [path, body] of variants) {
      const response = await fetch(`${h.origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(response.status, path).toBe(401);
    }
  });

  it('relays nothing it cannot classify', async () => {
    const h = await harness();
    await h.poolCheck();
    const before = submitsSeenByNode(h);
    for (const body of ['{}', 'not json', JSON.stringify({ tx: 'zz' }), JSON.stringify({ tx: '00' }), JSON.stringify({ tx: ['ab'] })]) {
      const response = await fetch(`${h.origin}/api/rpc?path=/tx/submit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      expect(response.status, body).toBe(400);
      expect(await code(response), body).toBe('ERR_MALFORMED');
    }
    expect(submitsSeenByNode(h)).toBe(before);
  });

  it('forwards only the routes that take a POST, and no other verb', async () => {
    const h = await harness();
    await h.poolCheck();
    for (const route of ['/tx/simulate', '/tx/encode', '/tx/gas', '/rpc', '/names']) {
      const response = await fetch(`${h.origin}/api/rpc?path=${encodeURIComponent(route)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status, route).toBe(400);
    }
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${h.origin}/api/rpc?path=/names`, { method });
      expect(response.status, method).toBe(405);
    }
  });

  it('refuses to relay when the decoder is unavailable, rather than relaying unclassified', async () => {
    const h = await harness();
    await h.poolCheck();
    h.breakCore();
    const response = await claim(h, signedTxHex(TxType.MINING_CLAIM, KEYS.mine));
    expect(response.status).toBe(503);
    expect(await code(response)).toBe('ERR_RELAY_UNAVAILABLE');
  });
});

describe('the mining certificate (protocol 1.7.0: the chain refuses a claim without one)', () => {
  const CLAIM_ID = 'ab'.repeat(32);
  const ask = (h: Harness, body: unknown, cookie?: string) =>
    fetch(`${h.origin}/api/mining/certificate`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify(body) });
  const subject = (address: string, claimId = CLAIM_ID) => ({ networkId: 'obsidian-devnet-1', chainId: 7780, address, claimId });

  async function account(h: Harness, steps: { link?: Keys; mfa?: boolean }) {
    const created = await h.signIn('founder', { inviteCode: h.genesisCode });
    const cookie = (created.headers.get('set-cookie') ?? '').split(';')[0]!;
    if (steps.link) expect((await proveLink(h, cookie, steps.link)).status).toBe(200);
    if (steps.mfa) {
      const setup = (await (await fetch(`${h.origin}/api/auth/mfa/setup`, { method: 'POST', headers: jsonHeaders(cookie), body: '{}' })).json()) as { secret: string };
      const confirmed = await fetch(`${h.origin}/api/auth/mfa/confirm`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ totp: totpNow(setup.secret) }) });
      expect(confirmed.status).toBe(200);
    }
    return cookie;
  }
  const code = async (response: Response) => ((await response.json()) as { code?: string }).code;

  it('issues a certificate the chain accepts, for the linked wallet and that claim only', async () => {
    const h = await harness({ gate: true });
    const cookie = await account(h, { link: KEYS.mine, mfa: true });
    const response = await ask(h, { address: KEYS.mine.address, claimId: CLAIM_ID }, cookie);
    expect(response.status).toBe(200);
    const { gate, issuer } = (await response.json()) as { gate: { issuer: string; issuedAt: number; signature: string }; issuer: string };
    expect(issuer).toBe(h.gateIssuer!.publicKey);
    // The chain's own verifier, with the chain's committed key list.
    const keys = [h.gateIssuer!.publicKey];
    expect(() => assertMiningGate(keys, gate, subject(KEYS.mine.address), gate.issuedAt + 5)).not.toThrow();
    expect(() => assertMiningGate(keys, gate, subject(KEYS.other.address), gate.issuedAt + 5)).toThrow();
    expect(() => assertMiningGate(keys, gate, subject(KEYS.mine.address, 'cd'.repeat(32)), gate.issuedAt + 5)).toThrow();
    expect(() => assertMiningGate(keys, gate, subject(KEYS.mine.address), gate.issuedAt + 3600)).toThrow(/expired/);
  });

  it('issues nothing without a session', async () => {
    const h = await harness({ gate: true });
    const response = await ask(h, { address: KEYS.mine.address, claimId: CLAIM_ID });
    expect(response.status).toBe(401);
    expect(await code(await ask(h, { address: KEYS.mine.address, claimId: CLAIM_ID }, 'obsidian_session=forged'))).toBe('ERR_UNAUTHORIZED');
  });

  it('issues nothing before a wallet is linked, or before two-factor is confirmed', async () => {
    const h = await harness({ gate: true });
    const noWallet = await account(h, { mfa: true });
    const refusedA = await ask(h, { address: KEYS.mine.address, claimId: CLAIM_ID }, noWallet);
    expect(refusedA.status).toBe(403);
    expect(await code(refusedA)).toBe('ERR_WALLET_NOT_LINKED');

    const h2 = await harness({ gate: true });
    const noMfa = await account(h2, { link: KEYS.mine });
    const refusedB = await ask(h2, { address: KEYS.mine.address, claimId: CLAIM_ID }, noMfa);
    expect(refusedB.status).toBe(403);
    expect(await code(refusedB)).toBe('ERR_MINING_NOT_ENABLED');
  });

  it("issues nothing for a wallet that is not the account's own, including another account's wallet", async () => {
    const h = await harness({ gate: true });
    const cookie = await account(h, { link: KEYS.mine, mfa: true });
    const other = await ask(h, { address: KEYS.other.address, claimId: CLAIM_ID }, cookie);
    expect(other.status).toBe(403);
    expect(await code(other)).toBe('ERR_WALLET_MISMATCH');
    // A second account (no wallet, no MFA) cannot get a certificate for the first account's wallet either.
    const guest = await secondAccount(h, cookie);
    const stolen = await ask(h, { address: KEYS.mine.address, claimId: CLAIM_ID }, guest);
    expect(stolen.status).toBe(403);
    expect(await code(stolen)).toBe('ERR_WALLET_NOT_LINKED');
  });

  it('refuses a malformed request without signing anything', async () => {
    const h = await harness({ gate: true });
    const cookie = await account(h, { link: KEYS.mine, mfa: true });
    for (const body of [{}, { address: KEYS.mine.address }, { address: KEYS.mine.address, claimId: 'xyz' }, { address: KEYS.mine.address, claimId: 'ab'.repeat(31) }, { address: 5, claimId: CLAIM_ID }, { claimId: CLAIM_ID }]) {
      const response = await ask(h, body, cookie);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(await code(response)).toBe('ERR_MALFORMED');
    }
  });

  it('fails closed when the platform has no gate key: 503, never a made-up certificate', async () => {
    const h = await harness();
    h.config.network = 'devnet';
    const cookie = await account(h, { link: KEYS.mine, mfa: true });
    const response = await ask(h, { address: KEYS.mine.address, claimId: CLAIM_ID }, cookie);
    expect(response.status).toBe(503);
    expect(await code(response)).toBe('ERR_GATE_UNAVAILABLE');
  });

  it('is POST only', async () => {
    const h = await harness({ gate: true });
    const response = await fetch(`${h.origin}/api/mining/certificate`);
    expect(response.status).toBe(404);
  });

  it('opens the keystore only with the right passphrase and refuses a damaged or weakened one', async () => {
    const { path } = await testGateIssuer();
    const load = (passphrase: string, keystorePath = path) => loadGateIssuer({ keystorePath, passphrase, coreDir: REAL_CORE });
    await expect(load('not-the-passphrase')).rejects.toThrow(/could not decrypt/);
    await expect(load(GATE_PASSPHRASE, join(scratch(), 'missing.json'))).rejects.toThrow(/not found/);

    const file = JSON.parse(readFileSync(path, 'utf8'));
    const write = (mutate: (f: Record<string, any>) => void) => {
      const copy = JSON.parse(JSON.stringify(file));
      mutate(copy);
      const target = join(scratch(), 'x.json');
      writeFileSync(target, JSON.stringify(copy));
      return target;
    };
    await expect(load(GATE_PASSPHRASE, write((f) => (f.kdfParams.N = 1024)))).rejects.toThrow(/outside the accepted range/);
    await expect(load(GATE_PASSPHRASE, write((f) => (f.ciphertext = f.ciphertext.replace(/^../, (c: string) => (c === '00' ? '01' : '00')))))).rejects.toThrow(/could not decrypt/);
    await expect(load(GATE_PASSPHRASE, write((f) => (f.publicKeyHash = '00'.repeat(32))))).rejects.toThrow(/integrity/);
    await expect(load(GATE_PASSPHRASE, write((f) => (f.cipher = 'none')))).rejects.toThrow(/unsupported/);
    const issuer = await load(GATE_PASSPHRASE);
    expect(issuer.publicKey).toBe((keyPairFromPrivateKey(GATE_PRIVATE_KEY, 'dobs') as { publicKey: string }).publicKey);
  });

  it('takes the passphrase from the environment or a file, and rejects a short one', () => {
    expect(gatePassphraseFromEnv({ OBSIDIAN_GATE_KEYSTORE_PASSPHRASE: 'short' })).toBeUndefined();
    expect(gatePassphraseFromEnv({ OBSIDIAN_GATE_KEYSTORE_PASSPHRASE: GATE_PASSPHRASE })).toBe(GATE_PASSPHRASE);
    const file = join(scratch(), 'pass');
    writeFileSync(file, `${GATE_PASSPHRASE}\n`);
    expect(gatePassphraseFromEnv({ OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE: file })).toBe(GATE_PASSPHRASE);
    expect(gatePassphraseFromEnv({})).toBeUndefined();
  });
});

describe('linking a wallet', () => {
  const link = (h: Harness, cookie: string | undefined, address: unknown) =>
    fetch(`${h.origin}/api/wallet/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ address }),
    });

  it('needs a session', async () => {
    const h = await harness();
    expect((await link(h, undefined, KEYS.mine.address)).status).toBe(401);
  });

  it('refuses text that only looks like an address', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const forged = KEYS.mine.address.slice(0, -1) + (KEYS.mine.address.endsWith('q') ? 'p' : 'q');
    for (const address of ['', 'hello', 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', forged, 42, null, { a: 1 }]) {
      const response = await link(h, cookie, address);
      expect(response.status, String(address)).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_BAD_ADDRESS');
    }
  });

  it('exposes whether the account is ready to mine, and only when both parts are in place', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const me = async () => ((await (await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } })).json()) as { account: { miningReady: boolean } }).account;
    expect((await me()).miningReady).toBe(false);
    expect((await proveLink(h, cookie, KEYS.mine)).status).toBe(200);
    expect((await me()).miningReady).toBe(false); // linked, but MFA is not confirmed
  });

  const raw = (h: Harness) => readFileSync(join(h.config.dataDir, 'interface-accounts.json'), 'utf8');

  it('refuses an unsigned link: an address alone proves nothing', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const response = await link(h, cookie, KEYS.mine.address);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('ERR_LINK_PROOF_REQUIRED');
    const me = (await (await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } })).json()) as { account: { walletAddress?: string } };
    expect(me.account.walletAddress).toBeUndefined();
  });

  it('issues a challenge that names the network, the account and the address', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const { response, body } = await challengeFor(h, cookie, KEYS.mine.address);
    expect(response.status).toBe(200);
    expect(body.domain).toBe(WALLET_LINK_DOMAIN);
    expect(body.message).toMatch(/network: (devnet|dobs)/);
    expect(body.message).toContain(`address: ${KEYS.mine.address}`);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
    expect((await fetch(`${h.origin}/api/wallet/link/challenge`, { method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ address: KEYS.mine.address }) })).status).toBe(401);
  });

  it('refuses a signature made by a key that does not own the address (nobody can squat a stranger\'s wallet)', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    // Signed by the attacker's key, claiming the victim's address, with the victim's public key or their own.
    for (const tamper of [{ signWith: KEYS.other }, { signWith: KEYS.other, publicKey: KEYS.other.publicKey }, { signature: 'ab'.repeat(64) }, { signature: 'zz' }]) {
      const response = await proveLink(h, cookie, KEYS.mine, tamper);
      expect(response.status, JSON.stringify(tamper)).toBe(400);
      expect(['ERR_LINK_PROOF'].includes(((await response.json()) as { code: string }).code)).toBe(true);
    }
    expect(raw(h)).not.toContain(KEYS.mine.address);
    // The wallet is still free for its real owner.
    expect((await proveLink(h, cookie, KEYS.mine)).status).toBe(200);
  });

  it('spends a challenge on the first attempt, good or bad, and never accepts an old or foreign one', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const { body } = await challengeFor(h, cookie, KEYS.mine.address);
    const signature = signMessage(WALLET_LINK_DOMAIN, new TextEncoder().encode(body.message!), KEYS.mine.privateKey);
    const post = (address: string, sig: string) =>
      fetch(`${h.origin}/api/wallet/link`, { method: 'POST', headers: jsonHeaders(cookie), body: JSON.stringify({ address, publicKey: KEYS.mine.publicKey, signature: sig }) });
    // A failed attempt consumes it...
    expect(((await (await post(KEYS.mine.address, 'ab'.repeat(64))).json()) as { code: string }).code).toBe('ERR_LINK_PROOF');
    // ...so the correct signature can no longer be used with it.
    const replay = await post(KEYS.mine.address, signature);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { code: string }).code).toBe('ERR_LINK_CHALLENGE');
    // A challenge for one address does not authorise another.
    const second = await challengeFor(h, cookie, KEYS.mine.address);
    const wrong = await post(KEYS.other.address, signMessage(WALLET_LINK_DOMAIN, new TextEncoder().encode(second.body.message!), KEYS.other.privateKey));
    expect(((await wrong.json()) as { code: string }).code).toBe('ERR_LINK_CHALLENGE');
    // The same signature under another domain is not a link proof.
    const third = await challengeFor(h, cookie, KEYS.mine.address);
    const otherDomain = signMessage('OBSIDIAN:SOMETHING_ELSE:v1', new TextEncoder().encode(third.body.message!), KEYS.mine.privateKey);
    expect(((await (await post(KEYS.mine.address, otherDomain)).json()) as { code: string }).code).toBe('ERR_LINK_PROOF');
  });

  it('expires a challenge', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const { body } = await challengeFor(h, cookie, KEYS.mine.address);
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      const response = await fetch(`${h.origin}/api/wallet/link`, {
        method: 'POST',
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ address: KEYS.mine.address, publicKey: KEYS.mine.publicKey, signature: signMessage(WALLET_LINK_DOMAIN, new TextEncoder().encode(body.message!), KEYS.mine.privateKey) }),
      });
      expect(((await response.json()) as { code: string }).code).toBe('ERR_LINK_CHALLENGE');
    } finally {
      Date.now = realNow;
    }
  });

  it('makes the link permanent: a second, different wallet is refused, the same one is idempotent', async () => {
    const h = await harness();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    expect((await proveLink(h, cookie, KEYS.mine)).status).toBe(200);

    const change = await proveLink(h, cookie, KEYS.other);
    expect(change.status).toBe(409);
    expect(((await change.json()) as { code: string }).code).toBe('ERR_WALLET_LOCKED');

    // Even with a valid challenge in hand, a direct post for a different wallet cannot rebind.
    const again = await proveLink(h, cookie, KEYS.mine);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ alreadyLinked: true, address: KEYS.mine.address });

    const me = (await (await fetch(`${h.origin}/api/auth/me`, { headers: { cookie } })).json()) as { account: { walletAddress: string } };
    expect(me.account.walletAddress).toBe(KEYS.mine.address);
    expect(raw(h)).not.toContain(KEYS.other.address);
  });

  it('refuses a wallet already linked to another account, for linking and for claiming', async () => {
    const h = await harness();
    await h.poolCheck();
    const owner = await (async () => {
      const created = await h.signIn('founder', { inviteCode: h.genesisCode });
      return (created.headers.get('set-cookie') ?? '').split(';')[0]!;
    })();
    expect((await proveLink(h, owner, KEYS.mine)).status).toBe(200);

    const rival = await secondAccount(h, owner);
    const taken = await proveLink(h, rival, KEYS.mine);
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as { code: string }).code).toBe('ERR_WALLET_TAKEN');
    const me = (await (await fetch(`${h.origin}/api/auth/me`, { headers: { cookie: rival } })).json()) as { account: { walletAddress?: string } };
    expect(me.account.walletAddress).toBeUndefined();

    // The rival can still link a wallet of its own, and only that one.
    expect((await proveLink(h, rival, KEYS.other)).status).toBe(200);
    const before = h.requests.filter((r) => r === 'POST /tx/submit').length;
    const setup = (await (await fetch(`${h.origin}/api/auth/mfa/setup`, { method: 'POST', headers: jsonHeaders(rival), body: '{}' })).json()) as { secret: string };
    await fetch(`${h.origin}/api/auth/mfa/confirm`, { method: 'POST', headers: jsonHeaders(rival), body: JSON.stringify({ totp: totpNow(setup.secret) }) });
    const stolen = await fetch(`${h.origin}/api/rpc?path=/tx/submit`, { method: 'POST', headers: jsonHeaders(rival), body: JSON.stringify({ tx: signedTxHex(TxType.MINING_CLAIM, KEYS.mine) }) });
    expect(stolen.status).toBe(403);
    expect(((await stolen.json()) as { code: string }).code).toBe('ERR_WALLET_MISMATCH');
    expect(h.requests.filter((r) => r === 'POST /tx/submit').length).toBe(before);
  });

  it('lets only one of two racing accounts take a wallet', async () => {
    const h = await harness();
    const first = (await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie')!.split(';')[0]!;
    const second = await secondAccount(h, first);
    // Both fetch their challenge, then both submit at the same moment.
    const challenges = await Promise.all([challengeFor(h, first, KEYS.mine.address), challengeFor(h, second, KEYS.mine.address)]);
    const submit = (cookie: string, message: string) =>
      fetch(`${h.origin}/api/wallet/link`, {
        method: 'POST',
        headers: jsonHeaders(cookie),
        body: JSON.stringify({ address: KEYS.mine.address, publicKey: KEYS.mine.publicKey, signature: signMessage(WALLET_LINK_DOMAIN, new TextEncoder().encode(message), KEYS.mine.privateKey) }),
      });
    const results = await Promise.all([submit(first, challenges[0]!.body.message!), submit(second, challenges[1]!.body.message!)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('ignores a legacy bare address: not shown, not enough to mine, and replaceable by a proven link', async () => {
    const h = await harness();
    await h.poolCheck();
    const cookie = ((await h.signIn('founder', { inviteCode: h.genesisCode })).headers.get('set-cookie') ?? '').split(';')[0]!;
    const file = join(h.config.dataDir, 'interface-accounts.json');
    await h.close();
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { accounts: Array<Record<string, unknown>> };
    stored.accounts[0]!.walletAddress = KEYS.other.address; // what the old advisory link wrote
    writeFileSync(file, JSON.stringify(stored));
    const reopened = await startHarness({ dataDir: h.config.dataDir });
    running.push(reopened);
    await reopened.poolCheck();
    const me = (await (await fetch(`${reopened.origin}/api/auth/me`, { headers: { cookie } })).json()) as { account: { walletAddress?: string; miningReady: boolean } };
    expect(me.account.walletAddress).toBeUndefined();
    expect(me.account.miningReady).toBe(false);
    // The legacy address reserved nothing: another account may prove it first...
    const guest = await secondAccount(reopened, cookie);
    expect((await proveLink(reopened, guest, KEYS.other)).status).toBe(200);
    // ...and the legacy account can link a different, proven wallet.
    expect((await proveLink(reopened, cookie, KEYS.mine)).status).toBe(200);
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

describe('trusted origins', () => {
  const OFFICIAL = 'https://wallet.obsmainnet.us.ci';
  const call = (h: Harness, path: string, origin: string | undefined, init: RequestInit = {}) =>
    fetch(`${h.origin}${path}`, { ...init, headers: { ...(origin ? { origin } : {}), ...((init.headers as Record<string, string>) ?? {}) } });

  it('lets a page on the official domain read the chain through this interface — with no cookies', async () => {
    const h = await harness();
    await h.poolCheck();
    for (const path of ['/api/health', '/api/nodes', '/api/rpc?path=%2Fstatus']) {
      const response = await call(h, path, OFFICIAL);
      expect(response.status, path).toBe(200);
      expect(response.headers.get('access-control-allow-origin'), path).toBe(OFFICIAL);
      expect(response.headers.get('vary'), path).toContain('Origin');
      expect(response.headers.get('access-control-allow-credentials'), `${path} must not allow cookies`).toBeNull();
    }
  });

  it('lets it relay a signed transaction, the one write that carries its own authority', async () => {
    const h = await harness();
    await h.poolCheck();
    const response = await call(h, '/api/rpc?path=%2Ftx%2Fsubmit', OFFICIAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tx: signedTxHex(TxType.PAYMENT, KEYS.mine) }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(OFFICIAL);
  });

  it('answers the preflight of an official page for the public routes, and refuses it for account routes', async () => {
    const h = await harness();
    const open = await call(h, '/api/rpc', OFFICIAL, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST' } });
    expect(open.status).toBe(204);
    expect(open.headers.get('access-control-allow-methods')).toBe('GET,POST,OPTIONS');
    const closed = await call(h, '/api/auth/login', OFFICIAL, { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST' } });
    expect(closed.status).toBe(403);
  });

  it('keeps accounts, sessions and wallet linking same-origin for an origin the operator did not list', async () => {
    const h = await harness();
    for (const [path, method] of [
      ['/api/auth/config', 'GET'],
      ['/api/auth/me', 'GET'],
      ['/api/auth/invites', 'GET'],
      ['/api/auth/login', 'POST'],
      ['/api/auth/logout', 'POST'],
      ['/api/wallet/link', 'POST'],
    ] as const) {
      const response = await call(h, path, OFFICIAL, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe('ERR_FORBIDDEN');
      expect(response.headers.get('access-control-allow-origin'), path).toBeNull();
    }
    // ...and a sibling subdomain cannot spend the Genesis Invitation on the way past.
    const attempt = await call(h, '/api/auth/register', OFFICIAL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'sibling-tester@gmail.com', password: 'a-long-enough-pass-9', inviteCode: h.genesisCode }),
    });
    expect(attempt.status).toBe(403);
    const config = (await (await fetch(`${h.origin}/api/auth/config`)).json()) as { genesisInvite: { redeemed: boolean } };
    expect(config.genesisInvite.redeemed).toBe(false);
  });

  it('is not fooled by a lookalike of the official domain', async () => {
    const h = await harness();
    for (const origin of [
      'https://obsmainnet.us.ci.evil.test',
      'https://evilobsmainnet.us.ci',
      'http://api.obsmainnet.us.ci',
      'https://api.obsmainnet.us.ci:8443',
      'https://obsmainnet.us.ci@evil.test',
      'null',
    ]) {
      const response = await call(h, '/api/health', origin);
      expect(response.status, origin).toBe(403);
      expect(response.headers.get('access-control-allow-origin'), origin).toBeNull();
    }
  });

  it('gives an origin the operator lists the full, credentialed treatment — and a wildcard covers only what is beneath it', async () => {
    const h = await harness();
    h.config.allowedOrigins = ['https://*.example.org'];
    const created = await call(h, '/api/auth/register', 'https://app.example.org', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'listed-tester@gmail.com', password: 'a-long-enough-pass-9', inviteCode: h.genesisCode }),
    });
    expect(created.status).toBe(200);
    expect(created.headers.get('access-control-allow-origin')).toBe('https://app.example.org');
    expect(created.headers.get('access-control-allow-credentials')).toBe('true');

    expect((await call(h, '/api/auth/config', 'https://example.org')).status, 'the bare domain is not beneath itself').toBe(403);
    expect((await call(h, '/api/auth/config', 'https://example.org.evil.test')).status).toBe(403);
    expect((await call(h, '/api/auth/config', 'https://notexample.org')).status).toBe(403);
  });

  it('can be told not to trust the official domain', async () => {
    const h = await harness();
    h.config.trustOfficialDomains = false;
    expect((await call(h, '/api/health', OFFICIAL)).status).toBe(403);
  });

  it('is unchanged for a page on its own origin', async () => {
    const h = await harness();
    const response = await call(h, '/api/health', h.origin);
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('trusted origins in the configuration', () => {
  const load = (argv: string[], env: Record<string, string> = {}) => loadInterfaceConfig(['--network', 'devnet', ...argv], env as NodeJS.ProcessEnv).config;

  it('trusts the official domain unless the operator says not to', () => {
    expect(load([]).trustOfficialDomains).toBe(true);
    expect(load(['--no-trust-official-domains']).trustOfficialDomains).toBe(false);
    expect(load([], { OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS: 'false' }).trustOfficialDomains).toBe(false);
    expect(load([], { OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS: 'true' }).trustOfficialDomains).toBe(true);
  });

  it('reads wildcard origins from the environment and from the flag', () => {
    expect(load([], { OBSIDIAN_INTERFACE_ALLOWED_ORIGINS: 'https://a.example.org, https://*.example.net' }).allowedOrigins).toEqual(['https://a.example.org', 'https://*.example.net']);
    expect(load(['--allow-origin', 'https://*.example.org']).allowedOrigins).toEqual(['https://*.example.org']);
  });

  it('refuses a list entry that is malformed or would trust strangers, and says which setting and why', () => {
    expect(() => load([], { OBSIDIAN_INTERFACE_ALLOWED_ORIGINS: 'https://*.us.ci' })).toThrow(/OBSIDIAN_INTERFACE_ALLOWED_ORIGINS.*strangers/);
    expect(() => load([], { OBSIDIAN_INTERFACE_ALLOWED_ORIGINS: 'example.org' })).toThrow(/invalid origin "example.org"/);
    expect(() => load(['--allow-origin', 'https://example.org/app'])).toThrow(/invalid origin/);
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
