/**
 * Connection settings for the Obsidian extension, and the checks that go with them.
 *
 * The extension has no node and no ledger of its own. It talks to one Obsidian app server — the same
 * server obsidian-app-web serves, which fronts the platform and an Obsidian node — and everything it shows
 * comes from there. This module only decides which server that is and whether it may be trusted to be
 * the network the user meant. It has no DOM and no chrome.* dependency, so the popup, the options page,
 * the service worker and the tests all share it.
 */

/**
 * The four networks. Kept separate from obsidian-core on purpose (as obsidian-app-web's own table is);
 * tests/config.test.mjs asserts this equals that table, so the two cannot drift apart silently.
 */
export const NETWORKS = Object.freeze({
  mainnet: { name: 'mainnet', networkId: 'obsidian-mainnet-1', chainId: 7777, addressHrp: 'obs', production: true },
  testnet: { name: 'testnet', networkId: 'obsidian-testnet-1', chainId: 7778, addressHrp: 'tobs', production: false },
  staging: { name: 'staging', networkId: 'obsidian-staging-1', chainId: 7779, addressHrp: 'sobs', production: false },
  devnet: { name: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', production: false },
});
export const NETWORK_NAMES = Object.freeze(Object.keys(NETWORKS));

export const SETTINGS_KEY = 'obsidian.settings';
export const REQUEST_TIMEOUT_MS = 8000;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate a server address typed by a person.
 *
 * Accepts https anywhere, and plain http only for a loopback host (a node or app server run on this
 * machine). Plain http to any other host would send a session cookie and a password across the network
 * in the clear, so it is refused rather than warned about. Credentials, a path, a query and a fragment are
 * all refused: the value is an origin, and anything else would be silently dropped.
 *
 * @returns {{ ok: true, origin: string, pattern: string } | { ok: false, error: string }}
 */
export function parseServerUrl(input) {
  const text = String(input ?? '').trim();
  if (!text) return { ok: false, error: 'Enter the address of an Obsidian app server.' };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, error: 'That is not a valid address. Example: https://app.example.org' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only https:// addresses are accepted (http:// only for this machine).' };
  }
  if (url.protocol === 'http:' && !LOOPBACK.has(url.hostname)) {
    return {
      ok: false,
      error: 'Plain http:// is only accepted for this machine (localhost or 127.0.0.1). Use https:// for anything else.',
    };
  }
  if (url.username || url.password) {
    return { ok: false, error: 'The address must not contain a user name or password.' };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { ok: false, error: 'Give the server address only, without a path, query or fragment.' };
  }
  // Extension host permissions are match patterns: scheme and host, never a port.
  return { ok: true, origin: url.origin, pattern: `${url.protocol}//${url.hostname}/*` };
}

/** What the extension stores. Anything else found in storage is ignored, never trusted. */
export function sanitiseSettings(raw) {
  const out = { serverUrl: null, network: null, alerts: false, address: null };
  if (!raw || typeof raw !== 'object') return out;
  if (typeof raw.serverUrl === 'string') {
    const parsed = parseServerUrl(raw.serverUrl);
    if (parsed.ok) out.serverUrl = parsed.origin;
  }
  if (typeof raw.network === 'string' && NETWORKS[raw.network]) out.network = raw.network;
  out.alerts = raw.alerts === true;
  // A public address only. Format is checked again against the network before it is ever used.
  if (typeof raw.address === 'string' && /^[a-z]{1,8}1[02-9ac-hj-np-z]{20,120}$/.test(raw.address)) {
    out.address = raw.address;
  }
  return out;
}

export async function loadSettings(storage) {
  const stored = await storage.get(SETTINGS_KEY);
  return sanitiseSettings(stored?.[SETTINGS_KEY]);
}

export async function saveSettings(storage, patch) {
  const next = sanitiseSettings({ ...(await loadSettings(storage)), ...patch });
  await storage.set({ [SETTINGS_KEY]: next });
  return next;
}

