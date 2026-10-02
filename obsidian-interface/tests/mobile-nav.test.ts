// @vitest-environment jsdom
/**
 * The masthead on a phone.
 *
 * Ten two-line navigation links were rendered inline at every width. On a
 * phone they wrapped into ten rows and filled the viewport, so the page was
 * only reachable by switching the browser to desktop view. The links are now
 * a drawer behind a menu button, and the landing page shows exactly three
 * doors: Start Mining, Create Wallet, Explorer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
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
    expect(navLinks).toContain('/circle/');
    expect(navLinks).toContain('/social/');
    expect(navLinks.length).toBeGreaterThanOrEqual(10);

    // And CSS hides it on the landing page at every width until `menu-open`.
    expect(css).toMatch(/\.masthead\.landing \.nav \{\s*display: none;/);
    expect(css).toMatch(/\.masthead\.landing\.menu-open \.nav \{/);
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
  it('still carry the full navigation, plus the button for narrow screens', async () => {
    await render('mine');
    const header = document.querySelector('.masthead')!;
    expect(header.classList.contains('landing')).toBe(false);
    expect(document.querySelector('.quick-nav')).toBeNull();
    expect(document.querySelector('.nav-toggle')).not.toBeNull();
    expect(document.querySelectorAll('#site-nav .nav-link').length).toBeGreaterThanOrEqual(10);
    expect(document.querySelector('#site-nav .nav-link.active')?.getAttribute('href')).toBe('/mine/');
  });
});

describe('the phone layout itself', () => {
  it('collapses the navigation below 900px and shrinks the masthead below 720px', () => {
    expect(css).toMatch(/@media \(max-width: 900px\) \{[\s\S]*?\.nav-toggle \{ display: inline-flex; \}/);
    expect(css).toMatch(/@media \(max-width: 900px\) \{[\s\S]*?\.masthead \.nav \{ display: none; \}/);
    // Touch targets large enough to hit.
    expect(css).toMatch(/\.nav-toggle \{[\s\S]*?min-height: 44px;/);
    expect(css).toMatch(/\.cta \{ min-height: 44px;/);
    // On a phone the hero's three doors go full width rather than squeezing.
    expect(css).toMatch(/@media \(max-width: 720px\) \{[\s\S]*?\.cta-row \.cta \{ flex: 1 1 100%;/);
  });
});
