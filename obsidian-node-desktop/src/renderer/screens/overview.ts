import { call } from '../api.js';
import { html, raw } from '../dom.js';
import { ago, formatBytes, formatDuration, formatInt, formatTime, shortHash } from '../format.js';
import { navigate } from '../router.js';
import { DISPLAY, currentNetwork, displayState, networkLabel, store } from '../store.js';
import { badge, dot, pageHead, registerActions, stat, warn } from '../ui.js';
import { restartNodeFlow, startNode, stopNodeFlow } from '../node-actions.js';
import type { Screen } from './common.js';

export function nodeControls(): ReturnType<typeof html> {
  const s = displayState();
  if (s === 'stopped' || s === 'failed') return html`<button class="btn p" data-action="node.start">${s === 'failed' ? 'Try Again' : 'Start Node'}</button>`;
  if (s === 'starting' || s === 'stopping') return html`<button class="btn" disabled>${s === 'starting' ? 'Starting…' : 'Stopping…'}</button>`;
  return html`<button class="btn" data-action="node.restart">Restart</button><button class="btn d" data-action="node.stop">Stop Node</button>`;
}

export function statusCard(): ReturnType<typeof html> {
  const s = displayState();
  const d = DISPLAY[s];
  const node = store.node;
  const detail = s === 'failed' && node?.error ? node.error.message.split('\n')[0] : s === 'lost' && store.snap?.lastError ? `${d.text} Last error: ${store.snap.lastError}` : d.text;
  return html`<div class="card hero"><span aria-hidden="true">${dot(d.tone, 14)}</span><div style="flex:1;min-width:0"><div class="big" id="status-title">${d.title}</div><div class="sub" style="font-size:13px">${detail}</div></div><div class="sp1">${nodeControls()}</div></div>`;
}

function nodeUptime(): number | null {
  const snap = store.snap;
  if (!snap?.health || !snap.at) return null;
  return snap.health.uptimeSeconds + Math.max(0, (store.now - snap.at) / 1000);
}

function lastBlockAge(): number | null {
  const snap = store.snap;
  if (!snap || snap.headAgeSeconds === null || !snap.at) return null;
  return snap.headAgeSeconds + Math.max(0, (store.now - snap.at) / 1000);
}

export function networkHealth(): { text: string; sub: string } {
  const s = displayState();
  const snap = store.snap;
  if (s === 'stopped' || s === 'starting' || s === 'stopping' || s === 'failed') return { text: '—', sub: networkLabel(currentNetwork()) };
  if (s === 'lost') return { text: 'No answer', sub: networkLabel(currentNetwork()) };
  if (s === 'connecting') return { text: '—', sub: 'Waiting for the node' };
  if (s === 'syncing') return { text: 'Syncing', sub: networkLabel(currentNetwork()) };
  if (snap?.health && snap.health.peers === 0) return { text: 'No peers', sub: `${networkLabel(currentNetwork())} · standalone` };
  if (snap?.health && !snap.health.supplyOk) return { text: 'Check supply', sub: 'The node reports a supply mismatch' };
  return { text: 'Good', sub: networkLabel(currentNetwork()) };
}

