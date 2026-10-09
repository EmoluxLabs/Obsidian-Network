/**
 * Connection settings and diagnostics.
 *
 * This is where the extension is pointed at a server and where the browser's own permission prompt is
 * raised (it needs a click, and the popup would close under the prompt). Nothing is saved unless the server
 * answers as the network the user chose. Built with DOM calls and textContent only: nothing a server says
 * is ever parsed as markup.
 */
import { NETWORKS, NETWORK_NAMES, SETTINGS_KEY, checkIdentity, getJson, loadSettings, parseServerUrl, runDiagnostics, saveSettings, ServerError } from './config.mjs';

const api = globalThis.browser ?? globalThis.chrome;
const NOTIFIED_KEY = 'obsidian.lastNotified';

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'style') node.style.cssText = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value);
  }
  for (const child of children.flat().filter((c) => c !== null && c !== undefined && c !== false)) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

const root = document.getElementById('app');
let settings = await loadSettings(api.storage.local);
let message = { text: '', tone: '' };
let diag = null;
let busy = null;
let alertsResult = null;

function say(text, tone = '') {
  message = { text, tone };
  paint();
}

async function save() {
  const input = document.getElementById('server');
  const network = document.getElementById('network').value;
  const parsed = parseServerUrl(input.value);
  if (!parsed.ok) return say(parsed.error, 'err');
  if (!NETWORKS[network]) return say('Choose which network this extension should use.', 'err');

  busy = 'save';
  say('Asking the browser for permission\u2026');
  const alreadyAllowed = await api.permissions.contains({ origins: [parsed.pattern] });
  let granted = alreadyAllowed;
  if (!granted) {
    try {
      granted = await api.permissions.request({ origins: [parsed.pattern] });
    } catch (error) {
      granted = false;
    }
  }
  if (!granted) {
    busy = null;
    return say('Permission was not granted, so the extension cannot contact that server. Nothing was saved.', 'err');
  }

  say('Checking that the server is the network you chose\u2026');
  let verdict;
  try {
    verdict = checkIdentity(await getJson(parsed.origin, '/app-config.json'), network);
  } catch (error) {
    verdict = { ok: false, message: error instanceof ServerError ? error.message : 'The connection failed.' };
  }
  if (!verdict.ok) {
    if (!alreadyAllowed) await api.permissions.remove({ origins: [parsed.pattern] }).catch(() => {});
    busy = null;
    return say(`Not saved. ${verdict.message}`, 'err');
  }

  const previous = settings;
  const moved = previous.serverUrl && previous.serverUrl !== parsed.origin;
  const networkChanged = previous.network && previous.network !== network;
  settings = await saveSettings(api.storage.local, {
    serverUrl: parsed.origin,
    network,
    // The remembered address and the "already alerted" marker belong to the old connection.
    ...(moved || networkChanged ? { address: null } : {}),
  });
  if (moved || networkChanged) await api.storage.local.remove(NOTIFIED_KEY);
  if (moved) {
    const old = parseServerUrl(previous.serverUrl);
    if (old.ok && old.pattern !== parsed.pattern) await api.permissions.remove({ origins: [old.pattern] }).catch(() => {});
  }
  diag = null;
  busy = null;
  say(`Connected to ${new URL(settings.serverUrl).host} \u00b7 ${network}. Open the extension to continue.`, 'ok');
}

async function diagnose() {
  if (!settings.serverUrl) return say('Connect to a server first.', 'err');
  busy = 'diag';
  paint();
  diag = await runDiagnostics(settings.serverUrl, settings.network);
  busy = null;
  paint();
}

async function checkAlerts() {
  busy = 'alerts';
  paint();
  try {
    alertsResult = await api.runtime.sendMessage({ type: 'obsidian.check-now' });
  } catch {
    alertsResult = { ok: false };
  }
  busy = null;
  paint();
}

async function disconnect() {
  if (!confirm('Disconnect this extension from its server? The wallet sealed on this device is not deleted; remove it from the Wallet screen if you want that.')) return;
  if (settings.serverUrl) {
    const parsed = parseServerUrl(settings.serverUrl);
    if (parsed.ok) await api.permissions.remove({ origins: [parsed.pattern] }).catch(() => {});
  }
  await api.storage.local.remove([SETTINGS_KEY, NOTIFIED_KEY]);
  settings = await loadSettings(api.storage.local);
  diag = null;
  alertsResult = null;
  say('Disconnected. The browser permission for that server was withdrawn.', 'ok');
}

