#!/usr/bin/env node
/**
 * obsidian-core CLI.
 *
 * Commands
 *   start | node            run a full node (chain + p2p + rpc + optional miner)
 *   keygen                  create or show this node's identity key
 *   health                  query a local node's health endpoint
 *   genesis init            print the genesis document, id and hash for a network
 *   validate                verify a data directory's chain integrity
 *   audit                   print the decentralization + compliance self-audit
 *   wallet new              create a non-custodial wallet (prints once, locally)
 *   version                 print version metadata
 *
 * Everything the node needs is in the configuration file or the environment;
 * there are no hidden flags that change consensus behaviour.
 */

import { existsSync } from 'node:fs';
import { loadConfig, type LoadedConfig } from './config/config.js';
import { startNode, validateDataDir } from './node.js';
import {
  MAINNET_GENESIS_DOCUMENT,
  TESTNET_GENESIS_DOCUMENT,
  buildGenesisBlock,
  genesisDocumentFor,
  genesisId,
} from './genesis/initialize.js';
import { blockHash } from './blockchain/block.js';
import { Keystore, keystorePassphraseFromEnv } from './crypto/keystore.js';
import { nodeIdFromPublicKey } from './crypto/keys.js';
import { generateRecoveryPhrase, deriveWallet } from './crypto/mnemonic.js';
import { CONSENSUS_PARAMS } from './protocol/params.js';
import { CORE_VERSION, PROTOCOL_VERSION, versionInfo, BUILD_ID } from './version.js';
import { PARAMS_HASH } from './blockchain/state-root.js';
import { formatObs, MAX_SUPPLY_SEALS } from './protocol/amount.js';
import { Logger } from './security/logger.js';

function usage(): void {
  process.stdout.write(
    `${[
      'obsidian-core — Obsidian Network node software',
      '',
      'Usage: obsidian-core <command> [options]',
      '',
      'Commands:',
      '  start | node        Run a full node (default)',
      '  keygen              Create/show the node identity keystore',
      '  health              Query the local RPC health endpoint',
      '  genesis init        Print the genesis document, id and hash',
      '  validate            Verify the data directory chain integrity',
      '  audit               Print the decentralization and compliance audit',
      '  wallet new          Create a non-custodial OBS wallet (local only)',
      '  version             Print version and protocol metadata',
      '',
      'Options:',
      '  --config <path>     Configuration file (JSON)',
      '  --network <name>    mainnet | testnet | staging | devnet',
      '  --data-dir <path>   Data directory',
      '  --keystore <path>   Node identity keystore',
      '  --p2p-host <host>   Peer-to-peer bind host',
      '  --p2p-port <port>   Peer-to-peer bind port',
      '  --node-name <name>  Operator-visible node name',
      '  --port-offset <n>   Add n to the network default ports',
      '  --seeds <list>      Comma-separated bootstrap peers (host:port)',
      '  --cors <list>       RPC CORS allowlist (comma separated origins)',
      '  --log-level <level> trace | debug | info | warn | error',
      '  --mine              Enable block production (default on mainnet)',
      '  --no-mine           Disable block production',
      '  --offline           Do not dial seed nodes',
      '  -h, --help          Show this help',
      '',
      'Environment: OBSIDIAN_* (see .env.example)',
    ].join('\n')}\n`,
  );
}

