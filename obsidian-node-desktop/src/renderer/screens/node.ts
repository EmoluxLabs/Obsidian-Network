import { html } from '../dom.js';
import { formatDuration, formatInt, formatTime } from '../format.js';
import { DISPLAY, displayState, networkLabel, store } from '../store.js';
import { badge, mono, pageHead, registerActions, warn } from '../ui.js';
import { navigate } from '../router.js';
import { statusCard } from './overview.js';
import { call, load, poller, type Loadable, type Screen } from './common.js';
import type { PeersInfo } from '../../shared/chain-types.js';

let identity: Loadable<PeersInfo> = { state: 'idle' };
const p = poller(async () => {
  if (store.node?.phase !== 'running') {
    identity = { state: 'idle' };
    return;
  }
  const detail = await call('chain:detail');
  identity = detail.peers;
}, 5000);

export const nodeScreen: Screen = {
  enter: () => p.start(),
  leave: () => p.stop(),
  render() {
    const node = store.node;
    const s = displayState();
    const parts: unknown[] = [pageHead('Node', 'Node Management'), html`<div style="margin-top:18px">${statusCard()}</div>`];
    if (node?.externalNodeDetected && s !== 'synced' && s !== 'syncing' && s !== 'connecting') {
      parts.push(html`<div style="margin-top:14px">${warn(`Another program already answers on ${node.rpcUrl}. Obsidian Node does not take over or start a second node on that port.`)}</div>`);
    }
    if (node?.error && (s === 'failed' || s === 'stopped')) {
      parts.push(html`<div style="margin-top:14px">${warn(html`<b>${node.error.code}</b> — ${node.error.message}`, 'er')}</div>`);
    }
    if (node?.lastExit && (s === 'failed' || s === 'stopped')) {
      parts.push(html`<div class="sub" style="margin-top:8px">Last exit: ${node.lastExit.signal ? `signal ${node.lastExit.signal}` : `code ${node.lastExit.code}`} at ${formatTime(node.lastExit.at)}.</div>`);
    }
    const uptime = node?.startedAt && node.phase === 'running' ? (store.now - node.startedAt) / 1000 : null;
    const idAddress = identity.state === 'ready' ? identity.data.identity : null;
    parts.push(html`<div class="g g2" style="margin-top:14px">
      <div class="card"><div class="k">Process</div>
        <div class="row"><span>State</span>${badge(DISPLAY[s].badge, DISPLAY[s].tone)}</div>
        <div class="row"><span>Network</span><b>${networkLabel(node?.network)}</b></div>
        <div class="row"><span>Process id</span><span class="m">${node?.pid ?? '—'}</span></div>
        <div class="row"><span>Running for</span><span class="m">${uptime !== null ? formatDuration(uptime) : '—'}</span></div>
        <div class="row"><span>Local RPC</span><span class="m">${node?.rpcUrl ?? '—'}</span></div>
        <div class="row"><span>Peer-to-peer port</span><span class="m">${node ? formatInt(node.p2pPort).replace(/,/g, '') : '—'}</span></div>
        <div class="sub" style="margin-top:8px">The RPC listens on this computer only. It is not exposed to your network.</div></div>
      <div class="card"><div class="k">Data and identity</div>
        <div class="row"><span>Data directory</span>${mono(node?.dataDir, { copy: true })}</div>
        <div class="row"><span>Chain data on disk</span>${badge(node?.chainDataPresent ? 'PRESENT' : 'NONE YET', node?.chainDataPresent ? 'ok' : 'mu')}</div>
        <div class="row"><span>Node identity key</span>${mono(node?.keystorePath, { copy: true })}</div>
        <div class="row"><span>Node identity address</span>${idAddress ? mono(idAddress, { short: true, copy: true }) : html`<span class="m">${node?.phase === 'running' ? 'reading…' : '—'}</span>`}</div>
        <div class="sub" style="margin-top:8px">The identity key is encrypted on disk. Back up the data directory; the key cannot be recovered from the chain.</div></div>
    </div>`);
    const logs = store.logs.slice(-12).reverse();
    parts.push(html`<div class="card" style="margin-top:14px"><div style="display:flex;justify-content:space-between"><div class="k">Latest log lines</div><button class="lk" data-action="nav" data-route="logs">Open logs &amp; diagnostics</button></div>${logs.length === 0 ? html`<div class="sub" style="margin-top:8px">The node has not written anything this session.</div>` : html`<table><tbody>${logs.map((e) => html`<tr><td class="m" style="width:90px;color:var(--mu)">${formatTime(e.ts)}</td><td style="width:80px">${badge(e.severity, e.severity === 'ERROR' ? 'er' : e.severity === 'WARN' ? 'wn' : 'ok')}</td><td class="m wrap">${e.message}</td></tr>`)}</tbody></table>`}</div>`);
    return html`${parts}`;
  },
};

registerActions({ 'nav': (el) => navigate((el.dataset.route ?? 'overview') as never) });
void load;
