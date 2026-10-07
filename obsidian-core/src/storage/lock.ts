/**
 * Data-directory lock.
 *
 * Two processes writing one chain directory corrupt it: interleaved appends to
 * the block index, two writers fighting over the canonical log, a second node
 * "recovering" files the first one is in the middle of writing. The classic
 * way to get there is innocent — a systemd service is already running and an
 * operator starts `obsidian-core` by hand "just to check", or runs `validate`
 * against a live node. This lock makes that a refusal with a clear message
 * instead of a damaged chain.
 *
 * The lock is a file holding the owner's pid, created exclusively. A lock whose
 * owner no longer exists (a crash, a power cut, `kill -9`) is stale and is
 * taken over, so a node never needs manual cleanup to restart.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface DataDirLock {
  readonly path: string;
  release(): void;
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else: still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function acquireDataDirLock(dataDir: string): DataDirLock {
  const path = join(dataDir, 'LOCK');
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try {
          if (Number.parseInt(readFileSync(path, 'utf8'), 10) === process.pid) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
      process.once('exit', release);
      return { path, release };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(readFileSync(path, 'utf8'), 10);
      } catch {
        /* the owner released it between our two calls: try again */
      }
      if (owner === process.pid) {
        // This process already holds it (a second ChainManager in one process,
        // as the test suite does). Not a conflict.
        return { path, release: () => undefined };
      }
      if (Number.isFinite(owner) && processIsAlive(owner)) {
        throw new Error(
          `data directory ${dataDir} is in use by another Obsidian process (pid ${owner}). ` +
            'Stop it first — two processes on one chain directory corrupt it. ' +
            `If you are certain no node is running, delete ${path}.`,
        );
      }
      try {
        unlinkSync(path); // stale: the owner is gone
      } catch {
        /* someone else removed it first */
      }
    }
  }
  throw new Error(`could not acquire the data directory lock at ${path}`);
}
