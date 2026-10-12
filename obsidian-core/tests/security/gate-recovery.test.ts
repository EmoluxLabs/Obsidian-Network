/**
 * Gate authority: recovery, restart and convergence (protocol 1.8.0).
 *
 * gate-authority.test.ts proves what a block may do. These prove what an OPERATOR relies on: that the rotated set
 * survives a restart, that a node which was offline during a rotation or a revocation ends in the same place as one
 * that watched it, that a lost key can be replaced and never resurrected, that losing the quorum fails SAFE (nothing
 * changes, mining under the surviving key goes on), and that none of it needs a private key on any node.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ChainManager } from '../../src/blockchain/chain.js';
import { keyPairFromPrivateKey } from '../../src/crypto/keys.js';
import { GateAuthorityOp, TxType, type Block, type GateAuthorityBody } from '../../src/protocol/types.js';
import { computeClaimId, encodeMiningBody } from '../../src/transactions/executors/mining.js';
import { issueMiningGateCertificate } from '../../src/mining/gate.js';
import { approveGateUpdate, encodeGateAuthorityBody } from '../../src/mining/gate-authority.js';
import { GATE_ISSUER, advance, createHarness, makeWallet, type Harness } from '../helpers/harness.js';

const K1 = GATE_ISSUER;
const K2 = keyPairFromPrivateKey('33'.repeat(32));
const K3 = keyPairFromPrivateKey('44'.repeat(32));
const K4 = keyPairFromPrivateKey('55'.repeat(32));
type Pair = typeof K1;

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
async function node(keys: Pair[] = [K1, K2, K3]): Promise<Harness> {
  const h = await createHarness({ miningGatePublicKeys: keys.map((k) => k.publicKey) });
  open.push(h);
  return h;
}
const ctxOf = (h: Harness) => ({ networkId: h.net.networkId, chainId: h.net.chainId });
function update(h: Harness, change: { add?: Pair[]; remove?: Pair[]; approvers: Pair[]; epoch?: number }) {
  const add = (change.add ?? []).map((k) => k.publicKey);
  const remove = (change.remove ?? []).map((k) => k.publicKey);
  const epoch = change.epoch ?? h.chain.world.s.genesis.gateEpoch + 1;
  const body: GateAuthorityBody = {
    op: GateAuthorityOp.UPDATE,
    epoch,
    add,
    remove,
    approvals: change.approvers.map((k) => approveGateUpdate(k.privateKey, k.publicKey, ctxOf(h), epoch, add, remove)),
  };
  return h.sign(makeWallet(), TxType.GATE_AUTHORITY, encodeGateAuthorityBody(body), { gas: 0n });
}
function claim(h: Harness, issuer: Pair) {
  const wallet = makeWallet();
  const claimId = computeClaimId(h.net.chainId, wallet.address, 1, 0);
  const gate = issueMiningGateCertificate(issuer.privateKey, issuer.publicKey, { networkId: h.net.networkId, chainId: h.net.chainId, address: wallet.address, claimId }, h.chain.protocolTime);
  return h.sign(wallet, TxType.MINING_CLAIM, encodeMiningBody({ claimId, claimSequence: 1, gate }), { gas: 0n });
}
/** A refusal is only evidence if it is refused FOR THE RIGHT REASON: a block built with simulate:false would also fail on its roots. */
const refusedFor = (outcome: { accepted: boolean; message?: string }, reason: RegExp): void => {
  expect(outcome.accepted).toBe(false);
  expect(outcome.message ?? '').toMatch(reason);
};
const gateOf = (c: ChainManager) => {
  const g = c.world.s.genesis;
  return { active: [...g.gateKeysActive], revoked: [...g.gateKeysRevoked], epoch: g.gateEpoch };
};

