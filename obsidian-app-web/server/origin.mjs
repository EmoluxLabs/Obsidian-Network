/**
 * Which browser requests may use the app's API. See the comment above the call in main.mjs for why this lives at
 * the app server: the proxy drops `Origin` before the platform sees it, so this is the last place it can be checked.
 */

const EXTENSION_ORIGIN = /^(?:chrome|moz|safari-web)-extension:\/\/[a-z0-9._-]{1,64}$/i;

/** `APP_ALLOWED_ORIGINS`: exact origins only (`https://wallet.example.org`), comma separated. No wildcards. */
export function parseAllowedOrigins(value) {
  const out = new Set();
  for (const raw of String(value ?? '').split(',')) {
    const text = raw.trim().replace(/\/$/, '');
    if (!text) continue;
    let url;
    try { url = new URL(text); } catch { throw new Error(`APP_ALLOWED_ORIGINS: "${text}" is not an origin`); }
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' || url.search || url.hash || url.username || text.includes('*')) {
      throw new Error(`APP_ALLOWED_ORIGINS: "${text}" must be an exact origin like https://wallet.example.org`);
    }
    out.add(url.origin);
  }
  return out;
}

/**
 * @param {Record<string, string | string[] | undefined>} headers  Node's lower-cased request headers
 * @param {Set<string>} [allowed]
 */
export function originAllowed(headers, allowed = new Set()) {
  const origin = headers.origin;
  const site = headers['sec-fetch-site'];
  // No Origin: not a browser form or fetch (curl, a server, a native app). A cross-site browser request cannot
  // hide it, but if one did, Sec-Fetch-Site would say so.
  if (origin === undefined) return site === undefined || site === 'same-origin' || site === 'none';
  if (typeof origin !== 'string' || origin === 'null') return false;
  if (EXTENSION_ORIGIN.test(origin)) return true;
  if (allowed.has(origin)) return true;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.origin !== origin.toLowerCase()) return false;
  const host = headers.host;
  return typeof host === 'string' && parsed.host.toLowerCase() === host.toLowerCase();
}
