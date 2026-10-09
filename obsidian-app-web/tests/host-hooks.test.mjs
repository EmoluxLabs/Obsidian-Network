/**
 * The optional embedding-host hooks (`globalThis.ObsidianHost`) used by the browser extension.
 *
 * Two promises are tested: with NO host the app behaves exactly as before (same-origin, same-origin credentials,
 * no extra Menu rows, the browser's own notifier); and WITH a host the host is only a transport — it supplies an
 * address and a deadline, and an unconfigured host sends nothing at all.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getStatus } from '../public/data.mjs';
import * as notify from '../public/notify.mjs';
import { SCREENS } from '../public/screens.mjs';

let calls;
beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, text: async () => '{"height":7}' };
  };
});
afterEach(() => {
  delete globalThis.ObsidianHost;
});

test('no host: requests go to this origin with same-origin credentials, unchanged', async () => {
  await getStatus();
  assert.equal(calls[0].url, '/api/rpc?path=%2Fstatus');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal(calls[0].init.signal, undefined);
});

test('host: requests go to the host\u2019s server, with credentials and a deadline, after the host is ready', async () => {
  let ready = false;
  globalThis.ObsidianHost = {
    ready: new Promise((resolve) => setTimeout(() => { ready = true; resolve(); }, 20)),
    apiBase: () => 'https://app.example.org',
    timeoutMs: 5000,
  };
  await getStatus();
  assert.ok(ready, 'waited for the host');
  assert.equal(calls[0].url, 'https://app.example.org/api/rpc?path=%2Fstatus');
  assert.equal(calls[0].init.credentials, 'include');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
});

test('host with no server configured: the request is never sent', async () => {
  globalThis.ObsidianHost = {
    ready: Promise.resolve(),
    apiBase: () => {
      throw Object.assign(new Error('No server'), { code: 'ERR_NOT_CONFIGURED' });
    },
  };
  await assert.rejects(getStatus(), /No server/);
  assert.equal(calls.length, 0);
});

const menuState = { account: { email: 'a@gmail.com' }, status: null, menu: false };

test('Menu: no host means no extra rows', () => {
  assert.ok(!/ObsidianExtTab|>NODE</.test(SCREENS.menu(menuState)));
});

test('Menu: host rows are rendered, escaped, and anything not an Obsidian handler or a plain screen name is dropped', () => {
  globalThis.ObsidianHost = {
    menu: [
      { label: 'NODE', go: 'node' },
      { label: 'OPEN <b>', call: 'ObsidianExtTab' },
      { label: 'bad call', call: 'alert' },
      { label: 'bad go', go: "x');alert(1);('" },
      { label: 'bad call 2', call: 'ObsidianX());alert(1);(' },
      null,
    ],
  };
  const html = SCREENS.menu(menuState);
  assert.ok(html.includes(`onclick="ObsidianGo('node')"`));
  assert.ok(html.includes('onclick="ObsidianExtTab()"'));
  assert.ok(html.includes('OPEN &lt;b&gt;'));
  assert.ok(!html.includes('alert'));
});

test('notify: with a host, every call is the host\u2019s and the browser\u2019s Notification is not touched', async () => {
  const seen = [];
  globalThis.Notification = new Proxy(function () {}, {
    get() {
      throw new Error('Notification must not be used when a host takes over');
    },
  });
  globalThis.ObsidianHost = {
    notify: {
      note: 'host note',
      permission: () => 'granted',
      enable: async (address) => (seen.push(['enable', address]), 'granted'),
      disable: () => seen.push(['disable']),
      resume: (address) => seen.push(['resume', address]),
    },
  };
  try {
    assert.equal(notify.permission(), 'granted');
    assert.equal(notify.isSupported(), true);
    assert.equal(notify.limitNote(), 'host note');
    assert.equal(await notify.enable('dobs1abc'), 'granted');
    notify.disable();
    notify.resume('dobs1abc');
    assert.deepEqual(seen, [['enable', 'dobs1abc'], ['disable'], ['resume', 'dobs1abc']]);
  } finally {
    delete globalThis.Notification;
  }
});

test('notify: with no host the note is the web one', () => {
  assert.match(notify.limitNote(), /Closing the tab stops them/);
});
