/**
 * The real data layer for the Obsidian app.
 *
 * Every function here replaces one of the demo behaviours the design file shipped
 * with. The design's layout, tokens and screen structure are kept exactly; only the
 * data underneath them changes.
 *
 * Two rules govern this file:
 *
 *   - Nothing is invented. A value the platform did not return is rendered as an
 *     explicit unavailable state, never as a plausible-looking default. The design
 *     file's hardcoded VALID invite list, its TAKEN names, its FEE and its PRICE all
 *     came from nowhere, and none of them survive here.
 *   - No amount is ever a float. The protocol's internal unit is the seal and
 *     1 OBS is 10^18 of them, so every conversion here is integer arithmetic on
 *     strings. Dividing by 10^8 — which this file once did — overstates every
 *     balance and every reward by ten orders of magnitude.
 *
 * All requests go to /api/* on this origin. The server proxies them to the platform,
 * so the browser never learns where the platform lives.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * An optional embedding host, for the browser-extension build (obsidian-extension/).
 *
 * On the web this is undefined and nothing below changes: every request goes to this origin. An
 * extension page has no origin of its own to serve /api from, so its host supplies the address of an
 * Obsidian app server (the same server this file normally talks to) and says when it is ready:
 *
 *   ObsidianHost.ready          promise: settings loaded
 *   ObsidianHost.apiBase()      the server origin, or throws when none is configured (nothing is sent)
 *   ObsidianHost.timeoutMs      per-request deadline
 *
 * The host is a transport, not a source of data: paths, parsing and every figure shown still come from
 * this file and the server.
 */
const host = () => globalThis.ObsidianHost ?? null;

/**
 * Call this origin and surface the platform's own error wording.
 *
 * The server distinguishes cases the app cannot see — a spent invitation versus an
 * address that is already taken, for instance — so its message is returned verbatim
 * rather than replaced with something generic.
 */
