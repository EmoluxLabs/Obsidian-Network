import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPaths } from '../core/paths.js';
import { SettingsStore } from '../core/settings.js';
import { LogBuffer } from '../core/log-buffer.js';
import { loadCore } from '../core/core-loader.js';
import { NodeSupervisor } from '../core/node-supervisor.js';

export function tempDir(prefix = 'obsnode-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const hostScript = join(dirname(fileURLToPath(import.meta.url)), '..', 'main', 'node-host.js');

/** A supervisor on a disposable data directory with ports offset away from any real node. */
export function makeSupervisor(base: string, offset: number, network: 'devnet' | 'testnet' = 'devnet') {
  const paths = createPaths(base);
  const settings = new SettingsStore(paths.settings);
  const current = settings.get();
  settings.update({
    network,
    node: { network, values: { ...current.nodes[network], portOffset: offset, blockProduction: true } },
  });
  const logs = new LogBuffer(2000);
  const supervisor = new NodeSupervisor({
    paths,
    settings,
    logs,
    core: () => loadCore(),
    hostScript,
    readyTimeoutMs: 60_000,
    stopTimeoutMs: 30_000,
  });
  return { paths, settings, logs, supervisor };
}

/**
 * The first port offset (from `preferred`, in steps of 10) whose RPC and P2P ports are both free right now.
 * Devnet's default ports sit inside the OS's ephemeral range, so a fixed offset can collide with an
 * unrelated outgoing connection.
 */
export async function freeOffset(preferred: number, base = 38630): Promise<number> {
  const { createServer } = await import('node:net');
  const free = (port: number): Promise<boolean> =>
    new Promise((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
    });
  for (let offset = preferred; offset <= 100; offset += 10) {
    if ((await free(base + offset)) && (await free(base + offset + 1))) return offset;
  }
  throw new Error('no free port offset found');
}
