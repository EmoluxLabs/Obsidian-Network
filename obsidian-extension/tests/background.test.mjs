import { test } from 'node:test';
import assert from 'node:assert/strict';

// A fake browser, installed before the service worker module is loaded so its top-level listeners register on it.
const listeners = { installed: [], startup: [], changed: [], alarm: [], message: [] };
const store = {};
const alarms = {};
const notifications = [];
let badge = '';
globalThis.chrome = {
  runtime: {
    id: 'ext-id',
    getURL: (p) => `chrome-extension://ext-id/${p}`,
    onInstalled: { addListener: (f) => listeners.installed.push(f) },
    onStartup: { addListener: (f) => listeners.startup.push(f) },
    onMessage: { addListener: (f) => listeners.message.push(f) },
  },
  storage: {
    local: {
      get: async (k) => (k in store ? { [k]: store[k] } : {}),
      set: async (v) => Object.assign(store, v),
    },
    onChanged: { addListener: (f) => listeners.changed.push(f) },
  },
  alarms: {
    get: async (n) => alarms[n],
    create: (n, info) => { alarms[n] = info; },
    clear: async (n) => { delete alarms[n]; return true; },
    onAlarm: { addListener: (f) => listeners.alarm.push(f) },
  },
  notifications: { create: (id, o) => notifications.push({ id, ...o }) },
  action: { setBadgeText: async ({ text }) => { badge = text; }, setBadgeBackgroundColor: async () => {} },
};

const ADDRESS = 'dobs1m6927qpu49ke2gz6jqerl42c8a86k73pqfzhsk';
let eligible = true;
let seq = 1;
globalThis.fetch = async (url) => {
  const body = String(url).endsWith('/app-config.json')
    ? { network: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', verified: true }
    : { address: ADDRESS, eligible, nextClaimSequence: seq, cycleStartAt: 1, nextEligibleAt: 9 };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
};

await import('../src/background.js');
const settingsKey = 'obsidian.settings';
const on = { serverUrl: 'https://x.org', network: 'devnet', alerts: true, address: ADDRESS };

test('every listener is registered synchronously at load (a suspended worker is woken by them)', () => {
  for (const [name, list] of Object.entries(listeners)) assert.equal(list.length, 1, name);
});

test('alerts on: an alarm is created; off: it is removed and the badge cleared', async () => {
  store[settingsKey] = on;
  await listeners.installed[0]();
  assert.equal(alarms['obsidian-claim-watch'].periodInMinutes, 1);
  store[settingsKey] = { ...on, alerts: false };
  badge = '1';
  await listeners.installed[0]();
  assert.equal(alarms['obsidian-claim-watch'], undefined);
  assert.equal(badge, '');
});

test('the alarm asks the node and notifies once per opportunity, from storage alone (no in-memory state)', async () => {
  store[settingsKey] = on;
  await listeners.installed[0]();
  const fire = () => listeners.alarm[0]({ name: 'obsidian-claim-watch' });
  await fire();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /open/i);
  assert.equal(badge, '1');
  await fire();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifications.length, 1, 'not repeated');
  seq = 2;
  await fire();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifications.length, 2, 'a new window alerts again');
  eligible = false;
  await fire();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(notifications.length, 2);
  assert.equal(badge, '');
});

test('other alarms are ignored', async () => {
  const before = notifications.length;
  await listeners.alarm[0]({ name: 'something-else' });
  assert.equal(notifications.length, before);
});

test('messages: only this extension\u2019s own pages, only the one known shape; the design\u2019s {t:"sync"} is ignored', async () => {
  const [onMessage] = listeners.message;
  const respond = () => { throw new Error('should not respond'); };
  assert.equal(onMessage({ type: 'obsidian.check-now' }, { id: 'someone-else' }, respond), false, 'foreign sender');
  assert.equal(onMessage({ type: 'obsidian.check-now' }, {}, respond), false, 'no sender id');
  assert.equal(onMessage({ t: 'sync', mine: { x: 1 } }, { id: 'ext-id' }, respond), false, 'the design\u2019s demo message');
  assert.equal(onMessage('obsidian.check-now', { id: 'ext-id' }, respond), false);
  assert.equal(onMessage(null, { id: 'ext-id' }, respond), false);
  assert.equal(onMessage({ type: 'obsidian.sign', payload: 'x' }, { id: 'ext-id' }, respond), false, 'no signing message exists');
  let answer;
  const kept = onMessage({ type: 'obsidian.check-now' }, { id: 'ext-id' }, (x) => { answer = x; });
  assert.equal(kept, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(answer.ok, true);
});

test('a storage change that turns alerts on checks straight away', async () => {
  eligible = true; seq = 5;
  store[settingsKey] = on;
  const before = notifications.length;
  listeners.changed[0]({ [settingsKey]: { newValue: on } }, 'local');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notifications.length, before + 1);
  listeners.changed[0]({ [settingsKey]: { newValue: on } }, 'sync');
});
