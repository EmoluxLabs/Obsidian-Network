/**
 * Binds the design file's screens to real data.
 *
 * The design file is kept byte-for-byte. What this module does is replace the
 * screens and the behaviour functions with ones that talk to the platform, and it
 * can do that because of one distinction in how a classic script publishes its
 * top-level declarations:
 *
 *   - `function go(){}` becomes a property of the global object, so it can be
 *     replaced from here;
 *   - `const V = {}` becomes a binding in the *global lexical environment*, which a
 *     module can READ by bare name but cannot overwrite, and which never appears on
 *     `window` at all.
 *
 * The first version of this module guarded on `window.V`, found it undefined, and
 * returned before installing anything. The page rendered, the design looked right,
 * and every behaviour in it was the demo's. The installed entry point is now
 * `render()` — a function declaration, therefore replaceable — and every screen is
 * served from screens.mjs, which reads the design's own helpers (`hdr`, `nav`, `fld`,
 * `logo`, `back`) by bare name and reuses its CSS unchanged.
 *
 * What changed and what did not:
 *   - ht() faked a block height from Date.now(). Now the node's own head.
 *   - addr() synthesised an address by hashing the email. Now the address derived
 *     from the recovery phrase sealed on this device, or nothing at all. A plausible
 *     address belonging to nobody is worse than an empty field.
 *   - claim() added RATE*4 to a local balance with no transaction. Now it signs a
 *     MINING_CLAIM with the local key and submits it, and reports *submitted* —
 *     never confirmed.
 *   - signup()/signin() used a hardcoded invite list and never verified a password.
 *     Now the platform decides, and its error wording is shown verbatim.
 *   - onsq()/buy() answered from a TAKEN array and sold names at PRICE=25. Now the
 *     chain's name set, the consensus fee from /params, and a real signed ONS
 *     registration when a wallet is present.
 *   - send() debited a local balance. Now a signed PAYMENT with protocol gas.
 *   - The Edge Node screen is gone: a browser cannot run a node, and a toggle that
 *     claims otherwise is a lie with a switch on it.
 */

import {
  authConfig,
  register,
  login,
  me,
  logout,
  mfaSetup,
  mfaConfirm,
  recover,
  invites,
  issueInvite,
  linkWallet,
  getStatus,
  getNetwork,
  getParams,
  getBlocks,
  getBlock,
  getTransaction,
  getAddressHistory,
  getBalance,
  getMiningStatus,
  getMiningSchedule,
  getMiningClaims,
  getName,
  nameStatus,
  normaliseName,
} from './data.mjs';
import * as notify from './notify.mjs';
import {
  cachedAddress,
  walletAddress,
  addressOnNetwork,
  walletKdf,
  setupWallet,
  removeWallet,
  revealPhrase,
  claim,
  send,
  registerName,
} from './wallet.mjs';
import { SCREENS, remainingSeconds } from './screens.mjs';

/** Screens that need a signed-in account. The chain itself is readable without one. */
const ACCOUNT_SCREENS = new Set(['home', 'mine', 'menu']);

/**
 * Everything the screens render.
 *
 * A value stays `null` until the platform actually answers it. That is the rule
 * this whole app is built around: `null` renders as an em dash, and an em dash is
 * honest in a way a plausible default never is.
 */
const state = {
  screen: 'splash',
  menu: false,
  account: null,
  config: null,
  status: null,
  network: null,
  params: null,
  schedule: null,
  mining: null,
  miningAt: null,
  balance: null,
  history: null,
  blocks: null,
  claims: null,
  ownNames: null,
  invites: null,
  recoveryCodes: null,
  walletAddress: cachedAddress(),
  vaultKdf: null,
  mfa: null,
  mfaRequired: false,
  search: null,
  query: '',
  ons: { query: '', result: null },
  wt: 'send',
  error: '',
  notice: '',
  busy: null,
  notify: notify.permission(),
};

let countdownTimer = null;

// ── rendering ────────────────────────────────────────────────────────────────

function setError(message) {
  state.error = String(message ?? '');
  state.notice = '';
}

function setNotice(message) {
  state.notice = String(message ?? '');
  state.error = '';
}

/**
 * Paint the current screen.
 *
 * A screen that is not one of ours is never rendered from the design's `V` table:
 * every entry there carries at least one invented figure, so showing one would
 * undo the whole point of this module.
 */
