/**
 * Storage safety: logs that must not lose data silently, stale temp files, and
 * the data-directory lock.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appendLinesSync, atomicWriteFile, fsyncDir, readJsonLines } from '../../src/storage/atomic.js';
import { BlockStore } from '../../src/storage/blockstore.js';
import { ChainManager } from '../../src/blockchain/chain.js';
import { parseState, stringifyState } from '../../src/storage/json.js';
import { sha256Hex, utf8 } from '../../src/crypto/hash.js';
import { acquireDataDirLock } from '../../src/storage/lock.js';
import { createHarness } from '../helpers/harness.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'obs-storage-'));
}

describe('append-only logs', () => {
  it('appends several records with one call and keeps their order', () => {
    const dir = tmp();
    const path = join(dir, 'log.jsonl');
    appendLinesSync(path, ['{"n":1}', '{"n":2}']);
    appendLinesSync(path, ['{"n":3}']);
    expect(readJsonLines<{ n: number }>(path).map((row) => row.n)).toEqual([1, 2, 3]);
  });

  it('drops a torn FINAL line (the expected result of a crash)', () => {
    const path = join(tmp(), 'log.jsonl');
    writeFileSync(path, '{"n":1}\n{"n":2}\n{"n":3');
    expect(readJsonLines<{ n: number }>(path, { strict: true }).map((row) => row.n)).toEqual([1, 2]);
  });

  it('refuses to silently discard valid records that follow a corrupt line', () => {
    const path = join(tmp(), 'log.jsonl');
    writeFileSync(path, '{"n":1}\nGARBAGE\n{"n":3}\n');
    expect(() => readJsonLines(path, { strict: true })).toThrow(/corrupt and valid records follow/);
    // The lenient reader (used for caches) still stops at the first bad line.
    expect(readJsonLines<{ n: number }>(path).map((row) => row.n)).toEqual([1]);
  });

  it('keeps the previous atomic file when opening the replacement temp file fails', () => {
    const dir = tmp();
    const path = join(dir, 'metadata.json');
    writeFileSync(path, 'old');
    const now = 1_700_000_000_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      // atomicWriteFile uses this exact private name. Making it a directory
      // injects an EISDIR failure before any byte of the target can be changed.
      mkdirSync(`${path}.tmp-${process.pid}-${now}`);
      expect(() => atomicWriteFile(path, 'new')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe('old');
    } finally {
      clock.mockRestore();
    }
  });

  it('does not publish or leak a temp file when atomic rename fails', () => {
    const dir = tmp();
    const path = join(dir, 'metadata.json');
    mkdirSync(path); // renaming a regular file over a directory must fail
    const now = 1_700_000_000_001;
    const temp = `${path}.tmp-${process.pid}-${now}`;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      expect(() => atomicWriteFile(path, 'new')).toThrow();
      expect(statSync(path).isDirectory()).toBe(true);
      expect(existsSync(temp)).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('propagates directory fsync durability failures and still closes the descriptor', () => {
    let closed = false;
    const failure = Object.assign(new Error('disk I/O error'), { code: 'EIO' });
    expect(() =>
      fsyncDir('/injected', {
        open: () => 42,
        sync: () => {
          throw failure;
        },
        close: (fd) => {
          expect(fd).toBe(42);
          closed = true;
        },
      }),
    ).toThrow(failure);
    expect(closed).toBe(true);
  });
});

describe('block store', () => {
  it('refuses a chain log with a hole in it instead of loading a broken chain', async () => {
    const h = await createHarness();
    try {
      h.produce();
      h.produce();
      const path = join(h.dir, 'chain', 'canonical.jsonl');
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      writeFileSync(path, `${[lines[0], lines[2]].join('\n')}\n`); // heights 0 and 2: height 1 is missing
      expect(() => new BlockStore(h.dir)).toThrow(/not contiguous/);
    } finally {
      h.close();
    }
  });

  it('refuses an index with a corrupt line in the middle', async () => {
    const h = await createHarness();
    try {
      h.produce();
      h.produce();
      const path = join(h.dir, 'chain', 'index.jsonl');
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      writeFileSync(path, `${[lines[0], 'NOT JSON', lines[1], lines[2]].join('\n')}\n`);
      expect(() => new BlockStore(h.dir)).toThrow(/corrupt and valid records follow/);
    } finally {
      h.close();
    }
  });

  it('cross-checks index metadata against canonical block bytes at startup', async () => {
    const h = await createHarness();
    try {
      h.produce();
      const path = join(h.dir, 'chain', 'index.jsonl');
      const lines = readFileSync(path, 'utf8').trim().split('\n');
      const entry = JSON.parse(lines[1]!);
      entry.txCount += 1;
      lines[1] = JSON.stringify(entry);
      writeFileSync(path, `${lines.join('\n')}\n`);
      expect(() => new BlockStore(h.dir)).toThrow(/metadata does not match encoded block/);
    } finally {
      h.close();
    }
  });

  it('ignores a checksummed checkpoint whose state no longer matches its block root', async () => {
    const h = await createHarness();
    try {
      h.produce();
      const checkpointPath = join(h.dir, 'state', 'checkpoint-0.json');
      const snapshot = parseState<any>(readFileSync(checkpointPath, 'utf8'));
      snapshot.timestamp += 123;
      const altered = stringifyState(snapshot);
      writeFileSync(checkpointPath, `${altered}\n`);

      // Model a parseable attacker/corruption that also rewrote the file checksum:
      // identity and block state-root verification must still reject it.
      const indexPath = join(h.dir, 'state', 'checkpoints.json');
      const index = JSON.parse(readFileSync(indexPath, 'utf8'));
      index.checkpoints[0].checksum = sha256Hex(utf8(altered));
      writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);

      const recovered = new ChainManager({
        dataDir: h.dir,
        net: h.net,
        genesisDocument: h.chain.genesisDocument,
        enforceProposerRotation: true,
      });
      await recovered.init();
      expect(recovered.height).toBe(h.chain.height);
      expect(recovered.stateRoot).toBe(h.chain.stateRoot);
      expect(recovered.verifyIntegrity()).toEqual({
        ok: false,
        problems: ['checkpoint 0 does not reproduce its block state root'],
      });
    } finally {
      h.close();
    }
  });

  it('falls back to replay when a checkpoint checksum fails', async () => {
    const h = await createHarness();
    try {
      h.produce();
      const checkpointPath = join(h.dir, 'state', 'checkpoint-0.json');
      const body = readFileSync(checkpointPath, 'utf8');
      writeFileSync(checkpointPath, body.replace('\"height\":0', '\"height\":9'));
      const recovered = new ChainManager({
        dataDir: h.dir,
        net: h.net,
        genesisDocument: h.chain.genesisDocument,
        enforceProposerRotation: true,
      });
      await recovered.init();
      expect(recovered.height).toBe(h.chain.height);
      expect(recovered.stateRoot).toBe(h.chain.stateRoot);
      expect(recovered.verifyIntegrity().problems).toContain('checkpoint 0 failed parsing or checksum verification');
    } finally {
      h.close();
    }
  });

  it('tracks stored bytes without scanning the index, and survives a reload', async () => {
    const h = await createHarness();
    try {
      h.produce();
      h.produce();
      const live = h.chain.store.diskUsageBytes();
      expect(live).toBeGreaterThan(0);
      expect(new BlockStore(h.dir).diskUsageBytes()).toBe(live);
    } finally {
      h.close();
    }
  });

  it('removes temp files a crash left behind, but never one that is fresh', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'chain', 'blocks'), { recursive: true });
    const stale = join(dir, 'chain', 'blocks', '1-abc.blk.tmp-111-222');
    const fresh = join(dir, 'chain', 'blocks', '2-def.blk.tmp-333-444');
    writeFileSync(stale, 'x');
    writeFileSync(fresh, 'y');
    const hourAgo = (Date.now() - 3_600_000) / 1000;
    utimesSync(stale, hourAgo, hourAgo);
    new BlockStore(dir);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('data directory lock', () => {
  it('lets a process take the lock, and a second attempt in the same process is not a conflict', () => {
    const dir = tmp();
    const first = acquireDataDirLock(dir);
    expect(readFileSync(first.path, 'utf8').trim()).toBe(String(process.pid));
    const again = acquireDataDirLock(dir);
    again.release(); // the non-owning handle must not remove the owner's lock
    expect(existsSync(first.path)).toBe(true);
    first.release();
    expect(existsSync(first.path)).toBe(false);
  });

  it('refuses a directory that another LIVE process holds', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'LOCK'), '1\n'); // pid 1 is always alive
    expect(() => acquireDataDirLock(dir)).toThrow(/in use by another Obsidian process \(pid 1\)/);
  });

  it('takes over a lock whose owner is gone (a crash must never need manual cleanup)', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'LOCK'), '2147483646\n'); // a pid that does not exist
    const lock = acquireDataDirLock(dir);
    expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid));
    lock.release();
  });
});

describe('data directory lock under contention (separate processes)', () => {
  // Regression: a stale lock used to be deleted by every starter that had read it, so each then created its own
  // and two processes ran on one chain directory (reproduced 10/10 trials with 12 simultaneous starters).
  it('lets exactly one of many simultaneous starters take over a stale lock', async () => {
    const { spawn } = await import('node:child_process');
    const ts = await import('typescript');
    const work = mkdtempSync(join(tmpdir(), 'obs-lock-race-'));
    try {
      // Compile the real lock module, unchanged, so the children run the code under test and need no build step.
      const source = readFileSync(new URL('../../src/storage/lock.ts', import.meta.url), 'utf8');
      const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
      writeFileSync(join(work, 'lock.mjs'), js);
      writeFileSync(
        join(work, 'child.mjs'),
        `import { acquireDataDirLock } from './lock.mjs';
const [dir, startAt] = [process.argv[2], Number(process.argv[3])];
while (Date.now() < startAt) {}
try { const l = acquireDataDirLock(dir); process.stdout.write('OK\\n'); await new Promise((r) => setTimeout(r, 900)); l.release(); }
catch { process.stdout.write('REFUSED\\n'); }
`,
      );
      for (let trial = 0; trial < 3; trial += 1) {
        const dir = join(work, `data${trial}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'LOCK'), '999999\n'); // a pid nobody owns
        const startAt = Date.now() + 800;
        const outcomes = await Promise.all(
          Array.from({ length: 8 }, () =>
            new Promise<string>((resolve) => {
              const child = spawn(process.execPath, [join(work, 'child.mjs'), dir, String(startAt)]);
              let out = '';
              child.stdout.on('data', (d) => (out += d));
              child.on('close', () => resolve(out.trim()));
            }),
          ),
        );
        expect(outcomes.filter((o) => o === 'OK')).toHaveLength(1);
        expect(outcomes.filter((o) => o === 'REFUSED')).toHaveLength(7);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 60_000);

  it('does not take over a lock whose owner has created the file but not yet written its pid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obs-lock-new-'));
    try {
      writeFileSync(join(dir, 'LOCK'), ''); // brand new and empty: its owner is mid-creation
      const started = Date.now();
      // Nobody ever fills it in, so after the grace period it is garbage and is taken over, but not before.
      const lock = acquireDataDirLock(dir);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
      expect(readFileSync(lock.path, 'utf8').trim()).toBe(String(process.pid));
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