describe('restart', () => {
  it('a rotated and revoked gate set survives a restart from disk, byte for byte, and keeps refusing the revoked key', async () => {
    const h = await node();
    advance(h, 1);
    h.produce([update(h, { add: [K4], remove: [K1], approvers: [K2, K3] })]);
    const before = { gate: gateOf(h.chain), root: h.chain.stateRoot, tip: h.chain.tip!.hash };
    expect(before.gate.revoked).toEqual([K1.publicKey]);

    const restarted = new ChainManager({ dataDir: h.dir, net: h.net, genesisDocument: h.chain.genesisDocument, enforceProposerRotation: true });
    await restarted.init();
    expect(restarted.verifyIntegrity().ok).toBe(true);
    expect(gateOf(restarted)).toEqual(before.gate);
    expect(restarted.stateRoot).toBe(before.root);
    expect(restarted.tip!.hash).toBe(before.tip);
    // The restarted node enforces the rotated set, not the genesis one.
    refusedFor(restarted.addBlock(h.makeBlock([claim(h, K1)], { simulate: false })), /not issued by a key this chain committed/);
    expect(restarted.addBlock(h.makeBlock([claim(h, K4)])).accepted).toBe(true);
  });
});

describe('a node that was offline', () => {
  it('catches up through a rotation and a revocation to exactly the same gate state and state root', async () => {
    const online = await node();
    const offline = await node(); // same genesis, then it "goes away"
    const blocks: Block[] = [];
    blocks.push(online.produce([]));
    blocks.push(online.produce([update(online, { add: [K4], remove: [K1], approvers: [K2, K3] })]));
    blocks.push(online.produce([]));
    blocks.push(online.produce([update(online, { remove: [K2], approvers: [K3, K4] })]));
    expect(gateOf(online.chain).epoch).toBe(2);

    // It comes back and is handed the blocks, with no private key and no special message.
    for (const block of blocks) expect(offline.chain.addBlock(block).accepted).toBe(true);
    expect(gateOf(offline.chain)).toEqual(gateOf(online.chain));
    expect(offline.chain.stateRoot).toBe(online.chain.stateRoot);
    expect(gateOf(offline.chain).revoked.sort()).toEqual([K1.publicKey, K2.publicKey].sort());
    // And it refuses what the online node refuses.
    refusedFor(offline.tryBlock([claim(offline, K2)], { simulate: false }), /not issued by a key this chain committed/);
  });

  it('two fresh nodes fed the same history converge; re-delivery is idempotent; a block that skips its parent is queued, never applied', async () => {
    const source = await node();
    const blocks: Block[] = [source.produce([]), source.produce([update(source, { add: [K4], approvers: [K1, K2] })]), source.produce([])];
    const a = await node();
    const b = await node();
    for (const block of blocks) expect(a.chain.addBlock(block).accepted).toBe(true);
    for (const block of blocks) expect(b.chain.addBlock(block).accepted).toBe(true);
    expect(a.chain.stateRoot).toBe(b.chain.stateRoot);
    expect(gateOf(a.chain)).toEqual(gateOf(b.chain));
    // Delivering the same blocks again changes nothing (idempotent), and out-of-order delivery is not accepted as state.
    for (const block of blocks) a.chain.addBlock(block);
    expect(a.chain.stateRoot).toBe(b.chain.stateRoot);
    const fresh = await node();
    refusedFor(fresh.chain.addBlock(blocks[2]!), /parent block is unknown/);
    expect(gateOf(fresh.chain).epoch).toBe(0);
  });
});

describe('a lost key', () => {
  it('is replaced by the other two, and the lost key coming back can neither approve nor be re-added', async () => {
    const h = await node();
    advance(h, 1);
    // K3 is lost. K1 and K2 (2 of 3) revoke it and add K4.
    h.produce([update(h, { add: [K4], remove: [K3], approvers: [K1, K2] })]);
    expect(gateOf(h.chain).active.sort()).toEqual([K1, K2, K4].map((k) => k.publicKey).sort());
    // "Restored" K3 is just an old key: it counts for nothing as an approver...
    const asApprover = h.tryBlock([update(h, { remove: [K4], approvers: [K3, K1] })], { simulate: false });
    refusedFor(asApprover, /is not a current issuer/);
    // ...and cannot be put back, even with a full quorum.
    const readd = h.tryBlock([update(h, { add: [K3], approvers: [K1, K2] })], { simulate: false });
    refusedFor(readd, /revoked earlier and can never be admitted again/);
    expect(gateOf(h.chain).epoch).toBe(1);
    // Its certificates are dead; the others work.
    refusedFor(h.tryBlock([claim(h, K3)], { simulate: false }), /not issued by a key this chain committed/);
    expect(h.tryBlock([claim(h, K1)]).accepted).toBe(true);
  });
});

