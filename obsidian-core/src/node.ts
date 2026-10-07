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
import { acquireDataDirLock, type DataDirLock } from './storage/lock.js';
import { describeConfig, type LoadedConfig } from './config/config.js';
import { CONSENSUS_PARAMS } from './protocol/params.js';
import { maxBig } from './protocol/amount.js';
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
  mkdirSync(options.config.dataDir, { recursive: true });
  // One process per data directory: two writers on one chain directory corrupt
  // it, and "start it by hand to check" while the service is up is exactly how
  // that happens. A stale lock from a crash is taken over automatically.
  const lock = acquireDataDirLock(options.config.dataDir);
  try {
    return await bootNode(options, lock);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function bootNode(options: StartOptions, lock: DataDirLock): Promise<NodeRuntimeInfo> {
  const { config, net } = options;
  const logger = new Logger({ level: config.logLevel, json: config.logJson, component: 'node' });
  logger.info('starting obsidian core', describeConfig(config));
  for (const warning of options.warnings ?? []) logger.warn(warning);

  mkdirSync(config.dataDir, { recursive: true });

  // ── Identity key (the ONLY secret this process persists) ─────────────────
  const passphrase = resolveKeystorePassphrase(config.keystorePath, logger, net.isProduction);
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
  const genesisDocument = genesisDocumentFor(net, config.bootstrapValidatorPublicKeys);
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
  // The index is a cache of the chain, so it can be wrong in exactly three ways:
  // a reorganisation happened, the node crashed between committing a block and
  // indexing it, or the directory was deleted. Repair all three before serving.
  const repair = indexer.reconcile(chain);
  if (repair.indexed > 0) {
    logger.info('index repaired from stored blocks', { rolledBackTo: repair.rolledBackTo, blocksIndexed: repair.indexed });
  }

  // ── P2P ──────────────────────────────────────────────────────────────────
  const peers = new PeerStore({
    dataDir: config.dataDir,
    maxPeers: config.maxPeers,
    seeds: config.seedNodes,
    // Test networks routinely run several nodes on one host. Mainnet peers are
    // remote by definition, so loopback/link-local hints from a stranger are junk there.
    allowLocalAddresses: !net.isProduction,
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

  // A reorganisation changes which transactions are confirmed. Only the new tip
  // raises a `block` event, so the index re-derives the rest from the chain.
  chain.on('reorg', (info: { forkHeight: number; abandoned: number; adopted: number }) => {
    try {
      indexer.reconcile(chain);
      logger.info('chain reorganised', { forkHeight: info.forkHeight, abandoned: info.abandoned, adopted: info.adopted });
    } catch (error) {
      logger.warn('index repair after a reorganisation failed (non-fatal, indexer is a cache)', {
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

  // Sync loop: ask the best peer for blocks whenever it holds a better chain.
  timers.push(
    setInterval(() => {
      const behind = p2p.behindBy() > 1;
      chain.setSyncing(behind);
      if (behind) p2p.requestSyncFromPeers();
    }, 5_000),
  );

  // Block production loop.
  timers.push(
    setInterval(() => {
      if (!config.miningEnabled) return;
      // Still catching up: building on a stale head only mints a block nobody
      // will accept. Wait until we are level with the best peer.
      if (p2p.behindBy() > 1) return;
      // null means "anyone may produce": either no validator is registered, or
      // every validator has let this height's slot lapse (the liveness
      // backstop in consensus/proposer.ts).
      const scheduled = chain.scheduledProposerNow();
      if (scheduled !== null && scheduled !== identity.address) {
        logger.debug('not this node’s slot', { height: chain.height + 1, scheduled });
        return;
      }
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
    lock.release();
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
 *
 * Production path: OBSIDIAN_KEYSTORE_PASSPHRASE (or ..._FILE) must be set. On a
 * test network a first run may generate one and keep it with 0600 permissions
 * next to the keystore, with a loud warning — convenient for a phone or a
 * laptop. On MAINNET that fallback is refused: a passphrase stored beside the
 * file it protects protects nothing, and the identity key is the one that signs
 * blocks.
 */
function resolveKeystorePassphrase(keystorePath: string, logger: Logger, production: boolean): string {
  try {
    return keystorePassphraseFromEnv();
  } catch (error) {
    if (production) {
      throw new Error(
        `${(error as Error).message} Mainnet will not fall back to a passphrase kept beside the keystore.`,
      );
    }
    const companion = `${keystorePath}.pass`;
    if (existsSync(companion)) {
      return readFileSync(companion, 'utf8').trim();
    }
    const generated = randomBytes(32).toString('base64url');
    writeFileSync(companion, `${generated}\n`, { mode: 0o600 });
    logger.warn(
      'OBSIDIAN_KEYSTORE_PASSPHRASE was not set: generated one and stored it beside the keystore. ' +
        'Fine for a test network; mainnet refuses to start this way.',
      { companion },
    );
    return generated;
  }
}

/** Validate a data directory without starting the node (used by `obsidian-core validate`). */
export async function validateDataDir(loaded: LoadedConfig): Promise<{ ok: boolean; problems: string[] }> {
  const { config, net } = loaded;
  if (!existsSync(config.dataDir)) return { ok: false, problems: [`data directory ${config.dataDir} does not exist`] };
  // Refuses (with a message that names the other process) when a node is
  // running on this directory: reading a chain that is being written is
  // meaningless, and opening it can interfere with the live node.
  const lock = acquireDataDirLock(config.dataDir);
  try {
    const chain = new ChainManager({
      dataDir: config.dataDir,
      net,
      genesisDocument: genesisDocumentFor(net, config.bootstrapValidatorPublicKeys),
    });
    await chain.init();
    return chain.verifyIntegrity();
  } finally {
    lock.release();
  }
}

export { maxBig };
export { join };
