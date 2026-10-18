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

import { emptyExplorer } from './explorer.mjs';
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
  getAppConfig,
  MIN_PASSPHRASE_LENGTH,
  getStatus,
  getNetwork,
  getParams,
  getBlocks,
  getPot,
  getSupply,
  getProducers,
  getFinality,
  getMempool,
  getAudit,
  getNodeRewards,
  getNodes,
  getNames,
  readRoute,
  getBlock,
  getTransaction,
  getAddressHistory,
  getBalance,
  getMiningStatus,
  getMiningSchedule,
  getMiningClaims,
  getName,
  getMarketName,
  getMarketListings,
  getMarketOffers,
  getMarketOffer,
  getMarketEvents,
  nameStatus,
  normaliseName,
  shortenIdentifier,
} from './data.mjs';
import * as notify from './notify.mjs';
import {
  cachedAddress,
  walletAddress,
  addressOnNetwork,
  walletKdf,
  setupWallet,
  setupWalletFromKey,
  addressForPrivateKey,
  privateKeyOfPhrase,
  newPhrase,
  qrFor,
  decodeFrame,
  interpretScan,
  removeWallet,
  revealPhrase,
  claim,
  linkProven,
  send,
  registerName,
  listName,
  updateListing,
  delistName,
  buyName,
  makeNameOffer,
  acceptNameOffer,
  declineNameOffer,
  cancelNameOffer,
  updateNameAddress,
  transferName,
  acceptNameTransfer,
  cancelNameTransfer,
  setNameRecovery,
  startNameRecovery,
  cancelNameRecovery,
  finalizeNameRecovery,
  checkAddressText,
  recipientKind,
  resolveRecipientName,
  reconfirmRecipientName,
} from './wallet.mjs';
import { SCREENS, remainingSeconds, networkBanner } from './screens.mjs';
import { installDisplayStyles } from './identifier.mjs';
import { scan } from './scanner.mjs';

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
  appConfig: null,
  config: null,
  status: null,
  network: null,
  params: null,
  schedule: null,
  mining: null,
  miningAt: null,
  balance: null,
  history: null,
  ex: emptyExplorer(),
  apiTry: null,
  ownNames: null,
  invites: null,
  recoveryCodes: null,
  walletAddress: cachedAddress(),
  vaultKdf: null,
  mfa: null,
  mfaRequired: false,
  ons: { query: '', result: null },
  // The ONS Marketplace (protocol 2.0.0). Everything here is read from the node; `review` is a Buy or an Offer that is
  // waiting for the person to confirm its terms, and nothing is signed until they do.
  market: { feed: null, sort: 'newest', offset: 0, incoming: null, outgoing: null, mine: null, events: null, nameOffers: null, review: null },
  setup: { mode: 'create', draft: null, keyPreview: null },
  qr: null,
  // A `.obs` recipient that has been resolved and is waiting for the user to confirm it. Nothing is signed until then.
  sendReview: null,
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
  app.innerHTML = networkBanner(state) + (screen
    ? screen(state)
    : `<div class="hd"><b style="letter-spacing:.18em">OBSIDIAN</b></div>` +
      `<div class="card" style="margin-top:20px"><div class="row mu">That screen does not exist.</div></div>` +
      `<button class="btn" onclick="ObsidianGo('landing')">‹ BACK</button>`);
  startCountdown();
}

