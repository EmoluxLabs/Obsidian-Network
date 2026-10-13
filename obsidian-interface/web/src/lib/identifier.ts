/**
 * One component for every long identifier the interface shows: wallet addresses, transaction ids, block hashes.
 *
 * What the reader sees is shortened (`obs1ijdn...slvgsi`); what the page KNOWS is the full value, which is kept in a
 * closure and never read back from the shortened text. Copy puts exactly the full value on the clipboard. Nothing
 * here changes an identifier that is stored, sent, validated or signed.
 *
 * Width is decided by CSS, not by measuring: below 720 px the short form (8 + 6 characters for an address), at 720 px
 * and above the longer form, and a `detail` identifier shows the whole value at every width, wrapping instead of
 * overflowing. Tapping or pressing Enter on a shortened identifier expands it in place.
 */
import { isMaskedIdentifier, shortenIdentifier, type IdentifierKind } from '../../core/protocol/display.js';
import { el, toast } from './ui.js';

export interface IdentifierOptions {
  kind?: IdentifierKind;
  /** Show the whole value at every width (a detail view, or the one thing a card is about). */
  detail?: boolean;
  /** Show a copy button. Default true. */
  copy?: boolean;
  /** Spoken name of the field. Default derived from the kind. */
  label?: string;
  /** Make the identifier a link (the href carries the FULL value; only the text is shortened). */
  href?: string;
}

const LABELS: Record<IdentifierKind, string> = { address: 'Wallet address', hash: 'Hash', id: 'Identifier' };

/** Puts exactly `full` on the clipboard (never the shortened text) and says so, visibly and to screen readers. */
export async function copyIdentifier(full: string, label: string, live?: HTMLElement): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(full);
  } catch {
    toast('Clipboard access was blocked by the browser', 'error');
    if (live) live.textContent = 'Copy failed';
    return false;
  }
  toast(`${label} copied`, 'success');
  if (live) {
    live.textContent = `${label} copied`;
    window.setTimeout(() => {
      live.textContent = '';
    }, 2500);
  }
  return true;
}

export function identifier(value: string | undefined | null, options: IdentifierOptions = {}): HTMLElement {
  const kind = options.kind ?? 'address';
  const full = typeof value === 'string' ? value : '';
  if (!full) return el('span', { class: 'idv idv-empty' }, '—');
  const label = options.label ?? LABELS[kind];
  const shortText = shortenIdentifier(full, kind, 'narrow');
  const wideText = shortenIdentifier(full, kind, 'wide');
  const shortened = shortText !== full;
  // A value the node already masked is shown as it came and offers nothing to copy: copying it would put a truncated
  // string on the clipboard that looks like an identifier and is not one.
  const masked = isMaskedIdentifier(full);

  const root = el('span', { class: `idv idv-${kind}${options.detail ? ' idv-detail' : ''}`, 'data-kind': kind });
  const text = options.href
    ? el('a', { class: 'idv-text mono link', href: options.href, title: full, 'aria-label': `${label} ${full}` })
    : el('span', { class: 'idv-text mono', title: full });
  text.append(
    el('span', { class: 'idv-s', 'aria-hidden': 'true' }, shortText),
    el('span', { class: 'idv-m', 'aria-hidden': 'true' }, wideText),
    el('span', { class: 'idv-f', 'aria-hidden': 'true' }, full),
  );
  if (shortened && !options.detail && !options.href) {
    // Tap or Enter shows the whole value; again to fold it back.
    text.setAttribute('role', 'button');
    text.setAttribute('tabindex', '0');
    text.setAttribute('aria-expanded', 'false');
    text.setAttribute('aria-label', `${label} ${full}. Activate to show or hide the full value`);
    const toggle = (): void => {
      const open = root.classList.toggle('idv-open');
      text.setAttribute('aria-expanded', String(open));
    };
    text.addEventListener('click', toggle);
    text.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        toggle();
      }
    });
  }
  root.append(text);

  if (options.copy !== false && !masked) {
    const live = el('span', { class: 'sr-only', 'aria-live': 'polite', role: 'status' });
    const button = el(
      'button',
      { class: 'idv-copy', type: 'button', 'aria-label': `Copy ${label.toLowerCase()}`, title: `Copy ${label.toLowerCase()}` },
      'Copy',
    );
    button.addEventListener('click', () => {
      void copyIdentifier(full, label, live).then((ok) => {
        if (!ok) return;
        button.textContent = 'Copied';
        window.setTimeout(() => {
          button.textContent = 'Copy';
        }, 1600);
      });
    });
    root.append(button, live);
  }
  return root;
}
