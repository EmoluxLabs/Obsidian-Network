/**
 * The screens.
 *
 * The design file (public/index.html) is not edited. Its CSS, its tokens, its
 * geometry and its markup helpers are used as authored; what this module replaces is
 * the *content* of every screen that carried invented data.
 *
 * How it reaches the design's helpers
 *   `hdr`, `nav`, `fld`, `logo` and `back` are top-level `const` arrow functions in a
 *   classic script. That puts them in the global lexical environment, where a module
 *   CAN read them by bare name but CANNOT overwrite them, and it does not put them on
 *   `window` at all. So `window.hdr` is undefined and an override would be silently
 *   dead — which is exactly how the first version of this app did nothing at all.
 *
 *   Each helper is therefore read here and wrapped, with a plain fallback if the
 *   binding is ever renamed. tests/design-contract.test.mjs asserts the bindings
 *   still exist, so a rename fails the build instead of quietly degrading the layout.
 *
 * What is gone, and why
 *   - the synthesized `addr()` and the `ht()` derived from Date.now(): both invented
 *     values that looked authoritative;
 *   - the `VALID` invite list, the `TAKEN` names, and the constants `RATE`, `FEE` and
 *     `PRICE`: none of them came from the protocol;
 *   - the session timer that credited RATE*4 to a local balance with no transaction;
 *   - the Edge Node screen: a browser cannot run a node, and a switch that pretends
 *     otherwise is the kind of thing this project does not ship.
 *
 * Every figure below is either a value the node returned or an explicit "unavailable".
 * Nothing is estimated, extrapolated or defaulted into looking plausible.
 */

import { sealsToObs, formatDuration, formatTime, normaliseName } from './data.mjs';

// ── the design's own helpers ─────────────────────────────────────────────────

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[c]);
}

function designHdr(title) {
  try {
    return hdr(title);
  } catch {
    return `<div class="hd"><b style="letter-spacing:.18em">${esc(title)}</b><span class="pill">LIVE</span></div>`;
  }
}

function designNav(active) {
  try {
    return nav(active);
  } catch {
    return '';
  }
}

function designLogo(size) {
  try {
    return logo(size);
  } catch {
    return '';
  }
}

function designField(id, label, type, placeholder) {
  try {
    return fld(id, label, type, placeholder);
  } catch {
    return `<label>${esc(label)}</label><input id="${esc(id)}" type="${esc(type || 'text')}" placeholder="${esc(placeholder || '')}" autocomplete="off">`;
  }
}

function designBack(to) {
  try {
    return back(to);
  } catch {
    return `<div class="hd"><b onclick="ObsidianGo('${esc(to)}')" style="cursor:pointer;font-size:13px;letter-spacing:.1em">‹ BACK</b></div>`;
  }
}

/**
 * The header, with a pill that reports the real thing.
 *
 * The design's pill always read LIVE, including with no chain behind it. A status
 * indicator that cannot be wrong because it never changes is not a status indicator.
 */
function header(s, title) {
  const pill = s.status
    ? `<span class="pill">${esc(networkLabel(s))}</span>`
    : `<span class="pill" style="background:#FDECEA;color:#A12626">OFFLINE</span>`;
  return designHdr(title).replace(/<span class="pill">LIVE<\/span>/, pill);
}

function networkLabel(s) {
  const name = s.network?.network?.name ?? s.status?.network ?? s.config?.network;
  if (!name) return 'LIVE';
  return String(name).replace(/[-_]/g, ' ').toUpperCase();
}

/** A "the node has not answered" panel. Never a fabricated figure. */
function unavailable(what) {
  return `<div class="card"><div class="row mu">${esc(what)}</div></div>`;
}

function errorLine(s) {
  return `<div class="err">${esc(s.error || '')}</div>`;
}

function noticeLine(s) {
  return s.notice ? `<div class="ok" style="font-size:13px;font-weight:600;margin-top:10px">${esc(s.notice)}</div>` : '';
}

function rows(entries) {
  return `<div class="card">${entries
    .map(
      ([label, value, cls]) =>
        `<div class="row"><span>${esc(label)}</span><b class="${cls ? esc(cls) : ''}">${value}</b></div>`,
    )
    .join('')}</div>`;
}

/** A value or an em dash. Used for every number that came from the node. */
function orDash(value, render = (v) => esc(v)) {
  return value === null || value === undefined || value === '' ? '—' : render(value);
}

function busy(label, s, key) {
  return s.busy === key ? `${esc(label)}…` : esc(label);
}

// ── screens ──────────────────────────────────────────────────────────────────

