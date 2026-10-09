import { call } from '../api.js';
import { html, inputValue, isChecked } from '../dom.js';
import { NETWORK_INFO, currentNetwork, displayState, networkLabel, store } from '../store.js';
import { badge, mono, pageHead, registerActions, requestRender, toast, warn } from '../ui.js';
import { restartNodeFlow, switchNetworkFlow } from '../node-actions.js';
import { LOG_LEVELS, type NodeSettings } from '../../shared/settings-types.js';
import type { NetworkName } from '../../shared/chain-types.js';
import type { Screen } from './common.js';

let saving = false;
let error: string | null = null;
let restartPending: string[] = [];

export const settings: Screen = {
  enter() {
    error = null;
  },
  render() {
    const net = currentNetwork() as NetworkName;
    const s = store.settings;
    const head = pageHead('Settings', 'Settings');
    if (!s) return html`${head}`;
    const n = s.nodes[net];
    const active = store.node?.phase === 'running' || store.node?.phase === 'starting';
    return html`${head}
    ${store.settingsRecovered ? html`<div style="margin-top:14px">${warn(`The settings file could not be read (${store.settingsRecovered.reason}). Defaults were used and the unreadable file was kept at ${store.settingsRecovered.backup}.`)}</div>` : ''}
    ${restartPending.length && active ? html`<div style="margin-top:14px">${warn(html`Saved. <b>${restartPending.join(', ')}</b> will apply after the node restarts. <button class="lk" data-action="node.restart">Restart now</button>`, 'in')}</div>` : ''}
    <div class="card" style="margin-top:18px"><div class="k">Network</div>
      <div class="row"><span>Selected network</span><span>${badge(networkLabel(net).toUpperCase(), NETWORK_INFO[net]!.tone)}</span></div>
      <div class="sub" style="margin-top:6px">${NETWORK_INFO[net]!.blurb} Switching networks changes the chain data, wallet and node identity in use — each network keeps its own. Use the selector in the title bar or choose here:</div>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">${(Object.keys(NETWORK_INFO) as NetworkName[]).map((k) => html`<button class="btn" data-action="settings.net" data-net="${k}" ${k === net ? 'disabled' : ''}>${NETWORK_INFO[k]!.label}</button>`)}</div></div>
    <form class="card" style="margin-top:14px" data-submit="settings.save"><div class="k">Node settings · ${networkLabel(net)}</div>
      <div class="sub" style="margin:6px 0 10px">These apply to the ${networkLabel(net)} node only. Consensus rules, genesis and protocol parameters are fixed by the network and cannot be changed here. ${active ? 'The node is running: changes apply after a restart.' : ''}</div>
      <div class="frm"><div><label class="fl" for="st-name">Node name</label><input class="in" id="st-name" value="${n.nodeName}" maxlength="48" autocomplete="off"></div>
        <div style="max-width:200px"><label class="fl" for="st-offset">Port offset (0–100)</label><input class="in m" id="st-offset" type="number" min="0" max="100" value="${n.portOffset}"></div>
        <div style="max-width:220px"><label class="fl" for="st-level">Log level</label><select class="in" id="st-level">${LOG_LEVELS.map((l) => html`<option value="${l}" ${l === n.logLevel ? 'selected' : ''}>${l}</option>`)}</select></div></div>
      <label class="chk"><input type="checkbox" id="st-produce" ${n.blockProduction ? 'checked' : ''}> Block production — this node proposes blocks with its identity key when the protocol allows it. Unticking makes it follow and validate only.</label>
      <label class="fl" for="st-seeds" style="margin-top:12px">Bootstrap peers (one host:port per line; empty uses the network defaults)</label><textarea class="in m" id="st-seeds" rows="3" spellcheck="false" style="height:84px;padding-top:10px">${n.seeds.join('\n')}</textarea>
      <div class="sub" style="margin-top:6px">The RPC and peer-to-peer ports are the network defaults plus the offset: RPC ${store.node?.rpcPort ?? '—'}, peer-to-peer ${store.node?.p2pPort ?? '—'}. The RPC only listens on this computer.</div>
      ${error ? warn(error, 'er') : ''}
      <div style="margin-top:14px"><button class="btn p" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save settings'}</button></div></form>
    <div class="card" style="margin-top:14px"><div class="k">Where things are stored</div>
      <div class="row"><span>Chain data</span>${mono(store.node?.dataDir, { copy: true })}</div>
      <div class="row"><span>Node identity key (encrypted)</span>${mono(store.node?.keystorePath, { copy: true })}</div>
      <div class="row"><span>Application data</span>${mono(store.appInfo?.userDataDir, { copy: true })}</div>
      <div class="sub" style="margin-top:8px">Changing a setting never deletes or resets chain data. Each network has its own folder.</div></div>
    <div class="card" style="margin-top:14px"><div class="k">Interface</div><label class="chk" style="margin-top:8px"><input type="checkbox" id="st-collapse" data-action-change="settings.collapse" ${s.ui.sidebarCollapsed ? 'checked' : ''}> Collapse the sidebar to icons</label></div>`;
  },
};

registerActions({
  'settings.net': (el) => switchNetworkFlow(el.dataset.net as NetworkName),
  'node.restart': () => restartNodeFlow(),
  'settings.collapse': async () => {
    const result = await call('settings:ui-update', { sidebarCollapsed: isChecked('st-collapse') });
    store.settings = result;
    requestRender();
  },
  'settings.save': async () => {
    if (saving) return;
    const net = currentNetwork() as NetworkName;
    const seeds = inputValue('st-seeds').split('\n').map((l) => l.trim()).filter(Boolean);
    const values: NodeSettings = {
      nodeName: inputValue('st-name').trim(),
      blockProduction: isChecked('st-produce'),
      logLevel: inputValue('st-level') as NodeSettings['logLevel'],
      portOffset: Number(inputValue('st-offset')),
      seeds,
    };
    saving = true;
    error = null;
    requestRender();
    try {
      const result = await call('settings:node-update', { values });
      store.settings = result.settings;
      restartPending = result.restartRequired ? result.changedFields : [];
      store.node = await call('node:state');
      toast(result.changedFields.length ? `Saved for ${networkLabel(net)}` : 'Nothing changed', result.changedFields.length ? 'ok' : 'mu');
    } catch (e) {
      error = (e as Error).message;
    } finally {
      saving = false;
      requestRender();
    }
  },
});
void displayState;
