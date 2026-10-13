/**
 * Regression guards for the two things that went wrong on screen: amounts printed by hand, and long values that were
 * allowed to widen the page. These read the source, so a new page that bypasses the shared formatter or the shared
 * identifier component fails here instead of on a phone.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = resolve(__dirname, '../web/src');
const files = ['pages', 'lib'].flatMap((dir) => readdirSync(join(src, dir)).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)));
const read = (f: string): string => readFileSync(join(src, f), 'utf8');
const css = readFileSync(resolve(__dirname, '../public/css/obsidian.css'), 'utf8');

describe('no amount or count is formatted by hand', () => {
  for (const file of files) {
    const lines = read(file).split('\n');
    it(`${file} has no toLocaleString() on a number and no toFixed() on a token amount`, () => {
      const bad = lines
        .map((text, index) => ({ text, line: index + 1 }))
        .filter(({ text }) => !/^\s*(\/\/|\*)/.test(text))
        .filter(({ text }) => /\.toLocaleString\(/.test(text) && !/new Date|Date\(/.test(text));
      expect(bad).toEqual([]);
      const amounts = lines.filter((text) => /toFixed\(/.test(text) && /(Obs|obs|seals|Seals|balance|reward)/.test(text) && !/Bps|bps|Math|pct|percent|blocksPerMinute|PerMinute|Spacing/.test(text));
      expect(amounts).toEqual([]);
    });
    it(`${file} never prints a raw node amount followed by OBS`, () => {
      const bad = lines.filter((text) => /\$\{[^}]*Obs[^}]*\}\s*OBS/.test(text) && !/obsUnit|obs\(|displayObs|formatObs|\bOBS\b.*—/.test(text));
      expect(bad).toEqual([]);
    });
  }
});

describe('identifiers go through the shared component', () => {
  for (const file of files.filter((f) => f.startsWith('pages'))) {
    it(`${file} does not hand-shorten an address, hash or id`, () => {
      const text = read(file);
      expect(text).not.toMatch(/\.slice\(0,\s*\d+\)\s*\}?…/);
      expect(text).not.toMatch(/\bshort\(\s*(?:String\()?(?:tx|block|record|status|state|claim|entry|node)\b[^)]*\)/);
    });
  }
});

describe('layout: long values wrap inside their card', () => {
  it('flex and grid children may shrink below their content', () => {
    expect(css).toMatch(/\.kv > \*[^{]*\{ min-width: 0; \}/);
  });
  it('the shared identifier styles exist: short on phones, longer from 720px, whole value on demand', () => {
    expect(css).toMatch(/\.idv-m, \.idv-f \{ display: none; \}/);
    expect(css).toMatch(/@media \(min-width: 720px\) \{\s*\.idv-s \{ display: none; \}\s*\.idv-m \{ display: inline; \}/);
    expect(css).toMatch(/\.idv-open \.idv-f/);
  });
  it('the body still has no horizontal scroll', () => {
    expect(css).toMatch(/html, body \{ max-width: 100%; overflow-x: hidden; \}/);
  });
  it('a screen-reader-only class exists for visually hidden labels', () => {
    expect(css).toMatch(/\.sr-only \{ position: absolute;/);
  });
});
