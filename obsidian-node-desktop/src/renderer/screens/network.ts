import { html } from '../dom.js';
import { ago, formatBytes, formatInt, formatDateTime, shortHash } from '../format.js';
import { currentNetwork, displayState, networkLabel, store } from '../store.js';
import { badge, emptyCard, loadingCard, mono, pageHead, stat, unavailableCard, warn } from '../ui.js';
import { call, poller, type Loadable, type Screen } from './common.js';
import type { NetworkDetail } from '../../shared/view-types.js';

let detail: NetworkDetail | null = null;
let failure: string | null = null;

const p = poller(async () => {
  if (store.node?.phase !== 'running') {
    detail = null;
    failure = null;
    return;
  }
  try {
    detail = await call('chain:detail');
    failure = null;
  } catch (error) {
    failure = (error as Error).message;
  }
}, 5000);

function remoteView<T>(r: Loadable<T> | undefined, render: (data: T) => unknown, title: string): unknown {
  if (!r || r.state === 'idle' || r.state === 'loading') return loadingCard(`Loading ${title}…`);
  if (r.state === 'unavailable') return unavailableCard(`${title} unavailable`, r.message);
  if (r.state === 'error') return unavailableCard(`${title}: the node gave an unusable answer`, r.message, 'er');
  return render(r.data);
}

export const network: Screen = {
  enter: () => p.start(),
  leave: () => p.stop(),
  render() {
    const s = displayState();
    const net = currentNetwork();
    const health = store.snap?.health;
    const status = store.snap?.status;
    const head = pageHead('Network', 'Network & Peers');
    if (s === 'stopped' || s === 'starting' || s === 'failed' || s === 'stopping') {
      return html`${head}<div style="margin-top:18px">${unavailableCard('The node is not running', 'Peers, chain timing and finality come from the running node. Start it on the Node or Overview screen.', 'mu')}</div>
      <div class="card" style="margin-top:14px"><div class="k">Configured for this network</div><div class="row"><span>Network</span><b>${networkLabel(net)}</b></div><div class="row"><span>Bootstrap peers</span><span class="m">${store.settings?.nodes[net as 'devnet']?.seeds.length ? store.settings.nodes[net as 'devnet'].seeds.join(', ') : 'none configured (network defaults apply)'}</span></div></div>`;
    }
    const stale = s === 'lost' ? html`<div style="margin-top:14px">${warn('The node is not answering. The figures below are the last ones received.', 'er')}</div>` : '';
    const d = detail;
    return html`${head}${stale}${failure ? html`<div style="margin-top:14px">${warn(`Could not read network details: ${failure}`, 'er')}</div>` : ''}
    <div class="g g4" style="margin-top:18px">
      ${stat('Network', health ? networkLabel(health.network) : '—', health ? `Chain id ${health.chainId}` : '')}
      ${stat('Peers connected', status ? formatInt(status.peers) : '—', d?.peers.state === 'ready' ? `${d.peers.data.inbound} in · ${d.peers.data.outbound} out` : '')}
      ${stat('Block height', status ? formatInt(status.height) : '—', status && store.snap?.headAgeSeconds !== null && store.snap ? `Last block ${ago(store.snap.headAgeSeconds)}` : '')}
      ${stat('Transaction pool', status ? formatInt(status.mempoolTransactions) : '—', status ? formatBytes(status.mempoolBytes) : '')}
    </div>
    <div class="g g2" style="margin-top:14px">
      <div class="card"><div class="k">Chain identity</div>
        <div class="row"><span>Network id</span><span class="m">${health?.networkId ?? '—'}</span></div>
        <div class="row"><span>Genesis id</span>${mono(health?.genesisId, { short: true, copy: true })}</div>
        <div class="row"><span>Protocol / core</span><span class="m">${health ? `${health.protocolVersion} / ${health.coreVersion}` : '—'}</span></div>
        <div class="row"><span>Parameters hash</span>${mono(health?.paramsHash, { copy: true })}</div>
        <div class="row"><span>Supply invariant</span>${health ? badge(health.supplyOk ? 'HOLDS' : 'VIOLATED', health.supplyOk ? 'ok' : 'er') : html`<span class="m">—</span>`}</div></div>
      ${remoteView(d?.pot, (pot) => html`<div class="card"><div class="k">Proof of Time</div>
        <div class="row"><span>Consensus</span><span class="m">${pot.consensus}</span></div>
        <div class="row"><span>Difficulty</span><span class="m">${formatInt(pot.difficultyBps)} bps</span></div>
        <div class="row"><span>Observed block spacing</span><span class="m">${pot.warmingUp ? 'warming up' : `${(pot.observedSpacingMs / 1000).toFixed(2)} s`}</span></div>
        <div class="row"><span>Blocks / transactions per minute</span><span class="m">${pot.blocksPerMinute} / ${pot.transactionsPerMinute}</span></div>
        <div class="row"><span>Protocol time</span><span class="m">${formatDateTime(pot.protocolTime)}</span></div>
        <div class="row"><span>Median time past</span><span class="m">${formatDateTime(pot.medianTimePast)}</span></div></div>`, 'Proof of Time')}
    </div>
    <div class="g g2" style="margin-top:14px">
      ${remoteView(d?.finality, (f) => html`<div class="card"><div class="k">Finality</div>
        <div class="row"><span>Finalized height</span><span class="m">${formatInt(f.finalizedHeight)} of ${formatInt(f.headHeight)}</span></div>
        <div class="row"><span>Committee / quorum</span><span class="m">${f.validatorCount} / ${f.quorum}</span></div>
        <div class="row"><span>Pending votes</span><span class="m">${f.pendingVotes}</span></div>
        <div class="row"><span>Equivocation evidence</span><span class="m">${f.evidenceCount}</span></div>
        <div class="row"><span>Bootstrap mode</span>${badge(f.bootstrap ? 'ON' : 'OFF', f.bootstrap ? 'wn' : 'ok')}</div>
        ${f.bootstrap ? html`<div class="sub" style="margin-top:8px">Until the first validator registers, blocks are not finalized by a committee.</div>` : ''}</div>`, 'Finality')}
      ${remoteView(d?.peers, (pe) => html`<div class="card"><div class="k">This node on the network</div>
        <div class="row"><span>Name</span><span class="m">${pe.name}</span></div>
        <div class="row"><span>Node id</span>${mono(pe.nodeId, { short: true, copy: true })}</div>
        <div class="row"><span>Listening</span>${badge(pe.listening ? 'YES' : 'NO', pe.listening ? 'ok' : 'wn')} <span class="m">${pe.endpoint}</span></div>
        <div class="row"><span>Known peers</span><span class="m">${pe.known}</span></div>
        <div class="row"><span>Best peer height</span><span class="m">${formatInt(pe.bestPeerHeight)}</span></div></div>`, 'Peer information')}
    </div>
    ${d?.peers.state === 'ready' ? peersTables(d.peers.data) : ''}`;
  },
};

