/**
 * Development and test bridge — NOT part of the packaged app (it is excluded from the
 * electron-builder file list).
 *
 * It serves the built renderer over HTTP and exposes the same handler registry the Electron
 * main process uses, through a `window.obsidian` shim. This lets the real UI run in a plain
 * browser against the real node supervisor and services, for automated UI tests in
 * environments where the Electron binary cannot be downloaded. It performs no logic of its own.
 *
 *   node dist/dev/bridge.js --port 5173 --data /tmp/obsidian-node-dev
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext } from '../core/app-context.js';
import { createHandlers, dispatch, wireEvents } from '../core/handlers.js';
import { CHANNELS } from '../shared/contract.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};
const port = Number(arg('port', '5173'));
const host = arg('host', '127.0.0.1');
const dataDir = resolve(arg('data', join(process.cwd(), '.dev-data')));
const webRoot = resolve(here, '..', 'web');
mkdirSync(dataDir, { recursive: true });

const ctx = createContext({
  appName: 'Obsidian Node (dev bridge)',
  appVersion: JSON.parse(readFileSync(resolve(here, '..', '..', 'package.json'), 'utf8')).version as string,
  userDataDir: dataDir,
  hostScript: join(here, '..', 'main', 'node-host.js'),
  templateSha256: existsSync(join(webRoot, 'TEMPLATE.sha256')) ? readFileSync(join(webRoot, 'TEMPLATE.sha256'), 'utf8').trim() : 'unknown',
  repository: 'https://github.com/EmoluxLabs/Obsidian-Node-Exe',
  versions: { electron: 'none (dev bridge)', chromium: 'browser', node: process.versions.node, platform: process.platform, arch: process.arch },
});
const handlers = createHandlers(ctx, {
  openExternal: async () => undefined,
  saveText: async () => ({ saved: false }),
});
const allowed = new Set<string>(Object.values(CHANNELS));

const SHIM = `
(() => {
  const listeners = new Map();
  const es = new EventSource('/__events');
  es.onmessage = (m) => { const { event, data } = JSON.parse(m.data); (listeners.get(event) || []).forEach((l) => l(data)); };
  window.obsidian = {
    invoke: async (channel, payload) => {
      const r = await fetch('/__ipc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel, payload: payload === undefined ? null : payload }) });
      return r.json();
    },
    on: (event, l) => { const a = listeners.get(event) || []; a.push(l); listeners.set(event, a); return () => listeners.set(event, (listeners.get(event) || []).filter((x) => x !== l)); },
  };
})();`;

const clients = new Set<import('node:http').ServerResponse>();
wireEvents(ctx, (event, data) => {
  const line = `data: ${JSON.stringify({ event, data })}\n\n`;
  for (const c of clients) c.write(line);
});

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.sha256': 'text/plain' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/__events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': ok\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/__shim.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' });
    res.end(SHIM);
    return;
  }
  if (url.pathname === '/__ipc' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let channel = '';
    let payload: unknown = undefined;
    try {
      const parsed = JSON.parse(body) as { channel: string; payload: unknown };
      channel = parsed.channel;
      payload = parsed.payload === null ? undefined : parsed.payload;
    } catch {
      /* falls through to the unknown-channel answer */
    }
    const result = allowed.has(channel) ? await dispatch(handlers, channel, payload) : { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'That action is not available.' } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
    return;
  }
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '') || 'index.html';
  const target = resolve(webRoot, rel);
  if (!target.startsWith(webRoot + sep) || !existsSync(target)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  let data: Buffer | string = readFileSync(target);
  if (rel === 'index.html') {
    // The packaged app forbids all network access from the page; the bridge page needs fetch.
    data = data.toString('utf8').replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<script type="module"', '<script src="/__shim.js"></script><script type="module"');
  }
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
  res.end(data);
});

server.listen(port, host, () => process.stdout.write(`dev bridge on http://${host}:${port} (data ${dataDir})\n`));

async function shutdown(): Promise<void> {
  await ctx.dispose();
  server.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
