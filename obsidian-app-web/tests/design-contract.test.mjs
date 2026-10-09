/**
 * The contract between this app and the design file it does not edit.
 *
 * public/index.html is a 250 KB single-file design: its CSS, its screens and a
 * classic inline script that renders them. This app is built to leave that file
 * byte-for-byte alone and replace only behaviour. That promise rests on a detail of
 * the language, and the app broke against it once:
 *
 *   `function render(){}`  -> a property of the global object, replaceable.
 *   `const V = {}`         -> the global LEXICAL environment: readable from a module
 *                             by bare name, not writable, and NOT on `window`.
 *
 * The first version of real.mjs opened with `if (!window.V) return;`. `window.V`
 * was always undefined, the guard always fired, and the app installed nothing —
 * while the page rendered perfectly and every number on it was the demo's. The
 * failure was invisible, which is what makes it worth a test.
 *
 * So this file asserts the three things that must stay true:
 *   1. the levers the app replaces are function declarations, on the global object;
 *   2. the helpers the screens read are top-level bindings that exist at all;
 *   3. every handler a screen's markup calls is actually installed by real.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appWeb = resolve(here, '..');
const publicDir = join(appWeb, 'public');

const html = readFileSync(join(publicDir, 'index.html'), 'utf8');

/**
 * Source with its comments removed.
 *
 * This file's own docstrings quote the very identifiers it forbids — `window.V`,
 * `addr()` — because explaining a bug means naming it. The rules below are about
 * code, so they are applied to code.
 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const real = withoutComments(readFileSync(join(publicDir, 'real.mjs'), 'utf8'));
const screens = withoutComments(readFileSync(join(publicDir, 'screens.mjs'), 'utf8'));

/** The first inline classic script: everything between `<script>` and `</script>`. */
function inlineScript() {
  const start = html.indexOf('<script>');
  const end = html.indexOf('</script>', start);
  assert.notEqual(start, -1, 'index.html has an inline script');
  assert.notEqual(end, -1, 'the inline script is closed');
  return html.slice(start + '<script>'.length, end);
}

const script = inlineScript();

/** The design's own helpers, as screens.mjs reads them: by bare name. */
const DESIGN_HELPERS = ['hdr', 'nav', 'fld', 'back', 'logo'];

test('the design file is still a single self-contained file with an inline script', () => {
  assert.match(html, /<style>/);
  assert.match(html, /<div id="app"><\/div>/);
  assert.equal((html.match(/<script/g) ?? []).length, 2, 'the design script plus the real module');
  assert.match(html, /<script type="module" src="\/real\.mjs"><\/script>/);
});

test('the levers the app replaces are function declarations, on the global object', () => {
  // Only a function declaration (or a `var`) becomes a property of globalThis.
  // These three are what real.mjs assigns to, so they must stay declared this way.
  for (const name of ['render', 'go']) {
    assert.match(script, new RegExp(`function\\s+${name}\\s*\\(`), `${name}() must be a function declaration`);
  }
});

test('the helpers screens.mjs reads exist as top-level bindings in the design', () => {
  // They are `const` arrows, therefore NOT on window. screens.mjs can only reach
  // them because a module resolves free variables through the global lexical
  // environment. If one is renamed here, the screen silently degrades to a
  // fallback; this test makes that a failure instead.
  for (const name of DESIGN_HELPERS) {
    assert.match(script, new RegExp(`\\b${name}\\s*=`), `the design must still declare ${name}`);
  }
  assert.match(script, /\bV\s*=/, 'the design must still declare the screen table V');
  assert.match(script, /\bS\s*=/, 'the design must still declare the state object S');
});

test('nothing in this app gates on a design binding being on window', () => {
  // The regression, pinned. `window.V` / `g.V` is always undefined because V is a
  // top-level `const` in a classic script, so a guard on it disables the app.
  for (const [file, source] of [['real.mjs', real], ['screens.mjs', screens]]) {
    assert.doesNotMatch(source, /\b(?:window|g)\.V\b/, `${file} must not read V off window`);
    assert.doesNotMatch(source, /\b(?:window|g)\.hdr\b/, `${file} must not read hdr off window`);
    assert.doesNotMatch(source, /\b(?:window|g)\.nav\b/, `${file} must not read nav off window`);
  }
});

