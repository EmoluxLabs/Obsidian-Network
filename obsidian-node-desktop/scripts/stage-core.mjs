#!/usr/bin/env node
/**
 * Stage the Obsidian Core node into vendor/obsidian-core.
 *
 * The desktop app does not contain a second node. It runs the real obsidian-core
 * build, so the app is only ever as correct as the core it is staged from. This
 * script copies a BUILT core (dist/, config/, VERSION, package.json) and its
 * production dependencies (npm ci --omit=dev) into vendor/obsidian-core, which the
 * app loads at run time and electron-builder ships as an extra resource.
 *
 *   OBSIDIAN_CORE_DIR   path to the obsidian-core checkout (default ../obsidian-core, the sibling in the Obsidian-Network repository)
 *
 * Nothing in the core is modified. A manifest (vendor/obsidian-core/STAGED.json)
 * records the core version and the git commit it came from.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const source = resolve(process.env.OBSIDIAN_CORE_DIR ?? join(root, '..', 'obsidian-core'));
const target = join(root, 'vendor', 'obsidian-core');

function fail(message) {
  process.stderr.write(`stage-core: ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(source, 'package.json'))) fail(`no obsidian-core at ${source} (set OBSIDIAN_CORE_DIR)`);
if (!existsSync(join(source, 'dist', 'node.js'))) {
  fail(`${source} has no dist/ — build the core first: (cd ${source} && npm ci && npm run build)`);
}

const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const entry of ['dist', 'config', 'VERSION', 'package.json', 'package-lock.json']) {
  if (existsSync(join(source, entry))) cpSync(join(source, entry), join(target, entry), { recursive: true });
}

execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
  cwd: target,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  // A build made from uncommitted changes must not claim to be the commit it started from.
  const dirty = execFileSync('git', ['-C', source, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim();
  if (dirty) {
    commit = `${commit}+dirty`;
    process.stderr.write('stage-core: WARNING: the core checkout has uncommitted changes; the staged build is marked +dirty\n');
  }
} catch {
  /* not a git checkout */
}
writeFileSync(
  join(target, 'STAGED.json'),
  `${JSON.stringify({ name: pkg.name, version: pkg.version, sourceCommit: commit, stagedAt: new Date().toISOString() }, null, 2)}\n`,
);
process.stdout.write(`stage-core: staged ${pkg.name}@${pkg.version} (${commit.slice(0, 12)}) into ${target}\n`);
