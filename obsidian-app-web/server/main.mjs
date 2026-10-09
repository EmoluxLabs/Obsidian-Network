#!/usr/bin/env node
/**
 * The Obsidian app server.
 *
 * Deliberately dependency-free, in the same house style as
 * obsidian-interface/server: Node's own http module, no framework, no build step.
 *
 * It does two jobs and nothing else:
 *
 *   1. Serve the static app from ./public.
 *   2. Proxy /api/* to the Obsidian Web platform.
 *
 * The proxy is the reason this server exists at all. The browser talks to one
 * origin only, which means one cookie jar, one CORS story and one place a failure
 * can come from. It also keeps the platform's address off the client: the app never
 * learns where the platform lives, so a deployed app cannot be pointed somewhere
 * else by editing its JavaScript.
 *
 * This server holds no account state, no keys and no session of its own. It is a
 * pipe. Anything that looks like a decision about an account belongs to the
 * platform, and stays there.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originAllowed as checkOrigin, parseAllowedOrigins } from './origin.mjs';
import { NETWORK_NAMES, networkFor, publicConfig, verifyPlatform } from './networks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '..', 'public');

/**
 * Which network this deployment is. Required, never defaulted: there is deliberately
 * no network an app silently becomes. See server/networks.mjs.
 */
let NETWORK = null;
let NETWORK_ERROR = null;
try {
  NETWORK = networkFor(process.env.OBSIDIAN_APP_NETWORK);
} catch (error) {
  NETWORK_ERROR = error instanceof Error ? error.message : String(error);
}

const PORT = Number(process.env.APP_PORT ?? NETWORK?.appPort ?? 8790);
const HOST = process.env.APP_HOST ?? '0.0.0.0';
const RECHECK_MS = Number(process.env.APP_NETWORK_RECHECK_MS ?? 30_000);

/**
 * The last answer to "is the platform on the network this app claims to be?".
 * `pending` until the first check; `unreachable` and `unverified` are tolerated
 * (an outage is not a mismatch); `mismatch` is not, and closes the API.
 */
let verification = { state: 'pending', detail: 'not checked yet' };

/**
 * The Obsidian Web platform. Required rather than defaulted: an app that silently
 * starts with no backend renders a design full of empty states and looks broken
 * rather than misconfigured. Failing at boot says which.
 */
const PLATFORM_URL = process.env.OBSIDIAN_PLATFORM_URL;

const USAGE = `Obsidian app server

  OBSIDIAN_APP_NETWORK  ${NETWORK_NAMES.join(' | ')}        (required, no default)
  OBSIDIAN_PLATFORM_URL origin of the Obsidian Web platform FOR THAT NETWORK, e.g.
                        https://obsidian.example  (required)
  APP_PORT              port to listen on   (default per network:
                        mainnet 8790, testnet 18790, staging 28790, devnet 38790)
  APP_HOST              address to bind              (default 0.0.0.0)
  APP_NETWORK_RECHECK_MS  how often the platform's network is re-verified (default 30000)
  APP_TRUST_PROXY       true ONLY behind a reverse proxy you control that writes X-Forwarded-For: the visitor's
                        address is then taken from it, so the platform rate-limits per visitor (default false)
  APP_ALLOWED_ORIGINS   extra exact origins allowed to make state-changing API calls, comma separated
                        (default none: only this app's own origin and browser extensions)

Serves ./public and proxies /api/* to the platform. Holds no session state.
Refuses to start in front of a platform that reports a different network.
`;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/**
 * Resolve a request path to a file inside PUBLIC_DIR.
 *
 * Returns null rather than throwing for anything that escapes the root, so a
 * crafted path cannot read outside it.
 */
async function resolveStatic(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // A lone `%` or a broken UTF-8 sequence. This used to throw out of an async handler, and an unhandled
    // rejection ends the process: one unauthenticated request took the whole app down.
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? '/index.html' : decoded;
  const target = resolve(PUBLIC_DIR, '.' + normalize(rel));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + '/')) return null;
  try {
    const info = await stat(target);
    if (!info.isFile()) return null;
    return target;
  } catch {
    return null;
  }
}

/**
 * Sent on every response this server makes, including the proxied ones.
 *
 * The app holds a wallet and signs with it, so it must not be framed (a transparent frame over a real page turns a
 * click into a signature), must not be sniffed into another type, and must only talk to itself. The platform sets
 * the same family of headers on its own pages; this server is the front door for the app, so it sets them too.
 * script-src keeps 'unsafe-inline' because the design's own markup uses inline handlers and one inline boot
 * script; everything else is closed (no framing, no plugins, no <base>, no remote connections, no foreign forms).
 */
