#!/usr/bin/env node
/**
 * Copy the browser-safe part of the compiled Obsidian Core into the interface's
 * web tree, so the wallet in the browser runs the *same* code as the node —
 * identical encoders, identical signatures, identical address derivation.
 *
 * The node-only modules (storage, networking, indexer, rpc, chain) are not
 * copied at all: the browser must not be able to reach them.
 */
import { cpSync, existsSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const interfaceRoot = resolve(here, '..');
const coreDist = resolve(interfaceRoot, '..', 'obsidian-core', 'dist');
const target = join(interfaceRoot, 'web', 'core');

if (!existsSync(coreDist)) {
  console.error(`obsidian-core is not built: ${coreDist} is missing. Run: npm --prefix ../obsidian-core run build`);
  process.exit(1);
}

const KEEP = ['crypto', 'protocol', 'transactions', 'land', 'mining', 'genesis', 'version.js', 'version.d.ts'];
// Modules that exist in the node build but must never reach a browser.
const DROP = new Set(['keystore.js', 'keystore.js.map', 'keystore.d.ts']);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

let copied = 0;
for (const entry of KEEP) {
  const from = join(coreDist, entry);
  if (!existsSync(from)) continue;
  cpSync(from, join(target, entry), {
    recursive: true,
    filter: (source) => !DROP.has(source.split('/').pop()),
  });
  copied += statSync(from).isDirectory() ? readdirSync(from).length : 1;
}

// Fail loudly if anything node-only slipped in: the browser bundle must be
// limited to pure cryptography and canonical encoders.
const offenders = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) {
      const source = readFileSync(full, 'utf8');
      for (const match of source.matchAll(/from\s+'(node:[^']+)'/g)) offenders.push(`${full}: ${match[1]}`);
    }
  }
};
import { readFileSync } from 'node:fs';
walk(target);
if (offenders.length > 0) {
  console.error('browser-safety check failed — node-only imports found:');
  for (const offender of offenders) console.error(`  ${offender}`);
  process.exit(1);
}
console.log(`synced ${copied} core entries into web/core (browser-safe ✓)`);
