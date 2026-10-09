/** Renderer entry: boots from the main process, renders the shell and routes to screens. */
import { ApiError, call, subscribe } from './api.js';
import { $, html, raw, type Html } from './dom.js';
import { EVENTS } from '../shared/contract.js';
import { formatInt } from './format.js';
import { navigate, onNavigate, routeFromHash } from './router.js';
import { DISPLAY, LOG_CAP, NAV, NETWORK_INFO, currentNetwork, displayState, networkLabel, store, type Route } from './store.js';
import { copyText, clickModalButton, dismissModal, dot, icon, modalOpen, registerActions, renderModal, requestRender, runAction, setRenderer, toasts, toast } from './ui.js';
import { switchNetworkFlow } from './node-actions.js';
import type { Screen } from './screens/common.js';
import { overview } from './screens/overview.js';
import { nodeScreen } from './screens/node.js';
import { network } from './screens/network.js';
import { validator } from './screens/validator.js';
import { wallet } from './screens/wallet.js';
import { tx } from './screens/tx.js';
import { explorer } from './screens/explorer.js';
import { logs, logFilterChanged } from './screens/logs.js';
import { settings } from './screens/settings.js';
import { help } from './screens/help.js';
import type { NetworkName } from '../shared/chain-types.js';
import type { LogEntry } from '../shared/log-types.js';
import type { NodeProcessState } from '../shared/node-types.js';
import type { ChainSnapshot } from '../shared/view-types.js';

const SCREENS: Record<Route, Screen> = { overview, node: nodeScreen, network, validator, wallet, tx, explorer, logs, settings, help };
const LABELS = Object.fromEntries(NAV.map((n) => [n.id, n.label])) as Record<Route, string>;

// ── rendering with state preservation ────────────────────────────────────────
interface Saved {
  focusId: string | null;
  fields: Map<string, { value: string; checked: boolean; start: number | null; end: number | null }>;
  scroll: Map<string, number>;
}

function capture(root: HTMLElement): Saved {
  const fields = new Map<string, { value: string; checked: boolean; start: number | null; end: number | null }>();
  root.querySelectorAll<HTMLInputElement>('input[id], textarea[id], select[id]').forEach((el) => {
    let start: number | null = null;
    let end: number | null = null;
    try {
      start = el.selectionStart;
      end = el.selectionEnd;
    } catch {
      /* not a text field */
    }
    fields.set(el.id, { value: el.value, checked: el.checked, start, end });
  });
  const scroll = new Map<string, number>();
  root.querySelectorAll<HTMLElement>('.logbox').forEach((el) => {
    scroll.set('logbox', el.scrollHeight - el.scrollTop - el.clientHeight < 24 ? -1 : el.scrollTop);
  });
  const active = document.activeElement as HTMLElement | null;
  return { focusId: active && root.contains(active) && active.id ? active.id : null, fields, scroll };
}

