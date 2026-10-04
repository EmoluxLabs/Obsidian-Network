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
  '/api/rpc?path=/land',
  '/api/rpc?path=/capsules',
  '/api/rpc?path=/social',
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
      const cacheKey = new Request(`${url.origin}${url.pathname}${url.search}`, { method: 'GET' });
      const hit = await cache.match(cacheKey);
      if (hit) {
        const response = new Response(hit.body, hit);
        response.headers.set('x-obsidian-cache', 'HIT');
        return withSecurityHeaders(response);
      }
      const fetched = await fetchUpstream(request, origin);
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
  const target = url ? `${origin}${url.pathname}${url.search}` : `${origin}${new URL(request.url).pathname}${new URL(request.url).search}`;
  const init = {
    method: request.method,
    headers: filterHeaders(request.headers),
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

function filterHeaders(headers) {
  const forwarded = new Headers();
  for (const [key, value] of headers) {
    if (key === 'host' || key === 'cf-connecting-ip' || key === 'cf-ray') continue;
    forwarded.set(key, value);
  }
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
