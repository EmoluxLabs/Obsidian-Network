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

/*
 * The landing page's three doors — Start Mining, Create Wallet, Explorer —
 * are rendered by the page itself, in the hero. The masthead deliberately
 * adds nothing next to them: on the landing page it is a brand, a node strip
 * and a menu button, so the first thing a visitor sees is what this is rather
 * than a directory of ten products.
 */

export function layout(options: { current: string; title: string; tagline: string; children: Child[] }): void {
  const isLanding = options.current === 'landing';

  const nav = el(
    'nav',
    { class: 'nav', id: 'site-nav', 'aria-label': 'All products' },
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

  // The ten-link navigation used to be rendered inline on every screen width.
  // On a phone it wrapped into ten two-line rows and filled the viewport, so
  // the page itself was below the fold until you asked for desktop view. It is
  // now a drawer: always behind this button on the landing page, and behind it
  // on narrow screens everywhere else.
  const navToggle = el(
    'button',
    {
      type: 'button',
      class: 'nav-toggle',
      id: 'nav-toggle',
      'aria-expanded': 'false',
      'aria-controls': 'site-nav',
      'aria-label': 'Open menu',
    },
    el('span', { class: 'nav-toggle-bars', 'aria-hidden': 'true' }),
    el('span', { class: 'nav-toggle-text' }, 'Menu'),
  );



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
      el('div', { class: 'masthead-actions' }, accountSlot, navToggle),
    ),
    banner,
    nav,
  );
  header.classList.add('masthead');
  if (isLanding) header.classList.add('landing');

  // No inline script anywhere: the CSP is `script-src 'self'` and that promise
  // is only worth something if the markup never needs relaxing.
  const setOpen = (open: boolean): void => {
    header.classList.toggle('menu-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  };
  navToggle.addEventListener('click', () => setOpen(!header.classList.contains('menu-open')));
  nav.addEventListener('click', (event) => {
    if ((event.target as HTMLElement).closest('a')) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && header.classList.contains('menu-open')) {
      setOpen(false);
      navToggle.focus();
    }
  });

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
