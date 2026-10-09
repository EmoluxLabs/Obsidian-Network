/**
 * Interface HTTP server.
 *
 * Responsibilities, in order of importance:
 *   1. Serve the sites (landing, mine, wallet, explorer, ons, node, developer,
 *      app, audit) as plain static files — no server rendering, no
 *      per-user state in the pages.
 *   2. Enforce the access rules: invite-only registration (a Gmail address, a
 *      password and a TOTP code, no third-party sign-in), and a hard limit of 5
 *      invites per account.
 *   3. Proxy reads and transaction submissions to a healthy Obsidian node, so
 *      the browser never needs to know an internal address and never talks to
 *      a node directly. If every node is down the interface says so; it never
 *      fabricates chain data.
 *
 * This process holds no keys and no funds. Deleting it entirely changes nothing
 * about the chain.
 */

import { OFFICIAL_PATTERNS, compileOrigins, originMatches } from './trusted-origins.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { AccountStore, type Account } from './store.js';
import { newInviteCode, newSecret } from './auth.js';
import { NodePool } from './nodes.js';
import { KeyedLimiter } from './rate-limit.js';
import { interfaceNetwork, type NetworkName } from './networks.js';
import { looksLikeGenesisCode } from './genesis-invite.js';
import {
  canonicalGmail,
  checkPasswordPolicy,
  dummyPasswordHash,
  hashSecretAsync,
  verifySecretAsync,
  newRecoveryCodeSetAsync,
  normaliseRecoveryCode,
  newTotpSecret,
  verifyTotp,
  totpUri,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  RECOVERY_CODE_COUNT,
} from './identity.js';

export interface InterfaceConfig {
  /**
   * The network this interface serves. Nodes that follow another network are
   * refused. `main.ts` requires it; it is optional here only so tests and
   * embedders can build a server without one.
   */
  network?: NetworkName;
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
  /**
   * Origins the operator lists as allowed to call the API with credentials (cookies): exact origins or
   * whole-subdomain patterns such as `https://*.example.org`. Listing one is a statement that every
   * page it serves is as trusted as this interface's own.
   */
  allowedOrigins: string[];
  /**
   * Let pages on the project's official domain (obsmainnet.us.ci and its subdomains) READ this interface
   * from a browser: chain data and transaction relay, with no cookies. Accounts, sessions and wallet
   * linking stay same-origin unless the operator lists the origin in `allowedOrigins`.
   */
  trustOfficialDomains: boolean;
  /** Max invites one account may issue (protocol default: 5). */
  maxInvitesPerAccount: number;
  /**
   * scrypt hash of the single Genesis Invitation that bootstraps the first
   * account. The plaintext code is never stored, logged or served.
   */
  genesisInviteHash?: string;
  /** Set only when the operator terminates TLS elsewhere. */
  trustProxy: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /**
   * Per-client request budgets as [burst, refill per second]. The defaults suit
   * production; tests shrink them.
   */
  rateLimits?: { auth?: [number, number]; proxy?: [number, number]; refresh?: [number, number] };
}

export const DEFAULT_INTERFACE_CONFIG: InterfaceConfig = {
  // Loopback unless told otherwise: behind nginx the interface must not also be
  // reachable directly, in plain HTTP, on its own port. A container sets
  // OBSIDIAN_INTERFACE_HOST=0.0.0.0 explicitly.
  host: '127.0.0.1',
  port: 8788,
  siteRoot: resolve(process.cwd(), '..'),
  publicDir: resolve(process.cwd(), 'public'),
  coreDir: resolve(process.cwd(), 'web', 'core'),
  dataDir: resolve(process.cwd(), '.data'),
  nodeUrls: ['http://127.0.0.1:8630'],
  allowedOrigins: [],
  trustOfficialDomains: true,
  maxInvitesPerAccount: 5,
  genesisInviteHash: undefined,
  trustProxy: false,
  logLevel: 'info',
};

/**
 * The slice of the compiled core the server needs to tell WHAT a signed
 * transaction is. It is loaded from the same synced `coreDir` the browser
 * wallet runs, so the decoder here is the node's own decoder: there is no
 * second parser whose idea of a transaction could differ from the chain's.
 */
export interface TxCore {
  decodeSignedTxFromBytes(bytes: Uint8Array): { type: number; sender: string; chainId: number };
  miningClaimType: number;
  isValidAddress(address: string, hrp?: string): boolean;
}

async function loadTxCore(coreDir: string): Promise<TxCore> {
  const load = (relative: string) => import(pathToFileURL(join(coreDir, relative)).href);
  const [encode, types, keys] = await Promise.all([
    load('transactions/encode.js'),
    load('protocol/types.js'),
    load('crypto/keys.js'),
  ]);
  return {
    decodeSignedTxFromBytes: encode.decodeSignedTxFromBytes,
    miningClaimType: types.TxType.MINING_CLAIM,
    isValidAddress: keys.isValidAddress,
  };
}

/**
 * Node routes that accept a POST through the proxy. Everything else is a read:
 * a POST to any other route is refused here instead of being forwarded, so the
 * only write that crosses this server is a signed transaction.
 */
const PROXY_POST_ROUTES: ReadonlySet<string> = new Set(['/tx/submit', '/wallet/balance', '/wallet/quote']);

export interface InterfaceDependencies {
  store: AccountStore;
  pool: NodePool;
  config: InterfaceConfig;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** Test seam: how the transaction decoder is loaded. Defaults to `config.coreDir`. */
  loadCore?: () => Promise<TxCore>;
}

