/**
 * ObsidianNode — the running node process.
 *
 * Wires together: configuration, encrypted keystore, chain engine, indexer,
 * peer-to-peer networking, sync, the RPC/API surface and the block producer.
 *
 * Operational guarantees:
 *   - the node never holds user private keys and never asks for them;
 *   - it starts and serves reads even with zero peers;
 *   - it never trusts a peer, a proxy or an interface for state;
 *   - it can be stopped at any moment and resumes from its own storage.
 */

import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { ChainManager } from './blockchain/chain.js';
import { RpcServer } from './rpc/server.js';
import { P2PService } from './networking/p2p.js';
import { PeerStore } from './networking/peer-store.js';
import { Indexer } from './indexer/indexer.js';
import { Keystore, keystorePassphraseFromEnv } from './crypto/keystore.js';
import { addressFromPublicKey, nodeIdFromPublicKey } from './crypto/keys.js';
import { genesisDocumentFor, genesisId as computeGenesisId } from './genesis/initialize.js';
import { Logger } from './security/logger.js';
import { describeConfig, type LoadedConfig } from './config/config.js';
import { CONSENSUS_PARAMS } from './protocol/params.js';
import { maxBig } from './protocol/amount.js';
import { scheduledProposer } from './consensus/proposer.js';
import type { Block, ProtocolEvent } from './protocol/types.js';

export interface NodeRuntimeInfo {
  chain: ChainManager;
  rpc?: RpcServer;
  p2p: P2PService;
  indexer: Indexer;
  config: LoadedConfig;
  nodeId: string;
  publicKey: string;
  stop: () => Promise<void>;
}

export interface StartOptions extends LoadedConfig {
  /** Skip connecting to seed nodes (used by tests and isolated nodes). */
  offline?: boolean;
}

