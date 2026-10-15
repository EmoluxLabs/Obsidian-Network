/**
 * The local safety record: a node's memory of what it already treated as final and of the one block it signed on a
 * parent. Both facts must survive a restart, and tampering with them must stop the node instead of being forgotten.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { ChainManager } from '../../src/blockchain/chain.js';
import { SafetyStore } from '../../src/storage/safety-store.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import { createHarness, makeNode, makeWallet, nodeSigner, nodeStatement, type Harness } from '../helpers/harness.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

async function fresh(): Promise<Harness> {
  const h = await createHarness();
  harnesses.push(h);
  h.produce([]);
  return h;
}

const reopen = (h: Harness) =>
  new ChainManager({ dataDir: h.dir, net: h.net, genesisDocument: h.chain.genesisDocument, enforceProposerRotation: true });

describe('safety record integrity', () => {
  it('round-trips, carries a checksum, and holds no secret', async () => {
    const h = await fresh();
    const store = new SafetyStore(h.dir);
    const record = store.load()!;
    expect(record.finalizedHeight).toBe(0);
    expect(record.lastSigned).toBeNull();
    store.save({ ...record, lastSigned: { height: 1, parentHash: 'ab'.repeat(32) } });
    expect(store.load()!.lastSigned).toEqual({ height: 1, parentHash: 'ab'.repeat(32) });
    expect(readFileSync(store.path, 'utf8')).not.toMatch(/private|secret|seed/i);
  });

  it('refuses to start over a record that was edited without its checksum', async () => {
    const h = await fresh();
    const path = new SafetyStore(h.dir).path;
    const envelope = JSON.parse(readFileSync(path, 'utf8'));
    envelope.record.finalizedHeight = 0;
    envelope.record.lastSigned = { height: 99, parentHash: 'cd'.repeat(32) };
    writeFileSync(path, JSON.stringify(envelope));
    await expect(reopen(h).init()).rejects.toThrow(/checksum/);
  });

  it('refuses to start over a corrupted or truncated record rather than forgetting what it held', async () => {
    const h = await fresh();
    const path = new SafetyStore(h.dir).path;
    writeFileSync(path, '{"checksum":"x","record":');
    await expect(reopen(h).init()).rejects.toThrow(/not valid JSON/);
    writeFileSync(path, '{}');
    await expect(reopen(h).init()).rejects.toThrow(/malformed/);
  });

  it('refuses a record that belongs to another network or protocol', async () => {
    const h = await fresh();
    const store = new SafetyStore(h.dir);
    const record = store.load()!;
    store.save({ ...record, genesisId: 'ff'.repeat(20) });
    await expect(reopen(h).init()).rejects.toThrow(/different network or protocol/);
    store.save({ ...record, protocolVersion: '1.8.2' });
    await expect(reopen(h).init()).rejects.toThrow(/different network or protocol/);
  });

  it('refuses a data directory whose chain reports a LOWER finalized height than this node recorded (rollback)', async () => {
    const h = await fresh();
    const store = new SafetyStore(h.dir);
    store.save({ ...store.load()!, finalizedHeight: 5, finalizedHash: 'ee'.repeat(32) });
    await expect(reopen(h).init()).rejects.toThrow(/finality regressed/);
  });
});

describe('the double-sign lock', () => {
  it('survives a restart: a node that signed on a parent will not sign a second block on it', async () => {
    const h = await fresh();
    const node = makeNode(makeWallet());
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.REGISTER })]);
    const signer = nodeSigner(node);

    const first = h.chain.buildNextBlock(signer);
    expect(first).not.toBeNull();
    expect(h.chain.buildNextBlock(signer)).toBeNull();
    expect(new SafetyStore(h.dir).load()!.lastSigned).toEqual({ height: first!.header.height, parentHash: first!.header.prevHash });

    // A restart does not forget it: the lock is on disk before the signature exists.
    const restarted = reopen(h);
    await restarted.init();
    expect(restarted.height).toBe(h.chain.height);
    expect(restarted.buildNextBlock(signer)).toBeNull();
  });
});