interface CliOptions {
  command: string;
  sub?: string;
  configPath?: string;
  network?: string;
  dataDir?: string;
  keystorePath?: string;
  offline: boolean;
  rpcPort?: number;
  rpcHost?: string;
  p2pPort?: number;
  p2pHost?: string;
  nodeName?: string;
  portOffset?: number;
  seeds?: string;
  cors?: string;
  logLevel?: string;
  miningEnabled?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { command: argv[0] ?? 'start', offline: false };
  const rest = argv.slice(1);
  options.sub = rest[0] && !rest[0].startsWith('--') ? rest[0] : undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case '--config':
        options.configPath = rest[++i];
        break;
      case '--network':
        options.network = rest[++i];
        break;
      case '--data-dir':
        options.dataDir = rest[++i];
        break;
      case '--keystore':
        options.keystorePath = rest[++i];
        break;
      case '--offline':
        options.offline = true;
        break;
      case '--rpc-port':
        options.rpcPort = Number.parseInt(rest[++i] ?? '', 10);
        break;
      case '--rpc-host':
        options.rpcHost = rest[++i];
        break;
      case '--p2p-port':
        options.p2pPort = Number.parseInt(rest[++i] ?? '', 10);
        break;
      case '--p2p-host':
        options.p2pHost = rest[++i];
        break;
      case '--node-name':
        options.nodeName = rest[++i];
        break;
      case '--port-offset':
        options.portOffset = Number.parseInt(rest[++i] ?? '', 10);
        break;
      case '--seeds':
        options.seeds = rest[++i];
        break;
      case '--cors':
        options.cors = rest[++i];
        break;
      case '--log-level':
        options.logLevel = rest[++i];
        break;
      case '--mine':
        options.miningEnabled = true;
        break;
      case '--no-mine':
        options.miningEnabled = false;
        break;
      default:
        // Unknown flags are a hard error: silently ignoring a typo such as
        // "--mine-ing" could leave a node that the operator believes is mining.
        if (arg.startsWith('--')) throw new Error(`unknown option "${arg}" (try --help)`);
        break;
    }
  }
  return options;
}

