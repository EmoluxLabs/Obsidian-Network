/** Shared page shell: masthead, navigation, node status strip, footer. */

import { el, mount, type Child } from './ui.js';
import { renderNodeBanner } from './node-banner.js';
import { session, type AccountView } from './session.js';

export interface Site {
  id: string;
  href: string;
  label: string;
  blurb: string;
}

export const SITES: Site[] = [
  { id: 'mine', href: '/mine/', label: 'Mine', blurb: 'Protocol mining' },
  { id: 'wallet', href: '/wallet/', label: 'Wallet', blurb: 'Non-custodial keys' },
  { id: 'explorer', href: '/explorer/', label: 'Explorer', blurb: 'Chain data' },
  { id: 'ons', href: '/ons/', label: 'ONS', blurb: '.obs names' },
  { id: 'circle', href: '/circle/', label: 'Circle', blurb: 'Land registry' },
  { id: 'capsule', href: '/capsule/', label: 'Capsules', blurb: 'Time locks' },
  { id: 'social', href: '/social/', label: 'Social', blurb: 'OBS Social' },
  { id: 'node', href: '/node/', label: 'Node runners', blurb: 'Rewards & registry' },
  { id: 'developer', href: '/developer/', label: 'Developers', blurb: 'Build on OBS' },
  { id: 'app', href: '/app/', label: 'Account', blurb: 'Invites & nodes' },
];

export function layout(options: { current: string; title: string; tagline: string; children: Child[] }): void {
  const nav = el(
    'nav',
    { class: 'nav' },
    ...SITES.map((site) =>
      el(
        'a',
        { href: site.href, class: site.id === options.current ? 'nav-link active' : 'nav-link' },
        el('span', { class: 'nav-label' }, site.label),
        el('span', { class: 'nav-blurb' }, site.blurb),
      ),
    ),
  );

  const banner = el('div', { class: 'node-strip', id: 'node-strip' }, el('span', { class: 'muted' }, 'contacting nodes…'));
  const accountSlot = el('div', { class: 'account-slot', id: 'account-slot' });

  const header = el(
    'header',
    { class: 'masthead' },
    el(
      'div',
      { class: 'masthead-inner' },
      el(
        'a',
        { class: 'brand', href: '/' },
        // The official OBS coin. Served from /assets so the same file backs the
        // favicon, the manifest icons and every static site shell.
        el('img', {
          class: 'brand-mark',
          src: '/assets/logo.svg',
          width: '34',
          height: '34',
          alt: '',
          'aria-hidden': 'true',
          decoding: 'async',
        }),
        el(
          'span',
          {},
          el('strong', {}, 'OBSIDIAN'),
          el('em', {}, 'NETWORK'),
        ),
      ),
      el('div', { class: 'headline' }, el('h1', {}, options.title), el('p', {}, options.tagline)),
      accountSlot,
    ),
    banner,
    nav,
  );

  const main = el('main', { class: 'page' }, ...options.children);
  const footer = el(
    'footer',
    { class: 'footer' },
    el(
      'div',
      {},
      el('p', {}, 'Obsidian Network — a Proof of Time (PoT) chain with a hard cap of 21,000,000 OBS.'),
      el(
        'p',
        { class: 'muted' },
        'Every number on this page is read from Obsidian Core nodes. Cloudflare, this website and your browser are caches: none of them can create, move or decide.',
      ),
    ),
    el(
      'div',
      { class: 'footer-links' },
      el('a', { href: '/developer/' }, 'Node software & releases'),
      el('a', { href: '/explorer/' }, 'Explorer'),
      el('a', { href: '/audit/' }, 'Compliance audit'),
      el('a', { href: '/node/' }, 'Node runner rewards'),
    ),
  );

  mount(header, main, footer);
  void renderNodeBanner(banner);
  void renderAccount(accountSlot);
}

async function renderAccount(slot: HTMLElement): Promise<void> {
  const account = await session.current();
  drawAccount(slot, account);
}

function drawAccount(slot: HTMLElement, account: AccountView | undefined): void {
  slot.replaceChildren();
  if (!account) {
    const link = el('a', { class: 'pill-link', href: '/app/' }, 'Sign in');
    slot.append(link);
    return;
  }
  const initials = (account.displayName ?? account.email).slice(0, 2).toUpperCase();
  slot.append(
    el('a', { class: 'pill-link', href: '/app/', title: account.email }, el('span', { class: 'avatar' }, initials), 'Account'),
    el(
      'span',
      { class: 'pill muted', title: `${account.invitesIssued} invites issued` },
      `${account.invitesIssued}/5 invites`,
    ),
  );
}

/** Fetch JSON from the interface, surfacing the node's own error text. */
export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`);
  return body as T;
}
