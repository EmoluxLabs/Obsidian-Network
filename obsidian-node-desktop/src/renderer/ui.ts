/** UI plumbing: render scheduling, actions, toasts and the modal system. */
import { ApiError } from './api.js';
import { esc, html, raw, type Html } from './dom.js';
import type { Tone } from './store.js';

// ── render scheduling ────────────────────────────────────────────────────────
type Renderer = () => void;
let renderer: Renderer = () => {};
let scheduled = false;

export function setRenderer(fn: Renderer): void {
  renderer = fn;
}

export function requestRender(): void {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    renderer();
  });
}

// ── actions (event delegation; the page has no inline handlers) ─────────────
export type ActionHandler = (el: HTMLElement, event: Event) => void | Promise<void>;
const actions = new Map<string, ActionHandler>();

export function registerActions(map: Record<string, ActionHandler>): void {
  for (const [name, fn] of Object.entries(map)) actions.set(name, fn);
}

export function runAction(name: string, el: HTMLElement, event: Event): void {
  const handler = actions.get(name);
  if (!handler) return;
  Promise.resolve(handler(el, event)).catch((error) => toast(error instanceof ApiError || error instanceof Error ? error.message : 'Something went wrong.', 'er'));
}

// ── toasts ───────────────────────────────────────────────────────────────────
export interface Toast {
  id: number;
  message: string;
  tone: Tone;
}
let toastSeq = 0;
export let toasts: Toast[] = [];

export function toast(message: string, tone: Tone = 'vi', ms = 4200): void {
  const t: Toast = { id: ++toastSeq, message, tone };
  toasts = [...toasts.slice(-2), t];
  requestRender();
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    requestRender();
  }, ms);
}

export async function copyText(text: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(label, 'ok', 1800);
  } catch {
    toast('Copy is not available here. Select the text and copy it manually.', 'wn');
  }
}

// ── modals ───────────────────────────────────────────────────────────────────
export interface ModalButton {
  label: string;
  kind?: 'p' | 'd' | '';
  /** Runs when clicked. Return false to keep the dialog open. Throw to show the error in the dialog. */
  run?: () => Promise<boolean | void> | boolean | void;
  disabled?: () => boolean;
}

export interface ModalDef {
  title: string;
  body: () => Html;
  buttons: ModalButton[];
  /** Cancel/Escape/backdrop close. Defaults to true. */
  dismissible?: boolean;
  wide?: boolean;
  onClose?: () => void;
}

export interface OpenModal extends ModalDef {
  busy: boolean;
  error: string | null;
}

let current: OpenModal | null = null;

export function modalOpen(): boolean {
  return current !== null;
}

export function openModal(def: ModalDef): OpenModal {
  current = { ...def, busy: false, error: null };
  requestRender();
  return current;
}

export function closeModal(): void {
  const m = current;
  current = null;
  m?.onClose?.();
  requestRender();
}

export function updateModal(): void {
  requestRender();
}

export function setModalError(message: string | null): void {
  if (current) current.error = message;
  requestRender();
}

export function renderModal(): Html {
  const m = current;
  if (!m) return html``;
  const buttons = m.buttons.map((b, i) => html`<button class="btn ${b.kind ?? ''}" data-modal-button="${i}" ${m.busy || b.disabled?.() ? raw('disabled') : ''}>${b.label}</button>`);
  return html`<div class="ov" data-modal-backdrop="1"><div class="md ${m.wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${m.title}"><h2>${m.title}</h2>${m.body()}${m.error ? html`<div class="wr er" role="alert">${m.error}</div>` : ''}<div class="acts">${buttons}</div></div></div>`;
}

export async function clickModalButton(index: number): Promise<void> {
  const m = current;
  if (!m || m.busy) return;
  const button = m.buttons[index];
  if (!button) return;
  if (!button.run) {
    closeModal();
    return;
  }
  m.busy = true;
  m.error = null;
  requestRender();
  try {
    const keepOpen = (await button.run()) === false;
    if (current === m) {
      m.busy = false;
      if (!keepOpen) closeModal();
      else requestRender();
    }
  } catch (error) {
    if (current === m) {
      m.busy = false;
      m.error = error instanceof Error ? error.message : 'Something went wrong.';
      requestRender();
    }
  }
}

export function dismissModal(): void {
  if (current && current.dismissible !== false && !current.busy) closeModal();
}

// ── small view helpers ───────────────────────────────────────────────────────
const TONE_VAR: Record<Tone, string> = { ok: 'var(--ok)', wn: 'var(--wn)', er: 'var(--er)', in: 'var(--in)', vi: 'var(--vi)', mu: 'var(--mu)' };

export function badge(text: string, tone: Tone = 'mu'): Html {
  return html`<span class="bg" style="color:${tone === 'vi' ? '#B4A0FF' : TONE_VAR[tone]}"><i class="dot" style="background:${TONE_VAR[tone]}"></i>${text}</span>`;
}

export function dot(tone: Tone, size = 8): Html {
  return html`<i class="dot" style="width:${size}px;height:${size}px;background:${TONE_VAR[tone]}"></i>`;
}

export function stat(label: string, value: unknown, sub?: unknown, opts: { mono?: boolean; title?: string } = {}): Html {
  return html`<div class="card"><div class="k">${label}</div><div class="v ${opts.mono === false ? '' : 'm'}" ${opts.title ? raw(`title="${esc(opts.title)}"`) : ''}>${value}</div><div class="sub">${sub ?? ''}</div></div>`;
}

export function icon(path: string, size = 18): Html {
  return raw(`<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${esc(path)}"/></svg>`);
}

export function pageHead(crumb: string, title: string, right?: Html): Html {
  return html`<div class="cr">${crumb}</div><div class="ph"><h1>${title}</h1>${right ?? ''}</div>`;
}

export function warn(content: unknown, kind: '' | 'er' | 'in' | 'ok' = ''): Html {
  return html`<div class="wr ${kind}" role="${kind === 'er' ? 'alert' : 'note'}">${content}</div>`;
}

export function loadingCard(text = 'Loading…'): Html {
  return html`<div class="card" aria-busy="true"><div class="sk"></div><div class="sub" style="margin-top:10px">${text}</div></div>`;
}

export function emptyCard(title: string, text: string): Html {
  return html`<div class="card empty"><b>${title}</b><div class="sub" style="font-size:13px;margin-top:6px">${text}</div></div>`;
}

export function unavailableCard(title: string, text: string, tone: Tone = 'wn'): Html {
  return html`<div class="card empty"><div>${dot(tone, 10)} <b>${title}</b></div><div class="sub" style="font-size:13px;margin-top:6px">${text}</div></div>`;
}

export function mono(value: string | null | undefined, opts: { copy?: boolean; short?: boolean } = {}): Html {
  if (!value) return html`<span class="m">—</span>`;
  const shown = opts.short && value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-6)}` : value;
  return html`<span class="m" title="${value}">${shown}</span>${opts.copy ? html` <button class="lk" data-action="copy" data-copy="${value}" aria-label="Copy">Copy</button>` : ''}`;
}
