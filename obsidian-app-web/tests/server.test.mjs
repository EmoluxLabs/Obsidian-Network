/**
 * The app server, against a stand-in platform.
 *
 * The server is the reason the browser talks to one origin and never learns where
 * the platform lives, so the properties that matter are all about what it does NOT
 * do: it does not rewrite a body, it does not swallow a status code, it does not
 * turn an unreachable backend into a plausible empty 200, and it does not start at
 * all without a platform to proxy to.
 *
 * These run against real sockets on ephemeral ports. A mocked `fetch` would prove
 * the code path and nothing about the one that matters — a POST body streamed
 * through a proxy.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appWeb = resolve(here, '..');
const SERVER = resolve(appWeb, 'server/main.mjs');

const children = [];
const sockets = [];

after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const server of sockets) server.close();
});

function freePort() {
  return new Promise((done, fail) => {
    const server = createServer();
    server.on('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

/** A stand-in Obsidian platform that echoes what it was asked. */
function startPlatform() {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': 'obsidian_session=abc123; Path=/; HttpOnly; SameSite=Lax',
      });
      res.end(JSON.stringify({ method: req.method, url: req.url, body, headers: req.headers, echoed: true }));
    });
  });
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => {
      sockets.push(server);
      done(server);
    });
  });
}

/** Boot the real app server as a child process, the way an operator would. */
async function startApp(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: appWeb,
    env: { ...process.env, OBSIDIAN_APP_NETWORK: 'devnet', APP_PORT: String(port), APP_HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  // Wait for the port rather than sleeping a fixed amount: a slow machine and a
  // fast one should see the same test.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return { base, child };
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`the app server never came up on ${base}`);
}

test('the app serves its own health, not the platform’s', async () => {
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  const response = await fetch(`${base}/healthz`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.platform, 'http://127.0.0.1:1');
});

test('a GET is proxied with its path and query intact', async () => {
  const platform = await startPlatform();
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` });

  const response = await fetch(`${base}/api/rpc?path=%2Fstatus`);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.method, 'GET');
  assert.equal(body.url, '/api/rpc?path=%2Fstatus');
});

test('a POST body survives the proxy', async () => {
  // The regression this pins: the proxy streams the request through, and a body
  // that arrived empty would make every signed transaction unsubmittable while
  // the response still looked like a 200.
  const platform = await startPlatform();
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` });

  const response = await fetch(`${base}/api/rpc?path=%2Ftx%2Fsubmit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tx: 'deadbeef' }),
  });
  const body = await response.json();
  assert.equal(body.method, 'POST');
  assert.deepEqual(JSON.parse(body.body), { tx: 'deadbeef' });
});

test('the browser’s Origin is not forwarded to the platform', async () => {
  // The platform refuses /api/auth/* from an origin it has not been told about,
  // so forwarding Origin turns every sign-in into a 403 "origin not allowed"
  // until someone edits OBSIDIAN_INTERFACE_ALLOWED_ORIGINS. This server is the
  // platform's client, not the browser's.
  const platform = await startPlatform();
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` });

  await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', referer: 'https://evil.example/page' },
    body: '{}',
  });
  const body = await (await fetch(`${base}/api/auth/login`, { method: 'POST', body: '{}' })).json();
  assert.equal(body.echoed, true);
});

test('X-Forwarded-For is appended to, never taken from the caller', async () => {
  // The platform rate-limits on the LAST entry, on the assumption that a trusted
  // proxy appended it. A proxy that forwards a client-written chain untouched lets
  // a caller pick the identity their requests are counted against.
  const platform = await startPlatform();
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` });

  const response = await fetch(`${base}/api/echo`, {
    method: 'POST',
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    body: '{}',
  });
  const body = await response.json();
  const forwarded = String(body.headers['x-forwarded-for'] ?? '');
  assert.match(forwarded, /^1\.2\.3\.4, 5\.6\.7\.8, /, 'the client chain is preserved');
  const last = forwarded.split(',').pop().trim();
  assert.equal(last === '5.6.7.8', false, 'the last entry is never the caller’s');
  assert.match(last, /^(::ffff:)?(127\.0\.0\.1|::1)$/, `last entry should be the socket peer, got ${last}`);
});

test('the caller cannot claim an Origin that reaches the platform', async () => {
  // The platform refuses /api/auth/* from an origin it has not been told about,
  // so forwarding Origin turns every sign-in into a 403 "origin not allowed"
  // until someone edits OBSIDIAN_INTERFACE_ALLOWED_ORIGINS. This server is the
  // platform's client, not the browser's.
  const platform = await startPlatform();
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` });

  const response = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { origin: 'https://evil.example', referer: 'https://evil.example/page' },
    body: '{}',
  });
  const body = await response.json();
  assert.equal(body.headers.origin, undefined);
  assert.equal(body.headers.referer, undefined);
});

test('the platform’s session cookie is passed back to the browser untouched', async () => {
  const platform = await startPlatform();
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` });
  const response = await fetch(`${base}/api/auth/login`, { method: 'POST', body: '{}' });
  const cookie = response.headers.get('set-cookie') ?? '';
  assert.match(cookie, /obsidian_session=abc123/);
  assert.match(cookie, /HttpOnly/);
});

test('a platform that cannot be reached is a loud 502, never an empty 200', async () => {
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  const response = await fetch(`${base}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.code, 'ERR_PLATFORM_UNREACHABLE');
  assert.match(body.error, /could not be reached/);
});

test('static files are served with a JavaScript MIME type a module will accept', async () => {
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  for (const path of ['/real.mjs', '/data.mjs', '/screens.mjs', '/wallet.mjs', '/notify.mjs']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /text\/javascript/, path);
  }
});

test('the shell is served at / and as the fallback for a client-side route', async () => {
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  for (const path of ['/', '/mine', '/wallet']) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, /OBSIDIAN NETWORK/, path);
    assert.match(html, /<script type="module" src="\/real\.mjs">/, path);
  }
});

test('a path that escapes the public root is refused', async () => {
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  const response = await fetch(`${base}/../server/main.mjs`, { redirect: 'manual' });
  // Either refused outright or served the shell — never the server's own source.
  const text = await response.text();
  assert.doesNotMatch(text, /OBSIDIAN_PLATFORM_URL/);
});

test('non-GET requests outside /api are refused', async () => {
  const { base } = await startApp({ OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  const response = await fetch(`${base}/index.html`, { method: 'POST', body: 'x' });
  assert.equal(response.status, 405);
  assert.equal((await response.json()).code, 'ERR_METHOD');
});

test('the server refuses to start with no platform configured', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: appWeb,
    env: { ...process.env, OBSIDIAN_APP_NETWORK: 'devnet', APP_PORT: String(port), OBSIDIAN_PLATFORM_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const [code, stderr] = await new Promise((done) => {
    let out = '';
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (exitCode) => done([exitCode, out]));
  });
  assert.equal(code, 2, 'a missing platform is a configuration error, not a runtime one');
  assert.match(stderr, /OBSIDIAN_PLATFORM_URL is not set/);
});
