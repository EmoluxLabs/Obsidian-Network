/**
 * Node-only hashing helpers for large artifacts (release checksums, backups,
 * verification of downloaded archives). Kept out of `crypto/hash.ts` so that
 * module stays usable in a browser bundle.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { toHex } from '../crypto/hash.js';

export function sha256FileStream(): import('node:crypto').Hash {
  return createHash('sha256');
}

/** Stream a file through SHA-256 and return the hex digest. */
export async function sha256File(path: string): Promise<string> {
  const hash = sha256FileStream();
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve());
  });
  return toHex(hash.digest());
}

/** `sha256sum`-compatible line for a file: `<hex>  <name>`. */
export async function checksumLine(path: string, name?: string): Promise<string> {
  const digest = await sha256File(path);
  const label = name ?? path.split('/').pop() ?? path;
  return `${digest}  ${label}`;
}

export async function fileSize(path: string): Promise<number> {
  return (await stat(path)).size;
}
