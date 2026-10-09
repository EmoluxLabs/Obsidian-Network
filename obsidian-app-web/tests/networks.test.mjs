/**
 * Mainnet, testnet, staging and devnet are four deployments of this app, and they
 * must be four different things — in what they are told, in what they refuse, and in
 * what a user sees.
 *
 * The table is pinned to the two places that already own these facts. If the node or
 * the platform changes a chain id or an address prefix, this fails, instead of an app
 * quietly signing for a chain that no longer exists.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NETWORKS, NETWORK_NAMES, networkFor, compareNetwork, verifyPlatform, publicConfig } from '../server/networks.mjs';

const appWeb = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = resolve(appWeb, 'server/main.mjs');
const root = resolve(appWeb, '..');

const children = [];
const sockets = [];
after(() => {
  for (const child of children) child.kill('SIGKILL');
  for (const socket of sockets) socket.close();
});

// ── the table ────────────────────────────────────────────────────────────────

test('the table equals obsidian-core’s own network definitions', async () => {
  const core = await import(resolve(root, 'obsidian-core/dist/protocol/networks.js'));
  assert.deepEqual([...NETWORK_NAMES].sort(), Object.keys(core.NETWORKS).sort());
  for (const name of NETWORK_NAMES) {
    const mine = NETWORKS[name];
    const theirs = core.NETWORKS[name];
    assert.equal(mine.chainId, theirs.chainId, `${name} chain id`);
    assert.equal(mine.addressHrp, theirs.addressHrp, `${name} address prefix`);
    assert.equal(mine.networkId, theirs.networkId, `${name} network id`);
    assert.equal(mine.production, theirs.isProduction, `${name} production flag`);
  }
});

test('the table equals the platform’s, so an app and its platform agree on what they are', async (t) => {
  const file = resolve(root, 'obsidian-interface/dist/server/networks.js');
  if (!existsSync(file)) return t.skip('obsidian-interface is not built');
  const { INTERFACE_NETWORKS } = await import(file);
  for (const name of NETWORK_NAMES) {
    assert.equal(NETWORKS[name].chainId, INTERFACE_NETWORKS[name].chainId, `${name} chain id`);
    assert.equal(NETWORKS[name].addressHrp, INTERFACE_NETWORKS[name].addressHrp, `${name} prefix`);
    assert.equal(NETWORKS[name].networkId, INTERFACE_NETWORKS[name].networkId, `${name} id`);
  }
});

test('the four apps have four different identities and four different ports', async () => {
  const ids = new Set(NETWORK_NAMES.map((n) => NETWORKS[n].chainId));
  const prefixes = new Set(NETWORK_NAMES.map((n) => NETWORKS[n].addressHrp));
  const ports = new Set(NETWORK_NAMES.map((n) => NETWORKS[n].appPort));
  assert.equal(ids.size, 4);
  assert.equal(prefixes.size, 4);
  assert.equal(ports.size, 4);
  assert.deepEqual(NETWORK_NAMES.filter((n) => NETWORKS[n].production), ['mainnet'], 'only mainnet is production');

  // An app port must not be a node or interface port of any network, or two things
  // on one host could not both start.
  const core = await import(resolve(root, 'obsidian-core/dist/protocol/networks.js'));
  const taken = new Set();
  for (const name of NETWORK_NAMES) {
    taken.add(core.NETWORKS[name].defaultRpcPort);
    taken.add(core.NETWORKS[name].defaultP2pPort);
    taken.add(core.NETWORKS[name].defaultRpcPort + 158); // 8630 -> 8788 interface scheme
  }
  for (const name of NETWORK_NAMES) assert.ok(!taken.has(NETWORKS[name].appPort), `${name} app port collides`);
});

test('a network name that is not one of the four is an error, never a default', () => {
  for (const bad of [undefined, '', 'prod', 'main', 'localnet', 'mainnet ']) {
    assert.throws(() => networkFor(bad), /unknown network/, JSON.stringify(bad));
  }
  assert.equal(networkFor('Testnet').name, 'testnet', 'case alone is forgiven');
});

// ── the comparison ───────────────────────────────────────────────────────────

const DEV = NETWORKS.devnet;
const devNode = { name: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs' };

test('matching reports are ok, and say how much was checked', () => {
  const result = compareNetwork(DEV, { authNetwork: 'devnet', node: devNode });
  assert.equal(result.state, 'ok');
  assert.match(result.detail, /5 fields/);
});

test('any single wrong field is a mismatch that names it', () => {
  for (const [field, patch, text] of [
    ['authNetwork', { authNetwork: 'testnet', node: devNode }, /platform network is testnet/],
    ['chain id', { node: { ...devNode, chainId: 7777 } }, /chain id is 7777, expected 7780/],
    ['prefix', { node: { ...devNode, addressHrp: 'obs' } }, /prefix is obs, expected dobs/],
    ['network id', { node: { ...devNode, networkId: 'obsidian-mainnet-1' } }, /network id is obsidian-mainnet-1/],
  ]) {
    const result = compareNetwork(DEV, patch);
    assert.equal(result.state, 'mismatch', field);
    assert.match(result.detail, text, field);
  }
});

test('a platform that reports nothing is unverified — never ok', () => {
  assert.equal(compareNetwork(DEV, {}).state, 'unverified');
  assert.equal(compareNetwork(DEV, { node: {} }).state, 'unverified');
});

test('verifyPlatform: ok, mismatch, and unreachable are three different answers', async () => {
  const platformOn = (network) => async (url) => {
    const target = String(url);
    if (target.includes('/api/auth/config')) return Response.json({ network: network.name });
    if (target.includes('path=%2Fnetwork')) return Response.json({ network });
    throw new Error('unexpected ' + target);
  };
  assert.equal((await verifyPlatform('http://p', DEV, platformOn(devNode))).state, 'ok');
  assert.equal(
    (await verifyPlatform('http://p', DEV, platformOn({ name: 'mainnet', networkId: 'obsidian-mainnet-1', chainId: 7777, addressHrp: 'obs' }))).state,
    'mismatch',
  );
  const down = async () => {
    throw new Error('ECONNREFUSED');
  };
  const result = await verifyPlatform('http://p', DEV, down);
  assert.equal(result.state, 'unreachable');
  assert.match(result.detail, /ECONNREFUSED/);
});

test('the browser is told the app’s identity, from the table and not from the platform', () => {
  const config = publicConfig(NETWORKS.testnet, { state: 'ok' });
  assert.deepEqual(config, {
    network: 'testnet',
    networkId: 'obsidian-testnet-1',
    chainId: 7778,
    addressHrp: 'tobs',
    production: false,
    verified: true,
    verification: 'ok',
  });
  assert.equal(publicConfig(NETWORKS.mainnet, { state: 'unreachable' }).verified, false);
  assert.equal(publicConfig(NETWORKS.mainnet, { state: 'ok' }).production, true);
});

// ── the real server, as an operator runs it ──────────────────────────────────

/** A fake platform that follows `network`, and can be told to switch. */
function fakePlatform(network) {
  const state = { network };
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      res.setHeader('Content-Type', 'application/json');
      if (url.pathname === '/api/auth/config') return res.end(JSON.stringify({ network: state.network.name }));
      if (url.pathname === '/api/rpc') return res.end(JSON.stringify({ network: state.network }));
      res.statusCode = 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () => {
      sockets.push(server);
      done({ url: `http://127.0.0.1:${server.address().port}`, state });
    });
  });
}

