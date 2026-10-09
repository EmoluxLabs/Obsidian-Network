/**
 * Claim-time notifications.
 *
 * The one thing this app is genuinely for: telling someone when the protocol says
 * they may claim again, so they do not have to keep the tab open.
 *
 * It uses the Notification API directly rather than a background service worker,
 * and that choice is deliberate. A service worker can be throttled or stopped by the
 * browser at any time, and there is no honest way to promise a user that a notification
 * will fire at an exact moment from a page they have closed. This module is clear
 * about what it can and cannot guarantee:
 *
 *   - While the page is open, it checks the protocol's own eligibility and notifies.
 *   - It never computes eligibility itself. It asks the node. The browser's clock is
 *     used only to decide when to ask again, never to decide whether a claim is due —
 *     which is exactly the mistake the design file's session timer made.
 *   - It says plainly, in the UI that enables it, that closing the tab stops it.
 */

import { getMiningStatus } from './data.mjs';

const STATE_KEY = 'obsidian.notify';

/** How often to re-ask the protocol. Not how often to fire: the node decides that. */
const POLL_MS = 60_000;

let timer = null;
let lastNotifiedAt = 0;

/**
 * A host that can watch while no page is open (the browser extension's service worker) takes over
 * the whole feature: `ObsidianHost.notify = { permission, enable, disable, resume, note }`. It still
 * asks the node whether a claim is allowed; it never decides that itself.
 */
const host = () => globalThis.ObsidianHost?.notify ?? null;

/** What the user is told after turning alerts on, so the words match what actually happens. */
export function limitNote() {
  return (
    host()?.note ??
    'Claim alerts are on while this tab is open. Closing the tab stops them.'
  );
}

export function isSupported() {
  return host() ? true : typeof Notification !== 'undefined';
}

export function permission() {
  if (host()) return host().permission();
  return isSupported() ? Notification.permission : 'unsupported';
}

export function isEnabled() {
  try {
    return localStorage.getItem(STATE_KEY) === 'on';
  } catch {
    return false;
  }
}

/**
 * Ask for permission and start watching.
 *
 * Returns a string describing what happened, because the outcomes are genuinely
 * different and the user should know which one they got: granted, denied, already
 * blocked, or unavailable in this browser.
 */
export async function enable(address) {
  if (host()) return host().enable(address);
  if (!isSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') {
    const result = await Notification.requestPermission();
    if (result !== 'granted') return result === 'denied' ? 'denied' : 'prompt';
  }
  try {
    localStorage.setItem(STATE_KEY, 'on');
  } catch {
    // Private mode can refuse storage. Notifications still work for this session;
    // they just will not resume on reload, and that is worth knowing.
  }
  start(address);
  return 'granted';
}

export function disable() {
  if (host()) return host().disable();
  try {
    localStorage.removeItem(STATE_KEY);
  } catch {
    /* nothing to undo */
  }
  stop();
}

export function start(address) {
  stop();
  if (!address) return;
  tick(address);
  timer = setInterval(() => tick(address), POLL_MS);
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

/**
 * One check.
 *
 * The node's answer is the only authority here. `eligible` comes from protocol state
 * and the including block's timestamp; this module's clock is used solely to space out
 * requests. If the node cannot be reached, nothing is notified — a missed notification
 * is recoverable, a false "you may claim now" is not.
 */
export async function tick(address) {
  if (!address || permission() !== 'granted') return null;
  let eligibility;
  try {
    eligibility = await getMiningStatus(address);
  } catch {
    return null;
  }
  if (!eligibility?.eligible) return eligibility;

  // One notification per eligibility window. Without this, an eligible wallet that
  // stays open would be nagged every poll for as long as it remained unclaimed.
  const windowStart = Number(eligibility.nextEligibleAt || 0);
  if (windowStart && windowStart === lastNotifiedAt) return eligibility;
  lastNotifiedAt = windowStart;

  try {
    const notification = new Notification('Obsidian claim available', {
      body: 'The protocol says this wallet may claim now.',
      tag: 'obsidian-claim',
      // The user's own decision, not the app's: do not assume a sound is wanted.
      silent: false,
    });
    notification.onclick = () => {
      globalThis.focus?.();
      notification.close();
    };
  } catch {
    // Some browsers refuse to construct a Notification outside a user gesture, or
    // require a service worker registration. Failing silently here is right: the
    // screen still shows the same eligibility, so nothing is lost.
  }
  return eligibility;
}

/**
 * Resume watching on load if the user turned it on before.
 *
 * Needs an address, which means a session, so this is called by the app once the
 * account is known rather than on import.
 */
export function resume(address) {
  if (host()) return host().resume(address);
  if (isEnabled() && permission() === 'granted') start(address);
}
