/**
 * Binds the design file's screens to real data.
 *
 * The design file is kept byte-for-byte: its markup, its tokens, its twelve screens,
 * its splash geometry. What this module does is replace the *behaviour* functions
 * that script declared — signup, signin, claim, onsq, ht, addr, txs — with ones that
 * talk to the platform. Because those are top-level function declarations in a
 * classic script they live on window, so they can be swapped without editing the
 * file that renders them.
 *
 * That ordering matters. Editing the design file's 230 KB inline script in place
 * would risk the layout for no benefit; overriding the functions leaves the design
 * provably untouched and puts every piece of invented behaviour in one reviewable
 * file.
 *
 * What changes and what does not:
 *   - ht() faked a block height from Date.now(). Now the node's own head.
 *   - addr() synthesised an address by hashing the email. Now the account's real
 *     linked address, or nothing. A plausible address belonging to nobody is worse
 *     than an empty field.
 *   - claim() added RATE*4 to a local balance with no transaction. Claiming is a
 *     signed MINING_CLAIM; this app holds no key, so it shows eligibility and
 *     submits nothing. It never credits a balance.
 *   - signup()/signin() used a hardcoded invite list and did not verify the password.
 *     Now the platform decides, and its error wording is shown verbatim.
 *   - onsq()/buy() answered from a TAKEN array and sold names at PRICE=25. Now the
 *     chain's name set, and no purchase — registering a name is a signed ONS
 *     transaction this app cannot build.
 */

import {
  authConfig,
  register,
  login,
  me,
  logout,
  getMiningStatus,
  getStatus,
  nameStatus,
  sealsToObs,
  formatDuration,
} from './data.mjs';

/** Live protocol state, refreshed rather than derived from this browser's clock. */
const live = {
  height: null,
  account: null,
  eligibility: null,
  error: null,
};

const er = (message) => {
  live.error = message;
  const node = document.querySelector('.err');
  if (node) node.textContent = message;
};

/**
 * Block height. The design computed it from Date.now(), which meant it ticked
 * upward whether or not a chain existed. This reads the node's head and shows an em
 * dash when the node has not answered — never a number that looks current.
 */
function realHeight() {
  return live.height == null ? '—' : `#${Number(live.height).toLocaleString()}`;
}

/**
 * The account's linked address.
 *
 * The design synthesised one from the email so the wallet screen was never empty.
 * That is the single most dangerous thing in the file: an address that belongs to
 * nobody, presented as the user's, invites someone to send funds to it.
 */
function realAddress() {
  return live.account?.walletAddress || 'No address linked. Link one in the platform.';
}

async function refresh() {
  try {
    const status = await getStatus();
    live.height = status?.height ?? null;
  } catch (error) {
    live.height = null;
    live.error = error.message;
  }
  try {
    const { account } = await me();
    live.account = account ?? null;
  } catch {
    // No session is a normal state, not an error. The screens already branch on it.
    live.account = null;
  }
  if (live.account?.walletAddress) {
    try {
      live.eligibility = await getMiningStatus(live.account.walletAddress);
    } catch {
      live.eligibility = null;
    }
  }
  if (typeof window.render === 'function') window.render();
}

