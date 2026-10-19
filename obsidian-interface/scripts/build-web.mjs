#!/usr/bin/env node
/**
 * Build the browser app. esbuild bundles the page entry points together with the
 * vendored core modules; `--platform=browser` makes the build FAIL if any code
 * on that path tries to import a Node built-in, which is exactly the guarantee
 * the wallet needs.
 */
import { build } from 'esbuild';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webFingerprint } from './web-fingerprint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outdir = join(root, 'public', 'js');
const nodePaths = [join(root, '..', 'obsidian-core', 'node_modules'), join(root, 'node_modules')];

const pages = ['landing', 'mine', 'wallet', 'explorer', 'ons', 'developer', 'app', 'audit', 'node'];

rmSync(outdir, { recursive: true, force: true });

const missing = pages.filter((page) => !existsSync(join(root, 'web', 'src', 'pages', `${page}.ts`)) && !existsSync(join(root, 'web', 'src', `${page}.ts`)));
if (missing.length > 0) {
  console.error(`missing page entries: ${missing.join(', ')}`);
  process.exit(1);
}

const result = await build({
  entryPoints: pages.map((page) => {
    const inPages = join(root, 'web', 'src', 'pages', `${page}.ts`);
    return existsSync(inPages) ? inPages : join(root, 'web', 'src', `${page}.ts`);
  }),
  outdir,
  entryNames: '[name]',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2022'],
  sourcemap: true,
  minify: false, // readable output: this is a protocol client, not a marketing bundle
  legalComments: 'none',
  nodePaths,
  logLevel: 'info',
});

// Ties these bundles to the sources they came from; the server compares it at start (server/web-bundle.ts).
writeFileSync(join(outdir, 'build.json'), `${JSON.stringify({ fingerprint: webFingerprint(join(root, 'web', 'src')) })}\n`);

console.log(`built ${result.outputFiles?.length ?? pages.length} browser entries (browser-safe ✓)`);
