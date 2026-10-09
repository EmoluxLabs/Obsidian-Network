/**
 * The popup / tab entry point.
 *
 * Order matters and is the point of this file:
 *   1. The design file has already run (popup.js). It renders demo screens with demo data and arms its own
 *      timers, so the very first thing done here, before any await, is to switch those off.
 *   2. Load settings. No server → connect screen. A server this extension has no permission for → connect screen.
 *   3. Ask that server who it is (`/app-config.json`) and refuse unless it is the network the user pinned.
 *      A wrong-network or unverified server never reaches the app, so nothing from it is shown or signed.
 *   4. Only then load obsidian-app-web's real screens and add the extension's own.
 */
import { loadSettings, getJson, checkIdentity, parseServerUrl, ServerError } from './config.mjs';
import { createHost } from './host.mjs';
import { installExtScreens, showConnectScreen } from './ext-screens.mjs';

const api = globalThis.browser ?? globalThis.chrome;

// 1 ── disable the design file's demo behaviour --------------------------------------------------------------
function disableDemo() {
  // The design's own `render` and `go` are replaced (function declarations are writable on window); its
  // pending 800 ms "splash → landing" timer and 1 s tick then call these and do nothing.
  window.render = () => {};
  window.go = () => {};
  document.getElementById('app').innerHTML = '';
}

/**
 * The design file's delegated `data-a` dispatcher is live for the markup helpers it supplies (`nav`, `back`).
 * Its table `A` also holds the demo behaviours (fake sign-in, fake claim, fake send ...). Those are removed;
 * only navigation and "open in a tab" remain. tests/ui asserts this.
 */
export const KEPT_DESIGN_ACTIONS = ['go', 'goClose', 'toggleMenu', 'tab'];
function restrictDesignDispatcher() {
  let table;
  try {
    table = A; // a global lexical binding from popup.js
  } catch {
    return;
  }
  for (const key of Object.keys(table)) {
    if (!KEPT_DESIGN_ACTIONS.includes(key)) table[key] = () => {};
  }
}

disableDemo();

const settings = await loadSettings(api.storage.local);
const host = createHost(api, settings);
globalThis.ObsidianHost = host;

async function preflight() {
  if (!settings.serverUrl || !settings.network) return { ok: false, reason: 'not-configured' };
  const parsed = parseServerUrl(settings.serverUrl);
  const granted = await api.permissions.contains({ origins: [parsed.pattern] });
  if (!granted) return { ok: false, reason: 'permission', host: new URL(settings.serverUrl).host };
  try {
    const config = await getJson(settings.serverUrl, '/app-config.json');
    const verdict = checkIdentity(config, settings.network);
    if (!verdict.ok) return { ok: false, reason: verdict.kind, message: verdict.message, host: new URL(settings.serverUrl).host };
    return { ok: true };
  } catch (error) {
    const kind = error instanceof ServerError ? error.kind : 'unreachable';
    return { ok: false, reason: kind, message: error?.message ?? 'The connection failed.', host: new URL(settings.serverUrl).host };
  }
}

try {
  host.notify.setLevel(await new Promise((resolve) => (typeof api.notifications?.getPermissionLevel === 'function' ? api.notifications.getPermissionLevel(resolve) : resolve('granted'))));
} catch {
  /* level stays "granted": the OS-level decision is only known to the browser */
}

const verdict = await preflight();
if (!verdict.ok) {
  showConnectScreen({ ...verdict, api });
} else {
  const { SCREENS, esc } = await import('./screens.mjs');
  const data = await import('./data.mjs');
  let appState = null;
  const extension = installExtScreens({
    SCREENS,
    esc,
    api,
    host,
    getState: () => appState,
    repaint: () => globalThis.render?.(),
    readRoute: data.readRoute,
    getNodes: data.getNodes,
  });
  const real = await import('./real.mjs');
  appState = real.state;
  restrictDesignDispatcher();
  globalThis.__obsidianExtension = extension; // read by the UI tests only
}
