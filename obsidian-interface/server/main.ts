#!/usr/bin/env node
/**
 * Interface entry point.
 *
 * Boots the HTTP server, tells the operator exactly which nodes it will read and
 * which chain they are on, and refuses to start on a half-configured deployment.
 */

import { InterfaceServer } from './index.js';
import { gatePassphraseFromEnv, loadGateIssuer, type GateIssuer } from './gate-issuer.js';
import {
  INTERFACE_USAGE,
  describeInterfaceConfig,
  loadInterfaceConfig,
  validateInterfaceConfig,
} from './config.js';

async function main(): Promise<number> {
  let loaded;
  try {
    loaded = loadInterfaceConfig();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${INTERFACE_USAGE}`);
    return 2;
  }

  if ((process.argv.includes('--help') || process.argv.includes('-h'))) {
    process.stdout.write(INTERFACE_USAGE);
    return 0;
  }

  const problems = validateInterfaceConfig(loaded);
  if (problems.length > 0) {
    process.stderr.write(`interface cannot start:\n  - ${problems.join('\n  - ')}\n`);
    return 2;
  }

  // The mining gate key. A keystore that is configured but cannot be opened stops the start; no keystore at all
  // starts the interface with mining closed (it says so on every certificate request and here).
  let gateIssuer: GateIssuer | undefined;
  const gateKeystore = process.env.OBSIDIAN_GATE_KEYSTORE?.trim();
  if (gateKeystore) {
    const passphrase = gatePassphraseFromEnv();
    if (!passphrase) {
      process.stderr.write('OBSIDIAN_GATE_KEYSTORE is set but OBSIDIAN_GATE_KEYSTORE_PASSPHRASE (or _FILE) is missing or shorter than 12 characters\n');
      return 2;
    }
    try {
      gateIssuer = await loadGateIssuer({ keystorePath: gateKeystore, passphrase, coreDir: loaded.config.coreDir });
    } catch (error) {
      process.stderr.write(`interface cannot start: ${(error as Error).message}\n`);
      return 2;
    }
  }

  const server = new InterfaceServer({ config: loaded.config, gateIssuer });
  const port = await server.listen();
  const described = describeInterfaceConfig(loaded);
  process.stdout.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: 'info', component: 'interface', message: 'ready', port, ...described })}\n`,
  );
  process.stdout.write(
    `${JSON.stringify({
      ts: new Date().toISOString(),
      level: gateIssuer ? 'info' : 'warn',
      component: 'interface',
      message: gateIssuer
        ? 'mining gate issuer loaded'
        : 'no mining gate key (OBSIDIAN_GATE_KEYSTORE): certificates cannot be issued, so mining is closed',
      ...(gateIssuer ? { gatePublicKey: gateIssuer.publicKey } : {}),
    })}\n`,
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second Ctrl+C while the first is still draining must not start a second shutdown.
    if (stopping) return;
    stopping = true;
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level: 'info', message: 'shutting down', signal })}\n`);
    try {
      await server.close();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`shutdown failed: ${(error as Error).message}\n`);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // A background interface must never hold the event loop open by accident.
  return new Promise<number>(() => {
    /* run until a signal arrives */
  });
}

main().then(
  (code) => {
    if (code !== 0 && code !== undefined) process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`interface failed: ${(error as Error).message}\n`);
    process.exitCode = 1;
  },
);
