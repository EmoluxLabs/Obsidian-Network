/**
 * Is the browser bundle the server hands out the one built from the sources on disk?
 *
 * `npm run build:web` writes `public/js/build.json` with a fingerprint of `web/src`. The server compares it with the
 * fingerprint of `web/src` as it is now. A mismatch means someone updated the code and restarted without rebuilding, so
 * visitors get an old page talking to a new server. The server says so at start and in `/api/health` (`webBundle`).
 * It does not refuse to start: a stale page is better than no page, and the fix is one command.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export type WebBundleState = 'current' | 'stale' | 'missing' | 'unchecked';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Same algorithm as scripts/web-fingerprint.mjs. */
export function webFingerprint(webSrcDir: string): string {
  const hash = createHash('sha256');
  for (const file of walk(webSrcDir)) {
    hash.update(`${relative(webSrcDir, file).split(sep).join('/')}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}

const memo = new Map<string, { at: number; value: { state: WebBundleState; detail: string } }>();

/** Cached for a minute: /api/health is polled by load balancers and the check reads every source file. */
export function checkWebBundle(publicDir: string, now = Date.now()): { state: WebBundleState; detail: string } {
  const hit = memo.get(publicDir);
  if (hit && now - hit.at < 60_000) return hit.value;
  const value = checkWebBundleNow(publicDir);
  memo.set(publicDir, { at: now, value });
  return value;
}

function checkWebBundleNow(publicDir: string): { state: WebBundleState; detail: string } {
  const stamp = join(publicDir, 'js', 'build.json');
  const sources = resolve(publicDir, '..', 'web', 'src');
  // A deployment that ships only the built output has no sources to compare with: nothing to say.
  if (!existsSync(sources)) return { state: 'unchecked', detail: 'no web/src next to the public directory to compare with' };
  if (!existsSync(stamp)) {
    return { state: 'missing', detail: 'public/js has no build.json: the bundles were built before this check existed or not at all. Run: npm run build' };
  }
  let built: unknown;
  try {
    built = (JSON.parse(readFileSync(stamp, 'utf8')) as { fingerprint?: unknown }).fingerprint;
  } catch {
    return { state: 'stale', detail: 'public/js/build.json cannot be read. Run: npm run build' };
  }
  return built === webFingerprint(sources)
    ? { state: 'current', detail: 'the bundles match web/src' }
    : { state: 'stale', detail: 'the bundles in public/js were built from older sources than web/src. Run: npm run build' };
}
