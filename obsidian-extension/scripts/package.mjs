#!/usr/bin/env node
/**
 * Package dist/ as release/obsidian-extension-<version>.zip (manifest.json at the root, which is what the Chrome Web
 * Store, Edge Add-ons and Firefox AMO all expect) plus a SHA-256 file.
 *
 * Deterministic: files are added in sorted order with a fixed modification time and no extra attributes, so the same
 * sources always give the same bytes. The archive is unsigned. Signing is done by the store (or by the user for a
 * private Firefox build) and needs credentials that must never be in this repository.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('package failed: dist/ is missing. Run `npm run build` first.');
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
const out = path.join(root, 'release');
fs.mkdirSync(out, { recursive: true });
const zipPath = path.join(out, `obsidian-extension-${manifest.version}.zip`);
fs.rmSync(zipPath, { force: true });

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(path.relative(dist, full).split(path.sep).join('/'));
  }
})(dist);
files.sort();

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-ext-pack-'));
try {
  const fixed = new Date('2026-01-01T00:00:00Z');
  for (const file of files) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(dist, file), target);
    fs.utimesSync(target, fixed, fixed);
  }
  execFileSync('zip', ['-X', '-q', '-9', zipPath, ...files], { cwd: stage, stdio: 'inherit' });
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}

const sha = createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
fs.writeFileSync(`${zipPath}.sha256`, `${sha}  ${path.basename(zipPath)}\n`);
console.log(`${path.relative(process.cwd(), zipPath) || zipPath}  ${fs.statSync(zipPath).size} bytes  sha256 ${sha}`);
