/**
 * Small DOM toolkit for the interface pages.
 *
 * Deliberately dependency-free: no framework, no build-time magic, no inline
 * event handlers (the interface ships a strict Content-Security-Policy, so all
 * listeners are attached from JavaScript).
 */

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
 * Format an Obsidian amount exactly, without ever going through a float.
 *
 * The node speaks two languages for the same quantity and both are exact:
 *
 *   - seal counts   — integer strings, 10^18 seals = 1 OBS (`/status.supplySeals`)
 *   - OBS decimals  — `"100000.000000000000000000"` (`/supply.totalSupplyObs`)
 *
 * Feeding a decimal to a seal formatter (or the reverse) does not throw, it
 * just displays the wrong number: 1000000000000000 seals read as a decimal is
 * 1, and a decimal read as a seal count is 0. So this accepts either, detects
 * which one it was given, and never rounds through a float.
 */
export function obs(value: string | bigint | number | undefined | null, decimals = 8): string {
  if (value === undefined || value === null) return '—';
  const text = typeof value === 'bigint' ? value.toString() : String(value).trim();
  if (text === '' || !/^-?\d+(\.\d+)?$/.test(text)) return '—';
  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [wholePart, givenFraction] = digits.split('.');
  let whole: string;
  let fraction: string;
  if (givenFraction === undefined) {
    // Seal count: the last 18 digits are the fractional part of one OBS.
    const padded = digits.padStart(19, '0');
    whole = padded.slice(0, padded.length - 18);
    fraction = padded.slice(-18);
  } else {
    whole = wholePart;
    fraction = givenFraction.padEnd(18, '0').slice(0, 18);
  }
  const trimmed = fraction.slice(0, Math.max(0, decimals)).replace(/0+$/, '');
  const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${grouped}${trimmed ? `.${trimmed}` : ''}`;
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

/**
 * Format micro-USD (a node integer string) as dollars: `usd('50000000')` = `$50.00`.
 * A string that is already formatted (`"$50.1"`) passes through untouched.
 */
export function usd(microUsd: string | number | bigint | undefined | null, digits = 2): string {
  if (microUsd === undefined || microUsd === null) return '—';
  const text = typeof microUsd === 'bigint' ? microUsd.toString() : String(microUsd).trim();
  if (text === '') return '—';
  if (text.startsWith('$')) return text;
  if (!/^-?\d+$/.test(text)) return '—';
  const value = BigInt(text);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, Math.max(0, digits)).replace(/0+$/, '');
  return `${negative ? '-' : ''}$${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Format whole dollars. `/land/countries.glvUsd` is `"20403"` — dollars, not
 * micro-USD — and reading it as micro-USD would print `$0.02` for `$20,403`.
 */
export function usdDollars(dollars: string | number | bigint | undefined | null, digits = 0): string {
  if (dollars === undefined || dollars === null) return '—';
  const text = typeof dollars === 'bigint' ? dollars.toString() : String(dollars).trim();
  if (text === '') return '—';
  if (text.startsWith('$')) return text;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return '—';
  const [whole, fraction = ''] = text.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const trimmed = fraction.slice(0, Math.max(0, digits)).replace(/0+$/, '');
  return `$${grouped}${trimmed ? `.${trimmed}` : ''}`;
}

/**
 * Whole-dollar string → micro-USD, exact. `/params.social.businessPagePriceUsd`
 * arrives as `"50.00"` (dollars), while fees are computed in micro-USD, and
 * converting through a float would round the protocol fee.
 */
export function usdMicroFromDollars(dollars: string | number | bigint): bigint {
  const text = typeof dollars === 'bigint' ? dollars.toString() : String(dollars).trim();
  if (!/^\d+(\.\d{0,6})?$/.test(text)) throw new Error(`not a USD amount: ${dollars}`);
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0') || '0');
}

/** Pass through an amount the node already formatted (`"$50.1"`). */
export function usdText(text: string | undefined | null): string {
  if (text === undefined || text === null || text === '') return '—';
  return String(text);
}

/**
 * Reward amounts from `/mining/schedule` or `/mining/status`. `obs()` accepts
 * both exact shapes, so a node that sends `dailyRewardObs` and one that sends
 * `dailyRewardSeals` both display the real number instead of `0 OBS`.
 */
export function rewardLine(schedule: { dailyRewardSeals?: string; dailyRewardObs?: string; rewardPerDayObs?: string }): string {
  return `${obs(schedule.dailyRewardObs ?? schedule.dailyRewardSeals ?? schedule.rewardPerDayObs)} OBS`;
}

export function rewardPerClaim(schedule: { claimRewardSeals?: string; claimRewardObs?: string; rewardPerClaimObs?: string }): string {
  return `${obs(schedule.claimRewardObs ?? schedule.claimRewardSeals ?? schedule.rewardPerClaimObs)} OBS`;
}

/** A protocol price is only a price when the node says the feed is usable. */
export function oraclePriceText(oracle: { usable?: boolean; priceUsd?: string; priceUsdMicro?: string } | undefined): string {
  if (!oracle || oracle.usable !== true) return 'no price yet';
  if (oracle.priceUsd !== undefined && oracle.priceUsd !== '') return usdText(oracle.priceUsd);
  return usd(oracle.priceUsdMicro ?? '0');
}

/** The oracle median in micro-USD, or undefined when the feed is stale or too thin. */
export function oraclePriceMicro(oracle: { usable?: boolean; priceUsdMicro?: string } | undefined): bigint | undefined {
  if (!oracle || oracle.usable !== true) return undefined;
  const micro = oracle.priceUsdMicro ?? '';
  if (!/^\d+$/.test(micro) || micro === '0') return undefined;
  return BigInt(micro);
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
