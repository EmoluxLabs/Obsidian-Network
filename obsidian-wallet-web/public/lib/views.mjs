/**
 * The screens, as pure functions from state to markup.
 *
 * The layout, the copy and the order are the supplied design's (template/obsidian-wallet.html); what changed is where
 * every value comes from. Rules this file keeps:
 *
 *   - Every dynamic string goes through `esc`. A value from the node, from a QR code or from the user is text, always.
 *   - No inline style, no inline handler: a class, or a `data-a` / `data-submit` attribute the controller delegates on.
 *   - No password or phrase is ever written back into markup. The only secret that is rendered is the recovery phrase
 *     the user is being asked to write down, and it is passed in for that one screen.
 *   - A value that is not known is shown as "Unavailable", never as 0.
 */

import { esc, exactObs, shortAddress, isTestNetwork, classifyHistory } from './pure.mjs';

const LOGO = '/logo.png';
const logo = (size) => `<img class="logo" src="${LOGO}" width="${size}" height="${size}" alt="Obsidian">`;

const upper = (s) => String(s ?? '').toUpperCase();

export const fmtTime = (seconds) => {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return new Date(n * 1000).toLocaleString();
};

// ── pieces ───────────────────────────────────────────────────────────────────

const netPill = (S) => {
  if (S.net.state !== 'ok') return '<span class="pill w">NETWORK UNVERIFIED</span>';
  return `<span class="pill${isTestNetwork(S.net.name) ? ' w' : ''}">${esc(upper(S.net.name))}</span>`;
};

const nodePill = (S) => {
  if (S.node.state === 'loading') return '<span class="pill w">CONNECTING…</span>';
  if (S.node.state === 'error') return '<span class="pill e">NODE UNREACHABLE</span>';
  const syncing = S.node.syncing ? ' · SYNCING' : '';
  return `<span class="pill${S.node.syncing ? ' w' : ''}">BLOCK ${esc(S.node.height.toLocaleString('en-US'))}${syncing}</span>`;
};

const hdr = (title, right = '') => `<div class="hd"><div class="hd-l">${logo(34)}<b class="hd-t">${esc(title)}</b></div>${right}</div>`;
const back = (to, label = '‹ BACK') => `<div class="hd"><button type="button" class="back" data-a="go" data-v="${esc(to)}">${esc(label)}</button><span></span></div>`;

const field = ({ id, label, type = 'text', placeholder = '', autocomplete = 'off', extra = '' }) =>
  `<label for="${esc(id)}">${esc(label)}</label><input id="${esc(id)}" type="${esc(type)}" placeholder="${esc(placeholder)}" autocomplete="${esc(autocomplete)}" spellcheck="false" autocapitalize="off" ${extra}>`;

const err = (S) => `<div class="err" role="alert" aria-live="polite">${esc(S.err || '')}</div>`;

const testBanner = (S) =>
  S.net.state === 'ok' && isTestNetwork(S.net.name)
    ? `<div class="wr">This is the <b>${esc(S.net.name)}</b>, a test network. Its coins have no value, and addresses here start with <span class="m">${esc(S.net.hrp)}1</span>. Never send coins from another network to these addresses.</div>`
    : '';

/** Bold the first and last characters of an address: the two places a look-alike address differs least. */
const address = (a) => {
  const t = String(a ?? '');
  if (t.length < 24) return esc(t);
  return `<b>${esc(t.slice(0, 8))}</b>${esc(t.slice(8, -8))}<b>${esc(t.slice(-8))}</b>`;
};

const STATE_WORDS = {
  prepared: 'Prepared',
  signed: 'Signed',
  submitted: 'Submitted',
  pending: 'Pending',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  failed: 'Not sent',
  expired: 'Expired',
};
export const stateWord = (state) => STATE_WORDS[state] ?? 'Unknown';

// ── amount lines ─────────────────────────────────────────────────────────────

const signed = (dir, amount) => {
  if (amount === null || amount === undefined) return '';
  const sign = dir === 'sent' || dir === 'self' ? '−' : dir === 'received' || dir === 'mining' ? '+' : '';
  return `${sign}${exactObs(amount)}`;
};

/**
 * The activity list: what this device submitted and has not yet seen in the node's history, then the node's history.
 * Rows are buttons, so keyboard and screen reader reach every one.
 */
