/**
 * Obsidian Wallet: the controller.
 *
 * It wires the supplied screens (lib/views.mjs) to the real protocol code. It decides nothing about money:
 *
 *   keys, phrases, addresses, signing, the vault   the signing bundle built from obsidian-core (js/obsidian.js)
 *   balances, history, nonces, fees, submission    the node, through the platform's gateway (js/shared/data.mjs)
 *   which network this is                          /app-config.json, compared with the node before every signature
 *
 * Secrets: the recovery phrase and the passwords live in a local variable for the one call that needs them and are
 * dropped. They are never put in `S` (the screens' state), in storage, in a URL, or in a log line. Only the vault,
 * which is encrypted, is persisted, and only after the user has said they wrote the phrase down.
 */

import * as W from '/js/shared/wallet.mjs';
import { MIN_PASSPHRASE_LENGTH, submitTransaction, getAppConfig } from '/js/shared/data.mjs';
import { scan } from '/js/shared/scanner.mjs';
import { V, stateWord } from './lib/views.mjs';
import {
  parseRecipient,
  parseAmount,
  exactObs,
  checkNewPassword,
  normalisePhrase,
  readBackup,
  classifyHistory,
  confirmationsAt,
  nextTxState,
  isFinalState,
  describeSubmitFailure,
  createIdleLock,
  unlockDelaySeconds,
  readRecords,
  writeRecords,
  BACKUP_LIMITS,
} from './lib/pure.mjs';
import { fetchBalance, fetchHistory, fetchNode, verifyNetwork, observeTx, fetchQuote } from './lib/chain.mjs';

const app = document.getElementById('app');
const IDLE_MS = 5 * 60 * 1000;
const POLL_MS = 5000;
const PHRASE_SHOWN_MS = 60 * 1000;
const WALLET_VIEWS = new Set(['home', 'activity', 'receive', 'send', 'review', 'status', 'tx', 'backup']);
const LIVE_VIEWS = new Set(['home', 'activity', 'status', 'tx']);

/** The screens' state. Nothing secret goes in here. */
const S = {
  view: 'splash',
  net: { state: 'loading', name: '', chainId: null, hrp: '', error: '' },
  node: { state: 'loading', height: 0, lastBlockTimestamp: null, syncing: false },
  address: null,
  unlocked: false,
  balance: { state: 'loading', seals: 0n, error: '' },
  hist: { state: 'loading', rows: [], ids: new Set(), error: '' },
  records: [],
  draft: { to: '', amount: '' },
  review: null,
  tx: null,
  txBack: 'home',
  qr: '',
  tab: 'phrase',
  err: '',
  busy: false,
  copied: false,
  lockedFor: 0,
  minPass: MIN_PASSPHRASE_LENGTH,
};

/** Held outside `S` on purpose: a phrase being shown, and a wallet being created. Cleared by `wipe()`. */
let shownPhrase = null;
let shownTimer = null;
let creating = null; // { phrase, password, address }
let bundle = null;
let signing = false; // one submission at a time, whatever the buttons do
let working = false; // a form is being processed: a second submit is ignored
let failures = 0;
let lockoutTimer = null;
let poller = null;

// ── rendering ────────────────────────────────────────────────────────────────

function render() {
  const view = V[S.view];
  const extra = S.view === 'create2' ? creating?.phrase ?? '' : S.view === 'backup' ? shownPhrase : undefined;
  app.innerHTML = view(S, extra);
  document.title = S.view === 'splash' ? 'Obsidian Wallet' : `Obsidian Wallet · ${S.net.state === 'ok' ? S.net.name : 'unverified'}`;
  after();
}

/** Things a freshly drawn screen needs: focus, a QR, the fee preview. */
function after() {
  const first = app.querySelector('input:not([type=checkbox]):not([type=file]):not(.hidden), textarea');
  if (first && ['unlock', 'create1', 'import', 'reveal', 'backup'].includes(S.view)) first.focus({ preventScroll: true });
  if (S.view === 'receive') drawQr();
  if (S.view === 'send') previewFee();
  if (S.view === 'unlock' && S.lockedFor) tickLockout();
}

