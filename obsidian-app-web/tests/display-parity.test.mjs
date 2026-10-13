/**
 * The Web App's numbers and identifiers against the shared vectors (tests/vectors/display.json) and against the
 * compiled core formatter. data.mjs carries a plain-JavaScript mirror of core/protocol/display.ts (this page has no
 * bundler); this is what stops the mirror drifting from the source of truth.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as mirror from '../public/data.mjs';
import { identifierHtml, copyButtonHtml, bigAmountHtml, toggleIdentifier, DISPLAY_CSS } from '../public/identifier.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(resolve(here, '../../tests/vectors/display.json'), 'utf8'));
const corePath = resolve(here, '../../obsidian-interface/web/core/protocol/display.js');
const core = existsSync(corePath) ? await import(corePath) : null;

for (const v of vectors.obs) {
  const fn = v.kind === 'decimal' ? mirror.displayDecimal : mirror.displayObs;
  test(`mirror ${v.kind === 'decimal' ? 'decimal' : 'obs'} ${JSON.stringify(v.in)} ${JSON.stringify(v.opts ?? {})} → ${v.out}`, () => {
    assert.equal(fn(v.in, v.opts), v.out);
  });
}
for (const v of vectors.integers) {
  test(`mirror integer ${JSON.stringify(v.in)} → ${v.out}`, () => assert.equal(mirror.displayInteger(v.in), v.out));
}
for (const v of vectors.identifiers) {
  test(`mirror identifier ${v.kind}/${v.width} ${String(v.in).slice(0, 18)} → ${String(v.out).slice(0, 24)}`, () => {
    assert.equal(mirror.shortenIdentifier(v.in, v.kind, v.width), v.out);
  });
}

test('the mirror and the compiled core formatter agree on every vector and on a sweep', { skip: core ? false : 'core display.js not built (run npm run build:web)' }, () => {
  for (const v of vectors.obs) {
    const [m, c] = v.kind === 'decimal' ? [mirror.displayDecimal, core.displayDecimal] : [mirror.displayObs, core.displayObs];
    assert.equal(m(v.in, v.opts), c(v.in, v.opts));
  }
  let seed = 12345n;
  for (let i = 0; i < 2000; i += 1) {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
    const digits = Number(seed % 40n);
    const text = (seed * (10n ** BigInt(digits))).toString();
    for (const opts of [undefined, { maxDecimals: 8 }, { maxDecimals: 0 }, { maxDecimals: 6, group: false }]) {
      assert.equal(mirror.displaySeals(text, opts), core.displaySeals(text, opts), text);
    }
  }
  assert.deepEqual(mirror.IDENTIFIER_POLICY, core.IDENTIFIER_POLICY);
  assert.equal(mirror.UNAVAILABLE, core.UNAVAILABLE);
  assert.equal(mirror.ELLIPSIS, core.ELLIPSIS);
});

test('the required display examples', () => {
  assert.equal(mirror.displayObsWithUnit('0'), '0 OBS');
  assert.equal(mirror.displayObsWithUnit('0.050000000000000000'), '0.05 OBS');
  assert.equal(mirror.displayObsWithUnit('21000000000000000000000000'), '21,000,000 OBS');
  assert.equal(mirror.displayObsWithUnit('100000.000000000000000000'), '100,000 OBS');
  assert.equal(mirror.displayObsWithUnit('1'), '0.000000000000000001 OBS');
  assert.equal(mirror.displayObsWithUnit(undefined), '—');
  assert.equal(mirror.sealsToObs('1'), '0.000000000000000001', 'one seal is not zero');
});

test('no token amount is formatted from a JavaScript number', () => {
  assert.equal(mirror.displayObs(0.05), '—');
  assert.equal(mirror.displayObs(1e-18), '—');
  assert.equal(mirror.displayObs('1e-18'), '—');
});

test('an address is shortened for display and copied in full', () => {
  const address = 'obs1ijdnq8k3m5x7v9c2z4b6n8t0w2e4r6y8slvgsi';
  const html = identifierHtml(address, 'address');
  assert.match(html, />obs1ijdn\.\.\.slvgsi</);
  assert.ok(html.includes(`ObsidianCopy('${address}')`), 'the copy handler carries the full address');
  assert.ok(html.includes(`title="${address}"`));
  assert.ok(html.includes(`aria-label="Wallet address ${address}.`), 'a screen reader is given the whole address');
  assert.ok(html.includes('aria-label="Copy wallet address"'));
  // the shortened text is never what is copied
  assert.ok(!/ObsidianCopy\('[^']*\.\.\./.test(html));
});

test('identifier markup works under the extension bridge: no inline handler other than a plain ObsidianCopy(\'text\') call', () => {
  const html = identifierHtml('obs1ijdnq8k3m5x7v9c2z4b6n8t0w2e4r6y8slvgsi', 'address');
  const handlers = [...html.matchAll(/\son(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(handlers.map(([kind]) => kind), ['click'], 'only COPY carries an inline handler');
  assert.match(handlers[0][1], /^ObsidianCopy\('[A-Za-z0-9._:@-]+'\)$/, 'the shape the bridge accepts: literal quoted text, no this, no escapes');
  assert.ok(html.includes('data-idv'), 'the toggle is delegated, so it needs no handler');
});

test('identifier markup escapes hostile values and cannot break out of the handler', () => {
  const evil = `obs1"><img src=x onerror=alert(1)>'),alert(2),('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const html = identifierHtml(evil, 'address');
  assert.ok(!html.includes('<img'));
  assert.ok(!/onerror=/.test(html.replace(/onerror=alert/g, 'x')) || !html.includes('"><img'));
  assert.ok(!/ObsidianCopy\('[^']*'\)[^"]*alert/.test(html), 'no quote inside the handler argument');
  assert.ok(html.includes('&lt;img'));
});

test('a node-masked value is shown as it came and offers no copy', () => {
  const html = identifierHtml('dobs13s4pg…rs0ff0', 'address');
  assert.ok(html.includes('dobs13s4pg…rs0ff0'));
  assert.ok(!html.includes('ObsidianCopy'));
});

test('a non-interactive identifier (inside a clickable row) has no second tap target', () => {
  const html = identifierHtml('a'.repeat(64), 'hash', { interactive: false, label: 'Transaction id' });
  assert.ok(!html.includes('onclick'));
  assert.ok(html.includes(`aria-label="Transaction id ${'a'.repeat(64)}"`));
});

test('a missing identifier is the unavailable mark; a short one is untouched', () => {
  assert.equal(identifierHtml('', 'address'), '—');
  assert.equal(identifierHtml(undefined, 'hash'), '—');
  assert.ok(identifierHtml('obs1short', 'address').includes('obs1short'));
});

test('copyButtonHtml copies exactly the full value and nothing else', () => {
  const hash = 'b'.repeat(64);
  assert.ok(copyButtonHtml(hash, 'Block id').includes(`ObsidianCopy('${hash}')`));
  assert.equal(copyButtonHtml('', 'Block id'), '');
});

test('a big balance keeps every digit and steps its size down only for long text', () => {
  assert.match(bigAmountHtml('1,234.5'), /font-size:34px/);
  assert.match(bigAmountHtml('0.000166666666666666'), /font-size:22px/);
  assert.ok(bigAmountHtml('0.000166666666666666').includes('0.000166666666666666'));
});

test('toggleIdentifier flips the open state and the aria-expanded flag', () => {
  const classes = new Set();
  const attrs = {};
  const root = { classList: { toggle: (c) => (classes.has(c) ? (classes.delete(c), false) : (classes.add(c), true)) } };
  const node = { closest: () => root, setAttribute: (k, v) => { attrs[k] = v; } };
  assert.equal(toggleIdentifier(node), true);
  assert.equal(attrs['aria-expanded'], 'true');
  assert.equal(toggleIdentifier(node), false);
  assert.equal(attrs['aria-expanded'], 'false');
});

test('the injected rules let long values wrap inside their card', () => {
  assert.match(DISPLAY_CSS, /\.row>b,\.row>div\{min-width:0;overflow-wrap:anywhere\}/);
});

// ── regression guards: nothing prints a node amount by hand, and nothing hand-shortens an identifier ──────────────

const publicDir = resolve(here, '../public');
const shipped = ['screens.mjs', 'explorer.mjs', 'real.mjs'].map((f) => [f, readFileSync(resolve(publicDir, f), 'utf8')]);

for (const [name, source] of shipped) {
  test(`${name}: no toLocaleString() on a number and no raw "\${…} OBS" interpolation`, () => {
    const lines = source.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l));
    assert.deepEqual(lines.filter((l) => /\.toLocaleString\(/.test(l) && !/new Date|Date\(/.test(l)), []);
    assert.deepEqual(lines.filter((l) => /\$\{[^}]*\}\s*OBS/.test(l) && !/displayObs|sealsToObs/.test(l)), []);
  });
  test(`${name}: no hand-made ellipsis shortening of an identifier`, () => {
    assert.doesNotMatch(source, /\.slice\(0,\s*\d+\)\}?…\$\{/);
    assert.doesNotMatch(source, /\.slice\(0,\s*\d+\)\s*\}…/);
  });
}