// ── talking to the server ───────────────────────────────────────────────────────────────────────────

/**
 * Failure kinds the user can act on. `kind` is stable (tests and the UI branch on it); `message` is for people.
 */
export class ServerError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'ServerError';
    this.kind = kind;
    this.detail = detail;
  }
}

/**
 * GET one JSON document from the server, with a deadline, and say precisely how it failed.
 * Never sends cookies (`credentials: 'omit'`): these are public reads used for diagnostics and for the
 * background check, and neither should depend on, or disturb, a session.
 */
export async function getJson(origin, path, { fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetchImpl(origin + path, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new ServerError('timeout', `No answer from the server within ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw new ServerError(
      'unreachable',
      'Could not connect to the server. It may be down, the address may be wrong, or the connection was refused.',
    );
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw new ServerError('unreachable', 'The connection dropped while reading the server\u2019s answer.');
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const code = typeof json?.error?.code === 'string' ? json.error.code : typeof json?.code === 'string' ? json.code : null;
    const kind = response.status === 404 || response.status === 405 ? 'unsupported' : response.status >= 500 ? 'server' : 'rejected';
    throw new ServerError(kind, `The server answered ${response.status}${code ? ` (${code})` : ''}.`, { status: response.status, code });
  }
  if (json === undefined || json === null || typeof json !== 'object') {
    throw new ServerError('malformed', 'The server answered, but not with JSON this extension understands. Is this an Obsidian app server?');
  }
  return json;
}

/**
 * Does the server's own statement of identity match the network the user pinned?
 * `app-config.json` is derived from the app server's fixed table, never from the platform it checks.
 * @returns {{ ok: true, config: object } | { ok: false, kind: string, message: string }}
 */
export function checkIdentity(config, expectedName) {
  const shapeOk =
    config &&
    typeof config.network === 'string' &&
    Number.isInteger(config.chainId) &&
    typeof config.addressHrp === 'string' &&
    typeof config.networkId === 'string';
  if (!shapeOk) {
    return { ok: false, kind: 'malformed', message: 'The server did not say which network it is. Is this an Obsidian app server?' };
  }
  const known = NETWORKS[config.network];
  if (!known || known.chainId !== config.chainId || known.addressHrp !== config.addressHrp || known.networkId !== config.networkId) {
    return {
      ok: false,
      kind: 'unsupported',
      message: `The server describes a network this extension does not know (${config.network}, chain ${config.chainId}).`,
    };
  }
  const expected = NETWORKS[expectedName];
  if (!expected) {
    return { ok: false, kind: 'not-configured', message: 'No network has been chosen for this extension yet.' };
  }
  if (known.name !== expected.name) {
    return {
      ok: false,
      kind: 'wrong-network',
      message: `WRONG NETWORK \u2014 this server is ${known.name}, but this extension is set to ${expected.name}. Nothing will be shown or signed.`,
    };
  }
  if (config.verified !== true) {
    return {
      ok: false,
      kind: 'unverified',
      message: 'The server could not confirm that its node and platform are on the network it claims (' + String(config.verification ?? 'unknown') + '). Nothing will be shown or signed.',
    };
  }
  return { ok: true, config };
}

/** Seconds after the last block at which a node counts as stale: it should produce one every few seconds. */
export function staleAfterSeconds(targetSeconds) {
  const t = Number.isFinite(targetSeconds) && targetSeconds > 0 ? targetSeconds : 5;
  return Math.max(60, t * 12);
}

/**
 * Walk through every check the extension depends on, in order, and report each separately.
 * Pure over (origin, expected, fetchImpl, now): used by the options page, shown in the popup, and tested.
 * @returns {Promise<Array<{id:string,label:string,status:'ok'|'warn'|'fail'|'skipped',detail:string}>>}
 */
export async function runDiagnostics(origin, expectedName, { fetchImpl = fetch, now = () => Date.now(), timeoutMs } = {}) {
  const opts = { fetchImpl, timeoutMs };
  const steps = [];
  const add = (id, label, status, detail) => steps.push({ id, label, status, detail });
  const fail = (id, label, error) => add(id, label, 'fail', error instanceof ServerError ? `${error.kind}: ${error.message}` : String(error?.message ?? error));

  let identity;
  try {
    identity = await getJson(origin, '/app-config.json', opts);
    const checked = checkIdentity(identity, expectedName);
    if (checked.ok) add('identity', 'Server identity', 'ok', `${identity.network} \u00b7 chain ${identity.chainId} \u00b7 ${identity.networkId}`);
    else add('identity', 'Server identity', 'fail', `${checked.kind}: ${checked.message}`);
    if (!checked.ok) {
      for (const [id, label] of [['platform', 'Platform'], ['node', 'Node'], ['consistency', 'Genesis agreement']]) {
        add(id, label, 'skipped', 'Not checked: the server identity failed.');
      }
      return steps;
    }
  } catch (error) {
    fail('identity', 'Server identity', error);
    for (const [id, label] of [['platform', 'Platform'], ['node', 'Node'], ['consistency', 'Genesis agreement']]) {
      add(id, label, 'skipped', 'Not checked: the server could not be reached.');
    }
    return steps;
  }

  try {
    const auth = await getJson(origin, '/api/auth/config', opts);
    if (auth.network !== identity.network) {
      add('platform', 'Platform', 'fail', `wrong-network: the platform says ${String(auth.network)}, the server says ${identity.network}.`);
    } else {
      add('platform', 'Platform', 'ok', auth.inviteOnly ? 'accounts are by invitation' : 'accounts are open');
    }
  } catch (error) {
    fail('platform', 'Platform', error);
  }

  let status = null;
  try {
    status = await getJson(origin, '/api/rpc?path=' + encodeURIComponent('/status'), opts);
    const height = Number.isInteger(status.height) ? status.height : null;
    if (height === null || typeof status.genesisId !== 'string') {
      add('node', 'Node', 'fail', 'malformed: the node\u2019s status did not include a height and genesis id.');
    } else if (status.chainId !== identity.chainId || status.networkId !== identity.networkId) {
      add('node', 'Node', 'fail', `wrong-network: the node reports ${String(status.networkId)} (chain ${String(status.chainId)}).`);
    } else {
      const age = Number.isFinite(status.lastBlockTimestamp) ? Math.max(0, Math.round(now() / 1000 - status.lastBlockTimestamp)) : null;
      const parts = [`height ${height}`, `${status.peers ?? 0} peer${status.peers === 1 ? '' : 's'}`];
      if (age !== null) parts.push(`last block ${age}s ago`);
      if (status.syncing) add('node', 'Node', 'warn', `syncing: ${parts.join(' \u00b7 ')}`);
      else if (age !== null && age > staleAfterSeconds(5)) add('node', 'Node', 'warn', `stale: ${parts.join(' \u00b7 ')} \u2014 no new block for a while`);
      else add('node', 'Node', 'ok', parts.join(' \u00b7 '));
    }
  } catch (error) {
    fail('node', 'Node', error);
  }

  try {
    const network = await getJson(origin, '/api/rpc?path=' + encodeURIComponent('/network'), opts);
    if (!status) add('consistency', 'Genesis agreement', 'skipped', 'Not checked: the node\u2019s status was unavailable.');
    else if (network.genesisId !== status.genesisId) add('consistency', 'Genesis agreement', 'fail', 'The node reports two different genesis ids.');
    else add('consistency', 'Genesis agreement', 'ok', `genesis ${String(network.genesisId).slice(0, 12)}\u2026 \u00b7 protocol ${String(network.protocolVersion)}`);
  } catch (error) {
    fail('consistency', 'Genesis agreement', error);
  }
  return steps;
}
