/**
 * Interface HTTP server.
 *
 * Responsibilities, in order of importance:
 *   1. Serve the sites (landing, mine, wallet, explorer, social, capsule, ons,
 *      circle, developer) as plain static files — no server rendering, no
 *      per-user state in the pages.
 *   2. Enforce the access rules: invite-only registration, server-side Google
 *      token verification, and a hard limit of 5 invites per account.
 *   3. Proxy reads and transaction submissions to a healthy Obsidian node, so
 *      the browser never needs to know an internal address and never talks to
 *      a node directly. If every node is down the interface says so; it never
 *      fabricates chain data.
 *
 * This process holds no keys and no funds. Deleting it entirely changes nothing
 * about the chain.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { AccountStore } from './store.js';
import { GoogleTokenVerifier, newInviteCode, newSecret, type TokenVerifier } from './auth.js';
import { NodePool } from './nodes.js';

export interface InterfaceConfig {
  host: string;
  port: number;
  /** Repo root (the directory holding the site folders). */
  siteRoot: string;
  /** Built web assets. */
  publicDir: string;
  /** Directory of the compiled browser-safe core modules. */
  coreDir: string;
  dataDir: string;
  nodeUrls: string[];
  googleClientId?: string;
  /** Origins allowed to call the API with credentials. */
  allowedOrigins: string[];
  /** Max invites one account may issue (protocol default: 5). */
  maxInvitesPerAccount: number;
  /** Set only when the operator terminates TLS elsewhere. */
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export const DEFAULT_INTERFACE_CONFIG: InterfaceConfig = {
  host: '0.0.0.0',
  port: 8788,
  siteRoot: resolve(process.cwd(), '..'),
  publicDir: resolve(process.cwd(), 'public'),
  coreDir: resolve(process.cwd(), 'web', 'core'),
  dataDir: resolve(process.cwd(), '.data'),
  nodeUrls: ['http://127.0.0.1:8630'],
  allowedOrigins: [],
  maxInvitesPerAccount: 5,
  trustProxy: false,
  logLevel: 'info',
};

export interface InterfaceDependencies {
  store: AccountStore;
  pool: NodePool;
  verifier: TokenVerifier;
  config: InterfaceConfig;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

const SESSION_COOKIE = 'obsidian_session';
const MAX_BODY_BYTES = 256 * 1024;
/** Hard ceiling on how much of an oversized body we are willing to drain. */
const MAX_DRAIN_BYTES = MAX_BODY_BYTES * 4;

/** Thrown when a request body is larger than the interface will read. */
export class BodyTooLargeError extends Error {
  readonly status = 413;
  readonly code = 'ERR_BODY_TOO_LARGE';
  constructor() {
    super(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    this.name = 'BodyTooLargeError';
  }
}
const SITES = ['landing', 'mine', 'wallet', 'explorer', 'social', 'capsule', 'ons', 'circle', 'developer', 'app', 'audit'];

export class InterfaceServer {
  private server?: ReturnType<typeof createServer>;
  private readonly config: InterfaceConfig;
  private readonly dependencies: InterfaceDependencies;

  constructor(dependencies: Partial<InterfaceDependencies> & { config: InterfaceConfig }) {
    this.config = dependencies.config;
    const thresholds: Record<InterfaceConfig['logLevel'], number> = { debug: 10, info: 20, warn: 30, error: 40 };
    const log = dependencies.log ?? ((level, message, fields) => {
      if (thresholds[level] < thresholds[this.config.logLevel]) return;
      const line = JSON.stringify({ ts: new Date().toISOString(), level, component: 'interface', message, ...fields });
      process.stdout.write(`${line}\n`);
    });
    this.dependencies = {
      store: dependencies.store ?? new AccountStore({ dataDir: this.config.dataDir }),
      pool:
        dependencies.pool ??
        new NodePool({
          nodes: this.config.nodeUrls,
          log: (level, message, fields) => log(level, message, fields),
        }),
      verifier:
        dependencies.verifier ??
        new GoogleTokenVerifier({ clientId: this.config.googleClientId ?? '' }),
      config: this.config,
      log,
    };
  }

