// @vitest-environment jsdom
/**
 * The masthead on a phone, and the light mobile-first stylesheet.
 *
 * Two-line navigation links used to render inline at every width. On a phone
 * they wrapped into rows and filled the viewport, so the page was only
 * reachable by switching the browser to desktop view. The links are now a
 * drawer behind a menu button, and the landing page shows exactly three doors:
 * Start Mining, Create Wallet, Explorer.
 *
 * The stylesheet is mobile-first and light: every rule outside a media query is
 * the phone layout, the `min-width` queries only add room, and the palette is a
 * white page with dark ink rather than the old near-black one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../public/css/obsidian.css'), 'utf8');

async function render(current: string): Promise<void> {
  document.body.innerHTML = '<div id="app"></div>';
  vi.resetModules();
  const { layout } = await import('../web/src/lib/shell.js');
  layout({ current, title: 'Test', tagline: 'Tagline', children: [] });
}

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
});

describe('the landing page offers three doors, not a directory', () => {
  it('adds no navigation of its own to the masthead', async () => {
    // The three doors belong to the hero, which the landing page renders.
    // The masthead must not duplicate them: brand, node strip, menu button.
    await render('landing');
    const header = document.querySelector('.masthead')!;
    expect(header.querySelectorAll('a.cta').length).toBe(0);
    expect(header.querySelector('.quick-nav')).toBeNull();
    expect([...header.querySelectorAll('.nav-toggle')].length).toBe(1);
  });

  it('ships exactly three calls to action in the landing source', () => {
    const page = readFileSync(resolve(here, '../web/src/pages/landing.ts'), 'utf8');
    const row = page.slice(page.indexOf("class: 'cta-row'"), page.indexOf("class: 'cta-row'") + 400);
    const labels = [...row.matchAll(/cta\('([^']+)', '([^']+)'/g)].map((m) => [m[2], m[1]]);
    expect(labels).toEqual([
      ['Start Mining', '/mine/'],
      ['Create Wallet', '/wallet/'],
      ['Explorer', '/explorer/'],
    ]);
  });

  it('keeps every other product behind the menu button', async () => {
    await render('landing');
    const header = document.querySelector('.masthead')!;
    expect(header.classList.contains('landing')).toBe(true);
    expect(document.querySelector('.nav-toggle')).not.toBeNull();

    // The full list still exists for the drawer — it is not deleted, just not
    // on display until asked for.
    const navLinks = [...document.querySelectorAll('#site-nav .nav-link')].map((a) => a.getAttribute('href'));
    expect(navLinks).toContain('/ons/');
    expect(navLinks).toContain('/node/');
    expect(navLinks.length).toBeGreaterThanOrEqual(7);
    // The discontinued products are not merely hidden: they are gone.
    for (const retired of ['/circle/', '/social/', '/capsule/']) expect(navLinks).not.toContain(retired);

    // And CSS hides it at every width, on every page, until `menu-open`.
    expect(css).toMatch(/\.masthead \.nav \{ display: none; \}/);
    expect(css).toMatch(/\.masthead\.menu-open \.nav \{/);
  });
});

describe('the menu button', () => {
  it('opens and closes, and reports its state to assistive tech', async () => {
    await render('landing');
    const header = document.querySelector('.masthead')!;
    const toggle = document.querySelector<HTMLButtonElement>('.nav-toggle')!;

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('site-nav');
    expect(document.getElementById('site-nav')).not.toBeNull();
    expect(header.classList.contains('menu-open')).toBe(false);

    toggle.click();
    expect(header.classList.contains('menu-open')).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Close menu');

    toggle.click();
    expect(header.classList.contains('menu-open')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes when a destination is chosen', async () => {
    await render('landing');
    const header = document.querySelector('.masthead')!;
    document.querySelector<HTMLButtonElement>('.nav-toggle')!.click();
    expect(header.classList.contains('menu-open')).toBe(true);

    document.querySelector<HTMLAnchorElement>('#site-nav .nav-link')!.click();
    expect(header.classList.contains('menu-open')).toBe(false);
  });

  it('closes on Escape', async () => {
    await render('landing');
    const header = document.querySelector('.masthead')!;
    document.querySelector<HTMLButtonElement>('.nav-toggle')!.click();
    expect(header.classList.contains('menu-open')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(header.classList.contains('menu-open')).toBe(false);
  });
});

describe('inner pages', () => {
  it('carry the full navigation inside the same drawer', async () => {
    await render('mine');
    const header = document.querySelector('.masthead')!;
    expect(header.classList.contains('landing')).toBe(false);
    expect(document.querySelector('.quick-nav')).toBeNull();
    expect(document.querySelector('.nav-toggle')).not.toBeNull();
    expect(document.querySelectorAll('#site-nav .nav-link').length).toBeGreaterThanOrEqual(7);
    expect(document.querySelector('#site-nav .nav-link.active')?.getAttribute('href')).toBe('/mine/');
  });
});

describe('the page fits the screen', () => {
  it('never lets anything be wider than the viewport', () => {
    // One unbroken hash or a wide table used to widen the document itself, and
    // a document wider than the screen has to be panned around to read.
    expect(css).toMatch(/html, body \{ max-width: 100%; overflow-x: hidden; \}/);
    expect(css).toMatch(/img, svg, video, canvas, table, pre \{ max-width: 100%; \}/);
    expect(css).toMatch(/\.mono, code, \.hash, \.address \{ overflow-wrap: anywhere; \}/);
  });

  it('stops pinning the masthead on a phone', () => {
    // A sticky header reserves a fixed slice of a short screen. With the old
    // ten-link navigation that slice was the whole viewport, which is why the
    // site could only be read in desktop view.
    expect(css).toMatch(/position: sticky;/);                       // still sticky on desktop
    expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.masthead \{ position: static; \}/);
  });

  it('lets an opened drawer scroll instead of growing without end', () => {
    // The drawer scrolls at every width, so a long list can never take the page.
    expect(css).toMatch(/\.masthead\.menu-open \.nav \{[\s\S]*?max-height: 60vh;[\s\S]*?overflow-y: auto;/);
  });

  it('is a light theme, declared in the stylesheet and in the generated shells', () => {
    expect(css).toMatch(/color-scheme: light;/);
    // The page surface is a near-white paper, not the old volcanic black.
    expect(css).toMatch(/--paper: #f6f7f9;/);
    expect(css).toMatch(/--surface: #ffffff;/);
    expect(css).toMatch(/background: var\(--paper\);/);
    // Inputs stay at 16px so a phone browser does not zoom the page on focus.
    expect(css).toMatch(/input, textarea, select \{[\s\S]*?font-size: 1rem;/);
  });

  it('is written mobile-first: the phone layout is the base, room is added by min-width queries', () => {
    // The only max-width query left is the one that unsticks the masthead.
    const maxWidthQueries = [...css.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => m[1]);
    expect(maxWidthQueries).toEqual(['720']);
    expect(css).toMatch(/@media \(min-width: 560px\) \{/);
    // The base grid is one column; the wider grid arrives in the query.
    expect(css).toMatch(/\n\.pillars \{ display: grid; grid-template-columns: 1fr; gap: 12px; \}/);
    expect(css).toMatch(/@media \(min-width: 560px\) \{[\s\S]*?\.pillars \{ grid-template-columns: repeat\(auto-fit, minmax\(260px, 1fr\)\); \}/);
  });

  it('declares a responsive viewport in every generated shell', () => {
    const sites = ['landing', 'mine', 'wallet', 'explorer', 'ons', 'node', 'audit', 'developer', 'app'];
    for (const site of sites) {
      const shell = resolve(here, '../..', site, 'index.html');
      if (!existsSync(shell)) continue;
      const markup = readFileSync(shell, 'utf8');
      expect(markup, site).toContain('width=device-width, initial-scale=1');
      expect(markup, site).toContain('<meta name="color-scheme" content="light">');
    }
  });
});

describe('the phone layout itself', () => {
  it('keeps the navigation behind the button at every width, with touch-sized targets', () => {
    // Not inside a media query: there must be no viewport width at which the
    // link bar renders inline and takes the screen back.
    expect(css).toMatch(/\n\.masthead \.nav \{ display: none; \}/);
    expect(css).toMatch(/\n\.nav-toggle \{[\s\S]*?display: inline-flex;/);
    // Touch targets large enough to hit: the menu button, the calls to action,
    // the drawer links and every button.
    expect(css).toMatch(/\.nav-toggle \{[\s\S]*?min-height: 44px;/);
    expect(css).toMatch(/\.cta \{[\s\S]*?min-height: 48px;/);
    expect(css).toMatch(/\.masthead\.menu-open \.nav-link \{ flex-direction: row;[\s\S]*?min-height: 44px;/);
    expect(css).toMatch(/button, \.as-link \{[\s\S]*?min-height: 44px;/);
  });
});