export const overview: Screen = {
  render() {
    const s = displayState();
    const snap = store.snap;
    const live = s === 'synced' || s === 'syncing' || s === 'lost';
    const status = live ? snap?.status ?? null : null;
    const health = live ? snap?.health ?? null : null;
    const node = store.node;
    const stale = s === 'lost';
    const parts: unknown[] = [pageHead('Overview', 'Overview'), html`<div style="margin-top:18px">${statusCard()}</div>`];

    if (node?.externalNodeDetected && (s === 'stopped' || s === 'failed')) {
      parts.push(html`<div style="margin-top:14px">${warn(`Another program is already answering on ${node.rpcUrl}. Obsidian Node will not start a second node on the same port. Stop the other program or change the port offset in Settings.`)}</div>`);
    }
    if (s === 'failed' && node?.error) {
      parts.push(html`<div style="margin-top:14px">${warn(html`<b>${node.error.code}</b> — ${node.error.message}`, 'er')}</div>`);
    }
    if (s === 'starting') {
      const steps = ['Starting node process', 'Opening data directory', 'Waiting for the node to answer', 'Synchronizing chain'];
      const idx = node?.step ? Math.max(0, steps.findIndex((x) => node.step!.toLowerCase().includes(x.split(' ')[0]!.toLowerCase()))) : 0;
      parts.push(html`<div class="card" style="margin-top:14px"><div class="k" style="margin-bottom:8px">Startup progress</div>${steps.map((label, i) => html`<div class="row"><span>${label}</span>${badge(i < idx ? 'Done' : i === idx ? 'In progress' : 'Waiting', i < idx ? 'ok' : i === idx ? 'wn' : 'mu')}</div>`)}${node?.step ? html`<div class="sub" style="margin-top:8px">${node.step}</div>` : ''}</div>`);
    }
    if (s === 'syncing' && status) {
      const target = snap?.syncTargetHeight ?? null;
      const pct = target && target > 0 ? Math.min(100, (status.height / target) * 100) : null;
      parts.push(html`<div class="card" style="margin-top:14px"><div style="display:flex;justify-content:space-between"><b>Block sync</b><span class="m">${formatInt(status.height)}${target ? ` / ${formatInt(target)}` : ''}</span></div>${pct !== null ? html`<div class="bar" style="margin:12px 0"><i style="width:${pct.toFixed(1)}%"></i></div>` : html`<div class="bar" style="margin:12px 0"><i style="width:8%;opacity:.5"></i></div>`}<div class="sub">${target ? 'Target height reported by connected peers.' : 'No peer has reported a target height yet.'} No time estimate is shown because none can be computed reliably.</div></div>`);
    }

    const dash = '—';
    const age = lastBlockAge();
    parts.push(html`<div class="g g4" style="margin-top:14px">
      ${stat('Block height', status ? formatInt(status.height) : dash, status ? (stale ? 'Last known' : s === 'syncing' ? 'Syncing' : 'Latest accepted block') : s === 'stopped' ? 'Not running' : 'Unavailable')}
      ${stat('Peers', status ? formatInt(status.peers) : dash, status ? (status.peers > 0 ? 'Connected' : 'No connections') : 'No connections')}
      ${stat('Uptime', health ? formatDuration(nodeUptime()) : dash, 'Since last start')}
      ${stat('Last block', age !== null && status ? ago(age) : dash, 'Block time vs chain time')}
    </div>
    <div class="g g4" style="margin-top:14px">
      ${stat('Protocol', health ? `v${health.protocolVersion}` : dash, health ? `Core ${health.coreVersion}` : store.appInfo?.core ? `Core ${store.appInfo.core.version}` : '')}
      ${stat('Storage', status ? formatBytes(status.diskBytes) : dash, 'Chain database size')}
      ${stat('Chain head', status ? shortHash(status.headHash, 8, 6) : dash, status ? raw(`<a href="#" class="lk" data-action="copy" data-copy="${status.headHash}">Copy hash</a>`) : '')}
      ${stat('Network health', networkHealth().text, networkHealth().sub)}
    </div>`);

    if (live && status) {
      const events = store.logs.filter((e) => e.severity !== 'DEBUG').slice(-6).reverse();
      parts.push(html`<div class="card" style="margin-top:14px"><div class="k">Recent node events</div>${events.length === 0 ? html`<div class="sub" style="margin-top:8px">No events yet.</div>` : html`<table><tbody>${events.map((e) => html`<tr><td class="m" style="width:100px;color:var(--mu)">${formatTime(e.ts)}</td><td style="width:80px">${badge(e.severity, e.severity === 'ERROR' ? 'er' : e.severity === 'WARN' ? 'wn' : 'ok')}</td><td>${e.message}</td></tr>`)}</tbody></table>`}<div style="margin-top:10px"><button class="lk" data-action="nav" data-route="logs">Open full logs</button></div></div>`);
    }
    return html`${parts}`;
  },
};

registerActions({
  'node.start': () => startNode(),
  'node.stop': () => stopNodeFlow(),
  'node.restart': () => restartNodeFlow(),
  nav: (el) => navigate((el.dataset.route ?? 'overview') as never),
});
void call;