async function call(path, { method = 'GET', body } = {}) {
  const embedding = host();
  if (embedding) await embedding.ready;
  const response = await fetch((embedding ? embedding.apiBase() : '') + path, {
    method,
    headers: JSON_HEADERS,
    // The session cookie belongs to the app server. From an extension page that is another origin.
    credentials: embedding ? 'include' : 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: embedding?.timeoutMs ? AbortSignal.timeout(embedding.timeoutMs) : undefined,
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  // Every endpoint this app calls answers JSON. A proxy that answers HTML — a
  // captive portal, a misconfigured host, a login page — is not "no data", and
  // reading it as an empty object would render as exactly that on every screen.
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    const error = new Error(
      response.ok
        ? `unexpected non-JSON response from ${path}`
        : `HTTP ${response.status} from ${path}`,
    );
    error.code = response.ok ? 'ERR_MALFORMED' : null;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status} from ${path}`);
    error.code = data.code ?? null;
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * The shortest passphrase that may seal a wallet on this device. The platform's own
 * MIN_VAULT_PASSPHRASE_LENGTH, and the same as its account-password minimum:
 * tests/vault-interop.test.mjs fails if the two ever differ.
 */
export const MIN_PASSPHRASE_LENGTH = 12;

// ── this deployment's own identity ───────────────────────────────────────────

let appConfigCache = null;

/**
 * Which network THIS app is, as its own server declares it (`/app-config.json`).
 *
 * This is the app's identity and is deliberately not read from the node: the node is
 * the thing being checked against it. Only a successful answer is remembered, so an
 * app that could not be identified at load time tries again rather than staying
 * unidentified — and anything that signs refuses until it has an identity.
 */
export async function getAppConfig() {
  if (appConfigCache) return appConfigCache;
  const config = await call('/app-config.json');
  if (!Number.isInteger(config.chainId) || typeof config.addressHrp !== 'string' || !config.network) {
    throw new Error('this app could not determine which network it is');
  }
  appConfigCache = config;
  return config;
}

// ── accounts ─────────────────────────────────────────────────────────────────

/**
 * The sign-up rules, from the server rather than from this file.
 *
 * The design file hardcoded an invitation list and a "password is not verified"
 * comment. The real platform is invite-only, checks the code before it looks
 * anything up about the address, and publishes its own minimums — so the form reads
 * them and cannot drift from the server.
 */
export const authConfig = () => call('/api/auth/config');

/** Register. The invitation is judged by the platform, never by this file. */
export const register = ({ email, password, inviteCode, displayName }) =>
  call('/api/auth/register', {
    method: 'POST',
    body: { email, password, inviteCode, displayName },
  });

/** Sign in. `totp` is required only once MFA is enabled on the account. */
export const login = ({ email, password, totp }) =>
  call('/api/auth/login', { method: 'POST', body: { email, password, totp } });

export const me = () => call('/api/auth/me');

export const logout = () => call('/api/auth/logout', { method: 'POST' });

export const mfaSetup = () => call('/api/auth/mfa/setup', { method: 'POST' });

export const mfaConfirm = (totp) => call('/api/auth/mfa/confirm', { method: 'POST', body: { totp } });

export const recover = ({ email, recoveryCode, newPassword }) =>
  call('/api/auth/recover', { method: 'POST', body: { email, recoveryCode, newPassword } });

export const invites = () => call('/api/auth/invites');

export const issueInvite = () => call('/api/auth/invites', { method: 'POST' });

/**
 * Linking a wallet is two calls: the platform issues a challenge for an address, then takes the
 * signature of it. The address is never accepted on its word alone, and no key is ever sent.
 */
export const requestLinkChallenge = (address) =>
  call('/api/wallet/link/challenge', { method: 'POST', body: { address } });

export const submitLinkProof = ({ address, publicKey, signature }) =>
  call('/api/wallet/link', { method: 'POST', body: { address, publicKey, signature } });

/**
 * Since protocol 1.7.0 the chain refuses a mining claim that does not carry a certificate from the mining gate.
 * The platform issues one — for ONE wallet and ONE claim id, valid for minutes — only to a signed-in account whose
 * second factor is confirmed and whose linked wallet is `address`. Resolves to the certificate itself.
 */
export const requestMiningCertificate = async (address, claimId) =>
  (await call('/api/mining/certificate', { method: 'POST', body: { address, claimId } })).gate;

// ── chain data, through the platform's one read-through gateway ───────────────

/**
 * The interface exposes node reads at `/api/rpc?path=<node route>`.
 *
 * That is a PATH proxy, not a JSON-RPC endpoint. Sending it a `{"jsonrpc":"2.0",
 * "method":"getstatus"}` envelope — which this file used to do — is answered by a
 * node route table that has never heard of `getstatus`, so every chain read failed
 * with "not found". The route names below are the node's own.
 *
 * The whole path is percent-encoded, including its query, because the interface
 * folds any extra query parameters onto the read; encoding everything into `path`
 * leaves exactly one interpretation.
 */
function rpcPath(route, query) {
  const full = query ? `${route}?${query}` : route;
  return `/api/rpc?path=${encodeURIComponent(full)}`;
}

const read = (route, query) => call(rpcPath(route, query));
const write = (route, body) => call(rpcPath(route), { method: 'POST', body });

/** Run any allowlisted read and return the node's own JSON. Used by the API screen. */
export const readRoute = (route) => call(`/api/rpc?path=${encodeURIComponent(route)}`);

export const getStatus = () => read('/status');
export const getParams = () => read('/params');
export const getNetwork = () => read('/network');
export const getSupply = () => read('/supply');
export const getBlocks = (limit = 20) => read('/blocks', `limit=${encodeURIComponent(limit)}`);
export const getBlock = (idOrHeight) => read(`/block/${encodeURIComponent(idOrHeight)}`);
export const getTransaction = (txId) => read(`/tx/${encodeURIComponent(txId)}`);
export const getNodes = () => call('/api/nodes');

export const getAddressHistory = (address, limit = 25) =>
  read(`/address/${encodeURIComponent(address)}`, `limit=${encodeURIComponent(limit)}`);

/** The node's balance record for one address. Seals are exact; OBS strings are too. */
export const getBalance = (address) => write('/wallet/balance', { address });

/**
 * The nonce the next transaction from this address must carry.
 *
 * Read from the node, never tracked locally: two tabs, a restarted device or a
 * transaction that expired out of the mempool all leave a locally-counted nonce
 * wrong, and a wrong nonce is a BAD_NONCE rejection.
 */
export const getNextNonce = (address) => read(`/wallet/${encodeURIComponent(address)}/next-nonce`);

/**
 * The protocol's own mining eligibility for one address.
 *
 * This replaces the demo's session timer and its fixed RATE. The protocol derives
 * rewardPerClaim from how many miners are active, so any constant written into this
 * file would be wrong the moment that count moved. Everything here is the node's own
 * computation: eligibility, the reward, the interval, the claims left in the cycle,
 * and the canonical claim id the next claim must carry.
 *
 * Eligibility is a function of protocol state and the including block's timestamp
 * alone — never of this browser's clock. secondsRemaining is a UI hint, not
 * authority, and the app treats it that way.
 */
export const getMiningStatus = (address) =>
  read('/mining/status', `address=${encodeURIComponent(address)}`);

export const getMiningSchedule = () => read('/mining/schedule');

/**
 * Mining claims. With a miner, that address's own claims; without one, the chain's
 * latest claims from every miner, which the node masks before they leave it.
 */
export const getMiningClaims = (miner, limit = 20) =>
  read(
    '/mining/claims',
    `${miner ? `miner=${encodeURIComponent(miner)}&` : ''}limit=${encodeURIComponent(limit)}`,
  );

// ── what the explorer reads ──────────────────────────────────────────────────
// Each of these is a public, address-masked node route. None answers "how much
// does this wallet hold", and the explorer never asks (docs/explorer.md, rule 1).

/** Proof of Time state: difficulty, time-rate, the authoritative clock. */
export const getPot = () => read('/pot');
/** The deterministic producer schedule: which tier is active and how many registered nodes are eligible. */
export const getProducers = () => read('/producers');
/** The consensus-derived finalized checkpoint. Read from chain state; never a local timer. */
export const getFinality = () => read('/finality');
export const getMempool = () => read('/mempool');
/** The node's answers to "can anyone shut this down / mint / censor", with evidence. */
export const getAudit = (kind) => read(`/audit/${encodeURIComponent(kind)}`);
/** Node-runner reward pool and its settlement schedule. */
export const getNodeRewards = () => read('/nodes/rewards');
export const getNodeRegistry = () => read('/nodes/registry');

export const getNames = (prefix = '', limit = 20) =>
  read('/names', `${prefix ? `prefix=${encodeURIComponent(prefix)}&` : ''}limit=${encodeURIComponent(limit)}`);

export const getName = (name) => read(`/names/${encodeURIComponent(name)}`);

// ── ONS Marketplace (protocol 2.0.0): every figure is the node's own chain state ──────────────────────────────

const bareName = (name) => String(name ?? '').trim().toLowerCase().replace(/\.obs$/, '');
/** One name's Marketplace status: AVAILABLE, EXPIRED, OWNED or LISTED, with the listing and the pending offers count. */
export const getMarketName = (name) => read(`/market/name/${encodeURIComponent(bareName(name))}`);
export const getMarketListings = ({ sort = 'newest', limit = 20, offset = 0 } = {}) =>
  read('/market/listings', `sort=${encodeURIComponent(sort)}&limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
/** `scope` is `name`, `incoming` (to an owner) or `outgoing` (from a maker). */
export const getMarketOffers = (scope, subject, status) =>
  read(`/market/offers/${scope}/${encodeURIComponent(scope === 'name' ? bareName(subject) : subject)}`, status ? `status=${encodeURIComponent(status)}` : '');
export const getMarketOffer = (id) => read(`/market/offer/${encodeURIComponent(id)}`);
export const getMarketEvents = (address, limit = 20) => read('/market/events', `address=${encodeURIComponent(address)}&limit=${encodeURIComponent(limit)}`);

/**
 * Submit signed bytes.
 *
 * `hex` is the canonical signed encoding produced by the core's `encodeSignedTx`.
 * The node decodes it itself; nothing about the transaction is restated here, so
 * there is no way for the two descriptions to disagree.
 */
export const submitTransaction = (hex) => write('/tx/submit', { tx: hex });

// ── values the design file invented, and what replaces them ──────────────────

/**
 * One account's linked address, or null.
 *
 * The design synthesised one from a hash of the email so the wallet screen was never
 * empty. That was the single most dangerous thing in the file: an address that
 * belongs to nobody, presented as the user's, invites someone to send funds to it.
 */
export const accountAddress = async () => {
  const { account } = await me();
  return account?.walletAddress ?? null;
};

// Recipient resolution lives in the core (protocol/recipient.ts) and reaches this app through the signing bundle:
// see resolveRecipientName / reconfirmRecipientName in wallet.mjs. There is deliberately no second implementation here.

/**
 * Whether a name is registered, from the chain's own name set.
 *
 * The design file answered from a hardcoded TAKEN array and offered to sell the
 * name for PRICE=25. Neither number meant anything. The chain is the only source
 * that does, and the fee is a consensus parameter published on /params.
 */
export const nameStatus = async (rawName) => {
  const name = normaliseName(rawName);
  if (!name) return null;
  try {
    const record = await getName(name);
    return { name, registered: true, record };
  } catch (error) {
    // /names/{name} answers 404 for an unregistered name on every node build that
    // serves the route, but a node that predates it answers ERR_REJECTED for the
    // whole path. Either way the honest answer is "not registered", and the
    // caller shows which one it got.
    if (error.status === 404 || error.code === 'ERR_NOT_FOUND') {
      return { name, registered: false, record: null };
    }
    if (error.code === 'ERR_REJECTED' || error.status === 400) {
      return { name, registered: false, record: null, unverified: true };
    }
    throw error;
  }
};

/** `onsq()`'s own rule: 3–24 letters, numbers or hyphens, plus the .obs suffix. */
export function normaliseName(raw) {
  const base = String(raw ?? '').trim().toLowerCase().replace(/\.obs$/, '');
  if (!/^[a-z0-9-]{3,24}$/.test(base)) return null;
  return `${base}.obs`;
}

// ── amounts ──────────────────────────────────────────────────────────────────

const OBS_UNIT = 10n ** 18n;

/**
 * Format a seal amount as OBS — at most 6 decimals, rounded to nearest, grouped, trailing zeros removed, never `0`
 * for a real amount. Kept under its old name for the callers; the rules live in the display mirror below.
 * `decimals` is an optional display precision (18 = every digit).
 */
export function sealsToObs(seals, decimals) {
  return displaySeals(seals, decimals === undefined ? undefined : { maxDecimals: decimals });
}

/**
 * Parse a decimal OBS string into seals.
 *
 * Rejects more than 18 decimal places rather than rounding: an amount the protocol
 * cannot represent must not be quietly turned into a different one.
 */
export function parseObs(text) {
  const raw = String(text ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error('enter an amount like 0.05 or 12');
  const [whole, frac = ''] = raw.split('.');
  if (frac.length > 18) throw new Error('amounts have at most 18 decimal places');
  return BigInt(whole) * OBS_UNIT + BigInt((frac + '0'.repeat(18)).slice(0, 18) || '0');
}

// ── Display formatting (a mirror of obsidian-core/src/protocol/display.ts) ───────────────────────────────────────
//
// This page ships as plain ES modules with no bundler, so it cannot import the core's compiled formatter. These
// functions are the same code with the types removed, and tests/display-parity.test.mjs runs them against the
// shared vectors (tests/vectors/display.json) AND against the compiled core module, so the two cannot drift.
// Display only: nothing here feeds a transaction, a fee, a balance or an API payload, and nothing turns text back
// into a value. Every OBS amount, count and long identifier on every screen goes through these.

/** What is shown for a value that is missing or is not an amount. Never `0`: a missing balance is not a zero one. */
export const UNAVAILABLE = '—';

/** Fractional digits shown for an ordinary amount (balance, supply, mined, pool, reward, claim). */
export const DISPLAY_DECIMALS = 6;
const PROTOCOL_DECIMALS = 18;
const DISPLAY_UNIT = 10n ** BigInt(PROTOCOL_DECIMALS);

/** Every digit the protocol holds, for a detail view, a confirmation or a tooltip. */
export const EXACT_OBS = Object.freeze({ maxDecimals: PROTOCOL_DECIMALS });

function clampDecimals(value) {
  if (value === undefined) return DISPLAY_DECIMALS;
  if (!Number.isFinite(value)) return DISPLAY_DECIMALS;
  return Math.max(0, Math.min(PROTOCOL_DECIMALS, Math.floor(value)));
}

/** Insert commas into a string of digits. */
export function groupDigits(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Shared tail: a non-negative whole and an 18-digit fraction, to text. Exact integer arithmetic throughout. */
function render(negative, whole, fraction18, opts) {
  const maxDecimals = clampDecimals(opts?.maxDecimals);
  const group = opts?.group !== false;
  const total = whole * DISPLAY_UNIT + BigInt(fraction18);
  const nonZero = total > 0n;
  // Round to the nearest displayed unit, ties away from zero (the magnitude is rounded, then the sign is put back).
  const divisor = 10n ** BigInt(PROTOCOL_DECIMALS - maxDecimals);
  let units = total / divisor;
  if ((total % divisor) * 2n >= divisor && divisor > 1n) units += 1n;
  if (units === 0n && nonZero) {
    // A real amount that the displayed precision would hide. Say so, rather than show 0.
    const floor = maxDecimals === 0 ? '1' : `0.${'0'.repeat(maxDecimals - 1)}1`;
    return negative ? `>-${floor}` : `<${floor}`;
  }
  const scale = 10n ** BigInt(maxDecimals);
  const shownWhole = units / scale;
  const shownFraction = maxDecimals === 0 ? '' : (units % scale).toString().padStart(maxDecimals, '0').replace(/0+$/, '');
  const wholeText = group ? groupDigits(shownWhole.toString()) : shownWhole.toString();
  return `${negative && units > 0n ? '-' : ''}${wholeText}${shownFraction ? `.${shownFraction}` : ''}`;
}

/** Exact base units (seals; 1 OBS = 10^18) to display text. */
export function displaySeals(seals, opts) {
  if (seals === null || seals === undefined) return UNAVAILABLE;
  let value;
  if (typeof seals === 'bigint') value = seals;
  else if (typeof seals === 'string' && /^-?\d+$/.test(seals.trim())) value = BigInt(seals.trim());
  else return UNAVAILABLE;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  return render(negative, abs / DISPLAY_UNIT, (abs % DISPLAY_UNIT).toString().padStart(PROTOCOL_DECIMALS, '0'), opts);
}

/** An OBS decimal string ("0.05000000000000000000", "21000000") to display text. Input beyond 18 places is cut at 18 (the protocol holds no more); rounding to the display precision is done on that. */
export function displayDecimal(text, opts) {
  if (typeof text !== 'string') return UNAVAILABLE;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) return UNAVAILABLE;
  const fraction = (match[3] ?? '').slice(0, PROTOCOL_DECIMALS).padEnd(PROTOCOL_DECIMALS, '0');
  return render(match[1] === '-', BigInt(match[2]), fraction, opts);
}

/**
 * The node speaks two exact shapes for one quantity: seal counts (integer text) and OBS decimals (text with a point).
 * This accepts either and picks by the point. A bigint is a seal count. A JavaScript number is refused: it cannot hold
 * a token quantity exactly, so there is no honest way to print one.
 */
export function displayObs(value, opts) {
  if (typeof value === 'bigint') return displaySeals(value, opts);
  if (typeof value !== 'string') return UNAVAILABLE;
  return value.includes('.') ? displayDecimal(value, opts) : displaySeals(value, opts);
}

/** "12.5 OBS". Zero is "0 OBS"; a missing value is the unavailable mark with no unit. */
export function displayObsWithUnit(value, opts) {
  const text = displayObs(value, opts);
  return text === UNAVAILABLE ? text : `${text} OBS`;
}

/**
 * What a screen may say about the Mining Pool, decided from what the node actually returned. Display only.
 *
 * The Mining Pool is protocol state (`state.pool.balance`), served by a node as `GET /supply` -> `poolBalanceObs`.
 * It is NOT the total supply, NOT the amount mined, NOT the node-runner reward pool, NOT the treasury and NOT any
 * wallet's balance, and nothing here derives it from any of those. It is a recycling pool: gas and the
 * parked treasury share flow in, and the next mining claim is paid from it first, so `0` is a normal, genuine
 * reading whenever fees have already been paid out. That is why a zero is shown as zero ONLY when the node said
 * zero, and a missing answer is "unavailable", never 0.
 *
 *   mismatch    the node answering reports another chain than this interface is for; its figures are not shown
 *   unavailable the value is missing, malformed, or the node's own supply check does not hold
 *   ok          `value` is the node's figure (rounded for display), `exact` carries every digit
 */

export function describeMiningPool(input) {
  // The node returns OBS decimals with a point (formatObs). Anything else is not a pool balance.
  const shown = (v, o) => {
    const t = typeof v === 'string' && v.includes('.') ? displayDecimal(v, o) : UNAVAILABLE;
    return t === UNAVAILABLE ? t : `${t} OBS`;
  };
  const none = (state, reason) => ({
    state, value: UNAVAILABLE, exact: null, zero: false, reason, lifetimeInflow: null, lifetimeDistributed: null,
  });
  const expected = input.expectedChainId;
  if (expected !== undefined && expected !== null) {
    const reported = input.status?.chainId;
    const reportedChain = typeof reported === 'number' ? reported : typeof reported === 'string' && /^\d+$/.test(reported) ? Number(reported) : null;
    if (reportedChain === null) return none('unavailable', 'The node has not said which network it is on, so its pool figure cannot be trusted for this one.');
    if (reportedChain !== expected) return none('mismatch', `The node answering is on chain ${reportedChain}, but this is chain ${expected}. Its figures are not shown.`);
  }
  const pool = input.supply?.poolBalanceObs;
  if (shown(pool) === UNAVAILABLE) return none('unavailable', 'The node has not returned the Mining Pool figure.');
  if (input.supply?.invariantOk === false) return none('unavailable', 'The node reports that its supply check does not hold, so the pool figure is not shown.');
  const inflow = input.status?.pool?.lifetimeInflow;
  const distributed = input.status?.pool?.lifetimeDistributed;
  const text = (v) => (shown(v) === UNAVAILABLE ? null : shown(v));
  return {
    state: 'ok',
    value: shown(pool),
    exact: shown(pool, EXACT_OBS),
    zero: shown(pool, EXACT_OBS) === '0 OBS',
    reason: null,
    lifetimeInflow: text(inflow),
    lifetimeDistributed: text(distributed),
  };
}

/** A whole-number count (block height, miners, iterations) with commas, exact for any size, same in every locale. */
export function displayInteger(value) {
  let text;
  if (typeof value === 'bigint') text = value.toString();
  else if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) return UNAVAILABLE;
    text = String(value);
  } else if (typeof value === 'string') text = value.trim();
  else return UNAVAILABLE;
  const match = /^(-?)(\d+)$/.exec(text);
  if (!match) return UNAVAILABLE;
  return `${match[1]}${groupDigits(match[2].replace(/^0+(?=\d)/, ''))}`;
}

// ── identifiers ──────────────────────────────────────────────────────────────

/**
 * How many characters each end keeps. The narrow policy is the one in use on phones: `obs1ijdn...slvgsi` is the
 * address policy (8 + 6). `wide` is for screens with room; a detail view shows the whole value instead.
 */
export const IDENTIFIER_POLICY = {
  address: { narrow: [8, 6], wide: [14, 8] },
  hash: { narrow: [10, 8], wide: [16, 10] },
  id: { narrow: [10, 8], wide: [16, 10] },
};

export const ELLIPSIS = '...';

/**
 * A value a node has already masked for the explorer ("obs1abcd…wxyz") carries its own ellipsis. It is not an
 * identifier to copy or to shorten a second time; it is shown as it came.
 */
export function isMaskedIdentifier(value) {
  return typeof value === 'string' && (value.includes('…') || value.includes(ELLIPSIS));
}

/**
 * Display-only shortening: first N, "...", last M. Returns the value unchanged when shortening would not make it
 * shorter. The result is NOT an identifier and must never be copied, compared, validated, signed or sent.
 */
export function shortenIdentifier(value, kind = 'address', width = 'narrow') {
  if (typeof value !== 'string' || value === '') return UNAVAILABLE;
  const [head, tail] = IDENTIFIER_POLICY[kind][width];
  if (isMaskedIdentifier(value) || value.length <= head + tail + ELLIPSIS.length) return value;
  return `${value.slice(0, head)}${ELLIPSIS}${value.slice(-tail)}`;
}

/** A duration as the protocol counts it. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return '0s';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h}h`, m && `${m}m`, (s || (!h && !m)) && `${s}s`].filter(Boolean).join(' ');
}

/** A registration term, in the unit a person thinks in: 31,536,000 s is 365 days, not 8760h. */
export function formatTerm(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total >= 86400 && total % 86400 === 0) {
    const d = total / 86400;
    return d % 365 === 0 ? `${d} days (${d / 365} year${d / 365 === 1 ? '' : 's'})` : `${d} days`;
  }
  return formatDuration(total);
}

/** A protocol timestamp as a local time string, or an em dash when there is none. */
export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Date(value * 1000).toLocaleString();
}

/**
 * A value that goes INSIDE the quotes of an inline handler argument: onclick="ObsidianExOpen('tx','HERE')".
 *
 * esc() is the wrong tool there. It turns a quote into &#39;, and the browser decodes the attribute BEFORE it parses
 * the handler, so the value arrives as a real quote and ends the string: a node (or anything else that can put text
 * in a block, a name or a transaction id) could then run its own script in the page that holds the wallet.
 * Here every character outside a small safe set becomes a \uXXXX escape: the handler still receives the exact text,
 * and nothing in the attribute can be a quote, a backslash-escape of one, a tag or an entity. Real ids, heights,
 * names and addresses use only the safe set and are unchanged.
 */
export function arg(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._:@-]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
