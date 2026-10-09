/**
 * The four Obsidian networks, as far as the app server needs to know them, and the
 * check that the platform behind it is on the network this deployment says it is.
 *
 * Kept separate from obsidian-core on purpose, as obsidian-interface/server/networks.ts
 * is: this process talks to a platform over HTTP and must not import a node.
 * tests/networks.test.mjs asserts this table equals core's own NETWORKS (and the
 * platform's INTERFACE_NETWORKS), so the three cannot drift apart silently.
 *
 * A deployment of this app serves exactly one network. It is TOLD which, with no
 * default, and it refuses to run in front of a platform that follows another. A
 * testnet app that quietly signs mainnet transactions — or a mainnet app that shows
 * a devnet chain — is the failure this exists to make impossible.
 */

export const NETWORK_NAMES = ['mainnet', 'testnet', 'staging', 'devnet'];

/**
 * `appPort` follows the node's own scheme (8630 / 18630 / 28630 / 38630) applied to
 * 8790, so the four apps and the four platforms (8788…) can share one host.
 */
export const NETWORKS = Object.freeze({
  mainnet: { name: 'mainnet', networkId: 'obsidian-mainnet-1', chainId: 7777, addressHrp: 'obs', appPort: 8790, production: true },
  testnet: { name: 'testnet', networkId: 'obsidian-testnet-1', chainId: 7778, addressHrp: 'tobs', appPort: 18790, production: false },
  staging: { name: 'staging', networkId: 'obsidian-staging-1', chainId: 7779, addressHrp: 'sobs', appPort: 28790, production: false },
  devnet: { name: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', appPort: 38790, production: false },
});

/** The definition for a network name, or a thrown error that lists the valid ones. */
export function networkFor(name) {
  const found = NETWORKS[String(name ?? '').toLowerCase()];
  if (!found) {
    throw new Error(
      `unknown network "${name ?? ''}" (expected one of: ${NETWORK_NAMES.join(', ')})`,
    );
  }
  return found;
}

/**
 * What the browser is told about its own deployment. Everything in it is public and
 * is derived from the table above, never from the platform: the app's identity must
 * not be something the thing it is checking gets to decide.
 */
export function publicConfig(network, verification) {
  return {
    network: network.name,
    networkId: network.networkId,
    chainId: network.chainId,
    addressHrp: network.addressHrp,
    production: network.production,
    verified: verification.state === 'ok',
    verification: verification.state,
  };
}

/**
 * Compare what the platform reports with what this deployment expects.
 *
 * `observed` carries whatever the platform volunteered: `authNetwork` from
 * /api/auth/config, and `node` — the `network` object of the node's /network route
 * that the platform proxies. Fields the platform does not report are skipped, not
 * guessed; fields it reports and gets wrong are mismatches. At least one field must
 * have been checked, or the answer is "unverified" rather than "ok".
 */
export function compareNetwork(expected, observed) {
  const problems = [];
  let checked = 0;

  const check = (label, actual, wanted) => {
    if (actual === undefined || actual === null || actual === '') return;
    checked += 1;
    if (String(actual).toLowerCase() !== String(wanted).toLowerCase()) {
      problems.push(`${label} is ${actual}, expected ${wanted}`);
    }
  };

  check('platform network', observed.authNetwork, expected.name);
  check('node network', observed.node?.name, expected.name);
  check('node network id', observed.node?.networkId, expected.networkId);
  check('node chain id', observed.node?.chainId, expected.chainId);
  check('node address prefix', observed.node?.addressHrp, expected.addressHrp);

  if (problems.length > 0) return { state: 'mismatch', detail: problems.join('; ') };
  if (checked === 0) return { state: 'unverified', detail: 'the platform reported no network information' };
  return { state: 'ok', detail: `${checked} fields match ${expected.name}` };
}

/**
 * Ask the platform which network it is on, and compare.
 *
 * Returns `unreachable` — not `mismatch` — when it cannot be asked at all. A platform
 * that is briefly down is an outage, and refusing to start (or blocking the API) over
 * an outage would turn a restart of one service into an outage of two. A platform that
 * answers with the WRONG network is different, and is never tolerated.
 */
export async function verifyPlatform(platformUrl, expected, fetchImpl = fetch, timeoutMs = 5000) {
  const base = platformUrl.replace(/\/$/, '');
  const get = async (path) => {
    const response = await fetchImpl(base + path, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${path}`);
    return response.json();
  };

  const observed = {};
  let answered = false;
  let lastError = null;

  try {
    const config = await get('/api/auth/config');
    observed.authNetwork = config?.network ?? undefined;
    answered = true;
  } catch (error) {
    lastError = error;
  }
  try {
    const body = await get(`/api/rpc?path=${encodeURIComponent('/network')}`);
    observed.node = body?.network ?? undefined;
    answered = true;
  } catch (error) {
    lastError = error;
  }

  if (!answered) {
    return {
      state: 'unreachable',
      detail: lastError instanceof Error ? lastError.message : String(lastError),
    };
  }
  return compareNetwork(expected, observed);
}
