#!/usr/bin/env node
/**
 * Assemble dist/ — the unpacked extension.
 *
 * Nothing is copied by hand and nothing is duplicated into this package:
 *   - the DESIGN comes from the supplied template ZIP (template/obsidian-extension.zip), which is verified
 *     against its recorded SHA-256 and never modified: popup.css, popup.js and icons/ are taken from it
 *     byte-for-byte;
 *   - the BEHAVIOUR comes from obsidian-app-web/public (real.mjs, data.mjs, screens.mjs, explorer.mjs, notify.mjs,
 *     scanner.mjs, wallet.mjs) and the wallet/signing bundle built from obsidian-core (js/obsidian.js) — the same
 *     files the web app serves, so the extension cannot drift from the app;
 *   - the extension's own files are in src/ and manifest.json.
 *
 * Usage: node scripts/build.mjs [--skip-web-build]
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appWeb = path.resolve(root, '..', 'obsidian-app-web');
const dist = path.join(root, 'dist');
const templateZip = path.join(root, 'template', 'obsidian-extension.zip');
const skipWebBuild = process.argv.includes('--skip-web-build');

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const die = (message) => {
  console.error(`build failed: ${message}`);
  process.exit(1);
};

// 1 ── the template, verified --------------------------------------------------------------------------------
const recorded = fs.readFileSync(`${templateZip}.sha256`, 'utf8').trim().split(/\s+/)[0];
if (sha256(templateZip) !== recorded) die('template/obsidian-extension.zip does not match its recorded SHA-256. It must stay exactly as supplied.');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-ext-template-'));
try {
  execFileSync('unzip', ['-q', '-o', templateZip, '-d', scratch], { stdio: 'inherit' });

  // 2 ── the web app's modules and bundle ---------------------------------------------------------------------
  if (!skipWebBuild) {
    execFileSync('npm', ['run', 'build:web'], { cwd: appWeb, stdio: 'inherit' });
  }
  const bundle = path.join(appWeb, 'public', 'js', 'obsidian.js');
  if (!fs.existsSync(bundle)) die('obsidian-app-web/public/js/obsidian.js is missing. Run `npm run build:web` in obsidian-app-web first (or omit --skip-web-build).');

  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(path.join(dist, 'js'), { recursive: true });

  for (const name of ['popup.css', 'popup.js']) fs.copyFileSync(path.join(scratch, name), path.join(dist, name));
  fs.cpSync(path.join(scratch, 'icons'), path.join(dist, 'icons'), { recursive: true });

  const modules = fs.readdirSync(path.join(appWeb, 'public')).filter((name) => name.endsWith('.mjs')).sort();
  for (const name of modules) fs.copyFileSync(path.join(appWeb, 'public', name), path.join(dist, name));
  fs.copyFileSync(bundle, path.join(dist, 'js', 'obsidian.js'));

  // 3 ── this package's own files ----------------------------------------------------------------------------
  for (const name of fs.readdirSync(path.join(root, 'src')).sort()) fs.copyFileSync(path.join(root, 'src', name), path.join(dist, name));
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(dist, 'manifest.json'));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

const clash = fs.readdirSync(path.join(root, 'src')).filter((name) => fs.existsSync(path.join(appWeb, 'public', name)));
if (clash.length) die(`src/ would overwrite app-web modules: ${clash.join(', ')}`);

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(dist, full));
  }
})(dist);
console.log(`built ${files.length} files into ${path.relative(process.cwd(), dist) || 'dist'}`);
