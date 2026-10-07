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
  try {
    const fd = openSync(tmp, 'w', 0o600);
    try {
      const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
      let offset = 0;
      while (offset < buffer.length) {
        const written = writeSync(fd, buffer, offset, buffer.length - offset);
        if (written <= 0) throw new Error(`write made no progress for ${path}`);
        offset += written;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (error) {
    // A failed write/fsync/rename must not accumulate unbounded temp files.
    // If opening itself failed because the path was maliciously a directory,
    // unlink intentionally does nothing and the original error still wins.
    removeIfExists(tmp);
    throw error;
  }
  fsyncDir(dirname(path));
}

export function appendLineSync(path: string, line: string): void {
  appendLinesSync(path, [line]);
}

/**
 * Append several lines with ONE write and ONE fsync. Records keep their order,
 * so a log that needs "marker, then records" (a reorg) is never observed with
 * the records but not the marker.
 */
export function appendLinesSync(path: string, lines: string[]): void {
  if (lines.length === 0) return;
  ensureDir(dirname(path));
  const fd = openSync(path, 'a', 0o600);
  try {
    const buffer = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
    let offset = 0;
    while (offset < buffer.length) {
      const written = writeSync(fd, buffer, offset, buffer.length - offset);
      if (written <= 0) throw new Error(`append made no progress for ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

interface DirectorySyncOperations {
  open(path: string): number;
  sync(fd: number): void;
  close(fd: number): void;
}

const DIRECTORY_SYNC_OPERATIONS: DirectorySyncOperations = {
  open: (path) => openSync(path, 'r'),
  sync: (fd) => fsyncSync(fd),
  close: (fd) => closeSync(fd),
};

function directorySyncUnsupported(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  // Some filesystems and Windows do not support opening/fsyncing a directory.
  // EIO, ENOSPC, permission errors and every other durability failure must
  // propagate: acknowledging them would make an atomic rename look durable.
  return ['EINVAL', 'ENOTSUP', 'ENOSYS', 'EISDIR'].includes(String(error.code));
}

export function fsyncDir(
  path: string,
  operations: DirectorySyncOperations = DIRECTORY_SYNC_OPERATIONS,
): void {
  let fd: number;
  try {
    fd = operations.open(path);
  } catch (error) {
    if (directorySyncUnsupported(error)) return;
    throw error;
  }
  try {
    operations.sync(fd);
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    operations.close(fd);
  }
}

export function removeIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* already gone */
  }
}

export interface ReadLinesOptions {
  /**
   * Chain logs must not lose data silently. A torn FINAL line is the expected
   * result of a crash and is dropped; a malformed line that is followed by valid
   * records is real corruption, and reading past it would quietly discard the
   * rest of the chain — so strict mode throws instead.
   */
  strict?: boolean;
}

/** Read an append-only JSON-lines file defensively (a torn tail is dropped). */
export function readJsonLines<T>(path: string, options: ReadLinesOptions = {}): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const out: T[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      if (options.strict && lines.slice(index + 1).some((later) => later.trim().length > 0)) {
        throw new Error(
          `${path}: line ${index + 1} is corrupt and valid records follow it. ` +
            'Refusing to start rather than silently discard the rest of the log; restore the data directory from a backup or re-sync.',
        );
      }
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
