import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Write a file so a crash leaves either the old content or the new, never half of it. */
export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, mode);
  } catch {
    /* platforms without POSIX modes */
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