export function activityRows(S, limit) {
  const rows = [];
  for (const r of S.records.filter((x) => !S.hist.ids.has(x.txId))) {
    const stateName = r.state;
    rows.push(
      `<button type="button" class="row tx" data-a="tx" data-id="${esc(r.txId)}"><div><b>Sent</b><div class="mu sm">${esc(fmtTime(r.submittedAt / 1000))} · <span class="st st-${esc(stateName)}">${esc(stateWord(stateName))}</span></div></div><b class="m">−${esc(exactObs(r.amount))}</b></button>`,
    );
  }
  if (S.hist.state === 'ok') {
    for (const item of S.hist.rows) {
      const c = classifyHistory(item, S.address);
      const conf = Number.isInteger(item.height) && S.node.state === 'ok' ? S.node.height - item.height + 1 : null;
      const status = conf === null ? 'Confirmed' : `Confirmed · ${conf}`;
      const tone = c.dir === 'received' || c.dir === 'mining' ? ' ok' : '';
      rows.push(
        `<button type="button" class="row tx" data-a="tx" data-id="${esc(c.txId)}"><div><b>${esc(c.label)}</b><div class="mu sm">${esc(fmtTime(c.timestamp))} · <span class="ok">${esc(status)}</span></div></div><b class="m${tone}">${esc(signed(c.dir, c.amount))}</b></button>`,
      );
    }
  }
  const shown = limit ? rows.slice(0, limit) : rows;
  if (shown.length) return `<div class="card">${shown.join('')}</div>`;
  if (S.hist.state === 'loading') return '<div class="card"><div class="row mu">Loading transactions…</div></div>';
  if (S.hist.state === 'error') {
    return `<div class="card"><div class="row mu"><span>Transactions are unavailable: ${esc(S.hist.error)}</span><button type="button" class="btn s inline" data-a="refresh">RETRY</button></div></div>`;
  }
  return '<div class="card"><div class="row mu">No transactions on this address yet.</div></div>';
}

// ── views ────────────────────────────────────────────────────────────────────

