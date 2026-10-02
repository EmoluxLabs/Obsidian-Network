import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = resolve(here, '../web/src/pages');
const libDir = resolve(here, '../web/src/lib');
const repo = resolve(here, '../..');

/**
 * Protocol fees are denominated in OBS and no consensus path consults a price
 * source. The product copy kept saying otherwise long after that stopped being
 * true: the landing page listed "oracle prices" as platform state, the
 * developer page documented dollar-priced features converting "through the
 * protocol price", the ONS page closed registration when an oracle it no
 * longer needed was unusable, and Obsidian Circle advertised land at
 * "$100 to $30,000 per m²" when the real band is 0.01–5 OBS.
 *
 * Prose is not covered by any type and no fixture can catch it, so it is
 * covered here. This reads the page sources — the strings a user is shown —
 * not the bundles, whose vendored JSDoc legitimately discusses the oracle
 * transaction type that still exists in the protocol.
 */
function prose(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // block comments
    .replace(/^\s*\/\/.*$/gm, ' ');       // line comments
  return [
    ...[...stripped.matchAll(/'((?:[^'\\]|\\.){20,})'/g)].map((m) => m[1]),
    ...[...stripped.matchAll(/"((?:[^"\\]|\\.){20,})"/g)].map((m) => m[1]),
    ...[...stripped.matchAll(/`((?:[^`\\]|\\.){20,})`/g)].map((m) => m[1]),
  ];
}

const sources = [
  ...(existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith('.ts')).map((f) => join(pagesDir, f)) : []),
  ...(existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith('.ts')).map((f) => join(libDir, f)) : []),
];

describe('no page quotes a dollar price or waits on a price feed', () => {
  it('shows no literal dollar amount to a user', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      for (const text of prose(file)) {
        if (!/\$\d/.test(text)) continue;
        // A denial of a fee this project refuses to charge is the opposite claim.
        if (/no \$5 activation/.test(text)) continue;
        offenders.push(`${file.split('/').pop()}: ${text.slice(0, 140)}`);
      }
    }
    expect(offenders, `dollar-priced copy:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('never tells a user a feature is gated on a price feed', () => {
    const banned = [
      'oracle prices',
      'priced in dollars',
      'registration is closed',
      'price feed is stale',
      'convert through the protocol price',
      'at the protocol median',
    ];
    const offenders: string[] = [];
    for (const file of sources) {
      for (const text of prose(file)) {
        for (const phrase of banned) {
          if (text.toLowerCase().includes(phrase.toLowerCase())) offenders.push(`${file.split('/').pop()}: ${phrase}`);
        }
      }
    }
    expect(offenders, `price-feed copy:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('reads the OBS fee fields, never the removed USD ones', () => {
    const offenders: string[] = [];
    for (const file of sources) {
      const source = readFileSync(file, 'utf8');
      for (const field of ['registrationFeeUsd', 'businessPagePriceUsd', 'minGlvUsd', 'maxGlvUsd']) {
        if (source.includes(field)) offenders.push(`${file.split('/').pop()}: ${field}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('ships no dollar price in the generated site HTML', () => {
    const sites = ['landing', 'circle', 'ons', 'social', 'developer', 'mine', 'wallet', 'app'];
    const offenders: string[] = [];
    for (const site of sites) {
      const shell = join(repo, site, 'index.html');
      if (!existsSync(shell)) continue;
      const html = readFileSync(shell, 'utf8');
      if (/\$\d/.test(html)) offenders.push(site);
    }
    expect(offenders).toEqual([]);
  });
});
