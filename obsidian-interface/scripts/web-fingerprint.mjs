/**
 * A fingerprint of the browser sources (web/src), written next to the built bundles by `build:web` and re-computed by the
 * server (server/web-bundle.ts, the same algorithm). If they differ, the bundles the server is handing out were built from
 * other sources than the ones on disk: a `git pull` and a restart without `npm run build`. That mix (a new server and an
 * old page) is how a page keeps showing a figure the server no longer sends.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

export function webFingerprint(webSrcDir) {
  const hash = createHash('sha256');
  for (const file of walk(webSrcDir)) {
    hash.update(`${relative(webSrcDir, file).split(sep).join('/')}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 32);
}
