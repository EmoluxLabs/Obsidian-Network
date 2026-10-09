import { html } from '../dom.js';
import { formatInt, formatTime, shortHash } from '../format.js';
import { navigate } from '../router.js';
import { displayState, store } from '../store.js';
import { badge, emptyCard, loadingCard, mono, pageHead, registerActions, toast, unavailableCard, warn } from '../ui.js';
import { setExplorerQuery } from './explorer.js';
import { call, load, poller, type Loadable, type Screen } from './common.js';
import type { SubmissionRecord, TxStatus } from '../../shared/tx-types.js';
import type { MempoolInfo } from '../../shared/chain-types.js';
import type { Tone } from '../store.js';

let records: Loadable<SubmissionRecord[]> = { state: 'idle' };
const live = new Map<string, TxStatus>();
let pool: Loadable<MempoolInfo> = { state: 'idle' };
let resubmitting: string | null = null;

const p = poller(async () => {
  records = await load(() => call('tx:submissions'));
  if (store.node?.phase === 'running') pool = await load(() => call('explorer:mempool'));
  else pool = { state: 'idle' };
  if (records.state === 'ready') {
    const watch = records.data.filter((r) => r.state === 'submitted').slice(0, 20);
    await Promise.all(
      watch.map(async (r) => {
        const known = live.get(r.txId);
        if (known?.live === 'confirmed' && known.confirmations >= 12) return; // settled; stop asking
        try {
          live.set(r.txId, await call('tx:status', { txId: r.txId }));
        } catch (error) {
          live.set(r.txId, { txId: r.txId, live: 'unavailable', confirmations: 0, message: (error as Error).message });
        }
      }),
    );
  }
}, 5000);

function stateBadge(r: SubmissionRecord): unknown {
  if (r.state === 'rejected') return badge('REJECTED', 'er');
  if (r.state === 'submitting') return badge('SUBMITTING…', 'wn');
  if (r.state === 'unknown') return badge('RESULT UNKNOWN', 'wn');
  const l = live.get(r.txId);
  if (!l) return badge('SUBMITTED', 'wn');
  const map: Record<TxStatus['live'], [string, Tone]> = {
    pending: ['PENDING IN NODE POOL', 'wn'],
    confirmed: [`CONFIRMED · ${l.confirmations}`, 'ok'],
    'not-found': ['NOT FOUND BY NODE', 'er'],
    unavailable: ['STATUS UNAVAILABLE', 'mu'],
  };
  const [text, tone] = map[l.live];
  return badge(text, tone);
}

export const tx: Screen = {
  enter: () => p.start(),
  leave: () => p.stop(),
  render() {
    const head = pageHead('Transactions', 'Transactions');
    const s = displayState();
    const running = s === 'synced' || s === 'syncing';
    return html`${head}
    <div class="g g3" style="margin-top:18px">
      <div class="card"><div class="k">Sent from this app</div><div class="v m">${records.state === 'ready' ? formatInt(records.data.length) : '—'}</div><div class="sub">This session’s submissions</div></div>
      <div class="card"><div class="k">Node transaction pool</div><div class="v m">${pool.state === 'ready' ? formatInt(pool.data.size) : '—'}</div><div class="sub">${pool.state === 'ready' ? 'Waiting for a block' : running ? 'Loading…' : 'Node not running'}</div></div>
      <div class="card"><div class="k">Confirmation</div><div class="v" style="font-size:15px">Only when a block includes it</div><div class="sub">A transaction is never called successful before the node says so</div></div>
    </div>
    <div class="card" style="margin-top:14px"><div class="k">Submitted from this app</div>${list(running)}</div>
    <div class="card" style="margin-top:14px"><div class="k">Look up a transaction</div><form data-submit="tx.lookup" style="margin-top:10px;display:flex;gap:10px"><input class="in m" id="tx-lookup" placeholder="Transaction id (64 hex characters)" autocomplete="off" spellcheck="false" style="flex:1"><button class="btn" type="submit">Look up</button></form></div>
    ${pool.state === 'ready' && pool.data.transactions.length > 0 ? html`<div class="card" style="margin-top:14px"><div class="k">Pending in the node’s pool</div><table><thead><tr><th>Id</th><th>Type</th><th>Sender</th><th>Gas</th></tr></thead><tbody>${pool.data.transactions.slice(0, 25).map((t) => html`<tr><td class="m"><button class="lk" data-action="tx.open" data-tx="${t.txId}">${shortHash(t.txId, 8, 6)}</button></td><td>${t.type}</td><td class="m">${shortHash(t.sender, 12, 6)}</td><td class="m">${t.gas}</td></tr>`)}</tbody></table></div>` : ''}`;
  },
};

function list(running: boolean): unknown {
  if (records.state === 'idle' || records.state === 'loading') return loadingCard();
  if (records.state !== 'ready') return unavailableCard('Could not read submissions', records.state === 'error' || records.state === 'unavailable' ? records.message : '', 'er');
  if (records.data.length === 0) return html`<div class="sub" style="margin-top:8px">Nothing sent yet. Transfers and validator actions you authorize appear here, with their real state.</div>`;
  return html`<table><thead><tr><th>Time</th><th>Action</th><th>Id</th><th>State</th><th></th></tr></thead><tbody>${records.data.map((r) => html`<tr><td class="m">${formatTime(r.submittedAt)}</td><td>${r.summary}${r.error ? html`<div class="sub er-t">${r.error}</div>` : ''}</td><td class="m">${mono(r.txId, { short: true, copy: true })}</td><td>${stateBadge(r)}</td><td>${r.state === 'unknown' ? html`<button class="btn" data-action="tx.resubmit" data-tx="${r.txId}" ${!running || resubmitting ? 'disabled' : ''}>${resubmitting === r.txId ? 'Sending…' : 'Check & resend'}</button>` : ''}</td></tr>`)}</tbody></table>${records.data.some((r) => r.state === 'unknown') ? warn('“Result unknown” means the node did not answer in time. “Check & resend” sends the identical signed bytes; the node ignores a duplicate, so it cannot pay twice.') : ''}`;
}

registerActions({
  'tx.lookup': async () => {
    const q = (document.getElementById('tx-lookup') as HTMLInputElement | null)?.value.trim() ?? '';
    if (!q) return toast('Enter a transaction id.', 'wn');
    setExplorerQuery(q);
    navigate('explorer');
  },
  'tx.resubmit': async (el) => {
    const id = el.dataset.tx ?? '';
    resubmitting = id;
    try {
      const result = await call('tx:resubmit', { txId: id });
      toast(result.state === 'submitted' ? 'The node has the transaction.' : result.error ?? 'The node refused it.', result.state === 'submitted' ? 'ok' : 'er', 6000);
    } finally {
      resubmitting = null;
      p.now();
    }
  },
});
void emptyCard;