const nodeFor = (name) => {
  const n = NETWORKS[name];
  return { name: n.name, networkId: n.networkId, chainId: n.chainId, addressHrp: n.addressHrp };
};

function freePort() {
  return new Promise((done) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => done(port));
    });
  });
}

function run(env) {
  return freePort().then((port) => {
    const child = spawn(process.execPath, [SERVER], {
      cwd: appWeb,
      env: { ...process.env, APP_PORT: String(port), APP_HOST: '127.0.0.1', APP_NETWORK_RECHECK_MS: '100', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const exited = new Promise((done) => child.on('exit', (code) => done(code)));
    return { child, port, base: `http://127.0.0.1:${port}`, exited, stderr: () => stderr };
  });
}

async function up(base) {
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).status) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('never came up');
}

test('with no network declared the server refuses to start (exit 2)', async () => {
  const platform = await fakePlatform(nodeFor('devnet'));
  const app = await run({ OBSIDIAN_APP_NETWORK: '', OBSIDIAN_PLATFORM_URL: platform.url });
  assert.equal(await app.exited, 2);
  assert.match(app.stderr(), /OBSIDIAN_APP_NETWORK is not usable/);
});

test('an app refuses to start in front of a platform on another network (exit 3)', async () => {
  const platform = await fakePlatform(nodeFor('devnet'));
  for (const declared of ['mainnet', 'testnet', 'staging']) {
    const app = await run({ OBSIDIAN_APP_NETWORK: declared, OBSIDIAN_PLATFORM_URL: platform.url });
    assert.equal(await app.exited, 3, `${declared} app in front of a devnet platform`);
    assert.match(app.stderr(), new RegExp(`this is the ${declared} app`));
  }
});

test('each of the four apps starts against its own platform and says which it is', async () => {
  const seen = [];
  for (const name of NETWORK_NAMES) {
    const platform = await fakePlatform(nodeFor(name));
    const app = await run({ OBSIDIAN_APP_NETWORK: name, OBSIDIAN_PLATFORM_URL: platform.url });
    await up(app.base);
    const response = await fetch(`${app.base}/app-config.json`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.equal(config.network, name);
    assert.equal(config.chainId, NETWORKS[name].chainId);
    assert.equal(config.addressHrp, NETWORKS[name].addressHrp);
    assert.equal(config.verified, true);
    const health = await (await fetch(`${app.base}/healthz`)).json();
    assert.equal(health.network, name);
    assert.equal(health.verification, 'ok');
    seen.push(JSON.stringify(config));
  }
  assert.equal(new Set(seen).size, 4, 'four deployments, four different identities');
});

test('a platform that switches network while running closes the API, and reopens when fixed', async () => {
  const platform = await fakePlatform(nodeFor('testnet'));
  const app = await run({ OBSIDIAN_APP_NETWORK: 'testnet', OBSIDIAN_PLATFORM_URL: platform.url });
  await up(app.base);
  assert.equal((await fetch(`${app.base}/api/auth/config`)).status, 200);

  platform.state.network = nodeFor('mainnet'); // someone repoints the platform
  let blocked = null;
  for (let i = 0; i < 60 && !blocked; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    const response = await fetch(`${app.base}/api/rpc?path=%2Fstatus`);
    if (response.status === 503) blocked = await response.json();
  }
  assert.ok(blocked, 'the API must close');
  assert.equal(blocked.code, 'ERR_NETWORK_MISMATCH');
  assert.match(blocked.error, /testnet app/);
  assert.equal((await fetch(`${app.base}/healthz`)).status, 503);
  assert.equal((await (await fetch(`${app.base}/app-config.json`)).json()).verified, false);

  platform.state.network = nodeFor('testnet');
  let reopened = false;
  for (let i = 0; i < 60 && !reopened; i += 1) {
    await new Promise((r) => setTimeout(r, 50));
    reopened = (await fetch(`${app.base}/api/auth/config`)).status === 200;
  }
  assert.ok(reopened, 'the API must reopen once the platform is back on the right network');
});

test('an unreachable platform is an outage, not a mismatch: the app still starts', async () => {
  const app = await run({ OBSIDIAN_APP_NETWORK: 'staging', OBSIDIAN_PLATFORM_URL: 'http://127.0.0.1:1' });
  await up(app.base);
  const health = await (await fetch(`${app.base}/healthz`)).json();
  assert.equal(health.verification, 'unreachable');
  assert.equal(health.ok, true);
  assert.match(app.stderr(), /WARNING/);
  const config = await (await fetch(`${app.base}/app-config.json`)).json();
  assert.equal(config.verified, false, 'and it does not claim to have verified anything');
});


// ── the per-network start scripts ────────────────────────────────────────────

import { spawnSync } from 'node:child_process';
import { fileURLToPath as toPath } from 'node:url';
import { resolve as resolvePath, dirname as dirOf } from 'node:path';

const START = resolvePath(dirOf(toPath(import.meta.url)), '../scripts/start.mjs');
const clean = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const k of ['OBSIDIAN_APP_NETWORK', 'OBSIDIAN_PLATFORM_URL']) if (!(k in extra)) delete env[k];
  return env;
};

test('start.mjs: an unknown or missing network is a usage error (exit 2)', () => {
  assert.equal(spawnSync('node', [START, 'moonnet'], { env: clean() }).status, 2);
  assert.equal(spawnSync('node', [START], { env: clean() }).status, 2);
});

test('start.mjs: mainnet will not assume a platform', () => {
  const run = spawnSync('node', [START, 'mainnet'], { env: clean(), encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /without OBSIDIAN_PLATFORM_URL/);
});

test('start.mjs: a start script cannot be pointed at another network by the environment', () => {
  const run = spawnSync('node', [START, 'testnet'], { env: clean({ OBSIDIAN_APP_NETWORK: 'mainnet' }), encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /testnet entry point but OBSIDIAN_APP_NETWORK is mainnet/);
});

test('package.json has one start script per network, each the matching entry point', async () => {
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(resolvePath(dirOf(START), '../package.json'), 'utf8'));
  for (const name of NETWORK_NAMES) {
    assert.equal(pkg.scripts[`start:${name}`], `node scripts/start.mjs ${name}`);
  }
});
