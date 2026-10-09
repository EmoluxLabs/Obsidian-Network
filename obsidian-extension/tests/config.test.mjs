import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NETWORKS, parseServerUrl, sanitiseSettings, checkIdentity, getJson, runDiagnostics, ServerError, staleAfterSeconds, loadSettings, saveSettings, SETTINGS_KEY,
} from '../src/config.mjs';
import { NETWORKS as APP_NETWORKS } from '../../obsidian-app-web/server/networks.mjs';

test('the network table equals obsidian-app-web\u2019s (which tests itself against core)', () => {
  for (const [name, n] of Object.entries(APP_NETWORKS)) {
    const { appPort, ...expected } = n;
    assert.deepEqual({ ...NETWORKS[name] }, expected, name);
  }
  assert.equal(Object.keys(NETWORKS).length, Object.keys(APP_NETWORKS).length);
});

test('server address: https anywhere, http only for this machine, never a path or credentials', () => {
  for (const ok of ['https://app.example.org', 'https://app.example.org:8443', 'http://localhost:8790', 'http://127.0.0.1:38790', 'http://[::1]:8790/']) {
    assert.equal(parseServerUrl(ok).ok, true, ok);
  }
  for (const bad of ['', '   ', 'app.example.org', 'http://app.example.org', 'http://192.168.1.5:8790', 'http://10.0.0.1', 'ftp://x.org', 'javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd',
    'https://u:p@x.org', 'https://x.org/a', 'https://x.org/?a=1', 'https://x.org/#f', 'chrome-extension://abc/', null, undefined]) {
    assert.equal(parseServerUrl(bad).ok, false, String(bad));
  }
  const parsed = parseServerUrl('http://127.0.0.1:38790');
  assert.equal(parsed.origin, 'http://127.0.0.1:38790');
  assert.equal(parsed.pattern, 'http://127.0.0.1/*', 'permission patterns carry no port');
  assert.equal(parseServerUrl('https://App.Example.org/').origin, 'https://app.example.org');
});

test('stored settings are sanitised, never trusted', () => {
  assert.deepEqual(sanitiseSettings(null), { serverUrl: null, network: null, alerts: false, address: null });
  assert.deepEqual(sanitiseSettings({ serverUrl: 'javascript:1', network: 'nope', alerts: 'yes', address: '<script>' }), { serverUrl: null, network: null, alerts: false, address: null });
  const good = sanitiseSettings({ serverUrl: 'https://a.example.org/', network: 'devnet', alerts: true, address: 'dobs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk', extra: 'x' });
  assert.deepEqual(good, { serverUrl: 'https://a.example.org', network: 'devnet', alerts: true, address: 'dobs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk' });
});

test('settings round-trip through storage', async () => {
  const data = {};
  const storage = { get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (v) => Object.assign(data, v) };
  assert.equal((await loadSettings(storage)).serverUrl, null);
  await saveSettings(storage, { serverUrl: 'https://a.example.org', network: 'testnet' });
  await saveSettings(storage, { alerts: true });
  assert.deepEqual(await loadSettings(storage), { serverUrl: 'https://a.example.org', network: 'testnet', alerts: true, address: null });
  assert.ok(SETTINGS_KEY in data);
});

const respond = (status, body, { raw } = {}) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => raw ?? JSON.stringify(body) });

test('getJson: every failure has a kind the UI can act on', async () => {
  const cases = [
    [respond(200, { a: 1 }), null],
    [async () => { throw new TypeError('Failed to fetch'); }, 'unreachable'],
    [async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'timeout'],
    [respond(200, null, { raw: '<html>not json</html>' }), 'malformed'],
    [respond(200, null, { raw: '"just a string"' }), 'malformed'],
    [respond(404, { error: 'x' }), 'unsupported'],
    [respond(405, { error: 'x' }), 'unsupported'],
    [respond(500, { error: { code: 'ERR_X' } }), 'server'],
    [respond(403, { code: 'ERR_FORBIDDEN' }), 'rejected'],
  ];
  for (const [fetchImpl, kind] of cases) {
    if (kind === null) { assert.deepEqual(await getJson('https://x.org', '/a', { fetchImpl }), { a: 1 }); continue; }
    await assert.rejects(getJson('https://x.org', '/a', { fetchImpl }), (e) => e instanceof ServerError && e.kind === kind, kind);
  }
});

test('getJson sends no cookies and refuses redirects', async () => {
  let init;
  await getJson('https://x.org', '/a', { fetchImpl: async (u, i) => { init = i; return { ok: true, status: 200, text: async () => '{}' }; } });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.equal(init.method, 'GET');
});

