#!/usr/bin/env node
/**
 * Assemble the wallet: put the web app's own signing bundle and shared modules where the page loads them.
 *
 *   public/js/obsidian.js          the bundle built from obsidian-core (keys, derivation, signing, the vault, QR)
 *   public/js/shared/data.mjs      the web app's data layer (RPC reads, amounts)
 *   public/js/shared/wallet.mjs    the bridge between screens and the bundle (network check before every signature)
 *   public/js/shared/scanner.mjs   the camera / photo scanner
 *
 * These are COPIES of obsidian-app-web's files, not a second implementation: the wallet and the web app sign, derive and
 * read the chain with the same code. `public/js/` is generated and not committed (the repository ignores it).
 *
 *   node scripts/build.mjs               rebuild the bundle (needs obsidian-core, obsidian-interface and app-web installed)
 *   node scripts/build.mjs --if-missing  only if nothing is built yet
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const appWeb = resolve(root, '..', 'obsidian-app-web');
const out = resolve(root, 'public', 'js');
const shared = resolve(out, 'shared');
const SHARED = ['data.mjs', 'wallet.mjs', 'scanner.mjs'];

if (process.argv.includes('--if-missing') && existsSync(resolve(out, 'obsidian.js')) && SHARED.every((f) => existsSync(resolve(shared, f)))) {
  process.exit(0);
}

const run = spawnSync('npm', ['run', 'build:web'], { cwd: appWeb, stdio: 'inherit', shell: process.platform === 'win32' });
if (run.status !== 0) {
  console.error('build failed: obsidian-app-web could not build the signing bundle (npm ci in obsidian-core, obsidian-interface and obsidian-app-web first).');
  process.exit(run.status ?? 1);
}

mkdirSync(shared, { recursive: true });
copyFileSync(resolve(appWeb, 'public', 'js', 'obsidian.js'), resolve(out, 'obsidian.js'));
for (const file of SHARED) copyFileSync(resolve(appWeb, 'public', file), resolve(shared, file));

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const info = {
  builtFrom: 'obsidian-app-web',
  files: Object.fromEntries([['obsidian.js', sha(resolve(out, 'obsidian.js'))], ...SHARED.map((f) => [`shared/${f}`, sha(resolve(shared, f))])]),
};
writeFileSync(resolve(out, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`wallet build ok: ${Object.keys(info.files).length} files in ${out}`);
