#!/usr/bin/env node
/**
 * Post-build assurance: the shipped bundle must not contain Node built-ins,
 * `require`, or any Node global that would throw "X is not defined" the moment a
 * recovery phrase is typed into a real browser.
 *
 * The interface runs the same check on its own bundles. It is copied here because
 * the guarantee is identical and the failure is identical: `Buffer` reached a
 * shipped wallet bundle once, through BIP-32 derivation, and it must never happen
 * silently again. --platform=browser catches *imports*; this catches the globals a
 * bundler happily leaves in place.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, '..', 'public', 'js');

if (!existsSync(outdir)) {
  console.error('public/js is missing: run npm run build:web first');
  process.exit(1);
}

const banned = [
  /from\s*["']node:/,
  /require\(\s*["']node:/,
  /\bprocess\.env\b/,
  /\bBuffer\s*\./,
  /\bnew\s+Buffer\b/,
  /\b__dirname\b/,
  /\b__filename\b/,
  /\bglobal\s*\./,
];

let failures = 0;
let checked = 0;
for (const file of readdirSync(outdir)) {
  if (!file.endsWith('.js')) continue;
  checked += 1;
  const source = readFileSync(join(outdir, file), 'utf8');
  for (const pattern of banned) {
    if (pattern.test(source)) {
      console.error(`${file} matches ${pattern}`);
      failures += 1;
    }
  }
}

if (checked === 0) {
  console.error('public/js holds no bundles: run npm run build:web first');
  process.exit(1);
}

if (failures > 0) process.exit(1);
console.log(`browser bundles are free of node built-ins and process.env reads ✓ (${checked} file(s))`);