function paint() {
  const fields = {
    server: document.getElementById('server')?.value ?? settings.serverUrl ?? '',
    network: document.getElementById('network')?.value ?? settings.network ?? '',
  };
  root.replaceChildren(
    h('div', { class: 'hd' }, h('b', { style: 'letter-spacing:.18em' }, 'OBSIDIAN \u00b7 CONNECTION'), h('span', { class: 'pill' }, settings.serverUrl ? 'CONFIGURED' : 'NOT CONFIGURED')),
    h('p', { class: 'mu', style: 'line-height:1.5' }, 'This extension has no network of its own. It talks to an Obsidian app server \u2014 the one you run with Obsidian Node, or your network\u2019s public app \u2014 and shows what that server\u2019s node reports. It refuses any server that is not the network you choose here.'),
    h('div', { class: 'lb' }, 'SERVER'),
    h('label', { for: 'server' }, 'APP SERVER ADDRESS'),
    h('input', { id: 'server', type: 'url', placeholder: 'https://app.example.org', autocomplete: 'off', spellcheck: 'false', value: fields.server }),
    h('label', { for: 'network' }, 'NETWORK'),
    (() => {
      const select = h('select', { id: 'network', style: 'width:100%;height:56px;border:1.5px solid #D5D9DF;border-radius:14px;padding:0 16px;font-size:16px;background:#fff' },
        h('option', { value: '' }, 'Choose\u2026'),
        NETWORK_NAMES.map((name) => h('option', { value: name }, `${name}${NETWORKS[name].production ? ' (real value)' : ' (test, no value)'}`)),
      );
      select.value = fields.network;
      return select;
    })(),
    h('div', { class: message.tone === 'err' ? 'err' : message.tone === 'ok' ? 'ok' : 'mu', role: 'status', style: 'font-size:13px;font-weight:600;margin-top:10px;min-height:18px' }, message.text),
    h('button', { class: 'btn p', onclick: save, ...(busy ? { disabled: '' } : {}) }, busy === 'save' ? 'WORKING\u2026' : 'SAVE & ALLOW'),
    h('p', { class: 'mu', style: 'font-size:12px;line-height:1.5' }, 'Only https:// servers are accepted (http:// only for localhost or 127.0.0.1). Saving asks your browser to let this extension contact that one server; nothing else is requested.'),

    h('div', { class: 'lb' }, 'DIAGNOSTICS'),
    diag
      ? h('div', { class: 'card' }, diag.map((d) => h('div', { class: 'row', style: 'display:block' },
          h('div', { style: 'display:flex;justify-content:space-between' }, h('span', {}, d.label.toUpperCase()), h('b', { class: d.status === 'ok' ? 'ok' : d.status === 'skipped' ? 'mu' : '', style: d.status === 'fail' ? 'color:#A12626' : '' }, d.status.toUpperCase())),
          h('div', { class: 'mu', style: 'font-size:12px;margin-top:4px;word-break:break-word' }, d.detail))))
      : h('p', { class: 'mu', style: 'font-size:13px' }, settings.serverUrl ? 'Not run yet.' : 'Connect to a server to run checks.'),
    h('button', { class: 'btn', onclick: diagnose, ...(busy ? { disabled: '' } : {}) }, busy === 'diag' ? 'RUNNING\u2026' : 'RUN CHECKS'),

    h('div', { class: 'lb' }, 'CLAIM ALERTS'),
    h('div', { class: 'card' },
      h('div', { class: 'row' }, h('span', {}, 'ALERTS'), h('b', { class: settings.alerts ? 'ok' : 'mu' }, settings.alerts ? 'ON' : 'OFF')),
      h('div', { class: 'row' }, h('span', {}, 'WALLET KNOWN'), h('b', { class: settings.address ? 'ok' : 'mu' }, settings.address ? 'YES' : 'NO')),
      alertsResult ? h('div', { class: 'row' }, h('span', {}, 'LAST CHECK'), h('b', { class: 'm' }, alertsResult.ok ? String(alertsResult.state).toUpperCase() : 'FAILED')) : null),
    h('p', { class: 'mu', style: 'font-size:12px;line-height:1.5' }, 'Turn alerts on or off from the Menu inside the extension. The service worker only asks the node whether a claim is open; it never claims.'),
    h('button', { class: 'btn', onclick: checkAlerts, ...(busy || !settings.alerts ? { disabled: '' } : {}) }, busy === 'alerts' ? 'CHECKING\u2026' : 'CHECK NOW'),

    h('div', { class: 'lb' }, 'DISCONNECT'),
    h('button', { class: 'btn', onclick: disconnect, ...(settings.serverUrl ? {} : { disabled: '' }) }, 'DISCONNECT & FORGET SERVER'),
    h('p', { class: 'mu', style: 'font-size:12px;line-height:1.5' }, 'Withdraws the browser permission and forgets the server. Your sealed wallet and your account are not touched.'),
  );
}

paint();