function restore(root: HTMLElement, saved: Saved): void {
  saved.fields.forEach((f, id) => {
    const el = root.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`);
    if (!el) return;
    if (el.type === 'checkbox' || el.type === 'radio') el.checked = f.checked;
    else if (el.value !== f.value) el.value = f.value;
  });
  root.querySelectorAll<HTMLElement>('.logbox').forEach((el) => {
    const s = saved.scroll.get('logbox');
    el.scrollTop = s === undefined || s === -1 ? el.scrollHeight : s;
  });
  if (saved.focusId) {
    const el = root.querySelector<HTMLInputElement>(`#${CSS.escape(saved.focusId)}`);
    if (el) {
      el.focus({ preventScroll: true });
      const f = saved.fields.get(saved.focusId);
      if (f && f.start !== null && f.end !== null) {
        try {
          el.setSelectionRange(f.start, f.end);
        } catch {
          /* not a text field */
        }
      }
    }
  }
}

const last = new Map<string, string>();
function paint(id: string, content: Html, preserve: boolean): void {
  const el = document.getElementById(id);
  if (!el) return;
  const text = content.toString();
  if (last.get(id) === text) return;
  last.set(id, text);
  const saved = preserve ? capture(el) : null;
  const scrollTop = id === 'main' ? el.scrollTop : 0;
  el.innerHTML = text;
  if (saved) restore(el, saved);
  if (id === 'main') el.scrollTop = scrollTop;
}

function titlebar(): Html {
  const net = currentNetwork();
  const info = NETWORK_INFO[net]!;
  return html`<img src="./assets/obsidian-logo.png" width="22" height="22" style="border-radius:50%" alt=""><b>OBSIDIAN NODE</b>
    <div class="netwrap"><button class="net" data-action="menu.toggle" aria-haspopup="menu" aria-expanded="${store.menuOpen}" aria-label="Network selector: ${info.label}">${dot(info.tone)}${info.label.toUpperCase()} ▾</button>
    ${store.menuOpen ? html`<div class="dd" role="menu">${(Object.keys(NETWORK_INFO) as NetworkName[]).map((k) => html`<button role="menuitem" data-action="menu.net" data-net="${k}"><b style="color:${k === 'mainnet' ? 'var(--wn)' : 'var(--tx)'}">${NETWORK_INFO[k]!.label}${k === net ? ' · current' : ''}</b><div class="sub">${NETWORK_INFO[k]!.blurb}</div></button>`)}</div>` : ''}</div>
    <div class="sp"></div>`;
}

function sidebar(): Html {
  const collapsed = store.settings?.ui.sidebarCollapsed ?? false;
  return html`${NAV.map((i) => html`<button class="ni ${store.route === i.id ? 'on' : ''}" title="${i.label}" data-action="route" data-route="${i.id}" aria-label="${i.label}" aria-current="${store.route === i.id ? 'page' : 'false'}">${icon(i.icon)}<span class="lb">${i.label}</span></button>`)}
    <div style="flex:1"></div><button class="ni" data-action="sidebar.toggle" title="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}" aria-label="${collapsed ? 'Expand sidebar' : 'Collapse sidebar'}">${icon(collapsed ? 'M9 6l6 6-6 6' : 'M15 6l-6 6 6 6')}<span class="lb">Collapse</span></button>`;
}

function footer(): Html {
  const s = displayState();
  const d = DISPLAY[s];
  const status = store.snap?.status;
  const live = s === 'synced' || s === 'syncing';
  return html`<span>${dot(d.tone)} Node: ${d.badge.toLowerCase()}</span><span>${networkLabel(currentNetwork())}</span>${live && status ? html`<span class="m">Block ${formatInt(status.height)}</span><span>${status.peers} peer${status.peers === 1 ? '' : 's'}</span>` : ''}<span style="flex:1"></span><span>Obsidian Node ${store.appInfo ? `v${store.appInfo.appVersion}` : ''}</span>`;
}

function overlay(): Html {
  return html`${renderModal()}<div class="toasts" aria-live="polite">${toasts.map((t) => html`<div class="tt ${t.tone}" role="status">${t.message}</div>`)}</div>`;
}

function render(): void {
  const splash = document.getElementById('splash');
  if (!store.ready) {
    if (store.bootError && splash) splash.innerHTML = `<div class="spl"><div style="font-weight:800;letter-spacing:.3em;font-size:18px">OBSIDIAN NODE</div><div class="wr er" style="max-width:520px">The application could not start: ${raw(escapeText(store.bootError)).toString()}</div></div>`;
    return;
  }
  splash?.remove();
  document.getElementById('sb')?.classList.toggle('c', store.settings?.ui.sidebarCollapsed ?? false);
  paint('tb', titlebar(), false);
  paint('sb', sidebar(), false);
  paint('main', html`<div class="screen" data-route="${store.route}">${SCREENS[store.route].render()}</div>`, true);
  paint('ft', footer(), false);
  paint('ov', overlay(), true);
  document.title = `${LABELS[store.route]} — Obsidian Node`;
  if (modalOpen()) {
    const ov = document.getElementById('ov')!;
    if (!ov.contains(document.activeElement)) (ov.querySelector<HTMLElement>('input, textarea, select') ?? ov.querySelector<HTMLElement>('button.p, button.d') ?? ov.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }
}

function escapeText(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ── events ───────────────────────────────────────────────────────────────────
registerActions({
  route: (el) => navigate((el.dataset.route ?? 'overview') as Route),
  'menu.toggle': () => {
    store.menuOpen = !store.menuOpen;
    requestRender();
  },
  'menu.net': (el) => {
    store.menuOpen = false;
    switchNetworkFlow(el.dataset.net as NetworkName);
    requestRender();
  },
  'sidebar.toggle': async () => {
    const collapsed = !(store.settings?.ui.sidebarCollapsed ?? false);
    store.settings = await call('settings:ui-update', { sidebarCollapsed: collapsed });
    requestRender();
  },
  copy: async (el) => {
    await copyText(el.dataset.copy ?? '');
  },
});

function installEvents(): void {
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    const modalBtn = target.closest<HTMLElement>('[data-modal-button]');
    if (modalBtn) {
      void clickModalButton(Number(modalBtn.dataset.modalButton));
      return;
    }
    if (target.classList.contains('ov')) {
      dismissModal();
      return;
    }
    const el = target.closest<HTMLElement>('[data-action]');
    if (el && !(el as HTMLButtonElement).disabled) {
      event.preventDefault();
      runAction(el.dataset.action!, el, event);
      return;
    }
    if (store.menuOpen && !target.closest('.netwrap')) {
      store.menuOpen = false;
      requestRender();
    }
  });
  document.addEventListener('submit', (event) => {
    const form = (event.target as HTMLElement).closest<HTMLElement>('form[data-submit]');
    if (!form) return;
    event.preventDefault();
    runAction(form.dataset.submit!, form, event);
  });
  const changed = (event: Event): void => {
    const el = event.target as HTMLInputElement;
    if (el.id && logFilterChanged(el.id, el.value)) return;
    const name = el.dataset?.actionChange;
    if (name && event.type === 'change') runAction(name, el, event);
  };
  document.addEventListener('change', changed);
  document.addEventListener('input', (event) => {
    const el = event.target as HTMLInputElement;
    if (el.id === 'lg-q') changed(event);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (modalOpen()) dismissModal();
      else if (store.menuOpen) {
        store.menuOpen = false;
        requestRender();
      }
    }
    if (event.key === 'Enter' && modalOpen()) {
      const t = event.target as HTMLElement;
      if (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'checkbox') {
        const primary = document.querySelector<HTMLButtonElement>('#ov button.p:not(:disabled), #ov button.d:not(:disabled)');
        primary?.click();
      }
    }
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────
let current: Screen | null = null;
function switchScreen(route: Route): void {
  current?.leave?.();
  current = SCREENS[route];
  current.enter?.();
}

async function boot(): Promise<void> {
  const started = Date.now();
  try {
    store.appInfo = await call('app:info');
    const s = await call('settings:get');
    store.settings = s.settings;
    store.settingsRecovered = s.recovered;
    store.node = await call('node:state');
    store.snap = await call('chain:snapshot');
    store.logs = await call('node:logs', { limit: 500, minSeverity: 'DEBUG' });
  } catch (error) {
    store.bootError = error instanceof ApiError ? error.message : (error as Error).message;
    render();
    return;
  }
  subscribe(EVENTS.nodeState, (data) => {
    store.node = data as NodeProcessState;
    requestRender();
  });
  subscribe(EVENTS.chain, (data) => {
    store.snap = data as ChainSnapshot;
    requestRender();
  });
  subscribe(EVENTS.log, (data) => {
    store.logs.push(data as LogEntry);
    if (store.logs.length > LOG_CAP) store.logs.splice(0, store.logs.length - LOG_CAP);
    if (store.route === 'logs' || store.route === 'overview' || store.route === 'node') requestRender();
  });
  const wait = Math.max(0, 700 - (Date.now() - started));
  await new Promise((r) => setTimeout(r, wait));
  store.route = routeFromHash();
  store.ready = true;
  onNavigate((route) => switchScreen(route));
  switchScreen(store.route);
  render();
  setInterval(() => {
    store.now = Date.now();
    if (store.node?.phase === 'running' && (store.route === 'overview' || store.route === 'node')) requestRender();
  }, 1000);
  window.addEventListener('hashchange', () => navigate(routeFromHash()));
  void toast;
}

setRenderer(render);
installEvents();
void boot();
void $;
