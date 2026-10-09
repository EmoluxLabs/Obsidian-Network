import { html } from '../dom.js';
import { formatInt, formatObs } from '../format.js';
import { navigate } from '../router.js';
import { currentNetwork, displayState, networkLabel, store } from '../store.js';
import { badge, emptyCard, loadingCard, mono, pageHead, registerActions, stat, unavailableCard, warn, toast } from '../ui.js';
import { confirmPlan } from '../tx-flow.js';
import { call, load, poller, type Loadable, type Screen } from './common.js';
import { prefillSend } from './wallet.js';
import type { ValidatorView } from '../../shared/validator-types.js';
import type { ValidatorsInfo } from '../../shared/chain-types.js';
import type { Tone } from '../store.js';

let view: Loadable<ValidatorView> = { state: 'idle' };
let list: Loadable<ValidatorsInfo> = { state: 'idle' };
let preparing: string | null = null;

const p = poller(async () => {
  view = await load(() => call('validator:view'));
  list = store.node?.phase === 'running' ? await call('validator:list') : { state: 'idle' };
}, 6000);

const PHASE: Record<ValidatorView['phase'], { text: string; tone: Tone }> = {
  unknown: { text: 'Status unknown', tone: 'mu' },
  'not-registered': { text: 'Not registered', tone: 'in' },
  active: { text: 'Active validator', tone: 'ok' },
  jailed: { text: 'Jailed', tone: 'er' },
  unbonding: { text: 'Unbonding', tone: 'wn' },
  slashed: { text: 'Slashed', tone: 'er' },
};

export const validator: Screen = {
  enter: () => p.start(),
  leave: () => p.stop(),
  render() {
    const head = pageHead('Validator Centre', 'Validator Centre');
    if (view.state === 'idle' || view.state === 'loading') return html`${head}<div style="margin-top:18px">${loadingCard('Reading validator status from the node…')}</div>`;
    if (view.state === 'error' || view.state === 'unavailable') return html`${head}<div style="margin-top:18px">${unavailableCard('Validator status unavailable', view.message, 'er')}</div>`;
    const v = view.data;
    const ph = PHASE[v.phase];
    const ops = v.operations;
    const net = networkLabel(currentNetwork());
    const busy = preparing !== null;
    const button = (op: 'register' | 'unregister' | 'claim', label: string, kind: string): unknown =>
      html`<button class="btn ${kind}" data-action="validator.prepare" data-op="${op}" ${ops[op].allowed && !busy ? '' : 'disabled'}>${preparing === op ? 'Preparing…' : label}</button>`;
    const primary = v.phase === 'not-registered' || v.phase === 'unknown' ? 'register' : v.phase === 'unbonding' || v.phase === 'slashed' ? 'claim' : 'unregister';
    const actions =
      primary === 'register'
        ? button('register', 'Become a Validator', 'p')
        : primary === 'claim'
          ? button('claim', 'Claim Stake', 'p')
          : button('unregister', 'Request Unbonding', 'd');
    const reason = ops[primary].allowed || !v.nodeReachable ? null : ops[primary].reason;
    const r = v.record;
    const known = v.nodeReachable;
    const bondNow = !known ? null : r && (v.phase === 'active' || v.phase === 'jailed' || v.phase === 'unbonding') ? r.bond : '0';
    const claimable = !known ? null : v.phase === 'unbonding' && ops.claim.allowed && r ? r.bond : '0';
    return html`${head}
    <div class="card" style="margin-top:18px;display:flex;align-items:center;gap:20px"><div style="flex:1"><div class="k">Validator status · ${net}</div><div style="margin-top:8px">${badge(ph.text, ph.tone)}</div><div class="sub" style="font-size:13px;margin-top:8px">Running a node and being a validator are separate. Stopping the node never unbonds funds.</div></div><div class="sp1">${actions}</div></div>
    ${reason ? html`<div style="margin-top:14px">${warn(reason)}</div>` : ''}
    ${!v.nodeReachable ? html`<div style="margin-top:14px">${warn('The node is not running or not answering, so on-chain validator state cannot be read. Nothing below is guessed.')}</div>` : ''}
    <div class="g g4" style="margin-top:14px">
      ${stat('Required bond', v.params ? `${formatObs(v.params.bondObs)} OBS` : '—', 'Read from the node’s protocol parameters')}
      ${stat('Validator account balance', v.identityBalanceObs !== null ? `${formatObs(v.identityBalanceObs)} OBS` : '—', 'The node identity account, on ' + net)}
      ${stat('Current bond', bondNow === null ? '—' : `${formatObs(bondNow)} OBS`, v.phase === 'active' ? 'Locked by protocol' : v.phase === 'unbonding' ? 'Unbonding' : '')}
      ${stat('Claimable', claimable === null ? '—' : `${formatObs(claimable)} OBS`, v.phase === 'unbonding' ? (ops.claim.allowed ? 'The node says it can be claimed now' : 'After the protocol delay') : '')}
    </div>
    <div class="card" style="margin-top:14px"><div class="k">Validator account</div>
      <div class="row"><span>Address (this node’s identity key)</span>${v.identityAddress ? mono(v.identityAddress, { copy: true }) : html`<span class="m">not created yet — start the node once</span>`}</div>
      ${v.identityAddress ? html`<div style="margin-top:6px"><button class="btn" data-action="validator.fund" data-address="${v.identityAddress}">Send OBS to this account from my wallet</button></div>` : ''}
      <div class="sub" style="margin-top:8px">The protocol requires the validator key to be the sender’s own key, so the validator account is the node’s identity account, not your personal wallet. Fund it with the bond plus the fee, then register.</div></div>
    <div class="card" style="margin-top:14px"><div class="k">Eligibility checks</div>${v.checks.map((c) => html`<div class="row"><span>${c.label}<div class="sub">${c.detail}</div></span>${badge(c.pass === null ? 'UNKNOWN' : c.pass ? 'PASS' : 'ACTION NEEDED', c.pass === null ? 'mu' : c.pass ? 'ok' : 'wn')}</div>`)}</div>
    <div class="g g2" style="margin-top:14px">
      <div class="card"><div class="k">Protocol rules (from the node)</div>${v.params ? html`
        <div class="row"><span>Bond</span><span class="m">${formatObs(v.params.bondObs)} OBS</span></div>
        <div class="row"><span>Unbonding delay</span><span class="m">${formatInt(v.params.unbondingBlocks)} blocks</span></div>
        <div class="row"><span>Maximum validators</span><span class="m">${v.params.maxValidators}</span></div>
        <div class="row"><span>Penalty for double-signing</span><span class="m">${v.params.slashBps / 100}% (${formatObs(v.params.slashObs)} OBS)</span></div>
        <div class="row"><span>Jail time after missed duties</span><span class="m">${formatInt(v.params.jailSeconds)} s</span></div>
        <div class="row"><span>Missed slots before jail</span><span class="m">${v.params.maxMissedSlots}</span></div>` : html`<div class="sub" style="margin-top:8px">Unavailable until the node answers.</div>`}</div>
      <div class="card"><div class="k">Validator set</div>${v.chain ? html`
        <div class="row"><span>Active validators</span><span class="m">${v.chain.activeValidators}</span></div>
        <div class="row"><span>Registered validators</span><span class="m">${v.chain.registeredValidators}</span></div>
        <div class="row"><span>Finality bootstrap</span>${v.chain.finalityBootstrap === null ? html`<span class="m">—</span>` : badge(v.chain.finalityBootstrap ? 'ON' : 'OFF', v.chain.finalityBootstrap ? 'wn' : 'ok')}</div>` : html`<div class="sub" style="margin-top:8px">Unavailable until the node answers.</div>`}</div>
    </div>
    ${r ? html`<div class="card" style="margin-top:14px"><div class="k">This validator’s record</div>
      <div class="row"><span>Status</span><span class="m">${r.status}</span></div><div class="row"><span>Bond</span><span class="m">${formatObs(r.bond)} OBS</span></div>
      <div class="row"><span>Registered at block</span><span class="m">${formatInt(r.registeredAtHeight)}</span></div><div class="row"><span>Missed slots</span><span class="m">${r.missedSlots}</span></div>
      ${r.slashedAtHeight !== null ? html`<div class="row"><span>Slashed at block</span><span class="m">${formatInt(r.slashedAtHeight)}</span></div>` : ''}</div>` : ''}
    ${registered()}
    ${v.notes.length ? html`<div class="card" style="margin-top:14px"><div class="k">Good to know</div>${v.notes.map((n) => html`<div class="sub" style="margin-top:6px;font-size:13px">• ${n}</div>`)}</div>` : ''}`;
  },
};

