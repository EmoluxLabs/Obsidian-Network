import { call } from '../api.js';
import { html } from '../dom.js';
import { formatInt, formatObs } from '../format.js';
import { currentNetwork, networkLabel } from '../store.js';
import { badge, loadingCard, mono, pageHead, registerActions, requestRender, stat, toast, unavailableCard, warn } from '../ui.js';
import { navigate } from '../router.js';
import { poller, load, type Loadable, type Screen } from './common.js';
import type { ParticipationPhase, ParticipationView } from '../../shared/participation-types.js';
import type { Tone } from '../store.js';

let view: Loadable<ParticipationView> = { state: 'idle' };
let saving = false;
let draft = '';
let formError: string | null = null;

const FIELD = 'pt-wallet';
const field = (): HTMLInputElement | null => document.getElementById(FIELD) as HTMLInputElement | null;

const p = poller(async () => {
  // Keep what the person is typing across the periodic refresh.
  draft = field()?.value ?? draft;
  view = await load(() => call('participation:view'));
}, 8000);

const PHASE: Record<ParticipationPhase, { text: string; tone: Tone }> = {
  unknown: { text: 'Status unknown', tone: 'mu' },
  'no-wallet': { text: 'No reward wallet', tone: 'wn' },
  waiting: { text: 'Waiting to register', tone: 'in' },
  registered: { text: 'Registered · earning when online', tone: 'ok' },
  changing: { text: 'Wallet change pending', tone: 'wn' },
  banned: { text: 'Banned', tone: 'er' },
  left: { text: 'Not registered', tone: 'mu' },
};

