/**
 * Small DOM toolkit for the interface pages.
 *
 * Deliberately dependency-free: no framework, no build-time magic, no inline
 * event handlers (the interface ships a strict Content-Security-Policy, so all
 * listeners are attached from JavaScript).
 */

import { displayInteger, displayObs, displayObsWithUnit, shortenIdentifier, type IdentifierKind } from '../../core/protocol/display.js';

export type Child = Node | string | number | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

export function qs<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing element: ${selector}`);
  return found;
}

export function mount(...nodes: Child[]): void {
  const root = qs('#app');
  root.replaceChildren();
  root.append(...nodes.filter((node): node is Node | string => node !== null && node !== undefined && node !== false).map((node) => (typeof node === 'number' ? String(node) : node)));
}

export function clear(node: Element): void {
  node.replaceChildren();
}

/**
 * Format an Obsidian amount for a person: exact, grouped, trailing zeros removed, never `0` for a real amount.
 *
 * The node speaks two exact shapes for one quantity — seal counts (integer text, 10^18 seals = 1 OBS) and OBS
 * decimals (`"100000.000000000000000000"`) — and this accepts either. All the rules live in
 * core/protocol/display.ts, the one formatter every interface shares (see its header); this is its entry point for
 * the pages. `decimals` is a display cap for a tight spot; leave it out and every significant digit is shown.
 * Display only: nothing here feeds a transaction, a fee or a balance.
 */
export function obs(value: string | bigint | undefined | null, decimals?: number): string {
  return displayObs(value, decimals === undefined ? undefined : { maxDecimals: decimals });
}

/** "0.05 OBS". A missing value is the unavailable mark with no unit. */
export function obsUnit(value: string | bigint | undefined | null, decimals?: number): string {
  return displayObsWithUnit(value, decimals === undefined ? undefined : { maxDecimals: decimals });
}

/**
 * Short display text for an identifier inside a sentence or a toast (`obs1ijdn...slvgsi`). Text only: for a value shown on
 * the page use `identifier()` (lib/identifier.ts), which also carries the whole value and a copy button.
 */
export function shortId(value: string | undefined | null, kind: IdentifierKind = 'hash'): string {
  return shortenIdentifier(value, kind, 'narrow');
}

/** A whole-number count (height, miners, iterations) with commas; exact, and the same in every locale. */
export function count(value: string | bigint | number | undefined | null): string {
  return displayInteger(value);
}

/** Exact seals → exact OBS decimal string. Used to build transaction bodies. */
export function obsFromSeals(seals: bigint): string {
  if (seals < 0n) throw new Error('amounts are never negative');
  const whole = seals / 10n ** 18n;
  const fraction = (seals % 10n ** 18n).toString().padStart(18, '0');
  return `${whole}.${fraction}`;
}

/** Exact OBS decimal string → exact seals. Rejects anything that is not a plain amount. */
export function sealsFromObs(value: string | bigint): bigint {
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (!/^\d+(\.\d{0,18})?$/.test(text)) throw new Error(`not an OBS amount: ${value}`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0');
}

/*
 * The USD formatting helpers (`usd`, `usdDollars`, `usdMicroFromDollars`,
 * `usdText`) and the oracle readers (`oraclePriceText`, `oraclePriceMicro`)
 * lived here until 1.2.10.
 *
 * They were removed, not merely unused. Every protocol fee is denominated in
 * OBS and fixed by consensus, so no page converts anything through an
 * exchange rate; keeping dollar formatters around invites the next page to
 * reach for one and reintroduce a dependency the protocol deliberately does
 * not have. `GET /oracle` still exists for reporting and any consumer that
 * wants it can read it directly.
 */

/**
 * Reward amounts from `/mining/schedule` or `/mining/status`. `obs()` accepts
 * both exact shapes, so a node that sends `dailyRewardObs` and one that sends
 * `dailyRewardSeals` both display the real number instead of `0 OBS`.
 */
export function rewardLine(schedule: { dailyRewardSeals?: string; dailyRewardObs?: string; rewardPerDayObs?: string }): string {
  return obsUnit(schedule.dailyRewardObs ?? schedule.dailyRewardSeals ?? schedule.rewardPerDayObs);
}

export function rewardPerClaim(schedule: { claimRewardSeals?: string; claimRewardObs?: string; rewardPerClaimObs?: string }): string {
  return obsUnit(schedule.claimRewardObs ?? schedule.claimRewardSeals ?? schedule.rewardPerClaimObs);
}

export function relativeTime(timestampSeconds: number): string {
  if (!timestampSeconds) return '—';
  const delta = Math.floor(Date.now() / 1000) - timestampSeconds;
  if (delta < 0) return `in ${duration(-delta)}`;
  if (delta < 5) return 'just now';
  return `${duration(delta)} ago`;
}

export function duration(seconds: number): string {
  if (seconds <= 0) return 'now';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

export function when(timestampSeconds: number): string {
  if (!timestampSeconds) return '—';
  return new Date(timestampSeconds * 1000).toLocaleString();
}

export function short(value: string | undefined, size = 10): string {
  if (!value) return '—';
  if (value.length <= size * 2 + 1) return value;
  return `${value.slice(0, size)}…${value.slice(-6)}`;
}

export function pct(value: number, digits = 2): string {
  return `${value.toFixed(digits)}%`;
}

let toastTimer: number | undefined;

export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  let host = document.getElementById('toast');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast';
    host.className = 'toast-host';
    document.body.append(host);
  }
  const item = el('div', { class: `toast toast-${kind}`, role: 'status' }, message);
  host.append(item);
  window.setTimeout(() => item.classList.add('toast-out'), 4200);
  window.setTimeout(() => item.remove(), 5000);
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => host!.replaceChildren(), 5200);
}

export async function copy(value: string, label = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${label} to clipboard`, 'success');
  } catch {
    toast('Clipboard access was blocked by the browser', 'error');
  }
}

