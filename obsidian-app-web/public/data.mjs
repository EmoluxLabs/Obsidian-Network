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
 *   - The app holds no key and signs nothing. Claiming a mining reward is a signed
 *     MINING_CLAIM transaction; until the canonical crypto is wired in through
 *     sync-core.mjs, this file reports eligibility and submits nothing. It never
 *     adds to a balance the way the demo's claim() did.
 *
 * All requests go to /api/* on this origin. The server proxies them to the platform,
 * so the browser never learns where the platform lives.
 */

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

/**
 * Call the platform and surface its own error wording.
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
  const data = text ? JSON.parse(text) : {};
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

export const login = ({ email, password }) =>
  call('/api/auth/login', { method: 'POST', body: { email, password } });

export const me = () => call('/api/auth/me');

export const logout = () => call('/api/auth/logout', { method: 'POST' });

export const mfaSetup = () => call('/api/auth/mfa/setup', { method: 'POST' });

export const mfaConfirm = (code) =>
  call('/api/auth/mfa/confirm', { method: 'POST', body: { code } });

export const recover = ({ email, recoveryCode, newPassword }) =>
  call('/api/auth/recover', { method: 'POST', body: { email, recoveryCode, newPassword } });

export const invites = () => call('/api/auth/invites');

export const issueInvite = () => call('/api/auth/invites', { method: 'POST' });

/** Links a watch address. Only the address is sent — never a key or a phrase. */
export const linkWallet = (address) =>
  call('/api/wallet/link', { method: 'POST', body: { address } });

// ── chain data, through the platform's one RPC gateway ───────────────────────

async function rpc(method, params = {}) {
  const envelope = await call('/api/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
  // A JSON-RPC error object is a legitimate answer, not a transport failure: turn it
  // into a thrown error so a screen shows the node's own message instead of
  // mistaking the envelope for data.
  if (envelope?.error) {
    const error = new Error(envelope.error.message || 'the node returned an error');
    error.code = envelope.error.code ?? null;
    throw error;
  }
  return envelope?.result;
}

export const getStatus = () => rpc('getstatus');
export const getBlocks = (from, limit) => rpc('getblocks', { from, limit });
export const getBlock = (height) => rpc('getblock', { height });
export const getTransaction = (txId) => rpc('gettransaction', { txId });
export const getBalance = (address) => rpc('getbalance', { address });
export const getNames = () => rpc('getnames');
export const getFinality = () => rpc('getfinality');
export const getParams = () => rpc('getparams');
export const getPeers = () => rpc('getpeers');

/**
 * The protocol's own mining eligibility for one address.
 *
 * This replaces the demo's session timer and its fixed RATE. The protocol derives
 * rewardPerClaim from how many miners are active, so any constant written into this
 * file would be wrong the moment that count moved. Everything here is the node's own
 * computation: eligibility, the reward, the interval, and the claims left in the
 * cycle.
 *
 * Eligibility is a function of protocol state and the including block's timestamp
 * alone — never of this browser's clock. secondsRemaining is a UI hint, not
 * authority, and the app treats it that way.
 */
export const getMiningStatus = (address) => rpc('getminingstatus', { address });

// ── values the design file invented, and what replaces them ──────────────────

/**
 * The design file computed a fake address from a hash of the email. A real address
 * comes from the account, or is absent — it is never synthesised, because a
 * plausible-looking address that belongs to nobody is worse than a blank field.
 */
export const accountAddress = async () => {
  const { account } = await me();
  return account?.walletAddress ?? null;
};

/**
 * Whether a name is registered.
 *
 * The design file answered from a hardcoded TAKEN array and offered to sell the name
 * for PRICE=25. The chain's name set is the only source that means anything, and
 * claiming a name is a signed ONS transaction this app cannot build — so this
 * reports availability and stops there.
 */
export const nameStatus = async (rawName) => {
  const name = normaliseName(rawName);
  if (!name) return null;
  const names = await getNames();
  return { name, registered: Array.isArray(names) && names.includes(name) };
};

/** `onsq()`'s own rule: 3–24 letters, numbers or hyphens, plus the .obs suffix. */
export function normaliseName(raw) {
  const base = String(raw ?? '').trim().toLowerCase().replace(/\.obs$/, '');
  if (!/^[a-z0-9-]{3,24}$/.test(base)) return null;
  return `${base}.obs`;
}

/**
 * Format a seal amount as OBS.
 *
 * The protocol's internal unit is the seal. Showing a raw seal count as though it
 * were OBS would overstate every reward by eight orders of magnitude.
 */
export function sealsToObs(seals, decimals = 8) {
  const value = Number(seals);
  if (!Number.isFinite(value)) return '—';
  return (value / 1e8).toFixed(decimals).replace(/\.?0+$/, '') || '0';
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