export const V = {
  splash: () => `<div class="splash">${logo(120)}<b class="brand">OBSIDIAN WALLET</b></div>`,

  fatal: (S) =>
    `<div class="center-col top-46">${logo(96)}<b class="brand sm">OBSIDIAN WALLET</b></div>` +
    `<h1 class="mt-26">CANNOT CONFIRM THE NETWORK</h1><p class="mu">${esc(S.net.error || 'This page could not confirm which network it is on.')}</p>` +
    `<div class="wr">The wallet will not create, unlock or sign anything until it knows this page and its node are on the same network. Nothing was signed and no funds moved.</div>` +
    `<button type="button" class="btn p" data-a="retryNet">TRY AGAIN</button>`,

  welcome: (S) =>
    `<div class="center-col top-46">${logo(110)}<b class="brand">OBSIDIAN NETWORK</b></div>` +
    `<h1 class="mt-26 t-center">DECENTRALISED OBS COIN WALLET</h1>` +
    `<p class="mu t-center lh">Create or import a wallet. Your keys are made and kept on this device, encrypted with your password. Nobody else can recover them.</p>` +
    `<div class="t-center">${netPill(S)}</div>${testBanner(S)}` +
    `<button type="button" class="btn p mt-22" data-a="go" data-v="create1">CREATE WALLET</button>` +
    `<button type="button" class="btn" data-a="go" data-v="import">IMPORT WALLET</button>`,

  create1: (S) =>
    `${back('welcome')}<h1>CREATE WALLET</h1><p class="mu">Choose a password. It encrypts your wallet on this device. It cannot be reset, so keep it safe.</p>` +
    `<form data-submit="makeWallet" novalidate>` +
    field({ id: 'pw', label: 'PASSWORD', type: 'password', placeholder: `At least ${S.minPass} characters`, autocomplete: 'new-password' }) +
    field({ id: 'pw2', label: 'CONFIRM PASSWORD', type: 'password', autocomplete: 'new-password' }) +
    `${err(S)}<button type="submit" class="btn p"${S.busy ? ' disabled' : ''}>${S.busy ? 'GENERATING KEYS…' : 'CREATE WALLET'}</button></form>`,

  create2: (S, phrase) =>
    `${hdr('RECOVERY')}<h1 class="h-24">SAVE YOUR RECOVERY PHRASE</h1>` +
    `<p class="mu lh">Write these ${esc(phrase.split(' ').length)} words down, in order, on paper. They restore your wallet on any device. This is the only copy: nothing is saved on this device until you continue.</p>` +
    `<div class="card pad"><ol class="words">${phrase
      .split(' ')
      .map((w, i) => `<li class="m"><span class="mu n">${i + 1}</span> ${esc(w)}</li>`)
      .join('')}</ol></div>` +
    `<div class="wr">Anyone with these words controls your funds. Store them offline. Obsidian cannot recover them for you. They are deliberately not copied or downloaded as a file: a file or the clipboard is easy to leak.</div>` +
    `<form data-submit="finishCreate" novalidate><label class="check"><input id="ck" type="checkbox">I have written down my recovery phrase and stored it safely</label>` +
    `${err(S)}<button type="submit" class="btn p"${S.busy ? ' disabled' : ''}>${S.busy ? 'SEALING…' : 'CONTINUE'}</button></form>` +
    `<button type="button" class="btn" data-a="cancelCreate">CANCEL</button>`,

  import: (S) => {
    const phrase = S.tab !== 'backup';
    return (
      `${back('welcome')}<h1>IMPORT WALLET</h1><p class="mu">Use your recovery phrase, or an encrypted backup file you downloaded from this wallet.</p>` +
      `<div class="two mt-14"><button type="button" class="btn s${phrase ? ' p' : ''}" data-a="tab" data-v="phrase">RECOVERY PHRASE</button><button type="button" class="btn s${phrase ? '' : ' p'}" data-a="tab" data-v="backup">ENCRYPTED BACKUP</button></div>` +
      `<form data-submit="${phrase ? 'importPhrase' : 'importBackup'}" novalidate>` +
      (phrase
        ? `<label for="rp">RECOVERY PHRASE (12 OR 24 WORDS)</label><textarea id="rp" placeholder="word1 word2 word3 …" spellcheck="false" autocomplete="off" autocapitalize="off"></textarea>` +
          field({ id: 'pw', label: 'NEW PASSWORD', type: 'password', placeholder: `At least ${S.minPass} characters`, autocomplete: 'new-password' }) +
          field({ id: 'pw2', label: 'CONFIRM PASSWORD', type: 'password', autocomplete: 'new-password' })
        : `<label for="bf">BACKUP FILE</label><input id="bf" type="file" accept="application/json,.json" class="file">` +
          `<label for="bt">…OR PASTE ITS CONTENTS</label><textarea id="bt" placeholder='{"version":1,"kdf":"PBKDF2-SHA256", …}' spellcheck="false" autocomplete="off"></textarea>` +
          field({ id: 'pw', label: 'THE BACKUP’S PASSWORD', type: 'password', autocomplete: 'current-password' }) +
          `<p class="mu sm">The same password then protects the wallet on this device.</p>`) +
      `${err(S)}<button type="submit" class="btn p"${S.busy ? ' disabled' : ''}>${S.busy ? 'IMPORTING…' : 'IMPORT WALLET'}</button></form>` +
      `<div class="wr">Private keys cannot be imported: this wallet is restored from the recovery phrase only.</div>`
    );
  },

  unlock: (S) =>
    `<div class="center-col top-60">${logo(96)}<b class="brand sm">OBSIDIAN WALLET</b></div><h1 class="mt-28">WELCOME BACK</h1>` +
    `<div class="m mu sm mt-8">${esc(shortAddress(S.address))}</div><div class="mt-8">${netPill(S)}</div>` +
    `<form data-submit="unlock" novalidate>${field({ id: 'pw', label: 'PASSWORD', type: 'password', autocomplete: 'current-password' })}` +
    `${err(S)}<button type="submit" class="btn p"${S.busy || S.lockedFor ? ' disabled' : ''}>${S.busy ? 'UNLOCKING…' : S.lockedFor ? `WAIT ${esc(S.lockedFor)}s` : 'UNLOCK'}</button></form>` +
    `<p class="mu t-center mt-18 sm">Forgot your password? <button type="button" class="back link" data-a="go" data-v="remove">Remove it and import with your recovery phrase</button></p>`,

  home: (S) => {
    let balance;
    if (S.balance.state === 'ok') balance = `<div class="m balv" id="bal">${esc(exactObs(S.balance.seals))} <span class="unit">OBS</span></div>`;
    else if (S.balance.state === 'loading') balance = '<div class="m balv mu" id="bal">Loading…</div>';
    else balance = `<div class="m balv mu" id="bal">Unavailable</div><div class="err flush">${esc(S.balance.error || 'The balance could not be read.')} <button type="button" class="btn s inline" data-a="refresh">RETRY</button></div>`;
    return (
      hdr('WALLET', `<div class="hd-r">${netPill(S)}<button type="button" class="btn s auto" data-a="lock">LOCK</button></div>`) +
      testBanner(S) +
      `<div class="card bal-card"><div class="lb flush mu-c">OBS COIN BALANCE</div>${balance}` +
      `<div class="m addr" id="addr">${esc(S.address)}</div>` +
      `<button type="button" class="btn s mt-12" data-a="copyAddr">${S.copied ? 'COPIED' : 'COPY ADDRESS'}</button>` +
      `<div class="mu sm mt-10">Fiat value: unavailable (there is no verified price source)</div></div>` +
      `<div class="two mt-2"><button type="button" class="btn p" data-a="go" data-v="send">SEND</button><button type="button" class="btn" data-a="go" data-v="receive">RECEIVE</button></div>` +
      `<div class="lb">RECENT TRANSACTIONS</div>${activityRows(S, 5)}` +
      `<button type="button" class="btn s mt-10 w-100" data-a="go" data-v="activity">ALL ACTIVITY</button>` +
      `<div class="lb">NETWORK</div><div class="card">` +
      `<div class="row"><span>NETWORK</span><b>${esc(S.net.state === 'ok' ? S.net.name : 'Unverified')}</b></div>` +
      `<div class="row"><span>ADDRESS PREFIX</span><b class="m">${esc(S.net.hrp || '—')}1…</b></div>` +
      `<div class="row"><span>CHAIN ID</span><b class="m">${esc(S.net.chainId ?? '—')}</b></div>` +
      `<div class="row"><span>NODE</span>${nodePill(S)}</div>` +
      `<div class="row"><span>LAST BLOCK</span><b class="sm">${esc(S.node.state === 'ok' ? fmtTime(S.node.lastBlockTimestamp) : 'Unavailable')}</b></div></div>` +
      `<div class="lb">WALLET</div><div class="card">` +
      `<button type="button" class="row link-row" data-a="go" data-v="backup">Backup &amp; recovery<span>›</span></button>` +
      `<button type="button" class="row link-row danger" data-a="go" data-v="remove">Remove wallet from this device<span>›</span></button></div>`
    );
  },

  activity: (S) => `${back('home')}<h1>ACTIVITY</h1><p class="mu">What the node shows for this address, and what this device has sent.</p>${activityRows(S, 0)}<button type="button" class="btn s mt-10 w-100" data-a="refresh">REFRESH</button>`,

  receive: (S) =>
    `${back('home')}<h1>RECEIVE OBS</h1><p class="mu">Show this QR code to the sender, or share your address.</p>` +
    `<div class="qr-wrap"><div class="qr" id="qr">${S.qr ? S.qr : '<span class="mu">Preparing the code…</span>'}</div></div>` +
    `<div class="card pad t-center"><div class="lb flush mb-8">YOUR OBSIDIAN ADDRESS</div><div class="m addr" id="addr">${esc(S.address)}</div></div>` +
    `<button type="button" class="btn p" data-a="copyAddr">${S.copied ? 'COPIED' : 'COPY ADDRESS'}</button><button type="button" class="btn" data-a="share">SHARE</button>` +
    `<div class="wr">Network: <b>${esc(S.net.state === 'ok' ? upper(S.net.name) : 'unverified')}</b>. Only send ${S.net.state === 'ok' ? esc(S.net.name) : ''} OBS Coin to this address; coins from another network sent here are lost. The code holds the address only, no amount.</div>${err(S)}`,

  send: (S) => {
    const d = S.draft;
    const avail = S.balance.state === 'ok' ? `${esc(exactObs(S.balance.seals))} OBS` : 'unavailable';
    return (
      `${back('home')}<h1>SEND OBS</h1>${testBanner(S)}` +
      `<form data-submit="review" novalidate>` +
      field({ id: 'to', label: 'RECIPIENT ADDRESS', placeholder: `${S.net.hrp || 'obs'}1…`, extra: `value="${esc(d.to)}" inputmode="text"` }) +
      `<div class="two mt-10"><button type="button" class="btn s" data-a="scan">SCAN QR</button><button type="button" class="btn s" data-a="upload">UPLOAD QR IMAGE</button></div>` +
      `<input id="fi" type="file" accept="image/*" class="hidden">` +
      field({ id: 'am', label: 'AMOUNT (OBS)', placeholder: '0.00', extra: `value="${esc(d.amount)}" inputmode="decimal"` }) +
      `<div class="mu sm mt-8" id="feeline">Available ${avail} · Fee <span id="fee">set by the protocol for the amount</span></div>` +
      `${err(S)}<button type="submit" class="btn p"${S.busy ? ' disabled' : ''}>${S.busy ? 'CHECKING WITH THE NODE…' : 'REVIEW TRANSACTION'}</button></form>`
    );
  },

  review: (S) => {
    const r = S.review;
    return (
      `${back('send', '‹ EDIT')}<h1>REVIEW TRANSACTION</h1>${testBanner(S)}<div class="card mt-16">` +
      `<div class="row stack"><span>TO</span><b class="m addr-l">${address(r.to)}</b></div>` +
      `<div class="row"><span>AMOUNT</span><b class="m">${esc(exactObs(r.amount))} OBS</b></div>` +
      `<div class="row"><span>FEE</span><b class="m">${esc(exactObs(r.gas))} OBS</b></div>` +
      `<div class="row"><span>TOTAL</span><b class="m">${esc(exactObs(r.amount + r.gas))} OBS</b></div>` +
      `<div class="row"><span>NETWORK</span><b>${esc(upper(S.net.name))}</b></div>` +
      `<div class="row"><span>BALANCE AFTER</span><b class="m">${esc(exactObs(r.balance - r.amount - r.gas))} OBS</b></div></div>` +
      `<div class="wr">Check the first and last characters of the address. Signing happens on this device with your key. Once signed and sent, a transaction cannot be taken back.</div>` +
      `<form data-submit="sign" novalidate>${field({ id: 'pw', label: 'ENTER YOUR PASSWORD TO AUTHORIZE', type: 'password', autocomplete: 'current-password' })}` +
      `${err(S)}<button type="submit" class="btn p"${S.busy ? ' disabled' : ''}>${S.busy ? 'SIGNING…' : 'CONFIRM &amp; SIGN'}</button></form>` +
      `<button type="button" class="btn" data-a="go" data-v="send"${S.busy ? ' disabled' : ''}>EDIT</button>`
    );
  },

  status: (S) => {
    const t = S.tx;
    const steps = [
      ['Prepared', true],
      ['Signed on this device', t.signed],
      ['Accepted by the node', ['submitted', 'pending', 'confirmed'].includes(t.state) || t.accepted],
      ['Seen in the node’s mempool', ['pending', 'confirmed'].includes(t.state) || t.seenPending],
      [t.state === 'confirmed' ? `Included in a block · ${t.confirmations} confirmation${t.confirmations === 1 ? '' : 's'}` : 'Included in a block', t.state === 'confirmed'],
    ];
    const head = { confirmed: 'CONFIRMED', pending: 'PENDING', submitted: 'SUBMITTED', rejected: 'REJECTED', failed: 'NOT CONFIRMED SENT', expired: 'EXPIRED' }[t.state] ?? 'STATUS';
    const retry = t.state === 'failed' && t.signedHex
      ? `<button type="button" class="btn p" data-a="resubmit"${S.busy ? ' disabled' : ''}>${S.busy ? 'SENDING…' : 'SEND THE SAME TRANSACTION AGAIN'}</button>`
      : '';
    const check = t.state !== 'confirmed' && t.state !== 'rejected' && t.state !== 'expired'
      ? `<button type="button" class="btn" data-a="checkTx">CHECK WITH THE NODE NOW</button>`
      : '';
    return (
      `${hdr('TRANSACTION')}<h1 class="st-h st-${esc(t.state)}">${esc(head)}</h1><p class="mu lh" id="txmsg">${esc(t.message)}</p>` +
      `<div class="card pad"><ul class="steps">${steps.map(([label, done]) => `<li class="${done ? 'done' : ''}">${esc(label)}</li>`).join('')}</ul></div>` +
      txCard(S, t) + err(S) + retry + check +
      `<button type="button" class="btn${retry ? '' : ' p'}" data-a="go" data-v="home">BACK TO WALLET</button>`
    );
  },

  tx: (S) => {
    const t = S.tx;
    return (
      `${back(S.txBack || 'home')}<h1 class="st-h st-${esc(t.state)}">${esc(upper(stateWord(t.state)))}</h1><p class="mu lh">${esc(t.message || '')}</p>` +
      txCard(S, t) +
      `<div class="mu sm mt-10">${esc(t.note || '')}</div><button type="button" class="btn s mt-10 w-100" data-a="checkTx">CHECK WITH THE NODE</button>`
    );
  },

  backup: (S, phrase) =>
    `${back('home')}<h1>BACKUP &amp; RECOVERY</h1><p class="mu lh">Your recovery phrase is the only thing that restores this wallet if this device is lost.</p>` +
    (phrase
      ? `<div class="lb">RECOVERY PHRASE</div><div class="card pad"><ol class="words">${phrase.split(' ').map((w, i) => `<li class="m"><span class="mu n">${i + 1}</span> ${esc(w)}</li>`).join('')}</ol></div>` +
        `<div class="wr">Anyone with these words controls your funds. They hide again in one minute, when you lock, or when you leave this page.</div><button type="button" class="btn" data-a="hidePhrase">HIDE</button>`
      : `<form data-submit="reveal" novalidate>${field({ id: 'pw', label: 'PASSWORD', type: 'password', autocomplete: 'current-password' })}${err(S)}<button type="submit" class="btn p"${S.busy ? ' disabled' : ''}>${S.busy ? 'CHECKING…' : 'SHOW RECOVERY PHRASE'}</button></form>`) +
    `<div class="lb">ENCRYPTED BACKUP</div><div class="card pad"><p class="mu sm lh m0">A file that holds your wallet encrypted with your password. It is useless without the password, and it restores the wallet on the Import screen. It is not a replacement for the recovery phrase.</p></div>` +
    `<button type="button" class="btn" data-a="downloadBackup">DOWNLOAD ENCRYPTED BACKUP</button>`,

  remove: (S) =>
    `${back(S.address && S.unlocked ? 'home' : S.address ? 'unlock' : 'welcome')}<h1>REMOVE WALLET</h1>` +
    `<p class="mu lh">This deletes the encrypted wallet from this browser. It does not delete the wallet from the network: anyone with the recovery phrase can bring it back.</p>` +
    `<div class="wr"><b>Without your recovery phrase the funds cannot be recovered.</b> The wallet’s address is <span class="m">${esc(shortAddress(S.address))}</span>.</div>` +
    `<form data-submit="remove" novalidate><label class="check"><input id="ck" type="checkbox">I have my recovery phrase and want to remove this wallet from this device</label>` +
    `${err(S)}<button type="submit" class="btn p danger-btn">REMOVE WALLET</button></form>`,
};

