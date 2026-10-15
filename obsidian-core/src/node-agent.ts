/**
 * Node participation agent (protocol 1.9.0).
 *
 * A node earns nothing by existing: rewards are paid from uptime that the CHAIN contains. This agent is the part of
 * a running node that puts that uptime on chain, using only the node's own identity key:
 *
 *   1. REGISTER   once, when the operator has bound a reward wallet (see `node-binding.json`);
 *   2. HEARTBEAT  once per uptime window, saying "I am in sync at height H" — counted only if H is within the
 *                 responsive lag of the including block, so a stalled node earns no uptime;
 *   3. ATTEST     for peers this node is CURRENTLY CONNECTED to over an authenticated link and that have shown
 *                 uptime this period — direct observation, never a rumour;
 *   4. REPORT_EQUIVOCATION when it has seen two different blocks signed by one producer on one parent.
 *
 * It never asks for, reads or logs a wallet key. The wallet is an address in a text file. Every transaction it sends
 * is signed by the node identity key, costs no gas and goes through the same admission path as any other
 * transaction: simulated against current state, then pooled and gossiped. It sends nothing on a network the operator
 * has not started this node on, and nothing at all unless block production is enabled and a binding exists.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChainManager } from './blockchain/chain.js';
import type { P2PService } from './networking/p2p.js';
import type { NetworkDefinition } from './protocol/networks.js';
import { simulateTransactions } from './blockchain/state-machine.js';
import { NodeRegistryOp, TxType, type TxEnvelope } from './protocol/types.js';
import { encodeNodeRegistryBody } from './transactions/executors/node-registry.js';
import { signTransaction } from './transactions/encode.js';
import { rewardPeriodAt, uptimeWindowIndex, uptimeWindowInPeriod } from './economy/node-rewards.js';
import { CONSENSUS_PARAMS } from './protocol/params.js';
import { PROTOCOL_VERSION } from './version.js';
import { isValidAddress } from './crypto/keys.js';
import { atomicWriteFile } from './storage/atomic.js';

export const NODE_BINDING_FILE = 'node-binding.json';

/** The operator's choice of reward wallet. An address and a timestamp — nothing secret, nothing signed. */
export interface NodeBinding {
  version: 1;
  rewardWallet: string;
  boundAt: string;
}

export function bindingPath(dataDir: string): string {
  return join(dataDir, NODE_BINDING_FILE);
}

/** Read the binding. Returns null when there is none or it is unusable (an unusable file never registers a node). */
export function readNodeBinding(dataDir: string, net: NetworkDefinition): NodeBinding | null {
  const path = bindingPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<NodeBinding>;
    if (parsed.version !== 1 || typeof parsed.rewardWallet !== 'string') return null;
    if (!isValidAddress(parsed.rewardWallet, net.addressHrp)) return null;
    // The chain only accepts the canonical lowercase form, which is the same address as its uppercase spelling.
    return { version: 1, rewardWallet: parsed.rewardWallet.toLowerCase(), boundAt: String(parsed.boundAt ?? '') };
  } catch {
    return null;
  }
}

/**
 * Record the operator's reward wallet. Validates the address for THIS network and refuses anything else, so a
 * mistyped paste is caught here and never reaches the chain. Returns the binding it wrote.
 */
export function writeNodeBinding(dataDir: string, net: NetworkDefinition, rewardWallet: string): NodeBinding {
  const wallet = rewardWallet.trim().toLowerCase();
  if (!isValidAddress(wallet, net.addressHrp)) {
    throw new Error(`that is not a valid ${net.addressHrp} address for ${net.name}`);
  }
  const binding: NodeBinding = { version: 1, rewardWallet: wallet, boundAt: new Date().toISOString() };
  atomicWriteFile(bindingPath(dataDir), `${JSON.stringify(binding, null, 2)}\n`);
  return binding;
}

export interface AgentIdentity {
  address: string;
  publicKey: string;
  privateKey: string;
  nodeId: string;
}

export interface NodeTxInput {
  op: NodeRegistryOp;
  nodeId: string;
  rewardWallet?: string;
  slot?: number;
  subject?: string;
  reportedHeight?: number;
  reason?: string;
  firstHeader?: string;
  secondHeader?: string;
}

