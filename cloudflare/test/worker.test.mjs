/**
 * Worker tests.
 *
 * Run with: node --test cloudflare/test/worker.test.mjs
 *
 * These prove the one property that matters: the edge is a cache and a proxy,
 * never an authority. A cached copy of a block list is fine; a cached copy of a
 * transaction submission, or of somebody's account, would be a lie.
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import worker from '../src/worker.js';

/** Minimal Cache API stand-in shaped like Cloudflare's. */
function makeCache() {
  const store = new Map();
  return {
    default: {
      async match(request) {
        const hit = store.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        store.set(request.url, response.clone());
      },
    },
    _store: store,
  };
}

function makeEnv() {
  return { OBSIDIAN_ORIGIN: 'https://interface.example', CHAIN_CACHE_SECONDS: '5' };
}

function makeCtx(cache) {
  return { cacheApi: cache, waitUntil(promise) { return promise; } };
}

function upstreamResponse(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-obsidian-node': 'http://127.0.0.1:8630', ...headers },
  });
}

test('a cacheable chain read carries the node that produced it', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  globalThis.fetch = async () => upstreamResponse({ height: 100 });

  const response = await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/status'), makeEnv(), makeCtx(cache));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-obsidian-node'), 'http://127.0.0.1:8630');
  assert.equal(response.headers.get('x-obsidian-cache'), 'MISS');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('a second identical read is served from the cache, still naming the node', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return upstreamResponse({ height: 100 });
  };

  const first = await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/blocks'), makeEnv(), makeCtx(cache));
  const second = await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/blocks'), makeEnv(), makeCtx(cache));

  assert.equal(calls, 1, 'the origin should be asked once');
  assert.equal(first.headers.get('x-obsidian-cache'), 'MISS');
  assert.equal(second.headers.get('x-obsidian-cache'), 'HIT');
  assert.equal(second.headers.get('x-obsidian-node'), 'http://127.0.0.1:8630');
  await first.text();
  await second.text();
});

test('a transaction submission is never cached and never replayed from cache', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return upstreamResponse({ accepted: true, txId: `tx-${calls}` });
  };

  const send = () =>
    worker.fetch(
      new Request('https://obsidian.example/api/rpc?path=/tx/submit', { method: 'POST', body: '{"tx":"00"}' }),
      makeEnv(),
      makeCtx(cache),
    );

  const first = await send();
  const second = await send();
  assert.equal(calls, 2);
  assert.equal((await first.json()).txId, 'tx-1');
  assert.equal((await second.json()).txId, 'tx-2');
});

test('account and session routes bypass the cache entirely', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return upstreamResponse({ account: { email: `user${calls}@example.com` } });
  };

  await worker.fetch(new Request('https://obsidian.example/api/auth/me', { headers: { cookie: 'obsidian_session=abc' } }), makeEnv(), makeCtx(cache));
  await worker.fetch(new Request('https://obsidian.example/api/auth/me', { headers: { cookie: 'obsidian_session=abc' } }), makeEnv(), makeCtx(cache));
  assert.equal(calls, 2, 'a session check must always reach the origin');
});

test('an unreachable origin is reported honestly, not papered over with stale data', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  globalThis.fetch = async () => {
    throw new Error('connect ECONNREFUSED');
  };

  const response = await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/status'), makeEnv(), makeCtx(cache));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.code, 'ERR_ORIGIN_UNREACHABLE');
  assert.match(body.note, /nodes/i);
});

test('a gateway with no origin configured refuses to guess one', async () => {
  const response = await worker.fetch(new Request('https://obsidian.example/'), {}, {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'ERR_NO_ORIGIN');
});

test('the worker does not weaken the interface CSP or add its own scripts', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  globalThis.fetch = async () =>
    new Response('<!doctype html>landing', {
      status: 200,
      headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'self'; script-src 'self'" },
    });

  const response = await worker.fetch(new Request('https://obsidian.example/'), makeEnv(), makeCtx(cache));
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'; script-src 'self'");
  assert.match(await response.text(), /landing/);
});

/**
 * The configuration is part of the deployment, not a note beside it.
 *
 * A worker published with `OBSIDIAN_ORIGIN = "https://interface.example"`
 * deploys successfully and serves a broken site from a real hostname, which
 * is the kind of failure that gets noticed by users rather than by CI.
 */