test('the app never calls the design’s fabricated behaviours', () => {
  // addr() synthesised an address from the email; ht() faked a height from
  // Date.now(); claim() credited RATE*4 with no transaction. Every one of them is
  // unreachable from a screen this module renders, and that must stay true.
  for (const name of ['addr', 'ht']) {
    assert.doesNotMatch(screens, new RegExp(`(?<!['"\\w.])${name}\\s*\\(`), `screens.mjs must not call ${name}()`);
  }
  for (const source of [real, screens]) {
    assert.doesNotMatch(source, /\bTAKEN\b/, 'the design’s hardcoded name list must not be used');
    assert.doesNotMatch(source, /\bPRICE\b/, 'the design’s invented name price must not be used');
    assert.doesNotMatch(source, /\bRATE\b/, 'the design’s invented mining rate must not be used');
    assert.doesNotMatch(source, /\bSESS\b/, 'the design’s hardcoded session length must not be used');
    assert.doesNotMatch(source, /\bVALID\b/, 'the design’s hardcoded invite list must not be used');
    // `FEE` is deliberately not banned: it is ordinary English in a screen label
    // ("REGISTRATION FEE"), and the number behind it is read from /params.
  }
});

test('the Edge Node screen is not reachable', () => {
  assert.match(script, /\bnode:\s*\(\)/, 'the design still ships a node screen');
  assert.doesNotMatch(screens, /\bnode:\s*\(/, 'screens.mjs must not define one');
  assert.equal(/SCREENS\s*=\s*\{[\s\S]*?\n\};/.test(screens), true);
  const table = screens.match(/export const SCREENS = \{([\s\S]*?)\n\};/)[1];
  assert.doesNotMatch(table, /\bnode:/, 'the screen table has no node entry');
});

test('every handler a screen calls is installed by real.mjs', () => {
  // A button wired to a function nobody assigned is a dead button that looks
  // live. This catches exactly that, for every module that emits markup.
  const sources = readdirSync(publicDir)
    .filter((file) => file.endsWith('.mjs'))
    .map((file) => [file, withoutComments(readFileSync(join(publicDir, file), 'utf8'))]);

  const called = new Set();
  for (const [, source] of sources) {
    for (const match of source.matchAll(/on\w+="\s*(Obsidian[A-Za-z]+)\s*\(/g)) {
      called.add(match[1]);
    }
  }
  assert.ok(called.size > 5, `expected the screens to wire up handlers, found ${called.size}`);

  for (const name of called) {
    assert.match(
      real,
      new RegExp(`g\\.${name}\\s*=`),
      `${name} is called from markup but real.mjs never installs it`,
    );
  }
});

test('the demo behaviours that remain reachable are replaced with refusals', () => {
  // The design's markup never reaches a screen this app renders, but its inline
  // onclicks name these, and a future edit could resurrect one.
  for (const name of ['claim', 'send', 'buy', 'startM', 'onsq']) {
    assert.match(real, new RegExp(`g\\.${name}\\s*=`), `${name}() must be overridden`);
  }
});

test('the bundle is generated output, and web/ is its only source', () => {
  // public/js used to hold hand-written copies of web/vault.mjs and
  // web/claim.mjs that had already drifted from them. One source, one bundle.
  const jsDir = join(publicDir, 'js');
  if (existsSync(jsDir)) {
    // Empty is fine: the bundle is generated and gitignored, so a fresh clone has
    // nothing here until `npm run build:web` runs. Anything else is drift.
    const files = readdirSync(jsDir).filter((file) => file !== '.gitkeep');
    for (const file of files) {
      assert.equal(file, 'obsidian.js', `public/js should hold only the bundle, found: ${file}`);
    }
  }
  assert.equal(existsSync(join(appWeb, 'web/vault.mjs')), true);
  assert.equal(existsSync(join(appWeb, 'web/ops.mjs')), true);
  assert.equal(existsSync(join(appWeb, 'web/index.mjs')), true);
});

test('the address cache key agrees between the app and the bundle', () => {
  // wallet.mjs reads localStorage directly so the wallet screen can paint without
  // downloading the crypto bundle; web/vault.mjs owns the key. Two string literals
  // in two files, one name — so they are pinned to each other here.
  const walletSource = withoutComments(readFileSync(join(publicDir, 'wallet.mjs'), 'utf8'));
  const vaultSource = withoutComments(readFileSync(join(appWeb, 'web/vault.mjs'), 'utf8'));
  const fromWallet = walletSource.match(/const ADDRESS_KEY = '([^']+)'/)[1];
  const fromVault = vaultSource.match(/const ADDRESS_KEY = '([^']+)'/)[1];
  assert.equal(fromWallet, fromVault);
  assert.equal(fromWallet, 'obsidian.address');
});
