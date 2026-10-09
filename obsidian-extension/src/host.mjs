/**
 * The extension's side of the `ObsidianHost` contract that obsidian-app-web's modules look for
 * (data.mjs for the server address, screens.mjs for Menu rows, notify.mjs for claim alerts, real.mjs for
 * the wallet address). On the web none of this exists and the app talks to its own origin; here it is the
 * seam between "an app written for a page on a server" and "an extension page".
 *
 * It is a transport and a place to keep settings. It holds no wallet secret, makes no protocol decision
 * and has no data of its own: every figure on screen is still the server's.
 */
import { NETWORKS, ServerError, loadSettings, saveSettings } from './config.mjs';

export const REQUEST_TIMEOUT_MS = 15000;

/**
 * @param {object} api       `browser` / `chrome`
 * @param {object} settings  sanitised settings, already loaded
 */
export function createHost(api, settings) {
  let alertsLevel = 'granted';

  const host = {
    settings,
    ready: Promise.resolve(),
    timeoutMs: REQUEST_TIMEOUT_MS,

    /** The one place a request address is decided. Throws, and sends nothing, when none is configured. */
    apiBase() {
      if (!settings.serverUrl) throw new ServerError('not-configured', 'No Obsidian server is configured.');
      return settings.serverUrl;
    },

    menu: [
      { label: 'NODE', go: 'node' },
      { label: 'CONNECTION', call: 'ObsidianExtConnection' },
      { label: 'OPEN IN A TAB', call: 'ObsidianExtTab' },
    ],

    /**
     * Keep the service worker's copy of the public address current, but only while claim alerts are on: the
     * address is public, yet there is no reason to copy it anywhere nothing needs it. Nothing else is stored.
     */
    walletAddress(address) {
      if (!settings.alerts) return;
      const clean = typeof address === 'string' && address.startsWith(`${NETWORKS[settings.network]?.addressHrp}1`) ? address : null;
      if (clean === settings.address) return;
      settings.address = clean;
      saveSettings(api.storage.local, { address: clean }).catch((error) => console.error('[obsidian] could not save the address:', error?.message ?? error));
    },

    notify: {
      note:
        'Claim alerts are on. While your browser is open the extension asks the node about once a minute and tells you when a claim is open, even with this window closed. It only tells you: claiming still needs you.',
      permission() {
        if (!api.notifications) return 'unsupported';
        if (alertsLevel === 'denied') return 'denied';
        return settings.alerts && settings.address ? 'granted' : 'default';
      },
      async enable(address) {
        if (!api.notifications) return 'unsupported';
        // Firefox has no permission-level query; there the OS decides when a notification is shown.
        if (typeof api.notifications.getPermissionLevel === 'function') {
          alertsLevel = await new Promise((resolve) => api.notifications.getPermissionLevel(resolve));
        }
        if (alertsLevel === 'denied') return 'denied';
        const clean = typeof address === 'string' && address.startsWith(`${NETWORKS[settings.network]?.addressHrp}1`) ? address : null;
        if (!clean) return 'unsupported';
        settings.alerts = true;
        settings.address = clean;
        await saveSettings(api.storage.local, { alerts: true, address: clean });
        return 'granted';
      },
      disable() {
        settings.alerts = false;
        settings.address = null;
        saveSettings(api.storage.local, { alerts: false, address: null }).catch(() => {});
      },
      resume(address) {
        if (settings.alerts) host.walletAddress(address);
      },
      setLevel(level) {
        alertsLevel = level;
      },
    },
  };
  return host;
}

export { loadSettings };