function loadFromCli(options: CliOptions): LoadedConfig {
  const overrides: Record<string, unknown> = {};
  if (options.network) overrides.network = options.network;
  if (options.dataDir) overrides.dataDir = options.dataDir;
  if (options.keystorePath) overrides.keystorePath = options.keystorePath;
  if (typeof options.rpcPort === 'number' && Number.isFinite(options.rpcPort)) overrides.rpcPort = options.rpcPort;
  if (options.rpcHost) overrides.rpcHost = options.rpcHost;
  if (typeof options.p2pPort === 'number' && Number.isFinite(options.p2pPort)) overrides.p2pPort = options.p2pPort;
  if (options.p2pHost) overrides.p2pHost = options.p2pHost;
  if (options.nodeName) overrides.nodeName = options.nodeName;
  if (typeof options.portOffset === 'number' && Number.isFinite(options.portOffset)) overrides.portOffset = options.portOffset;
  if (options.seeds) overrides.seedNodes = options.seeds.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (options.cors) overrides.rpcCorsOrigins = options.cors.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (options.logLevel) overrides.logLevel = options.logLevel;
  if (options.miningEnabled !== undefined) overrides.miningEnabled = options.miningEnabled;
  return loadConfig({ configPath: options.configPath, overrides });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    usage();
    return;
  }
  const options = parseArgs(argv);
  const command = options.command === 'node' ? 'start' : options.command;

  switch (command) {
    case 'start': {
      const loaded = loadFromCli(options);
      const runtime = await startNode({ ...loaded, offline: options.offline });
      const shutdown = async (signal: string): Promise<void> => {
        process.stdout.write(`\nreceived ${signal}, shutting down\n`);
        await runtime.stop();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown('SIGINT'));
      process.on('SIGTERM', () => void shutdown('SIGTERM'));
      return;
    }

    case 'keygen': {
      const loaded = loadFromCli(options);
      const logger = new Logger({ level: 'info', json: false, component: 'keygen' });
      if (Keystore.exists(loaded.config.keystorePath)) {
        const passphrase = keystorePassphraseFromEnv();
        const pair = Keystore.read(loaded.config.keystorePath, passphrase);
        process.stdout.write(
          `${JSON.stringify(
            {
              existing: true,
              path: loaded.config.keystorePath,
              address: pair.address,
              publicKey: pair.publicKey,
              nodeId: nodeIdFromPublicKey(pair.publicKey),
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      const passphrase = keystorePassphraseFromEnv();
      const pair = Keystore.create(loaded.config.keystorePath, passphrase);
      logger.info('created node identity keystore', { path: loaded.config.keystorePath });
      process.stdout.write(
        `${JSON.stringify(
          {
            created: true,
            path: loaded.config.keystorePath,
            address: pair.address,
            publicKey: pair.publicKey,
            nodeId: nodeIdFromPublicKey(pair.publicKey),
            note: 'The private key never leaves this machine and is never logged.',
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    case 'health': {
      const loaded = loadFromCli(options);
      const url = `http://${loaded.config.rpcHost === '0.0.0.0' ? '127.0.0.1' : loaded.config.rpcHost}:${loaded.config.rpcPort}/health`;
      const response = await fetch(url);
      process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'genesis': {
      if (options.sub !== 'init') {
        usage();
        return;
      }
      const loaded = loadFromCli(options);
      const document = genesisDocumentFor(loaded.net);
      const block = buildGenesisBlock(document, loaded.net);
      process.stdout.write(
        `${JSON.stringify(
          {
            network: loaded.net.name,
            document,
            genesisId: genesisId(document, loaded.net),
            genesisHash: blockHash(block.header),
            stateRoot: block.header.stateRoot,
            paramsHash: PARAMS_HASH,
            premine: 'none',
            genesisAllocationObs: formatObs(CONSENSUS_PARAMS.genesisAllocation),
            note: 'The 100,000 OBS Genesis Allocation is reserved for the first protocol-valid mining claim.',
            references: { mainnet: MAINNET_GENESIS_DOCUMENT, testnet: TESTNET_GENESIS_DOCUMENT },
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    case 'validate': {
      const loaded = loadFromCli(options);
      const result = await validateDataDir(loaded);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
      return;
    }

    case 'audit': {
      process.stdout.write(
        `${JSON.stringify(
          {
            design: {
              adminMint: 'impossible: issue() accepts only GENESIS_ALLOCATION and MINING_REWARD',
              databaseAuthority: 'none: the node has no external database dependency',
              cloudflareAuthority: 'none: hosting and gateway only',
              googleAuthority: 'none: OAuth is application-level',
              browserClockAuthority: 'none: eligibility derives from block timestamps',
              privateKeysServerSide: 'none: users sign client-side; the node persists only its own encrypted identity key',
              explorerBalances: 'not exposed: balances are served only by the wallet API',
              genesisReplay: 'impossible: one-way flag plus claim-id replay protection',
              supplyCap: `enforced at every issuance: maximum ${MAX_SUPPLY_SEALS} seals (21,000,000 OBS)`,
            },
            removedFeatures: {
              wac: !CONSENSUS_PARAMS.registry.wacEnabled,
              wacPriceUsd: CONSENSUS_PARAMS.registry.wacPriceUsd.toString(),
              legacyGenesisAllocation: CONSENSUS_PARAMS.legacyGenesisAllocationRemoved.toString(),
              miningKyc: !CONSENSUS_PARAMS.registry.miningKycRequired,
              nativeExchange: !CONSENSUS_PARAMS.registry.nativeExchangeEnabled,
              signupAllocation: formatObs(CONSENSUS_PARAMS.registry.newAccountBalance),
            },
            versions: versionInfo(),
            buildId: BUILD_ID,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    case 'wallet': {
      if (options.sub !== 'new') {
        usage();
        return;
      }
      // Local, offline wallet generation. Nothing is transmitted; the operator
      // is responsible for keeping the output secret.
      const phrase = generateRecoveryPhrase();
      const wallet = deriveWallet(phrase, 0, 0);
      process.stdout.write(
        `${JSON.stringify(
          {
            address: wallet.address,
            publicKey: wallet.publicKey,
            derivationPath: wallet.derivationPath,
            recoveryPhrase: phrase,
            warning:
              'This output is printed once and is NOT stored. Write the recovery phrase down offline. ' +
              'Anyone with it controls the wallet. Never paste it into a website, chat or issue tracker.',
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    case 'version': {
      process.stdout.write(
        `${JSON.stringify({ ...versionInfo(), paramsHash: PARAMS_HASH, core: CORE_VERSION, protocol: PROTOCOL_VERSION }, null, 2)}\n`,
      );
      return;
    }

    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`fatal: ${(error as Error).message}\n`);
  if (process.env.OBSIDIAN_DEBUG) process.stderr.write(`${(error as Error).stack ?? ''}\n`);
  process.exit(1);
});
