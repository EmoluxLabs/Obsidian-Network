#!/usr/bin/env node
/**
 * Builds the browser signing bundle.
 *
 * This exists because "it built once in a session" is not a build system. The bundle
 * is generated output and is deliberately NOT committed — .gitignore's
 * `**\/public\/js\/` says so, and that rule is right. What was missing was a
 * repeatable way to produce it.
 *
 * The chain has three links, and all three must succeed:
 *
 *   1. obsidian-core compiled to dist/          (needs its own typescript)
 *   2. core synced into obsidian-interface/web/core/   (browser-safe subset only)
 *   3. web/signing.mjs bundled for the browser
 *
 * Step 3 runs with --platform=browser, and that flag is the point: it fails the build
 * on any Node built-in, so a dependency that would break in a browser is caught here
 * rather than when someone types a recovery phrase into a live screen.
 *
 * It exits non-zero on any failure. A build script that reports success while
 * producing nothing is worse than no build script.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appWeb = resolve(here, '..');
const root = resolve(appWeb, '..');
const core = resolve(root, 'obsidian-core');
const iface = resolve(root, 'obsidian-interface');

const OUTFILE = resolve(appWeb, 'public/js/signing.js');

function run(cmd, args, cwd) {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`);
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function fail(message) {
  process.stderr.write(`\nbuild:web failed: ${message}\n`);
  process.exit(1);
}

// 1. Compile the core. Its own typescript is used, not a bare `tsc` on PATH — npx tsc
//    resolves to an unrelated, abandoned package named tsc, which prints a banner
//    and compiles nothing.
const tsc = resolve(core, 'node_modules/typescript/bin/tsc');
if (!existsSync(tsc)) {
  fail(`obsidian-core's TypeScript compiler is missing at ${tsc}\n` +
       `  Run: (cd obsidian-core && npm install)`);
}
run(process.execPath, [tsc, '-p', 'tsconfig.json'], core);

if (!existsSync(resolve(core, 'dist/crypto/mnemonic.js'))) {
  fail('obsidian-core compiled but produced no dist/crypto/mnemonic.js');
}

// 2. Sync the browser-safe core into the interface's web tree. This is what keeps
//    Node-only modules out of the bundle.
run(process.execPath, ['scripts/sync-core.mjs'], iface);

const synced = resolve(iface, 'web/core/crypto/mnemonic.js');
if (!existsSync(synced)) {
  fail(`sync-core reported success but ${synced} does not exist`);
}

// 3. Bundle. --platform=browser is the gate, not a preference.
run('npx', ['--yes', 'esbuild@0.23.1', 'web/signing.mjs',
            '--bundle', '--platform=browser', '--format=esm',
            `--outfile=${OUTFILE}`], appWeb);

if (!existsSync(OUTFILE)) {
  fail(`esbuild reported success but ${OUTFILE} was not written`);
}

const bytes = statSync(OUTFILE).size;
if (bytes < 10_000) {
  fail(`bundle is only ${bytes} bytes - too small to contain the core`);
}

process.stdout.write(`\nbuild:web ok — ${OUTFILE} (${bytes.toLocaleString()} bytes)\n`);
process.stdout.write('Not committed by design; .gitignore excludes generated bundles.\n');
