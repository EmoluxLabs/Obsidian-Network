import { html } from '../dom.js';
import { ago, formatBytes, formatDateTime, formatInt, formatObs, shortHash } from '../format.js';
import { displayState, store } from '../store.js';
import { badge, emptyCard, loadingCard, mono, pageHead, registerActions, toast, unavailableCard, requestRender } from '../ui.js';
import { call, poller, type Screen } from './common.js';
import { takePendingTx } from './wallet.js';
import type { AddressHistory, BlockDetail, BlockSummary, TxRecord } from '../../shared/chain-types.js';

type View =
  | { kind: 'list' }
  | { kind: 'loading'; label: string }
  | { kind: 'block'; data: BlockDetail }
  | { kind: 'tx'; data: TxRecord }
  | { kind: 'address'; data: AddressHistory }
  | { kind: 'error'; message: string };

let view: View = { kind: 'list' };
let list: { blocks: BlockSummary[]; head: number } | null = null;
let listError: string | null = null;
let before: number | undefined;
const trail: Array<number | undefined> = [];
let searchText = '';
let queued = '';

export function setExplorerQuery(q: string): void {
  queued = q;
}

const p = poller(async () => {
  if (store.node?.phase !== 'running') {
    list = null;
    return;
  }
  if (view.kind !== 'list') return;
  try {
    list = await call('explorer:blocks', { beforeHeight: before, limit: 20 });
    listError = null;
  } catch (error) {
    listError = (error as Error).message;
  }
}, 5000);

async function open(query: string): Promise<void> {
  searchText = query;
  view = { kind: 'loading', label: `Searching for ${shortHash(query, 14, 8)}…` };
  requestRender();
  try {
    const found = await call('explorer:search', { query });
    if (found.kind === 'none') view = { kind: 'error', message: found.message };
    else if (found.kind === 'block') view = { kind: 'block', data: await call('explorer:block', { query: found.query }) };
    else if (found.kind === 'tx') view = { kind: 'tx', data: await call('explorer:tx', { txId: found.query }) };
    else view = { kind: 'address', data: await call('explorer:address', { address: found.query }) };
  } catch (error) {
    view = { kind: 'error', message: (error as Error).message };
  }
  requestRender();
}

export const explorer: Screen = {
  enter() {
    const q = takePendingTx() || queued;
    queued = '';
    if (q) void open(q);
    p.start();
  },
  leave: () => p.stop(),
  render() {
    const s = displayState();
    const head = pageHead('Blockchain Explorer', 'Blockchain Explorer');
    const running = s === 'synced' || s === 'syncing';
    const form = html`<form data-submit="explorer.search" class="card" style="margin-top:18px;display:flex;gap:10px;align-items:center"><input class="in m" id="ex-q" style="flex:1" value="${searchText}" placeholder="Block height, block hash, transaction id or address" autocomplete="off" spellcheck="false" aria-label="Search the chain"><button class="btn p" type="submit" ${running ? '' : 'disabled'}>Search</button></form>`;
    if (!running) return html`${head}${form}<div style="margin-top:14px">${unavailableCard('The node is not running', 'The explorer reads blocks and transactions from your own node. Start the node to browse the chain.', 'mu')}</div>`;
    if (view.kind === 'loading') return html`${head}${form}<div style="margin-top:14px">${loadingCard(view.label)}</div>`;
    if (view.kind === 'error') return html`${head}${form}<div style="margin-top:14px">${unavailableCard('Nothing found', view.message, 'wn')}</div><div style="margin-top:12px"><button class="btn" data-action="explorer.back">Back to latest blocks</button></div>`;
    if (view.kind === 'block') return html`${head}${form}${blockView(view.data)}`;
    if (view.kind === 'tx') return html`${head}${form}${txView(view.data)}`;
    if (view.kind === 'address') return html`${head}${form}${addressView(view.data)}`;
    return html`${head}${form}${listView()}`;
  },
};