function setErr(message) {
  S.err = message || '';
  const el = app.querySelector('.err');
  if (el) el.textContent = S.err;
}

/** Disable the submit button and say what is happening, without redrawing (a redraw would empty the fields). */
function busy(form, on, label) {
  working = on;
  const button = form?.querySelector('button[type=submit]');
  if (!button) return;
  if (on) {
    button.dataset.label = button.textContent;
    button.textContent = label;
  } else if (button.dataset.label) {
    button.textContent = button.dataset.label;
  }
  button.disabled = on;
}

function go(view) {
  if (!Object.hasOwn(V, view)) throw new Error(`There is no screen called "${view}".`); // a typo in a link must be loud, not a blank page
  if (WALLET_VIEWS.has(view) && !S.unlocked) view = S.address ? 'unlock' : 'welcome';
  if (view !== 'backup') wipePhrase();
  if (view === 'home' || view === 'welcome' || view === 'unlock') {
    S.draft = { to: '', amount: '' };
    S.review = null;
  }
  if (view !== 'create2' && view !== 'create1') creating = null;
  S.view = view;
  S.err = '';
  S.copied = false;
  if (view !== 'receive') S.qr = '';
  render();
  if (LIVE_VIEWS.has(view)) void refresh();
}

function wipePhrase() {
  shownPhrase = null;
  clearTimeout(shownTimer);
  shownTimer = null;
}

// ── the network and the node ─────────────────────────────────────────────────

async function checkNetwork() {
  try {
    const ctx = await verifyNetwork();
    S.net = { state: 'ok', name: ctx.network ?? '', chainId: ctx.chainId, hrp: ctx.addressHrp, error: '' };
    const config = await getAppConfig();
    S.net.name = config.network;
  } catch (error) {
    S.net = { state: 'error', name: '', chainId: null, hrp: '', error: error?.message || 'unknown error' };
  }
  return S.net.state === 'ok';
}

async function refreshNode() {
  try {
    const n = await fetchNode();
    S.node = { state: 'ok', ...n };
  } catch {
    S.node = { ...S.node, state: 'error' };
  }
}

async function refreshBalance() {
  if (!S.address) return;
  try {
    const { seals } = await fetchBalance(S.address);
    S.balance = { state: 'ok', seals, error: '' };
  } catch (error) {
    S.balance = { state: 'error', seals: 0n, error: error?.message || 'The node did not answer.' };
  }
}

async function refreshHistory() {
  if (!S.address) return;
  try {
    const rows = await fetchHistory(S.address);
    S.hist = { state: 'ok', rows, ids: new Set(rows.map((r) => r.txId)), error: '' };
  } catch (error) {
    S.hist = { state: 'error', rows: [], ids: new Set(), error: error?.message || 'The node did not answer.' };
  }
}

/** Read everything the live screens show, then redraw the screen that is up (and only if it is a live one). */
async function refresh() {
  if (!S.unlocked) return;
  await Promise.all([refreshNode(), refreshBalance(), refreshHistory()]);
  await trackRecords();
  if (LIVE_VIEWS.has(S.view) && S.unlocked) {
    if (S.view === 'tx' || S.view === 'status') syncOpenTx();
    render();
  }
}

// ── what this device submitted ───────────────────────────────────────────────

const persist = () => {
  try {
    writeRecords(localStorage, S.address, S.records);
  } catch {
    /* a browser that refuses storage still shows this session's transactions */
  }
};

function loadRecords() {
  S.records = readRecords(localStorage, S.address);
}

const toRecordView = (r) => ({
  txId: r.txId,
  state: r.state,
  to: r.to,
  amount: BigInt(r.amount),
  gas: BigInt(r.gas),
  validUntil: r.validUntil,
  dir: 'sent',
  confirmations: 0,
  signed: true,
  accepted: r.state !== 'failed' && r.state !== 'rejected',
  seenPending: r.state === 'pending',
  message: stateMessage(r.state, r),
  note: '',
});