/**
 * Split a proxied RPC path into its route and query.
 *
 * The route allowlist matches routes, not whole request strings: a path like
 * `/mining/status?address=obs1…` must be checked as `/mining/status` and then
 * forwarded with its query intact, otherwise every parameterised read is
 * refused by an interface that looks like it works.
 */
function splitPathAndQuery(raw: string): [string, string] {
  const index = raw.indexOf('?');
  if (index === -1) return [raw, ''];
  return [raw.slice(0, index), raw.slice(index + 1)];
}

const SESSION_COOKIE = 'obsidian_session';
const MAX_BODY_BYTES = 256 * 1024;
/** Largest answer the proxy will read from a node. */
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

/**
 * Is `target` already in the form a node will resolve it in: no dot segments, no
 * encoded separators, no control characters, no empty segments?
 */
export function isCleanProxyPath(target: string): boolean {
  if (!target.startsWith('/')) return false;
  if (/%2e|%2f|%5c|\\|\/\/|[\u0000-\u001f]/i.test(target)) return false;
  try {
    return new URL(target, 'http://obsidian.invalid').pathname === target;
  } catch {
    return false;
  }
}

/** Read a response body, refusing to hold more than `maxBytes` of it. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error(`response too large (${declared} bytes)`);
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`response too large (more than ${maxBytes} bytes)`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
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
/**
 * Site directories this server will serve. It is an allowlist, not a directory
 * listing: an unknown first path segment is a 404 rather than an attempt to
 * read whatever happens to be on disk. Must stay in step with the `SITES` list
 * in scripts/build-sites.mjs — `tests/server.test.ts` asserts that it does.
 */
/**
 * What a trusted origin that the operator did NOT list may call: public chain reads, the transaction relay
 * and node health. None of these reads a cookie, so none of them can be used to act as a signed-in user.
 */
const PUBLIC_API_PATHS: ReadonlySet<string> = new Set(['/api/rpc', '/api/nodes', '/api/health']);

const SITES = [
  'landing',
  'mine',
  'wallet',
  'explorer',
  'ons',
  'node',
  'developer',
  'app',
  'audit',
];

export class InterfaceServer {
  private server?: ReturnType<typeof createServer>;
  private readonly config: InterfaceConfig;
  private readonly dependencies: InterfaceDependencies;
  /**
   * Costly routes are held to a budget per client address. Password hashing is
   * slow on purpose; slow-by-design and unthrottled is a denial-of-service
   * switch. The auth budget is deliberately above the per-account lockout
   * threshold (10), so the account lock still answers first for a guesser.
   */
  private readonly authLimiter: KeyedLimiter;
  private readonly proxyLimiter: KeyedLimiter;
  private readonly refreshLimiter: KeyedLimiter;