function listView(): unknown {
  if (listError && !list) return html`<div style="margin-top:14px">${unavailableCard('Blocks could not be read', listError, 'er')}</div>`;
  if (!list) return html`<div style="margin-top:14px">${loadingCard('Loading blocks…')}</div>`;
  if (list.blocks.length === 0) return html`<div style="margin-top:14px">${emptyCard('No blocks yet', 'The chain has no blocks to show.')}</div>`;
  const oldest = list.blocks[list.blocks.length - 1]!.height;
  return html`<div class="card" style="margin-top:14px"><div style="display:flex;justify-content:space-between;align-items:center"><div class="k">${before === undefined ? 'Latest blocks' : `Blocks below #${formatInt(before)}`}</div><span class="sub">Chain height ${formatInt(list.head)}</span></div>
    <table><thead><tr><th>Height</th><th>Hash</th><th>Age</th><th>Txs</th><th>Producer</th><th>Size</th></tr></thead><tbody>${list.blocks.map((b) => html`<tr><td class="m"><button class="lk" data-action="explorer.open" data-q="${b.height}">${formatInt(b.height)}</button></td><td class="m">${shortHash(b.hash, 10, 6)}</td><td>${ago(Math.max(0, (store.snap?.health?.timestamp ?? b.timestamp) - b.timestamp))}</td><td class="m">${b.txCount}</td><td class="m">${b.producer}</td><td class="m">${formatBytes(b.size)}</td></tr>`)}</tbody></table>
    <div style="display:flex;gap:10px;margin-top:12px"><button class="btn" data-action="explorer.newer" ${trail.length === 0 ? 'disabled' : ''}>Newer</button><button class="btn" data-action="explorer.older" data-before="${oldest}" ${oldest <= 0 ? 'disabled' : ''}>Older</button></div></div>`;
}

function blockView(d: BlockDetail): unknown {
  const b = d.summary;
  return html`<div style="margin-top:14px"><button class="btn" data-action="explorer.back">← Latest blocks</button></div>
  <div class="card" style="margin-top:14px"><div class="k">Block ${formatInt(b.height)}</div>
    <div class="row"><span>Hash</span>${mono(b.hash, { copy: true })}</div>
    <div class="row"><span>Previous block</span>${b.height > 0 ? html`<button class="lk m" data-action="explorer.open" data-q="${b.prevHash}">${shortHash(b.prevHash, 14, 8)}</button>` : html`<span class="m">none (genesis)</span>`}</div>
    <div class="row"><span>Time</span><span class="m">${formatDateTime(b.timestamp)}</span></div>
    <div class="row"><span>Producer</span><span class="m">${d.producer}</span></div>
    <div class="row"><span>Confirmations</span><span class="m">${formatInt(d.confirmations)}</span></div>
    <div class="row"><span>Transactions</span><span class="m">${b.txCount}</span></div>
    <div class="row"><span>State root</span>${mono(d.stateRoot, { short: true, copy: true })}</div>
    <div class="row"><span>Transaction root</span>${mono(d.txRoot, { short: true, copy: true })}</div>
    <div class="row"><span>Protocol version</span><span class="m">${d.protocolVersion}</span></div></div>
  ${d.transactions.length ? html`<div class="card" style="margin-top:14px"><div class="k">Transactions in this block</div><table><thead><tr><th>Id</th><th>Type</th><th>Sender</th><th>Nonce</th><th>Gas</th></tr></thead><tbody>${d.transactions.map((t) => html`<tr><td class="m"><button class="lk" data-action="explorer.open" data-q="${t.id}">${shortHash(t.id, 8, 6)}</button></td><td>${t.type}</td><td class="m">${shortHash(t.sender, 12, 6)}</td><td class="m">${t.nonce}</td><td class="m">${t.gas}</td></tr>`)}</tbody></table></div>` : ''}`;
}

function txView(t: TxRecord): unknown {
  return html`<div style="margin-top:14px"><button class="btn" data-action="explorer.back">← Latest blocks</button></div>
  <div class="card" style="margin-top:14px"><div class="k">Transaction</div>
    <div class="row"><span>Id</span>${mono(t.txId, { copy: true })}</div>
    <div class="row"><span>Status</span>${badge(t.status === 'INCLUDED' ? `CONFIRMED${t.confirmations !== undefined ? ` · ${t.confirmations}` : ''}` : 'PENDING', t.status === 'INCLUDED' ? 'ok' : 'wn')}</div>
    <div class="row"><span>Type</span><span>${t.kind ?? t.type}</span></div>
    <div class="row"><span>Sender</span>${mono(t.sender, { copy: true })}</div>
    ${t.recipient ? html`<div class="row"><span>Recipient</span>${mono(t.recipient, { copy: true })}</div>` : ''}
    ${t.amount !== undefined ? html`<div class="row"><span>Amount</span><span class="m">${formatObs(t.amount)} OBS</span></div>` : ''}
    <div class="row"><span>Gas</span><span class="m">${t.gas}</span></div>
    ${t.height !== undefined ? html`<div class="row"><span>Block</span><button class="lk m" data-action="explorer.open" data-q="${t.height}">${formatInt(t.height)}</button></div>` : ''}
    ${t.timestamp ? html`<div class="row"><span>Time</span><span class="m">${formatDateTime(t.timestamp)}</span></div>` : ''}
    ${t.memo ? html`<div class="row"><span>Memo</span><span>${t.memo}</span></div>` : ''}</div>`;
}

function addressView(a: AddressHistory): unknown {
  return html`<div style="margin-top:14px"><button class="btn" data-action="explorer.back">← Latest blocks</button></div>
  <div class="card" style="margin-top:14px"><div class="k">Address</div><div style="margin-top:8px">${mono(a.address, { copy: true })}</div></div>
  <div class="card" style="margin-top:14px"><div class="k">Recent transactions</div>${a.transactions.length === 0 ? html`<div class="sub" style="margin-top:8px">No transactions for this address on this chain.</div>` : html`<table><thead><tr><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Status</th><th>Id</th></tr></thead><tbody>${a.transactions.map((t) => html`<tr><td>${t.kind ?? t.type}</td><td class="m">${shortHash(t.sender, 10, 6)}</td><td class="m">${shortHash(t.recipient, 10, 6)}</td><td class="m">${t.amount !== undefined ? formatObs(t.amount) : '—'}</td><td>${badge(t.status === 'INCLUDED' ? 'CONFIRMED' : 'PENDING', t.status === 'INCLUDED' ? 'ok' : 'wn')}</td><td class="m"><button class="lk" data-action="explorer.open" data-q="${t.txId}">${shortHash(t.txId, 8, 6)}</button></td></tr>`)}</tbody></table>`}</div>`;
}

registerActions({
  'explorer.search': async () => {
    const q = (document.getElementById('ex-q') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!q) return toast('Enter something to search for.', 'wn');
    await open(q);
  },
  'explorer.open': (el) => open(el.dataset.q ?? ''),
  'explorer.back': () => {
    view = { kind: 'list' };
    searchText = '';
    p.now();
  },
  'explorer.older': (el) => {
    trail.push(before);
    before = Number(el.dataset.before);
    list = null;
    p.now();
  },
  'explorer.newer': () => {
    before = trail.pop();
    list = null;
    p.now();
  },
});
