import { ApiError } from '../api.js';
import { html, inputValue, isChecked } from '../dom.js';
import { formatInt, formatObs, formatDateTime, shortHash } from '../format.js';
import { currentNetwork, displayState, networkLabel, store } from '../store.js';
import { badge, closeModal, copyText, emptyCard, loadingCard, mono, openModal, pageHead, registerActions, setModalError, toast, unavailableCard, warn, requestRender } from '../ui.js';
import { confirmPlan } from '../tx-flow.js';
import { passphraseField, readPassphrase } from '../node-actions.js';
import { navigate } from '../router.js';
import { call, load, poller, type Loadable, type Screen } from './common.js';
import type { WalletStatus } from '../../shared/wallet-types.js';
import type { WalletBalanceView } from '../../shared/contract.js';
import type { AddressHistory } from '../../shared/chain-types.js';

let status: Loadable<WalletStatus> = { state: 'idle' };
let balance: Loadable<WalletBalanceView> = { state: 'idle' };
let history: Loadable<AddressHistory> = { state: 'idle' };
let preparing = false;
let sendTo = '';
let sendAmount = '';
let sendMemo = '';

export function prefillSend(to: string, amount = ''): void {
  sendTo = to;
  sendAmount = amount;
}

const p = poller(async () => {
  status = await load(() => call('wallet:status'));
  if (status.state === 'ready' && status.data.exists) {
    balance = await call('wallet:balance').catch((e: Error) => ({ state: 'error', message: e.message }) as Loadable<WalletBalanceView>);
    history = await call('wallet:history').catch((e: Error) => ({ state: 'error', message: e.message }) as Loadable<AddressHistory>);
  } else {
    balance = { state: 'idle' };
    history = { state: 'idle' };
  }
}, 8000);

export function refreshWallet(): void {
  p.now();
}

export const wallet: Screen = {
  enter: () => p.start(),
  leave: () => p.stop(),
  render() {
    const net = networkLabel(currentNetwork());
    const head = pageHead('Wallet', 'Wallet');
    if (status.state === 'idle' || status.state === 'loading') return html`${head}<div style="margin-top:18px">${loadingCard('Reading the wallet…')}</div>`;
    if (status.state === 'error' || status.state === 'unavailable') return html`${head}<div style="margin-top:18px">${unavailableCard('The wallet could not be read', status.message, 'er')}</div>`;
    const w = status.data;
    if (!w.exists) {
      return html`${head}<div style="margin-top:18px">${warn(`There is no wallet for ${net} on this computer yet. A wallet is an independent key pair; it is never derived from an account or a password.`, 'in')}</div>
      <div class="g g2" style="margin-top:14px">
        <div class="card"><div class="k">Create a new wallet</div><div class="sub" style="font-size:13px;margin:8px 0 14px">Generates a 24-word recovery phrase and encrypts the wallet on this computer with a passphrase you choose.</div><button class="btn p" data-action="wallet.create">Create wallet</button></div>
        <div class="card"><div class="k">Import an existing wallet</div><div class="sub" style="font-size:13px;margin:8px 0 14px">Restore from a 12 or 24-word recovery phrase. Wallet addresses are specific to ${net}.</div><button class="btn" data-action="wallet.import">Import recovery phrase</button></div>
      </div>`;
    }
    const running = displayState() === 'synced' || displayState() === 'syncing';
    const bal = balance.state === 'ready' ? balance.data : null;
    return html`${head}
    <div class="card" style="margin-top:18px;display:flex;align-items:center;gap:20px"><div style="flex:1;min-width:0"><div class="k">${net} address</div><div style="margin-top:8px;font-size:15px;word-break:break-all">${mono(w.address, { copy: true })}</div><div class="sub" style="margin-top:6px">Created ${w.createdAt ? formatDateTime(w.createdAt / 1000) : '—'}. The recovery phrase and key never leave this computer and are never shown again.</div></div><div class="sp1"><button class="btn" data-action="wallet.remove">Remove</button></div></div>
    <div class="g g4" style="margin-top:14px">
      <div class="card"><div class="k">Balance</div><div class="v m">${bal ? `${formatObs(bal.balanceObs)} OBS` : '—'}</div><div class="sub">${bal ? `At block ${formatInt(bal.atHeight)}` : balance.state === 'unavailable' ? 'Start the node to read it' : balance.state === 'error' ? 'Could not be read' : 'Loading…'}</div></div>
      <div class="card"><div class="k">Transactions sent</div><div class="v m">${bal ? formatInt(bal.nonce) : '—'}</div><div class="sub">Account nonce</div></div>
      <div class="card"><div class="k">Transactions seen</div><div class="v m">${bal ? formatInt(bal.txCount) : '—'}</div><div class="sub">By the node</div></div>
      <div class="card"><div class="k">Network</div><div class="v">${net}</div><div class="sub">${running ? 'Node answering' : 'Node not answering'}</div></div>
    </div>
    ${balance.state === 'unavailable' || balance.state === 'error' ? html`<div style="margin-top:14px">${warn(balance.message + ' Balances and sending need the running node on this network.')}</div>` : ''}
    <div class="card" style="margin-top:14px"><div class="k">Send OBS</div>
      <form data-submit="wallet.review" style="margin-top:10px">
        <div class="frm"><div><label class="fl" for="send-to">Recipient address</label><input class="in m" id="send-to" value="${sendTo}" placeholder="${w.addressHrp}1…" autocomplete="off" spellcheck="false"></div>
        <div style="max-width:200px"><label class="fl" for="send-amount">Amount (OBS)</label><input class="in m" id="send-amount" value="${sendAmount}" inputmode="decimal" placeholder="0.00" autocomplete="off"></div></div>
        <label class="fl" for="send-memo">Memo (optional)</label><input class="in" id="send-memo" value="${sendMemo}" maxlength="200" autocomplete="off">
        <div style="margin-top:14px"><button class="btn p" type="submit" ${preparing || !running ? 'disabled' : ''}>${preparing ? 'Checking…' : 'Review transfer'}</button><span class="sub" style="margin-left:12px">${running ? 'You will see everything before anything is signed.' : 'The node must be running to build a transfer.'}</span></div>
      </form></div>
    <div class="card" style="margin-top:14px"><div class="k">History</div>${historyView(w.address)}</div>`;
  },
};