function peersTables(pe: import('../../shared/chain-types.js').PeersInfo): unknown {
  return html`<div class="card" style="margin-top:14px"><div class="k">Connected peers</div>${pe.connectedPeers.length === 0 ? html`<div class="sub" style="margin-top:8px">No peers are connected. A node without peers only follows and extends its own chain.</div>` : html`<table><thead><tr><th>Address</th><th>Node id</th><th>Height</th><th>Direction</th><th>Version</th></tr></thead><tbody>${pe.connectedPeers.map((c) => html`<tr><td class="m">${c.address}</td><td class="m">${shortHash(c.nodeId, 8, 4)}</td><td class="m">${formatInt(c.height)}</td><td>${c.inbound ? 'inbound' : 'outbound'}</td><td class="m">${c.version}</td></tr>`)}</tbody></table>`}</div>
  ${pe.knownPeers.length > 0 ? html`<div class="card" style="margin-top:14px"><div class="k">Known peers (${pe.known})</div><table><thead><tr><th>Address</th><th>Node id</th><th>Height</th><th>Last seen</th><th>OK / failed</th></tr></thead><tbody>${pe.knownPeers.slice(0, 25).map((k) => html`<tr><td class="m">${k.address}</td><td class="m">${shortHash(k.nodeId, 8, 4)}</td><td class="m">${formatInt(k.height)}</td><td>${k.lastSeen ? formatDateTime(k.lastSeen > 1e11 ? k.lastSeen / 1000 : k.lastSeen) : '—'}</td><td class="m">${k.successCount} / ${k.failureCount}</td></tr>`)}</tbody></table></div>` : emptyCard('No known peers yet', 'Peers appear here once this node discovers them.')}`;
}