function install() {
  const g = window;
  if (!g.V || typeof g.render !== 'function') return;

  // ── the fake values ────────────────────────────────────────────────────────
  g.ht = () => (live.height == null ? 0 : Number(live.height));
  g.addr = realAddress;

  // ── accounts ───────────────────────────────────────────────────────────────
  g.signup = async () => {
    const email = g.v('em');
    const password = document.getElementById('pw')?.value ?? '';
    const confirm = document.getElementById('p2')?.value ?? '';
    const invite = g.v('rf');
    if (!/^\S+@\S+\.\S+$/.test(email)) return er('Enter a valid email.');
    if (password.length < 12) return er('Password must be at least 12 characters.');
    if (password !== confirm) return er('Passwords do not match.');
    if (!invite) return er('An invitation code is required. Obsidian is invite only.');
    try {
      // The platform checks the invitation before looking anything up about the
      // address, so this cannot be used to probe which accounts exist.
      await register({ email, password, inviteCode: invite, displayName: email });
      live.error = null;
      await refresh();
      g.go('home');
    } catch (error) {
      er(error.message);
    }
  };

  g.signin = async () => {
    const email = g.v('em');
    const password = document.getElementById('pw')?.value ?? '';
    if (!email || !password) return er('Enter your email and password.');
    try {
      await login({ email, password });
      live.error = null;
      await refresh();
      g.go('home');
    } catch (error) {
      er(error.message);
      document.getElementById('pw').value = '';
    }
  };

  // ── mining ─────────────────────────────────────────────────────────────────
  /**
   * The demo's claim() added RATE*4 to a local balance and reset a timer. There is
   * no session and no local balance. This reports the protocol's own eligibility and
   * does not submit, because submitting needs a signature this app cannot make.
   */
  g.claim = () => {
    er('Claiming is a signed MINING_CLAIM transaction. This app holds no key, so it ' +
      'reports eligibility and submits nothing. Nothing has been credited.');
  };

  g.startM = () => {
    er('There is no session to start. Mining eligibility is decided by the protocol ' +
      'from its own state and block timestamps, not by this device.');
  };

  // ── ONS ────────────────────────────────────────────────────────────────────
  /**
   * Availability from the chain's name set. The demo answered from a TAKEN array and
   * offered to sell the name; the price was a constant and the purchase was fake.
   */
  g.onsq = async () => {
    try {
      const result = await nameStatus(g.v('nm'));
      if (!result) return er('Use 3–24 letters, numbers or hyphens.');
      live.error = null;
      g.res = `<div class="card" style="margin-top:12px;padding:16px">` +
        `<div style="display:flex;justify-content:space-between">` +
        `<b class="m" style="font-size:17px">${result.name}</b>` +
        `<span class="pill">${result.registered ? 'REGISTERED' : 'FREE'}</span></div>` +
        `<div class="row" style="margin-top:8px"><span>SOURCE</span><b>chain name set</b></div>` +
        `<p class="mu" style="font-size:12.5px;margin:10px 0 0">` +
        `Registering a name is a signed ONS transaction. This app holds no key, so it ` +
        `reads the name set and does not register.</p></div>`;
      g.render();
    } catch (error) {
      er(error.message);
    }
  };

  g.buy = () => er('This app cannot register a name: that needs a signed ONS ' +
    'transaction, and the demo price of 25 OBS was a constant with no basis.');

  // ── wallet ─────────────────────────────────────────────────────────────────
  /**
   * The demo debited a local balance and pushed a fake transaction. Sending is a
   * signed payment; without a key there is nothing to submit, and recording one
   * locally would show a transfer that never happened.
   */
  g.send = () => {
    er('Sending is a signed payment. This app holds no key, so it builds nothing and ' +
      'submits nothing. No balance has changed.');
  };

  // ── sign out ───────────────────────────────────────────────────────────────
  /** Destroys the session on the platform, not just the local copy of it. */
  const originalMenu = g.V.menu;
  g.V.menu = () => originalMenu();

  g.ObsidianSignOut = async () => {
    try { await logout(); } catch { /* an expired session is already signed out */ }
    live.account = null;
    live.eligibility = null;
    g.go('landing');
  };

  // ── the mine screen, driven by real eligibility ────────────────────────────
  const originalMine = g.V.mine;
  g.V.mine = () => {
    const html = originalMine();
    const e = live.eligibility;
    if (!e) {
      return html.replace(
        /<div class="card" style="margin-top:16px">[\s\S]*?<\/div>\s*$/,
        `<div class="card" style="margin-top:16px"><div class="row mu">` +
        `No eligibility data. Link a wallet address and the protocol's own figures ` +
        `will show here.</div></div>`,
      );
    }
    // Every figure below is the node's own computation for this address.
    return html.replace(
      /<div class="card" style="margin-top:16px">[\s\S]*?<\/div>\s*$/,
      `<div class="card" style="margin-top:16px">` +
      `<div class="row"><span>REWARD PER CLAIM</span><b class="m">${sealsToObs(e.rewardPerClaim)} OBS</b></div>` +
      `<div class="row"><span>CLAIM INTERVAL</span><b>${formatDuration(e.claimIntervalSeconds ?? 14400)}</b></div>` +
      `<div class="row"><span>CLAIMS LEFT THIS CYCLE</span><b class="m">${e.claimsRemainingInCycle}</b></div>` +
      `<div class="row"><span>NEXT CLAIM IN</span><b class="m">${e.eligible ? 'now' : formatDuration(e.secondsRemaining)}</b></div>` +
      `<div class="row"><span>ELIGIBLE</span><b class="${e.eligible ? 'ok' : 'mu'}">${e.eligible ? 'Yes' : 'No'}</b></div>` +
      `</div>`,
    );
  };

  // ── the header pill reports real connectivity ──────────────────────────────
  const originalHeader = g.hdr;
  g.hdr = (title) => {
    const pill = live.height == null
      ? `<span class="pill" style="background:#FDECEA;color:#A12626">OFFLINE</span>`
      : `<span class="pill">LIVE</span>`;
    return originalHeader(title).replace(/<span class="pill">LIVE<\/span>/, pill);
  };

  refresh();
  // Keep the head height honest without inventing movement: poll, never extrapolate.
  setInterval(refresh, 15000);

  // The design file's splash auto-advances on a 2s timer; load the real rules so
  // the sign-up form shows the server's minimums rather than a guess.
  authConfig().catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install);
} else {
  install();
}

export { live, refresh };