function historyView(address: string | null): unknown {
  if (history.state === 'idle' || history.state === 'loading') return html`<div class="sub" style="margin-top:8px">Loading…</div>`;
  if (history.state === 'unavailable') return html`<div class="sub" style="margin-top:8px">${history.message}</div>`;
  if (history.state === 'error') return html`<div class="sub" style="margin-top:8px">History could not be read: ${history.message}</div>`;
  const txs = history.data.transactions;
  if (txs.length === 0) return html`<div class="sub" style="margin-top:8px">No transactions for this address on this chain yet.</div>`;
  return html`<table><thead><tr><th>Type</th><th>Direction</th><th>Counterparty</th><th>Amount</th><th>Status</th><th>Id</th></tr></thead><tbody>${txs.map((t) => {
    const out = t.sender === address;
    const other = out ? t.recipient : t.sender;
    return html`<tr><td>${t.kind ?? t.type}</td><td>${out ? 'sent' : 'received'}</td><td class="m">${shortHash(other, 12, 6)}</td><td class="m">${t.amount !== undefined ? formatObs(t.amount) : '—'}</td><td>${badge(t.status === 'INCLUDED' ? `CONFIRMED${t.confirmations !== undefined ? ` · ${t.confirmations}` : ''}` : 'PENDING', t.status === 'INCLUDED' ? 'ok' : 'wn')}</td><td class="m"><button class="lk" data-action="tx.open" data-tx="${t.txId}">${shortHash(t.txId, 8, 6)}</button></td></tr>`;
  })}</tbody></table>`;
}