/**
 * How long a statement stays valid: half of the protocol's maximum (the rest is slack for the block that carries it),
 * so a statement that waits in the pool is still includable and never exceeds the validUntil bound.
 */
export const STATEMENT_VALIDITY_SECONDS = Math.floor((CONSENSUS_PARAMS.tx.expiryBlocks * CONSENSUS_PARAMS.block.targetBlockSeconds) / 2);

/** Build and sign one node statement. The node key is the sender; there is no second signature and no gas. */
export function buildNodeTx(
  identity: AgentIdentity,
  chainId: number,
  nonce: number,
  protocolTime: number,
  input: NodeTxInput,
): TxEnvelope {
  const body = encodeNodeRegistryBody({
    op: input.op,
    nodeId: input.nodeId,
    rewardWallet: input.rewardWallet ?? '',
    nodePublicKey: identity.publicKey,
    proof: '',
    endpoint: undefined,
    slot: input.slot,
    subject: input.subject,
    reportedHeight: input.reportedHeight,
    reason: input.reason,
    issuedAt: undefined,
    expiresAt: undefined,
    firstHeader: input.firstHeader,
    secondHeader: input.secondHeader,
  });
  return signTransaction({
    sender: identity.address,
    privateKeyHex: identity.privateKey,
    publicKeyHex: identity.publicKey,
    chainId,
    protocolVersion: PROTOCOL_VERSION,
    nonce,
    type: TxType.NODE_REGISTRY,
    gas: 0n,
    body,
    validUntil: protocolTime + STATEMENT_VALIDITY_SECONDS,
  });
}

export interface AgentOptions {
  chain: ChainManager;
  p2p?: P2PService;
  net: NetworkDefinition;
  dataDir: string;
  identity: AgentIdentity;
  /** True when this node produces blocks (OBSIDIAN_MINING_ENABLED). Participation requires it. */
  participating: () => boolean;
  /** True while this node is behind its peers: nothing is said about a chain this node has not caught up with. */
  behind: () => boolean;
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

interface PendingEquivocation {
  producer: string;
  firstHeader: string;
  secondHeader: string;
  id: string;
}

export class NodeAgent {
  private readonly options: AgentOptions;
  private readonly queue: PendingEquivocation[] = [];
  private readonly reported = new Set<string>();
  private warnedBanned = false;

  constructor(options: AgentOptions) {
    this.options = options;
    options.chain.on('equivocation', (evidence: { producer: string; firstId: string; secondId: string; firstHeader: string; secondHeader: string }) => {
      const id = `${evidence.firstId}:${evidence.secondId}`;
      if (this.reported.has(id) || this.queue.some((item) => item.id === id)) return;
      if (this.queue.length >= 16) this.queue.shift();
      this.queue.push({ producer: evidence.producer, firstHeader: evidence.firstHeader, secondHeader: evidence.secondHeader, id });
    });
  }

  /** One pass. Safe to call at any cadence: every statement is idempotent against chain state and pool contents. */
  tick(): void {
    const { chain, identity } = this.options;
    if (!this.options.participating() || this.options.behind() || chain.isSyncing) return;
    const world = chain.world;
    const record = world.node(identity.nodeId);
    if (record && record.bannedAtHeight !== undefined) {
      if (!this.warnedBanned) {
        this.options.log('error', 'this node identity was banned for signing two blocks on one parent; it can never rejoin', {
          nodeId: identity.nodeId,
          bannedAtHeight: record.bannedAtHeight,
        });
        this.warnedBanned = true;
      }
      return;
    }
    const binding = readNodeBinding(this.options.dataDir, this.options.net);
    const timestamp = chain.protocolTime;
    let nonce = this.nextNonce();
    const send = (input: NodeTxInput): boolean => {
      const tx = buildNodeTx(identity, this.options.net.chainId, nonce, timestamp, input);
      if (this.submit(tx, input.op)) {
        nonce += 1;
        return true;
      }
      return false;
    };

    if (!record || record.deregisteredAtHeight !== undefined) {
      if (!binding) return; // not bound: this node verifies and relays, and earns nothing.
      send({ op: NodeRegistryOp.REGISTER, nodeId: identity.nodeId, rewardWallet: binding.rewardWallet });
      return;
    }

    if (
      binding &&
      record.rewardWallet !== binding.rewardWallet &&
      record.pendingWallet !== binding.rewardWallet &&
      record.reclaimEffectivePeriod === undefined
    ) {
      send({ op: NodeRegistryOp.CHANGE_WALLET, nodeId: identity.nodeId, rewardWallet: binding.rewardWallet });
    }

    const period = rewardPeriodAt(timestamp);
    const evidence = world.nodeEvidence(period, identity.nodeId);
    const window = uptimeWindowIndex(timestamp);
    const bit = 1 << uptimeWindowInPeriod(timestamp);
    if (((evidence?.liveWindows ?? 0) & bit) === 0 && !this.pendingOfOp(NodeRegistryOp.HEARTBEAT)) {
      send({ op: NodeRegistryOp.HEARTBEAT, nodeId: identity.nodeId, slot: window, reportedHeight: chain.height });
    }

    // Equivocation reports first: they are the only statements that remove a misbehaving identity.
    for (const item of this.queue.splice(0, 2)) {
      const subject = world.nodeByProducer(item.producer);
      if (!subject || subject.bannedAtHeight !== undefined) continue;
      if (send({ op: NodeRegistryOp.REPORT_EQUIVOCATION, nodeId: subject.nodeId, firstHeader: item.firstHeader, secondHeader: item.secondHeader })) {
        this.reported.add(item.id);
      }
    }

    this.attestConnectedPeers(period, send);
  }