  constructor(dependencies: Partial<InterfaceDependencies> & { config: InterfaceConfig }) {
    this.config = dependencies.config;
    const limits = this.config.rateLimits ?? {};
    this.authLimiter = new KeyedLimiter(...(limits.auth ?? [30, 1 / 3]));
    this.proxyLimiter = new KeyedLimiter(...(limits.proxy ?? [300, 10]));
    this.refreshLimiter = new KeyedLimiter(...(limits.refresh ?? [1, 0.5]));
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
          expect: this.config.network
            ? (({ networkId, chainId }) => ({ networkId, chainId }))(interfaceNetwork(this.config.network))
            : undefined,
          log: (level, message, fields) => log(level, message, fields),
        }),
      config: this.config,
      log,
    };

    // Install the Genesis Invitation hash, if the operator configured one.
    // Only the hash ever reaches the store; a redeemed invitation is never
    // replaced, so restarting with the same hash cannot revive a spent code.
    if (this.config.genesisInviteHash) {
      this.dependencies.store.configureGenesisInvite(this.config.genesisInviteHash);
    }
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
    // Sessions and last-seen times are written lazily; do not lose them on a clean stop.
    this.dependencies.store.flush();
    await new Promise<void>((resolvePromise) => {
      if (!this.server) return resolvePromise();
      this.server.close(() => resolvePromise());
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url: URL;
    try {
      url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    } catch {
      // A Host header or request target that cannot form a URL is the caller's mistake.
      this.json(response, 400, { error: 'malformed request target or Host header', code: 'ERR_MALFORMED' });
      return;
    }
    try {
      // Same-origin by default. Cross-origin API access must be explicitly
      // allowlisted, and it is always credential-oriented (cookies), never
      // token-in-URL.
      //
      // Browsers send `Origin` on same-origin POSTs too, not only on
      // cross-origin ones. So the page's own requests have to be recognised as
      // same-origin before the allowlist is consulted, or an interface with the
      // default empty allowlist rejects its own sign-in form with
      // "origin not allowed" — which is exactly what it used to do.
      const origin = request.headers.origin;
      const sameOrigin = origin !== undefined && origin === this.selfOrigin(request);
      const foreign = origin !== undefined && !sameOrigin;
      // Three tiers, and only the first reads cookies:
      //   1. the operator's own list: full credentialed CORS, as before;
      //   2. the project's official domain: chain reads and transaction relay only, never cookies;
      //   3. everything else is refused on /api/.
      // A trusted sibling subdomain can therefore read the chain through this interface without being
      // able to act as a signed-in user on it.
      if (foreign && this.operatorOriginMatches(origin)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Access-Control-Allow-Credentials', 'true');
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      } else if (foreign && this.config.trustOfficialDomains !== false && originMatches(origin, OFFICIAL_PATTERNS) && PUBLIC_API_PATHS.has(url.pathname)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      } else if (foreign && url.pathname.startsWith('/api/')) {
        this.json(response, 403, { error: 'origin not allowed', code: 'ERR_FORBIDDEN' });
        return;
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(204);
        response.end();
        return;
      }

      // Since Google sign-in was removed, no page needs a third-party origin:
      // every surface, the account page included, gets the strictest policy.
      this.securityHeaders(response);

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

  /** The operator's own list, read once per request: it is short, and a bad entry never gets this far. */
  private operatorOriginMatches(origin: string | undefined): boolean {
    try {
      return originMatches(origin, compileOrigins(this.config.allowedOrigins));
    } catch {
      return false;
    }
  }

  /**
   * The address a request is rate-limited as. Behind a reverse proxy every
   * connection arrives from the proxy, so without this one client's burst would
   * use up the budget of everybody. With `trustProxy` the LAST X-Forwarded-For
   * entry is used: it is the address the proxy itself appended, whereas anything
   * earlier in the header is client-supplied.
   */
  private clientIp(request: IncomingMessage): string {
    const socketIp = (request.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/i, '');
    if (!this.config.trustProxy) return socketIp;
    const header = request.headers['x-forwarded-for'];
    const value = Array.isArray(header) ? header[header.length - 1] : header;
    const last = value?.split(',').pop()?.trim() ?? '';
    return /^[0-9a-fA-F:.]{3,45}$/.test(last) ? last.replace(/^::ffff:/i, '') : socketIp;
  }

  /** Spend one token of `limiter` for this client, or answer 429 and return false. */
  private throttle(request: IncomingMessage, response: ServerResponse, limiter: KeyedLimiter, scope: string, cost = 1): boolean {
    const key = `${scope}:${this.clientIp(request)}`;
    if (limiter.allow(key, cost)) return true;
    const retryAfterSeconds = limiter.retryAfterSeconds(key, cost);
    response.setHeader('Retry-After', String(retryAfterSeconds));
    this.json(response, 429, { error: 'too many requests; slow down', code: 'ERR_RATE_LIMITED', retryAfterSeconds });
    return false;
  }

  /**
   * The origin this request was addressed to, as the browser would write it.
   *
   * `Host` is attacker-controlled in general, but here it is only ever compared
   * against `Origin` from the same request: a forged pair proves nothing and
   * grants nothing, because a browser will not let a page set either header.
   * Behind a proxy that terminates TLS, the scheme has to come from
   * `x-forwarded-proto`, and only when the operator has said to trust it.
   */
  private selfOrigin(request: IncomingMessage): string | undefined {
    // Behind a gateway the Host the interface sees is the gateway's origin
    // hostname, not the one the browser used (and put in `Origin`). A trusted
    // proxy says which one that was.
    const forwardedHost = this.config.trustProxy
      ? String(request.headers['x-forwarded-host'] ?? '').split(',')[0]?.trim()
      : '';
    const host = forwardedHost || request.headers.host;
    if (!host) return undefined;
    const forwarded = this.config.trustProxy
      ? String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
      : '';
    const encrypted = (request.socket as { encrypted?: boolean }).encrypted === true;
    const scheme = forwarded || (encrypted || this.config.trustProxy ? 'https' : 'http');
    return `${scheme}://${host}`;
  }

  private securityHeaders(response: ServerResponse): void {
    // The pages are static and the API is same-origin, so a strict policy costs
    // nothing and blocks injected script from doing anything useful.
    response.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "frame-src 'none'",
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
      // `?v=<content hash>` is written into the markup by build-sites.mjs. A
      // request that carries one is asking for an exact build and can be
      // cached forever; one that does not must be revalidated every time.
      return this.serveFile(response, this.config.publicDir, requestPath, url.searchParams.has('v'));
    }
    // No catch-all document on purpose: every product has its own directory and
    // its own index.html, so an unknown path is a real 404 rather than a page
    // that silently pretends to be something it is not.
    this.json(response, 404, { error: `no site or asset at ${requestPath}`, code: 'ERR_NOT_FOUND' });
    void request;
  }

  private serveFile(response: ServerResponse, root: string, relative: string, immutable = false): void {
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
    // Only a content-addressed request (`?v=<hash>`) may be cached, and then
    // forever, because its URL changes whenever its bytes do. Everything else —
    // site HTML, and any bundle asked for without a hash — is revalidated, so
    // an upgraded deployment can never leave a stale page or a stale bundle
    // pinned in a browser.
    response.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-store',
    });
    const stream = createReadStream(full);
    // An unhandled 'error' on a stream is an uncaught exception: a file that
    // vanishes or becomes unreadable between the stat above and the read must
    // end THIS response, not the process.
    stream.on('error', (error) => {
      this.dependencies.log('warn', 'static file read failed', { file: full, error: error.message });
      response.destroy(error);
    });
    stream.pipe(response);
  }

  // ── API ───────────────────────────────────────────────────────────────────

  private async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '');

    if (path === '/api/health') {
      const consensusHeight = this.dependencies.pool.consensusHeight();
      this.json(response, 200, {
        status: 'ok',
        network: this.config.network ?? null,
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
        network: this.config.network ?? null,
        nodes: this.dependencies.pool.summary(),
        consensusHeight: this.dependencies.pool.consensusHeight() ?? null,
        genesisMismatch: this.dependencies.pool.genesisMismatch,
      });
      return;
    }

    if (path === '/api/nodes/refresh' && request.method === 'POST') {
      // Unauthenticated, and each call fans out to every node: one refresh per
      // couple of seconds for the whole deployment is plenty.
      if (!this.throttle(request, response, this.refreshLimiter, 'refresh', 1)) return;
      await this.dependencies.pool.checkAll();
      this.json(response, 200, { nodes: this.dependencies.pool.summary() });
      return;
    }

    if (path === '/api/auth/config') {
      this.json(response, 200, {
        network: this.config.network ?? null,
        inviteOnly: true,
        // Accounts are Gmail + password + invite + MFA. Google OAuth was
        // removed: no third party decides who may hold a mining account.
        authMethod: 'GMAIL_PASSWORD_MFA',
        emailDomains: ['gmail.com', 'googlemail.com'],
        passwordMinLength: 12,
        mfaRequiredForMining: true,
        recoveryCodeCount: RECOVERY_CODE_COUNT,
        maxInvitesPerAccount: this.config.maxInvitesPerAccount,
        accountsExist: this.dependencies.store.accountCount > 0,
        // Whether a Genesis Invitation is configured and whether it has been
        // spent. Never the hash, and never any part of the code — a frontend
        // only needs to know which field to show on the sign-in form.
        genesisInvite: (() => {
          const status = this.dependencies.store.genesisInviteStatus();
          return { configured: status.configured, redeemed: status.redeemed };
        })(),
      });
      return;
    }

    if (path === '/api/auth/me') {
      const account = this.requireSession(request, response);
      if (!account) return;
      this.json(response, 200, { account: publicAccount(account) });
      return;
    }

    if (path === '/api/auth/register' && request.method === 'POST') {
      await this.register(request, response);
      return;
    }

    if (path === '/api/auth/login' && request.method === 'POST') {
      await this.login(request, response);
      return;
    }

    if (path === '/api/auth/mfa/setup' && request.method === 'POST') {
      if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
      this.mfaSetup(request, response);
      return;
    }

    if (path === '/api/auth/mfa/confirm' && request.method === 'POST') {
      if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
      await this.mfaConfirm(request, response);
      return;
    }

    if (path === '/api/auth/recover' && request.method === 'POST') {
      await this.recover(request, response);
      return;
    }

    if (path === '/api/auth/invites' && request.method === 'POST') {
      if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
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
      if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
      const account = this.requireSession(request, response);
      if (!account) return;
      const body = await this.readJson<{ address?: unknown }>(request);
      const address = typeof body?.address === 'string' ? body.address.trim() : '';
      if (!(await this.isLinkableAddress(address))) {
        const hrp = this.config.network ? interfaceNetwork(this.config.network).addressHrp : undefined;
        this.json(response, 400, {
          error: hrp
            ? `a valid ${this.config.network} wallet address (${hrp}1…) is required`
            : 'a valid wallet address is required',
          code: 'ERR_BAD_ADDRESS',
        });
        return;
      }
      this.dependencies.store.setWalletAddress(account.accountId, address);
      const updated = this.dependencies.store.getAccount(account.accountId) ?? account;
      this.json(response, 200, { linked: true, address, account: publicAccount(updated) });
      return;
    }

    if (path === '/api/rpc') {
      await this.proxy(request, response, url);
      return;
    }

    this.json(response, 404, { error: 'unknown interface route', code: 'ERR_NOT_FOUND' });
  }

  /**
   * Admit an account: issue the session cookie and answer with the account.
   * Shared by registration, password login and recovery.
   */
  private admit(response: ServerResponse, account: Account, extra: Record<string, unknown> = {}): void {
    const token = newSecret(32);
    this.dependencies.store.createSession(account.accountId, token);
    this.dependencies.store.touch(account.accountId);
    const secure = this.config.trustProxy ? '; Secure' : '';
    response.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${14 * 24 * 3600}${secure}`,
    );
    this.json(response, 200, {
      account: publicAccount(account),
      bootstrapped: this.dependencies.store.accountCount === 1,
      ...extra,
    });
  }

  /**
   * Register: Gmail + password + an invite.
   *
   * Identity is a canonical Gmail address, computed here. The frontend never
   * decides whether an address is unique — it cannot be trusted to, and the
   * store's canonical index is the actual gate.
   *
   * There is no email verification and no password reset, by design. Recovery
   * is by recovery code, which is why the codes are issued here, exactly once,
   * in the only response that will ever contain them.
   */
  private async register(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
    const body = await this.readJson<{ email?: string; password?: string; inviteCode?: string; displayName?: string }>(
      request,
    );
    const store = this.dependencies.store;

    const identity = canonicalGmail(body?.email ?? '');
    if (!identity) {
      this.json(response, 400, {
        error: 'a valid Gmail address is required',
        code: 'ERR_EMAIL_INVALID',
      });
      return;
    }
    const policy = checkPasswordPolicy(body?.password ?? '');
    if (!policy.ok) {
      this.json(response, 400, { error: `password rejected: ${policy.reason}`, code: 'ERR_PASSWORD_WEAK' });
      return;
    }

    // The invitation is checked BEFORE anything is looked up about the Gmail
    // address and BEFORE any password is hashed. Order matters twice over:
    //   - "an account already exists for that address" used to be answered to
    //     anyone, invitation or not, which let a stranger list which Gmail
    //     addresses have mining accounts; it is now only said to someone who
    //     holds a usable invitation;
    //   - hashing costs ~70 ms of CPU per call, so doing it for requests that
    //     were never going to be admitted handed every visitor a CPU burner.
    const inviteCode = body?.inviteCode?.trim();
    const isFirstAccount = store.accountCount === 0;
    if (!inviteCode) {
      this.json(
        response,
        403,
        isFirstAccount
          ? {
              error: 'the first account on this deployment requires the Genesis Invitation',
              code: 'ERR_GENESIS_INVITE_REQUIRED',
            }
          : { error: 'this deployment is invite-only', code: 'ERR_INVITE_REQUIRED' },
      );
      return;
    }
    if (isFirstAccount && !store.genesisInviteStatus().configured) {
      this.json(response, 503, {
        error: 'this deployment has no Genesis Invitation configured; registration is closed',
        code: 'ERR_GENESIS_INVITE_NOT_CONFIGURED',
      });
      return;
    }
    if (isFirstAccount) {
      // Prove the Genesis Invitation is the right one BEFORE spending twelve
      // hashes on the account it would create.
      if ((await store.precheckGenesisInvite(inviteCode)) !== 'OK') {
        this.json(response, 403, {
          error: 'that Genesis Invitation is invalid or has already been used',
          code: 'ERR_GENESIS_INVITE_INVALID_OR_USED',
        });
        return;
      }
    }
    if (!isFirstAccount && looksLikeGenesisCode(inviteCode)) {
      this.json(response, 403, {
        error: 'that Genesis Invitation is invalid or has already been used',
        code: 'ERR_GENESIS_INVITE_INVALID_OR_USED',
      });
      return;
    }
    if (!isFirstAccount) {
      const invite = store.findByCode(inviteCode);
      if (!invite || invite.acceptedBy) {
        this.json(
          response,
          403,
          invite
            ? { error: 'that invite code has already been used', code: 'ERR_INVITE_USED' }
            : { error: 'that invite code is not valid', code: 'ERR_INVITE_INVALID' },
        );
        return;
      }
    }
    if (store.findByCanonicalEmail(identity.canonical)) {
      // Gmail ignores dots and +tags, so this also catches the
      // john.smith+1@ / johnsmith@ trick for farming mining accounts.
      this.json(response, 409, {
        error: 'an account already exists for that Gmail address',
        code: 'ERR_EMAIL_IN_USE',
      });
      return;
    }

    // Off the event loop: eleven scrypt hashes, in parallel on the thread pool.
    const [passwordHash, recovery] = await Promise.all([hashSecretAsync(body!.password!), newRecoveryCodeSetAsync()]);

    let account: Account;
    try {
      account = store.createAccount({
        subject: `gmail:${identity.canonical}`,
        email: identity.display,
        canonicalEmail: identity.canonical,
        displayName: typeof body?.displayName === 'string' ? body.displayName.slice(0, 64) : undefined,
        passwordHash,
        recoveryCodeHashes: recovery.hashes,
      });
    } catch (error) {
      // The store repeats the uniqueness check with no await before the
      // insert, so a race between two simultaneous registrations lands here.
      if ((error as Error & { code?: string }).code === 'ERR_EMAIL_IN_USE') {
        this.json(response, 409, {
          error: 'an account already exists for that Gmail address',
          code: 'ERR_EMAIL_IN_USE',
        });
        return;
      }
      throw error;
    }

    // Everything from here to the answer is synchronous: the invitation is spent
    // in the same breath as the account is created, so two simultaneous
    // registrations cannot both win it.
    if (isFirstAccount) {
      const redemption = store.redeemGenesisInvite(inviteCode, account.accountId);
      if (!redemption.ok) {
        store.deleteAccount(account.accountId);
        this.json(response, 403, {
          error: 'that Genesis Invitation is invalid or has already been used',
          code: 'ERR_GENESIS_INVITE_INVALID_OR_USED',
        });
        return;
      }
    } else {
      const invite = store.findByCode(inviteCode);
      if (!invite || invite.acceptedBy) {
        store.deleteAccount(account.accountId);
        this.json(
          response,
          403,
          invite
            ? { error: 'that invite code has already been used', code: 'ERR_INVITE_USED' }
            : { error: 'that invite code is not valid', code: 'ERR_INVITE_INVALID' },
        );
        return;
      }
      store.markInviteAccepted(invite.code, account.accountId);
    }

    // The only time these codes exist in plaintext. They are not stored, not
    // logged and cannot be re-displayed.
    this.admit(response, account, {
      recoveryCodes: recovery.codes,
      recoveryCodesWarning:
        'Write these down offline now. They are shown once, they are the only way to recover this mining account, and no one can reissue them.',
      nextStep: 'SET_UP_MFA',
    });
  }

  /** Sign in with Gmail + password, then MFA if it is enabled. */
  private async login(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
    const body = await this.readJson<{ email?: string; password?: string; totp?: string }>(request);
    const store = this.dependencies.store;
    const identity = canonicalGmail(body?.email ?? '');

    // One answer for "no such account" and "wrong password", so the endpoint
    // cannot be used to discover which Gmail addresses are registered. The TIME
    // has to be the same too: an unknown account used to be refused instantly
    // while a wrong password cost a hash, so the response time said what the
    // response text did not. Unknown accounts now verify against a decoy hash.
    const refuse = (): void => {
      this.json(response, 401, { error: 'those credentials are not valid', code: 'ERR_CREDENTIALS_INVALID' });
    };
    if (!identity) {
      refuse();
      return;
    }
    const account = store.findByCanonicalEmail(identity.canonical);
    if (!account || !account.passwordHash) {
      await verifySecretAsync(body?.password ?? '', await dummyPasswordHash());
      refuse();
      return;
    }
    const now = Date.now();
    if (account.lockedUntil && account.lockedUntil > now) {
      this.json(response, 429, {
        error: 'too many failed attempts; try again later',
        code: 'ERR_TOO_MANY_ATTEMPTS',
        retryAfterSeconds: Math.ceil((account.lockedUntil - now) / 1000),
      });
      return;
    }
    /** Count a failed attempt and lock the account after ten. */
    const failed = (): void => {
      account.failedLogins = (account.failedLogins ?? 0) + 1;
      if (account.failedLogins >= 10) {
        account.lockedUntil = Date.now() + 15 * 60 * 1000;
        account.failedLogins = 0;
      }
      store.saveAccount(account, { critical: false });
    };
    if (!(await verifySecretAsync(body?.password ?? '', account.passwordHash))) {
      failed();
      refuse();
      return;
    }
    if (account.suspended) {
      this.json(response, 403, { error: 'this account is suspended', code: 'ERR_ACCOUNT_SUSPENDED' });
      return;
    }

    if (account.mfaEnabled) {
      const result = verifyTotp(account.totpSecret ?? '', body?.totp ?? '', { lastUsedStep: account.totpLastStep });
      if (!result.ok) {
        // A wrong code is a failed attempt like a wrong password. It used to
        // cost the guesser nothing: whoever had the password could try the
        // million six-digit codes with no lockout at all.
        if (body?.totp) failed();
        this.json(response, 401, {
          error: body?.totp ? `MFA rejected: ${result.reason}` : 'an MFA code is required',
          code: body?.totp ? 'ERR_MFA_INVALID' : 'ERR_MFA_REQUIRED',
        });
        return;
      }
      account.totpLastStep = result.step;
    }

    account.failedLogins = 0;
    account.lockedUntil = undefined;
    store.saveAccount(account, { critical: false });
    this.admit(response, account);
  }

  /** Begin MFA enrolment: issue a TOTP secret for an authenticator app. */
  private mfaSetup(request: IncomingMessage, response: ServerResponse): void {
    const account = this.requireSession(request, response);
    if (!account) return;
    if (account.mfaEnabled) {
      this.json(response, 409, { error: 'MFA is already enabled on this account', code: 'ERR_MFA_ALREADY_ENABLED' });
      return;
    }
    const secret = newTotpSecret();
    account.totpSecret = secret;
    this.dependencies.store.saveAccount(account);
    this.json(response, 200, {
      secret,
      uri: totpUri(secret, account.email),
      digits: TOTP_DIGITS,
      periodSeconds: TOTP_STEP_SECONDS,
      note: 'Add this to an authenticator app, then confirm a code to finish enrolment.',
    });
  }

  /**
   * Confirm MFA. This is the step that opens mining: an account is only fully
   * enrolled once it has a password, recovery codes and a confirmed second
   * factor.
   */
  private async mfaConfirm(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const account = this.requireSession(request, response);
    if (!account) return;
    const body = await this.readJson<{ totp?: string }>(request);
    if (!account.totpSecret) {
      this.json(response, 409, { error: 'start MFA enrolment first', code: 'ERR_MFA_NOT_STARTED' });
      return;
    }
    const result = verifyTotp(account.totpSecret, body?.totp ?? '', { lastUsedStep: account.totpLastStep });
    if (!result.ok) {
      this.json(response, 400, { error: `MFA rejected: ${result.reason}`, code: 'ERR_MFA_INVALID' });
      return;
    }
    account.mfaEnabled = true;
    account.totpLastStep = result.step;
    account.miningEnabled = true;
    this.dependencies.store.saveAccount(account);
    this.json(response, 200, {
      account: publicAccount(account),
      miningEnabled: true,
      note: 'This account is now fully enrolled. Mining claims are still signed by your wallet, never by this account.',
    });
  }

  /**
   * Recover an account with a recovery code: sets a new password, consumes the
   * code and clears MFA so the user can re-enrol a new device.
   */
  private async recover(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.throttle(request, response, this.authLimiter, 'auth')) return;
    const body = await this.readJson<{ email?: string; recoveryCode?: string; newPassword?: string }>(request);
    const store = this.dependencies.store;
    const identity = canonicalGmail(body?.email ?? '');
    const refuse = (): void => {
      this.json(response, 403, {
        error: 'that recovery code is not valid for this account',
        code: 'ERR_RECOVERY_INVALID',
      });
    };
    if (!identity) {
      refuse();
      return;
    }
    const account = store.findByCanonicalEmail(identity.canonical);
    const supplied = normaliseRecoveryCode(body?.recoveryCode ?? '');
    if (!account || !supplied) {
      // Same cost as a real attempt, so the answer time does not say whether
      // the address is registered.
      await verifySecretAsync(supplied || 'x', await dummyPasswordHash());
      refuse();
      return;
    }
    const policy = checkPasswordPolicy(body?.newPassword ?? '');
    if (!policy.ok) {
      this.json(response, 400, { error: `password rejected: ${policy.reason}`, code: 'ERR_PASSWORD_WEAK' });
      return;
    }
    // Verifying one recovery code is a scrypt hash (~70 ms), and an account has
    // up to ten: done on the thread pool, in parallel, never on the event loop.
    // Spending it is then a separate synchronous step that checks the hash is
    // still there, so two simultaneous requests that both matched the same code
    // cannot both spend it.
    const hashes = [...(account.recoveryCodeHashes ?? [])];
    const matches = await Promise.all(hashes.map((hash) => verifySecretAsync(supplied, hash)));
    const matched = matches.indexOf(true);
    if (matched < 0 || !store.consumeRecoveryHash(account.accountId, hashes[matched]!)) {
      refuse();
      return;
    }

    account.passwordHash = await hashSecretAsync(body!.newPassword!);
    account.mfaEnabled = false;
    account.totpSecret = undefined;
    account.totpLastStep = undefined;
    account.miningEnabled = false;
    account.failedLogins = 0;
    account.lockedUntil = undefined;
    store.saveAccount(account);
    // The reason someone recovers an account is often that somebody else has
    // it. Every session signed in before this moment is ended; only the one
    // issued by `admit` below survives.
    store.destroyAccountSessions(account.accountId);
    this.admit(response, account, {
      recovered: true,
      recoveryCodesRemaining: account.recoveryCodesRemaining ?? 0,
      nextStep: 'SET_UP_MFA',
    });
  }

  /**
   * Read proxy. The browser asks the interface; the interface asks the best
   * healthy node and fails over. Unknown routes are refused rather than
   * forwarded blindly, so this can never become an open proxy.
   */
  private async proxy(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    // Reads are cheap but every page polls, and a submit is dearer: both are
    // budgeted per client so one address cannot turn this into a firehose
    // pointed at the nodes.
    if (!this.throttle(request, response, this.proxyLimiter, 'proxy', request.method === 'POST' ? 5 : 1)) return;
    const rawPath = url.searchParams.get('path') ?? '/status';
    // A caller may percent-encode the whole read — `/api/rpc?path=%2Fnames%3Fprefix%3Dk`
    // — or write it out flat: `/api/rpc?path=/names&prefix=k`. Both mean the
    // same thing, and only the first used to work: the loose parameters were
    // read past and dropped, so a filtered read answered 200 with an
    // unfiltered registry hint. Nothing is dropped now — parameters other than
    // `path` are folded onto the read, in the order they were written.
    const extras = [...url.searchParams.entries()].filter(([key]) => key !== 'path');
    const raw = extras.length
      ? `${rawPath}${rawPath.includes('?') ? '&' : '?'}${extras
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join('&')}`
      : rawPath;
    if (raw.length > 512) {
      this.json(response, 400, { error: 'rpc path is too long', code: 'ERR_REJECTED' });
      return;
    }
    // Split the query off before the allowlist check. Every list and status
    // route carries a query (`/blocks?limit=`, `/mining/status?address=`,
    // `/names?prefix=`…), so matching the whole string against the route table
    // rejected the majority of real reads while single-segment routes passed.
    const [target, query = ''] = splitPathAndQuery(raw);
    if (query.length > 512) {
      this.json(response, 400, { error: 'rpc query is too long', code: 'ERR_REJECTED' });
      return;
    }
    // The allowlist matches the string the CALLER wrote; the node resolves the
    // string `fetch` sends. They are not the same string when it contains dot
    // segments: `/tx/../metrics` starts with `/tx/`, passes the check, and is
    // sent as `/metrics` — a route this proxy was built never to expose. Only a
    // path that is already in the form a node will resolve it in is considered.
    if (!isCleanProxyPath(target)) {
      this.json(response, 400, { error: `route "${target.slice(0, 80)}" is not exposed by the interface proxy`, code: 'ERR_REJECTED' });
      return;
    }
    const upstreamTarget = query ? `${target}?${query}` : target;
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
      // The wallet API. These are the node's own balance routes: the caller
      // must already know the address it is asking about, and the node serves
      // them publicly on its RPC port. Leaving them out of this list is what
      // made the wallet page unable to show a balance and the mining page
      // unable to claim — both failed with "route is not exposed by the
      // interface proxy", which reads as a broken product rather than a
      // missing line in an allowlist.
      target === '/wallet/balance' ||
      target === '/wallet/quote' ||
      /^\/wallet\/[A-Za-z0-9]{8,120}\/next-nonce$/.test(target) ||
      target === '/mining/schedule' ||
      target === '/mining/status' ||
      target === '/mining/claims' ||
      // Proof of Time state and the node runner reward registry: read-only,
      // and already free of wallet balances at the node.
      target === '/pot' ||
      target === '/revenue' ||
      target === '/nodes/registry' ||
      target === '/nodes/rewards' ||
      target.startsWith('/nodes/status/') ||
      target.startsWith('/block/') ||
      target.startsWith('/tx/') ||
      target.startsWith('/address/') ||
      target.startsWith('/names/') ||
      target.startsWith('/audit/');
    if (!allowed) {
      this.json(response, 400, { error: `route "${upstreamTarget}" is not exposed by the interface proxy`, code: 'ERR_REJECTED' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      this.json(response, 405, { error: `${request.method} is not accepted by the interface proxy`, code: 'ERR_REJECTED' });
      return;
    }
    const method = request.method === 'POST' ? 'POST' : 'GET';
    if (method === 'POST' && !PROXY_POST_ROUTES.has(target)) {
      this.json(response, 400, { error: `route "${target}" does not accept POST through the interface proxy`, code: 'ERR_REJECTED' });
      return;
    }
    const payload = method === 'POST' ? await this.readRaw(request) : undefined;
    // The one write. A mining claim is admitted only for a signed-in account
    // that has a wallet linked and signs with it; see admitSubmission().
    if (method === 'POST' && target === '/tx/submit' && !(await this.admitSubmission(request, response, payload ?? ''))) return;

    const attempts = this.dependencies.pool.ordered();
    if (attempts.length === 0) {
      if (this.dependencies.pool.all().some((node) => node.wrongNetwork)) {
        this.json(response, 503, {
          error: `every configured node follows a different network than this interface serves (${this.config.network ?? 'unset'}). Point --nodes at a ${this.config.network ?? 'matching'} node.`,
          code: 'ERR_WRONG_NETWORK',
        });
        return;
      }
      this.json(response, 503, { error: 'no Obsidian nodes are configured for this interface', code: 'ERR_NO_NODES' });
      return;
    }

    let lastError = 'no node answered';
    for (const node of attempts) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const upstream = await fetch(`${node.url}${upstreamTarget}`, {
          method,
          headers: payload ? { 'content-type': 'application/json' } : undefined,
          body: payload,
          signal: controller.signal,
        });
        // Bounded: a node that answers with an endless body must not be able to
        // fill this process's memory.
        const text = await readCapped(upstream, MAX_UPSTREAM_BYTES);
        if (upstream.status >= 500) {
          lastError = `node ${node.url} returned ${upstream.status}`;
          continue;
        }
        this.json(response, upstream.status, safeParse(text), { 'x-obsidian-node': node.url });
        return;
      } catch (error) {
        lastError = `${node.url}: ${(error as Error).message}`;
        void this.dependencies.pool.check(node.url);
      } finally {
        clearTimeout(timer);
      }
    }
    this.json(response, 503, { error: `no healthy Obsidian node: ${lastError}`, code: 'ERR_NO_HEALTHY_NODE' });
  }

  private txCore?: Promise<TxCore>;

  private core(): Promise<TxCore> {
    if (!this.txCore) {
      this.txCore = (this.dependencies.loadCore ?? (() => loadTxCore(this.config.coreDir)))();
      // A failed load must not be remembered forever: the next request retries.
      this.txCore.catch(() => {
        this.txCore = undefined;
      });
    }
    return this.txCore;
  }

  /** Is `address` a well-formed address of THIS interface's network? */
  private async isLinkableAddress(address: string): Promise<boolean> {
    if (!/^(obs|tobs|sobs|dobs)1[0-9a-z]{20,}$/.test(address)) return false;
    const hrp = this.config.network ? interfaceNetwork(this.config.network).addressHrp : address.slice(0, address.indexOf('1'));
    if (!address.startsWith(`${hrp}1`)) return false;
    try {
      return (await this.core()).isValidAddress(address, hrp);
    } catch {
      // Without the core the checksum cannot be verified; the shape and the
      // network prefix were. A bad checksum can never sign a claim anyway.
      return true;
    }
  }

  /**
   * Gate a transaction submission. Returns true when the request may be
   * forwarded to a node; otherwise the answer has been sent.
   *
   * Mining is account-bound; paying and naming are not. So the transaction is
   * decoded here — with the node's own decoder — and only a MINING_CLAIM needs:
   *   1. a signed-in account (401),
   *   2. a linked wallet (403 ERR_WALLET_NOT_LINKED),
   *   3. MFA confirmed, which is what opens mining on an account (403),
   *   4. the claim signed by that linked wallet, not by some other key (403).
   * An undecodable body is refused here rather than forwarded: the node would
   * refuse it too, and nothing that cannot be classified is relayed.
   */
  private async admitSubmission(request: IncomingMessage, response: ServerResponse, payload: string): Promise<boolean> {
    let hex: unknown;
    try {
      hex = (JSON.parse(payload) as { tx?: unknown } | null)?.tx;
    } catch {
      hex = undefined;
    }
    if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
      this.json(response, 400, { error: 'tx must be a hex-encoded signed transaction', code: 'ERR_MALFORMED' });
      return false;
    }
    let core: TxCore;
    try {
      core = await this.core();
    } catch (error) {
      this.dependencies.log('error', 'transaction decoder unavailable', { error: (error as Error).message });
      this.json(response, 503, { error: 'this interface cannot classify transactions right now; nothing was relayed', code: 'ERR_RELAY_UNAVAILABLE' });
      return false;
    }
    let tx: { type: number; sender: string };
    try {
      tx = core.decodeSignedTxFromBytes(Buffer.from(hex, 'hex'));
    } catch (error) {
      this.json(response, 400, { error: `cannot decode transaction: ${(error as Error).message}`, code: 'ERR_MALFORMED' });
      return false;
    }
    if (tx.type !== core.miningClaimType) return true;

    const account = this.requireSession(request, response);
    if (!account) return false;
    if (!account.walletAddress) {
      this.json(response, 403, {
        error: 'link a wallet to your account before mining: open the account page and publish your wallet address',
        code: 'ERR_WALLET_NOT_LINKED',
      });
      return false;
    }
    if (account.miningEnabled !== true) {
      this.json(response, 403, {
        error: 'mining is closed on this account until you confirm two-factor authentication',
        code: 'ERR_MINING_NOT_ENABLED',
      });
      return false;
    }
    if (tx.sender !== account.walletAddress) {
      this.json(response, 403, {
        error: 'this claim is signed by a different wallet than the one linked to your account',
        code: 'ERR_WALLET_MISMATCH',
      });
      return false;
    }
    return true;
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
    if (account.suspended) {
      // Suspension used to be checked only at sign-in, so a suspended account
      // with a live session carried on as before.
      this.json(response, 403, { error: 'this account is suspended', code: 'ERR_ACCOUNT_SUSPENDED' });
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
    mfaEnabled: account.mfaEnabled === true,
    miningEnabled: account.miningEnabled === true,
    // What the server enforces on a claim: a linked wallet AND confirmed MFA.
    miningReady: Boolean(account.walletAddress) && account.miningEnabled === true,
    recoveryCodesRemaining: account.recoveryCodesRemaining ?? 0,
    // Never leaked: passwordHash, totpSecret, recoveryCodeHashes,
    // canonicalEmail (the uniqueness key is a server concern).
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


