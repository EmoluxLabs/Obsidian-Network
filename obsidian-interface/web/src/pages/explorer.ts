/**
 * Explorer.
 *
 * Explorer privacy rule (spec §39): an explorer may show transaction amounts,
 * fees, block production and activity counts, but NEVER a wallet's balance and
 * never a partial wallet address next to a transaction. Transaction and block
 * identifiers use their own checksummed format, so a wallet address can never be
 * mistaken for a hash. The node enforces this: it refuses to serve balances on
 * the explorer surface, and this page never asks for one.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient, type BlockDetail, type BlockSummary } from '../lib/client.js';
import { el, obs, spinner, toast, kv, badge, table, short, relativeTime, when } from '../lib/ui.js';

const client = new ObsidianClient();

const searchBox = el('input', { id: 'explorer-search', placeholder: 'Block height, block id, transaction id, .obs name or parcel id', autocomplete: 'off' });
const resultPanel = el('section', { class: 'card', id: 'explorer-result' }, el('p', { class: 'muted' }, 'Search a block, a transaction, an ONS name or a parcel. Balances are not available here by design.'));
const blocksPanel = el('section', { class: 'card', id: 'blocks' }, spinner());
const statsPanel = el('section', { class: 'card', id: 'chain-stats' }, spinner());

const searchButton = el('button', { class: 'primary', type: 'button', id: 'explorer-go' }, 'Search');
searchButton.addEventListener('click', () => void search(searchBox.value.trim()));
searchBox.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void search(searchBox.value.trim());
});

layout({
  current: 'explorer',
  title: 'Explorer',
  tagline: 'Blocks, transactions, names, parcels and capsules straight from Obsidian Core nodes.',
  children: [
    el('section', { class: 'search-bar' }, searchBox, searchButton),
    resultPanel,
    statsPanel,
    blocksPanel,
  ],
});

void boot();

async function boot(): Promise<void> {
  await Promise.all([loadChainStats(), loadBlocks()]);
  window.setInterval(() => void loadBlocks(), 15_000);
}

async function loadChainStats(): Promise<void> {
  try {
    const [status, supply, network, audit] = await Promise.all([
      client.status(),
      client.supply(),
      client.network(),
      client.requestSafe<Record<string, unknown>>('/audit/decentralization'),
    ]);
    statsPanel.replaceChildren(
      el('h2', {}, 'Chain'),
      kv([
        ['Network', `${status.networkId} · chain ${status.chainId} · ${network.network?.addressHrp ?? 'obs'}1…`],
        ['Height', status.height.toLocaleString()],
        ['Head block id', el('span', { class: 'mono' }, short(status.headHash, 16))],
        ['Genesis id', el('span', { class: 'mono' }, status.genesisId)],
        ['Params hash', el('span', { class: 'mono' }, short(status.paramsHash, 16))],
        ['Protocol version', status.protocolVersion],
        ['Supply', `${obs(status.supplyObs)} OBS of ${obs(status.maxSupplyObs)} OBS`],
        ['Mining pool', `${obs(supply.poolBalanceObs)} OBS`],
        ['Peers', String(status.peers)],
        ['Last block', `${relativeTime(status.lastBlockTimestamp)} (${when(status.lastBlockTimestamp)})`],
        ['Genesis allocation', status.genesis ? `${status.genesis.allocationClaimed ? 'claimed' : 'unclaimed'} · ${obs(status.genesis.allocationObs)} OBS` : '—'],
      ]),
      ...(audit
        ? [el('div', {}, el('h3', {}, 'Decentralisation'), kv(Object.entries(audit).slice(0, 8).map(([key, value]) => [key, String(value)])))]
        : []),
      el('p', { class: 'fineprint' }, 'Every field above is recomputed by each node from the chain. Balances are deliberately absent: the explorer surface never exposes them.'),
    );
  } catch (error) {
    statsPanel.replaceChildren(el('h2', {}, 'Chain'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function loadBlocks(): Promise<void> {
  try {
    const { blocks } = await client.blocks(15);
    blocksPanel.replaceChildren(
      el('h2', {}, 'Latest blocks'),
      table(
        ['Height', 'Block id', 'Transactions', 'Size', 'Age'],
        blocks.map((block: BlockSummary) => [
          el('a', { class: 'mono link', href: `#/block/${block.height}` }, String(block.height)),
          el('a', { class: 'mono link', href: `#/block/${block.hash}` }, short(block.hash, 12)),
          String(block.txCount),
          `${block.size} B`,
          relativeTime(block.timestamp),
        ]),
      ),
    );
  } catch (error) {
    blocksPanel.replaceChildren(el('h2', {}, 'Latest blocks'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function search(term: string): Promise<void> {
  if (!term) return;
  resultPanel.replaceChildren(spinner('asking the nodes…'));
  try {
    if (/^\d+$/.test(term)) return void renderBlock(await client.block(term));
    if (/\.obs$/i.test(term)) {
      const record = await client.name(term.toLowerCase());
      resultPanel.replaceChildren(
        el('h2', {}, `ONS · ${term.toLowerCase()}`),
        kv([
          ['Resolves to (wallet address)', el('span', { class: 'mono' }, short(record.address, 18))],
          ['Registered at height', String(record.registeredAtHeight ?? '—')],
          ['Expires at height', String(record.expiresAt ?? '—')],
          ['Transfers', record.transferCount === 0 ? badge('never transferred', 'neutral') : badge(`${record.transferCount} transfers`, 'ok')],
        ]),
        el('p', { class: 'fineprint' }, 'A name maps to exactly one wallet. Transfers are blockchain state transitions, not rows in a company database.'),
      );
      return;
    }
    if (/^PAR-|^par-/.test(term) || term.includes('/')) {
      const parcel = await client.landParcel(term);
      resultPanel.replaceChildren(
        el('h2', {}, `Parcel · ${term}`),
        kv(Object.entries(parcel).slice(0, 10).map(([key, value]) => [key, String(value)])),
      );
      return;
    }
    const tx = await client.transaction(term);
    resultPanel.replaceChildren(
      el('h2', {}, `Transaction ${short(term, 14)}`),
      kv([
        ['Included in block', String(tx.height ?? 'mempool')],
        ['Type', String(tx.kind ?? tx.type ?? '—')],
        ['Amount', tx.amount !== undefined && tx.amount !== null ? `${obs(tx.amount)} OBS` : '—'],
        ['Gas paid', tx.gas !== undefined ? `${obs(tx.gas)} OBS` : '—'],
        ['Timestamp', tx.timestamp ? `${when(Number(tx.timestamp))}` : 'pending'],
        ['Sender (masked by the node)', el('span', { class: 'mono' }, short(String(tx.sender ?? '—'), 18))],
        ['Recipient (masked by the node)', el('span', { class: 'mono' }, short(String(tx.recipient ?? '—'), 18))],
        ['Confirmations', String(tx.confirmations ?? '—')],
      ]),
      el('p', { class: 'fineprint' }, 'Addresses shown here are masked by the node before they leave it: an explorer page cannot be used to look up a wallet\'s holdings.'),
    );
  } catch (error) {
    toast((error as Error).message, 'error');
    resultPanel.replaceChildren(el('p', { class: 'error' }, (error as Error).message));
  }
}

async function renderBlock(block: BlockDetail): Promise<void> {
  const txs = block.transactions;
  resultPanel.replaceChildren(
    el('h2', {}, `Block ${block.header.height}`),
    kv([
      ['Block id', el('span', { class: 'mono' }, short(block.hash, 24))],
      ['Parent', el('span', { class: 'mono' }, short(block.header.prevHash, 24))],
      ['Producer', el('span', { class: 'mono' }, short(block.header.producer, 18))],
      ['Timestamp', `${when(block.header.timestamp)} (${relativeTime(block.header.timestamp)})`],
      ['Transactions', String(txs.length)],
      ['Size', `${block.summary.size} B`],
      ['State root', el('span', { class: 'mono' }, short(block.header.stateRoot, 24))],
      ['Confirmations', String(block.confirmations)],
    ]),
    txs.length > 0
      ? table(
          ['Transaction id', 'Type', 'Gas', 'Sender (masked)'],
          txs.map((tx) => [
            el('span', { class: 'mono' }, short(tx.id, 18)),
            String(tx.type),
            `${obs(tx.gas)} OBS`,
            el('span', { class: 'mono' }, short(tx.sender, 14)),
          ]),
        )
      : el('p', { class: 'muted' }, 'This block contains no transactions.'),
    el('p', { class: 'fineprint' }, 'Block producers and transaction senders are masked by the node before they leave it.'),
  );
}

void (async () => {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash) return;
  const [kind, ...rest] = hash.split('/');
  const value = rest.join('/');
  if (kind === 'block' && value) {
    searchBox.value = value;
    void search(value);
  } else if (kind === 'tx' && value) {
    searchBox.value = value;
    void search(value);
  }
})();
