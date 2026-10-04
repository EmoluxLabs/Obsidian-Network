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
      'OBSIDIAN_ASSETS_ORIGIN = "https://interface.obsidian.network"',
      '[[routes]]',
      'pattern = "obsidian.network/*"',
      'zone_name = "obsidian.network"',
      '[[kv_namespaces]]',
      'binding = "OBSIDIAN_CACHE"',
      'id = "f00dcafef00dcafef00dcafef00dcafe"',
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
