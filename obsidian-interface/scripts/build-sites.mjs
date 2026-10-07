#!/usr/bin/env node
/**
 * Generate the deployable site directories.
 *
 * Every product ships as its own directory with its own index.html, so it can be
 * hosted by this interface, dropped behind Cloudflare, or served from a laptop
 * behind nginx — the markup only ever asks for three things: the shared
 * stylesheet, the page bundle, and its own <div id="app">.
 *
 * No inline script is emitted anywhere: the interface ships a Content-Security-
 * Policy of `script-src 'self'`, and that promise is only worth something if the
 * generated markup never needs to be relaxed.
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
// The site directories live at the repository root so they can be deployed
// individually (each one is a complete, self-contained host directory), while
// the interface serves them from `siteRoot`.
const siteRoot = resolve(root, '..');

/**
 * Cache busting. The bundles are served from stable paths (`/js/wallet.js`),
 * so without this a browser that cached an old build keeps running it after an
 * upgrade — which is exactly how a fixed wallet page kept deriving the wrong
 * address for a user who had already upgraded. Every asset URL therefore
 * carries a content hash: the bytes change, the URL changes, and the browser
 * cannot serve a stale copy. Assets requested with a `?v=` are immutable; the
 * HTML that references them is never cached.
 */
function assetUrl(relative) {
  const full = join(root, 'public', relative);
  if (!existsSync(full)) return `/${relative}`;
  const digest = createHash('sha256').update(readFileSync(full)).digest('hex').slice(0, 16);
  return `/${relative}?v=${digest}`;
}

const SITES = [
  {
    id: 'landing',
    path: 'landing',
    bundle: 'landing',
    title: 'Obsidian Network — a decentralised ledger and the apps built on it',
    description:
      'Obsidian Network is a Proof of Time (PoT) blockchain with a hard cap of 21,000,000 OBS. Mine, hold keys you own and register .obs names — all as chain state.',
  },
  {
    id: 'mine',
    path: 'mine',
    bundle: 'mine',
    title: 'Mine OBS — Obsidian Network',
    description: 'Claim the protocol mining reward: one claim every four hours, six per cycle, paid from a fixed schedule that no admin can mint against.',
  },
  {
    id: 'wallet',
    path: 'wallet',
    bundle: 'wallet',
    title: 'Wallet — Obsidian Network',
    description: 'Create a non-custodial OBS wallet in your browser. Keys are generated locally, encrypted locally, and never transmitted.',
  },
  {
    id: 'explorer',
    path: 'explorer',
    bundle: 'explorer',
    title: 'Explorer — Obsidian Network',
    description: 'Blocks, transactions and .obs names read directly from Obsidian Core nodes. Balances are never exposed here.',
  },
  {
    id: 'ons',
    path: 'ons',
    bundle: 'ons',
    title: 'ONS — Obsidian Name Service',
    description: 'Register a .obs name that maps to one wallet, transferable as blockchain state.',
  },
  {
    id: 'developer',
    path: 'developer',
    bundle: 'developer',
    title: 'Developers — Obsidian Network',
    description: 'Run a node, read the RPC, self-host the interface, verify release checksums.',
  },
  {
    id: 'app',
    path: 'app',
    bundle: 'app',
    title: 'Account & invites — Obsidian Network',
    description: 'Invite-only accounts, node health and optional wallet linking. Keys never leave your browser.',
  },
  {
    id: 'node',
    path: 'node',
    bundle: 'node',
    title: 'Node runners — Obsidian Network',
    description:
      'Run an Obsidian Core node and earn 90% of ONS revenue. Uptime, participation and reliability are measured by the protocol from evidence other nodes attested — never self-reported.',
  },
  {
    id: 'audit',
    path: 'audit',
    bundle: 'audit',
    title: 'Compliance audit — Obsidian Network',
    description: 'Proof that the removed mechanisms are genuinely absent: no WAC, no legacy genesis allocation, no admin mint, no mining KYC, no native exchange.',
  },
];

const ICONS = `
<link rel="icon" href="/assets/logo.svg" type="image/svg+xml">
<link rel="icon" href="/assets/logo-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/assets/logo-192.png">
<link rel="manifest" href="/assets/manifest.webmanifest">
<meta name="application-name" content="Obsidian Network">`.trim();

function html(site) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${site.title}</title>
<meta name="description" content="${site.description}">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#f7f8fa">
<meta property="og:title" content="${site.title}">
<meta property="og:description" content="${site.description}">
<meta property="og:type" content="website">
${ICONS}
<link rel="stylesheet" href="${assetUrl('css/obsidian.css')}">
</head>
<body>
<div id="app">
  <noscript>
    <p style="max-width:60ch;margin:40px auto;font-family:sans-serif">
      This interface signs with keys that never leave your device, so it needs JavaScript.
      The chain itself does not: any Obsidian Core node serves the same data at its RPC port.
    </p>
  </noscript>
</div>
<script type="module" src="${assetUrl(`js/${site.bundle}.js`)}"></script>
</body>
</html>
`;
}

let written = 0;
for (const site of SITES) {
  const dir = join(siteRoot, site.path);
  mkdirSync(dir, { recursive: true });
  const markup = html(site);
  writeFileSync(join(dir, 'index.html'), markup, 'utf8');
  // The landing page doubles as the interface's own root document, so a
  // self-hoster can serve everything from one directory if they prefer.
  if (site.id === 'landing') writeFileSync(join(root, 'public', 'index.html'), markup, 'utf8');
  written += 1;
}
console.log(`wrote ${written} site shells (landing → root, others → their own directories)`);