test('the shipped wrangler.toml is rejected until its placeholders are filled in', async () => {
  const { execFileSync } = await import('node:child_process');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const checker = resolve(here, '..', 'check-wrangler.mjs');

  let failed = false;
  let output = '';
  try {
    output = execFileSync(process.execPath, [checker], { encoding: 'utf8' });
  } catch (error) {
    failed = true;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  assert.equal(failed, true, 'the template must not pass the readiness check');
  assert.match(output, /not ready to deploy/);
  assert.match(output, /account_id/);
});

test('a filled-in config passes the same check', async () => {
  const { execFileSync } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const checker = resolve(here, '..', 'check-wrangler.mjs');

  const dir = mkdtempSync(join(tmpdir(), 'wrangler-'));
  const file = join(dir, 'wrangler.toml');
  writeFileSync(
    file,
    [
      'name = "obsidian-gateway"',
      'main = "src/worker.js"',
      'account_id = "0123456789abcdef0123456789abcdef"',
      '[vars]',
      'OBSIDIAN_ORIGIN = "https://interface.obsidian.network"',
      '[[routes]]',
      'pattern = "obsidian.network/*"',
      'zone_name = "obsidian.network"',
      '',
    ].join('\n'),
  );
  try {
    const output = execFileSync(process.execPath, [checker, file], { encoding: 'utf8' });
    assert.match(output, /ready to deploy/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a cached chain read states its lifetime in both cache directives', async () => {
  // Cloudflare's Cache API example uses `s-maxage` to bound an entry stored with
  // cache.put; `max-age` is the browser-facing directive. The worker promised a
  // CHAIN_CACHE_SECONDS staleness bound, so it says it in both.
  const cache = makeCache();
  globalThis.caches = cache;
  globalThis.fetch = async () => upstreamResponse({ height: 100 });

  await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/status'), makeEnv(), makeCtx(cache));
  const stored = [...cache._store.values()][0];
  assert.match(stored.headers.get('cache-control'), /max-age=5\b/);
  assert.match(stored.headers.get('cache-control'), /s-maxage=5\b/);

  // And the cached copy that is served still names the node that produced it.
  const hit = await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/status'), makeEnv(), makeCtx(cache));
  assert.equal(hit.headers.get('x-obsidian-cache'), 'HIT');
  assert.equal(hit.headers.get('x-obsidian-node'), 'http://127.0.0.1:8630');
});

test('the origin is told who the client really is, and which host the browser used', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let seen;
  globalThis.fetch = async (_target, init) => {
    seen = init.headers;
    return upstreamResponse({ ok: true });
  };
  // A visitor tries to pick their own rate-limit bucket and their own origin.
  const request = new Request('https://obsidian.example/api/auth/login', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '198.51.100.7',
      'x-forwarded-for': '203.0.113.99',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'http',
      'x-real-ip': '203.0.113.98',
      origin: 'https://obsidian.example',
    },
    body: '{}',
  });
  await worker.fetch(request, makeEnv(), makeCtx(cache));
  assert.equal(seen.get('x-forwarded-for'), '198.51.100.7', 'the address Cloudflare saw, not the one the visitor wrote');
  assert.equal(seen.get('x-forwarded-host'), 'obsidian.example', 'the host the browser used, which is what its Origin header names');
  assert.equal(seen.get('x-forwarded-proto'), 'https');
  assert.equal(seen.get('x-real-ip'), null);
  assert.equal(seen.get('cf-connecting-ip'), null);
  assert.equal(seen.get('origin'), 'https://obsidian.example');
});

test('with no cf-connecting-ip the worker invents no client address', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let seen;
  globalThis.fetch = async (_target, init) => {
    seen = init.headers;
    return upstreamResponse({ ok: true });
  };
  await worker.fetch(new Request('https://obsidian.example/api/rpc?path=/status', { headers: { 'x-forwarded-for': '203.0.113.99' } }), makeEnv(), makeCtx(cache));
  assert.equal(seen.get('x-forwarded-for'), null, 'a visitor-supplied value must not survive');
});

test('per-user reads are never cached: a stale nonce would break a wallet\u2019s second transaction', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return upstreamResponse({ nextNonce: calls });
  };
  const url = 'https://obsidian.example/api/rpc?path=' + encodeURIComponent('/wallet/dobs1qqqqqqqq/next-nonce');
  for (const path of ['/wallet/dobs1qqqqqqqq/next-nonce', '/mining/status', '/mempool', '/address/dobs1qqqq', '/tx/abc']) {
    const target = 'https://obsidian.example/api/rpc?path=' + path;
    await (await worker.fetch(new Request(target), makeEnv(), makeCtx(cache))).text();
    await (await worker.fetch(new Request(target), makeEnv(), makeCtx(cache))).text();
  }
  await (await worker.fetch(new Request(url), makeEnv(), makeCtx(cache))).text();
  assert.equal(calls, 11, 'every one of those reads must reach the origin');
  assert.equal(cache._store.size, 0);
});

