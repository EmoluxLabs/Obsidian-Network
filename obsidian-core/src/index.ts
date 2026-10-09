#!/usr/bin/env node
/**
 * obsidian-core CLI.
 *
 * Commands
 *   start | node            run a full node (chain + p2p + rpc + optional miner)
 *   keygen                  create or show this node's identity key
 *   health                  query a local node's health endpoint
 *   finality                query the local node's verified finality state
 *   genesis init            print the genesis document, id and hash for a network
 *   validate                verify a data directory's chain integrity
 *   audit                   print the decentralization + compliance self-audit
 *   wallet new              create a non-custodial wallet (prints once, locally)
 *                           honours --network: the address prefix is per network
 *   version                 print version metadata
 *
 * Everything the node needs is in the configuration file or the environment;
 * there are no hidden flags that change consensus behaviour.
 */

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
import { getNetwork } from './protocol/networks.js';
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
      '  start | node        Run a full node (the default command; it still needs --network)',
      '  keygen              Create/show the node identity keystore',
      '  health              Query the local RPC health endpoint',
      '  finality            Query the local verified finality checkpoint',
      '  genesis init        Print the genesis document, id and hash',
      '  validate            Verify the data directory chain integrity',
      '  audit               Print the decentralization and compliance audit',
      '  wallet new          Create a non-custodial OBS wallet (local only, honours --network)',
      '  version             Print version and protocol metadata',
      '',
      'Options:',
      '  --config <path>     Configuration file (JSON)',
      '  --network <name>    mainnet | testnet | staging | devnet  (required for `start`; there is no default)',
      '  --data-dir <path>   Data directory',
      '  --keystore <path>   Node identity keystore',
      '  --rpc-port <port>   RPC bind port (default: the network port)',
      '  --rpc-host <host>   RPC bind host (default: 127.0.0.1)',
      '  --p2p-port <port>   Peer-to-peer bind port',
      '  --p2p-host <host>   Peer-to-peer bind host',
      '  --node-name <name>  Operator-visible node name',
      '  --port-offset <n>   Add n to the network default ports',
      '  --seeds <list>      Comma-separated bootstrap peers (host:port)',
      '  --cors <list>       RPC CORS allowlist (comma separated origins)',
      '  --log-level <level> trace | debug | info | warn | error',
      '  --mine              Enable block production (the default on every network)',
      '  --no-mine           Disable block production (follow and validate only)',
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
    const arg = rest[i]!;
    // A flag that takes a value must be given one. `--network` at the end of a
    // command used to read as "no value" and quietly fall through to the
    // default, which was mainnet.
    const value = (): string => {
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value (try --help)`);
      i += 1;
      return next;
    };
    const whole = (): number => {
      const raw = value();
      if (!/^\d+$/.test(raw)) throw new Error(`${arg} must be a whole number, received "${raw}"`);
      return Number.parseInt(raw, 10);
    };
    switch (arg) {
      case '--config':
        options.configPath = value();
        break;
      case '--network':
        options.network = value();
        break;
      case '--data-dir':
        options.dataDir = value();
        break;
      case '--keystore':
        options.keystorePath = value();
        break;
      case '--offline':
        options.offline = true;
        break;
      case '--rpc-port':
        options.rpcPort = whole();
        break;
      case '--rpc-host':
        options.rpcHost = value();
        break;
      case '--p2p-port':
        options.p2pPort = whole();
        break;
      case '--p2p-host':
        options.p2pHost = value();
        break;
      case '--node-name':
        options.nodeName = value();
        break;
      case '--port-offset':
        options.portOffset = whole();
        break;
      case '--seeds':
        options.seeds = value();
        break;
      case '--cors':
        options.cors = value();
        break;
      case '--log-level':
        options.logLevel = value();
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

function loadFromCli(options: CliOptions, extra: { requireExplicitNetwork?: boolean } = {}): LoadedConfig {
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
  return loadConfig({ configPath: options.configPath, overrides, requireExplicitNetwork: extra.requireExplicitNetwork });
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
      const loaded = loadFromCli(options, { requireExplicitNetwork: true });
      const runtime = await startNode({ ...loaded, offline: options.offline });
      let stopping = false;
      const shutdown = async (signal: string): Promise<void> => {
        // A second Ctrl+C while the first is still draining must not start a second shutdown.
        if (stopping) return;
        stopping = true;
        process.stdout.write(`\nreceived ${signal}, shutting down\n`);
        try {
          await runtime.stop();
          process.exit(0);
        } catch (error) {
          process.stderr.write(`shutdown failed: ${(error as Error).message}\n`);
          process.exit(1);
        }
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
      // The RPC port follows the network. Asking the wrong port reports on the wrong
      // chain (or on nothing), so say which one.
      const loaded = loadFromCli(options, { requireExplicitNetwork: true });
      const url = `http://${loaded.config.rpcHost === '0.0.0.0' ? '127.0.0.1' : loaded.config.rpcHost}:${loaded.config.rpcPort}/health`;
      const response = await fetch(url);
      process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`);
      process.exitCode = response.ok ? 0 : 1;
      return;
    }

    case 'finality': {
      const loaded = loadFromCli(options,{requireExplicitNetwork:true});
      const url=`http://${loaded.config.rpcHost==='0.0.0.0'?'127.0.0.1':loaded.config.rpcHost}:${loaded.config.rpcPort}/finality`;
      const response=await fetch(url); process.stdout.write(`${JSON.stringify(await response.json(),null,2)}\n`); process.exitCode=response.ok?0:1; return;
    }

    case 'genesis': {
      if (options.sub !== 'init') {
        usage();
        return;
      }
      const loaded = loadFromCli(options, { requireExplicitNetwork: true });
      const document = genesisDocumentFor(loaded.net, loaded.config.bootstrapValidatorPublicKeys, loaded.config.miningGatePublicKeys);
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
      // A data directory is only meaningful for the network that wrote it, and which
      // genesis it must replay to depends on that: name it rather than assume mainnet.
      const loaded = loadFromCli(options, { requireExplicitNetwork: true });
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
              googleAuthority: 'none: there is no Google sign-in; the node never talks to Google',
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
      // The address prefix belongs to the network, so the operator must say which.
      // Deriving with a default prefix is how a mainnet address ended up on
      // devnet in 1.2.1, and a default here would do the same thing at the
      // command line: there is none.
      const requested = options.network ?? process.env.OBSIDIAN_NETWORK;
      if (!requested) {
        throw new Error(
          'no network selected. Say which network this wallet is for: --network devnet|testnet|staging|mainnet ' +
            '(or set OBSIDIAN_NETWORK). There is no default on purpose: an address belongs to one network, and ' +
            'one made for the wrong network is refused by every node on the right one.',
        );
      }
      const net = getNetwork(requested);
      const phrase = generateRecoveryPhrase();
      const wallet = deriveWallet(phrase, 0, 0, undefined, net.addressHrp);
      process.stdout.write(
        `${JSON.stringify(
          {
            network: net.name,
            chainId: net.chainId,
            addressHrp: net.addressHrp,
            address: wallet.address,
            publicKey: wallet.publicKey,
            derivationPath: wallet.derivationPath,
            recoveryPhrase: phrase,
            warning:
              `This address is for ${net.name}: it carries the "${net.addressHrp}" prefix and no other network accepts it. ` +
              'The same recovery phrase derives the same KEY on every network (only the prefix changes), so make a separate wallet ' +
              'for each network and never reuse a test-network phrase on mainnet. ' +
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
