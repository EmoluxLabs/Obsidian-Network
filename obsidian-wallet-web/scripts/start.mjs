#!/usr/bin/env node
/**
 * Start the wallet for ONE network:  node scripts/start.mjs <mainnet|testnet|staging|devnet>
 *
 * The wallet is served by the web app's own hardened server (obsidian-app-web/server/main.mjs): the same network check
 * at start, the same origin check, security headers, body cap and read-through gateway to the platform. Three settings
 * make it the wallet and not the full app:
 *
 *   APP_PUBLIC_DIR       this package's public/
 *   APP_API_ALLOW        /api/rpc only: chain reads and transaction relay. No sign-in, no account routes, no nodes.
 *   APP_STRICT_SCRIPTS   script-src 'self': this page has no inline script and no inline handler, so none can run.
 *
 * Ports: mainnet 8791, testnet 18791, staging 28791, devnet 38791 (the web app uses 8790 / 18790 / 28790 / 38790).
 * The platform URL is the network's own platform port on this machine, as for the web app; mainnet must be told.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const appWeb = resolve(root, '..', 'obsidian-app-web');

const PORT = { mainnet: 8791, testnet: 18791, staging: 28791, devnet: 38791 };
const wanted = process.argv[2] ?? process.env.OBSIDIAN_APP_NETWORK;
if (!PORT[wanted]) {
  console.error(`usage: node scripts/start.mjs <${Object.keys(PORT).join('|')}>`);
  process.exit(2);
}
const already = process.env.OBSIDIAN_APP_NETWORK;
if (already && already.toLowerCase() !== wanted) {
  console.error(`refusing to start: this is the ${wanted} entry point but OBSIDIAN_APP_NETWORK is ${already}.`);
  process.exit(2);
}

// In this process, not a child: the server is then this process, and stopping it stops the server.
process.argv[2] = wanted;
process.env.APP_PORT ??= String(PORT[wanted]);
process.env.APP_PUBLIC_DIR = resolve(root, 'public');
process.env.APP_API_ALLOW = '/api/rpc';
process.env.APP_STRICT_SCRIPTS = 'true';
await import(pathToFileURL(resolve(appWeb, 'scripts', 'start.mjs')).href);