function stateMessage(state, extra = {}) {
  switch (state) {
    case 'submitted':
      return 'The node accepted this transaction. It is not confirmed until a block holds it; this page checks every few seconds.';
    case 'pending':
      return 'The node has it in its queue and will include it in a block. Not confirmed yet.';
    case 'confirmed':
      return 'A block holds this transaction. It is confirmed.';
    case 'expired':
      return 'This transaction was never included and its validity has ended, so it can no longer happen. Your funds were not spent; check your balance, then send again if you still want to.';
    case 'rejected':
      return extra.detail ? `The node refused it: ${extra.detail}. Nothing was accepted and no funds moved.` : 'The node refused this transaction. No funds moved.';
    case 'failed':
      return `${extra.detail ? `${extra.detail}. ` : ''}It is not known whether the node received it. Do not sign a new one yet: check with the node, or send this same transaction again (it cannot be applied twice).`;
    default:
      return '';
  }
}

/** Look at every transaction this device sent that has not reached a final state. */
async function trackRecords() {
  const open = S.records.filter((r) => !isFinalState(r.state));
  if (!open.length) {
    prune();
    return;
  }
  await Promise.all(open.map(async (r) => {
    const seen = await observeTx(r.txId);
    const next = nextTxState(r.state, seen, { validUntil: r.validUntil, chainTime: S.node.lastBlockTimestamp });
    r.state = next.state;
    if (S.tx?.txId === r.txId) {
      S.tx = { ...S.tx, ...toRecordView(r), signedHex: S.tx.signedHex, confirmations: next.confirmations ?? S.tx.confirmations, seenPending: S.tx.seenPending || seen.kind === 'pending' || seen.kind === 'confirmed' };
      if (seen.kind === 'confirmed') {
        S.tx.height = seen.record.height;
        S.tx.timestamp = seen.record.timestamp;
      }
    }
  }));
  prune();
  persist();
}

/** Final records the history already lists, or that are a day old, are dropped; the chain is the record. */
function prune() {
  const day = 24 * 3600 * 1000;
  const before = S.records.length;
  S.records = S.records.filter((r) => !(isFinalState(r.state) && (S.hist.ids.has(r.txId) || Date.now() - r.submittedAt > day)));
  if (S.records.length !== before) persist();
}

function syncOpenTx() {
  const r = S.records.find((x) => x.txId === S.tx?.txId);
  if (r && S.tx) S.tx = { ...S.tx, state: r.state, message: S.tx.state === r.state ? S.tx.message : stateMessage(r.state, S.tx) };
  else if (S.tx?.height && S.node.state === 'ok') S.tx.confirmations = confirmationsAt(S.tx.height, S.node.height) ?? S.tx.confirmations;
}

// ── boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  S.view = 'splash';
  render();
  const started = Date.now();
  try {
    bundle = await W.loadBundle();
  } catch (error) {
    S.net = { state: 'error', name: '', chainId: null, hrp: '', error: error?.message ?? 'The signing code could not be loaded.' };
    S.view = 'fatal';
    return render();
  }
  const ok = await checkNetwork();
  await new Promise((r) => setTimeout(r, Math.max(0, 600 - (Date.now() - started))));
  if (!ok) {
    S.view = 'fatal';
    return render();
  }
  await route();
}

async function route() {
  const has = await W.hasWallet();
  if (has) {
    const cached = W.cachedAddress();
    S.address = cached ? await W.addressOnNetwork(cached, S.net.hrp) : null;
    return go(S.address ? 'unlock' : 'remove');
  }
  S.address = null;
  go('welcome');
}

// ── actions ──────────────────────────────────────────────────────────────────

