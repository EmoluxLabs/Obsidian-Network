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
 * Call this origin and surface the platform's own error wording.
 *
 * The server distinguishes cases the app cannot see — a spent invitation versus an
 * address that is already taken, for instance — so its message is returned verbatim
 * rather than replaced with something generic.
 */
async function call(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: JSON_HEADERS,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
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

/** Links the wallet address to the account. Only an address is sent — never a key. */
export const linkWallet = (address) =>
  call('/api/wallet/link', { method: 'POST', body: { address } });

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

export const getMiningClaims = (miner, limit = 20) =>
  read('/mining/claims', `miner=${encodeURIComponent(miner)}&limit=${encodeURIComponent(limit)}`);

export const getNames = (prefix = '') =>
  read('/names', prefix ? `prefix=${encodeURIComponent(prefix)}` : '');

export const getName = (name) => read(`/names/${encodeURIComponent(name)}`);

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

/**
 * Turn what the user typed into a recipient address.
 *
 * A `.obs` name is resolved on the chain rather than locally: the mapping is
 * blockchain state, and showing the user the address their name resolves to —
 * before they sign — is the only honest way to let them check it.
 */
export async function resolveRecipient(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: 'Enter a recipient address or a .obs name.' };
  if (/\.obs$/i.test(text)) {
    let record;
    try {
      record = await getName(text.toLowerCase());
    } catch (error) {
      return { ok: false, message: error.message };
    }
    if (!record?.address) return { ok: false, message: `${text.toLowerCase()} does not resolve to an address.` };
    return { ok: true, address: record.address, name: text.toLowerCase(), resolved: true };
  }
  if (!/^(obs|tobs|sobs|dobs)1[0-9a-z]{20,}$/.test(text)) {
    return { ok: false, message: 'That is not a valid Obsidian address or a .obs name.' };
  }
  return { ok: true, address: text, resolved: false };
}

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
 * Format a seal amount as OBS.
 *
 * Done on BigInt strings, never on a float: `Number` holds 2^53 exactly, and a
 * balance in seals is far past that, so a float conversion silently rounds the
 * amount this page claims the user holds.
 *
 * Trailing zeros are trimmed for readability, and `decimals` caps the display —
 * the protocol's own full-precision strings are used wherever a node supplies one.
 */
export function sealsToObs(seals, decimals = 8) {
  if (seals === null || seals === undefined) return '—';
  const raw = String(seals).trim();
  if (!/^\d+$/.test(raw)) return '—';
  const value = typeof seals === 'bigint' ? seals : BigInt(raw);
  const whole = value / OBS_UNIT;
  const frac = value % OBS_UNIT;
  const digits = Math.max(0, Math.min(18, Math.floor(decimals)));
  if (digits === 0) return whole.toString();
  const padded = frac.toString().padStart(18, '0');
  // Full precision keeps the protocol's own representation, trailing zeros and
  // all — the same default the node's formatter uses. Anything shorter is a
  // display decision, so it is trimmed to `digits`.
  if (digits >= 18) return `${whole}.${padded}`;
  const trimmed = padded.slice(0, digits).replace(/0+$/, '');
  return trimmed ? `${whole}.${trimmed}` : whole.toString();
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

/** A duration as the protocol counts it. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return '0s';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h}h`, m && `${m}m`, (s || (!h && !m)) && `${s}s`].filter(Boolean).join(' ');
}

/** A protocol timestamp as a local time string, or an em dash when there is none. */
export function formatTime(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value <= 0) return '—';
  return new Date(value * 1000).toLocaleString();
}