// ── create ───────────────────────────────────────────────────────────────────
function createFlow(): void {
  let pending: { pendingId: string; phrase: string; confirmPositions: number[] } | null = null;
  let step: 'intro' | 'phrase' | 'confirm' = 'intro';
  const clear = (): void => {
    if (pending) void call('wallet:cancel-create', { pendingId: pending.pendingId }).catch(() => undefined);
    pending = null;
  };
  const modal = openModal({
    title: 'Create a wallet',
    wide: true,
    onClose: clear,
    body: () => {
      if (step === 'intro') return html`<p class="mu0">A 24-word recovery phrase will be created. It is the only way to recover this wallet.</p>${warn('Anyone who has the phrase controls the funds. Nobody can reset it for you — not this app, not the project. Have a pen and paper ready, and make sure nobody can see your screen.')}`;
      if (step === 'phrase' && pending) return html`<div class="words" aria-label="Recovery phrase">${pending.phrase.split(' ').map((w, i) => html`<div class="wd"><span>${i + 1}</span>${w}</div>`)}</div>${warn('Write these 24 words down in order and keep them offline. They will not be shown again. Do not photograph or copy them into a file or chat.')}<label class="chk"><input type="checkbox" id="cw-written"> I have written the phrase down and stored it safely.</label>`;
      if (step === 'confirm' && pending) return html`<p class="mu0">Prove you wrote it down: enter the words at these positions.</p><div class="frm" style="margin-top:8px">${pending.confirmPositions.map((pos, i) => html`<div><label class="fl" for="cw-${i}">Word #${pos}</label><input class="in m" id="cw-${i}" autocomplete="off" spellcheck="false"></div>`)}</div><div style="margin-top:12px">${passphraseField('cw-pass', 'Choose a passphrase (at least 12 characters)')}</div><div style="margin-top:12px">${passphraseField('cw-pass2', 'Repeat the passphrase')}</div><div class="sub" style="margin-top:8px">The passphrase encrypts the wallet on this computer. It cannot be recovered; the recovery phrase can restore the wallet if you forget it.</div>`;
      return html``;
    },
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Continue',
        kind: 'p',
        disabled: () => false,
        run: async () => {
          if (step === 'intro') {
            pending = await call('wallet:begin-create');
            step = 'phrase';
            modal.title = 'Your recovery phrase';
            return false;
          }
          if (step === 'phrase') {
            if (!isChecked('cw-written')) throw new Error('Confirm that you have written the phrase down.');
            step = 'confirm';
            modal.title = 'Confirm and protect';
            return false;
          }
          if (!pending) throw new Error('This step expired. Start again.');
          const words = pending.confirmPositions.map((_, i) => inputValue(`cw-${i}`).trim().toLowerCase());
          const pass = inputValue('cw-pass');
          if (pass !== inputValue('cw-pass2')) throw new Error('The two passphrases do not match.');
          const id = pending.pendingId;
          await call('wallet:finish-create', { pendingId: id, passphrase: pass, confirmWords: words });
          pending = null;
          toast('Wallet created', 'ok');
          refreshWallet();
        },
      },
    ],
  });
}

function importFlow(): void {
  openModal({
    title: 'Import a wallet',
    wide: true,
    body: () => html`<label class="fl" for="iw-phrase">Recovery phrase (12 or 24 words)</label><textarea class="in m" id="iw-phrase" rows="3" autocomplete="off" spellcheck="false" style="height:84px;padding-top:10px"></textarea>
      <div style="margin-top:12px">${passphraseField('iw-pass', 'Choose a passphrase (at least 12 characters)')}</div><div style="margin-top:12px">${passphraseField('iw-pass2', 'Repeat the passphrase')}</div>
      ${warn('Only enter your phrase on a computer you trust. The phrase is used once to create the encrypted wallet and is not stored.')}`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Import wallet',
        kind: 'p',
        run: async () => {
          const pass = inputValue('iw-pass');
          if (pass !== inputValue('iw-pass2')) throw new Error('The two passphrases do not match.');
          await call('wallet:import', { phrase: inputValue('iw-phrase'), passphrase: pass });
          toast('Wallet imported', 'ok');
          refreshWallet();
        },
      },
    ],
  });
}

function removeFlow(): void {
  openModal({
    title: 'Remove wallet from this computer?',
    body: () => html`<p class="mu0">This deletes the encrypted wallet file for ${networkLabel(currentNetwork())}. Your funds stay on the chain.</p>${warn('You can only get the wallet back with its 24-word recovery phrase. If you do not have it, the funds will be lost for good.')}<div style="margin-top:12px">${passphraseField('rm-pass')}</div>`,
    buttons: [
      { label: 'Cancel' },
      {
        label: 'Remove wallet',
        kind: 'd',
        run: async () => {
          await call('wallet:remove', { passphrase: readPassphrase('rm-pass') });
          toast('Wallet removed from this computer', 'wn');
          refreshWallet();
        },
      },
    ],
  });
}

registerActions({
  'wallet.create': () => createFlow(),
  'wallet.import': () => importFlow(),
  'wallet.remove': () => removeFlow(),
  'wallet.review': async () => {
    if (preparing) return;
    sendTo = inputValue('send-to').trim();
    sendAmount = inputValue('send-amount').trim();
    sendMemo = inputValue('send-memo');
    preparing = true;
    requestRender();
    try {
      const plan = await call('tx:prepare-payment', { to: sendTo, amountObs: sendAmount, memo: sendMemo || undefined });
      confirmPlan(plan, {
        title: 'Review transfer',
        confirmLabel: 'Sign and send',
        onSubmitted: () => {
          sendTo = '';
          sendAmount = '';
          sendMemo = '';
          refreshWallet();
        },
      });
    } catch (error) {
      toast(error instanceof ApiError ? error.message : 'The transfer could not be prepared.', 'er', 7000);
    } finally {
      preparing = false;
      requestRender();
    }
  },
  'tx.open': (el) => {
    pendingTxQuery = el.dataset.tx ?? '';
    navigate('explorer');
  },
});

export let pendingTxQuery = '';
export function takePendingTx(): string {
  const q = pendingTxQuery;
  pendingTxQuery = '';
  return q;
}
void [closeModal, copyText, emptyCard, setModalError];
