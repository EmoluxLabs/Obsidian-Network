import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// bridge.js is a classic browser script; run it with no document so only the exported parser is installed.
globalThis.document = undefined;
(0, eval)(fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8'));
const parse = globalThis.__obsidianBridgeParse;

test('every onclick the web app produces parses to the call it spells', () => {
  assert.deepEqual(parse("ObsidianGo('signup')"), { name: 'ObsidianGo', args: ['signup'] });
  assert.deepEqual(parse('ObsidianToggleMenu()'), { name: 'ObsidianToggleMenu', args: [] });
  assert.deepEqual(parse("ObsidianExOpen('tx','8a1016dbd2')"), { name: 'ObsidianExOpen', args: ['tx', '8a1016dbd2'] });
  assert.deepEqual(parse(" ObsidianCopy( 'dobs1abc' ) ; "), { name: 'ObsidianCopy', args: ['dobs1abc'] });
});

test('it is a call parser, not an evaluator: nothing else is accepted', () => {
  for (const hostile of [
    "alert(1)", "ObsidianGo('x');alert(1)", "ObsidianGo('x'),alert(1)", "ObsidianGo(1)", "ObsidianGo(a)", "ObsidianGo('a'+'b')",
    "ObsidianGo(`x`)", 'ObsidianGo("x")', "ObsidianGo('a',)", "ObsidianGo('a\\'); alert(1); ('')", "ObsidianGo('a\nb')", "window.ObsidianGo('x')",
    "ObsidianGo('x').constructor('alert(1)')()", "Obsidian('x')", "obsidianGo('x')", "ObsidianGo['constructor']('x')", "ObsidianGo('x')//", 'javascript:alert(1)', '',
    "ObsidianGo('" + 'a'.repeat(500) + "')", null, undefined, 42,
  ]) {
    assert.equal(parse(hostile), null, JSON.stringify(hostile));
  }
});

test('it can only name Obsidian globals, never an arbitrary function', () => {
  for (const name of ['eval', 'Function', 'fetch', 'setTimeout', 'chrome']) assert.equal(parse(`${name}('x')`), null);
});

test('the script contains no eval and no Function constructor', () => {
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\beval\b|new Function|Function\(|setTimeout\(\s*['"`]/.test(src));
});
