/**
 * What a hostile caller can and cannot do to the app server itself.
 *
 * Every test here is something that was true of a real, running server: a malformed URL used to throw out of an
 * async handler and end the process, and the proxy dropped Origin so the platform's own cross-origin check never saw
 * the caller. These run against a real child process and real sockets.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originAllowed, parseAllowedOrigins } from '../server/origin.mjs';

const appWeb = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const servers = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of servers) s.close();
});

const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

async function stack(env = {}, platformHandler) {
  const platform = createServer(platformHandler ?? ((req, res) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'x-frame-options': 'SAMEORIGIN' }); res.end('{"ok":true}'); }));
  await new Promise((r) => platform.listen(0, '127.0.0.1', r));
  servers.push(platform);
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(appWeb, 'server/main.mjs')], {
    cwd: appWeb,
    env: { ...process.env, OBSIDIAN_APP_NETWORK: 'devnet', APP_PORT: String(port), APP_HOST: '127.0.0.1', OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, port, child }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('app server did not start');
}

const raw = (port, text) => new Promise((done) => {
  const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
  let data = '';
  socket.on('data', (d) => { data += d; });
  socket.on('close', () => done(data));
  socket.setTimeout(2000, () => socket.destroy());
});

test('origin policy: same origin, extensions and the operator list pass; everything else is refused', () => {
  const host = 'app.example';
  assert.equal(originAllowed({ host, origin: 'https://app.example' }), true);
  assert.equal(originAllowed({ host, origin: 'https://APP.example' }), true);
  assert.equal(originAllowed({ host, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }), true);
  assert.equal(originAllowed({ host, origin: 'moz-extension://5f1a3c2e-1b2c-4d5e-8f90-123456789abc' }), true);
  assert.equal(originAllowed({ host, origin: 'https://evil.example' }), false);
  assert.equal(originAllowed({ host, origin: 'https://app.example.evil.test' }), false);
  assert.equal(originAllowed({ host, origin: 'https://app.example@evil.test' }), false);
  assert.equal(originAllowed({ host, origin: 'null' }), false, 'sandboxed frames and data: pages send Origin: null');
  assert.equal(originAllowed({ host, origin: 'file://' }), false);
  assert.equal(originAllowed({ host, origin: 'chrome-extension://evil/../x' }), false);
  assert.equal(originAllowed({ host, origin: 'https://app.example/path' }), false);
  assert.equal(originAllowed({ host }), true, 'no Origin and no browser hint: curl, a server, a native app');
  assert.equal(originAllowed({ host, 'sec-fetch-site': 'cross-site' }), false, 'a browser request that hides Origin');
  assert.equal(originAllowed({ host, 'sec-fetch-site': 'same-site' }), false);
  assert.equal(originAllowed({ origin: 'https://app.example' }), false, 'no Host to compare with');
  const listed = parseAllowedOrigins('https://wallet.example.org, http://localhost:3000/');
  assert.equal(originAllowed({ host, origin: 'https://wallet.example.org' }, listed), true);
  assert.equal(originAllowed({ host, origin: 'http://localhost:3000' }, listed), true);
  assert.equal(originAllowed({ host, origin: 'https://x.wallet.example.org' }, listed), false);
  for (const bad of ['*', 'https://*.example.org', 'https://a.example/path', 'ftp://a.example', 'nonsense', 'https://u:p@a.example']) {
    assert.throws(() => parseAllowedOrigins(bad), /APP_ALLOWED_ORIGINS/, bad);
  }
});

test('a malformed URL or Host header answers an error and the server stays up', async () => {
  const { base, port, child } = await stack();
  for (const path of ['/%', '/%E0%A4%A', '/%zz', '/..%2f..%2fetc%2fpasswd', '/%00', '/a/%c0%af..%c0%af', '/' + '%41'.repeat(5000)]) {
    const text = await raw(port, `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    assert.match(text, /^HTTP\/1\.1 (200|400|404)/, path.slice(0, 40));
    assert.ok(!/root:|nologin/.test(text), 'no file outside public/');
  }
  await raw(port, 'GET / HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n');
  await raw(port, 'GET http://[::1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
  await raw(port, 'GARBAGE\r\n\r\n');
  assert.equal(child.exitCode, null, 'the process is still running');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('every response carries the framing, sniffing and CSP headers, including the proxied ones', async () => {
  const { base } = await stack();
  for (const path of ['/', '/real.mjs', '/healthz', '/app-config.json', '/nope/deep/link', '/api/status']) {
    const r = await fetch(`${base}${path}`);
    assert.match(r.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, path);
    assert.match(r.headers.get('content-security-policy') ?? '', /object-src 'none'/, path);
    assert.match(r.headers.get('content-security-policy') ?? '', /base-uri 'none'/, path);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
  }
  const proxied = await fetch(`${base}/api/status`);
  assert.equal(proxied.headers.get('x-frame-options'), 'DENY', 'the platform cannot loosen it');
});

test('the proxy refuses a state-changing request from a foreign origin, before it reaches the platform', async () => {
  let reached = 0;
  const { base } = await stack({}, (req, res) => { if (req.url.startsWith('/api/')) reached += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const booted = reached; // the app server asks the platform who it is, at boot and every 30 s
  const hostile = [
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { 'sec-fetch-site': 'cross-site' },
    { origin: 'https://127.0.0.1.evil.test' },
  ];
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const headers of hostile) {
      const r = await fetch(`${base}/api/auth/logout`, { method, headers, body: '{}' });
      assert.equal(r.status, 403, `${method} ${JSON.stringify(headers)}`);
      assert.equal((await r.json()).code, 'ERR_ORIGIN_NOT_ALLOWED');
    }
  }
  assert.equal(reached, booted, 'not one of them was forwarded');

  const same = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: base }, body: '{}' });
  assert.equal(same.status, 200);
  const ext = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }, body: '{}' });
  assert.equal(ext.status, 200);
  const native = await fetch(`${base}/api/auth/logout`, { method: 'POST', body: '{}' });
  assert.equal(native.status, 200);
  assert.equal(reached, booted + 3);
});

test('the operator can list one more origin, and only exactly that one', async () => {
  const { base } = await stack({ APP_ALLOWED_ORIGINS: 'https://wallet.example.org' });
  assert.equal((await fetch(`${base}/api/x`, { method: 'POST', headers: { origin: 'https://wallet.example.org' }, body: '{}' })).status, 200);
  assert.equal((await fetch(`${base}/api/x`, { method: 'POST', headers: { origin: 'https://wallet.example.org.evil.test' }, body: '{}' })).status, 403);
});

test('an oversized request body is refused before it is streamed to the platform', async () => {
  let reached = 0;
  const { base } = await stack({}, (req, res) => { if (req.url.startsWith('/api/')) reached += 1; req.resume(); res.end('{}'); });
  const booted = reached;
  const r = await fetch(`${base}/api/x`, { method: 'POST', body: 'x'.repeat(1_200_000) });
  assert.equal(r.status, 413);
  assert.equal(reached, booted);
});

test('a platform that dies halfway through an answer does not take the app server down', async () => {
  const { base, child } = await stack({}, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"partial":');
    setTimeout(() => res.socket.destroy(), 30);
  });
  await fetch(`${base}/api/x`).then((r) => r.text()).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test('a path that tries to leave public/ is never served', async () => {
  const { base, port } = await stack();
  for (const path of ['/../server/main.mjs', '/%2e%2e/server/main.mjs', '/..%2fserver%2fmain.mjs', '/%2e%2e%2f%2e%2e%2fpackage.json', '/js/../../package.json']) {
    const text = await raw(port, `GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    assert.ok(!/createServer|"name": "obsidian-app-web"|OBSIDIAN_PLATFORM_URL/.test(text), `${path} leaked a source file`);
  }
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test('X-Forwarded-For: by default the socket is the client; behind a trusted proxy the proxy\u2019s last entry is', async () => {
  const seen = [];
  const handler = (req, res) => { if (req.url.startsWith('/api/echo')) seen.push(req.headers['x-forwarded-for']); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); };
  const direct = await stack({}, handler);
  await fetch(`${direct.base}/api/echo`, { headers: { 'x-forwarded-for': '1.2.3.4, 9.9.9.9' } });
  assert.match(seen.at(-1), /^1\.2\.3\.4, 9\.9\.9\.9, (127\.0\.0\.1|::1)$/, 'untrusted: what the caller wrote is kept, the real peer is last');
  const behind = await stack({ APP_TRUST_PROXY: 'true' }, handler);
  await fetch(`${behind.base}/api/echo`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  assert.equal(seen.at(-1), '203.0.113.7', 'trusted: the visitor the proxy saw stays last');
  await fetch(`${behind.base}/api/echo`, { headers: { 'x-forwarded-for': 'not an ip' } });
  assert.match(seen.at(-1), /^not an ip, (127\.0\.0\.1|::1)$/, 'a garbage last entry falls back to the socket');
  await fetch(`${behind.base}/api/echo`);
  assert.match(seen.at(-1), /^(127\.0\.0\.1|::1)$/, 'no header at all: the socket');
});

test('the web app keeps its policy and its whole API; a product that sets APP_API_ALLOW / APP_STRICT_SCRIPTS gets less', async () => {
  const seen = [];
  const handler = (req, res) => { seen.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); };

  // defaults: unchanged. The design's inline handlers need 'unsafe-inline', and every /api route is forwarded.
  const full = await stack({}, handler);
  const shell = await fetch(`${full.base}/`);
  assert.match(shell.headers.get('content-security-policy'), /script-src 'self' 'unsafe-inline'/);
  assert.equal((await fetch(`${full.base}/api/auth/config`)).status, 200);

  // restricted: only the listed routes, and no inline script allowed
  const wallet = await stack({ APP_API_ALLOW: '/api/rpc,/api/nodes/*', APP_STRICT_SCRIPTS: 'true' }, handler);
  seen.length = 0; // the server's own start-up check of the platform's network is not a request from a browser
  const csp = (await fetch(`${wallet.base}/`)).headers.get('content-security-policy');
  assert.match(csp, /script-src 'self';/);
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*;[^;]*connect/, 'only style-src keeps unsafe-inline');
  assert.equal((await fetch(`${wallet.base}/api/rpc?path=%2Fstatus`)).status, 200);
  assert.equal((await fetch(`${wallet.base}/api/nodes/registry`)).status, 200);
  const refused = await fetch(`${wallet.base}/api/auth/login`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  assert.equal(refused.status, 404);
  assert.equal((await refused.json()).code, 'ERR_NOT_EXPOSED');
  assert.equal((await fetch(`${wallet.base}/api/rpcx`)).status, 404, 'an exact entry is exact, not a prefix');
  assert.deepEqual(seen, ['/api/rpc?path=%2Fstatus', '/api/nodes/registry']);

  // a malformed entry stops the server rather than silently allowing everything
  const bad = spawn(process.execPath, [resolve(appWeb, 'server/main.mjs')], {
    cwd: appWeb,
    env: { ...process.env, OBSIDIAN_APP_NETWORK: 'devnet', OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:9', APP_API_ALLOW: '*' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  bad.stderr.on('data', (d) => (err += d));
  assert.equal(await new Promise((r) => bad.on('exit', r)), 2);
  assert.match(err, /APP_API_ALLOW/);
});
