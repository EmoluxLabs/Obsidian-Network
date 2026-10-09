// Test-only stand-in for the browser's extension API (chrome.*), injected before any page script.
//
// A real browser provides this; the headless Chromium used here (a headless shell) cannot load extensions at all, so
// the extension's pages are loaded as ordinary pages under the manifest's own Content-Security-Policy and talk to this
// instead. State lives in localStorage so it survives a reload, as extension storage does.
(() => {
  const KEY = '__ext_shim';
  const fresh = () => ({ local: {}, perms: [], tabs: [], notifications: [], optionsOpened: 0, level: 'granted', permAnswer: true, badge: '' });
  const read = () => JSON.parse(localStorage.getItem(KEY) || 'null') || fresh();
  const write = (state) => localStorage.setItem(KEY, JSON.stringify(state));
  const listeners = [];
  const patterns = (details) => details.origins || [];
  const api = {
    runtime: {
      id: 'obsidian-test-extension',
      getURL: (path) => `${location.origin}/${path}`,
      openOptionsPage: () => { const s = read(); s.optionsOpened += 1; write(s); },
      sendMessage: async (message) => { const s = read(); s.sent = [...(s.sent || []), message]; write(s); return { ok: true, state: 'off' }; },
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        async get(keys) {
          const { local } = read();
          if (typeof keys === 'string') return keys in local ? { [keys]: local[keys] } : {};
          return Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys || local)).filter((k) => k in local).map((k) => [k, local[k]]));
        },
        async set(values) {
          const s = read();
          const changes = {};
          for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: s.local[k], newValue: v }; s.local[k] = v; }
          write(s);
          listeners.forEach((fn) => fn(changes, 'local'));
        },
        async remove(keys) {
          const s = read();
          for (const k of [].concat(keys)) delete s.local[k];
          write(s);
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    permissions: {
      async contains(details) { const s = read(); return patterns(details).every((p) => s.perms.includes(p)); },
      async request(details) { const s = read(); if (!s.permAnswer) return false; for (const p of patterns(details)) if (!s.perms.includes(p)) s.perms.push(p); write(s); return true; },
      async remove(details) { const s = read(); s.perms = s.perms.filter((p) => !patterns(details).includes(p)); write(s); return true; },
    },
    tabs: { async create(details) { const s = read(); s.tabs.push(details.url); write(s); return { id: 1 }; } },
    notifications: {
      getPermissionLevel: (cb) => cb(read().level),
      create: (id, options) => { const s = read(); s.notifications.push({ id, title: options.title }); write(s); },
    },
    action: { setBadgeText: async ({ text }) => { const s = read(); s.badge = text; write(s); } },
  };
  window.chrome = api;
  window.__shim = { read, write, reset: () => write(fresh()) };
})();
