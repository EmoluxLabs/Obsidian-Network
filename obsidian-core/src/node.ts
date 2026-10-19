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
import { mkdirSync, existsSync } from 'node:fs';
import { ChainManager } from './blockchain/chain.js';
import { RpcServer } from './rpc/server.js';
import { P2PService } from './networking/p2p.js';
import { PeerStore } from './networking/peer-store.js';
import { Indexer } from './indexer/indexer.js';
import { Keystore, resolveKeystorePassphrase } from './crypto/keystore.js';
import { addressFromPublicKey, nodeIdFromPublicKey } from './crypto/keys.js';
import { genesisDocumentFor, genesisId as computeGenesisId } from './genesis/initialize.js';
import { Logger } from './security/logger.js';
import { acquireDataDirLock, type DataDirLock } from './storage/lock.js';
import { describeConfig, type LoadedConfig } from './config/config.js';
import { NetworkIdentityError, buildManifest, resolveIdentity, writeManifest } from './config/network-manifest.js';
import { CONSENSUS_PARAMS } from './protocol/params.js';
import { maxBig } from './protocol/amount.js';
import type { Block, ProtocolEvent } from './protocol/types.js';
import { NodeAgent, AGENT_INTERVAL_SECONDS } from './node-agent.js';

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
  /**
   * Refuse to create a NEW network in this directory: only continue one that `init` (or an earlier start) recorded.
   * For production services, where a missing or wrong data directory must be an error and not a fresh chain.
   */
  requireInit?: boolean;
}

export async function startNode(options: StartOptions): Promise<NodeRuntimeInfo> {
  mkdirSync(options.config.dataDir, { recursive: true });
  // One process per data directory: two writers on one chain directory corrupt
  // it, and "start it by hand to check" while the service is up is exactly how
  // that happens. A stale lock from a crash is taken over automatically.
  const lock = acquireDataDirLock(options.config.dataDir);
  try {
    // The identity of this directory is decided under the lock, before anything is opened: what it was created as
    // (the manifest) wins over a missing setting and refuses a conflicting one.
    const identity = resolveIdentity(options);
    if (identity.state === 'new' && options.requireInit) {
      throw new NetworkIdentityError(
        `${options.config.dataDir} holds no network yet and --require-init is set, so a new chain will not be created here. ` +
          'Run `init` first (it prints the genesis id to check), or point --data-dir at the right directory.',
      );
    }
    return await bootNode({ ...options, ...identity.loaded }, lock, identity);
  } catch (error) {
    lock.release();
    throw error;
  }
}

