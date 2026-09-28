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
import { ObsidianClient, type BlockSummary } from '../lib/client.js';
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
        ['Mining pool', String((supply as { poolObs?: string }).poolObs ?? '—')],
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
          String(block.transactionCount),
          `${block.sizeBytes} B`,
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
          ['Owner (public key hash)', el('span', { class: 'mono' }, short(String(record.address ?? ''), 14))],
          ['Registered at height', String(record.registeredAt ?? record.height ?? '—')],
          ['Expires at height', String(record.expiresAt ?? '—')],
          ['Status', record.transferable === false ? badge('locked', 'warn') : badge('transferable', 'ok')],
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
        ['Type', String(tx.type ?? tx.kind ?? '—')],
        ['Amount', tx.amount !== undefined && tx.amount !== null ? `${obs(String(tx.amount))} OBS` : '—'],
        ['Gas paid', tx.gas !== undefined ? `${obs(String(tx.gas))} OBS` : '—'],
        ['Timestamp', tx.timestamp ? `${when(Number(tx.timestamp))}` : 'pending'],
        ['Sender', el('span', { class: 'mono' }, short(String(tx.senderMasked ?? tx.sender ?? '—'), 14))],
        ['Recipient', el('span', { class: 'mono' }, short(String(tx.recipientMasked ?? tx.recipient ?? '—'), 14))],
      ]),
      el('p', { class: 'fineprint' }, 'Addresses shown here are masked by the node before they leave it: an explorer page cannot be used to look up a wallet\'s holdings.'),
    );
  } catch (error) {
    toast((error as Error).message, 'error');
    resultPanel.replaceChildren(el('p', { class: 'error' }, (error as Error).message));
  }
}

async function renderBlock(blockRef: { height?: number; hash?: string; [key: string]: unknown }): Promise<void> {
  const height = Number(blockRef.height ?? 0);
  const txs = (blockRef.transactions as Array<Record<string, unknown>> | undefined) ?? [];
  resultPanel.replaceChildren(
    el('h2', {}, `Block ${height}`),
    kv([
      ['Block id', el('span', { class: 'mono' }, short(String(blockRef.hash ?? ''), 20))],
      ['Parent', el('span', { class: 'mono' }, short(String(blockRef.prevHash ?? ''), 20))],
      ['Producer', el('span', { class: 'mono' }, short(String(blockRef.producer ?? ''), 16))],
      ['Timestamp', `${when(Number(blockRef.timestamp ?? 0))}`],
      ['Transactions', String(txs.length)],
      ['Size', `${blockRef.sizeBytes ?? '—'} B`],
    ]),
    txs.length > 0
      ? table(
          ['Transaction id', 'Type', 'Amount', 'Recipient'],
          txs.map((tx) => [
            el('span', { class: 'mono' }, short(String(tx.txId ?? ''), 14)),
            String(tx.kind ?? tx.type ?? '—'),
            tx.amount ? `${obs(String(tx.amount))} OBS` : '—',
            el('span', { class: 'mono' }, short(String(tx.recipientMasked ?? '—'), 12)),
          ]),
        )
      : el('p', { class: 'muted' }, 'This block contains no transactions.'),
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