export function download(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function copyButton(value: string | (() => string), label = 'Copy'): HTMLElement {
  const button = el('button', { class: 'ghost small', type: 'button' }, label);
  button.addEventListener('click', () => void copy(typeof value === 'function' ? value() : value));
  return button;
}

export function card(title: string, ...body: Child[]): HTMLElement {
  return el('section', { class: 'card' }, el('h2', {}, title), ...body);
}

export function kv(pairs: Array<[string, Child]>): HTMLElement {
  return el(
    'dl',
    { class: 'kv' },
    ...pairs.flatMap(([key, value]) => [el('dt', {}, key), el('dd', {}, value)]),
  );
}

export function badge(text: string, kind: 'ok' | 'warn' | 'bad' | 'neutral' = 'neutral'): HTMLElement {
  return el('span', { class: `badge badge-${kind}` }, text);
}

export function button(label: string, onClick: () => void | Promise<void>, options: { kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; id?: string } = {}): HTMLButtonElement {
  const node = el('button', {
    class: options.kind === 'primary' ? 'primary' : options.kind === 'danger' ? 'danger' : 'ghost',
    type: 'button',
    id: options.id,
    disabled: options.disabled ? 'disabled' : undefined,
  }, label);
  node.addEventListener('click', async () => {
    node.disabled = true;
    try {
      await onClick();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      node.disabled = false;
    }
  });
  return node;
}

export function spinner(label = 'Loading…'): HTMLElement {
  return el('div', { class: 'loading' }, el('span', { class: 'dot' }), label);
}

export function table(headers: string[], rows: Child[][]): HTMLElement {
  return el(
    'div',
    { class: 'table-wrap' },
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, ...headers.map((header) => el('th', {}, header)))),
      el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((cell) => el('td', {}, cell))))),
    ),
  );
}

export function link(href: string, label: string, external = false): HTMLElement {
  return el('a', { href, class: 'link', target: external ? '_blank' : undefined, rel: external ? 'noreferrer' : undefined }, label);
}
