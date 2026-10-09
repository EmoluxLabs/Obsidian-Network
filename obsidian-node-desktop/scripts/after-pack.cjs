/**
 * electron-builder afterPack hook: put the real core's production dependencies into the package.
 *
 * `extraResources` copies vendor/obsidian-core but electron-builder deliberately drops a root
 * `node_modules` directory from every filtered copy, so the core would arrive without @noble/*,
 * @scure/* and ws and could not start. (`scripts/verify-package.mjs` exists to catch exactly that.)
 * This hook copies the staged node_modules next to the rest of the core, before signing and before
 * the installers are made.
 */
const { cpSync, existsSync } = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, packager, electronPlatformName } = context;
  const resources =
    electronPlatformName === 'darwin'
      ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : path.join(appOutDir, 'resources');
  const from = path.join(packager.projectDir, 'vendor', 'obsidian-core', 'node_modules');
  const to = path.join(resources, 'obsidian-core', 'node_modules');
  if (!existsSync(from)) throw new Error(`after-pack: ${from} is missing — run "npm run stage:core" first`);
  if (!existsSync(path.join(resources, 'obsidian-core'))) throw new Error(`after-pack: ${resources}/obsidian-core was not copied`);
  cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== '.bin' });
  process.stdout.write(`  • after-pack: core dependencies copied into ${path.relative(appOutDir, to)}\n`);
};
