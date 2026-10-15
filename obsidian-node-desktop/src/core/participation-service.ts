/**
 * Node participation (protocol 1.9.0): which wallet this node's rewards are paid to, and where the node stands.
 *
 * There is no validator, no bond and no registration transaction signed here. The operator pastes an OBS address; this
 * service validates it with the core's own address check and writes it to the node's data directory (core
 * `writeNodeBinding`). The RUNNING node registers itself on chain with its own identity key and keeps heartbeating, so
 * this app never signs, never opens the node key and never submits anything for it.
 *
 * Honest limits, repeated in the screen: pasting an address does not prove ownership (anyone could paste yours; rewards
 * are only ever paid TO a wallet, never taken from it, and the wallet's owner can reclaim it with a transaction), and a
 * node that is offline, behind or not producing earns nothing.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { NetworkName } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { BindResult, ParticipationCheck, ParticipationPhase, ParticipationView } from '../shared/participation-types.js';
import type { NodeStatusInfo } from '../shared/chain-types.js';
import type { CoreModules } from './core-loader.js';
import type { AppPaths } from './paths.js';
import type { RpcClient } from './rpc-client.js';
import type { SettingsStore } from './settings.js';

export interface ParticipationDeps {
  core: () => Promise<CoreModules>;
  paths: AppPaths;
  settings: SettingsStore;
  /** A client when the node of that network is reachable, otherwise null. */
  rpcIfRunning: (network: NetworkName) => RpcClient | null;
}

export class ParticipationService {
  constructor(private readonly deps: ParticipationDeps) {}

  /** The keystore's public key (stored unencrypted next to the encrypted private key; no passphrase is needed). */
  publicKey(network: NetworkName): string | null {
    const path = this.deps.paths.forNetwork(network).keystore;
    if (!existsSync(path)) return null;
    try {
      const file = JSON.parse(readFileSync(path, 'utf8')) as { publicKey?: unknown };
      return typeof file.publicKey === 'string' && /^0[23][0-9a-f]{64}$/.test(file.publicKey) ? file.publicKey : null;
    } catch {
      return null;
    }
  }

  async nodeId(network: NetworkName): Promise<string | null> {
    const key = this.publicKey(network);
    if (!key) return null;
    const core = await this.deps.core();
    try {
      return core.keys.nodeIdFromPublicKey(key);
    } catch {
      return null;
    }
  }

  /** The operator's choice, from the node's own binding file (null when absent or unusable). */
  async chosenWallet(network: NetworkName): Promise<string | null> {
    const core = await this.deps.core();
    const binding = core.agent.readNodeBinding(this.deps.paths.forNetwork(network).dataDir, core.networks.NETWORKS[network]);
    return binding?.rewardWallet ?? null;
  }

  /**
   * Record the reward wallet. No gas, no wallet signature, no key. An invalid address is refused with the reason and
   * nothing is written. Changing a wallet that the chain already holds is applied by the chain after its delay.
   */
  async bind(network: NetworkName, address: string): Promise<BindResult> {
    const core = await this.deps.core();
    const net = core.networks.NETWORKS[network];
    const wallet = address.trim();
    if (wallet.length === 0) throw new AppError('BAD_REQUEST', 'Paste the OBS address that should receive this node’s rewards.');
    if (!core.keys.isValidAddress(wallet.toLowerCase(), net.addressHrp)) {
      throw new AppError('INVALID_ADDRESS', `That is not a valid ${net.addressHrp} address for ${network}. Nothing was saved.`);
    }
    const dataDir = this.deps.paths.forNetwork(network).dataDir;
    mkdirSync(dataDir, { recursive: true });
    const binding = core.agent.writeNodeBinding(dataDir, net, wallet);
    return { rewardWallet: binding.rewardWallet, appliesTo: this.deps.rpcIfRunning(network) ? 'running-node' : 'next-start' };
  }