  get pool(): NodePool {
    return this.dependencies.pool;
  }

  get store(): AccountStore {
    return this.dependencies.store;
  }

  async listen(): Promise<number> {
    this.server = createServer((request, response) => {
      // `handle` is async; a floating promise here would crash the process on an
      // unhandled rejection instead of answering the client with an error.
      void this.handle(request, response).catch((error) => {
        this.dependencies.log('error', 'unhandled interface failure', { error: (error as Error).message });
        if (!response.headersSent) this.json(response, 500, { error: 'internal error', code: 'ERR_INTERNAL' });
        else response.end();
      });
    });
    await new Promise<void>((resolvePromise, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.config.port, this.config.host, () => resolvePromise());
    });
    this.dependencies.pool.start();
    const address = this.server.address();
    const port = typeof address === 'object' && address ? address.port : this.config.port;
    this.dependencies.log('info', 'interface listening', { host: this.config.host, port, nodes: this.config.nodeUrls.length });
    return port;
  }

  async close(): Promise<void> {
    this.dependencies.pool.stop();
    await new Promise<void>((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    try {
      // Same-origin by default. Cross-origin API access must be explicitly
      // allowlisted, and it is always credential-oriented (cookies), never
      // token-in-URL.
      const origin = request.headers.origin;
      if (origin && this.config.allowedOrigins.includes(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      } else if (origin && url.pathname.startsWith('/api/')) {
        this.json(response, 403, { error: 'origin not allowed', code: 'ERR_FORBIDDEN' });
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      // The account page is the only surface that needs a third party: Google
      // Identity Services renders its button in an iframe and issues its ID
      // token from accounts.google.com. Every other page keeps the strictest
      // policy, and the token is still verified server-side against Google's
      // JWKS — the browser is never trusted to assert who the user is.
      const authSurface = url.pathname === '/app' || url.pathname.startsWith('/app/');
      this.securityHeaders(response, { googleIdentity: authSurface });

      // Every branch is awaited: returning a promise from inside a try/catch
      // would let its rejection escape the error handling below.
      if (url.pathname.startsWith('/api/')) return await this.api(request, response, url);
      if (url.pathname.startsWith('/core/')) return this.serveFile(response, this.config.coreDir, url.pathname.slice(6));
      return this.serveSite(request, response, url);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        if (!response.headersSent) this.json(response, error.status, { error: error.message, code: error.code });
        return;
      }
      this.dependencies.log('error', 'interface request failed', {
        path: url.pathname,
        error: (error as Error).message,
      });
      if (!response.headersSent) this.json(response, 500, { error: 'internal error', code: 'ERR_INTERNAL' });
    }
  }

  private securityHeaders(response: ServerResponse, options: { googleIdentity?: boolean } = {}): void {
    // The pages are static and the API is same-origin, so a strict policy costs
    // nothing and blocks injected script from doing anything useful.
    const google = options.googleIdentity ? ' https://accounts.google.com' : '';
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        `script-src 'self'${google}`,
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        `connect-src 'self'${google}`,
        google ? "frame-src 'self' https://accounts.google.com" : "frame-src 'none'",
        "worker-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ].join('; '),
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
  }

  // ── Sites ─────────────────────────────────────────────────────────────────

  private serveSite(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const requestPath = url.pathname.replace(/\/+$/, '') || '/';

    // Root shows the landing site; each product has its own directory so it can
    // also be deployed on its own host.
    if (requestPath === '/' || requestPath === '/index.html') {
      return this.serveFile(response, join(this.config.siteRoot, 'landing'), 'index.html');
    }
    const first = requestPath.split('/')[1] ?? '';
    if (SITES.includes(first)) {
      const rest = requestPath.slice(first.length + 1);
      return this.serveFile(response, join(this.config.siteRoot, first), rest || 'index.html');
    }
    if (requestPath.startsWith('/js/') || requestPath.startsWith('/assets/') || requestPath.startsWith('/css/')) {
      return this.serveFile(response, this.config.publicDir, requestPath);
    }
    // No catch-all document on purpose: every product has its own directory and
    // its own index.html, so an unknown path is a real 404 rather than a page
    // that silently pretends to be something it is not.
    this.json(response, 404, { error: `no site or asset at ${requestPath}`, code: 'ERR_NOT_FOUND' });
    void request;
  }

  private serveFile(response: ServerResponse, root: string, relative: string): void {
    const safeRelative = normalize(relative).replace(/^([.]{2}[/\\])+/, '');
    const full = join(root, safeRelative);
    if (!full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`) && full !== root) {
      this.json(response, 403, { error: 'forbidden path', code: 'ERR_FORBIDDEN' });
      return;
    }
    if (!existsSync(full) || !statSync(full).isFile()) {
      this.json(response, 404, { error: 'not found', code: 'ERR_NOT_FOUND' });
      return;
    }
    const type = contentType(full);
    // Files served from the built bundle are immutable; site HTML is revalidated
    // so a redeploy cannot leave a stale page pinned in a browser cache.
    const fromBundle = full.startsWith(this.config.publicDir) || full.startsWith(this.config.coreDir);
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': fromBundle ? 'public, max-age=300' : 'no-store',
    });
    createReadStream(full).pipe(response);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  private async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/api/health') {
      const consensusHeight = this.dependencies.pool.consensusHeight();
      this.json(response, 200, {
        status: 'ok',
        accounts: this.dependencies.store.accountCount,
        nodes: this.dependencies.pool.summary().length,
        healthyNodes: this.dependencies.pool.summary().filter((node) => node.healthy).length,
        consensusHeight: consensusHeight ?? null,
        genesisMismatch: this.dependencies.pool.genesisMismatch,
      });
      return;
    }

    if (path === '/api/nodes') {
      this.json(response, 200, {
        nodes: this.dependencies.pool.summary(),
        consensusHeight: this.dependencies.pool.consensusHeight() ?? null,
        genesisMismatch: this.dependencies.pool.genesisMismatch,
      });
      return;
    }

    if (path === '/api/nodes/refresh' && request.method === 'POST') {
      await this.dependencies.pool.checkAll();
      this.json(response, 200, { nodes: this.dependencies.pool.summary() });
      return;
    }

    if (path === '/api/auth/config') {
      this.json(response, 200, {
        inviteOnly: true,
        googleClientId: this.config.googleClientId ?? '',
        maxInvitesPerAccount: this.config.maxInvitesPerAccount,
        accountsExist: this.dependencies.store.accountCount > 0,
      });
      return;
    }

    if (path === '/api/auth/me') {
      const account = this.requireSession(request, response);
      if (!account) return;
      this.json(response, 200, { account: publicAccount(account) });
      return;
    }

    if (path === '/api/auth/google' && request.method === 'POST') {
      await this.loginWithGoogle(request, response);
      return;
    }

    if (path === '/api/auth/invites' && request.method === 'POST') {
      const account = this.requireSession(request, response);
      if (!account) return;
      const issued = this.dependencies.store.countIssued(account.accountId);
      if (account.invitesIssued !== issued) this.dependencies.store.listInvites(account.accountId);
      if (issued >= this.config.maxInvitesPerAccount) {
        this.json(response, 403, {
          error: `this account has already issued the maximum of ${this.config.maxInvitesPerAccount} invites`,
          code: 'ERR_INVITE_LIMIT',
          issued,
          limit: this.config.maxInvitesPerAccount,
        });
        return;
      }
      const code = newInviteCode();
      this.dependencies.store.createInvite(account.accountId, code);
      this.dependencies.store.incrementInvitesIssued(account.accountId);
      this.json(response, 201, {
        invite: { code, createdAt: Date.now() },
        issued: issued + 1,
        limit: this.config.maxInvitesPerAccount,
      });
      return;
    }

    if (path === '/api/auth/invites' && request.method === 'GET') {
      const account = this.requireSession(request, response);
      if (!account) return;
      this.json(response, 200, {
        invites: this.dependencies.store.listInvites(account.accountId),
        issued: this.dependencies.store.countIssued(account.accountId),
        limit: this.config.maxInvitesPerAccount,
      });
      return;
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      const token = readCookie(request, SESSION_COOKIE);
      if (token) this.dependencies.store.destroySession(token);
      response.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      this.json(response, 200, { signedOut: true });
      return;
    }

    if (path === '/api/wallet/link' && request.method === 'POST') {
      const account = this.requireSession(request, response);
      if (!account) return;
      const body = await this.readJson<{ address?: string }>(request);
      if (!body?.address || !/^(obs|tobs|sobs|dobs)1[0-9a-z]{20,}$/.test(body.address)) {
        this.json(response, 400, { error: 'a valid wallet address is required', code: 'ERR_BAD_ADDRESS' });
        return;
      }
      this.dependencies.store.setWalletAddress(account.accountId, body.address);
      this.json(response, 200, { linked: true, address: body.address });
      return;
    }

    if (path === '/api/rpc') {
      await this.proxy(request, response, url);
      return;
    }

    this.json(response, 404, { error: 'unknown interface route', code: 'ERR_NOT_FOUND' });
  }

  private async loginWithGoogle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJson<{ idToken?: string; inviteCode?: string; isGoogleUser?: boolean }>(request);
    if (!body?.idToken || typeof body.idToken !== 'string') {
      this.json(response, 400, { error: 'a Google ID token is required', code: 'ERR_MALFORMED' });
      return;
    }
    // Note: `isGoogleUser` is deliberately never read. Only the verified token
    // decides who the caller is.

    let profile;
    try {
      profile = await this.dependencies.verifier.verify(body.idToken);
    } catch (error) {
      this.json(response, 401, { error: `Google sign-in rejected: ${(error as Error).message}`, code: 'ERR_UNAUTHORIZED' });
      return;
    }

    let account = this.dependencies.store.findAccountBySubject(profile.subject);
    if (!account) {
      const store = this.dependencies.store;
      const inviteCode = body.inviteCode?.trim();
      const isFirstAccount = store.accountCount === 0;
      if (!isFirstAccount) {
        if (!inviteCode) {
          this.json(response, 403, { error: 'this deployment is invite-only', code: 'ERR_INVITE_REQUIRED' });
          return;
        }
        const invite = store.findByCode(inviteCode);
        if (!invite) {
          this.json(response, 403, { error: 'that invite code is not valid', code: 'ERR_INVITE_INVALID' });
          return;
        }
        if (invite.acceptedBy) {
          this.json(response, 403, { error: 'that invite code has already been used', code: 'ERR_INVITE_USED' });
          return;
        }
        account = store.createAccount(profile);
        store.markInviteAccepted(invite.code, account.accountId);
      } else {
        // The first account bootstraps the deployment. Every later account must
        // present an invite issued by an existing member.
        account = store.createAccount(profile);
      }
    }

    if (account.suspended) {
      this.json(response, 403, { error: 'this account is suspended', code: 'ERR_ACCOUNT_SUSPENDED' });
      return;
    }

    const token = newSecret(32);
    this.dependencies.store.createSession(account.accountId, token);
    this.dependencies.store.touch(account.accountId);
    const secure = this.config.trustProxy ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 3600}${secure}`,
    );
    this.json(response, 200, { account: publicAccount(account), bootstrapped: this.dependencies.store.accountCount === 1 });
  }

  /**
   * Read proxy. The browser asks the interface; the interface asks the best
   * healthy node and fails over. Unknown routes are refused rather than
   * forwarded blindly, so this can never become an open proxy.
   */
  private async proxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const target = url.searchParams.get('path') ?? '/status';
    const allowed =
      target === '/status' ||
      target === '/health' ||
      target === '/supply' ||
      target === '/params' ||
      target === '/version' ||
      target === '/genesis' ||
      target === '/network' ||
      target === '/nodes' ||
      target === '/peers' ||
      target === '/oracle' ||
      target === '/validators' ||
      target === '/blocks' ||
      target === '/mempool' ||
      target === '/names' ||
      target === '/land/countries' ||
      target === '/land/search' ||
      target === '/land/parcels' ||
      target === '/capsules' ||
      target === '/social/feed' ||
      target === '/mining/schedule' ||
      target === '/mining/status' ||
      target === '/mining/claims' ||
      target.startsWith('/block/') ||
      target.startsWith('/tx/') ||
      target.startsWith('/address/') ||
      target.startsWith('/names/') ||
      target.startsWith('/land/') ||
      target.startsWith('/capsules/') ||
      target.startsWith('/social/') ||
      target.startsWith('/audit/');
    if (!allowed) {
      this.json(response, 400, { error: `route "${target}" is not exposed by the interface proxy`, code: 'ERR_REJECTED' });
      return;
    }

    const method = request.method === 'POST' ? 'POST' : 'GET';
    const payload = method === 'POST' ? await this.readRaw(request) : undefined;

    const attempts = this.dependencies.pool.ordered();
    if (attempts.length === 0) {
      this.json(response, 503, { error: 'no Obsidian nodes are configured for this interface', code: 'ERR_NO_NODES' });
      return;
    }

    let lastError = 'no node answered';
    for (const node of attempts) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const upstream = await fetch(`${node.url}${target}`, {
          method,
          headers: payload ? { 'content-type': 'application/json' } : undefined,
          body: payload,
          signal: controller.signal,
        });
        clearTimeout(timer);
        const text = await upstream.text();
        if (upstream.status >= 500) {
          lastError = `node ${node.url} returned ${upstream.status}`;
          continue;
        }
        this.json(response, upstream.status, safeParse(text), { 'x-obsidian-node': node.url });
        return;
      } catch (error) {
        lastError = `${node.url}: ${(error as Error).message}`;
        void this.dependencies.pool.check(node.url);
      }
    }
    this.json(response, 503, { error: `no healthy Obsidian node: ${lastError}`, code: 'ERR_NO_HEALTHY_NODE' });
  }