function render() {
  const app = document.getElementById('app');
  if (!app) return;
  const screen = SCREENS[state.screen];
  app.innerHTML = screen
    ? screen(state)
    : `<div class="hd"><b style="letter-spacing:.18em">OBSIDIAN</b></div>` +
      `<div class="card" style="margin-top:20px"><div class="row mu">That screen does not exist.</div></div>` +
      `<button class="btn" onclick="ObsidianGo('landing')">‹ BACK</button>`;
  startCountdown();
}

/** Repaint after a background refresh, unless the user is mid-input. */
function repaint() {
  const active = document.activeElement;
  const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (!typing) render();
}

/**
 * Navigate.
 *
 * Of the design's twelve screens, only the splash is reachable as authored; the
 * rest are replaced here.
 */
function go(target) {
  const next = SCREENS[target] ? target : 'landing';
  if (ACCOUNT_SCREENS.has(next) && !state.account) {
    state.screen = 'signin';
  } else {
    state.screen = next;
  }
  state.error = '';
  state.notice = '';
  state.menu = false;
  state.busy = null;
  window.scrollTo(0, 0);
  render();
}

/**
 * The claim countdown.
 *
 * It rewrites one text node per second and nothing else: re-rendering the whole
 * screen on a timer would wipe whatever the user is typing into the passphrase
 * field. When the countdown reaches zero it asks the node again instead of
 * deciding for itself that a claim is due — the same rule the notifier follows.
 */
function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer);
  countdownTimer = null;
  if (state.screen !== 'mine' || !state.mining || state.mining.eligible) return;
  countdownTimer = setInterval(() => {
    const seconds = remainingSeconds(state);
    const node = document.getElementById('tm');
    if (node) node.textContent = formatClock(seconds);
    if (seconds === 0) {
      // The interpolated countdown has run out. Only the node can say whether a
      // claim is actually allowed now, so ask rather than assuming yes.
      clearInterval(countdownTimer);
      countdownTimer = null;
      refreshMining().then(repaint);
    }
  }, 1000);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.round(seconds ?? 0));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((x) => String(x).padStart(2, '0'))
    .join(':');
}

// ── refresh ──────────────────────────────────────────────────────────────────

async function refreshMining() {
  if (!state.walletAddress) {
    state.mining = null;
    state.miningAt = null;
    return null;
  }
  try {
    state.mining = (await getMiningStatus(state.walletAddress)) ?? null;
    state.miningAt = Date.now();
  } catch {
    state.mining = null;
    state.miningAt = null;
  }
  return state.mining;
}

async function refreshWallet() {
  const stored = state.walletAddress || (await walletAddress().catch(() => null));
  // The prefix is the network's: a cache written under another network is
  // re-encoded rather than shown as an address this node would reject.
  const address = await addressOnNetwork(stored, state.network?.network?.addressHrp).catch(() => stored);
  state.walletAddress = address || null;
  if (!address) {
    state.mining = null;
    state.balance = null;
    state.history = null;
    state.ownNames = null;
    return;
  }
  const [balance, history] = await Promise.all([
    getBalance(address).catch(() => null),
    getAddressHistory(address, 12).catch(() => null),
  ]);
  state.balance = balance;
  state.history = history;
  state.ownNames = balance?.names ?? null;
  await refreshMining();
}

async function refreshAccount() {
  try {
    const { account } = await me();
    state.account = account ?? null;
  } catch {
    // No session is a normal state, not an error. The screens branch on it.
    state.account = null;
  }
}

async function refresh() {
  const [status, network] = await Promise.all([
    getStatus().catch(() => null),
    getNetwork().catch(() => null),
  ]);
  state.status = status;
  state.network = network;

  await refreshAccount();
  await refreshWallet();

  const needsExplorer = state.screen === 'explorer' || Boolean(state.search);
  const [blocks, claims, params, schedule] = await Promise.all([
    needsExplorer ? getBlocks(12).catch(() => null) : null,
    needsExplorer && state.walletAddress ? getMiningClaims(state.walletAddress, 8).catch(() => null) : null,
    state.params ? null : getParams().catch(() => null),
    state.schedule ? null : getMiningSchedule().catch(() => null),
  ]);
  if (needsExplorer) {
    state.blocks = blocks;
    state.claims = claims;
  }
  if (params) state.params = params;
  if (schedule) state.schedule = schedule;

  state.invites = state.account ? await invites().catch(() => null) : null;
  repaint();
}