/** Repaint after a background refresh, unless the user is mid-input. */
function repaint() {
  const active = document.activeElement;
  const typing = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
  if (typing) return;
  // A form with something typed into it is not repainted either, even when its field
  // is not focused: a background refresh must not erase a half-written payment or the
  // words someone is copying back from paper.
  const app = document.getElementById('app');
  const filled = app?.querySelectorAll?.('input, textarea');
  if (filled && [...filled].some((el) => el.value)) return;
  render();
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
  // A phrase that was generated but never sealed does not survive leaving the screen.
  state.setup.draft = null;
  state.setup.keyPreview = null;
  discardPendingKey();
  state.sendReview = null;
  if (state.screen === 'wallet' && !state.walletAddress) state.wt = 'setup';
  window.scrollTo(0, 0);
  render();
  // A screen that reads the chain asks for it on arrival. Waiting for the next
  // 15-second poll left the explorer reading "the node has not returned any blocks"
  // for a visitor looking at a healthy chain.
  if (state.screen === 'explorer') loadExplorer().catch(() => {});
  if (state.screen === 'ons') {
    state.market.review = null;
    loadMarket({ paint: true }).catch(() => {});
  }
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

/**
 * Tell an embedding host which public address this device holds (the browser extension's service worker
 * needs it to ask the node about claim eligibility while the popup is closed). Only the address, which is
 * public: no phrase, key or passphrase ever goes through here. No host on the web, so a no-op.
 */
function announceAddress() {
  try {
    globalThis.ObsidianHost?.walletAddress?.(state.walletAddress);
  } catch {
    /* a host's bookkeeping must never break the wallet */
  }
}

async function refreshWallet() {
  const stored = state.walletAddress || (await walletAddress().catch(() => null));
  // The prefix is the network's: a cache written under another network is
  // re-encoded rather than shown as an address this node would reject.
  const address = await addressOnNetwork(stored, state.network?.network?.addressHrp).catch(() => stored);
  state.walletAddress = address || null;
  announceAddress();
  await ensureQr();
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

/**
 * Draw the wallet's QR code, once per address. It encodes the address and nothing
 * else, so there is nothing to keep secret and nothing to expire. A failure is
 * remembered as a failure — the screen says so — rather than retried every repaint.
 */
async function ensureQr() {
  const address = state.walletAddress;
  if (!address) {
    state.qr = null;
    return;
  }
  if (state.qr?.address === address) return;
  try {
    state.qr = { address, svg: await qrFor(address) };
  } catch {
    state.qr = { address, svg: null, error: true };
  }
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

/**
 * Read the Marketplace from the node: the listings feed, this wallet's names with their listing state, and its
 * incoming and outgoing offers. Each read fails on its own and leaves an honest gap (`null`) rather than a guess.
 */
async function loadMarket({ paint = false } = {}) {
  const ask = (promise) => promise.then((value) => value, () => null);
  const m = state.market;
  const address = state.walletAddress;
  const [feed, incoming, outgoing, events] = await Promise.all([
    ask(getMarketListings({ sort: m.sort, offset: m.offset })),
    address ? ask(getMarketOffers('incoming', address)) : null,
    address ? ask(getMarketOffers('outgoing', address)) : null,
    address ? ask(getMarketEvents(address, 12)) : null,
  ]);
  const mine = address && state.ownNames
    ? Object.fromEntries(await Promise.all(state.ownNames.map(async (n) => [n, await ask(getMarketName(n))])))
    : null;
  Object.assign(m, { feed, incoming, outgoing, events, mine });
  if (paint) render();
  else repaint();
}

async function refresh() {
  const [status, network] = await Promise.all([
    getStatus().catch(() => null),
    getNetwork().catch(() => null),
  ]);
  state.status = status;
  state.network = network;
  // A node that has stopped answering must not leave its last answers on screen as
  // if they were current: a stale height beside "OFFLINE" is an invented chain.
  if (!status) state.ex.data = {};

  await refreshAccount();
  await refreshWallet();

  const [params, schedule] = await Promise.all([
    state.params ? null : getParams().catch(() => null),
    state.schedule ? null : getMiningSchedule().catch(() => null),
  ]);
  if (params) state.params = params;
  if (schedule) state.schedule = schedule;

  // The explorer shows the chain, not this wallet, so it is refreshed on its own
  // schedule rather than as part of the wallet refresh.
  if (state.screen === 'explorer') await loadExplorer({ quiet: true });
  if (state.screen === 'ons') await loadMarket();

  state.invites = state.account ? await invites().catch(() => null) : null;
  repaint();
}

/**
 * Load whatever the open explorer view needs.
 *
 * Each tab reads its own routes, and one route failing blanks only its own panel:
 * a node that serves /supply but not /pot still shows the supply. The result is
 * written only if the user is still looking at the tab it was fetched for, so a
 * slow answer cannot paint over a different view.
 */
async function loadExplorer({ quiet = false } = {}) {
  const ex = state.ex;
  if (ex.detail) return;
  const tab = ex.tab;
  if (!quiet) {
    ex.loading = true;
    delete ex.errors[tab];
    repaint();
  }
  const ask = (promise) => promise.then((value) => value, () => null);
  let data = null;
  if (tab === 'overview') {
    const [status, supply, pot, mempool] = await Promise.all([ask(getStatus()), ask(getSupply()), ask(getPot()), ask(getMempool())]);
    if (status) state.status = status;
    data = status || supply || pot ? { status, supply, pot, mempool } : null;
  } else if (tab === 'blocks') {
    data = await ask(getBlocks(25));
  } else if (tab === 'claims') {
    data = await ask(getMiningClaims(undefined, 25));
  } else if (tab === 'names') {
    data = await ask(getNames('', 25));
  } else if (tab === 'network') {
    const [nodes, producers, finality, mempool, rewards, audit] = await Promise.all([
      ask(getNodes()),
      ask(getProducers()),
      ask(getFinality()),
      ask(getMempool()),
      ask(getNodeRewards()),
      ask(getAudit('decentralization')),
    ]);
    data = nodes || producers || finality || mempool || rewards || audit ? { nodes, producers, finality, mempool, rewards, audit } : null;
  }
  if (state.ex !== ex || ex.tab !== tab) return;
  ex.loading = false;
  if (data) {
    ex.data[tab] = data;
    delete ex.errors[tab];
  } else {
    delete ex.data[tab];
    ex.errors[tab] = 'The node did not answer. Nothing here is guessed in its place.';
  }
  repaint();
}

/**
 * Someone who is already signed in is taken home, not shown the signed-out landing page.
 *
 * The design file arms a timer that sends the splash to the landing page 800 ms after load, whatever the session
 * is, so a signed-in user reopening the app would otherwise be greeted with "START MINING" and a sign-up button.
 * Wait out that timer, then correct it. Only splash and landing are moved: if the user has already gone
 * somewhere on purpose (the explorer, say), that is left alone.
 */
async function landSignedInUsersHome() {
  const wait = 900 - (typeof performance !== 'undefined' ? performance.now() : 900);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  if (state.account && (state.screen === 'splash' || state.screen === 'landing')) go('home');
}

async function boot() {
  state.appConfig = await getAppConfig().catch(() => null);
  if (state.appConfig && !state.appConfig.production) {
    document.title = `Obsidian Network — ${state.appConfig.network.toUpperCase()}`;
  }
  state.config = await authConfig().catch(() => null);
  await refresh();
  render();
  notify.resume(state.walletAddress);
  await landSignedInUsersHome();
  // Poll, never extrapolate: the height and the eligibility window are the node's
  // to state, and a page that invents movement between polls is lying about a chain.
  setInterval(() => {
    refresh().catch(() => {});
  }, 15_000);
}

// ── actions ──────────────────────────────────────────────────────────────────

/**
 * A private key typed or pasted for recovery. Held here, outside `state`, from the moment its address has been shown
 * until the wallet is sealed or the person leaves the screen: the key is never put back into the page, never sent and
 * never logged.
 */
let pendingKey = null;
function discardPendingKey() {
  pendingKey = null;
}

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
  // What was typed, so that an error does not cost the user their input. Passwords and
  // passphrases are never carried over: they are asked for again.
  const screen = state.screen;
  const typed = [...document.querySelectorAll('#app input, #app textarea')]
    .filter((el) => el.id && el.type !== 'password' && el.type !== 'checkbox' && el.value)
    .map((el) => [el.id, el.value]);
  // Ticked boxes are state too. A repaint builds new elements, and a new checkbox is unticked: without this the
  // "I have saved my recovery phrase" box cleared itself the moment the button was pressed.
  const ticked = [...document.querySelectorAll('#app input[type=checkbox]')].filter((el) => el.id && el.checked).map((el) => el.id);
  const retick = () => {
    for (const id of ticked) {
      const el = document.getElementById(id);
      if (el) el.checked = true;
    }
  };
  state.busy = key;
  state.error = '';
  // A deliberate action: its fields were read before this point, so it repaints
  // unconditionally to show the busy state (the quiet background refresh does not).
  render();
  retick();
  try {
    await fn();
  } catch (error) {
    setError(explain(error));
  } finally {
    state.busy = null;
    render();
    if (state.error && state.screen === screen) {
      for (const [id, value] of typed) {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = value;
      }
      retick();
    }
  }
}

// ── installation ─────────────────────────────────────────────────────────────

function install() {
  installDisplayStyles();
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
    if (tab === 'receive') ensureQr().then(() => state.wt === 'receive' && render());
  };

  // Scan a wallet's RECEIVE code into the recipient field. The scan fills the field and
  // nothing else: it never sets an amount and never sends.
  g.ObsidianScan = async () => {
    if (state.scanning) return;
    state.scanning = true;
    let verdict = null;
    try {
      verdict = await scan({
        decode: decodeFrame,
        interpret: (text) => interpretScan(text, { own: state.walletAddress }).catch((error) => ({ ok: false, message: explain(error) })),
      });
    } finally {
      state.scanning = false;
    }
    if (!verdict) return;
    const to = document.getElementById('to');
    if (!to) return; // the user left the Send form while the camera was open
    to.value = verdict.value;
    const note = document.getElementById('scn');
    if (note) {
      note.className = 'ok';
      note.textContent =
        verdict.kind === 'name'
          ? 'Name filled in from the QR code. It is looked up on the chain when you send, and you confirm the address it resolves to before anything is signed.'
          : 'Address filled in from the QR code. Check it matches who you mean to pay, then enter the amount.';
    }
    document.getElementById('am')?.focus();
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
    let keepPassword = false;
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
          keepPassword = true;
          setError('Enter the code from your authenticator app.');
        } else {
          setError(explain(error));
        }
      }
    }).then(() => {
      // The repaint emptied the form. Keep the address so a typo in the password, or the
      // extra code, does not mean typing it again; keep the password only for the
      // second-factor step, where it was right.
      if (state.screen !== 'signin') return;
      const put = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      put('em', email);
      if (keepPassword) put('pw', password);
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
      // The secret and the code field live on the Menu screen; started from Home, the
      // user is taken to them rather than left looking at a button that did nothing.
      if (state.mfa) state.screen = 'menu';
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

  /**
   * Link this device's wallet to the account — once, for good. The wallet signs a challenge from
   * the platform with its own key (the passphrase unlocks it here), so only a proven address is
   * ever bound, and nothing about the account is used to make a wallet.
   */
  g.ObsidianLinkAddress = () => {
    const passphrase = field('pp');
    return withBusy('link', async () => {
      if (!state.walletAddress) return setError('Set up a wallet on this device first.');
      if (!passphrase) return setError('Enter your vault passphrase to sign the link.');
      const result = await linkProven(() => passphrase);
      if (!result.ok) return setError(result.message);
      await refreshAccount();
      setNotice('Wallet linked to your account for good.');
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
  g.ObsidianSetupMode = (mode) => {
    pendingKey = null;
    state.setup = { mode: mode === 'import' ? 'import' : mode === 'key' ? 'key' : 'create', draft: null, keyPreview: null };
    state.error = '';
    render();
  };

  g.ObsidianGeneratePhrase = () =>
    withBusy('generate', async () => {
      const words = (await newPhrase()).trim().split(/\s+/);
      // Three distinct positions to prove the phrase was written down, chosen by the
      // browser's CSPRNG and shown in order.
      const picks = new Set();
      while (picks.size < 3) picks.add(1 + (crypto.getRandomValues(new Uint32Array(1))[0] % words.length));
      // The private key this phrase controls, shown beside it so both can be backed up.
      const privateKey = await privateKeyOfPhrase(words.join(' '));
      state.setup = { mode: 'create', draft: { words, privateKey, check: [...picks].sort((a, b) => a - b) } };
    });

  /** Step one of recovery from a private key: validate locally and show the address it controls. Nothing is stored. */
  g.ObsidianCheckKey = () => {
    const typed = field('pk');
    return withBusy('checkkey', async () => {
      pendingKey = null;
      state.setup = { mode: 'key', draft: null, keyPreview: null };
      let address;
      try {
        address = await addressForPrivateKey(typed);
      } catch (error) {
        return setError(error.message); // the reason, never the input
      }
      pendingKey = typed;
      state.setup = { mode: 'key', draft: null, keyPreview: { address } };
    });
  };

  g.ObsidianDiscardKey = () => {
    pendingKey = null;
    state.setup = { mode: 'key', draft: null, keyPreview: null };
    state.error = '';
    render();
  };

  /** Step two: the person confirmed the address is theirs; choose a passphrase and seal. */
  g.ObsidianSealKey = () => {
    const passphrase = field('pp');
    const confirm = field('p2');
    const confirmed = document.getElementById('ckaddr')?.checked === true;
    return withBusy('setup', async () => {
      if (!pendingKey || !state.setup.keyPreview) return setError('Enter your private key and check its address first.');
      if (!confirmed) return setError('Confirm that this is your address before continuing.');
      if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return setError(`Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      }
      if (passphrase !== confirm) return setError('Passphrases do not match.');
      const key = pendingKey;
      const expected = state.setup.keyPreview.address;
      const { address } = await setupWalletFromKey({ privateKey: key, passphrase });
      pendingKey = null;
      if (address !== expected) throw new Error('The sealed wallet does not match the address you confirmed. It was not kept.');
      state.setup = { mode: 'create', draft: null, keyPreview: null };
      state.walletAddress = address;
      state.wt = 'receive';
      setNotice('Wallet recovered from your private key and sealed on this device.');
      await refreshWallet();
    });
  };

  g.ObsidianDiscardPhrase = () => {
    state.setup = { mode: 'create', draft: null };
    state.error = '';
    render();
  };

  g.ObsidianSetupWallet = () => {
    const importing = state.setup.mode === 'import';
    const draft = state.setup.draft;
    const phrase = importing ? field('ph') : draft?.words.join(' ') ?? '';
    const proof = draft ? draft.check.map((_, i) => field(`cw${i}`)) : [];
    // Read now, with the other fields: once the busy state is painted the page holds new, unticked elements.
    const saved = document.getElementById('cksaved')?.checked === true;
    const passphrase = field('pp');
    const confirm = field('p2');
    return withBusy('setup', async () => {
      if (!importing) {
        if (!draft) return setError('Generate a recovery phrase first.');
        if (!saved) {
          return setError('Confirm that you have saved both the recovery phrase and the private key.');
        }
        const right = draft.check.every((n, i) => proof[i].trim().toLowerCase() === draft.words[n - 1]);
        // Deliberately does not say which word was wrong.
        if (!right) return setError('Those words do not match the phrase above. Check what you wrote down.');
      }
      if (!passphrase || passphrase.length < MIN_PASSPHRASE_LENGTH) {
        return setError(`Choose a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
      }
      if (passphrase !== confirm) return setError('Passphrases do not match.');
      const { address } = await setupWallet({ phrase, passphrase });
      state.setup = { mode: 'create', draft: null };
      state.walletAddress = address;
      state.wt = 'receive';
      setNotice('Wallet sealed on this device. Keep the paper with your phrase safe: it is the only backup.');
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
      state.sendReview = null;
      state.walletAddress = null;
      announceAddress();
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
      state.claimSentAt = Date.now();
      setNotice(`Claim submitted — ${shortenIdentifier(result.txId, 'hash', 'narrow')} — not yet confirmed.`);
      await refreshMining();
    });
  };

  /**
   * Pay an address — or resolve a `.obs` name and ask first.
   *
   * An address goes straight to signing, as it always has. A name does not: it is resolved
   * from the chain's ONS record, the result is put on screen (the name, the full address it
   * resolves to, the network), and nothing is signed until the user confirms THAT address.
   * A name that cannot be resolved stops here with the reason; it is never sent as text.
   */
  g.ObsidianSend = () => {
    const to = field('to').trim();
    const amountObs = field('am').trim();
    const memo = field('mm').trim();
    const passphrase = field('pp');
    return withBusy('send', async () => {
      const kind = await recipientKind(to);
      if (kind === 'empty') return setError('Enter a recipient address or a .obs name.');
      if (kind === 'name') {
        if (!/^\d+(\.\d{1,18})?$/.test(amountObs)) return setError('Enter the amount to send before the name is resolved.');
        const resolved = await resolveRecipientName(to);
        if (!resolved.ok) return setError(resolved.message);
        state.sendReview = { resolved, to, amountObs, memo, from: state.walletAddress };
        return;
      }
      const result = await send({ to, amountObs, memo }, () => passphrase);
      if (!result.ok) return setError(result.message);
      setNotice(`Payment submitted — ${shortenIdentifier(result.txId, 'hash', 'narrow')} — not yet confirmed.`);
      await refreshWallet();
    });
  };

  /** The user has read the resolved address. Resolve once more, and sign only if it is unchanged. */
  g.ObsidianSendConfirm = () => {
    const review = state.sendReview;
    const passphrase = field('pp');
    if (!review) return undefined;
    return withBusy('send', async () => {
      if (review.from !== state.walletAddress) {
        state.sendReview = null;
        return setError('The wallet changed while this payment was waiting. Nothing was sent.');
      }
      const again = await reconfirmRecipientName(review.resolved);
      if (!again.ok) {
        state.sendReview = null;
        return setError(again.message);
      }
      // The address that was shown is the address that is paid: `again.address === review.resolved.address`,
      // and only that value — never the name — is handed to the payment builder.
      const result = await send({ to: review.resolved.address, amountObs: review.amountObs, memo: review.memo }, () => passphrase);
      if (!result.ok) return setError(result.message);
      state.sendReview = null;
      setNotice(`Payment to ${review.resolved.name} submitted — ${shortenIdentifier(result.txId, 'hash', 'narrow')} — not yet confirmed.`);
      await refreshWallet();
    });
  };

  g.ObsidianSendCancel = () => {
    const typed = state.sendReview;
    state.sendReview = null;
    state.error = '';
    render();
    // Back to the form with what was typed (never the passphrase) so a cancelled review costs nothing.
    for (const [id, value] of [['to', typed?.to], ['am', typed?.amountObs], ['mm', typed?.memo]]) {
      const input = document.getElementById(id);
      if (input && value) input.value = value;
    }
  };

  g.ObsidianNameSearch = async () => {
    const raw = field('nm');
    const name = normaliseName(raw);
    state.ons = { query: raw, result: null };
    if (!name) return setError('Use 3–63 letters, numbers or hyphens (no leading, trailing or double hyphens, and not a reserved name).');
    setError('');
    render();
    try {
      await openName(name);
    } catch (error) {
      setError(explain(error));
    }
    render();
  };

  // ── ONS Marketplace ───────────────────────────────────────────────────────

  /** Look a name up on the Marketplace: the node says whether it is available, owned or listed. */
  const openName = async (name) => {
    const found = await nameStatus(name);
    const market = found?.registered ? await getMarketName(name).catch(() => null) : null;
    const offers = found?.registered && market?.pendingOffers ? await getMarketOffers('name', name, 'PENDING').catch(() => null) : null;
    state.ons = { query: name, result: found ? { ...found, market } : null };
    state.market.nameOffers = offers;
    state.market.review = null;
  };

  /** After a signed action: poll the node until the chain shows the new state, then say so. Submitted is not confirmed. */
  const confirmThen = async (label, txId, confirmed) => {
    setNotice(`${label} submitted — ${shortenIdentifier(txId, 'hash', 'narrow')} — waiting for the chain to confirm…`);
    render();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await confirmed().catch(() => false)) {
        setNotice(`${label} confirmed on the chain.`);
        await refreshWallet();
        await loadMarket();
        if (state.ons?.query) await openName(state.ons.query).catch(() => {});
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    setError(`${label} is not confirmed yet. It may still be pending, or the chain refused it: check the state below before trying again.`);
  };

  /** Run one Marketplace operation: refusals are shown plainly; success waits for the chain. */
  const marketAction = (label, sign, confirmed, passphraseField = 'pp') => {
    const passphrase = field(passphraseField);
    return withBusy('ons', async () => {
      const result = await sign(() => passphrase);
      if (!result.ok) return setError(result.message);
      await confirmThen(label, result.txId, confirmed);
    });
  };

  g.ObsidianMarketSort = (sort) => {
    state.market.sort = sort;
    state.market.offset = 0;
    loadMarket({ paint: true }).catch(() => {});
  };

  g.ObsidianMarketPage = (delta) => {
    state.market.offset = Math.max(0, state.market.offset + delta);
    loadMarket({ paint: true }).catch(() => {});
  };

  g.ObsidianMarketOpen = (name) => {
    const input = document.getElementById('nm');
    if (input) input.value = name;
    return g.ObsidianNameSearch();
  };

  g.ObsidianMarketReviewBuy = () => {
    const { market } = state.ons.result;
    if (!market?.listing) return setError('This name is no longer listed.');
    state.market.review = { kind: 'buy', name: state.ons.result.name, listing: market.listing };
    setError('');
    render();
  };

  g.ObsidianMarketReviewOffer = () => {
    const { market } = state.ons.result;
    const amountObs = field('oa').trim();
    if (!/^\d+(\.\d{1,18})?$/.test(amountObs) || /^0+(\.0*)?$/.test(amountObs)) {
      return setError('Enter the offer as an OBS amount greater than zero, such as 25 or 0.5.');
    }
    state.market.review = { kind: 'offer', name: state.ons.result.name, owner: market?.owner, amountObs };
    setError('');
    render();
  };

  g.ObsidianMarketCancelReview = () => {
    state.market.review = null;
    render();
  };

  g.ObsidianMarketBuy = () => {
    const review = state.market.review;
    const me = state.walletAddress;
    return marketAction(
      `Purchase of ${review.name}`,
      (pass) => buyName({ name: review.name, reviewedPriceSeals: review.listing.priceSeals, reviewedSeller: review.listing.seller }, pass),
      async () => (await getMarketName(review.name)).owner === me,
    );
  };

  g.ObsidianMarketOffer = () => {
    const review = state.market.review;
    const me = state.walletAddress;
    return marketAction(
      `Offer on ${review.name}`,
      (pass) => makeNameOffer({ name: review.name, amountObs: review.amountObs, reviewedOwner: review.owner }, pass),
      async () => (await getMarketOffers('outgoing', me, 'PENDING')).offers.some((o) => o.name === review.name),
    );
  };

  g.ObsidianMarketList = (name, inputId) => {
    const priceObs = field(inputId).trim();
    return marketAction(`Listing of ${name}`, (pass) => listName({ name, priceObs }, pass), async () => (await getMarketName(name)).status === 'LISTED', 'pp2');
  };

  g.ObsidianMarketUpdate = (name, previous, inputId) => {
    const priceObs = field(inputId).trim();
    return marketAction(`Re-pricing of ${name}`, (pass) => updateListing({ name, priceObs }, pass), async () => (await getMarketName(name)).listing?.priceSeals !== previous, 'pp2');
  };

  g.ObsidianMarketDelist = (name) =>
    marketAction(`Removal of the listing of ${name}`, (pass) => delistName({ name }, pass), async () => !(await getMarketName(name)).locked, 'pp2');

  const offerDone = (offerId) => async () => (await getMarketOffer(offerId)).offer.status !== 'PENDING';
  g.ObsidianMarketAccept = (offerId) => marketAction('Acceptance of the offer', (pass) => acceptNameOffer({ offerId }, pass), offerDone(offerId), 'pp2');
  g.ObsidianMarketDecline = (offerId) => marketAction('Decline of the offer', (pass) => declineNameOffer({ offerId }, pass), offerDone(offerId), 'pp2');
  g.ObsidianMarketCancel = (offerId) => marketAction('Cancellation of the offer', (pass) => cancelNameOffer({ offerId }, pass), offerDone(offerId), 'pp2');

  // ── ONS owner actions (protocol 1.9.0): change address, transfer, recovery ───────────────────────────────────
  //
  // Every action is two steps. REVIEW shows what will be signed and what it will do; CONFIRM asks for the vault passphrase,
  // re-reads the name from the node (a name that changed while it was on screen is not signed), signs, and then waits for the
  // chain to show the new state before saying it happened. None of these moves OBS, and none pays gas.

  /** The parts of a name's record an owner action depends on: if any of them changed since review, nothing is signed. */
  const nameSnapshot = (record) => ({
    owner: record?.owner ?? null,
    address: record?.address ?? null,
    pendingTransfer: record?.pendingTransfer ? { to: record.pendingTransfer.to, offerExpiresAt: record.pendingTransfer.offerExpiresAt ?? null } : null,
    recoveryAddress: record?.recoveryAddress ?? null,
    pendingRecovery: record?.pendingRecovery
      ? { by: record.pendingRecovery.by, newAddress: record.pendingRecovery.newAddress, effectiveAt: record.pendingRecovery.effectiveAt ?? null }
      : null,
    locked: Boolean(record?.locked) || record?.marketStatus === 'LISTED',
  });

  /** `field` is the input that holds the address this action needs; `done` is how the chain shows it happened. */
  const OWNER_ACTIONS = {
    update: {
      field: 'oaddr',
      label: 'Change of address',
      sign: (review, pass) => updateNameAddress({ name: review.name, address: review.target }, pass),
      done: (record, review) => record.address === review.target,
    },
    transfer: {
      field: 'otto',
      label: 'Transfer offer',
      sign: (review, pass) => transferName({ name: review.name, to: review.target }, pass),
      done: (record, review) => record.pendingTransfer?.to === review.target,
    },
    withdraw: {
      label: 'Withdrawal of the transfer offer',
      sign: (review, pass) => cancelNameTransfer({ name: review.name }, pass),
      done: (record) => !record.pendingTransfer,
    },
    accept: {
      label: 'Acceptance of the transfer',
      sign: (review, pass) => acceptNameTransfer({ name: review.name }, pass),
      done: (record, review) => record.owner === review.me,
    },
    recoverySet: {
      field: 'orec',
      label: 'Recovery address',
      sign: (review, pass) => setNameRecovery({ name: review.name, address: review.target }, pass),
      done: (record, review) => record.recoveryAddress === review.target,
    },
    recoveryClear: {
      label: 'Removal of the recovery address',
      sign: (review, pass) => setNameRecovery({ name: review.name, address: '' }, pass),
      done: (record) => !record.recoveryAddress,
    },
    recoveryStart: {
      field: 'onew',
      label: 'Recovery',
      sign: (review, pass) => startNameRecovery({ name: review.name, newOwner: review.target }, pass),
      done: (record, review) => record.pendingRecovery?.newAddress === review.target,
    },
    recoveryCancel: {
      label: 'Cancellation of the recovery',
      sign: (review, pass) => cancelNameRecovery({ name: review.name }, pass),
      done: (record) => !record.pendingRecovery,
    },
    recoveryFinalize: {
      label: 'Completion of the recovery',
      sign: (review, pass) => finalizeNameRecovery({ name: review.name }, pass),
      done: (record, review) => record.owner === review.snapshot.pendingRecovery?.newAddress,
    },
  };

  /** Open a name from YOUR NAMES: the search result carries the owner's actions. */
  g.ObsidianOwnerManage = async (name) => {
    await g.ObsidianMarketOpen(name);
    window.scrollTo?.(0, 0);
  };

  g.ObsidianOwnerReview = async (kind) => {
    const result = state.ons?.result;
    const spec = OWNER_ACTIONS[kind];
    if (!result?.record || !spec) return;
    if (!state.walletAddress) {
      setError('Set up a wallet on this device first.');
      return render();
    }
    let target;
    const typed = spec.field ? field(spec.field).trim() : '';
    if (spec.field) {
      const checked = await checkAddressText(typed);
      if (!checked.ok) {
        setError(checked.message);
        render();
        const input = document.getElementById(spec.field);
        if (input) input.value = typed;
        return;
      }
      target = checked.address;
    }
    state.market.review = { kind, name: result.name, target, me: state.walletAddress, snapshot: nameSnapshot(result.record) };
    setError('');
    render();
  };

  g.ObsidianOwnerConfirm = () => {
    const review = state.market.review;
    const spec = OWNER_ACTIONS[review?.kind];
    if (!spec) return undefined;
    const me = state.walletAddress;
    return marketAction(
      `${spec.label} on ${review.name}`,
      async (pass) => {
        if (review.me !== me) return { ok: false, message: 'The wallet changed while this was waiting. Nothing was signed.' };
        const now = nameSnapshot(await getName(review.name).catch(() => null));
        if (JSON.stringify(now) !== JSON.stringify(review.snapshot)) {
          return { ok: false, message: `${review.name} changed while you were reviewing it. Nothing was signed: look at it again.` };
        }
        return spec.sign(review, pass);
      },
      async () => spec.done(await getName(review.name), review),
    );
  };

  g.ObsidianRegisterName = (name) => {
    const feeObs = state.params?.ons?.registrationFeeObs;
    const passphrase = field('pp');
    return withBusy('ons', async () => {
      if (!feeObs) return setError('The node has not published a registration fee.');
      const result = await registerName({ name, feeObs }, () => passphrase);
      if (!result.ok) return setError(result.message);
      setNotice(`Registration submitted — ${shortenIdentifier(result.txId, 'hash', 'narrow')} — not yet confirmed.`);
      await refreshWallet();
    });
  };

  // ── explorer ───────────────────────────────────────────────────────────────
  g.ObsidianExTab = (tab) => {
    state.ex.tab = tab;
    state.ex.detail = null;
    state.error = '';
    render();
    loadExplorer().catch(() => {});
  };

  g.ObsidianExClose = () => {
    state.ex.detail = null;
    state.error = '';
    render();
    loadExplorer({ quiet: true }).catch(() => {});
  };

  /** Open a block, a transaction or a name from a list or a link. */
  g.ObsidianExOpen = async (kind, value) => {
    state.error = '';
    // Opened from another screen — a transaction in your own activity, say — it is
    // shown in the explorer, which is where a transaction's detail lives.
    if (state.screen !== 'explorer') state.screen = 'explorer';
    try {
      if (kind === 'block') {
        state.ex.detail = { kind: 'block', block: await getBlock(value) };
      } else if (kind === 'tx') {
        state.ex.detail = { kind: 'transaction', transaction: await getTransaction(value) };
      } else if (kind === 'name') {
        state.ex.detail = { kind: 'name', record: await getName(value) };
      }
      window.scrollTo(0, 0);
    } catch (error) {
      setError(explain(error));
    }
    render();
  };

  /**
   * Search by height, block id, transaction id or name — and nothing else.
   *
   * An address is deliberately not searchable. Looking up an arbitrary wallet's
   * activity is the one thing the platform's own explorer refuses to do, and an
   * explorer here that did it would turn a privacy rule into a per-product choice.
   */
  g.ObsidianSearch = async (preset) => {
    const query = preset !== undefined ? String(preset).trim() : field('q').trim();
    if (!query) {
      setError('Enter a block height, a block or transaction id, or a name ending in .obs.');
      return render();
    }
    setError('');
    if (/^(obs|tobs|sobs|dobs)1[0-9a-z]{10,}$/i.test(query)) {
      setError(
        'Addresses are not searchable here, by design: an explorer that looks up a wallet turns the chain into a surveillance tool. Your own activity is on the WALLET screen.',
      );
      return render();
    }
    state.busy = 'search';
    render();
    try {
      if (/^\d+$/.test(query)) {
        state.ex.detail = { kind: 'block', block: await getBlock(query) };
      } else if (/^[0-9a-f]{64}$/i.test(query)) {
        // The two id kinds look alike. Ask for a transaction first, then a block.
        try {
          state.ex.detail = { kind: 'transaction', transaction: await getTransaction(query.toLowerCase()) };
        } catch {
          state.ex.detail = { kind: 'block', block: await getBlock(query.toLowerCase()) };
        }
      } else if (/\.obs$/i.test(query)) {
        state.ex.detail = { kind: 'name', record: await getName(query.toLowerCase()) };
      } else {
        setError('That is not a block height, a block or transaction id, or a .obs name.');
      }
      if (state.ex.detail) window.scrollTo(0, 0);
    } catch (error) {
      setError(explain(error));
    }
    state.busy = null;
    render();
  };

  // ── developer reads ────────────────────────────────────────────────────────
  g.ObsidianApiTry = async (route) => {
    state.apiTry = { route, loading: true };
    render();
    try {
      state.apiTry = { route, body: await readRoute(route) };
    } catch (error) {
      state.apiTry = { route, error: explain(error) };
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
      setNotice(notify.limitNote());
    }
    render();
  };

  g.ObsidianNotifyDisable = () => {
    notify.disable();
    state.notify = notify.permission();
    setNotice('Claim alerts off.');
    render();
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