const config = (over = {}) => ({ network: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', production: false, verified: true, verification: 'ok', ...over });

test('identity: right network passes; every other case is refused with its own kind', () => {
  assert.equal(checkIdentity(config(), 'devnet').ok, true);
  assert.equal(checkIdentity(config(), 'mainnet').kind, 'wrong-network');
  assert.equal(checkIdentity(config({ verified: false, verification: 'mismatch' }), 'devnet').kind, 'unverified');
  assert.equal(checkIdentity(config({ chainId: 1 }), 'devnet').kind, 'unsupported');
  assert.equal(checkIdentity(config({ addressHrp: 'obs' }), 'devnet').kind, 'unsupported', 'a server may not redefine a network');
  assert.equal(checkIdentity(config({ network: 'madeup' }), 'devnet').kind, 'unsupported');
  assert.equal(checkIdentity({}, 'devnet').kind, 'malformed');
  assert.equal(checkIdentity(null, 'devnet').kind, 'malformed');
  assert.equal(checkIdentity(config(), null).kind, 'not-configured');
});

test('staleness threshold follows the block time with a floor', () => {
  assert.equal(staleAfterSeconds(5), 60);
  assert.equal(staleAfterSeconds(10), 120);
  assert.equal(staleAfterSeconds(undefined), 60);
});

function fakeServer(over = {}) {
  const now = 1_800_000_000;
  const routes = {
    '/app-config.json': config(),
    '/api/auth/config': { network: 'devnet', inviteOnly: true },
    '/api/rpc?path=%2Fstatus': { height: 10, genesisId: 'g'.repeat(40), chainId: 7780, networkId: 'obsidian-devnet-1', peers: 1, syncing: false, lastBlockTimestamp: now - 3 },
    '/api/rpc?path=%2Fnetwork': { genesisId: 'g'.repeat(40), protocolVersion: '1.6.1' },
    ...over,
  };
  const fetchImpl = async (url) => {
    const path = url.replace('https://x.org', '');
    const value = routes[path];
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return { fetchImpl, now: () => now * 1000 };
}
const byId = (steps) => Object.fromEntries(steps.map((s) => [s.id, s.status]));

test('diagnostics: healthy', async () => {
  const steps = await runDiagnostics('https://x.org', 'devnet', fakeServer());
  assert.deepEqual(byId(steps), { identity: 'ok', platform: 'ok', node: 'ok', consistency: 'ok' });
});

test('diagnostics: server unreachable skips the rest and says so', async () => {
  const steps = await runDiagnostics('https://x.org', 'devnet', fakeServer({ '/app-config.json': new TypeError('x') }));
  assert.deepEqual(byId(steps), { identity: 'fail', platform: 'skipped', node: 'skipped', consistency: 'skipped' });
});

test('diagnostics: wrong network stops at identity', async () => {
  const steps = await runDiagnostics('https://x.org', 'mainnet', fakeServer());
  assert.equal(byId(steps).identity, 'fail');
  assert.match(steps[0].detail, /wrong-network/);
  assert.equal(byId(steps).node, 'skipped');
});

test('diagnostics: stale node, syncing node, node on another chain, malformed status, platform disagreeing', async () => {
  const now = 1_800_000_000;
  const path = '/api/rpc?path=%2Fstatus';
  const base = { height: 10, genesisId: 'g'.repeat(40), chainId: 7780, networkId: 'obsidian-devnet-1', peers: 0, syncing: false, lastBlockTimestamp: now - 3 };
  assert.equal(byId(await runDiagnostics('https://x.org', 'devnet', fakeServer({ [path]: { ...base, lastBlockTimestamp: now - 600 } }))).node, 'warn');
  assert.equal(byId(await runDiagnostics('https://x.org', 'devnet', fakeServer({ [path]: { ...base, syncing: true } }))).node, 'warn');
  assert.equal(byId(await runDiagnostics('https://x.org', 'devnet', fakeServer({ [path]: { ...base, chainId: 7777 } }))).node, 'fail');
  assert.equal(byId(await runDiagnostics('https://x.org', 'devnet', fakeServer({ [path]: { hello: 'world' } }))).node, 'fail');
  assert.equal(byId(await runDiagnostics('https://x.org', 'devnet', fakeServer({ '/api/auth/config': { network: 'mainnet' } }))).platform, 'fail');
  const mismatch = await runDiagnostics('https://x.org', 'devnet', fakeServer({ '/api/rpc?path=%2Fnetwork': { genesisId: 'z'.repeat(40) } }));
  assert.equal(byId(mismatch).consistency, 'fail');
});
