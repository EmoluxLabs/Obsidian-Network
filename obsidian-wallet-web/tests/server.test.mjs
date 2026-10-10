/**
 * The wallet as served: the real launcher, in front of a stand-in platform, over real sockets.
 *
 * What is checked is what a browser or an attacker would meet: which files are served, which API routes exist, and
 * what the Content-Security-Policy allows. The stand-in platform only records what reaches it.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const children = [];
const servers = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of servers) { s.closeAllConnections?.(); s.close(); }
});

const freePort = () => new Promise((done) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => done(port)); }); });

async function stack() {
  const seen = [];
  const platform = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((r) => platform.listen(0, '127.0.0.1', r));
  servers.push(platform);
  const port = await freePort();
  const child = spawn(process.execPath, [resolve(root, 'scripts/start.mjs'), 'devnet'], {
    cwd: root,
    env: { ...process.env, APP_PORT: String(port), APP_HOST: '127.0.0.1', OBSIDIAN_PLATFORM_URL: `http://127.0.0.1:${platform.address().port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${base}/healthz`)).ok) return { base, seen, child }; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the wallet server did not start');
}

test('the wallet is what is served, under a policy with no inline script', async () => {
  const { base } = await stack();
  const page = await fetch(`${base}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /<title>Obsidian Wallet<\/title>/);
  assert.match(html, /src="\/app\.mjs"/);
  const csp = page.headers.get('content-security-policy');
  const script = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'));
  assert.equal(script, "script-src 'self'", `script-src was: ${script}`);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.match(page.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)/i, 'the page itself carries no inline script');

  for (const [path, type] of [['/app.mjs', /javascript/], ['/lib/views.mjs', /javascript/], ['/wallet.css', /css/], ['/logo.png', /png/], ['/js/obsidian.js', /javascript/], ['/js/shared/wallet.mjs', /javascript/]]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get('content-type'), type, path);
  }
  const config = await (await fetch(`${base}/app-config.json`)).json();
  assert.deepEqual([config.network, config.chainId, config.addressHrp], ['devnet', 7780, 'dobs']);
});

test('only the chain gateway is reachable through the wallet; the account API is not', async () => {
  const { base, seen } = await stack();
  const rpc = await fetch(`${base}/api/rpc?path=${encodeURIComponent('/status')}`);
  assert.equal(rpc.status, 200);
  assert.ok(seen.some((u) => u.startsWith('/api/rpc')), 'the read reached the platform');
  const before = seen.length;
  for (const path of ['/api/auth/login', '/api/auth/me', '/api/wallet/link', '/api/mining/certificate', '/api/nodes', '/api/rpcx', '/api/rpc/../auth/me', '/api/']) {
    for (const method of ['GET', 'POST']) {
      const r = await fetch(`${base}${path}`, { method, body: method === 'POST' ? '{}' : undefined, headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 404, `${method} ${path} must not be forwarded (got ${r.status})`);
      const body = await r.json().catch(() => ({}));
      assert.notEqual(body.ok, true, `${method} ${path} must not have been answered by the platform`);
    }
  }
  assert.equal(seen.length, before, 'none of those reached the platform');
});

test('only the wallet is served: not the web app, not files outside public/', async () => {
  const { base } = await stack();
  for (const path of ['/real.mjs', '/screens.mjs', '/explorer.mjs', '/../server/main.mjs', '/%2e%2e/server/main.mjs', '/..%2f..%2fpackage.json', '/js/../../package.json', '/template/obsidian-wallet.html', '/scripts/build.mjs', '/package.json', '/tests/pure.test.mjs']) {
    const r = await fetch(`${base}${path}`);
    const text = await r.text();
    // an unknown path gets the wallet's own shell (a single-page app) or an error; never another file
    assert.ok([400, 403, 404].includes(r.status) || (r.status === 200 && /<title>Obsidian Wallet<\/title>/.test(text) && !/real\.mjs/.test(text)), `${path} answered ${r.status}`);
    assert.ok(!/@obsidian\/wallet-web|createServer|spawnSync/.test(text), `${path} leaked a source file`);
  }
});

test('the launcher refuses to run for a different network than it is told', async () => {
  const child = spawn(process.execPath, [resolve(root, 'scripts/start.mjs'), 'testnet'], {
    cwd: root,
    env: { ...process.env, OBSIDIAN_APP_NETWORK: 'devnet', OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 2);
  assert.match(err, /refusing to start/);
  const text = readFileSync(resolve(root, 'scripts/start.mjs'), 'utf8');
  assert.match(text, /APP_API_ALLOW = '\/api\/rpc'/);
  assert.match(text, /APP_STRICT_SCRIPTS = 'true'/);
});
