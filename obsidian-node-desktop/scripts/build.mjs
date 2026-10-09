#!/usr/bin/env node
/**
 * Build: compile the main/core/shared code and the renderer with tsc, copy the static
 * renderer files, and generate the sandboxed preload script from the IPC contract.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const run = (args) => execFileSync(process.execPath, [tsc, ...args], { cwd: root, stdio: 'inherit' });

if (!existsSync(join(root, 'vendor', 'obsidian-core', 'dist', 'node.js'))) {
  process.stderr.write('build: vendor/obsidian-core is missing. Run "npm run stage:core" first.\n');
  process.exit(1);
}

rmSync(join(root, 'dist'), { recursive: true, force: true });
run(['-p', 'tsconfig.json']);
run(['-p', 'tsconfig.renderer.json']);

// static renderer files
const web = join(root, 'dist', 'web');
mkdirSync(web, { recursive: true });
cpSync(join(root, 'renderer'), web, { recursive: true });

// preload: the template contains the channel allowlist taken from the contract, so the
// sandboxed preload (which cannot import local modules) and the main process can never disagree.
const { CHANNELS } = await import(pathToUrl(join(root, 'dist', 'shared', 'contract.js')));
const template = readFileSync(join(root, 'src', 'main', 'preload.template.cjs'), 'utf8');
if (!template.includes('/*CHANNELS*/[]')) throw new Error('preload template has no channel placeholder');
writeFileSync(join(root, 'dist', 'main', 'preload.cjs'), template.replace('/*CHANNELS*/[]', JSON.stringify(Object.values(CHANNELS))));

process.stdout.write('build: ok\n');

function pathToUrl(p) {
  return new URL(`file://${p.startsWith('/') ? '' : '/'}${p.replace(/\\/g, '/')}`).href;
}