describe('losing the quorum fails safe', () => {
  it('one key of three cannot change anything, the failed attempt leaves state untouched, and mining under that key goes on', async () => {
    const h = await node();
    advance(h, 1);
    const before = { gate: gateOf(h.chain), root: h.chain.stateRoot };
    const lone = h.tryBlock([update(h, { remove: [K2, K3], approvers: [K1] })], { simulate: false });
    refusedFor(lone, /needs 2 of 3 current issuers to approve it, and has 1/);
    expect(gateOf(h.chain)).toEqual(before.gate);
    expect(h.chain.stateRoot).toBe(before.root);
    expect(h.tryBlock([claim(h, K1)]).accepted).toBe(true);
  });

  it('the same key signing twice is one approval, not two', async () => {
    const h = await node();
    advance(h, 1);
    const epoch = 1;
    const remove = [K2.publicKey];
    const one = approveGateUpdate(K1.privateKey, K1.publicKey, ctxOf(h), epoch, [], remove);
    const body: GateAuthorityBody = { op: GateAuthorityOp.UPDATE, epoch, add: [], remove, approvals: [one, one] };
    const tx = h.sign(makeWallet(), TxType.GATE_AUTHORITY, encodeGateAuthorityBody(body), { gas: 0n });
    refusedFor(h.tryBlock([tx], { simulate: false }), /approved twice/);
    expect(gateOf(h.chain).epoch).toBe(0);
  });
});

describe('conflicting updates', () => {
  it('two quorum-signed updates for the same epoch: exactly one wins, the other is refused, and the loser changes nothing', async () => {
    const h = await node();
    advance(h, 1);
    const first = update(h, { add: [K4], approvers: [K1, K2] });
    const second = update(h, { remove: [K3], approvers: [K2, K3] }); // same epoch, different content
    h.produce([first]);
    const afterFirst = { gate: gateOf(h.chain), root: h.chain.stateRoot };
    expect(afterFirst.gate.active).toContain(K4.publicKey);
    refusedFor(h.tryBlock([second], { simulate: false }), /next epoch is 2/);
    expect(gateOf(h.chain)).toEqual(afterFirst.gate);
    expect(h.chain.stateRoot).toBe(afterFirst.root);
  });

  it('an update signed for one network or chain id is not valid on another (domain separation)', async () => {
    const h = await node();
    advance(h, 1);
    const epoch = 1;
    const remove = [K2.publicKey];
    const foreign = [K1, K3].map((k) => approveGateUpdate(k.privateKey, k.publicKey, { networkId: 'obsidian-other-1', chainId: h.net.chainId + 1 }, epoch, [], remove));
    const body: GateAuthorityBody = { op: GateAuthorityOp.UPDATE, epoch, add: [], remove, approvals: foreign };
    const tx = h.sign(makeWallet(), TxType.GATE_AUTHORITY, encodeGateAuthorityBody(body), { gas: 0n });
    refusedFor(h.tryBlock([tx], { simulate: false }), /does not match this update/);
    expect(gateOf(h.chain).epoch).toBe(0);
  });
});

describe('no private key on a node', () => {
  it('the chain, its snapshot and its data directory hold gate PUBLIC keys only', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const h = await node();
    advance(h, 2);
    const secrets = [K1, K2, K3].map((k) => k.privateKey.toLowerCase());
    const scan = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const full = join(dir, entry);
        return statSync(full).isDirectory() ? scan(full) : [full];
      });
    for (const file of scan(h.dir)) {
      const text = readFileSync(file).toString('hex') + readFileSync(file, 'latin1').toLowerCase();
      for (const secret of secrets) expect(text.includes(secret), `${file} contains a gate private key`).toBe(false);
    }
  });
});
