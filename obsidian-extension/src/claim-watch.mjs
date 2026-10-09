/**
 * The service worker's decision, as a pure function of (settings, what the node says).
 *
 * This is the whole of the "claim alert" feature and it has one rule, the same one the web app's notifier
 * follows: the extension NEVER works out for itself whether a claim is open. It asks the node
 * (`/mining/status`), believes `eligible === true` only when the node says exactly that, and tells the
 * user. Eligibility is consensus's — from the account's last claim — not the wallet's, not this
 * browser's clock, and not this file's.
 *
 * Nothing here signs, submits or claims. An alert is a prompt to open the popup, where claiming needs
 * the wallet passphrase.
 */
import { NETWORKS, ServerError, checkIdentity, getJson } from './config.mjs';

/**
 * @returns {Promise<{state: string, notify: boolean, windowKey?: string, nextEligibleAt?: number, message?: string}>}
 * state: off | no-wallet | not-configured | wrong-network | unavailable | waiting | eligible
 */
export async function evaluateClaim(settings, { fetchImpl = fetch, lastNotified = null } = {}) {
  if (!settings.alerts) return { state: 'off', notify: false };
  if (!settings.serverUrl || !NETWORKS[settings.network]) return { state: 'not-configured', notify: false };
  if (!settings.address) return { state: 'no-wallet', notify: false };

  // The address must belong to the pinned network before it is sent anywhere.
  if (!settings.address.startsWith(`${NETWORKS[settings.network].addressHrp}1`)) {
    return { state: 'wrong-network', notify: false, message: 'The saved wallet address is not on the selected network.' };
  }

  try {
    const config = await getJson(settings.serverUrl, '/app-config.json', { fetchImpl });
    const verdict = checkIdentity(config, settings.network);
    if (!verdict.ok) {
      return { state: verdict.kind === 'wrong-network' ? 'wrong-network' : 'unavailable', notify: false, message: verdict.message };
    }
    const path = '/api/rpc?path=' + encodeURIComponent(`/mining/status?address=${encodeURIComponent(settings.address)}`);
    const status = await getJson(settings.serverUrl, path, { fetchImpl });
    if (typeof status.eligible !== 'boolean' || status.address !== settings.address) {
      return { state: 'unavailable', notify: false, message: 'The node\u2019s mining status was not in the expected form.' };
    }
    if (!status.eligible) {
      return {
        state: 'waiting',
        notify: false,
        // A hint for display only. The node decides when a claim is actually open.
        nextEligibleAt: Number.isFinite(status.nextEligibleAt) ? status.nextEligibleAt : undefined,
      };
    }
    // One alert per opportunity: the claim sequence moves on when a claim is accepted.
    const windowKey = `${settings.address}:${String(status.nextClaimSequence)}:${String(status.cycleStartAt)}`;
    return { state: 'eligible', notify: windowKey !== lastNotified, windowKey };
  } catch (error) {
    return { state: 'unavailable', notify: false, message: error instanceof ServerError ? error.message : 'The check failed.' };
  }
}

export const BADGE = {
  eligible: { text: '1', colour: '#1F7A55' },
  'wrong-network': { text: '!', colour: '#A12626' },
  unavailable: { text: '?', colour: '#7A6126' },
};
