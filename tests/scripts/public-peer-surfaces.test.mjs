/**
 * No public surface lists peers or nodes.
 *
 * The node's own `/peers` and `/nodes` answer the operator on the node's machine; the interface does not proxy them; and
 * no page, app, wallet, extension, CDN worker or doc tells a visitor which nodes the network (or one interface) is made of.
 * Peer-to-peer discovery is untouched: it runs over the P2P protocol, not over any of these files. The behaviour is
 * tested where it lives (obsidian-core rpc-peers-privacy, obsidian-interface server tests); this file guards the
 * source of every public surface against a peer list creeping back in.
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
  ...walk('obsidian-app-web/public', (f) => /\.(mjs|html)$/.test(f) && !f.endsWith('index.html')),
  ...walk('obsidian-wallet-web/public', (f) => /\.(mjs|html)$/.test(f)),
  ...walk('obsidian-extension/src', (f) => f.endsWith('.mjs')),
];

test('the public UI sources are found', () => {
  assert.ok(PUBLIC_UI.length > 20, `found only ${PUBLIC_UI.length} files`);
});

test('no public page asks for the peer list, the node directory or a count of peers', () => {
  const forbidden = [
    [/path=\/peers|['"`]\/peers['"`]/, 'a request for /peers'],
    [/path=\/nodes(?![/\w])|['"`]\/nodes['"`]/, 'a request for the /nodes directory'],
    [/\.peers\s*\(\s*\)/, 'a client.peers() call'],
    [/\bstatus\??\.peers\b/, 'a peer count read from /status'],
    [/\bst\??\.peers\b/, 'a peer count read from /status'],
    [/['"`]PEERS['"`]|'Peers'|"Peers"/, 'a PEERS row'],
    [/\bnode\.url\b|\bn\.url\b/, 'a node URL'],
    [/\.nodes\?\.nodes|data\.nodes\b|\b(?:n|node)\.(?:healthy|latencyMs)\b/, 'a node list read from /api/nodes'],
  ];
  const hits = [];
  for (const file of PUBLIC_UI) {
    const text = strip(read(file));
    for (const [pattern, what] of forbidden) if (pattern.test(text)) hits.push(`${file}: ${what}`);
  }
  assert.deepEqual(hits, []);
});

test('the interface proxy does not allow the node peer routes, and does not name the node in a header', () => {
  const server = strip(read('obsidian-interface/server/index.ts'));
  assert.doesNotMatch(server, /target === '\/nodes' \|\|/, 'the proxy allowlist must not include /nodes');
  assert.doesNotMatch(server, /target === '\/peers' \|\|/, 'the proxy allowlist must not include /peers');
  assert.doesNotMatch(server, /'x-obsidian-node':\s*node\.url/, 'the node URL must not be sent to the browser');
  assert.match(server, /'\/api\/nodes\/detail'/, 'the operator-only detail route exists');
  assert.match(server, /isOperatorCaller\(request\)/, 'and is gated on the operator check');
});

test('the CDN worker does not cache the node directory', () => {
  const worker = read('cloudflare/src/worker.js');
  const list = worker.slice(worker.indexOf('CACHEABLE_RPC_PREFIXES'), worker.indexOf('NEVER_CACHE'));
  assert.doesNotMatch(list, /path=\/nodes'/, 'only the on-chain runner registry may be cached, never /nodes');
  assert.doesNotMatch(list, /path=\/peers/);
  const terraform = read('cloudflare/terraform/main.tf');
  assert.doesNotMatch(terraform, /"\/nodes",/);
});

test('the node still exposes discovery to the operator and to its own peers', () => {
  const rpc = read('obsidian-core/src/rpc/server.ts');
  assert.match(rpc, /private mayShowPeers\(request: IncomingMessage\)/);
  for (const route of ["case 'getpeers'", "case 'getnodes'"]) assert.match(rpc, new RegExp(`${route}:\\s*\\n\\s*return showPeers`), `${route} is gated`);
  const p2p = read('obsidian-core/src/networking/p2p.ts');
  assert.match(p2p, /t: 'getaddr'/, 'peers still ask each other for addresses over the P2P protocol');
  assert.match(p2p, /t: 'addr'/);
});