export const participation: Screen = {
  enter: () => p.start(),
  leave: () => p.stop(),
  render() {
    const head = pageHead('Node Rewards', 'Node Rewards');
    if (view.state === 'idle' || view.state === 'loading') return html`${head}<div style="margin-top:18px">${loadingCard('Reading this node’s status…')}</div>`;
    if (view.state === 'error' || view.state === 'unavailable') return html`${head}<div style="margin-top:18px">${unavailableCard('Node status unavailable', view.message, 'er')}</div>`;
    const v = view.data;
    const ph = PHASE[v.phase];
    const net = networkLabel(currentNetwork());
    const typed = field()?.value ?? draft;
    if (document.activeElement?.id === FIELD) requestAnimationFrame(() => requestAnimationFrame(() => field()?.focus()));
    const r = v.record;
    const c = v.chain;
    return html`${head}
    <div class="card" style="margin-top:18px;display:flex;align-items:center;gap:20px"><div style="flex:1"><div class="k">Node status · ${net}</div><div style="margin-top:8px">${badge(ph.text, ph.tone)}</div><div class="sub" style="font-size:13px;margin-top:8px">Every eligible node that is online takes part. There is nothing to bond and no validator to become.</div></div></div>
    ${!v.nodeReachable ? html`<div style="margin-top:14px">${warn('The node is not running or not answering, so the chain cannot be read. Nothing below is guessed.')}</div>` : ''}
    <div class="g g4" style="margin-top:14px">
      ${stat('Reward wallet (chain)', r ? 'bound' : v.nodeReachable ? 'none yet' : '—', r ? 'The chain pays this wallet' : '')}
      ${stat('Uptime this period', r ? `${r.liveWindows} / ${r.expectedWindows}` : '—', 'Heartbeat windows the chain verified')}
      ${stat('Rewards earned', r ? `${formatObs(r.lifetimeRewardObs)} OBS` : '—', 'Paid by the chain at each period end')}
      ${stat('Block production', v.participating ? 'ON' : 'OFF', v.participating ? 'This node registers and produces' : 'Switch it on in Settings to take part')}
    </div>
    <div class="card" style="margin-top:14px"><div class="k">Reward wallet</div>
      <div class="row"><span>Chosen on this computer</span>${v.chosenWallet ? mono(v.chosenWallet, { copy: true }) : html`<span class="m">none</span>`}</div>
      <div class="row"><span>Held by the chain</span>${r && r.rewardWallet ? mono(r.rewardWallet, { copy: true }) : html`<span class="m">${v.nodeReachable ? 'none yet' : '—'}</span>`}</div>
      <div class="sub" style="margin-top:10px;font-size:13px">Paste the OBS address that should receive this node’s rewards. It costs no gas and asks for no signature, passphrase or private key. Only an address is saved, here, on this computer; the running node registers itself on the chain with its own key.</div>
      <div style="display:flex;gap:10px;margin-top:10px;flex-wrap:wrap"><input id="${FIELD}" class="in m" style="flex:1;min-width:260px" placeholder="Paste an OBS address" value="${typed}" autocomplete="off" spellcheck="false" maxlength="200"><button class="btn p" data-action="participation.bind" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : v.chosenWallet ? 'Change reward wallet' : 'Save reward wallet'}</button></div>
      ${formError ? html`<div style="margin-top:10px">${warn(formError, 'er')}</div>` : ''}
      <div class="sub" style="margin-top:10px;font-size:13px">Pasting an address does not prove you own it. Rewards are only ever paid to it, never taken from it; if someone bound your address to their node, you can reclaim it with one transaction from that wallet. Changing a wallet the chain already holds takes effect after a delay the chain enforces.</div>
      <div style="margin-top:8px"><button class="btn" data-action="participation.wallet">Open my wallet</button></div></div>
    <div class="card" style="margin-top:14px"><div class="k">Checks</div>${v.checks.map((x) => html`<div class="row"><span>${x.label}<div class="sub">${x.detail}</div></span>${badge(x.pass === null ? 'UNKNOWN' : x.pass ? 'PASS' : 'ACTION NEEDED', x.pass === null ? 'mu' : x.pass ? 'ok' : 'wn')}</div>`)}</div>
    <div class="g g2" style="margin-top:14px">
      <div class="card"><div class="k">Block producers</div>${c ? html`
        <div class="row"><span>Schedule</span><span class="m">${c.tier}</span></div>
        <div class="row"><span>Eligible now</span><span class="m">${formatInt(c.eligibleProducers)}</span></div>
        <div class="row"><span>Registered nodes</span><span class="m">${formatInt(c.registeredNodes)}</span></div>
        <div class="row"><span>Banned</span><span class="m">${formatInt(c.bannedNodes)}</span></div>` : html`<div class="sub" style="margin-top:8px">Unavailable until the node answers.</div>`}</div>
      <div class="card"><div class="k">Finality</div>${c ? html`
        <div class="row"><span>Status</span>${badge(c.finalityAvailable ? 'AVAILABLE' : 'NOT YET', c.finalityAvailable ? 'ok' : 'wn')}</div>
        <div class="row"><span>Finalized height</span><span class="m">${formatInt(c.finalizedHeight)} of ${formatInt(c.headHeight)}</span></div>
        <div class="sub" style="margin-top:8px">${c.finalityReason}</div>
        <div class="sub" style="margin-top:6px">This is checkpoint finality derived from the chain itself, not Byzantine-fault-tolerant finality.</div>` : html`<div class="sub" style="margin-top:8px">Unavailable until the node answers.</div>`}</div>
    </div>
    ${r ? html`<div class="card" style="margin-top:14px"><div class="k">This node’s record</div>
      <div class="row"><span>Node id</span>${mono(r.nodeId, { short: true, copy: true })}</div>
      <div class="row"><span>Registered at block</span><span class="m">${formatInt(r.registeredAtHeight)}</span></div>
      <div class="row"><span>Faults reported against this node</span><span class="m">${r.faults}</span></div>
      <div class="row"><span>Reward period</span><span class="m">${formatInt(r.currentPeriod)}</span></div></div>` : v.nodeId ? html`<div class="card" style="margin-top:14px"><div class="k">This node</div><div class="row"><span>Node id</span>${mono(v.nodeId, { short: true, copy: true })}</div></div>` : ''}
    <div class="card" style="margin-top:14px"><div class="k">Good to know</div>${v.notes.map((n) => html`<div class="sub" style="margin-top:6px;font-size:13px">• ${n}</div>`)}</div>`;
  },
};

registerActions({
  'participation.bind': async () => {
    if (saving) return;
    const address = field()?.value ?? draft;
    draft = address;
    saving = true;
    formError = null;
    requestRender();
    try {
      const result = await call('participation:bind', { address });
      draft = '';
      toast(result.appliesTo === 'running-node' ? 'Reward wallet saved. The running node will use it on its next cycle.' : 'Reward wallet saved. The node will use it when it starts.', 'ok', 6000);
      
    } catch (error) {
      formError = (error as Error).message;
    } finally {
      saving = false;
      p.now();
    }
  },
  'participation.wallet': () => navigate('wallet'),
});