const SECURITY_HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // camera is the QR scanner, and only on this origin
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * May this browser request use the API?
 *
 * The proxy drops `Origin` before forwarding (see forwardHeaders), which switches OFF the platform's own check of
 * who is calling. So the check has to happen here, at the first hop that still sees the header. A request that
 * changes anything must come from this app's own origin, or from a browser extension (the Obsidian extension
 * calls this server from chrome-extension:// or moz-extension://), or from an origin the operator listed in
 * APP_ALLOWED_ORIGINS. No Origin at all means not a browser form or fetch (curl, a server, a native app), and
 * a cross-site browser request that hides its Origin is caught by Sec-Fetch-Site.
 * The session cookie is SameSite=Lax, which already stops the common case; this is the second wall, and the one
 * that holds against a sibling subdomain, where Lax does not.
 */
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.APP_ALLOWED_ORIGINS);
const TRUST_PROXY = process.env.APP_TRUST_PROXY === 'true';
const IP_LIKE = /^[0-9a-fA-F:.]{3,45}$/;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * Forward one request to the platform.
 *
 * Cookies pass through untouched in both directions, because the session belongs
 * to the platform and the browser has to hold its cookie for it to mean anything.
 * Nothing is rewritten, cached or interpreted here: a 4xx from the platform stays
 * a 4xx, so the app shows the server's own reason instead of a generic one. The
 * one exception is the pair of browser-only headers described in forwardHeaders,
 * which are dropped because they would otherwise decide the platform's answer.
 */
/**
 * Request headers to forward, and the two that must not be.
 *
 * `Origin` and `Referer` are dropped on purpose. The platform decides whether a
 * caller may use its API by comparing `Origin` against its own origin and then
 * against the operator's allowlist — a browser-facing check. This process is not a
 * browser: it is the operator's own server, and the decision to let it call the
 * platform was already made by setting OBSIDIAN_PLATFORM_URL. Forwarding the
 * browser's origin makes the platform see a foreign caller it was never told
 * about, so every POST — sign-in included — answers 403 "origin not allowed" until
 * someone adds the app's origin to OBSIDIAN_INTERFACE_ALLOWED_ORIGINS. That turns
 * a working deployment into a configuration exercise, and a misconfigured one
 * looks identical to a broken app.
 *
 * `X-Forwarded-For` is rebuilt rather than passed through. The platform reads the
 * LAST entry to decide who to rate-limit, precisely because anything earlier in
 * the chain is client-supplied. A proxy that forwards the header untouched lets a
 * caller write their own last entry and spend somebody else's request budget.
 */
function forwardHeaders(req) {
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers.origin;
  delete headers.referer;

  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
  const prior = headers['x-forwarded-for'];
  const chain = typeof prior === 'string' ? prior.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // Keep what the caller claimed, then append what this socket actually is: the
  // last entry is then always the address this server saw, never a claim.
  //
  // Behind the operator's own reverse proxy (nginx, Cloudflare) the socket is the PROXY, so appending it makes every
  // visitor look like one client to the platform's rate limiter: a handful of requests would lock everyone out of
  // sign-in. With APP_TRUST_PROXY=true the last entry the proxy wrote is the visitor, and it stays last.
  const visitor = TRUST_PROXY ? chain.at(-1) : undefined;
  headers['x-forwarded-for'] = visitor && IP_LIKE.test(visitor) ? chain.join(', ') : [...chain, peer].join(', ');
  return headers;
}

const MAX_BODY_BYTES = 1_000_000;

