/**
 * Long identifiers in the Web App: wallet addresses, transaction ids, block hashes.
 *
 * Same policy as the main platform (shortenIdentifier in data.mjs mirrors core/protocol/display.ts): the screen shows
 * `obs1ijdn...slvgsi`, tapping it shows the whole value, COPY puts exactly the whole value on the clipboard, and a
 * screen reader is told the whole value instead of the shortened text. The full value is held in the attributes
 * (escaped for HTML, and `arg`-escaped for the copy handler) and is never recovered from the shortened text.
 *
 * Nothing here changes an identifier that is stored, sent, validated or signed.
 *
 * The page is `design/index.html`'s own markup and stays byte-for-byte as designed, so the few rules these need are
 * injected as a <style> at start-up (the app's CSP allows inline styles). The handlers used here are inline, like
 * the design's own, so they run under the same script policy as the rest of the app.
 */

import { arg, isMaskedIdentifier, shortenIdentifier } from './data.mjs';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const LABELS = { address: 'Wallet address', hash: 'Hash', id: 'Identifier' };

/**
 * Markup for one identifier.
 * @param {string|null|undefined} value  the canonical, full value
 * @param {'address'|'hash'|'id'} kind
 * @param {{ copy?: boolean, label?: string, expanded?: boolean, interactive?: boolean }} [options]
 */
export function identifierHtml(value, kind = 'address', options = {}) {
  const full = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
  if (!full) return '—';
  const label = options.label ?? LABELS[kind] ?? LABELS.id;
  const short = shortenIdentifier(full, kind, 'narrow');
  // A value the node already masked is shown as it came and offers no copy: it is not the identifier.
  if (isMaskedIdentifier(full) || short === full) {
    return `<span class="idv idv-plain m" title="${esc(full)}">${esc(full)}</span>`;
  }
  // Inside a row that is itself a link (a list of transactions) a second tap target would fight the row: show the
  // short form with the full value on hover/long-press and in the screen-reader label; the detail view has the rest.
  if (options.interactive === false) {
    return `<span class="idv idv-plain m" title="${esc(full)}" aria-label="${esc(label)} ${esc(full)}">${esc(short)}</span>`;
  }
  const copy =
    options.copy === false
      ? ''
      : `<button type="button" class="idv-c" aria-label="Copy ${esc(label.toLowerCase())}" title="Copy ${esc(label.toLowerCase())}" onclick="ObsidianCopy('${arg(full)}')">COPY</button>`;
  return (
    `<span class="idv${options.expanded ? ' open' : ''}">` +
    `<span class="idv-t m" data-idv role="button" tabindex="0" aria-expanded="${options.expanded ? 'true' : 'false'}" ` +
    `aria-label="${esc(label)} ${esc(full)}. Activate to show or hide the full value" title="${esc(full)}">` +
    `<span class="idv-s" aria-hidden="true">${esc(short)}</span><span class="idv-f" aria-hidden="true">${esc(full)}</span></span>` +
    copy +
    `</span>`
  );
}

/** A COPY button for a value that is already shown in full (a detail page). Copies exactly `full`. */
export function copyButtonHtml(full, label = 'identifier') {
  const text = typeof full === 'string' ? full : '';
  if (!text) return '';
  return `<button type="button" class="idv-c" aria-label="Copy ${esc(label.toLowerCase())}" title="Copy ${esc(label.toLowerCase())}" onclick="ObsidianCopy('${arg(text)}')">COPY</button>`;
}

/** Toggle one identifier between its short form and the whole value. */
export function toggleIdentifier(node) {
  const root = node?.closest?.('.idv');
  if (!root) return false;
  const open = root.classList.toggle('open');
  node.setAttribute('aria-expanded', open ? 'true' : 'false');
  return open;
}

/**
 * A big balance: the full exact text, wrapped rather than cut, at a size that fits the 430 px frame. The size steps
 * down only as the text gets longer; no digit is ever dropped to make it fit.
 */
export function bigAmountHtml(text, { base = 34, weight = 600, extra = '', title = '' } = {}) {
  const length = String(text ?? '').length;
  const size = length <= 12 ? base : length <= 16 ? Math.round(base * 0.82) : Math.round(base * 0.65);
  const tip = title ? ` title="${esc(title)}"` : '';
  return `<div class="m obsv"${tip} style="font-size:${size}px;font-weight:${weight};${extra}">${esc(text)}</div>`;
}

export const DISPLAY_CSS = `
/* Long values wrap inside their card instead of widening it. A flex child cannot shrink below its content unless it
   is allowed to (min-width:0), which is how one long address pushed a row past the screen. */
.row>b,.row>div{min-width:0;overflow-wrap:anywhere}
.row>b{text-align:right}
.row>span{flex:0 0 auto}
.obsv{overflow-wrap:anywhere;line-height:1.15}
.card,.big{min-width:0;max-width:100%}
.idv{display:inline-flex;align-items:center;flex-wrap:wrap;justify-content:flex-end;gap:4px 8px;max-width:100%;min-width:0;vertical-align:middle}
.idv-t{min-width:0;max-width:100%;overflow-wrap:anywhere;cursor:pointer;border-radius:4px;font-size:12.5px;font-weight:600;letter-spacing:0}
.idv-t:focus-visible{outline:2px solid var(--go);outline-offset:2px}
.idv-f{display:none;word-break:break-all}
.idv.open .idv-s{display:none}.idv.open .idv-f{display:inline}
.idv-c{font:inherit;font-size:10px;font-weight:800;letter-spacing:.1em;padding:6px 10px;min-height:30px;border-radius:99px;border:1px solid var(--bd);background:#fff;color:var(--gd);cursor:pointer}
.idv-c:focus-visible{outline:2px solid var(--go);outline-offset:2px}
.idv-plain{overflow-wrap:anywhere;font-size:12.5px}
`;

let installed = false;
/**
 * Add the few rules above and the one delegated listener that expands a tapped identifier. Idempotent.
 *
 * The toggle is a delegated listener, not an inline handler, so it also works in the browser extension, whose page
 * policy forbids inline handlers (its bridge only forwards a named call with literal text, which is all COPY needs).
 */
export function installDisplayStyles(doc = globalThis.document) {
  if (installed || !doc?.head) return false;
  const style = doc.createElement('style');
  style.setAttribute('data-obs-display', '');
  style.textContent = DISPLAY_CSS;
  doc.head.appendChild(style);
  doc.addEventListener('click', (event) => {
    const node = event.target instanceof Element ? event.target.closest('[data-idv]') : null;
    if (node) toggleIdentifier(node);
  });
  doc.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = event.target instanceof Element ? event.target.closest('[data-idv]') : null;
    if (!node) return;
    event.preventDefault();
    toggleIdentifier(node);
  });
  installed = true;
  return true;
}
