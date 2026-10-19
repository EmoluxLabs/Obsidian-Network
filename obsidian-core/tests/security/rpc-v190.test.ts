/**
 * What the node tells the world under protocol 2.0.0: producers, finality, node registry and name ownership. These read
 * the real routes of a real RPC server over a chain built from real blocks; none of it is a fixture.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RpcServer } from '../../src/rpc/server.js';
import { Indexer } from '../../src/indexer/indexer.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { NodeRegistryOp, OnsOp, TxType } from '../../src/protocol/types.js';
import { CORE_VERSION, PROTOCOL_VERSION } from '../../src/version.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { createHarness, makeNode, makeWallet, nodeSigner, nodeStatement, onsBody, signedClaim, type Harness } from '../helpers/harness.js';

const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const servers: RpcServer[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (harnesses.length) harnesses.pop()!.close();
});

async function serve(h: Harness): Promise<string> {
  const config: NodeConfig = { ...DEFAULT_CONFIG, network: 'devnet', rpcPort: 0, rpcHost: '127.0.0.1', rpcCorsOrigins: [], rpcRateLimitPerMinute: 0, dataDir: h.dir };
  const server = new RpcServer({ chain: h.chain, indexer: new Indexer(h.dir), net: h.net, config, genesisId: computeGenesisId(h.chain.genesisDocument, h.net), log: () => undefined });
  servers.push(server);
  return `http://127.0.0.1:${await server.listen()}`;
}

const get = async (base: string, path: string) => {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { status: response.status, text, json: text.startsWith('{') ? JSON.parse(text) : undefined };
};

async function networkWithNodes(count: number) {
  const h = await createHarness();
  harnesses.push(h);
  const nodes = Array.from({ length: count }, () => makeNode(makeWallet()));
  for (let i = 0; i < nodes.length; i += CONSENSUS_PARAMS.consensus.producers.maxRegistrationsPerBlock) {
    const batch = nodes.slice(i, i + CONSENSUS_PARAMS.consensus.producers.maxRegistrationsPerBlock);
    const ts = h.chain.tip!.timestamp + SLOT;
    h.produce(batch.map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })), { timestamp: ts });
    for (const node of batch) h.signers.set(node.address, nodeSigner(node));
  }
  return { h, nodes, base: await serve(h) };
}

describe('GET /finality and /producers', () => {
  it('says finality is unavailable below the minimum producer count, and says what it is not', async () => {
    const { base } = await networkWithNodes(2);
    const { status, json } = await get(base, '/finality');
    expect(status).toBe(200);
    expect(json.available).toBe(false);
    expect(json.finalizedHeight).toBe(0);
    expect(json.minProducers).toBe(CONSENSUS_PARAMS.consensus.finality.minProducers);
    expect(json.reason).toMatch(/unavailable/);
    expect(json.assumptions).toMatch(/not BFT/);
    expect(JSON.stringify(json)).not.toMatch(/vote|validator|committee/i);
  });

  it('lists the schedule with masked producer addresses and no validator vocabulary', async () => {
    const { base, nodes } = await networkWithNodes(3);
    const { status, json, text } = await get(base, '/producers');
    expect(status).toBe(200);
    expect(json.tier).toBe('TIER2');
    expect(json.eligible).toBe(3);
    expect(json.registered).toBe(3);
    expect(json.nodes).toHaveLength(3);
    for (const node of nodes) {
      expect(text).not.toContain(node.address);
      expect(text).not.toContain(node.privateKey);
      expect(json.nodes.some((entry: { nodeId: string }) => entry.nodeId === node.nodeId)).toBe(true);
    }
    // Three nodes exist but none is established yet (maturity), so finality is honestly unavailable.
    expect(json.finality.available).toBe(false);
    expect(json.finality.reason).toMatch(/established producer/);
    expect(json.penalties).toMatch(/Nothing is bonded/);
  });

  it('has no /validators route any more', async () => {
    const { base } = await networkWithNodes(1);
    expect((await get(base, '/validators')).status).toBe(404);
  });
});

describe('node registry routes', () => {
  it('serve the bound wallet and the recorded uptime, and never a key', async () => {
    const { base, nodes } = await networkWithNodes(1);
    const { status, json, text } = await get(base, `/nodes/status/${nodes[0].nodeId}`);
    expect(status).toBe(200);
    expect(json.rewardWallet).toBe(nodes[0].wallet.address);
    expect(json.registered).toBe(true);
    expect(json.bannedAtHeight).toBeNull();
    expect(json.evidence).toHaveProperty('liveWindows');
    expect(json.evidence).toHaveProperty('expectedWindows', CONSENSUS_PARAMS.nodeRewards.uptimeWindowsPerPeriod);
    expect(text).not.toContain(nodes[0].privateKey);
    expect((await get(base, `/nodes/status/${'0'.repeat(64)}`)).status).toBe(404);

    const registry = await get(base, '/nodes/registry');
    expect(registry.json.registeredNodes).toBe(1);
    const rewards = await get(base, '/nodes/rewards');
    expect(rewards.json.split.nodePoolBps).toBe(9000);
    expect(rewards.json.pool).not.toHaveProperty('bondedObs');
  });
});

describe('status, params and metrics', () => {
  it('report the core and protocol versions and expose producer and finality parameters instead of a bond', async () => {
    const { base } = await networkWithNodes(3);
    const status = (await get(base, '/status')).json;
    expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(status.nodes).toBe(3);
    expect(status.scheduleTier).toBe('TIER2');
    expect(status).toHaveProperty('finalizedHeight');
    expect((await get(base, '/version')).json.coreVersion ?? CORE_VERSION).toBe('2.0.3');
    const params = (await get(base, '/params')).json;
    expect(params.consensus.producers.maturityBlocks).toBe(CONSENSUS_PARAMS.consensus.producers.maturityBlocks);
    expect(params.consensus.finality.minProducers).toBe(2);
    expect(params.consensus.validatorBondObs).toBeUndefined();
    expect(JSON.stringify(params)).not.toMatch(/validator/i);
    const metrics = (await get(base, '/metrics')).text;
    expect(metrics).toMatch(/obsidian_nodes\b/);
    expect(metrics).toMatch(/obsidian_finalized_height\b/);
    expect(metrics).not.toMatch(/validator/i);
  });
});

describe('GET /names/:name exposes ownership state', () => {
  it('shows an open offer and a recovery address so recipients and owners can see them', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const base = await serve(h);
    const genesisTs = 1_767_225_600;
    const alice = makeWallet();
    const bob = makeWallet();
    const carol = makeWallet();
    h.produce([signedClaim(h, alice, genesisTs + 100)], { timestamp: genesisTs + 100 });
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee), protocolTime: genesisTs + 101 })], { timestamp: genesisTs + 101 });
    const plain = (await get(base, '/names/alice')).json;
    expect(plain).toMatchObject({ owner: alice.address, pendingTransfer: null, recoveryAddress: null, pendingRecovery: null });

    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.TRANSFER, 'alice', { to: bob.address }), { protocolTime: genesisTs + 110 })], { timestamp: genesisTs + 110 });
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.SET_RECOVERY, 'alice', { address: carol.address }), { protocolTime: genesisTs + 120 })], { timestamp: genesisTs + 120 });
    const after = (await get(base, '/names/alice.obs')).json;
    expect(after.owner).toBe(alice.address);
    expect(after.pendingTransfer.to).toBe(bob.address);
    expect(after.recoveryAddress).toBe(carol.address);
  });
});
