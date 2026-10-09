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

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, '..', 'public');

const PORT = Number(process.env.APP_PORT ?? 8790);
const HOST = process.env.APP_HOST ?? '0.0.0.0';

/**
 * The Obsidian Web platform. Required rather than defaulted: an app that silently
 * starts with no backend renders a design full of empty states and looks broken
 * rather than misconfigured. Failing at boot says which.
 */
const PLATFORM_URL = process.env.OBSIDIAN_PLATFORM_URL;

const USAGE = `Obsidian app server

  APP_PORT              port to listen on            (default 8790)
  APP_HOST              address to bind              (default 0.0.0.0)
  OBSIDIAN_PLATFORM_URL origin of the Obsidian Web platform, e.g.
                        https://obsidian.example  (required)

Serves ./public and proxies /api/* to the platform. Holds no session state.
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
  const decoded = decodeURIComponent(pathname);
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

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
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

  const peer = req.socket.remoteAddress ?? '';
  const prior = headers['x-forwarded-for'];
  const chain = typeof prior === 'string' ? prior.split(',').map((s) => s.trim()).filter(Boolean) : [];
  // Keep what the caller claimed, then append what this socket actually is: the
  // last entry is then always the address this server saw, never a claim.
  headers['x-forwarded-for'] = [...chain, peer].join(', ');
  return headers;
}

async function proxy(req, res, url) {
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

    const responseHeaders = {};
    for (const [key, value] of upstream.headers) {
      // Hop-by-hop and encoding headers must not be replayed: the body is
      // re-streamed here, so a content-length or content-encoding from upstream
      // would describe bytes this response is not sending.
      if (['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) continue;
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
    // A platform that cannot be reached is reported as such. It is never turned
    // into an empty 200, which the app would render as a chain with no data.
    send(res, 502, {
      error: 'the Obsidian platform could not be reached',
      code: 'ERR_PLATFORM_UNREACHABLE',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

async function serveStatic(req, res, url) {
  const file = await resolveStatic(url.pathname);
  if (!file) {
    // A single-page app: an unknown path that is not a file gets the shell, so
    // client-side routes survive a reload. Only non-API GETs reach here.
    const shell = await resolveStatic('/index.html');
    if (!shell) return send(res, 404, { error: 'not found', code: 'ERR_NOT_FOUND' });
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    createReadStream(shell).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, platform: PLATFORM_URL ?? null });
  }

  if (url.pathname.startsWith('/api/')) {
    if (!PLATFORM_URL) {
      return send(res, 503, {
        error: 'this app has no platform configured',
        code: 'ERR_PLATFORM_UNCONFIGURED',
      });
    }
    return proxy(req, res, url);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed', code: 'ERR_METHOD' });
  }

  return serveStatic(req, res, url);
});

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (!PLATFORM_URL) {
  process.stderr.write(
    'OBSIDIAN_PLATFORM_URL is not set. Refusing to start: the app would render\n' +
    'empty states everywhere and look broken instead of misconfigured.\n\n' + USAGE,
  );
  process.exit(2);
}

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `Obsidian app  http://${HOST}:${PORT}\n` +
    `  platform    ${PLATFORM_URL}\n` +
    `  public      ${PUBLIC_DIR}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
