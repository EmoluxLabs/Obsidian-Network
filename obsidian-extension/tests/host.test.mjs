import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHost } from '../src/host.mjs';

const ADDRESS = 'dobs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk';
function make(settings, { level = 'granted', getLevel = true } = {}) {
  const data = {};
  const api = {
    storage: { local: { get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (v) => Object.assign(data, v) } },
    notifications: getLevel ? { getPermissionLevel: (cb) => cb(level) } : {},
  };
  const base = { serverUrl: 'https://x.org', network: 'devnet', alerts: false, address: null, ...settings };
  return { host: createHost(api, base), data, settings: base };
}

test('apiBase is the configured server; unconfigured throws and so nothing can be sent', () => {
  assert.equal(make({}).host.apiBase(), 'https://x.org');
  assert.throws(() => make({ serverUrl: null }).host.apiBase(), (e) => e.kind === 'not-configured');
});

test('the address is mirrored only while alerts are on, only if it belongs to the network', async () => {
  const off = make({});
  off.host.walletAddress(ADDRESS);
  assert.equal(off.settings.address, null);
  assert.deepEqual(off.data, {});

  const on = make({});
  assert.equal(await on.host.notify.enable(ADDRESS), 'granted');
  assert.equal(on.settings.address, ADDRESS);
  assert.equal(on.host.notify.permission(), 'granted');
  on.host.walletAddress('obs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk');
  assert.equal(on.settings.address, null, 'an address from another network is dropped');
  on.host.walletAddress(null);
  assert.equal(on.settings.address, null);
});

test('enable refuses without a usable address and when the OS blocks notifications', async () => {
  assert.equal(await make({}).host.notify.enable(null), 'unsupported');
  assert.equal(await make({}).host.notify.enable('obs1wrongnetwork'), 'unsupported');
  const blocked = make({}, { level: 'denied' });
  assert.equal(await blocked.host.notify.enable(ADDRESS), 'denied');
  assert.equal(blocked.settings.alerts, false);
  assert.equal(blocked.host.notify.permission(), 'denied');
});

test('Firefox has no permission-level query: enabling still works', async () => {
  const ff = make({}, { getLevel: false });
  assert.equal(await ff.host.notify.enable(ADDRESS), 'granted');
});

test('disable turns alerts off and forgets the address', async () => {
  const m = make({});
  await m.host.notify.enable(ADDRESS);
  m.host.notify.disable();
  assert.equal(m.settings.alerts, false);
  assert.equal(m.settings.address, null);
  assert.equal(m.host.notify.permission(), 'default');
});

test('the Menu rows the host offers are all handlers or screens that exist', () => {
  const { host } = make({});
  for (const item of host.menu) assert.ok(/^[a-z]{2,20}$/.test(item.go ?? '') || /^Obsidian[A-Za-z]+$/.test(item.call), item.label);
});
