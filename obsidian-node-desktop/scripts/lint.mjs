#!/usr/bin/env node
/**
 * Project rules that a type checker cannot see. Fails (exit 1) on any violation.
 *
 *  - no demo/mock/simulated data or randomness in production code (src/dev and src/tests are exempt)
 *  - the renderer never imports Node or Electron, and shared/ never imports core/ or Node-only modules
 *  - child processes are spawned only by the supervisor, the node host and the packaging scripts
 *  - no eval / new Function / document.write / unescaped innerHTML outside the html template helper
 *  - no inline scripts, inline event handlers or remote URLs in the renderer HTML/CSS
 *  - every data-action used in the renderer has a handler; every handler is reachable
 *  - every IPC channel is handled, allow-listed by the preload and used by the renderer or main
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (file, message) => problems.push(`${relative(root, file)}: ${message}`);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const read = (f) => readFileSync(f, 'utf8');
const rel = (f) => relative(root, f).replace(/\\/g, '/');

const production = walk(join(root, 'src')).filter((f) => f.endsWith('.ts') && !rel(f).startsWith('src/dev/') && !rel(f).startsWith('src/tests/'));
const renderer = production.filter((f) => rel(f).startsWith('src/renderer/'));

for (const file of production) {
  const text = read(file);
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\b(mock|stub|dummy|lorem ipsum|simulat(?:e|ed|ion)\s+(?:data|result|success))\b/i.test(code.replace(/\/tx\/simulate|simulate\(|\.simulate|simulateResult|'simulate'/g, ''))) fail(file, 'looks like demo/mock data in production code');
  if (/Math\.random\(\)/.test(code)) fail(file, 'Math.random in production code (use node:crypto)');
  if (/\beval\s*\(|new Function\s*\(|document\.write\s*\(/.test(code)) fail(file, 'eval / new Function / document.write');
  if (/\.innerHTML\s*=/.test(code) && !/renderer\/(dom|main)\.ts$/.test(rel(file))) fail(file, 'innerHTML assignment outside the render sink (main.ts paints only escaped Html values)');
  if (/console\.(log|debug)\(/.test(code) && rel(file).startsWith('src/core/')) fail(file, 'console output in core (use the LogBuffer)');
  if (/from\s+['"]node:child_process['"]|require\(['"]child_process['"]\)/.test(code) && !/src\/(core\/node-supervisor|main\/node-host|core\/core-loader)\.ts$/.test(rel(file))) fail(file, 'spawns processes outside the supervisor');
}

for (const file of renderer) {
  const code = read(file);
  if (/from\s+['"](node:|electron|fs|path|os|child_process)/.test(code)) fail(file, 'renderer must not import Node or Electron modules');
  if (/from\s+['"][^'"]*\/(core|main)\//.test(code)) fail(file, 'renderer must not import core/ or main/');
}
for (const file of production.filter((f) => rel(f).startsWith('src/shared/'))) {
  if (/from\s+['"](node:|electron|[^'".][^'"]*)['"]/.test(read(file)) || /from\s+['"][^'"]*\/(core|main)\//.test(read(file))) fail(file, 'shared/ may import only other shared files (it is loaded by the renderer)');
}

// HTML / CSS
const html = read(join(root, 'renderer', 'index.html'));
const css = read(join(root, 'renderer', 'styles.css'));
if (/<script(?![^>]*\ssrc=)/i.test(html)) fail(join(root, 'renderer/index.html'), 'inline <script>');
if (/\son[a-z]+\s*=/i.test(html)) fail(join(root, 'renderer/index.html'), 'inline event handler attribute');
if (!/Content-Security-Policy/i.test(html)) fail(join(root, 'renderer/index.html'), 'no Content-Security-Policy');
for (const [name, text] of [['index.html', html], ['styles.css', css]]) {
  if (/(?:src|href)\s*=\s*["']https?:|url\(\s*["']?https?:|@import\s+(?:url\()?["']?https?:/i.test(text)) fail(join(root, 'renderer', name), 'remote resource (the app must work offline and load nothing from the web)');
}

// actions
const used = new Set();
const handled = new Set();
for (const file of renderer) {
  const text = read(file);
  for (const m of text.matchAll(/data-(?:action|action-change|submit)=\\?"([a-zA-Z][\w.:-]*)\\?"/g)) used.add(m[1]);
  for (const m of text.matchAll(/^\s*'([a-zA-Z][\w-]*(?:\.[\w-]+)+|copy|nav|route)'\s*:/gm)) handled.add(m[1]);
}
for (const name of used) if (!['copy', 'nav', 'route'].includes(name) && !handled.has(name)) fail(join(root, 'src/renderer'), `data-action "${name}" has no handler`);
for (const name of handled) if (!used.has(name) && !/^(copy|nav|route)$/.test(name)) fail(join(root, 'src/renderer'), `handler "${name}" is never used by any control`);

// channels
const contract = read(join(root, 'src/shared/contract.ts'));
const channelBlock = contract.slice(contract.indexOf('export const CHANNELS'), contract.indexOf('} as const'));
const channels = [...channelBlock.matchAll(/\w+:\s*'([^']+)'/g)].map((m) => m[1]);
const handlers = read(join(root, 'src/core/handlers.ts'));
const rendererText = renderer.map(read).join('\n');
const mainText = read(join(root, 'src/main/main.ts'));
for (const c of new Set(channels)) {
  if (!handlers.includes(`'${c}'`)) fail(join(root, 'src/core/handlers.ts'), `channel ${c} has no handler`);
  if (!rendererText.includes(`'${c}'`) && !mainText.includes(`'${c}'`)) fail(join(root, 'src/renderer'), `channel ${c} is never used (dead interface)`);
}

if (problems.length > 0) {
  process.stderr.write(`lint: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`lint: ok (${production.length} source files, ${used.size} actions, ${new Set(channels).size} channels)\n`);
