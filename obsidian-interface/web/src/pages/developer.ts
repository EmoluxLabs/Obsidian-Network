/**
 * Developers.
 *
 * This page is the honest short version of the node/RPC documentation: what the
 * API is, what the p2p layer expects, how the interface reads a node and how to
 * self-host. No aspirational endpoints that do not exist.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { el, spinner, kv, table, badge, toast, copyButton } from '../lib/ui.js';

const client = new ObsidianClient();
const live = el('section', { class: 'card' }, spinner('asking the nodes…'));

layout({
  current: 'developer',
  title: 'Developers',
  tagline: 'Run a node, read the RPC, host the interface yourself. Everything here is verifiable on a laptop.',
  children: [
    live,
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Run a node'),
      el(
        'pre',
        { class: 'code' },
        [
          'git clone https://github.com/EmoluxLabs/Obsidian-Network.git',
          'cd Obsidian-Network/obsidian-core',
          'npm ci && npm run build',
          'OBSIDIAN_KEYSTORE_PASSPHRASE="a-strong-passphrase" \\',
          '  node dist/index.js start --network devnet --port-offset 1000 \\',
          '    --mine --seeds obs1seed.example:38631',
        ].join('\n'),
      ),
      el('div', { class: 'row' }, copyButton(() => 'node dist/index.js start --network devnet --port-offset 1000 --mine', 'Copy start command')),
      el('p', { class: 'fineprint' }, 'A node reconstructs state from blocks and validates every transaction. It needs no account, no database server and no permission from anyone.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Read a node'),
      el('p', {}, 'The RPC surface is plain JSON over HTTP. Reads are safe to cache; writes require a signed transaction.'),
      table(
        ['Method', 'Route', 'Purpose'],
        [
          ['GET', el('span', { class: 'mono' }, '/status'), 'height, head, supply, peers, genesis allocation state'],
          ['GET', el('span', { class: 'mono' }, '/mining/status?address=…'), 'eligibility, next claim id, reward per claim (protocol time)'],
          ['POST', el('span', { class: 'mono' }, '/tx/submit'), 'submit signed transaction bytes'],
          ['POST', el('span', { class: 'mono' }, '/wallet/balance'), 'balance of an address you already know'],
          ['GET', el('span', { class: 'mono' }, '/blocks?limit='), 'recent blocks'],
          ['GET', el('span', { class: 'mono' }, '/names, /land/countries, /capsules, /social/feed'), 'application state straight from chain data'],
          ['GET', el('span', { class: 'mono' }, '/audit/{decentralization,compliance}'), 'mining distribution and the compliance report'],
        ],
      ),
      el('p', { class: 'fineprint' }, 'Error codes are protocol codes (`ERR_INSUFFICIENT_FUNDS`, `ERR_BAD_NONCE`, `ERR_MINING_TOO_SOON`, …). They are stable, and a client should display them rather than guess.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Self-host this interface'),
      el(
        'pre',
        { class: 'code' },
        [
          'git clone https://github.com/EmoluxLabs/Obsidian-Network.git',
          'cd Obsidian-Network/obsidian-interface',
          'npm ci && npm run build',
          'OBSIDIAN_NODE_URLS="http://127.0.0.1:8630,http://node2.example:8630" \\',
          '  node dist/server/index.js --port 8788',
        ].join('\n'),
      ),
      el(
        'p',
        {},
        'The interface keeps no chain state of its own: it proxies reads to whichever node is healthiest and fails over automatically. ' +
          'It stores only the accounts it invited (no keys, ever) and serves the browser bundle it just built.',
      ),
      el('p', { class: 'fineprint' }, 'Cloudflare is not part of consensus. If every CDN in the world went down, the nodes would keep producing blocks and any operator could serve this same bundle from a laptop.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Release integrity'),
      el('p', {}, 'Each release in /releases is an archive with a SHA-256 checksum list. Verify before you run a binary that will hold keys:'),
      el('pre', { class: 'code' }, 'sha256sum --check SHA256SUMS\nsha256sum obsidian-core-1.0.0.tar.gz   # compare against the published digest'),
      el('p', { class: 'fineprint' }, 'Nodes also compare core version, protocol version, network id and genesis id when they handshake, so a mismatched binary is rejected instead of corrupting your view of the chain.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Prices and the oracle'),
      el(
        'p',
        {},
        'Dollar-priced features (ONS registration, business pages, land) convert through the protocol price: the median of at least two independent submissions, published on chain, bounded and time-limited. ' +
          'If fewer than two sources are fresh, the protocol refuses the transaction with `ERR_ORACLE_UNAVAILABLE`. It never guesses, and the interface cannot price anything on its own.',
      ),
    ),
  ],
});

void (async () => {
  try {
    const [status, network, peers] = await Promise.all([client.status(), client.network(), client.peers().catch(() => undefined)]);
    live.replaceChildren(
      el('h2', {}, 'This deployment'),
      kv([
        ['Node it is reading', 'chosen by health and height among the configured nodes'],
        ['Network', `${status.networkId} · chain ${status.chainId} · hrp ${network.network?.addressHrp ?? 'obs'}`],
        ['Genesis id', el('span', { class: 'mono' }, status.genesisId)],
        ['Params hash', el('span', { class: 'mono' }, status.paramsHash)],
        ['Protocol version', status.protocolVersion],
        ['Height', status.height.toLocaleString()],
        ['Peers', String(status.peers)],
        ['Peer detail', peers ? Object.keys(peers).join(', ') : 'unavailable'],
      ]),
      el('div', { class: 'row' }, badge('self-hostable', 'ok'), badge('no key custody', 'ok'), badge('no admin mint', 'ok')),
      el('div', { class: 'row' }, copyButton(() => window.location.origin, 'Copy this interface URL')),
    );
  } catch (error) {
    live.replaceChildren(el('h2', {}, 'This deployment'), el('p', { class: 'error' }, (error as Error).message));
    toast((error as Error).message, 'error');
  }
})();