async function boot() {
  state.config = await authConfig().catch(() => null);
  await refresh();
  render();
  notify.resume(state.walletAddress);
  // Poll, never extrapolate: the height and the eligibility window are the node's
  // to state, and a page that invents movement between polls is lying about a chain.
  setInterval(() => {
    refresh().catch(() => {});
  }, 15_000);
}

// ── actions ──────────────────────────────────────────────────────────────────

function field(id) {
  return document.getElementById(id)?.value ?? '';
}

/** An error the platform can return for a reason this app must explain plainly. */
function explain(error) {
  const code = error?.code;
  if (code === 'ERR_PLATFORM_UNREACHABLE') {
    return 'The Obsidian platform could not be reached. The app will not invent chain data in its place.';
  }
  if (code === 'ERR_FORBIDDEN' || /origin not allowed/i.test(error?.message ?? '')) {
    return 'This app’s origin is not in the platform’s OBSIDIAN_INTERFACE_ALLOWED_ORIGINS list, so the platform refused the request.';
  }
  return error?.message || 'Something went wrong.';
}

/**
 * Run an action, showing it as busy while it runs.
 *
 * `fn` must not read the DOM: by the time it runs the screen has been repainted
 * and every input in it is a new, empty element. Handlers read their fields first
 * and close over the values. Forgetting that is how a passphrase silently becomes
 * an empty string and every claim fails as a wrong passphrase.
 */
async function withBusy(key, fn) {
  state.busy = key;
  state.error = '';
  repaint();
  try {
    await fn();
  } catch (error) {
    setError(explain(error));
  } finally {
    state.busy = null;
    render();
  }
}

// ── installation ─────────────────────────────────────────────────────────────