export const SCREENS = {
  /** The design's splash is pure animation and fabricates nothing, so it is kept. */
  splash: () => (typeof V !== 'undefined' && V.splash ? V.splash() : ''),

  landing: (s) =>
    `<div class="hd"><div style="display:flex;align-items:center;gap:10px">${designLogo(38)}<b style="font-size:13px;letter-spacing:.18em">OBSIDIAN NETWORK</b></div>` +
    `<button class="btn" style="width:48px;height:48px;margin:0;border-radius:14px" onclick="ObsidianToggleMenu()" aria-label="Menu">☰</button></div>` +
    (s.menu
      ? `<div class="card" style="margin-bottom:10px">${[
          ['explorer', 'EXPLORER'],
          ['ons', 'ONS'],
          ['api', 'API'],
          ['signin', 'SIGN UP / SIGN IN'],
        ]
          .map(
            ([k, t]) =>
              `<div class="row" onclick="ObsidianGo('${k}')" style="cursor:pointer;font-weight:800;letter-spacing:.1em;height:54px">${t}<span>›</span></div>`,
          )
          .join('')}</div>`
      : '') +
    `<div class="lb" style="margin-top:14px">INVITE-ONLY · PROOF OF TIME</div><h1>THE PROOF OF TIME BLOCKCHAIN</h1>` +
    `<p class="mu" style="line-height:1.55;margin:14px 0 0">Obsidian is a blockchain built around time, participation and transparent verification. Mine from your phone, hold your own wallet, and inspect every block.</p>` +
    `<div style="margin:24px auto;width:260px;height:260px;border-radius:50%;border:1px solid var(--bd);display:flex;align-items:center;justify-content:center;background:#fff;box-shadow:0 8px 28px rgba(11,13,16,.08)">${designLogo(190)}</div>` +
    `<button class="btn p" onclick="ObsidianGo('signup')">START MINING</button>` +
    `<button class="btn" onclick="ObsidianGo('signup')">CREATE WALLET</button>` +
    `<button class="btn" onclick="ObsidianGo('explorer')">EXPLORER</button>` +
    `<div class="lb">NETWORK</div>` +
    rows([
      ['NETWORK', esc(orDash(s.network?.network?.name ?? s.status?.network))],
      ['CHAIN ID', esc(orDash(s.network?.network?.chainId ?? s.status?.chainId)), 'm'],
      ['BLOCK HEIGHT', orDash(s.status?.height, (h) => `#${Number(h).toLocaleString()}`), 'm'],
      ['SUPPLY', orDash(s.status?.supplyObs, (v) => `${esc(v)} OBS`), 'm'],
      ['ACTIVE MINERS', esc(orDash(s.status?.mining?.activeMiners ?? s.schedule?.activeMiners)), 'm'],
    ]) +
    `<div class="lb">BUILT FOR PARTICIPATION</div>` +
    [
      ['MINE', 'Claim a reward when the protocol says you may. The chain decides, not your clock.'],
      ['SECURE', 'Your keys stay in a vault on this device. Nothing here ever sees your phrase.'],
      ['EXPLORE', 'Browse blocks, transactions and addresses straight from a node.'],
    ]
      .map(
        ([a, b]) =>
          `<div class="card" style="margin-bottom:10px;padding:16px"><b style="letter-spacing:.12em">${a}</b><div class="mu" style="margin-top:4px;font-size:14px">${b}</div></div>`,
      )
      .join('') +
    `<div style="background:var(--ob);color:#fff;border-radius:24px;padding:24px;margin-top:20px"><b style="letter-spacing:.2em;font-size:13px">OBSIDIAN NETWORK</b><div style="margin-top:10px;color:#E3C877;font-weight:700">Build. Validate. Decentralize.</div></div>`,

  signup: (s) => {
    const min = s.config?.passwordMinLength ?? 12;
    const codeCount = s.config?.recoveryCodeCount;
    return (
      `<div style="display:flex;flex-direction:column;align-items:center;padding-top:34px">${designLogo(76)}<b style="margin-top:12px;font-size:13px;letter-spacing:.22em">OBSIDIAN NETWORK</b></div>` +
      `<h1 style="margin-top:24px;font-size:26px">CREATE YOUR ACCOUNT</h1>` +
      `<p class="mu" style="margin:6px 0 0">Obsidian is invite only. You need a Gmail address${
        s.config?.authMethod === 'GMAIL_PASSWORD_MFA' ? '' : ''
      } and an invitation code to join.</p>` +
      designField('em', 'GMAIL ADDRESS', 'email', 'you@gmail.com') +
      designField('pw', 'PASSWORD', 'password', `At least ${min} characters`) +
      designField('p2', 'CONFIRM PASSWORD', 'password') +
      designField('rf', 'INVITATION CODE (REQUIRED)', 'text', 'XXXX-XXXX-XXXX-XXXX') +
      errorLine(s) +
      noticeLine(s) +
      `<button class="btn p" style="margin-top:6px" onclick="ObsidianSignup()">CREATE ACCOUNT</button>` +
      (codeCount
        ? `<p class="mu" style="font-size:12.5px;margin-top:12px">The server issues ${esc(
            codeCount,
          )} recovery codes once, at registration. They are the only way back into this account.</p>`
        : '') +
      (s.config?.mfaRequiredForMining
        ? `<p class="mu" style="font-size:12.5px">Mining needs a second factor. You will be asked to add one after your account exists.</p>`
        : '') +
      `<p class="mu" style="text-align:center">Already have an account? <b onclick="ObsidianGo('signin')" style="color:var(--ob);cursor:pointer;border-bottom:2px solid var(--go)">SIGN IN</b></p>` +
      `<p class="mu" style="text-align:center">Lost your second factor? <b onclick="ObsidianGo('recover')" style="color:var(--ob);cursor:pointer;border-bottom:2px solid var(--go)">RECOVER</b></p>`
    );
  },

  signin: (s) =>
    `<div style="display:flex;flex-direction:column;align-items:center;padding-top:50px">${designLogo(96)}<b style="margin-top:14px;font-size:13px;letter-spacing:.22em">OBSIDIAN NETWORK</b></div>` +
    `<h1 style="margin-top:28px">WELCOME BACK</h1>` +
    designField('em', 'GMAIL ADDRESS', 'email', 'you@gmail.com') +
    designField('pw', 'PASSWORD', 'password') +
    (s.mfaRequired
      ? designField('mf', 'AUTHENTICATOR CODE', 'text', '6 digits') +
        `<p class="mu" style="font-size:12.5px">This account has a second factor. Enter the current code from your authenticator.</p>`
      : '') +
    errorLine(s) +
    `<button class="btn p" style="margin-top:6px" onclick="ObsidianSignin()">${esc(
      s.busy === 'signin' ? 'CHECKING…' : 'SIGN IN',
    )}</button>` +
    `<p class="mu" style="text-align:center">New to Obsidian? <b onclick="ObsidianGo('signup')" style="color:var(--ob);cursor:pointer;border-bottom:2px solid var(--go)">Create account</b></p>` +
    `<p class="mu" style="text-align:center">Lost your second factor? <b onclick="ObsidianGo('recover')" style="color:var(--ob);cursor:pointer;border-bottom:2px solid var(--go)">Recover</b></p>`,

  recover: (s) =>
    designBack('signin') +
    `<h1 style="font-size:26px;margin-top:16px">RECOVER YOUR ACCOUNT</h1>` +
    `<p class="mu">Recovery uses one of the codes issued when the account was created. It sets a new password and clears the second factor so you can enrol a new device.</p>` +
    designField('em', 'GMAIL ADDRESS', 'email', 'you@gmail.com') +
    designField('rc', 'RECOVERY CODE', 'text') +
    designField('np', 'NEW PASSWORD', 'password', `At least ${s.config?.passwordMinLength ?? 12} characters`) +
    errorLine(s) +
    `<button class="btn p" style="margin-top:6px" onclick="ObsidianRecover()">RECOVER ACCOUNT</button>`,

  home: (s) =>
    header(s, 'OBSIDIAN NETWORK') +
    `<h1 style="font-size:24px">Welcome back${s.account?.displayName ? `, ${esc(s.account.displayName)}` : ''}.</h1>` +
    (s.recoveryCodes?.length
      ? `<div class="card" style="margin-top:14px;padding:16px"><div class="lb" style="margin:0 0 8px">YOUR RECOVERY CODES — SHOWN ONCE</div>` +
        `<div class="m" style="font-size:13px;line-height:1.9">${s.recoveryCodes.map(esc).join('<br>')}</div>` +
        `<p class="mu" style="font-size:12.5px;margin:10px 0 0">Write these down offline now. They are the only way back into this account and nobody can reissue them.</p>` +
        `<button class="btn p" style="margin-top:10px" onclick="ObsidianDismissCodes()">I HAVE WRITTEN THEM DOWN</button></div>`
      : '') +
    (s.account && !s.account.mfaEnabled
      ? `<div class="card" style="margin-top:14px;padding:16px"><b style="letter-spacing:.1em">ADD A SECOND FACTOR</b><div class="mu" style="margin-top:4px;font-size:13.5px">Mining requires MFA on this platform. Add one now.</div><button class="btn p" style="margin-top:10px" onclick="ObsidianMfaSetup()">SET UP MFA</button></div>`
      : '') +
    `<div class="card" style="margin-top:16px;padding:20px"><div class="lb" style="margin:0;color:var(--mu)">OBS BALANCE</div><div class="m" style="font-size:34px;font-weight:600;margin-top:6px">${esc(
      s.balance ? sealsToObs(s.balance.balanceSeals, 6) : '—',
    )}</div></div>` +
    `<div class="card" style="margin-top:10px">` +
    `<div class="row"><span>MINING</span><b class="${s.mining?.eligible ? 'ok' : 'mu'}">${
      s.mining ? (s.mining.eligible ? 'READY TO CLAIM' : 'NOT ELIGIBLE YET') : '—'
    }</b></div>` +
    `<div class="row"><span>WALLET ON THIS DEVICE</span><b class="${s.walletAddress ? 'ok' : 'mu'}">${
      s.walletAddress ? 'SET UP' : 'NOT SET UP'
    }</b></div>` +
    `<div class="row"><span>BLOCK HEIGHT</span><b class="m">${orDash(s.status?.height, (h) => `#${Number(h).toLocaleString()}`)}</b></div>` +
    `</div>` +
    [['mine', 'MINING'], ['wallet', 'WALLET'], ['explorer', 'EXPLORER']]
      .map(([k, t]) => `<div class="big" onclick="ObsidianGo('${k}')">${t}<span>›</span></div>`)
      .join('') +
    `<div class="lb">RECENT ACTIVITY</div>` +
    activity(s, 5) +
    designNav('home'),

  mine: (s) => {
    const m = s.mining;
    const seconds = remainingSeconds(s);
    const ready = m?.eligible === true;
    return (
      header(s, 'MINING') +
      `<div style="text-align:center"><div class="lb" style="margin:4px 0;color:var(--mu)">OBS BALANCE</div><div class="m" style="font-size:34px;font-weight:600">${esc(
        s.balance ? sealsToObs(s.balance.balanceSeals, 6) : '—',
      )}</div></div>` +
      ring(s, seconds, ready) +
      (m
        ? claimPanel(s, m, seconds, ready)
        : `<div class="card" style="margin-top:16px"><div class="row mu">${
            s.status
              ? 'No eligibility data. Set up a wallet on this device and the protocol’s own figures appear here.'
              : 'The node has not answered. Mining eligibility is decided by the protocol, so there is nothing to show.'
          }</div></div>`) +
      `<div class="card" style="margin-top:16px">` +
      `<div class="row"><span>REWARD PER CLAIM</span><b class="m">${esc(orDash(m?.rewardPerClaimObs, (v) => `${v} OBS`))}</b></div>` +
      `<div class="row"><span>CLAIM INTERVAL</span><b>${esc(
        orDash(s.params?.mining?.claimIntervalSeconds ?? s.schedule?.intervalSeconds, formatDuration),
      )}</b></div>` +
      `<div class="row"><span>CLAIMS THIS CYCLE</span><b class="m">${esc(
        orDash(m ? `${m.claimsThisCycle} used · ${m.claimsRemainingInCycle} left` : null),
      )}</b></div>` +
      `<div class="row"><span>TOTAL CLAIMS</span><b class="m">${esc(orDash(m?.totalClaims))}</b></div>` +
      `<div class="row"><span>TOTAL EARNED</span><b class="m">${esc(orDash(m?.totalRewardObs, (v) => `${v} OBS`))}</b></div>` +
      `<div class="row"><span>ACTIVE MINERS</span><b class="m">${esc(orDash(m?.activeMiners))}</b></div>` +
      `<div class="row"><span>BLOCK HEIGHT</span><b class="m">${orDash(s.status?.height, (h) => `#${Number(h).toLocaleString()}`)}</b></div>` +
      `</div>` +
      (m?.note ? `<p class="mu" style="font-size:12px;margin-top:10px;text-align:center">${esc(m.note)}</p>` : '') +
      designNav('mine')
    );
  },

  wallet: (s) =>
    header(s, 'WALLET') +
    walletCard(s) +
    `<div style="display:flex;gap:12px"><button class="btn ${s.wt === 'send' ? 'p' : ''}" onclick="ObsidianWalletTab('send')">SEND</button>` +
    `<button class="btn ${s.wt === 'receive' ? 'p' : ''}" onclick="ObsidianWalletTab('receive')">RECEIVE</button>` +
    `<button class="btn ${s.wt === 'setup' ? 'p' : ''}" onclick="ObsidianWalletTab('setup')">${s.walletAddress ? 'KEY' : 'SET UP'}</button></div>` +
    (s.wt === 'send' ? sendPanel(s) : s.wt === 'receive' ? receivePanel(s) : setupPanel(s)) +
    errorLine(s) +
    noticeLine(s) +
    `<div class="lb">RECENT TRANSACTIONS</div>` +
    activity(s, 8) +
    designNav('wallet'),

  explorer: (s) =>
    header(s, 'EXPLORER') +
    designField('q', '', 'text', 'Block height, transaction id or address') +
    `<button class="btn p" style="margin-top:10px" onclick="ObsidianSearch()">SEARCH</button>` +
    errorLine(s) +
    (s.search ? searchResult(s) : '') +
    `<div class="card" style="margin-top:14px">` +
    `<div class="row"><span>BLOCK HEIGHT</span><b class="m">${orDash(s.status?.height, (h) => `#${Number(h).toLocaleString()}`)}</b></div>` +
    `<div class="row"><span>PROTOCOL</span><b class="m">${esc(orDash(s.status?.protocolVersion ?? s.params?.protocolVersion))}</b></div>` +
    `<div class="row"><span>NETWORK</span><b>${esc(orDash(s.network?.network?.name ?? s.status?.network))}</b></div>` +
    `<div class="row"><span>MEMPOOL</span><b class="m">${esc(orDash(s.status?.mempoolSize))}</b></div>` +
    `</div>` +
    `<div class="lb">LATEST BLOCKS</div>` +
    (s.blocks?.blocks?.length
      ? `<div class="card">${s.blocks.blocks
          .slice(0, 8)
          .map(
            (b) =>
              `<div class="row" onclick="ObsidianSearch('${esc(b.height)}')" style="cursor:pointer"><div><b class="m">#${Number(
                b.height,
              ).toLocaleString()}</b><div class="m mu" style="font-size:12px;margin-top:3px">${esc(
                short(b.hash),
              )}</div></div><span class="pill">${b.transactionCount ?? b.txCount ?? 0} TX</span></div>`,
          )
          .join('')}</div>`
      : unavailable('The node has not returned any blocks.')) +
    `<div class="lb">LATEST MINING CLAIMS</div>` +
    (s.claims?.claims?.length
      ? `<div class="card">${s.claims.claims
          .slice(0, 8)
          .map(
            (c) =>
              `<div class="row"><div><b class="m">${esc(short(c.txId))}</b><div class="mu" style="font-size:12px;margin-top:3px">${esc(
                short(c.miner),
              )} · height ${esc(c.height)}</div></div><b class="m ok">+${esc(c.rewardObs)}</b></div>`,
          )
          .join('')}</div>`
      : unavailable('No mining claims have been indexed yet.')) +
    (s.account ? designNav('explorer') : `<button class="btn" onclick="ObsidianGo('landing')">‹ BACK</button>`),

  ons: (s) =>
    (s.account ? header(s, 'ONS') : designBack('landing')) +
    `<h1 style="font-size:26px">OBSIDIAN NAME SERVICE</h1>` +
    `<p class="mu" style="line-height:1.55">A .obs name maps to a wallet address. The fee is fixed by consensus and is the protocol’s only revenue source.</p>` +
    `<div class="card" style="margin-top:12px"><div class="row"><span>REGISTRATION FEE</span><b class="m">${esc(
      orDash(s.params?.ons?.registrationFeeObs, (v) => `${v} OBS`),
    )}</b></div>` +
    `<div class="row"><span>RENEWAL FEE</span><b class="m">${esc(orDash(s.params?.ons?.renewalFeeObs, (v) => `${v} OBS`))}</b></div>` +
    `<div class="row"><span>TERM</span><b>${esc(orDash(s.params?.ons?.termSeconds, formatDuration))}</b></div></div>` +
    designField('nm', 'NAME', 'text', 'Search an Obsidian name...') +
    `<button class="btn p" style="margin-top:10px" onclick="ObsidianNameSearch()">SEARCH</button>` +
    errorLine(s) +
    (s.ons?.result ? nameResult(s) : '') +
    `<div class="lb">YOUR NAMES</div>` +
    (s.ownNames?.length
      ? `<div class="card">${s.ownNames
          .map(
            (n) =>
              `<div class="row"><b class="m">${esc(n)}${/\.obs$/.test(n) ? '' : '.obs'}</b><span class="pill">ACTIVE</span></div>`,
          )
          .join('')}</div>`
      : unavailable(s.walletAddress ? 'This wallet holds no names.' : 'Set up a wallet to see the names it holds.')) +
    (s.account ? designNav('menu') : ''),

  menu: (s) =>
    header(s, 'MENU') +
    `<div class="card" style="padding:16px;margin-bottom:6px"><b>${esc(s.account?.email || '')}</b>` +
    `<div class="mu m" style="font-size:12px;margin-top:4px">${esc(
      s.walletAddress || 'No wallet on this device',
    )}</div></div>` +
    [
      ['ons', 'ONS'],
      ['api', 'API'],
      ['wallet', 'WALLET & KEY'],
    ]
      .map(([k, t]) => `<div class="big" onclick="ObsidianGo('${k}')">${t}<span>›</span></div>`)
      .join('') +
    `<div class="lb">ACCOUNT</div>` +
    rows([
      ['SECOND FACTOR', s.account?.mfaEnabled ? 'ENABLED' : 'NOT ENABLED', s.account?.mfaEnabled ? 'ok' : 'mu'],
      ['MINING', s.account?.miningEnabled ? 'ENABLED' : 'NOT ENABLED', s.account?.miningEnabled ? 'ok' : 'mu'],
      ['RECOVERY CODES LEFT', esc(orDash(s.account?.recoveryCodesRemaining)), 'm'],
      ['LINKED ADDRESS', esc(orDash(s.account?.walletAddress)), 'm'],
    ]) +
    (s.account && !s.account.mfaEnabled
      ? `<button class="btn" onclick="ObsidianMfaSetup()">SET UP MFA</button>`
      : '') +
    (s.mfa
      ? `<div class="card" style="margin-top:12px;padding:16px"><div class="lb" style="margin:0 0 8px">SCAN OR ENTER THIS SECRET</div>` +
        `<div class="m" style="font-size:13px;word-break:break-all">${esc(s.mfa.secret)}</div>` +
        `<p class="mu" style="font-size:12.5px;margin:10px 0 0">${esc(s.mfa.note || '')}</p>` +
        designField('mf', 'CODE FROM YOUR AUTHENTICATOR', 'text', '6 digits') +
        `<button class="btn p" onclick="ObsidianMfaConfirm()">CONFIRM</button></div>`
      : '') +
    `<div class="lb">INVITATIONS</div>` +
    (s.invites
      ? rows([
          ['ISSUED', `${s.invites.issued} of ${s.invites.limit}`, 'm'],
        ]) +
        (s.invites.invites?.length
          ? `<div class="card" style="margin-top:10px">${s.invites.invites
              .map(
                (i) =>
                  `<div class="row"><b class="m">${esc(i.code)}</b><span class="pill">${i.acceptedBy ? 'USED' : 'OPEN'}</span></div>`,
              )
              .join('')}</div>`
          : '') +
        `<button class="btn" onclick="ObsidianIssueInvite()">ISSUE AN INVITE</button>`
      : unavailable('Sign in to see your invitations.')) +
    `<div class="lb">CLAIM ALERTS</div>` +
    `<div class="card"><div class="row"><span>NOTIFICATIONS</span><b class="${
      s.notify === 'granted' ? 'ok' : 'mu'
    }">${esc(notifyLabel(s.notify))}</b></div></div>` +
    (s.notify === 'granted'
      ? `<button class="btn" onclick="ObsidianNotifyDisable()">TURN OFF ALERTS</button>`
      : `<button class="btn" onclick="ObsidianNotifyEnable()">TURN ON ALERTS</button>`) +
    (s.walletAddress && s.account?.walletAddress !== s.walletAddress
      ? `<button class="btn" onclick="ObsidianLinkAddress()">LINK THIS ADDRESS TO MY ACCOUNT</button>`
      : '') +
    `<button class="btn" style="color:var(--er);border-color:#E7C9C9;margin-top:24px" onclick="ObsidianSignOut()">SIGN OUT</button>` +
    designNav('menu'),

  api: (s) =>
    (s.account ? header(s, 'API') : designBack('landing')) +
    `<h1 style="font-size:26px">OBSIDIAN DEVELOPER</h1>` +
    `<p class="mu" style="line-height:1.55">Every read on this page came through one gateway. Node routes are proxied at <span class="m">/api/rpc?path=…</span>, and only a published allowlist of routes is forwarded.</p>` +
    `<div class="lb">READ THE CHAIN</div>` +
    `<pre class="m" style="background:var(--ob);color:#E3C877;border-radius:18px;padding:18px;font-size:12.5px;overflow:auto;line-height:1.6">${esc(
      [
        `curl "${
          typeof location !== 'undefined' ? location.origin : ''
        }/api/rpc?path=%2Fstatus"`,
        '',
        `{\n  "height": ${s.status?.height ?? 0},\n  "network": "${s.status?.network ?? ''}",\n  "chainId": ${
          s.status?.chainId ?? 0
        },\n  "protocolVersion": "${s.status?.protocolVersion ?? ''}"\n}`,
      ].join('\n'),
    )}</pre>` +
    `<div class="lb">MINING ELIGIBILITY</div>` +
    `<pre class="m" style="background:var(--ob);color:#E3C877;border-radius:18px;padding:18px;font-size:12.5px;overflow:auto;line-height:1.6">${esc(
      `curl "${
        typeof location !== 'undefined' ? location.origin : ''
      }/api/rpc?path=${encodeURIComponent(`/mining/status?address=${s.walletAddress ?? 'obs1…'}`)}"`,
    )}</pre>` +
    `<div class="lb">ACCOUNTS</div>` +
    rows([
      ['GET  /api/auth/config', 'the server’s own sign-up rules'],
      ['GET  /api/auth/me', 'the signed-in account, or 401'],
      ['POST /api/auth/register', 'Gmail + password + invitation'],
      ['POST /api/auth/login', 'add totp once MFA is enabled'],
      ['POST /api/wallet/link', 'attach an address to the account'],
    ].map(([a, b]) => [a, `<span class="m" style="font-size:12.5px">${esc(b)}</span>`])) +
    `<p class="mu" style="font-size:12.5px;margin-top:14px">Transaction submission is a signed call to <span class="m">/api/rpc?path=%2Ftx%2Fsubmit</span> carrying <span class="m">{ "tx": "&lt;hex&gt;" }</span>. The bytes must come from the canonical encoder; nothing in this app invents them.</p>` +
    (s.account ? designNav('menu') : ''),
};

// ── panels ───────────────────────────────────────────────────────────────────

/**
 * The mining ring.
 *
 * The design's ring was driven by a session timer started in localStorage. There is
 * no session: the protocol decides when a claim is allowed, from its own state and
 * block timestamps. The ring shows what the node last said, and the countdown
 * interpolates between polls — it never decides eligibility itself.
 */
function ring(s, seconds, ready) {
  const m = s.mining;
  const interval = Number(s.params?.mining?.claimIntervalSeconds ?? s.schedule?.intervalSeconds ?? 0);
  const progress = m && interval > 0 ? Math.min(1, Math.max(0, 1 - (seconds ?? 0) / interval)) : 0;
  const label = !s.status ? 'OFFLINE' : !m ? 'NO WALLET' : ready ? 'READY TO CLAIM' : 'WAITING';
  const colour = ready ? 'var(--ok)' : 'var(--mu)';
  return (
    `<div style="position:relative;width:250px;height:250px;margin:14px auto"><svg width="250" height="250" viewBox="0 0 250 250" fill="none" style="position:absolute"><circle cx="125" cy="125" r="108" stroke="#E4E7EB" stroke-width="6"/><circle id="arc" cx="125" cy="125" r="108" stroke="#C8A85A" stroke-width="6" stroke-linecap="round" stroke-dasharray="${Math.max(
      6,
      progress * 679,
    ).toFixed(1)} 679" transform="rotate(-90 125 125)"/></svg>` +
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center">${designLogo(
      m ? 84 : 130,
    )}` +
    `<div style="font-size:11px;font-weight:800;letter-spacing:.2em;margin-top:10px;color:${colour}">${label}</div>` +
    (m
      ? `<div id="tm" class="m" style="font-size:26px;font-weight:600">${
          ready ? '00:00:00' : clock(seconds)
        }</div><div style="font-size:10px;font-weight:800;letter-spacing:.16em;color:var(--mu)">${
          ready ? 'CLAIM NOW' : 'NEXT CLAIM'
        }</div>`
      : '') +
    `</div></div>`
  );
}

function claimPanel(s, m, seconds, ready) {
  if (!s.walletAddress) {
    return `<div class="card" style="margin-top:16px"><div class="row mu">This device holds no wallet yet. Set one up on the Wallet screen — claiming needs a signature, and only a key on this device can make one.</div></div>`;
  }
  if (!ready) {
    return (
      `<button class="btn p" disabled>● NEXT CLAIM IN ${esc(clock(seconds))}</button>` +
      `<p class="mu" style="font-size:12.5px;text-align:center;margin-top:10px">${
        m.reason ? esc(m.reason) : 'The protocol decides eligibility from its own state and block timestamps.'
      }</p>`
    );
  }
  return (
    `<div class="lb" style="margin:10px 0 0">UNLOCK TO SIGN</div>` +
    designField('pp', 'VAULT PASSPHRASE', 'password', 'The passphrase you sealed this wallet with') +
    `<button class="btn p" onclick="ObsidianClaim()">${busy('SIGN &amp; SUBMIT CLAIM', s, 'claim')}</button>` +
    `<p class="mu" style="font-size:12px;margin-top:10px;text-align:center">The claim is signed on this device and submitted to a node. Admission to the mempool is not a confirmation.</p>`
  );
}

function walletCard(s) {
  return (
    `<div class="card" style="padding:20px"><div class="lb" style="margin:0;color:var(--mu)">OBS BALANCE</div>` +
    `<div class="m" style="font-size:34px;font-weight:600;margin:6px 0 14px">${esc(
      s.balance ? sealsToObs(s.balance.balanceSeals, 6) : '—',
    )}</div>` +
    `<div class="m" style="font-size:12.5px;word-break:break-all">${esc(
      s.walletAddress || 'No wallet on this device',
    )}</div>` +
    (s.balance
      ? `<div class="card" style="margin-top:14px">` +
        `<div class="row"><span>SPENDABLE</span><b class="m">${esc(sealsToObs(s.balance.spendableObs ?? s.balance.balanceSeals, 6))}</b></div>` +
        `<div class="row"><span>TRANSACTIONS</span><b class="m">${esc(orDash(s.balance.txCount))}</b></div>` +
        `<div class="row"><span>NEXT NONCE</span><b class="m">${esc(orDash(s.balance.nonce))}</b></div>` +
        `</div>`
      : unavailable('The node has not returned a balance for this address.')) +
    `</div>`
  );
}

function sendPanel(s) {
  if (!s.walletAddress) {
    return unavailable('Set up a wallet on this device to send. Sending is a signed payment; nothing here can sign for you.');
  }
  const gasNote = s.params?.gas ? `Gas is ${esc(s.params.gas.basisPoints / 100)}% of the amount, capped at ${esc(s.params.gas.maxGasObs)} OBS.` : '';
  return (
    designField('to', 'RECIPIENT', 'text', 'obs1… or name.obs') +
    designField('am', 'AMOUNT (OBS)', 'text', '0.000000') +
    designField('mm', 'MEMO (OPTIONAL)', 'text', '') +
    designField('pp', 'VAULT PASSPHRASE', 'password', 'The passphrase you sealed this wallet with') +
    `<p class="mu" style="font-size:12.5px;margin-top:10px">Available ${esc(
      s.balance ? sealsToObs(s.balance.balanceSeals, 6) : '—',
    )} OBS. ${gasNote}</p>` +
    `<button class="btn p" style="margin-top:4px" onclick="ObsidianSend()">${busy('SIGN &amp; SEND', s, 'send')}</button>`
  );
}

function receivePanel(s) {
  if (!s.walletAddress) return unavailable('Set up a wallet on this device first.');
  return (
    `<div class="card" style="margin-top:14px;padding:18px;text-align:center"><div class="lb" style="margin:0 0 10px">YOUR OBSIDIAN ADDRESS</div>` +
    `<div class="m" style="word-break:break-all;font-size:13px">${esc(s.walletAddress)}</div></div>` +
    `<button class="btn p" onclick="ObsidianCopy('${esc(s.walletAddress)}')">COPY ADDRESS</button>` +
    `<p class="mu" style="font-size:12.5px;margin-top:12px">This address is derived from the recovery phrase sealed on this device. Anyone who holds that phrase holds the funds.</p>`
  );
}

function setupPanel(s) {
  if (s.walletAddress) {
    return (
      `<div class="card" style="margin-top:14px;padding:18px"><div class="lb" style="margin:0 0 8px">WALLET ON THIS DEVICE</div>` +
      `<div class="m" style="font-size:13px;word-break:break-all">${esc(s.walletAddress)}</div>` +
      `<p class="mu" style="font-size:12.5px;margin:12px 0 0">The recovery phrase is sealed with ${esc(
        s.vaultKdf ? `${s.vaultKdf.kdf} at ${Number(s.vaultKdf.iterations).toLocaleString()} iterations` : 'AES-GCM',
      )}. This app can show it only with your passphrase, and it never leaves this device.</p></div>` +
      designField('pp', 'VAULT PASSPHRASE', 'password', 'To reveal the phrase') +
      `<button class="btn" onclick="ObsidianRevealPhrase()">REVEAL RECOVERY PHRASE</button>` +
      `<button class="btn" style="color:var(--er);border-color:#E7C9C9" onclick="ObsidianRemoveWallet()">REMOVE WALLET FROM THIS DEVICE</button>`
    );
  }
  return (
    `<p class="mu" style="line-height:1.55">A wallet is a BIP-39 recovery phrase, encrypted on this device with a passphrase you choose. It is what signs a mining claim or a payment — the platform never sees it.</p>` +
    designField('ph', 'RECOVERY PHRASE', 'text', '12 or 24 words, separated by spaces') +
    designField('pp', 'NEW PASSPHRASE', 'password', 'At least 8 characters') +
    designField('p2', 'CONFIRM PASSPHRASE', 'password') +
    `<button class="btn p" onclick="ObsidianSetupWallet()">${busy('SEAL WALLET ON THIS DEVICE', s, 'setup')}</button>` +
    `<p class="mu" style="font-size:12.5px;margin-top:12px">Write the phrase down before you seal it. This app can show it again, but it cannot recover it for you.</p>`
  );
}

function nameResult(s) {
  const r = s.ons.result;
  const fee = s.params?.ons?.registrationFeeObs;
  const owned = r.record?.owner && r.record.owner === s.walletAddress;
  const status = r.registered ? (owned ? 'YOURS' : 'REGISTERED') : 'AVAILABLE';
  const colour = r.registered ? (owned ? 'ok' : 'mu') : 'ok';
  return (
    `<div class="card" style="margin-top:12px;padding:16px">` +
    `<div style="display:flex;justify-content:space-between"><b class="m" style="font-size:17px">${esc(
      r.name,
    )}</b><span class="pill" style="${r.registered ? '' : 'background:#FBF6E8;color:var(--gd)'}">${status}</span></div>` +
    (r.record
      ? `<div class="card" style="margin-top:10px">` +
        `<div class="row"><span>RESOLVES TO</span><b class="m" style="font-size:12px">${esc(short(r.record.address))}</b></div>` +
        `<div class="row"><span>OWNER</span><b class="m" style="font-size:12px">${esc(short(r.record.owner))}</b></div>` +
        `<div class="row"><span>EXPIRES</span><b>${esc(formatTime(r.record.expiresAt))}</b></div>` +
        `</div>`
      : `<div class="row" style="margin-top:8px"><span>REGISTRATION FEE</span><b class="m">${esc(
          orDash(fee, (v) => `${v} OBS`),
        )}</b></div>`) +
    (!r.registered && s.walletAddress && fee
      ? designField('pp', 'VAULT PASSPHRASE', 'password', 'To sign the registration') +
        `<button class="btn p" onclick="ObsidianRegisterName('${esc(r.name)}')">${busy(
          `REGISTER ${r.name}`,
          s,
          'ons',
        )}</button>`
      : '') +
    (!r.registered && !s.walletAddress
      ? `<p class="mu" style="font-size:12.5px;margin:10px 0 0">Set up a wallet on this device to register it. Registration is a signed ONS transaction.</p>`
      : '') +
    (r.unverified
      ? `<p class="mu" style="font-size:12px;margin:10px 0 0">This node would not answer for a single name, so availability is unconfirmed. It does not serve /names/&lt;name&gt;.</p>`
      : '') +
    `</div>`
  );
}

function searchResult(s) {
  const r = s.search;
  if (r.kind === 'block') {
    const b = r.block;
    return (
      `<div class="lb">BLOCK</div>` +
      rows([
        ['HEIGHT', `#${Number(b.summary?.height ?? b.height).toLocaleString()}`, 'm'],
        ['HASH', esc(short(b.hash ?? b.summary?.hash)), 'm'],
        ['PRODUCER', esc(short(b.header?.producer ?? b.summary?.producer)), 'm'],
        ['TIME', esc(formatTime(b.summary?.timestamp ?? b.header?.timestamp))],
        ['TRANSACTIONS', esc(b.transactions?.length ?? b.summary?.txCount ?? b.summary?.transactionCount ?? 0), 'm'],
        ['CONFIRMATIONS', esc(orDash(b.confirmations)), 'm'],
      ])
    );
  }
  if (r.kind === 'transaction') {
    const t = r.transaction;
    return (
      `<div class="lb">TRANSACTION</div>` +
      rows([
        ['ID', esc(short(t.txId)), 'm'],
        ['TYPE', esc(t.typeName ?? t.type), 'm'],
        ['SENDER', esc(short(t.sender)), 'm'],
        ['RECIPIENT', esc(short(t.recipient)) || '—', 'm'],
        ['AMOUNT', esc(orDash(t.amount, (v) => `${v} OBS`)), 'm'],
        ['GAS', esc(orDash(t.gas, (v) => `${v} OBS`)), 'm'],
        ['STATUS', esc(t.status ?? ''), String(t.status).toLowerCase() === 'confirmed' ? 'ok' : ''],
        ['HEIGHT', esc(orDash(t.height)), 'm'],
      ])
    );
  }
  if (r.kind === 'address') {
    const a = r.address;
    return (
      `<div class="lb">ADDRESS</div>` +
      rows([
        ['ADDRESS', esc(short(s.query)), 'm'],
        ['TRANSACTIONS', esc(a.counts?.transactions ?? 0), 'm'],
        ['MINING CLAIMS', esc(a.counts?.miningClaims ?? 0), 'm'],
      ]) +
      (a.transactions?.length
        ? `<div class="card" style="margin-top:10px">${a.transactions
            .slice(0, 10)
            .map(
              (t) =>
                `<div class="row"><div><b class="m">${esc(short(t.txId))}</b><div class="mu" style="font-size:12px;margin-top:3px">${esc(
                  formatTime(t.timestamp),
                )}</div></div><b class="m ${String(t.kind).includes('credit') ? 'ok' : ''}">${esc(
                  orDash(t.amount, (v) => `${v} OBS`),
                )}</b></div>`,
            )
            .join('')}</div>`
        : unavailable('No transactions have been indexed for this address.'))
    );
  }
  return '';
}

