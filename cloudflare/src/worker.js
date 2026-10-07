/**
 * Obsidian edge gateway.
 *
 * Contract, in one sentence: forward requests to an Obsidian Interface, cache
 * only what is safe to cache, and never answer a question the origin did not
 * answer.
 *
 * Concretely:
 *   - `POST` is never cached and never served from cache (that is how signed
 *     transactions travel — a cached reply would be a lie about acceptance).
 *   - `/api/auth/*`, `/api/wallet/*` and anything carrying a cookie bypass the
 *     cache entirely, so one browser's session can never leak to another.
 *   - `/api/rpc` reads may be cached for CHAIN_CACHE_SECONDS, and the cached
 *     response keeps its `x-obsidian-node` header, which names the node that
 *     actually produced the data.
 *   - If the origin fails, the worker returns an honest 503 describing the
 *     failure instead of fabricating chain state.
 */

const CACHEABLE_RPC_PREFIXES = [
  '/api/rpc?path=/status',
  '/api/rpc?path=/blocks',
  '/api/rpc?path=/names',
  '/api/rpc?path=/mining/schedule',
  '/api/rpc?path=/oracle',
  '/api/rpc?path=/network',
  '/api/rpc?path=/audit',
  // Proof of Time state and the node runner registry are public, read-only and
  // change at most once per block, so they cache exactly like /status does.
  // `/nodes/status/` is included deliberately: it exposes no balance, only the
  // score and evidence the chain already publishes to everyone.
  '/api/rpc?path=/pot',
  '/api/rpc?path=/revenue',
  '/api/rpc?path=/nodes',
];

const NEVER_CACHE = ['/api/auth/', '/api/wallet/', '/api/nodes/refresh'];

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'permissions-policy': 'geolocation=(self), camera=(), microphone=()',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = (env.OBSIDIAN_ORIGIN ?? '').replace(/\/+$/, '');
    if (!origin) return json(503, { error: 'the gateway has no origin configured', code: 'ERR_NO_ORIGIN' });

    const isApi = url.pathname.startsWith('/api/');
    const isWrite = request.method !== 'GET' && request.method !== 'HEAD';
    const carriesCookies = request.headers.has('cookie');
    const neverCache = NEVER_CACHE.some((prefix) => url.pathname.startsWith(prefix)) || carriesCookies || isWrite;
    const cacheable = !neverCache && isApi && CACHEABLE_RPC_PREFIXES.some((prefix) => (url.pathname + url.search).startsWith(prefix));

    if (cacheable) {
      const cache = caches.default;
      // A page on another trusted origin gets `Access-Control-Allow-Origin` naming ITSELF, so its copy
      // must not be handed to a page on a third origin (the browser would refuse it) or to a plain
      // same-origin read (it would carry another site's name). Each origin has its own entry; only an
      // origin the interface answered is ever stored, because a refusal is not `ok`.
      const requestOrigin = request.headers.get('origin');
      const foreignOrigin = requestOrigin !== null && requestOrigin !== url.origin;
      const cacheKey = new Request(
        `${url.origin}${url.pathname}${url.search}${foreignOrigin ? `${url.search ? '&' : '?'}x-cors-origin=${encodeURIComponent(requestOrigin)}` : ''}`,
        { method: 'GET' },
      );
      const hit = await cache.match(cacheKey);
      if (hit) {
        const response = new Response(hit.body, hit);
        response.headers.set('x-obsidian-cache', 'HIT');
        return withSecurityHeaders(response);
      }
      const fetched = await fetchUpstream(request, origin, url);
      if (fetched.ok && fetched.headers.get('x-obsidian-node')) {
        // Both directives, deliberately. `max-age` is what a browser obeys;
        // `s-maxage` is what the Workers Cache API is documented to honour when
        // storing a response with `cache.put`, and Cloudflare's own Cache API
        // example sets exactly that. Emitting only `max-age` left the entry's
        // lifetime to platform behaviour the worker never stated, and this
        // cache exists to bound staleness at CHAIN_CACHE_SECONDS — not to hope.
        const seconds = Number(env.CHAIN_CACHE_SECONDS ?? 5);
        const store = new Response(fetched.clone().body, fetched);
        store.headers.set('cache-control', `public, max-age=${seconds}, s-maxage=${seconds}`);
        ctx.waitUntil(cache.put(cacheKey, store));
      }
      const response = new Response(fetched.body, fetched);
      response.headers.set('x-obsidian-cache', 'MISS');
      return withSecurityHeaders(response);
    }

    const upstream = await fetchUpstream(request, origin, url);
    return withSecurityHeaders(upstream);
  },
};

async function fetchUpstream(request, origin, url) {
  const incoming = url ?? new URL(request.url);
  const target = `${origin}${incoming.pathname}${incoming.search}`;
  const init = {
    method: request.method,
    headers: filterHeaders(request.headers, incoming.host),
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'manual',
  };
  try {
    // Node's fetch requires duplex when streaming a body; Workers tolerate it.
    if (init.body) init.duplex = 'half';
    return await fetch(target, init);
  } catch (error) {
    return json(503, {
      error: `the interface origin could not be reached (${error?.message ?? 'network error'})`,
      code: 'ERR_ORIGIN_UNREACHABLE',
      note: 'Obsidian nodes may still be running: point this gateway at another interface, or read a node directly.',
    });
  }
}

/**
 * Headers for the origin.
 *
 * The origin has to know two things this hop would otherwise erase, and it must
 * not be able to be lied to about either:
 *
 *   - WHO the client is. Every request now reaches the origin from this edge, so
 *     without the client's address the interface rate-limits the whole world as
 *     one client. Cloudflare sets `cf-connecting-ip` itself; anything the
 *     visitor sent as `x-forwarded-for` is theirs, and is replaced.
 *   - WHICH host the browser used. A browser sends `Origin: https://<public
 *     host>` with every sign-in; the origin sees a different Host, and without
 *     the public one it refuses its own users as a cross-origin attack.
 *
 * The origin should accept these only from this gateway (see docs/ORACLE-VPS-
 * DEPLOYMENT.md): restrict it to Cloudflare's address ranges.
 */
function filterHeaders(headers, publicHost) {
  const forwarded = new Headers();
  for (const [key, value] of headers) {
    if (
      key === 'host' ||
      key === 'cf-connecting-ip' ||
      key === 'cf-ray' ||
      key === 'x-forwarded-for' ||
      key === 'x-forwarded-host' ||
      key === 'x-forwarded-proto' ||
      key === 'x-real-ip'
    ) {
      continue;
    }
    forwarded.set(key, value);
  }
  const client = headers.get('cf-connecting-ip');
  if (client) forwarded.set('x-forwarded-for', client);
  if (publicHost) forwarded.set('x-forwarded-host', publicHost);
  forwarded.set('x-forwarded-proto', 'https');
  return forwarded;
}

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(key)) headers.set(key, value);
  }
  // The interface owns its own CSP; never weaken it here.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS },
  });
}