/** The facts of a transaction. A field is shown only when this device or the node supplied it. */
function txCard(S, t) {
  const rows = [];
  if (t.to) rows.push(`<div class="row stack"><span>TO</span><b class="m addr-l">${address(t.to)}</b></div>`);
  else if (t.counterparty) rows.push(`<div class="row"><span>${esc(upper(t.dir === 'received' ? 'FROM' : 'TO'))}</span><b class="m sm">${esc(t.counterparty)}</b></div>`);
  if (t.amount !== null && t.amount !== undefined) rows.push(`<div class="row"><span>AMOUNT</span><b class="m">${esc(exactObs(t.amount))} OBS</b></div>`);
  if (t.gas !== null && t.gas !== undefined && t.gas > 0n) rows.push(`<div class="row"><span>FEE</span><b class="m">${esc(exactObs(t.gas))} OBS</b></div>`);
  if (t.amount !== null && t.amount !== undefined && t.gas !== null && t.gas !== undefined && t.dir !== 'received') rows.push(`<div class="row"><span>TOTAL</span><b class="m">${esc(exactObs(t.amount + t.gas))} OBS</b></div>`);
  if (t.height) rows.push(`<div class="row"><span>BLOCK</span><b class="m">${esc(t.height)}</b></div>`);
  if (t.timestamp) rows.push(`<div class="row"><span>BLOCK TIME</span><b class="sm">${esc(fmtTime(t.timestamp))}</b></div>`);
  if (t.validUntil && t.state !== 'confirmed') rows.push(`<div class="row"><span>VALID UNTIL</span><b class="sm">${esc(fmtTime(t.validUntil))}</b></div>`);
  rows.push(`<div class="row stack"><span>TRANSACTION ID</span><b class="m addr-l" id="txid">${esc(t.txId)}</b></div>`);
  return `<div class="card mt-16">${rows.join('')}</div>`;
}
