#!/usr/bin/env node
/**
 * Make sure the tests have something to test against.
 *
 * The derivation and signing vectors import obsidian-interface/web/core, which is
 * generated: it is the browser-safe subset of obsidian-core/dist, copied by
 * scripts/sync-core.mjs, and it is gitignored. On a fresh clone it does not exist,
 * and a test that answers "cannot find module" is telling you about your checkout,
 * not about your code.
 *
 * This runs before the suite and builds whatever is missing. It is deliberately
 * silent when everything is already in place, and it never rebuilds something that
 * is already there — a pretest hook that recompiles the core on every run is a
 * pretest hook people learn to skip.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const core = resolve(root, 'obsidian-core');
const iface = resolve(root, 'obsidian-interface');

const NEED = [
  resolve(core, 'dist/crypto/mnemonic.js'),
  resolve(iface, 'web/core/crypto/mnemonic.js'),
];

if (NEED.every(existsSync)) {
  process.stdout.write('ensure-core: obsidian-core dist and the synced web/core are present\n');
  process.exit(0);
}

function step(label, command, args, cwd) {
  process.stdout.write(`ensure-core: ${label}\n`);
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

if (!existsSync(resolve(core, 'node_modules/typescript/bin/tsc'))) {
  step('installing obsidian-core dependencies', 'npm', ['install'], core);
}
if (!existsSync(resolve(core, 'dist/crypto/mnemonic.js'))) {
  step('building obsidian-core', process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], core);
}
if (!existsSync(resolve(iface, 'web/core/crypto/mnemonic.js'))) {
  step('syncing the browser-safe core', process.execPath, ['scripts/sync-core.mjs'], iface);
}

for (const file of NEED) {
  if (!existsSync(file)) {
    process.stderr.write(`ensure-core: ${file} is still missing\n`);
    process.exit(1);
  }
}
process.stdout.write('ensure-core: ready\n');
