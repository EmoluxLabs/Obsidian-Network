/**
 * The node agent: the part of a running node that turns "I am registered and online" into on-chain statements.
 *
 * It runs against a real chain, real mempool and real executors. The only stand-in is the peer list handed to the
 * attestation step (a two-method object), because opening sockets is the job of the p2p suites.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeAgent, bindingPath, buildNodeTx, readNodeBinding, writeNodeBinding, type AgentIdentity } from '../../src/node-agent.js';
import { producerDecision } from '../../src/consensus/schedule.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { NodeRegistryOp, type TxEnvelope } from '../../src/protocol/types.js';
import { decodeNodeRegistryBody } from '../../src/transactions/executors/node-registry.js';
import {
  createHarness,
  makeNode,
  makeWallet,
  nodeSigner,
  nodeStatement,
  type Harness,
  type TestNode,
} from '../helpers/harness.js';

const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const harnesses: Harness[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const identityOf = (node: TestNode): AgentIdentity => ({
  address: node.address,
  publicKey: node.publicKey,
  privateKey: node.privateKey,
  nodeId: node.nodeId,
});

interface Rig {
  h: Harness;
  node: TestNode;
  dataDir: string;
  agent: NodeAgent;
  logs: string[];
  flags: { participating: boolean; behind: boolean };
}

async function rig(): Promise<Rig> {
  const h = await createHarness();
  harnesses.push(h);
  h.produce([]);
  const node = makeNode(makeWallet());
  const dataDir = mkdtempSync(join(tmpdir(), 'obsidian-agent-'));
  dirs.push(dataDir);
  const logs: string[] = [];
  const flags = { participating: true, behind: false };
  const agent = new NodeAgent({
    chain: h.chain,
    net: h.net,
    dataDir,
    identity: identityOf(node),
    participating: () => flags.participating,
    behind: () => flags.behind,
    log: (level, message, fields) => logs.push(`${level} ${message} ${JSON.stringify(fields ?? {})}`),
  });
  return { h, node, dataDir, agent, logs, flags };
}

const pooledOps = (r: Rig): NodeRegistryOp[] =>
  r.h.chain.mempool.snapshot().map((entry) => decodeNodeRegistryBody(r.h.chain.mempool.get(entry.txId)!.tx.body).op);

function mine(r: Rig): void {
  const txs: TxEnvelope[] = r.h.chain.mempool.snapshot().map((entry) => r.h.chain.mempool.get(entry.txId)!.tx);
  r.h.produce(txs);
  r.h.chain.mempool.removeMany(txs.map((tx) => tx.id));
  // Once registered, the node is the only party the schedule will accept.
  r.h.signers.set(r.node.address, nodeSigner(r.node));
}

describe('binding file', () => {
  it('stores only an address and a timestamp, normalises case, and refuses anything that is not an address', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-bind-'));
    dirs.push(dir);
    const wallet = makeWallet();
    const written = writeNodeBinding(dir, h.net, `  ${wallet.address.toUpperCase()} `);
    expect(written.rewardWallet).toBe(wallet.address);
    const raw = readFileSync(bindingPath(dir), 'utf8');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['boundAt', 'rewardWallet', 'version']);
    expect(raw).not.toMatch(/private|secret|seed|phrase/i);
    expect(readNodeBinding(dir, h.net)?.rewardWallet).toBe(wallet.address);

    for (const bad of ['', 'hello', wallet.address.slice(0, -2), wallet.address.replace(/^dobs1/, 'obs1'), `${wallet.address}x`]) {
      expect(() => writeNodeBinding(dir, h.net, bad), bad).toThrow();
    }
    // The failed attempts left the good binding alone.
    expect(readNodeBinding(dir, h.net)?.rewardWallet).toBe(wallet.address);
    // A corrupted file never registers anything.
    writeFileSync(bindingPath(dir), '{"version":1,"rewardWallet":"nope"}');
    expect(readNodeBinding(dir, h.net)).toBeNull();
    writeFileSync(bindingPath(dir), '{not json');
    expect(readNodeBinding(dir, h.net)).toBeNull();
  });
});

describe('what the agent says, and when', () => {
  it('stays silent until the operator has bound a wallet: an unbound node verifies and relays, and earns nothing', async () => {
    const r = await rig();
    r.agent.tick();
    expect(pooledOps(r)).toEqual([]);
    expect(r.h.chain.world.node(r.node.nodeId)).toBeUndefined();
  });

  it('registers once with the bound wallet, signed by the node key only, and a second pass adds nothing', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    r.agent.tick();
    expect(pooledOps(r)).toEqual([NodeRegistryOp.REGISTER]);
    const tx = r.h.chain.mempool.get(r.h.chain.mempool.snapshot()[0].txId)!.tx;
    expect(tx.sender).toBe(r.node.address);
    expect(tx.gas).toBe(0n);
    expect(decodeNodeRegistryBody(tx.body).rewardWallet).toBe(r.node.wallet.address);
    r.agent.tick();
    expect(pooledOps(r)).toEqual([NodeRegistryOp.REGISTER]);

    mine(r);
    expect(r.h.chain.world.node(r.node.nodeId)?.rewardWallet).toBe(r.node.wallet.address);
    // Registered, but the registering block was not its own: the window is unproven, so the next thing it says is a
    // heartbeat. Once that block is mined (or the node produces a block itself) it has nothing left to add.
    r.agent.tick();
    expect(pooledOps(r)).toEqual([NodeRegistryOp.HEARTBEAT]);
    mine(r);
    r.agent.tick();
    expect(pooledOps(r)).toEqual([]);
  });

  it('says a heartbeat for a window it has not yet proven, and only one', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    const other = makeNode(makeWallet());
    r.agent.tick();
    r.h.produce([...r.h.chain.mempool.snapshot().map((e) => r.h.chain.mempool.get(e.txId)!.tx), nodeStatement(r.h, other, { op: NodeRegistryOp.REGISTER })]);
    r.h.chain.mempool.removeMany(r.h.chain.mempool.snapshot().map((e) => e.txId));
    r.h.signers.set(r.node.address, nodeSigner(r.node));
    r.h.signers.set(other.address, nodeSigner(other));
    // Let the OTHER node take the next block (on its own slot, or one round late when the slot is ours).
    const head = r.h.chain.tip!;
    const onTime = r.h.chain.protocolTime;
    const first = producerDecision(r.h.chain.world, head.height + 1, 0, onTime);
    const ts = first.kind === 'SCHEDULED' && first.producer === other.address ? onTime : onTime + 2 * SLOT;
    r.h.produce([], { timestamp: ts, producer: nodeSigner(other) });

    r.agent.tick();
    expect(pooledOps(r)).toEqual([NodeRegistryOp.HEARTBEAT]);
    r.agent.tick();
    expect(pooledOps(r)).toEqual([NodeRegistryOp.HEARTBEAT]);
  });

  it('does nothing while it is not participating, while it is behind its peers, or while it is syncing', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    r.flags.participating = false;
    r.agent.tick();
    r.flags.participating = true;
    r.flags.behind = true;
    r.agent.tick();
    r.flags.behind = false;
    r.h.chain.setSyncing(true);
    r.agent.tick();
    r.h.chain.setSyncing(false);
    expect(pooledOps(r)).toEqual([]);
    r.agent.tick();
    expect(pooledOps(r)).toEqual([NodeRegistryOp.REGISTER]);
  });

  it('proposes a wallet change when the operator rebinds, instead of silently replacing the registered wallet', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    r.agent.tick();
    mine(r);
    const next = makeWallet();
    writeNodeBinding(r.dataDir, r.h.net, next.address);
    r.agent.tick();
    expect(pooledOps(r)).toContain(NodeRegistryOp.CHANGE_WALLET);
    mine(r);
    const record = r.h.chain.world.node(r.node.nodeId)!;
    expect(record.rewardWallet).toBe(r.node.wallet.address);
    expect(record.pendingWallet).toBe(next.address);
  });

  it('goes quiet for good once its identity is banned', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    r.agent.tick();
    mine(r);
    r.h.chain.world.node(r.node.nodeId)!.bannedAtHeight = r.h.chain.height;
    r.agent.tick();
    r.agent.tick();
    expect(pooledOps(r)).toEqual([]);
    expect(r.logs.filter((line) => line.includes('banned')).length).toBe(1);
  });

  it('turns an equivocation it witnesses into a report, once', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    r.agent.tick();
    mine(r);
    r.h.signers.set(r.node.address, nodeSigner(r.node));
    // A second node that double-signs: the agent's chain sees both blocks.
    const cheater = makeNode(makeWallet());
    r.h.produce([nodeStatement(r.h, cheater, { op: NodeRegistryOp.REGISTER })]);
    r.h.signers.set(cheater.address, nodeSigner(cheater));
    // Wait for the cheater's own slot, so that both of its blocks are valid on their own and the chain keeps both.
    for (let i = 0; i < 4; i += 1) {
      const next = producerDecision(r.h.chain.world, r.h.chain.height + 1, 0, r.h.chain.protocolTime);
      if (next.kind === 'SCHEDULED' && next.producer === cheater.address) break;
      r.h.produce([]);
    }
    const head = r.h.chain.tip!;
    const parent = { hash: head.hash, height: head.height, cumulativePotWeight: BigInt(head.cumulativePotWeight), state: r.h.chain.world };
    const ts = r.h.chain.protocolTime;
    const seen: unknown[] = [];
    r.h.chain.on('equivocation', (evidence) => seen.push(evidence));
    const a = r.h.makeBlockOn(parent, [], { timestamp: ts, producer: nodeSigner(cheater) }).block;
    const b = r.h.makeBlockOn(parent, [], { timestamp: ts + 1, producer: nodeSigner(cheater) }).block;
    expect(r.h.chain.addBlock(a).accepted).toBe(true);
    r.h.chain.addBlock(b);
    expect(seen).toHaveLength(1);

    const reports = () => pooledOps(r).filter((op) => op === NodeRegistryOp.REPORT_EQUIVOCATION).length;
    r.agent.tick();
    expect(reports()).toBe(1);
    r.agent.tick();
    expect(reports()).toBe(1);
    mine(r);
    expect(r.h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeDefined();
  });
});

describe('the agent never exposes the node key', () => {
  it('writes no key material to the binding file or the log, and a built statement carries only the public key', async () => {
    const r = await rig();
    writeNodeBinding(r.dataDir, r.h.net, r.node.wallet.address);
    r.agent.tick();
    mine(r);
    r.agent.tick();
    const everything = `${readFileSync(bindingPath(r.dataDir), 'utf8')}\n${r.logs.join('\n')}`;
    expect(everything).not.toContain(r.node.privateKey);
    const tx = buildNodeTx(identityOf(r.node), r.h.net.chainId, 0, r.h.chain.protocolTime, { op: NodeRegistryOp.REGISTER, nodeId: r.node.nodeId, rewardWallet: r.node.wallet.address });
    expect(JSON.stringify(tx, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain(r.node.privateKey);
  });
});
