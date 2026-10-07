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
 * longer needed was unusable, and the discontinued Circle product advertised
 * land at "$100 to $30,000 per m²" when the real band was 0.01–5 OBS.
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

  it('quotes no dollar price in the product documentation', () => {
    // The docs drifted the same way the pages did: circle.md still sold land
    // at "$100 to $30,000 per m²" and ons.md documented an oracle conversion,
    // five releases after the protocol stopped pricing anything in dollars.
    const docsDir = join(repo, 'docs');
    if (!existsSync(docsDir)) return;
    const allowed = [
      // Deliberate denials of fees this project refuses to charge.
      'Where did the $5 activation',
      'no** `$5` activation',
      'No $5 activation',
      'Until 1.2.0 this fee was a dollar amount',
      // The removal report and the implementation report exist to record what
      // was deleted; naming the removed `$5 USDT` gate is their purpose.
      '`$5 USDT` activation',
      // A defect record quoting the symptom it describes, not a price claim.
      'listed every country as `$0.02`',
      // The published Genesis Invitation HASH is `scrypt$N$r$p$<salt>$<hash>`: the `$` is the
      // separator of that format, not a currency sign. (Hosting costs in the guides are written
      // "USD 27", never "$27", so this guard stays strict for everything else.)
      'scrypt$',
    ];
    const offenders: string[] = [];
    for (const file of readdirSync(docsDir).filter((f) => f.endsWith('.md'))) {
      const text = readFileSync(join(docsDir, file), 'utf8');
      for (const line of text.split('\n')) {
        if (!/\$\d/.test(line)) continue;
        if (allowed.some((phrase) => line.includes(phrase))) continue;
        // µ$ bounds describe the oracle transaction type, which still exists.
        if (line.includes('µ$')) continue;
        offenders.push(`${file}: ${line.trim().slice(0, 120)}`);
      }
    }
    expect(offenders, `dollar prices in docs:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('ships no dollar price in the generated site HTML', () => {
    const sites = ['landing', 'ons', 'node', 'developer', 'mine', 'wallet', 'app', 'explorer', 'audit'];
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