  /** Attest only peers this node is connected to right now, that are registered and have shown uptime this period. */
  private attestConnectedPeers(period: number, send: (input: NodeTxInput) => boolean): void {
    const { chain, p2p, identity } = this.options;
    if (!p2p) return;
    const mine = chain.world.nodeEvidence(period, identity.nodeId);
    const done = new Set(mine?.attested ?? []);
    let budget = 4;
    for (const connection of p2p.activeConnections()) {
      if (budget <= 0) break;
      const subject = chain.world.node(connection.nodeId);
      if (!subject || subject.nodeId === identity.nodeId) continue;
      if (subject.deregisteredAtHeight !== undefined || subject.bannedAtHeight !== undefined) continue;
      if (done.has(subject.nodeId)) continue;
      if ((chain.world.nodeEvidence(period, subject.nodeId)?.liveWindows ?? 0) === 0) continue;
      if (send({ op: NodeRegistryOp.ATTEST, nodeId: identity.nodeId, subject: subject.nodeId, slot: period })) {
        done.add(subject.nodeId);
        budget -= 1;
      }
    }
  }

  /** Account nonce plus whatever this node already has waiting in the pool. */
  private nextNonce(): number {
    const { chain, identity } = this.options;
    const account = chain.world.getAccount(identity.address);
    const pending = chain.mempool.snapshot().filter((entry) => entry.sender === identity.address).length;
    return (account?.nonce ?? 0) + pending;
  }

  private pendingOfOp(op: NodeRegistryOp): boolean {
    const { chain, identity } = this.options;
    for (const entry of chain.mempool.snapshot()) {
      if (entry.sender !== identity.address) continue;
      const pooled = chain.mempool.get(entry.txId);
      if (pooled && pooled.tx.body[0] === op) return true;
    }
    return false;
  }

  private submit(tx: TxEnvelope, op: NodeRegistryOp): boolean {
    const { chain, p2p, net } = this.options;
    const simulation = simulateTransactions(
      chain.world,
      [tx],
      { height: chain.height + 1, timestamp: chain.protocolTime, chainId: net.chainId, producer: '' },
      net,
    );
    const outcome = simulation.results[0];
    if (!outcome?.ok) {
      this.options.log('debug', 'node statement not sent: it would not apply to the current state', {
        op: NodeRegistryOp[op],
        reason: outcome?.error,
      });
      return false;
    }
    const admission = chain.mempool.add(tx);
    if (!admission.accepted) {
      this.options.log('debug', 'node statement not pooled', { op: NodeRegistryOp[op], reason: admission.reason });
      return false;
    }
    p2p?.broadcastTransaction(tx);
    this.options.log('info', 'node statement sent', { op: NodeRegistryOp[op], txId: tx.id });
    return true;
  }
}

/** Seconds between agent passes. A pass is cheap; the cadence only bounds how late a statement can be. */
export const AGENT_INTERVAL_SECONDS = Math.max(5, Math.floor(CONSENSUS_PARAMS.nodeRewards.uptimeWindowSeconds / 120));