function install() {
  const g = window;

  // The two levers the design publishes as function declarations. Everything else
  // in this app hangs off them.
  g.render = render;
  g.go = go;

  // Neutralise the demo behaviours. None of these is reachable from a screen this
  // module renders, but leaving them live behind an onclick that might survive a
  // future edit would be a trap for whoever edits next.
  const refuse = (what) => () =>
    setError(`${what} is a signed protocol action. The design file’s version of it was fake.`);
  g.claim = refuse('Claiming');
  g.startM = () => setError('Mining has no session to start. Eligibility is decided by the protocol.');
  g.send = refuse('Sending');
  g.buy = () => setError('The design file sold names for a constant 25 OBS. The fee is a consensus parameter.');
  g.onsq = () => setError('This screen is rebuilt against the chain’s own name set.');

  // ── navigation ────────────────────────────────────────────────────────────
  g.ObsidianGo = (target) => go(target);
  g.ObsidianToggleMenu = () => {
    state.menu = !state.menu;
    render();
  };
  g.ObsidianWalletTab = (tab) => {
    state.wt = tab;
    state.error = '';
    state.notice = '';
    render();
  };
  g.ObsidianCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice('Copied.');
    } catch {
      // Clipboard access is refused in plenty of legitimate contexts (an iframe
      // without permission, a non-secure origin). Select it instead of failing.
      const scratch = document.createElement('textarea');
      scratch.value = text;
      document.body.appendChild(scratch);
      scratch.select();
      setNotice('Selected — press ⌘/Ctrl+C to copy.');
      scratch.remove();
    }
    render();
  };

  // ── accounts ──────────────────────────────────────────────────────────────
  g.ObsidianSignup = () => {
    const email = field('em').trim();
    const password = field('pw');
    const confirm = field('p2');
    const inviteCode = field('rf').trim();
    return withBusy('signup', async () => {
      const min = state.config?.passwordMinLength ?? 12;
      if (!/^\S+@\S+\.\S+$/.test(email)) return setError('Enter a valid email address.');
      if (password.length < min) return setError(`Password must be at least ${min} characters.`);
      if (password !== confirm) return setError('Passwords do not match.');
      if (!inviteCode) return setError('An invitation code is required. Obsidian is invite only.');
      // The platform checks the invitation before it looks anything up about the
      // address, so this cannot be used to probe which accounts exist.
      const result = await register({ email, password, inviteCode, displayName: email });
      state.account = result?.account ?? null;
      state.mfaRequired = false;
      state.recoveryCodes = result?.recoveryCodes?.length ? result.recoveryCodes : null;
      await refresh();
      go('home');
    });
  };

  g.ObsidianSignin = () => {
    const email = field('em').trim();
    const password = field('pw');
    const totp = field('mf').trim() || undefined;
    return withBusy('signin', async () => {
      if (!email || !password) return setError('Enter your email and password.');
      try {
        const result = await login({ email, password, totp });
        state.account = result?.account ?? null;
        state.mfaRequired = false;
        setError('');
        await refresh();
        go('home');
      } catch (error) {
        // Asking for the second factor is a different state from a wrong password,
        // and the platform says which one it is.
        if (error?.code === 'ERR_MFA_REQUIRED') {
          state.mfaRequired = true;
          setError('Enter the code from your authenticator app.');
        } else {
          setError(explain(error));
        }
        const pw = document.getElementById('pw');
        if (pw) pw.value = '';
      }
    });
  };

  g.ObsidianRecover = () => {
    const email = field('em').trim();
    const recoveryCode = field('rc').trim();
    const newPassword = field('np');
    return withBusy('recover', async () => {
      const min = state.config?.passwordMinLength ?? 12;
      if (!email || !recoveryCode) return setError('Enter your email and one recovery code.');
      if (newPassword.length < min) return setError(`New password must be at least ${min} characters.`);
      const result = await recover({ email, recoveryCode, newPassword });
      state.account = result?.account ?? null;
      setNotice('Password set. Add a second factor again to reopen mining.');
      await refresh();
      go('home');
    });
  };

  g.ObsidianDismissCodes = () => {
    state.recoveryCodes = null;
    render();
  };

  g.ObsidianMfaSetup = () =>
    withBusy('mfa', async () => {
      state.mfa = (await mfaSetup()) ?? null;
      setError('');
    });

  g.ObsidianMfaConfirm = () => {
    const totp = field('mf').trim();
    return withBusy('mfa', async () => {
      if (!totp) return setError('Enter the code from your authenticator.');
      const result = await mfaConfirm(totp);
      state.mfa = null;
      state.account = result?.account ?? state.account;
      setNotice(result?.note || 'Second factor confirmed.');
      await refreshAccount();
    });
  };

  g.ObsidianIssueInvite = () =>
    withBusy('invite', async () => {
      await issueInvite();
      state.invites = await invites().catch(() => null);
      setNotice('Invitation issued.');
    });

  g.ObsidianLinkAddress = () => {
    const address = state.walletAddress;
    return withBusy('link', async () => {
      if (!address) return setError('Set up a wallet on this device first.');
      const result = await linkWallet(address);
      state.account = result?.account ?? state.account;
      setNotice('Address linked to your account.');
    });
  };

  /**
   * Sign out on the platform, not just in this tab.
   *
   * The design's button deleted a localStorage key, which left the session alive
   * on the server — a sign-out that does not end a session is not a sign-out.
   */
  g.ObsidianSignOut = async () => {
    try {
      await logout();
    } catch {
      // An expired session is already signed out; the local state is cleared
      // either way, so a failed call here must not leave the user stuck.
    }
    state.account = null;
    state.invites = null;
    state.mfa = null;
    state.mfaRequired = false;
    notify.disable();
    go('landing');
  };

  // ── the wallet on this device ──────────────────────────────────────────────
  g.ObsidianSetupWallet = () => {
    const phrase = field('ph');
    const passphrase = field('pp');
    const confirm = field('p2');
    return withBusy('setup', async () => {
      if (!passphrase || passphrase.length < 8) {
        return setError('Choose a passphrase of at least 8 characters.');
      }
      if (passphrase !== confirm) return setError('Passphrases do not match.');
      const { address } = await setupWallet({ phrase, passphrase });
      state.walletAddress = address;
      state.wt = 'receive';
      setNotice('Wallet sealed on this device. Write the phrase down if you have not already.');
      await refreshWallet();
    });
  };

  g.ObsidianRevealPhrase = () => {
    const passphrase = field('pp');
    return withBusy('reveal', async () => {
      setNotice(await revealPhrase(passphrase));
    });
  };

  g.ObsidianRemoveWallet = () =>
    withBusy('setup', async () => {
      if (!window.confirm('Remove the wallet sealed on this device? The phrase itself still exists wherever you wrote it down.')) {
        return;
      }
      removeWallet();
      state.walletAddress = null;
      state.mining = null;
      state.balance = null;
      state.history = null;
      state.ownNames = null;
      state.wt = 'setup';
      setNotice('Wallet removed from this device.');
    });

  // ── protocol actions: signed here, and none of them confirmed ──────────────
  g.ObsidianClaim = () => {
    const passphrase = field('pp');
    return withBusy('claim', async () => {
      const result = await claim(() => passphrase);
      if (!result.ok) return setError(result.message);
      setNotice(`Claim submitted — ${result.txId.slice(0, 16)}… — not yet confirmed.`);
      await refreshMining();
    });
  };

  g.ObsidianSend = () => {
    const to = field('to').trim();
    const amountObs = field('am').trim();
    const memo = field('mm').trim();
    const passphrase = field('pp');
    return withBusy('send', async () => {
      const result = await send({ to, amountObs, memo }, () => passphrase);
      if (!result.ok) return setError(result.message);
      setNotice(`Payment submitted — ${result.txId.slice(0, 16)}… — not yet confirmed.`);
      await refreshWallet();
    });
  };

  g.ObsidianNameSearch = async () => {
    const raw = field('nm');
    const name = normaliseName(raw);
    state.ons = { query: raw, result: null };
    if (!name) return setError('Use 3–24 letters, numbers or hyphens.');
    setError('');
    render();
    try {
      state.ons = { query: raw, result: await nameStatus(name) };
    } catch (error) {
      setError(explain(error));
    }
    render();
  };

  g.ObsidianRegisterName = (name) => {
    const feeObs = state.params?.ons?.registrationFeeObs;
    const passphrase = field('pp');
    return withBusy('ons', async () => {
      if (!feeObs) return setError('The node has not published a registration fee.');
      const result = await registerName({ name, feeObs }, () => passphrase);
      if (!result.ok) return setError(result.message);
      setNotice(`Registration submitted — ${result.txId.slice(0, 16)}… — not yet confirmed.`);
      await refreshWallet();
    });
  };

  // ── explorer ───────────────────────────────────────────────────────────────
  g.ObsidianSearch = async (preset) => {
    const query = preset !== undefined ? String(preset) : field('q').trim();
    if (!query) return setError('Enter a block height, a transaction id or an address.');
    state.query = query;
    state.search = null;
    setError('');
    render();
    try {
      if (/^\d+$/.test(query)) {
        state.search = { kind: 'block', block: await getBlock(query) };
      } else if (/^(obs|tobs|sobs|dobs)1[0-9a-z]{20,}$/.test(query)) {
        state.search = { kind: 'address', address: await getAddressHistory(query, 20) };
      } else if (/^[0-9a-f]{64}$/i.test(query)) {
        state.search = { kind: 'transaction', transaction: await getTransaction(query) };
      } else if (/\.obs$/i.test(query)) {
        // A name resolves to an address on the chain, and this app shows which
        // address rather than quietly searching for something else.
        const record = await getName(query.toLowerCase());
        state.search = { kind: 'address', address: await getAddressHistory(record.address, 20) };
      } else {
        setError('That is not a block height, a transaction id or an address.');
      }
    } catch (error) {
      state.search = null;
      setError(explain(error));
    }
    render();
  };

  // ── claim alerts ───────────────────────────────────────────────────────────
  g.ObsidianNotifyEnable = async () => {
    if (!state.walletAddress) {
      setError('Set up a wallet on this device before turning on claim alerts.');
      return render();
    }
    const result = await notify.enable(state.walletAddress);
    state.notify = notify.permission();
    if (result !== 'granted') {
      setError(
        result === 'denied'
          ? 'Notifications are blocked for this site. Allow them in your browser settings.'
          : 'Notifications are not available in this browser.',
      );
    } else {
      // Say the limit out loud rather than letting it look like a background
      // service: a closed tab cannot be woken, and pretending otherwise is the
      // kind of promise this project does not make.
      setNotice('Claim alerts are on while this tab is open. Closing the tab stops them.');
    }
    render();
  };

  g.ObsidianNotifyDisable = () => {
    notify.disable();
    state.notify = notify.permission();
    setNotice('Claim alerts off.');
    render();
  };

  g.ObsidianRefresh = () => {
    refresh().catch(() => {});
  };

  // A wallet already on this device: read what the vault was sealed with, so the
  // screen can say rather than imply.
  walletKdf()
    .then((info) => {
      state.vaultKdf = info;
      repaint();
    })
    .catch(() => {});

  boot().catch((error) => {
    setError(explain(error));
    render();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', install);
} else {
  install();
}

export { state, render, go, refresh, refreshMining, refreshWallet };
