#!/usr/bin/env node
/**
 * Post-build assurance: the shipped bundles must not contain Node built-ins,
 * `require`, or `process.env` reads that could silently change behaviour on a
 * user's machine.
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

// Node built-in *imports* are only half the risk. A Node **global** that the
// bundler happily leaves in place (Buffer, process, __dirname, global) throws
// "X is not defined" in the browser at runtime, which is exactly the class of
// bug a build-time check exists to prevent. `Buffer` reached the shipped wallet
// bundle once via BIP-32 derivation; it must never happen silently again.
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
for (const file of readdirSync(outdir)) {
  if (!file.endsWith('.js')) continue;
  const source = readFileSync(join(outdir, file), 'utf8');
  for (const pattern of banned) {
    if (pattern.test(source)) {
      console.error(`${file} matches ${pattern}`);
      failures += 1;
    }
  }
}
if (failures > 0) process.exit(1);
console.log('browser bundles are free of node built-ins and process.env reads ✓');
