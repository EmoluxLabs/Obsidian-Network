/**
 * N-01 — the node production loop acts on the decision committed state produces.
 *
 * Consensus answers "who may produce this height?" with one of two things (`producerDecision` in
 * consensus/schedule.ts): OPEN (no node is registered: the founding state) or SCHEDULED (a named producer). Protocol
 * 1.9.0 has NO halted state: if every registered node is unavailable the schedule falls back to the registered set
 * (tier 2) instead of stopping, so there is nothing for a loop to misread as "anyone may produce".
 *
 * These tests pin both ends:
 *   - the decision the loop consumes, computed from REAL committed state (registration, deregistration, restart); and
 *   - the loop itself, driven through the real `setInterval` production loop of a real started node, asserting what it
 *     does and does not do in each state.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNode, type NodeRuntimeInfo } from '../../src/node.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { ChainManager } from '../../src/blockchain/chain.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { addressFromPublicKey } from '../../src/crypto/keys.js';
import { producerDecision, producerSetFor } from '../../src/consensus/schedule.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import {
  createHarness,
  makeNode,
  makeWallet,
  nodeSigner,
  nodeStatement,
  registerNode,
  type Harness,
} from '../helpers/harness.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runtimes: NodeRuntimeInfo[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
  vi.useRealTimers();
});

// ── the decision, from real committed state ────────────────────────────────

async function chainHarness(): Promise<Harness> {
  const h = await createHarness();
  harnesses.push(h);
  h.produce();
  return h;
}

describe('N-01 the production decision comes from committed state', () => {
  it('TEST 1 — OPEN: before any registration the decision is OPEN and any key may produce', async () => {
    const h = await chainHarness();
    expect(h.chain.world.registeredNodes()).toHaveLength(0);
    expect(h.chain.productionDecisionNow()).toEqual({ kind: 'OPEN' });
    // null from the schedule accessor means "open founding state", and only that.
    expect(h.chain.scheduledProducerNow()).toBeNull();
  });

  it('TEST 2 — SCHEDULED: once a node registers the decision names it, and only it', async () => {
    const h = await chainHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const decision = h.chain.productionDecisionNow();
    expect(decision.kind).toBe('SCHEDULED');
    if (decision.kind === 'SCHEDULED') {
      expect(decision.producer).toBe(node.address);
      expect(decision.setSize).toBe(1);
      // A single young node is not mature yet: the chain still runs on tier 2 instead of stopping.
      expect(decision.tier).toBe('TIER2');
    }
    expect(h.chain.scheduledProducerNow()).toBe(node.address);
    // The outsider key that produced before registration may not produce now.
    expect(h.chain.buildNextBlock({ ...h.producer })).toBeNull();
  });

  it('TEST 3 — no halt: a lone node whose heartbeat lapsed is still scheduled (tier 2), the chain never stops', async () => {
    const h = await chainHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    // Evaluate the schedule a month after the node's last sign of life: it is no longer tier 1 (not live), yet it
    // is still the schedule. The set falls back to the registered nodes instead of emptying.
    const lapsed = h.chain.world.s.timestamp + 30 * 24 * 3600;
    const set = producerSetFor(h.chain.world, h.chain.height + 1, lapsed);
    expect(set.tier).toBe('TIER2');
    expect(set.producers).toEqual([node.address]);
    const decision = producerDecision(h.chain.world, h.chain.height + 1, 0, lapsed);
    expect(decision.kind).toBe('SCHEDULED');
    // The decision type has no halted variant at all.
    expect(['OPEN', 'SCHEDULED']).toContain(decision.kind);
  });

  it('TEST 4 — deregistering the last node returns to the founding OPEN state, never to a halt', async () => {
    const h = await chainHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.DEREGISTER })], { producer: nodeSigner(node) });
    expect(h.chain.world.registeredNodes()).toHaveLength(0);
    expect(h.chain.productionDecisionNow()).toEqual({ kind: 'OPEN' });
  });

  it('TEST 5 — restart: a restored chain makes the same decision from storage', async () => {
    const h = await chainHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const before = h.chain.productionDecisionNow();

    // A second ChainManager over the same directory is a restart: it rebuilds the head state from storage and
    // snapshots, exactly as a node does.
    const restored = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: {
        networkId: h.net.networkId,
        chainId: h.net.chainId,
        protocolVersion: h.chain.genesisDocument.protocolVersion,
        timestamp: h.chain.genesisDocument.timestamp,
        note: h.chain.genesisDocument.note,
        miningGatePublicKeys: h.chain.genesisDocument.miningGatePublicKeys ?? [],
      },
      enforceProposerRotation: true,
    });
    await restored.init();
    expect(restored.height).toBe(h.chain.height);
    expect(restored.productionDecisionNow()).toEqual(before);
    expect(restored.scheduledProducerNow()).toBe(node.address);
    expect(restored.world.nodeByRewardWallet(node.wallet.address)).toBe(node.nodeId);
  });
});

// ── the loop itself ────────────────────────────────────────────────────────

async function startMiningNode(): Promise<NodeRuntimeInfo> {
  const net = getNetwork('devnet');
  const dir = mkdtempSync(join(tmpdir(), 'obs-n01-'));
  const runtime = await startNode({
    config: {
      ...DEFAULT_CONFIG,
      network: 'devnet',
      dataDir: dir,
      keystorePath: join(dir, 'node-key.json'),
      rpcEnabled: false,
      p2pEnabled: false,
      miningEnabled: true,
      blockProductionIntervalSeconds: 1,
      logLevel: 'error',
    },
    net,
    source: 'test',
    warnings: [],
    offline: true,
  });
  runtimes.push(runtime);
  return runtime;
}

/** Let the real production interval fire `ticks` times. */
async function ticks(count: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, count * 1_200));
}

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.stop();
});

describe('N-01 the production loop honours the two states', () => {
  it('TEST 1 — OPEN: before any node is registered the founding state lets a node produce', async () => {
    const runtime = await startMiningNode();
    expect(runtime.chain.productionDecisionNow().kind).toBe('OPEN');
    await ticks(3);
    // Bootstrap production is untouched: the loop builds, the chain accepts.
    expect(runtime.chain.height).toBeGreaterThan(0);
  });

  it('TEST 3 — SCHEDULED for someone else: this node stays idle', async () => {
    const runtime = await startMiningNode();
    const build = vi.spyOn(runtime.chain, 'buildNextBlock');
    vi.spyOn(runtime.chain, 'productionDecisionNow').mockReturnValue({
      kind: 'SCHEDULED',
      producer: 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
      tier: 'TIER1',
      setSize: 3,
    });

    await ticks(3);
    expect(build).not.toHaveBeenCalled();
    expect(runtime.chain.height).toBe(0);
  });

  it('TEST 2 — SCHEDULED for this node: the loop still attempts production', async () => {
    const runtime = await startMiningNode();
    const build = vi.spyOn(runtime.chain, 'buildNextBlock');
    // The node's own on-chain address, derived from the public key the runtime
    // reports. Whether the resulting block is accepted is consensus's business
    // and is covered by the suites that test acceptance; what is under test here
    // is that the loop does not idle when it is this node's turn.
    const own = addressFromPublicKey(runtime.publicKey, runtime.config.net.addressHrp);
    vi.spyOn(runtime.chain, 'productionDecisionNow').mockReturnValue({ kind: 'SCHEDULED', producer: own, tier: 'TIER1', setSize: 1 });

    await ticks(2);
    expect(build).toHaveBeenCalled();
  });
});
