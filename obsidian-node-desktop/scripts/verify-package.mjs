#!/usr/bin/env node
/**
 * After electron-builder has run: open the UNPACKED app it produced and check, from the files
 * themselves, that the package is what we think it is.
 *
 *   required   the app archive, the node host unpacked beside it, the real obsidian-core with its
 *              dependencies in resources/, the staged-core manifest, the preload and the renderer
 *   forbidden  unit tests and the browser bridge (dist/tests, dist/dev), source maps, any wallet or key file
 *
 * It reads app.asar's table of contents through @electron/asar (a dependency of electron-builder).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const release = join(root, 'release');
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const problems = [];
const need = (cond, text) => {
  if (!cond) problems.push(text);
};

/** Find every unpacked app directory electron-builder left behind. */
function resourceDirs() {
  const found = [];
  if (!existsSync(release)) return found;
  for (const name of readdirSync(release)) {
    const dir = join(release, name);
    if (!statSync(dir).isDirectory()) continue;
    if (existsSync(join(dir, 'resources', 'app.asar'))) found.push(join(dir, 'resources')); // win-unpacked, linux-unpacked
    for (const app of existsSync(dir) ? readdirSync(dir) : []) {
      if (app.endsWith('.app') && existsSync(join(dir, app, 'Contents', 'Resources', 'app.asar'))) found.push(join(dir, app, 'Contents', 'Resources'));
    }
  }
  return found;
}

const dirs = resourceDirs();
if (dirs.length === 0) {
  process.stderr.write('verify-package: no unpacked app found under release/\n');
  process.exit(1);
}

for (const resources of dirs) {
  const label = resources.replace(root, '.');
  const listing = asar.listPackage(join(resources, 'app.asar')).map((p) => p.replace(/\\/g, '/'));
  const has = (p) => listing.includes(p) || listing.some((x) => x.startsWith(`${p}/`));
  need(has('/package.json'), `${label}: app.asar has no package.json`);
  need(has('/dist/main/main.js'), `${label}: app.asar has no dist/main/main.js`);
  need(has('/dist/main/preload.cjs'), `${label}: app.asar has no generated preload`);
  need(has('/dist/web/index.html') && has('/dist/web/styles.css') && has('/dist/web/assets/obsidian-logo.png'), `${label}: renderer files are missing`);
  need(has('/dist/core/handlers.js') && has('/dist/shared/contract.js'), `${label}: app code is missing`);
  need(!has('/dist/tests'), `${label}: unit tests are packaged`);
  need(!has('/dist/dev'), `${label}: the browser test bridge is packaged`);
  need(!listing.some((p) => p.endsWith('.map')), `${label}: source maps are packaged`);
  need(!listing.some((p) => /wallet|vault|node-key|keystore/i.test(p) && !/\/dist\/(core|shared|web)\//.test(p)), `${label}: a wallet or key file is packaged`);

  const unpacked = join(resources, 'app.asar.unpacked', 'dist', 'main', 'node-host.js');
  need(existsSync(unpacked), `${label}: node-host.js is not unpacked (the node host is started by file path)`);

  const core = join(resources, 'obsidian-core');
  need(existsSync(join(core, 'dist', 'index.js')), `${label}: obsidian-core/dist/index.js is missing`);
  need(existsSync(join(core, 'dist', 'node.js')), `${label}: obsidian-core/dist/node.js is missing`);
  for (const dep of ['@noble/curves', '@noble/hashes', '@scure/bip32', '@scure/bip39', 'ws']) {
    need(existsSync(join(core, 'node_modules', dep, 'package.json')), `${label}: core dependency ${dep} is missing`);
  }
  need(existsSync(join(core, 'STAGED.json')), `${label}: STAGED.json (core version and source commit) is missing`);
  if (existsSync(join(core, 'STAGED.json'))) {
    const staged = JSON.parse(readFileSync(join(core, 'STAGED.json'), 'utf8'));
    need(/^\d+\.\d+\.\d+/.test(staged.version) && /^[0-9a-f]{40}/.test(staged.sourceCommit ?? ''), `${label}: STAGED.json has no real version/commit (${JSON.stringify(staged)})`);
    need(!String(staged.sourceCommit).includes('+dirty'), `${label}: the packaged core was built from uncommitted changes (${staged.sourceCommit})`);
  }
  process.stdout.write(`verify-package: ${label}: ${listing.length} files in app.asar, core present\n`);
}

if (problems.length > 0) {
  process.stderr.write(`verify-package: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('verify-package: ok\n');