  private requireSession(request: IncomingMessage, response: ServerResponse): ReturnType<AccountStore['getAccount']> {
    const token = readCookie(request, SESSION_COOKIE);
    if (!token) {
      this.json(response, 401, { error: 'sign in required', code: 'ERR_UNAUTHORIZED' });
      return undefined;
    }
    const session = this.dependencies.store.getSession(token);
    if (!session) {
      this.json(response, 401, { error: 'session expired', code: 'ERR_UNAUTHORIZED' });
      return undefined;
    }
    const account = this.dependencies.store.getAccount(session.accountId);
    if (!account) {
      this.json(response, 401, { error: 'account no longer exists', code: 'ERR_UNAUTHORIZED' });
      return undefined;
    }
    return account;
  }

  /**
   * Read a request body with a hard byte ceiling.
   *
   * The oversized case must not leave the request half-read: an unread body makes
   * Node reset the connection, which turns a clean "413" into a socket error on
   * the client. So the first MAX_DRAIN_BYTES are drained and discarded, the
   * caller answers 413, and only a body that is still streaming after that is
   * torn down.
   */
  private async readRaw(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    let oversized = false;
    for await (const chunk of request) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BODY_BYTES) {
        oversized = true;
        chunks.length = 0;
        if (size > MAX_DRAIN_BYTES) {
          request.destroy();
          break;
        }
        continue;
      }
      chunks.push(buffer);
    }
    if (oversized) throw new BodyTooLargeError();
    return Buffer.concat(chunks).toString('utf8');
  }

  private async readJson<T>(request: IncomingMessage): Promise<T | undefined> {
    const raw = await this.readRaw(request);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  private json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    const payload = JSON.stringify(body, (_key, value) => (typeof value === 'bigint' ? value.toString() : value));
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
      ...headers,
    });
    response.end(payload);
  }
}

function publicAccount(account: NonNullable<ReturnType<AccountStore['getAccount']>>): Record<string, unknown> {
  return {
    accountId: account.accountId,
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt,
    invitesIssued: account.invitesIssued,
    walletAddress: account.walletAddress,
  };
}

function readCookie(request: IncomingMessage, name: string): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return undefined;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.ico':
      return 'image/x-icon';
    case '.woff2':
      return 'font/woff2';
    case '.txt':
      return 'text/plain; charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}