const A = {
  go: (el) => go(el.dataset.v),

  tab(el) {
    S.tab = el.dataset.v === 'backup' ? 'backup' : 'phrase';
    S.err = '';
    render();
  },

  async retryNet() {
    S.view = 'splash';
    render();
    if (!bundle) return boot();
    if (await checkNetwork()) return route();
    S.view = 'fatal';
    render();
  },

  lock: () => lock(),

  cancelCreate() {
    creating = null;
    go('welcome');
  },

  async copyAddr() {
    try {
      await navigator.clipboard.writeText(S.address);
      S.copied = true;
      render();
      setTimeout(() => {
        S.copied = false;
        if (S.view === 'home' || S.view === 'receive') render();
      }, 1500);
    } catch {
      setErr('This browser did not allow copying. Select the address and copy it by hand.');
      const box = app.querySelector('#addr');
      if (box) getSelection().selectAllChildren(box);
    }
  },

  async share() {
    if (!navigator.share) return A.copyAddr();
    try {
      await navigator.share({ title: 'My Obsidian address', text: S.address });
    } catch (error) {
      if (error?.name !== 'AbortError') await A.copyAddr();
    }
  },

  refresh: () => refresh(),

  async scan() {
    const result = await scan({
      decode: (image) => W.decodeFrame(image),
      interpret: async (text) => parseRecipient(text, { hrp: S.net.hrp, own: S.address, readScanned: bundle.readScanned }),
    });
    if (!result) return;
    setRecipient(result.value);
    setErr('');
  },

  upload() {
    app.querySelector('#fi')?.click();
  },

  async hidePhrase() {
    wipePhrase();
    render();
  },

  downloadBackup() {
    const vault = bundle.loadVault();
    if (!vault) return setErr('There is no wallet on this device to back up.');
    const blob = new Blob([JSON.stringify(vault)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'obsidian-wallet-backup.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  },

  tx(el) {
    openTx(el.dataset.id);
  },

  async checkTx() {
    if (!S.tx) return;
    await refreshNode();
    const r = S.records.find((x) => x.txId === S.tx.txId);
    if (r) await trackRecords();
    else await refreshHistory();
    if (S.tx) syncOpenTx();
    render();
  },

  async resubmit() {
    if (signing || !S.tx?.signedHex) return;
    signing = true;
    S.busy = true;
    render();
    try {
      // Look first: the earlier attempt may have reached the node after all.
      const seen = await observeTx(S.tx.txId);
      if (seen.kind === 'pending' || seen.kind === 'confirmed') {
        adopt(seen);
      } else {
        try {
          await submitTransaction(S.tx.signedHex);
          adopt({ kind: 'accepted' });
        } catch (error) {
          const again = await observeTx(S.tx.txId);
          if (again.kind === 'pending' || again.kind === 'confirmed') adopt(again);
          else failTx(error);
        }
      }
    } finally {
      signing = false;
      S.busy = false;
      render();
    }
  },
};

/** The node has this transaction: from now on it is tracked like any other. */
function adopt(seen) {
  const r = S.records.find((x) => x.txId === S.tx.txId);
  const state = seen.kind === 'confirmed' ? 'confirmed' : seen.kind === 'pending' ? 'pending' : 'submitted';
  if (r) r.state = state;
  S.tx = { ...S.tx, state, accepted: true, seenPending: seen.kind !== 'accepted', confirmations: seen.confirmations ?? 0, message: stateMessage(state), signedHex: undefined };
  persist();
}

function failTx(error) {
  const refusedByNode = Number.isInteger(error?.status) && error.status >= 400 && error.status < 500;
  const verdict = describeSubmitFailure({ refusedByNode, message: error?.message });
  const r = S.records.find((x) => x.txId === S.tx.txId);
  if (r) r.state = verdict.state;
  S.tx = { ...S.tx, state: verdict.state, message: stateMessage(verdict.state, { detail: verdict.detail }), signedHex: verdict.state === 'failed' ? S.tx.signedHex : undefined };
  persist();
}

function setRecipient(value) {
  S.draft.to = value;
  const input = app.querySelector('#to');
  if (input) input.value = value;
}

// ── forms ────────────────────────────────────────────────────────────────────

const val = (form, id) => form.querySelector(`#${id}`)?.value ?? '';
const clear = (form, ...ids) => ids.forEach((id) => { const el = form.querySelector(`#${id}`); if (el) el.value = ''; });

const F = {
  // Create: the phrase and the password are held in memory only until the user confirms the backup.
  async makeWallet(form) {
    if (await W.hasWallet()) return setErr('A wallet is already set up on this device.');
    const password = val(form, 'pw');
    const check = checkNewPassword(password, val(form, 'pw2'), S.minPass);
    if (!check.ok) return setErr(check.message);
    busy(form, true, 'GENERATING KEYS…');
    try {
      const phrase = await W.newPhrase();
      // The address is derived by the real implementation now, so a phrase that cannot become a wallet fails here.
      const address = await W.addressForPhrase(phrase);
      creating = { phrase, password, address };
      clear(form, 'pw', 'pw2');
      S.view = 'create2';
      S.err = '';
      render();
    } catch (error) {
      setErr(error?.message || 'Could not create the wallet in this browser.');
    } finally {
      busy(form, false);
    }
  },

  async finishCreate(form) {
    if (!creating) return go('create1');
    if (!form.querySelector('#ck')?.checked) return setErr('Please confirm you have written down your recovery phrase.');
    busy(form, true, 'SEALING…');
    try {
      const { phrase, password, address } = creating;
      const made = await W.setupWallet({ phrase, passphrase: password });
      if (made.address !== address) throw new Error('The address changed while sealing. Nothing was kept.');
      // Prove the stored vault opens with this password and holds this phrase before the page lets go of it.
      const back = await W.revealPhrase(password);
      if (back !== phrase) throw new Error('The stored wallet did not reopen correctly. It was removed.');
      creating = null;
      await enter(made.address);
    } catch (error) {
      await W.removeWallet().catch(() => {});
      setErr(error?.message || 'The wallet could not be saved in this browser.');
    } finally {
      busy(form, false);
    }
  },

  async importPhrase(form) {
    if (await W.hasWallet()) return setErr('A wallet is already set up on this device.');
    const phrase = normalisePhrase(val(form, 'rp'));
    const password = val(form, 'pw');
    if (!phrase) return setErr('Enter your recovery phrase.');
    const check = checkNewPassword(password, val(form, 'pw2'), S.minPass);
    if (!check.ok) return setErr(check.message);
    busy(form, true, 'IMPORTING…');
    try {
      if (!bundle.isValidPhrase(phrase)) throw new Error('That recovery phrase is not valid. Check the words and their order.');
      const { address } = await W.setupWallet({ phrase, passphrase: password });
      clear(form, 'rp', 'pw', 'pw2');
      await enter(address);
    } catch (error) {
      setErr(error?.message || 'Could not import this wallet.');
    } finally {
      busy(form, false);
    }
  },

  async importBackup(form) {
    if (await W.hasWallet()) return setErr('A wallet is already set up on this device.');
    const password = val(form, 'pw');
    if (!password) return setErr('Enter the password the backup was made with.');
    busy(form, true, 'IMPORTING…');
    let phrase = null;
    try {
      const file = form.querySelector('#bf')?.files?.[0];
      if (file && file.size > BACKUP_LIMITS.maxBytes) throw new Error('That file is too large to be a wallet backup.');
      const text = file ? await file.text() : val(form, 'bt');
      const read = readBackup(text);
      if (!read.ok) throw new Error(read.message);
      try {
        phrase = await bundle.openVault(read.envelope, password);
      } catch (error) {
        if (error instanceof bundle.PassphraseError) throw new Error('That password does not open this backup.');
        throw error;
      }
      if (!bundle.isValidPhrase(phrase)) throw new Error('The backup opened, but it does not hold a valid recovery phrase.');
      const { address } = await W.setupWallet({ phrase, passphrase: password });
      clear(form, 'bt', 'pw');
      await enter(address);
    } catch (error) {
      setErr(error?.message || 'Could not import this backup.');
    } finally {
      phrase = null;
      busy(form, false);
    }
  },

  async unlock(form) {
    if (S.lockedFor) return;
    const password = val(form, 'pw');
    if (!password) return setErr('Enter your password.');
    busy(form, true, 'UNLOCKING…');
    try {
      const phrase = await W.revealPhrase(password); // opens the vault: this is the check, and the phrase is dropped at once
      const derived = await W.addressForPhrase(phrase);
      if (derived !== S.address) {
        // The cached address was not the vault's. The vault is the truth; the cache is repaired from it.
        bundle.saveWalletAddress(derived);
        S.address = derived;
      }
      failures = 0;
      clear(form, 'pw');
      await enter(S.address);
    } catch (error) {
      failures += 1;
      clear(form, 'pw');
      setErr(error?.name === 'PassphraseError' ? 'Wrong password.' : error?.message || 'Could not open the wallet.');
      const wait = unlockDelaySeconds(failures);
      if (wait) {
        S.lockedFor = wait;
        busy(form, false);
        tickLockout();
        return;
      }
    } finally {
      if (!S.lockedFor) busy(form, false);
    }
  },

  async review(form) {
    const to = val(form, 'to');
    const amountText = val(form, 'am');
    S.draft = { to: to.trim(), amount: amountText.trim() };
    const recipient = parseRecipient(to, { hrp: S.net.hrp, own: S.address, readScanned: bundle.readScanned });
    if (!recipient.ok) return setErr(recipient.message);
    const amount = parseAmount(amountText);
    if (!amount.ok) return setErr(amount.message);
    if (S.records.some((r) => !isFinalState(r.state))) {
      return setErr('You have a transaction that is not settled yet. Wait until it is confirmed before sending another.');
    }
    busy(form, true, 'CHECKING WITH THE NODE…');
    try {
      if (!(await checkNetwork())) throw new Error(S.net.error);
      const { seals: balance } = await fetchBalance(S.address).catch(() => {
        throw new Error('Your balance could not be read from the node, so nothing can be sent right now. Try again.');
      });
      const gas = bundle.expectedGas(amount.seals);
      const quote = await fetchQuote(S.address, amount.text);
      if (bundle.parseObs(quote.gasObs) !== gas) {
        throw new Error('This page and the node do not agree on the fee, so nothing was prepared. Do not send; report this.');
      }
      if (balance < amount.seals + gas) {
        throw new Error(`Not enough balance: you have ${exactObs(balance)} OBS, and this payment needs ${exactObs(amount.seals + gas)} OBS including the fee.`);
      }
      S.review = { to: recipient.value, amount: amount.seals, amountText: amount.text, gas, balance };
      go('review');
    } catch (error) {
      setErr(error?.message || 'The node could not be reached.');
    } finally {
      busy(form, false);
    }
  },

  async sign(form) {
    if (signing || !S.review) return;
    const password = val(form, 'pw');
    if (!password) return setErr('Enter your password to authorize this payment.');
    const review = S.review;
    signing = true; // set before anything is awaited: a second click or a second Enter finds it taken
    busy(form, true, 'SIGNING…');
    let result;
    try {
      result = await W.send({ to: review.to, amountObs: review.amountText, memo: '' }, async () => password);
    } catch (error) {
      result = { ok: false, reason: 'ERROR', message: error?.message || 'Something went wrong before anything was sent.' };
    }
    clear(form, 'pw');
    try {
      if (result.ok) return acceptSent(review, result);
      if (result.reason === 'SUBMIT_FAILED') return sentButUnsure(review, result);
      // Nothing was signed, or signing did not complete: the transaction does not exist.
      setErr(result.reason === 'BAD_PASSPHRASE' ? 'Wrong password. Nothing was signed.' : `${result.message} Nothing was sent.`);
    } finally {
      signing = false;
      busy(form, false);
    }
  },

  async reveal(form) {
    const password = val(form, 'pw');
    if (!password) return setErr('Enter your password.');
    busy(form, true, 'CHECKING…');
    try {
      shownPhrase = await W.revealPhrase(password);
      clear(form, 'pw');
      clearTimeout(shownTimer);
      shownTimer = setTimeout(() => {
        wipePhrase();
        if (S.view === 'backup') render();
      }, PHRASE_SHOWN_MS);
      S.err = '';
      render();
    } catch (error) {
      clear(form, 'pw');
      setErr(error?.name === 'PassphraseError' ? 'Wrong password.' : error?.message || 'Could not open the wallet.');
    } finally {
      busy(form, false);
    }
  },

  async remove(form) {
    if (!form.querySelector('#ck')?.checked) return setErr('Tick the box to confirm you have your recovery phrase.');
    const own = S.address;
    await W.removeWallet();
    try {
      localStorage.setItem('obsidian.wallet.submitted.v1', JSON.stringify(readAll().filter((r) => r.from !== own)));
    } catch {
      /* nothing stored, nothing to remove */
    }
    S.address = null;
    S.unlocked = false;
    S.records = [];
    S.balance = { state: 'loading', seals: 0n, error: '' };
    S.hist = { state: 'loading', rows: [], ids: new Set(), error: '' };
    idle.stop();
    stopPolling();
    go('welcome');
  },
};

const readAll = () => {
  try {
    const list = JSON.parse(localStorage.getItem('obsidian.wallet.submitted.v1') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/** After a successful signing and submission. */
function acceptSent(review, result) {
  const record = {
    txId: result.txId,
    from: S.address,
    to: review.to,
    amount: review.amount.toString(),
    gas: review.gas.toString(),
    validUntil: result.validUntil,
    submittedAt: Date.now(),
    state: 'submitted',
  };
  S.records = [record, ...S.records];
  persist();
  S.tx = toRecordView(record);
  S.txBack = 'home';
  S.review = null;
  S.draft = { to: '', amount: '' };
  S.view = 'status';
  S.err = '';
  render();
  void refresh();
}

/** Signed, but the submission failed: said exactly, with the way to settle it. */
function sentButUnsure(review, result) {
  const verdict = describeSubmitFailure(result);
  const record = {
    txId: result.txId,
    from: S.address,
    to: review.to,
    amount: review.amount.toString(),
    gas: review.gas.toString(),
    validUntil: result.validUntil,
    submittedAt: Date.now(),
    state: verdict.state,
  };
  S.records = [record, ...S.records];
  persist();
  S.tx = { ...toRecordView(record), accepted: false, message: stateMessage(verdict.state, { detail: verdict.detail }), signedHex: verdict.state === 'failed' ? result.signedHex : undefined };
  S.review = null;
  S.view = 'status';
  S.err = '';
  render();
  if (verdict.state === 'failed') void refresh();
}

function openTx(txId) {
  const record = S.records.find((r) => r.txId === txId);
  if (record) {
    S.tx = { ...toRecordView(record), signedHex: S.tx?.txId === txId ? S.tx.signedHex : undefined };
    S.txBack = S.view;
    S.view = 'status';
    return render();
  }
  const row = S.hist.rows.find((r) => r.txId === txId);
  if (!row) return;
  const c = classifyHistory(row, S.address);
  const confirmations = confirmationsAt(row.height, S.node.height);
  S.tx = {
    txId: c.txId,
    state: 'confirmed',
    dir: c.dir,
    label: c.label,
    amount: c.amount,
    gas: c.gas,
    height: row.height,
    timestamp: row.timestamp,
    counterparty: c.counterparty ?? '',
    confirmations: confirmations ?? 1,
    message: `${c.label}. Included in block ${row.height}${confirmations ? `, with ${confirmations} confirmation${confirmations === 1 ? '' : 's'}` : ''}.`,
    note: c.note || 'The node shows the other party partly masked; only your own address is shown in full.',
  };
  S.txBack = S.view;
  S.view = 'tx';
  render();
}

// ── unlocked session ─────────────────────────────────────────────────────────

const idle = createIdleLock({ ms: IDLE_MS, onLock: () => lock() });

async function enter(address) {
  S.address = address;
  S.unlocked = true;
  S.balance = { state: 'loading', seals: 0n, error: '' };
  S.hist = { state: 'loading', rows: [], ids: new Set(), error: '' };
  loadRecords();
  idle.touch();
  startPolling();
  go('home');
}

function lock() {
  if (!S.unlocked) return;
  S.unlocked = false;
  S.review = null;
  S.tx = null;
  S.draft = { to: '', amount: '' };
  creating = null;
  wipePhrase();
  idle.stop();
  stopPolling();
  go('unlock');
}

function startPolling() {
  stopPolling();
  poller = setInterval(() => {
    if (document.visibilityState === 'visible' && LIVE_VIEWS.has(S.view)) void refresh();
  }, POLL_MS);
}
function stopPolling() {
  clearInterval(poller);
  poller = null;
}

function tickLockout() {
  clearInterval(lockoutTimer);
  lockoutTimer = setInterval(() => {
    S.lockedFor = Math.max(0, S.lockedFor - 1);
    const button = app.querySelector('form[data-submit=unlock] button[type=submit]');
    if (button) {
      button.textContent = S.lockedFor ? `WAIT ${S.lockedFor}s` : 'UNLOCK';
      button.disabled = S.lockedFor > 0;
    }
    if (!S.lockedFor) clearInterval(lockoutTimer);
  }, 1000);
  const button = app.querySelector('form[data-submit=unlock] button[type=submit]');
  if (button) {
    button.textContent = `WAIT ${S.lockedFor}s`;
    button.disabled = true;
  }
}

// ── QR image upload and the live fee line ────────────────────────────────────

async function fromImage(file) {
  if (file.size > 12 * 1024 * 1024) return setErr('That image is too large.');
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const text = await W.decodeFrame(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (!text) return setErr('No QR code was found in that image. Try a closer, sharper one.');
    const verdict = parseRecipient(text, { hrp: S.net.hrp, own: S.address, readScanned: bundle.readScanned });
    if (!verdict.ok) return setErr(verdict.message);
    setRecipient(verdict.value);
    setErr('');
  } catch {
    setErr('That file could not be read as an image.');
  }
}

function previewFee() {
  const out = app.querySelector('#fee');
  const input = app.querySelector('#am');
  if (!out || !input || !bundle) return;
  const amount = parseAmount(input.value);
  out.textContent = amount.ok ? `${exactObs(bundle.expectedGas(amount.seals))} OBS` : 'set by the protocol for the amount';
}

async function drawQr() {
  try {
    const svg = await W.qrFor(S.address); // generated by our own encoder from the address: trusted markup
    if (S.view !== 'receive') return;
    S.qr = svg;
    const box = app.querySelector('#qr');
    if (box) box.innerHTML = svg;
  } catch (error) {
    setErr(`The QR code could not be drawn: ${error?.message ?? 'unknown error'}. The address above is still correct.`);
  }
}

// ── events: one listener per kind, delegated ─────────────────────────────────

document.addEventListener('click', (event) => {
  touch();
  const el = event.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const action = A[el.dataset.a];
  if (action) void Promise.resolve(action(el)).catch((error) => setErr(error?.message || 'Something went wrong.'));
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-submit]');
  if (!form) return;
  event.preventDefault();
  touch();
  const handler = F[form.dataset.submit];
  if (handler && !working) void Promise.resolve(handler(form)).catch((error) => { busy(form, false); setErr(error?.message || 'Something went wrong.'); });
});

document.addEventListener('input', (event) => {
  touch();
  if (event.target.id === 'am') previewFee();
});

document.addEventListener('change', (event) => {
  if (event.target.id === 'fi' && event.target.files?.[0]) {
    void fromImage(event.target.files[0]);
    event.target.value = '';
  }
});

document.addEventListener('keydown', touch);
document.addEventListener('pointerdown', touch);

document.addEventListener('visibilitychange', () => {
  // A phrase on screen does not stay on a hidden tab.
  if (document.visibilityState === 'hidden' && shownPhrase) {
    wipePhrase();
    if (S.view === 'backup') render();
  }
});

function touch() {
  if (S.unlocked) idle.touch();
}

boot();