test('the terraform cache rule is no wider than the worker\u2019s own list', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, resolve } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const terraform = readFileSync(resolve(here, '../terraform/main.tf'), 'utf8');
  const source = readFileSync(resolve(here, '../src/worker.js'), 'utf8');
  const fromWorker = [...source.matchAll(/'\/api\/rpc\?path=([^']+)'/g)].map((match) => match[1]).sort();
  const block = terraform.match(/cacheable_rpc_paths = \[([^\]]+)\]/s)?.[1] ?? '';
  const fromTerraform = [...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(fromTerraform, fromWorker);
  assert.ok(!/starts_with\(http\.request\.uri\.path, \\"\/api\/rpc\\"\)/.test(terraform), 'the blanket /api/rpc rule must be gone');
  assert.match(terraform, /not http\.cookie contains/);
});

test('wrangler.toml declares only what the worker reads', async () => {
  // A setting the worker ignores is a resource an operator has to invent or create — and the
  // deploy check refuses to pass until they do — for nothing. It used to ship an assets origin
  // and a KV namespace that nothing referenced.
  const { readFileSync } = await import('node:fs');
  const { dirname, resolve } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const toml = readFileSync(resolve(here, '..', 'wrangler.toml'), 'utf8');
  const source = readFileSync(resolve(here, '..', 'src', 'worker.js'), 'utf8');

  const active = toml.split('\n').filter((line) => !line.trim().startsWith('#'));
  const section = (name) => {
    const start = active.findIndex((line) => line.trim() === `[${name}]`);
    if (start < 0) return [];
    const out = [];
    for (let i = start + 1; i < active.length && !/^\s*\[/.test(active[i]); i += 1) out.push(active[i]);
    return out;
  };
  const vars = section('vars').map((line) => line.match(/^\s*([A-Z_]+)\s*=/)?.[1]).filter(Boolean);
  assert.ok(vars.length >= 2, 'expected [vars] to be found');
  for (const name of vars) assert.match(source, new RegExp(`env\\.${name}\\b`), `[vars] sets ${name}, which src/worker.js never reads`);
  assert.ok(!/^\s*\[\[(?:kv_namespaces|r2_buckets|d1_databases|durable_objects)/m.test(active.join('\n')), 'a binding is declared that the worker does not use');
});

test('a read for one trusted site is never served to another, and never to a same-origin page', async () => {
  // The interface answers a page on another trusted origin with Access-Control-Allow-Origin naming that
  // page. If the cache stored that answer under the plain URL, the next visitor would be handed another
  // site's name and the browser would refuse the read.
  const cache = makeCache();
  globalThis.caches = cache;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls += 1;
    const origin = new Headers(init.headers).get('origin');
    return upstreamResponse({ height: 100 }, origin ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {});
  };
  const read = (origin) =>
    worker.fetch(new Request('https://obsmainnet.example/api/rpc?path=/status', origin ? { headers: { origin } } : {}), makeEnv(), makeCtx(cache));

  const wallet = await read('https://wallet.obsmainnet.example');
  assert.equal(wallet.headers.get('access-control-allow-origin'), 'https://wallet.obsmainnet.example');
  const explorer = await read('https://explorer.obsmainnet.example');
  assert.equal(explorer.headers.get('access-control-allow-origin'), 'https://explorer.obsmainnet.example', 'a second site gets its own name, not the first site\'s');
  const plain = await read(undefined);
  assert.equal(plain.headers.get('access-control-allow-origin'), null, 'a same-origin read carries no other site\'s name');
  assert.equal(calls, 3, 'three different audiences, three upstream reads');

  // The same site asking again IS served from the cache, still naming itself.
  const again = await read('https://wallet.obsmainnet.example');
  assert.equal(again.headers.get('x-obsidian-cache'), 'HIT');
  assert.equal(again.headers.get('access-control-allow-origin'), 'https://wallet.obsmainnet.example');
  assert.equal(calls, 3);
});

test('an origin the interface refused is never cached', async () => {
  const cache = makeCache();
  globalThis.caches = cache;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'origin not allowed', code: 'ERR_FORBIDDEN' }), { status: 403, headers: { 'content-type': 'application/json' } });
  };
  const ask = () => worker.fetch(new Request('https://obsmainnet.example/api/rpc?path=/status', { headers: { origin: 'https://evil.test' } }), makeEnv(), makeCtx(cache));
  assert.equal((await ask()).status, 403);
  assert.equal((await ask()).status, 403);
  assert.equal(calls, 2);
  assert.equal(cache._store.size, 0);
});
