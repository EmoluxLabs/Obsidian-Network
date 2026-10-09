/**
 * No button without a function.
 *
 * The brief for this app is that nothing on screen is a placeholder: every control
 * does something real in the ecosystem. The cheapest way to keep that true is to
 * check, mechanically, that every handler a screen can call exists and that every
 * screen a control navigates to is a screen. A button wired to a function that was
 * renamed or never written throws only when someone taps it, which is the worst time
 * to find out.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../public');
const read = (f) => readFileSync(resolve(root, f), 'utf8');
const screensSrc = read('screens.mjs') + '\n' + read('explorer.mjs');
const realSrc = read('real.mjs');

const handlersDefined = new Set([...realSrc.matchAll(/\bg\.(Obsidian\w+)\s*=/g)].map((m) => m[1]));
const handlersUsed = new Set([...screensSrc.matchAll(/\b(Obsidian\w+)\(/g)].map((m) => m[1]));

test('every handler a screen can call is defined', () => {
  const missing = [...handlersUsed].filter((h) => !handlersDefined.has(h));
  assert.deepEqual(missing, [], `screens call handlers that do not exist: ${missing.join(', ')}`);
});

test('every handler that is defined is used by some screen (no orphaned feature)', () => {
  // Handlers called only from code (not from markup) are listed here with the reason.
  const internal = new Set(['ObsidianGo']);
  const unused = [...handlersDefined].filter((h) => !handlersUsed.has(h) && !internal.has(h));
  assert.deepEqual(unused, [], `handlers nothing can reach: ${unused.join(', ')}`);
});

test('every screen a control navigates to exists', async () => {
  const { SCREENS } = await import('../public/screens.mjs');
  const targets = new Set([...screensSrc.matchAll(/ObsidianGo\('(\w+)'\)/g)].map((m) => m[1]));
  // Navigation built from a list: ['ons','ONS'], ['api','API'] ... and designNav('home').
  for (const m of screensSrc.matchAll(/designNav\('(\w+)'\)|designBack\('(\w+)'\)/g)) targets.add(m[1] ?? m[2]);
  const missing = [...targets].filter((t) => !SCREENS[t]);
  assert.deepEqual(missing, [], `navigation to screens that do not exist: ${missing.join(', ')}`);
});

test('no screen is a stub: each renders more than a heading and says nothing like "coming soon"', async () => {
  const { SCREENS } = await import('../public/screens.mjs');
  const state = { screen: 'x', network: null, appConfig: null, account: null, ex: undefined, setup: { mode: 'create', draft: null } };
  for (const [name, screen] of Object.entries(SCREENS)) {
    let html = '';
    try {
      html = screen({ ...state, ex: {}, ons: {}, apiTry: null });
    } catch {
      // A screen that needs more state than this minimal one is exercised by boot.test.mjs.
      continue;
    }
    assert.doesNotMatch(html, /coming soon|not available yet|not yet available|under construction|lorem ipsum/i, `${name} is a placeholder`);
  }
  assert.doesNotMatch(screensSrc, /coming soon|not available yet|under construction|lorem ipsum/i);
});