function activity(s, limit) {
  const txs = s.history?.transactions ?? [];
  if (!txs.length) {
    return unavailable(
      s.walletAddress
        ? 'No transactions have been indexed for this address yet.'
        : 'Set up a wallet on this device to see its activity.',
    );
  }
  return `<div class="card">${txs
    .slice(0, limit)
    .map((t) => {
      const incoming = typeof t.kind === 'string' && /credit|reward|received/i.test(t.kind);
      const amount = t.amount ? `${incoming ? '+' : ''}${t.amount} OBS` : '—';
      return `<div class="row" onclick="ObsidianSearch('${esc(t.txId)}')" style="cursor:pointer"><div><b>${
        t.kind ? esc(prettyKind(t.kind)) : 'Transaction'
      }</b><div class="mu" style="font-size:12px;margin-top:3px">${esc(short(t.txId))} · ${esc(
        formatTime(t.timestamp),
      )}</div></div><b class="m ${incoming ? 'ok' : ''}">${esc(amount)}</b></div>`;
    })
    .join('')}</div>`;
}

// ── small formatters ─────────────────────────────────────────────────────────

function clock(seconds) {
  if (seconds === null || seconds === undefined) return '—:—:—';
  const total = Math.max(0, Math.round(seconds));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((x) => String(x).padStart(2, '0'))
    .join(':');
}

/**
 * Seconds until the protocol allows the next claim.
 *
 * `secondsRemaining` is the node's answer at `s.miningAt`; this subtracts the wall
 * time since then. That is interpolation between polls, not a second opinion: when
 * the countdown reaches zero the app asks the node again rather than assuming it.
 */
export function remainingSeconds(s) {
  if (!s.mining) return null;
  if (s.mining.eligible) return 0;
  const base = Number(s.mining.secondsRemaining ?? 0);
  const elapsed = (Date.now() - (s.miningAt ?? Date.now())) / 1000;
  return Math.max(0, Math.round(base - elapsed));
}

function short(value, head = 10, tail = 6) {
  const text = String(value ?? '');
  if (text.length <= head + tail + 1) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

function prettyKind(kind) {
  return String(kind)
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function notifyLabel(permission) {
  if (permission === 'granted') return 'ON';
  if (permission === 'denied') return 'BLOCKED';
  if (permission === 'unsupported') return 'NOT AVAILABLE';
  return 'OFF';
}

export { esc, normaliseName };