async function proxy(req, res, url) {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    // The body is never read, so this connection must not be reused for another request.
    return send(res, 413, { error: 'request body too large', code: 'ERR_BODY_TOO_LARGE' }, { Connection: 'close' });
  }
  const target = PLATFORM_URL.replace(/\/$/, '') + url.pathname + url.search;
  const headers = forwardHeaders(req);

  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      // The platform sets its own session cookie; let it through unmodified.
      redirect: 'manual',
      duplex: 'half',
    });

    const responseHeaders = { ...SECURITY_HEADERS };
    for (const [key, value] of upstream.headers) {
      // Hop-by-hop and encoding headers must not be replayed: the body is
      // re-streamed here, so a content-length or content-encoding from upstream
      // would describe bytes this response is not sending.
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) continue;
      if (Object.keys(SECURITY_HEADERS).some((h) => h.toLowerCase() === key.toLowerCase())) continue;
      if (key.toLowerCase() === 'set-cookie') {
        const existing = responseHeaders[key];
        responseHeaders[key] = existing ? [].concat(existing, value) : value;
        continue;
      }
      responseHeaders[key] = value;
    }

    res.writeHead(upstream.status, responseHeaders);
    if (upstream.body) {
      for await (const chunk of upstream.body) res.write(chunk);
    }
    res.end();
  } catch (error) {
    // Headers already sent: the status line is gone and cannot be changed, and writeHead would throw out of
    // this handler. Cut the connection instead, so the browser sees a failed request and not a truncated "success".
    if (res.headersSent) return void res.destroy();
    // A platform that cannot be reached is reported as such. It is never turned
    // into an empty 200, which the app would render as a chain with no data.
    send(res, 502, {
      error: 'the Obsidian platform could not be reached',
      code: 'ERR_PLATFORM_UNREACHABLE',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

/** A file that vanishes between stat and open emits 'error' on the stream; unhandled, that ends the process. */
function pipeFile(res, file, type) {
  const stream = createReadStream(file);
  stream.once('open', () => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': type });
    stream.pipe(res);
  });
  stream.once('error', () => {
    if (res.headersSent) res.destroy();
    else send(res, 404, { error: 'not found', code: 'ERR_NOT_FOUND' });
  });
  res.once('close', () => stream.destroy());
}

async function serveStatic(req, res, url) {
  const file = await resolveStatic(url.pathname);
  if (!file) {
    // A single-page app: an unknown path that is not a file gets the shell, so
    // client-side routes survive a reload. Only non-API GETs reach here.
    const shell = await resolveStatic('/index.html');
    if (!shell) return send(res, 404, { error: 'not found', code: 'ERR_NOT_FOUND' });
    return pipeFile(res, shell, TYPES['.html']);
  }
  return pipeFile(res, file, TYPES[extname(file)] ?? 'application/octet-stream');
}

async function handle(req, res) {
  let url;
  try {
    // The Host header is attacker-controlled and `new URL` throws on a malformed one.
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    return send(res, 400, { error: 'bad request', code: 'ERR_BAD_REQUEST' });
  }

  if (url.pathname === '/healthz') {
    return send(res, verification.state === 'mismatch' ? 503 : 200, {
      ok: verification.state !== 'mismatch',
      platform: PLATFORM_URL ?? null,
      network: NETWORK?.name ?? null,
      verification: verification.state,
      detail: verification.detail,
    });
  }

  // The app's own identity, for the browser. Never cached: a deployment that moved
  // networks must not keep telling browsers it is still the old one.
  if (url.pathname === '/app-config.json') {
    return send(res, 200, publicConfig(NETWORK, verification), { 'Cache-Control': 'no-store' });
  }

  if (url.pathname.startsWith('/api/')) {
    if (verification.state === 'mismatch') {
      return send(res, 503, {
        error: `this app is the ${NETWORK.name} app, but its platform is not on ${NETWORK.name}: ${verification.detail}`,
        code: 'ERR_NETWORK_MISMATCH',
      });
    }
    if (!PLATFORM_URL) {
      return send(res, 503, {
        error: 'this app has no platform configured',
        code: 'ERR_PLATFORM_UNCONFIGURED',
      });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !checkOrigin(req.headers, ALLOWED_ORIGINS)) {
      return send(res, 403, { error: 'this request did not come from this app', code: 'ERR_ORIGIN_NOT_ALLOWED' });
    }
    return proxy(req, res, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed', code: 'ERR_METHOD' });
  }

  return serveStatic(req, res, url);
}

// One handler failing must answer 500, never take the process down: an async handler that rejects is an
// unhandled rejection, and Node ends the process for those.
const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    process.stderr.write(`request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    if (res.headersSent) res.destroy();
    else send(res, 500, { error: 'internal error', code: 'ERR_INTERNAL' });
  });
});
server.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  else socket.destroy();
});

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (!NETWORK) {
  process.stderr.write(
    `OBSIDIAN_APP_NETWORK is not usable: ${NETWORK_ERROR}.\n` +
    'Refusing to start. An app that guesses its network can sign for the wrong chain.\n\n' + USAGE,
  );
  process.exit(2);
}

if (!PLATFORM_URL) {
  process.stderr.write(
    'OBSIDIAN_PLATFORM_URL is not set. Refusing to start: the app would render\n' +
    'empty states everywhere and look broken instead of misconfigured.\n\n' + USAGE,
  );
  process.exit(2);
}

async function recheck() {
  const before = verification.state;
  verification = await verifyPlatform(PLATFORM_URL, NETWORK);
  if (verification.state !== before) {
    process.stderr.write(`network check: ${before} -> ${verification.state} (${verification.detail})\n`);
  }
}

await recheck();
if (verification.state === 'mismatch') {
  process.stderr.write(
    `Refusing to start: this is the ${NETWORK.name} app, but ${PLATFORM_URL} reports a\n` +
    `different network (${verification.detail}).\n` +
    'Point OBSIDIAN_PLATFORM_URL at the platform for this network, or change OBSIDIAN_APP_NETWORK.\n',
  );
  process.exit(3);
}

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Obsidian app  http://${HOST}:${PORT}\n` +
    `  network     ${NETWORK.name} (chain ${NETWORK.chainId}, prefix ${NETWORK.addressHrp}1)\n` +
    `  platform    ${PLATFORM_URL}  [${verification.state}: ${verification.detail}]\n` +
    `  public      ${PUBLIC_DIR}\n`,
  );
  if (verification.state !== 'ok') {
    process.stderr.write(
      `WARNING: the platform's network could not be confirmed (${verification.state}). ` +
      'It is checked again every ' + Math.round(RECHECK_MS / 1000) + 's, and the API closes if it turns out to be wrong.\n',
    );
  }
});

// A platform can be repointed after this process started. Keep asking.
setInterval(() => recheck().catch(() => {}), RECHECK_MS).unref();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