  async view(network: NetworkName): Promise<ParticipationView> {
    const nodeId = await this.nodeId(network);
    const chosenWallet = await this.chosenWallet(network);
    const participating = this.deps.settings.get().nodes[network].blockProduction;
    const client = this.deps.rpcIfRunning(network);
    const base: ParticipationView = {
      network,
      nodeReachable: client !== null,
      synced: null,
      nodeId,
      chosenWallet,
      record: null,
      phase: 'unknown',
      participating,
      chain: null,
      checks: [],
      notes: [],
    };
    if (!client) {
      base.phase = 'unknown';
      base.checks = [
        { label: 'Node running and synchronized', pass: null, detail: 'The node is not running. Start it from the Node screen.' },
        { label: 'Node identity', pass: nodeId ? true : null, detail: nodeId ?? 'Created the first time the node starts.' },
        { label: 'Reward wallet chosen', pass: chosenWallet !== null, detail: chosenWallet ?? 'No reward wallet yet. You can choose one now; it is saved on this computer.' },
      ];
      base.notes = notes(participating, null);
      return base;
    }
    try {
      const [health, producers, finality] = await Promise.all([client.health(), client.producers(), client.finality()]);
      const record = nodeId ? await client.nodeStatus(nodeId) : null;
      const synced = !health.syncing;
      const phase = phaseOf(record, chosenWallet);
      const checks: ParticipationCheck[] = [
        { label: 'Node running and synchronized', pass: synced, detail: synced ? `Height ${health.height}` : 'The node is still catching up. A node that is behind earns nothing.' },
        { label: 'Node identity', pass: nodeId !== null, detail: nodeId ?? 'Created the first time the node starts.' },
        { label: 'Reward wallet chosen', pass: chosenWallet !== null, detail: chosenWallet ?? 'Paste an OBS address below. Without one the node verifies and relays but earns nothing.' },
        { label: 'Block production enabled', pass: participating, detail: participating ? 'On: this node registers, sends heartbeats and produces blocks when scheduled.' : 'Off in Settings: this node follows and validates only, and does not register.' },
        { label: 'Registered on the chain', pass: record ? record.registered : false, detail: record ? (record.registered ? `Since block ${record.registeredAtHeight}` : 'The chain holds a record, but it is not active.') : 'The chain holds no record for this node yet.' },
      ];
      return {
        ...base,
        synced,
        record,
        phase,
        chain: {
          tier: producers.tier,
          eligibleProducers: producers.eligible,
          registeredNodes: producers.registered,
          bannedNodes: producers.banned,
          finalityAvailable: finality.available,
          finalizedHeight: finality.finalizedHeight,
          headHeight: finality.headHeight,
          finalityReason: finality.reason,
        },
        checks,
        notes: notes(participating, record),
      };
    } catch (error) {
      return {
        ...base,
        checks: [{ label: 'Node answered', pass: null, detail: (error as Error).message }],
      };
    }
  }
}

function phaseOf(record: NodeStatusInfo | null, chosen: string | null): ParticipationPhase {
  if (record) {
    if (record.bannedAtHeight !== null) return 'banned';
    if (record.deregisteredAtHeight !== null) return 'left';
    if (record.pendingWalletChange || (chosen !== null && record.rewardWallet !== chosen)) return 'changing';
    return record.registered ? 'registered' : 'left';
  }
  return chosen ? 'waiting' : 'no-wallet';
}

function notes(participating: boolean, record: NodeStatusInfo | null): string[] {
  const out = [
    'Rewards are paid to the wallet you choose, at the end of each reward period, in proportion to this node’s verified uptime. Nothing is bonded and nothing can be slashed from your funds.',
    'Pasting an address does not prove you own it, and nothing is signed. Rewards are only ever paid to that wallet, never taken from it.',
    'A node that is offline, still syncing or not producing earns nothing for that time. Your own computer is enough; a server is not required.',
  ];
  if (!participating) out.push('Block production is switched off in Settings, so this node will not register or earn.');
  if (record?.pendingWalletChange) out.push(`The chain will move rewards to ${record.pendingWalletChange.wallet} after its delay (from period ${record.pendingWalletChange.effectivePeriod ?? '?'}). Until then it pays the old wallet.`);
  if (record?.bannedAtHeight !== null && record?.bannedAtHeight !== undefined) out.push(`This node was banned at block ${record.bannedAtHeight} for signing two blocks on one parent. The ban is permanent for this node key.`);
  return out;
}
