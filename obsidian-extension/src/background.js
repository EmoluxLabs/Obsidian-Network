/*
 * Service worker (MV3). Holds no state in memory that matters: it can be stopped at any moment and is
 * woken by the alarm, so everything it needs is read from storage each time it runs.
 *
 * It does exactly one job: while claim alerts are on, ask the node once a minute whether this wallet may claim
 * (claim-watch.mjs) and tell the user if so. It never claims, signs or touches a key — the extension keeps no
 * key outside the wallet vault in the popup, which is encrypted under the user's passphrase.
 */
import { SETTINGS_KEY, loadSettings } from './config.mjs';
import { evaluateClaim, BADGE } from './claim-watch.mjs';

const api = globalThis.browser ?? globalThis.chrome;
const ALARM = 'obsidian-claim-watch';
const NOTIFIED_KEY = 'obsidian.lastNotified';

async function syncAlarm() {
  const settings = await loadSettings(api.storage.local);
  const wanted = settings.alerts && settings.serverUrl && settings.address;
  const existing = await api.alarms.get(ALARM);
  if (wanted && !existing) api.alarms.create(ALARM, { delayInMinutes: 0.1, periodInMinutes: 1 });
  if (!wanted && existing) await api.alarms.clear(ALARM);
  if (!wanted) await setBadge(null);
}

async function setBadge(state) {
  const badge = BADGE[state];
  await api.action.setBadgeText({ text: badge ? badge.text : '' });
  if (badge) await api.action.setBadgeBackgroundColor({ color: badge.colour });
}

export async function check() {
  const settings = await loadSettings(api.storage.local);
  const stored = await api.storage.local.get(NOTIFIED_KEY);
  const result = await evaluateClaim(settings, { lastNotified: stored[NOTIFIED_KEY] ?? null });
  await setBadge(result.state);
  if (result.notify) {
    // Record first: a failure to show must not turn into a notification every minute.
    await api.storage.local.set({ [NOTIFIED_KEY]: result.windowKey });
    api.notifications.create('obsidian-claim', {
      type: 'basic',
      iconUrl: api.runtime.getURL('icons/icon128.png'),
      title: 'Obsidian: a claim is open',
      message: 'The node says you can claim now. Open Obsidian to claim.',
    });
  }
  return result;
}

api.runtime.onInstalled.addListener(syncAlarm);
api.runtime.onStartup.addListener(syncAlarm);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) syncAlarm().then(() => changes[SETTINGS_KEY].newValue?.alerts && check()).catch(() => {});
});
api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) check().catch((error) => console.error('[obsidian] claim check failed:', error?.message ?? error));
});

/**
 * Messages. Only this extension's own pages may send them, and only these shapes are acted on. The design file
 * announces `{ t: 'sync' }` from its demo; that is ignored on purpose.
 */
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== api.runtime.id) return false;
  if (!message || typeof message !== 'object' || message.type !== 'obsidian.check-now') return false;
  check().then(
    (result) => sendResponse({ ok: true, state: result.state }),
    () => sendResponse({ ok: false }),
  );
  return true; // answered asynchronously
});