async function bootNode(options: StartOptions, lock: DataDirLock, identity0: ReturnType<typeof resolveIdentity>): Promise<NodeRuntimeInfo> {
  const { config, net } = options;
  const logger = new Logger({ level: config.logLevel, json: config.logJson, component: 'node' });
  logger.info('starting obsidian core', describeConfig(config));
  for (const warning of options.warnings ?? []) logger.warn(warning);

  mkdirSync(config.dataDir, { recursive: true });

  // ── Identity key (the ONLY secret this process persists) ─────────────────
  const passphrase = await resolveKeystorePassphrase({ creating: !Keystore.exists(config.keystorePath) });
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
  const genesisDocument = genesisDocumentFor(net, config.miningGatePublicKeys);
  const chain = new ChainManager({
    dataDir: config.dataDir,
    net,
    genesisDocument,
    enforceProposerRotation: true,
  });
  await chain.init();
  const genesisIdentifier = computeGenesisId(genesisDocument, net);
  if (identity0.state !== 'existing') {
    writeManifest(config.dataDir, buildManifest(net, identity0.derived, identity0.state === 'new' ? { kind: 'start' } : { kind: 'adopted' }));
  }
  logger.info(identity0.state === 'new' ? 'NEW network created in this data directory' : 'existing network resumed', {
    state: identity0.state,
    genesisId: genesisIdentifier,
    adoptedFromManifest: identity0.adopted,
  });
  logger.info('chain ready', {
    network: net.name,
    chainId: net.chainId,
    height: chain.height,
    head: chain.tip?.hash,
    genesisId: genesisIdentifier,
  });

  if (chain.world.s.genesis.gateKeysActive.length === 0) {
    logger.warn(
      'this chain commits no mining gate issuer key: the node runs and verifies blocks, but NO mining claim can be ' +
        'accepted. Set OBSIDIAN_MINING_GATE_PUBLIC_KEYS (the same list on every node) or commit the keys in genesis/gate-keys.ts.',
      { network: net.name },
    );
  }

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
        p2p.connectTo(seed, 'seed').catch((error: unknown) => {
          // One unusable seed (a malformed entry) must not stop the node, or the others.
          logger.warn('seed node ignored', { seed, error: (error as Error).message });
        });
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

  // The double-sign lock closed a slot this node had already signed on. It is the safe outcome — signing twice on
  // one parent is the equivocation that bans a node — but an operator watching a node that stopped producing
  // deserves to see why.
  chain.on('proposal-lock', (info: { height: number; parentHash: string }) => {
    logger.warn('this node already signed a block on this parent; waiting for the chain to move on', {
      height: info.height,
      parent: info.parentHash,
    });
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
  /** A periodic task that throws is logged with its name and run again next tick; an exception out of a timer would end the process. */
  const guarded = (task: string, work: () => void): (() => void) => () => {
    try {
      work();
    } catch (error) {
      logger.error('periodic task failed; the node keeps running', { task, error: (error as Error).message.slice(0, 300) });
    }
  };
  // Sync loop: ask the best peer for blocks whenever it holds a better chain.
  timers.push(
    setInterval(guarded('sync', () => {
      const behind = p2p.behindBy() > 1;
      chain.setSyncing(behind);
      if (behind) p2p.requestSyncFromPeers();
    }), 5_000),
  );

  // Block production loop.
  timers.push(
    setInterval(guarded('block-production', () => {
      if (!config.miningEnabled) return;
      // Still catching up: building on a stale head only mints a block nobody
      // will accept. Wait until we are level with the best peer.
      if (p2p.behindBy() > 1) return;
      // Pace: mint no sooner than the configured spacing after the parent. The loop wakes every second so a node
      // whose turn has come produces when it is due, not up to a whole interval later (a coarse timer would stretch
      // blocks to roughly double the target and could let a due turn pass to the next producer). The protocol itself
      // only requires one second between blocks; this is the node's own pacing, not a consensus rule.
      if (chain.protocolTime - chain.lastBlockTimestamp < config.blockProductionIntervalSeconds) return;
      // The schedule is read from committed state, the same way block validation reads it. OPEN means no node has
      // registered yet (the founding state); otherwise exactly one address is entitled to this slot.
      const decision = chain.productionDecisionNow();
      if (decision.kind === 'SCHEDULED' && decision.producer !== identity.address) {
        logger.debug('not this node’s slot', { height: chain.height + 1, scheduled: decision.producer });
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
    }), 1_000),
  );

  // Node participation: register, heartbeat, attest and report, signed by this node's own key (see node-agent.ts).
  const agent = new NodeAgent({
    chain,
    p2p,
    net,
    dataDir: config.dataDir,
    identity: { address: identity.address, publicKey: identity.publicKey, privateKey: identity.privateKey, nodeId },
    participating: () => config.miningEnabled,
    behind: () => p2p.behindBy() > 1,
    log: (level, message, fields) => logger[level](message, fields),
  });
  timers.push(setInterval(guarded('node-agent', () => agent.tick()), AGENT_INTERVAL_SECONDS * 1_000));

  // Mempool hygiene: drop expired transactions.
  timers.push(
    setInterval(guarded('mempool-prune', () => {
      const removed = chain.mempool.pruneExpired(chain.protocolTime);
      if (removed > 0) logger.debug('pruned expired mempool transactions', { removed });
    }), 60_000),
  );

  // Periodic status line (useful in production logs).
  timers.push(
    setInterval(guarded('status-line', () => {
      const status = chain.status({ peers: p2p.peerCount });
      logger.info('status', {
        height: status.height,
        peers: status.peers,
        mempool: status.mempool.transactions,
        supplyObs: status.supply,
        activeMiners: status.activeMiners,
        genesisClaimed: status.genesisAllocationClaimed,
        nodes: status.nodes,
        scheduleTier: status.scheduleTier,
        finalizedHeight: status.finalizedHeight,
        syncing: status.syncing,
      });
    }), 60_000),
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

/** Validate a data directory without starting the node (used by `obsidian-core validate`). */
export async function validateDataDir(loaded: LoadedConfig): Promise<{ ok: boolean; problems: string[] }> {
  const { config, net } = loaded;
  if (!existsSync(config.dataDir)) return { ok: false, problems: [`data directory ${config.dataDir} does not exist`] };
  // Refuses (with a message that names the other process) when a node is
  // running on this directory: reading a chain that is being written is
  // meaningless, and opening it can interfere with the live node.
  const lock = acquireDataDirLock(config.dataDir);
  try {
    const effective = resolveIdentity(loaded).loaded.config;
    const chain = new ChainManager({
      dataDir: config.dataDir,
      net,
      genesisDocument: genesisDocumentFor(net, effective.miningGatePublicKeys),
    });
    await chain.init();
    return chain.verifyIntegrity();
  } finally {
    lock.release();
  }
}

export { maxBig };
export { join };