export async function startNode(options: StartOptions): Promise<NodeRuntimeInfo> {
  const { config, net } = options;
  const logger = new Logger({ level: config.logLevel, json: config.logJson, component: 'node' });
  logger.info('starting obsidian core', describeConfig(config));

  mkdirSync(config.dataDir, { recursive: true });

  // ── Identity key (the ONLY secret this process persists) ─────────────────
  const passphrase = resolveKeystorePassphrase(config.keystorePath, logger);
  const identityKey = Keystore.exists(config.keystorePath)
    ? Keystore.read(config.keystorePath, passphrase)
    : Keystore.create(config.keystorePath, passphrase);
  // The node's on-chain address is derived for THIS network's HRP: an obs1
  // address is not valid on testnet/devnet and vice versa.
  const identity = {
    ...identityKey,
    address: addressFromPublicKey(identityKey.publicKey, net.addressHrp),
  };
  const nodeId = nodeIdFromPublicKey(identity.publicKey);
  logger.info('node identity ready', { nodeId, keystore: config.keystorePath });

  // ── Chain ────────────────────────────────────────────────────────────────
  const genesisDocument = genesisDocumentFor(net);
  const chain = new ChainManager({
    dataDir: config.dataDir,
    net,
    genesisDocument,
    enforceProposerRotation: true,
  });
  await chain.init();
  const genesisIdentifier = computeGenesisId(genesisDocument, net);
  logger.info('chain ready', {
    network: net.name,
    chainId: net.chainId,
    height: chain.height,
    head: chain.tip?.hash,
    genesisId: genesisIdentifier,
  });

  const indexer = new Indexer(config.dataDir);

  // ── P2P ──────────────────────────────────────────────────────────────────
  const peers = new PeerStore({
    dataDir: config.dataDir,
    maxPeers: config.maxPeers,
    seeds: config.seedNodes,
  });
  const p2p = new P2PService({
    net,
    chain,
    peers,
    identity: { nodeId, publicKey: identity.publicKey, privateKey: identity.privateKey },
    nodeName: config.nodeName,
    maxPeers: config.maxPeers,
    maxInboundPeers: config.maxInboundPeers,
    listenAddress: `${config.publicHost || '0.0.0.0'}:${config.p2pPort}`,
    genesisId: genesisIdentifier,
    log: (level, message, fields) => logger[level](message, fields),
  });

  if (config.p2pEnabled) {
    try {
      await p2p.listen(config.p2pPort, config.p2pHost);
    } catch (error) {
      logger.warn('p2p listener failed to start; node will run in isolated mode', {
        error: (error as Error).message,
      });
    }
    if (!options.offline) {
      for (const seed of config.seedNodes) {
        void p2p.connectTo(seed, 'seed');
      }
    }
  } else {
    logger.info('p2p is disabled by configuration; this node will not gossip or sync', {});
  }

  // ── Indexer wiring: index every connected block, including during sync ───
  chain.on('block', (block: Block, events: ProtocolEvent[] = []) => {
    try {
      // Index the block with the exact events the state machine emitted while
      // applying it — the indexer is a cache of consensus, never a second
      // implementation of it.
      indexer.indexBlock(block, events, chain.world);
    } catch (error) {
      logger.warn('indexing failed for a block (non-fatal, indexer is a cache)', {
        error: (error as Error).message,
      });
    }
  });

  // ── RPC ──────────────────────────────────────────────────────────────────
  let rpc: RpcServer | undefined;
  if (config.rpcEnabled) {
    rpc = new RpcServer({
      chain,
      p2p,
      indexer,
      net,
      config,
      genesisId: genesisIdentifier,
      log: (level, message, fields) => logger[level](message, fields),
    });
    await rpc.listen();
  }

  // ── Loops ────────────────────────────────────────────────────────────────
  const timers: NodeJS.Timeout[] = [];

  // Sync loop: ask peers for blocks whenever we are behind.
  timers.push(
    setInterval(() => {
      const bestPeerHeight = Math.max(0, ...p2p.activeConnections().map((c) => c.height));
      const behind = bestPeerHeight > chain.height + 1;
      chain.setSyncing(behind);
      if (behind) p2p.requestSyncFromPeers();
    }, 5_000),
  );

  // Block production loop.
  timers.push(
    setInterval(() => {
      if (!config.miningEnabled) return;
      const scheduled = scheduledProposer(chain.world, chain.height + 1);
      if (scheduled !== null && scheduled !== identity.address) return;
      try {
        const block = chain.buildNextBlock({
          address: identity.address,
          privateKey: identity.privateKey,
          publicKey: identity.publicKey,
        });
        if (!block) return;
        const result = chain.addBlock(block);
        if (result.accepted) {
          logger.info('produced block', {
            height: block.header.height,
            transactions: block.transactions.length,
            hash: result.hash,
          });
          p2p.broadcastBlock(block);
        } else {
          logger.warn('produced block rejected locally', { code: result.code, message: result.message });
        }
      } catch (error) {
        logger.error('block production failed', { error: (error as Error).message });
      }
    }, Math.max(1_000, config.blockProductionIntervalSeconds * 1_000)),
  );

  // Mempool hygiene: drop expired transactions.
  timers.push(
    setInterval(() => {
      const removed = chain.mempool.pruneExpired(chain.protocolTime);
      if (removed > 0) logger.debug('pruned expired mempool transactions', { removed });
    }, 60_000),
  );

  // Periodic status line (useful in production logs).
  timers.push(
    setInterval(() => {
      const status = chain.status({ peers: p2p.peerCount });
      logger.info('status', {
        height: status.height,
        peers: status.peers,
        mempool: status.mempool.transactions,
        supplyObs: status.supply,
        activeMiners: status.activeMiners,
        genesisClaimed: status.genesisAllocationClaimed,
        validators: status.validators,
        syncing: status.syncing,
      });
    }, 60_000),
  );

  const stop = async (): Promise<void> => {
    logger.info('shutting down');
    for (const timer of timers) clearInterval(timer);
    await p2p.stop();
    await rpc?.close();
    peers.persist(true);
    logger.info('stopped cleanly');
  };

  logger.info('obsidian core ready', {
    network: net.name,
    height: chain.height,
    rpc: config.rpcEnabled ? `http://${config.rpcHost}:${config.rpcPort}` : 'disabled',
    p2p: `ws://${config.p2pHost}:${config.p2pPort}`,
    mining: config.miningEnabled,
    maxSupplyObs: CONSENSUS_PARAMS.maxSupply.toString(),
  });

  return { chain, rpc, p2p, indexer, config: options, nodeId, publicKey: identity.publicKey, stop };
}

/**
 * Resolve the keystore passphrase.
 * Production path: OBSIDIAN_KEYSTORE_PASSPHRASE must be set. For a first run on
 * a development machine we generate one and store it with 0600 permissions next
 * to the keystore, and log a loud warning.
 */
function resolveKeystorePassphrase(keystorePath: string, logger: Logger): string {
  try {
    return keystorePassphraseFromEnv();
  } catch {
    const companion = `${keystorePath}.pass`;
    if (existsSync(companion)) {
      return readFileSync(companion, 'utf8').trim();
    }
    const generated = randomBytes(32).toString('base64url');
    writeFileSync(companion, `${generated}\n`, { mode: 0o600 });
    logger.warn(
      'OBSIDIAN_KEYSTORE_PASSPHRASE was not set: generated one and stored it beside the keystore. ' +
        'For production, set the environment variable and delete the companion file.',
      { companion },
    );
    return generated;
  }
}

/** Validate a data directory without starting the node (used by `obsidian-core validate`). */
export async function validateDataDir(loaded: LoadedConfig): Promise<{ ok: boolean; problems: string[] }> {
  const { config, net } = loaded;
  if (!existsSync(config.dataDir)) return { ok: false, problems: [`data directory ${config.dataDir} does not exist`] };
  const chain = new ChainManager({
    dataDir: config.dataDir,
    net,
    genesisDocument: genesisDocumentFor(net),
  });
  await chain.init();
  return chain.verifyIntegrity();
}

export { maxBig };
export { join };
