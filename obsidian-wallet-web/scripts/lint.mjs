#!/usr/bin/env node
/**
 * The wallet's static checks. There is no framework to lint, so this checks what matters for a page that holds keys:
 *
 *   - every module parses (node --check);
 *   - the page ships no inline script, inline handler or inline style (the server's CSP depends on it);
 *   - no way to turn text into code (eval, new Function, document.write, string timers);
 *   - nothing is loaded from, or sent to, another host: no absolute http(s) URL in the shipped code;
 *   - no demo data: no sample address, phrase, balance or transaction in what ships.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const skip = new Set(['js']); // generated: the web app's own code, checked by its own suite

const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (dir === pub && skip.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else files.push(path);
  }
})(pub);

let problems = 0;

// The scripts and the tests are not shipped, but a test that does not parse tests nothing.
const own = [];
for (const dir of ['scripts', 'tests', join('tests', 'e2e')]) {
  for (const name of readdirSync(join(root, dir))) if (name.endsWith('.mjs')) own.push(join(root, dir, name));
}
for (const file of own) {
  const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.error(`lint: ${relative(root, file)}: does not parse: ${run.stderr.trim().split('\n')[0]}`);
    problems += 1;
  }
}
const fail = (file, message) => {
  console.error(`lint: ${relative(root, file)}: ${message}`);
  problems += 1;
};

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const code = file.endsWith('.mjs') || file.endsWith('.html');
  if (file.endsWith('.mjs')) {
    const run = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (run.status !== 0) fail(file, `does not parse: ${run.stderr.trim().split('\n')[0]}`);
  }
  if (!code && !file.endsWith('.css')) continue;
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/<!--[\s\S]*?-->/g, '');
  if (code) {
    if (/\son[a-z]+\s*=\s*["']/i.test(noComments)) fail(file, 'inline event handler');
    if (/\sstyle\s*=\s*["'`]/i.test(noComments.replace(/<noscript>[\s\S]*?<\/noscript>/i, ''))) fail(file, 'inline style attribute');
    if (/<script(?![^>]*\ssrc=)[^>]*>/i.test(noComments)) fail(file, 'inline <script>');
    if (/\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(|set(Timeout|Interval)\s*\(\s*["'`]/.test(noComments)) fail(file, 'turns text into code');
    if (/https?:\/\/(?!127\.0\.0\.1|localhost)[\w.-]+/i.test(noComments)) fail(file, 'absolute URL to another host');
    if (/\b(obs|tobs|sobs|dobs)1[0-9a-z]{20,}/i.test(noComments)) fail(file, 'a literal address (demo data)');
    if (/\b(lorem ipsum|placeholder data|sample data|TODO|FIXME)\b/i.test(noComments)) fail(file, 'placeholder text');
  }
  if (file.endsWith('.css') && /url\(\s*["']?https?:/i.test(noComments)) fail(file, 'remote CSS resource');
}

if (problems) {
  console.error(`lint: ${problems} problem(s)`);
  process.exit(1);
}
console.log(`lint ok: ${files.length} files checked, ${own.length} scripts and tests parse`);
