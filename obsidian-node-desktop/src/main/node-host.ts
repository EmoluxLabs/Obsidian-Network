/**
 * The process that runs the node.
 *
 * It is a thin launcher around Obsidian Core's own `startNode()` — the same function the
 * `obsidian-core start` command calls, with the configuration loaded by the same
 * `loadConfig()`. Nothing about the node is reimplemented here. The only reason it exists
 * instead of spawning `obsidian-core start` directly is shutdown: the CLI stops the node
 * on SIGTERM/SIGINT, which Windows cannot deliver to a child process, so this launcher
 * also accepts a `shutdown` message over the IPC channel and stops the node through the
 * same `runtime.stop()`. If the parent app disappears (the IPC channel closes) the node is
 * stopped too, so closing or crashing the app can never leave an orphaned node holding
 * the data directory.
 *
 * Specification arrives as JSON in OBSIDIAN_NODE_SPEC; the passphrase for the node
 * identity keystore arrives as a FILE path (OBSIDIAN_KEYSTORE_PASSPHRASE_FILE), never as
 * a value on the command line.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface HostSpec {
  coreDir: string;
  network: string;
  dataDir: string;
  keystorePath: string;
  nodeName: string;
  logLevel: string;
  rpcPort: number;
  p2pPort: number;
  seeds: string[];
  blockProduction: boolean;
}

interface Runtime {
  stop(): Promise<void>;
}

type Send = (message: { type: string; [key: string]: unknown }) => void;

const send: Send = (message) => {
  if (process.send && process.connected) process.send(message);
};

async function main(): Promise<void> {
  const spec = JSON.parse(process.env.OBSIDIAN_NODE_SPEC ?? '') as HostSpec;
  const load = <T>(rel: string): Promise<T> => import(pathToFileURL(join(spec.coreDir, 'dist', rel)).href) as Promise<T>;
  const { loadConfig } = await load<{ loadConfig: (o: unknown) => unknown }>('config/config.js');
  const { startNode } = await load<{ startNode: (o: unknown) => Promise<Runtime> }>('node.js');

  const overrides: Record<string, unknown> = {
    network: spec.network,
    dataDir: spec.dataDir,
    keystorePath: spec.keystorePath,
    nodeName: spec.nodeName,
    logLevel: spec.logLevel,
    // Ports are stated explicitly (network default + the user's offset). Going through a config
    // file would let its fixed ports win over the offset.
    rpcPort: spec.rpcPort,
    p2pPort: spec.p2pPort,
    rpcHost: '127.0.0.1',
    // The RPC is for this app only: no browser origin, official domain or otherwise, may read it.
    rpcTrustOfficialDomains: false,
    rpcCorsOrigins: [],
    miningEnabled: spec.blockProduction,
  };
  if (spec.seeds.length > 0) overrides.seedNodes = spec.seeds;
  const loaded = loadConfig({
    overrides,
    requireExplicitNetwork: true,
  });

  let boot: Promise<Runtime> | undefined;
  let stopping = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    send({ type: 'stopping', reason });
    try {
      // A shutdown asked for while the node is still booting waits for the boot to finish,
      // so the data directory lock is always released by the core itself.
      const runtime = await boot?.catch(() => undefined);
      await runtime?.stop();
      send({ type: 'stopped' });
      process.exit(0);
    } catch (error) {
      process.stderr.write(`shutdown failed: ${(error as Error).message}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('message', (message: unknown) => {
    if (message && typeof message === 'object' && (message as { type?: string }).type === 'shutdown') void shutdown('ipc');
  });
  process.on('disconnect', () => void shutdown('parent-gone'));

  boot = startNode({ ...(loaded as object), offline: false } as never);
  await boot;
  if (!stopping) send({ type: 'ready' });
}

main().catch((error) => {
  process.stderr.write(`fatal: ${(error as Error).message}\n`);
  send({ type: 'fatal', message: (error as Error).message });
  process.exit(1);
});
