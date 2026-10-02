/**
 * Crash-safe file primitives.
 *
 * Every persistent write in Obsidian Core goes through these helpers: write to
 * a temporary file, fsync it, rename over the target, then fsync the directory.
 * A power loss can therefore leave the previous file or the new file, never a
 * truncated mixture — which is what keeps a node's chain database recoverable.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function atomicWriteFile(path: string, data: Uint8Array | string): void {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  const fd = openSync(tmp, 'w', 0o600);
  try {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    let offset = 0;
    while (offset < buffer.length) {
      offset += writeSync(fd, buffer, offset, buffer.length - offset);
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  fsyncDir(dirname(path));
}

export function appendLineSync(path: string, line: string): void {
  ensureDir(dirname(path));
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, `${line}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function fsyncDir(path: string): void {
  try {
    const fd = openSync(path, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* directory fsync is not supported everywhere; the rename is still atomic */
  }
}

export function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

/** Read an append-only JSON-lines file defensively (a torn tail is dropped). */
export function readJsonLines<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      // A partially written final line is expected after a crash; stop here.
      break;
    }
  }
  return out;
}

export function writeFileDirect(path: string, data: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, data);
}