function registered(): unknown {
  if (list.state !== 'ready') return '';
  const reg = list.data.registered;
  if (reg.length === 0) return html`<div style="margin-top:14px">${emptyCard('No validators are registered on this chain yet', 'Addresses are masked by the node. The first registration permanently closes permissionless block production.')}</div>`;
  return html`<div class="card" style="margin-top:14px"><div class="k">Registered validators (${reg.length})</div><table><thead><tr><th>Address (masked by the node)</th><th>Status</th><th>Bond</th><th>Commission</th><th>Missed</th><th>Since block</th></tr></thead><tbody>${reg.map((x) => html`<tr><td class="m">${x.address}</td><td>${badge(x.status, x.status === 'ACTIVE' ? 'ok' : x.status === 'UNBONDING' || x.status === 'JAILED' ? 'wn' : 'er')}</td><td class="m">${formatObs(x.bond)}</td><td class="m">${x.commissionBps / 100}%</td><td class="m">${x.missedSlots}</td><td class="m">${formatInt(x.registeredAtHeight)}</td></tr>`)}</tbody></table></div>`;
}

const TITLES = { register: ['Review validator registration', 'Authorize registration'], unregister: ['Request unbonding?', 'Request Unbonding'], claim: ['Claim unbonded stake', 'Authorize claim'] } as const;

registerActions({
  'validator.prepare': async (el) => {
    const op = el.dataset.op as 'register' | 'unregister' | 'claim';
    if (preparing) return;
    preparing = op;
    try {
      const plan = await call('validator:prepare', { op });
      confirmPlan(plan, { title: TITLES[op][0], confirmLabel: TITLES[op][1], danger: op === 'unregister', onSubmitted: () => p.now() });
    } catch (error) {
      toast((error as Error).message, 'er', 7000);
    } finally {
      preparing = null;
      p.now();
    }
  },
  'validator.fund': (el) => {
    prefillSend(el.dataset.address ?? '');
    navigate('wallet');
  },
});
void displayState;
