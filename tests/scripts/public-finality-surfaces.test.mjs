/**
 * No public surface shows how far finality has got.
 *
 * The finalized height, its lag and the producer count behind it are the operator's to read (the node's own `/finality`, for a
 * caller on the node's machine). No page, app, wallet, extension, proxy or CDN rule shows or serves them to a visitor.
 * Consensus is untouched: the node still computes and enforces finality. The behaviour is tested where it lives (obsidian-core
 * `rpc-finality-privacy`, obsidian-interface server tests); this file guards the source of every public surface.
 */
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir, keep, out = []) {
  if (!existsSync(join(ROOT, dir))) return out;
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name === 'dist' || name === 'core' || name === 'js') continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, keep, out);
    else if (keep(rel)) out.push(rel);
  }
  return out;
}

const PUBLIC_UI = [
  ...walk('obsidian-interface/web/src', (f) => f.endsWith('.ts')),
  ...walk('obsidian-app-web/public', (f) => /\.mjs$/.test(f)),
  ...walk('obsidian-wallet-web/public', (f) => /\.mjs$/.test(f)),
  ...walk('obsidian-extension/src', (f) => f.endsWith('.mjs')),
];

test('the public UI sources are found', () => {
  assert.ok(PUBLIC_UI.length > 20, `found only ${PUBLIC_UI.length} files`);
});

test('no public page reads or shows a finalized height, its lag, or the /finality route', () => {
  // "finalizeNameRecovery" and friends are the ONS recovery step, not chain finality: they do not match these.
  const forbidden = /finalizedHeight|finalizedHash|finalityLag|finalityAvailable|finalityEligible|\/finality|getFinality|\.finality\(|['"`]FINALIT|['"`]FINALIZED|FINALIZED HEIGHT|BLOCKS BEHIND HEAD/i;
  const hits = [];
  for (const file of PUBLIC_UI) if (forbidden.test(strip(read(file)))) hits.push(file);
  assert.deepEqual(hits, []);
});

test('no public page has a FINALIZED or PEERS card, row or label at all (not even an empty one)', () => {
  // A hidden figure with its label left behind still reads "FINALIZED —" or "PEERS 0": the whole card has to go.
  const label = /['"`>]\s*(finalized|finalized height|finality|peers|peers connected|connected peers)\s*['"`<:]/i;
  const files = [...PUBLIC_UI, 'obsidian-app-web/public/index.html', 'obsidian-wallet-web/public/index.html'];
  const hits = [];
  for (const file of files) {
    const text = file.endsWith('.html') ? read(file) : strip(read(file));
    // A sentence that merely says peers are not shown is prose, not a card: only a bare label is matched.
    if (label.test(text.replace(/<span>PEERS<\/span>/g, '<span>PEERS</span>'))) hits.push(file);
  }
  assert.deepEqual(hits, []);
});

test('the status strip tolerates one failed read and shows no peer or finality figure', () => {
  const banner = strip(read('obsidian-interface/web/src/lib/node-banner.ts'));
  assert.match(banner, /Promise\.allSettled/);
  assert.doesNotMatch(banner, /peers|finaliz|finality/i);
});

test('the interface proxy does not serve /finality and strips finality fields from /status and /producers', () => {
  const server = strip(read('obsidian-interface/server/index.ts'));
  assert.doesNotMatch(server, /target === '\/finality'/, 'the proxy allowlist must not include /finality');
  assert.match(server, /withoutFinality\(target, safeParse\(text\)\)/, 'proxied bodies pass through the stripper');
});

test('the CDN rules do not cache a finality route', () => {
  assert.doesNotMatch(read('cloudflare/src/worker.js'), /path=\/finality/);
  assert.doesNotMatch(read('cloudflare/terraform/main.tf'), /"\/finality"/);
});

test('the node still computes finality and still shows it to its operator', () => {
  const rpc = read('obsidian-core/src/rpc/server.ts');
  assert.match(rpc, /private mayShowFinality\(request: IncomingMessage\)/);
  assert.match(rpc, /private finality\(request: IncomingMessage, response: ServerResponse\)/);
  assert.match(rpc, /\.\.\.this\.options\.chain\.finalityStatus\(\)/, 'the operator route still returns the checkpoint');
});
