/**
 * Security suite: gate authority — rotating and revoking the mining gate issuer keys in consensus (protocol 1.8.0).
 *
 * Through 1.7.0 a leaked issuer key could only be handled by starting a new network. These tests prove the chain now
 * lets a MAJORITY of the current issuers replace or revoke a key, and lets nobody else do anything, through every
 * door the update arrives by: a block, the mempool/gossip check, and a state restore.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ErrCode } from '../../src/protocol/errors.js';
import { GateAuthorityOp, TxType, type GateAuthorityBody } from '../../src/protocol/types.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { keyPairFromPrivateKey } from '../../src/crypto/keys.js';
import { computeClaimId, encodeMiningBody } from '../../src/transactions/executors/mining.js';
import { issueMiningGateCertificate } from '../../src/mining/gate.js';
import {
  approveGateUpdate,
  decodeGateAuthorityBody,
  encodeGateAuthorityBody,
  gateQuorum,
  verifyGateUpdate,
} from '../../src/mining/gate-authority.js';
import { WorldState } from '../../src/blockchain/state.js';
import { Mempool } from '../../src/blockchain/mempool.js';
import { GATE_ISSUER, advance, createHarness, makeWallet, type Harness } from '../helpers/harness.js';

const K1 = GATE_ISSUER;
const K2 = keyPairFromPrivateKey('33'.repeat(32));
const K3 = keyPairFromPrivateKey('44'.repeat(32));
const K4 = keyPairFromPrivateKey('55'.repeat(32));
const K5 = keyPairFromPrivateKey('66'.repeat(32));
type Pair = typeof K1;

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
async function harness(keys: Pair[] = [K1, K2, K3]): Promise<Harness> {
  const h = await createHarness({ miningGatePublicKeys: keys.map((k) => k.publicKey) });
  open.push(h);
  advance(h, 1);
  return h;
}
const ctxOf = (h: Harness) => ({ networkId: h.net.networkId, chainId: h.net.chainId });

function body(h: Harness, change: { add?: Pair[]; remove?: Pair[]; approvers: Pair[]; epoch?: number }): GateAuthorityBody {
  const add = (change.add ?? []).map((k) => k.publicKey);
  const remove = (change.remove ?? []).map((k) => k.publicKey);
  const epoch = change.epoch ?? h.chain.world.s.genesis.gateEpoch + 1;
  return {
    op: GateAuthorityOp.UPDATE,
    epoch,
    add,
    remove,
    approvals: change.approvers.map((k) => approveGateUpdate(k.privateKey, k.publicKey, ctxOf(h), epoch, add, remove)),
  };
}
const txOf = (h: Harness, b: GateAuthorityBody, options: { gas?: bigint } = {}) =>
  h.sign(makeWallet(), TxType.GATE_AUTHORITY, encodeGateAuthorityBody(b), { gas: options.gas ?? 0n });
const active = (h: Harness) => h.chain.world.s.genesis.gateKeysActive;

function claimWith(h: Harness, issuer: Pair) {
  const wallet = makeWallet();
  const claimId = computeClaimId(h.net.chainId, wallet.address, 1, 0);
  const gate = issueMiningGateCertificate(
    issuer.privateKey,
    issuer.publicKey,
    { networkId: h.net.networkId, chainId: h.net.chainId, address: wallet.address, claimId },
    h.chain.protocolTime,
  );
  return { wallet, tx: h.sign(wallet, TxType.MINING_CLAIM, encodeMiningBody({ claimId, claimSequence: 1, gate }), { gas: 0n }) };
}

describe('a majority of the current issuers can rotate the set', () => {
  it('starts with the genesis keys active, and the genesis keys never change', async () => {
    const h = await harness();
    const g = h.chain.world.s.genesis;
    expect(g.gateKeysActive).toEqual([K1, K2, K3].map((k) => k.publicKey).sort());
    expect(g.miningGateKeys).toEqual(g.gateKeysActive);
    expect(g.gateKeysRevoked).toEqual([]);
    expect(g.gateEpoch).toBe(0);
  });

  it('replaces a key with two of three approvals, in a block, and moves the state root', async () => {
    const h = await harness();
    const before = h.chain.stateRoot;
    const outcome = h.tryBlock([txOf(h, body(h, { add: [K4], remove: [K1], approvers: [K1, K2] }))]);
    expect(outcome.accepted, outcome.message).toBe(true);
    const g = h.chain.world.s.genesis;
    expect(g.gateKeysActive).toEqual([K2, K3, K4].map((k) => k.publicKey).sort());
    expect(g.gateKeysRevoked).toEqual([K1.publicKey]);
    expect(g.gateEpoch).toBe(1);
    // The genesis record is immutable: it is what the genesis id commits to.
    expect(g.miningGateKeys).toEqual([K1, K2, K3].map((k) => k.publicKey).sort());
    expect(h.chain.stateRoot).not.toBe(before);
  });

  it('stops accepting a revoked key at once, and starts accepting the new one', async () => {
    const h = await harness();
    const stolen = claimWith(h, K1);
    expect(h.tryBlock([claimWith(h, K1).tx]).accepted).toBe(true); // before revocation K1 is a valid issuer
    expect(h.tryBlock([txOf(h, body(h, { add: [K4], remove: [K1], approvers: [K2, K3] }))]).accepted).toBe(true);
    const refused = h.tryBlock([stolen.tx], { simulate: false });
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe(ErrCode.MINING_GATE_INVALID);
    expect(h.tryBlock([claimWith(h, K4).tx]).accepted).toBe(true);
    expect(h.tryBlock([claimWith(h, K2).tx]).accepted).toBe(true);
  });

  it('can revoke without adding, as long as one issuer remains', async () => {
    const h = await harness();
    expect(h.tryBlock([txOf(h, body(h, { remove: [K3], approvers: [K1, K2] }))]).accepted).toBe(true);
    expect(active(h)).toEqual([K1, K2].map((k) => k.publicKey).sort());
    expect(gateQuorum(active(h).length)).toBe(2);
  });

  it('applies two updates in order, one epoch each', async () => {
    const h = await harness();
    expect(h.tryBlock([txOf(h, body(h, { add: [K4], approvers: [K1, K2] }))]).accepted).toBe(true);
    expect(active(h)).toHaveLength(4); // quorum is now 3
    expect(h.tryBlock([txOf(h, body(h, { add: [K5], remove: [K2], approvers: [K1, K3, K4] }))]).accepted).toBe(true);
    expect(h.chain.world.s.genesis.gateEpoch).toBe(2);
  });
});

describe('nobody else can change it', () => {
  const refused = async (h: Harness, b: GateAuthorityBody, message?: RegExp) => {
    const tx = txOf(h, b);
    const outcome = h.tryBlock([tx], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.GATE_AUTHORITY_INVALID);
    if (message) expect(outcome.message).toMatch(message);
    expect(active(h)).toHaveLength(3);
    expect(h.chain.world.s.genesis.gateEpoch).toBe(0);
  };

  it('refuses a minority: one stolen key cannot replace the set', async () => {
    const h = await harness();
    await refused(h, body(h, { add: [K4], remove: [K2, K3], approvers: [K1] }), /needs 2 of 3/);
  });

  it('refuses an approver that is not a current issuer, even with enough signatures', async () => {
    const h = await harness();
    await refused(h, body(h, { add: [K4], approvers: [K1, K5] }), /not a current issuer/);
  });

  it('refuses a forged or mismatched signature, and never skips a bad one to reach the quorum', async () => {
    const h = await harness();
    const good = body(h, { add: [K4], approvers: [K1, K2, K3] });
    const forged = { ...good, approvals: good.approvals.map((a, i) => (i === 2 ? { ...a, signature: a.signature.replace(/.$/, (c) => (c === '0' ? '1' : '0')) } : a)) };
    await refused(h, forged, /does not match this update/);
    // K1's and K2's signatures are valid, K3 signed a DIFFERENT change: the whole update is refused.
    const other = approveGateUpdate(K3.privateKey, K3.publicKey, ctxOf(h), 1, [K5.publicKey], []);
    await refused(h, { ...good, approvals: [...good.approvals.slice(0, 2), other] }, /does not match this update/);
  });

  it('refuses one issuer approving twice', async () => {
    const h = await harness();
    const b = body(h, { add: [K4], approvers: [K1] });
    await refused(h, { ...b, approvals: [b.approvals[0]!, b.approvals[0]!] }, /approved twice/);
  });

  it('refuses an approval signed for another network or chain', async () => {
    const h = await harness();
    const b = body(h, { add: [K4], approvers: [K1] });
    const wrongNet = { ...b, approvals: [K1, K2].map((k) => approveGateUpdate(k.privateKey, k.publicKey, { networkId: 'obsidian-mainnet-1', chainId: h.net.chainId }, 1, [K4.publicKey], [])) };
    await refused(h, wrongNet, /does not match this update/);
    const wrongChain = { ...b, approvals: [K1, K2].map((k) => approveGateUpdate(k.privateKey, k.publicKey, { networkId: h.net.networkId, chainId: 1 }, 1, [K4.publicKey], [])) };
    await refused(h, wrongChain, /does not match this update/);
  });

  it('refuses a replay, a skipped epoch and an old epoch', async () => {
    const h = await harness();
    const first = body(h, { add: [K4], approvers: [K1, K2] });
    expect(h.tryBlock([txOf(h, first)]).accepted).toBe(true);
    const replay = h.tryBlock([txOf(h, first)], { simulate: false });
    expect(replay.accepted).toBe(false);
    expect(replay.message).toMatch(/next epoch is 2/);
    const skipped = body(h, { add: [K5], approvers: [K1, K2, K3], epoch: 3 });
    expect(h.tryBlock([txOf(h, skipped)], { simulate: false }).accepted).toBe(false);
    const zero = body(h, { add: [K5], approvers: [K1, K2, K3], epoch: 0 });
    expect(h.tryBlock([txOf(h, zero)], { simulate: false }).accepted).toBe(false);
  });

  it('carries no gas: a non-zero gas value is refused', async () => {
    const h = await harness();
    const outcome = h.tryBlock([txOf(h, body(h, { add: [K4], approvers: [K1, K2] }), { gas: 1n })], { simulate: false });
    expect(outcome.accepted).toBe(false);
  });

  it('refuses a change that is not a change, or contradicts itself', async () => {
    const h = await harness();
    await refused(h, body(h, { approvers: [K1, K2] }), /at least one key/);
    await refused(h, body(h, { add: [K4], remove: [K4], approvers: [K1, K2] }), /added and removed/);
    await refused(h, body(h, { add: [K4, K4], approvers: [K1, K2] }), /listed twice/);
  });

  it('refuses to add an active key, remove an inactive one, or use a malformed key', async () => {
    const h = await harness();
    await refused(h, body(h, { add: [K1], approvers: [K1, K2] }), /already an active issuer/);
    await refused(h, body(h, { remove: [K4], approvers: [K1, K2] }), /not an active issuer/);
    const bad = { ...body(h, { add: [K4], approvers: [K1, K2] }), add: ['02' + 'ff'.repeat(32)] };
    await refused(h, bad, /not a valid secp256k1 point|compressed/);
    await refused(h, { ...body(h, { add: [K4], approvers: [K1, K2] }), add: ['not a key'] }, /compressed/);
  });

  it('can never put a revoked key back', async () => {
    const h = await harness();
    expect(h.tryBlock([txOf(h, body(h, { remove: [K1], approvers: [K2, K3] }))]).accepted).toBe(true);
    const back = body(h, { add: [K1], approvers: [K2, K3] });
    const outcome = h.tryBlock([txOf(h, back)], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.message).toMatch(/revoked earlier/);
  });

  it('cannot empty the set, and cannot exceed the maximum', async () => {
    const h = await harness([K1]);
    const emptied = h.tryBlock([txOf(h, body(h, { remove: [K1], approvers: [K1] }))], { simulate: false });
    expect(emptied.accepted).toBe(false);
    expect(emptied.message).toMatch(/no issuer/);
    expect(active(h)).toEqual([K1.publicKey]);

    const crowd = Array.from({ length: CONSENSUS_PARAMS.miningGate.maxIssuers }, (_, i) => keyPairFromPrivateKey((70 + i).toString(16).padStart(2, '0').repeat(32)));
    const over = h.tryBlock([txOf(h, body(h, { add: crowd, approvers: [K1] }))], { simulate: false });
    expect(over.accepted).toBe(false);
    expect(over.message).toMatch(/at most 8 active/);
  });

  it('on a chain with no issuer at all, nobody can authorise anything', async () => {
    const h = await harness([]);
    const sim = h.tryBlock([txOf(h, body(h, { add: [K4], approvers: [K1] }))], { simulate: false });
    expect(sim.accepted).toBe(false);
    expect(sim.message).toMatch(/no active gate issuer/);
  });
});

describe('a single key can replace itself (and that is the weakest setting)', () => {
  it('rotates with its own approval', async () => {
    const h = await harness([K1]);
    expect(gateQuorum(1)).toBe(1);
    expect(h.tryBlock([txOf(h, body(h, { add: [K2], remove: [K1], approvers: [K1] }))]).accepted).toBe(true);
    expect(active(h)).toEqual([K2.publicKey]);
  });
});

describe('the quorum rule', () => {
  it('is a strict majority', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(gateQuorum)).toEqual([1, 2, 2, 3, 3, 4, 4, 5]);
    expect(gateQuorum(0)).toBe(Number.POSITIVE_INFINITY);
  });

  it('verifyGateUpdate is pure: it returns the result and changes nothing', async () => {
    const h = await harness();
    const state = { active: active(h), revoked: [] as string[], epoch: 0 };
    const snapshot = JSON.stringify(state);
    const outcome = verifyGateUpdate(state, body(h, { add: [K4], remove: [K1], approvers: [K1, K2] }), ctxOf(h));
    expect(outcome.epoch).toBe(1);
    expect(outcome.approvedBy).toEqual([K1.publicKey, K2.publicKey].sort());
    expect(JSON.stringify(state)).toBe(snapshot);
  });
});

describe('encoding', () => {
  it('round-trips canonically', async () => {
    const h = await harness();
    const b = body(h, { add: [K4], remove: [K1], approvers: [K1, K2] });
    expect(decodeGateAuthorityBody(encodeGateAuthorityBody(b))).toEqual(b);
  });

  it('refuses trailing bytes, an unknown operation and oversized lists', async () => {
    const h = await harness();
    const bytes = encodeGateAuthorityBody(body(h, { add: [K4], approvers: [K1, K2] }));
    expect(() => decodeGateAuthorityBody(new Uint8Array([...bytes, 0]))).toThrow();
    const wrongOp = Uint8Array.from(bytes);
    wrongOp[0] = 9;
    expect(() => decodeGateAuthorityBody(wrongOp)).toThrow();
    const many = Array.from({ length: CONSENSUS_PARAMS.miningGate.maxChangesPerUpdate + 1 }, () => K4.publicKey);
    expect(() => decodeGateAuthorityBody(encodeGateAuthorityBody({ op: GateAuthorityOp.UPDATE, epoch: 1, add: many, remove: [], approvals: [] }))).toThrow(/at most/);
    expect(() => decodeGateAuthorityBody(new Uint8Array([1, 0, 0]))).toThrow();
  });
});

describe('persistence', () => {
  it('survives a snapshot round trip and a clone, and is refused when missing from an old snapshot', async () => {
    const h = await harness();
    expect(h.tryBlock([txOf(h, body(h, { add: [K4], remove: [K1], approvers: [K1, K2] }))]).accepted).toBe(true);
    const world = h.chain.world;
    const snapshot = world.toSnapshot(h.chain.tip!.hash);
    const restored = WorldState.fromSnapshot(snapshot);
    expect(restored.s.genesis.gateKeysActive).toEqual(world.s.genesis.gateKeysActive);
    expect(restored.s.genesis.gateKeysRevoked).toEqual([K1.publicKey]);
    expect(restored.s.genesis.gateEpoch).toBe(1);
    const copy = world.clone();
    copy.s.genesis.gateKeysActive.push('x');
    expect(world.s.genesis.gateKeysActive).not.toContain('x');

    const { gateKeysActive: _dropped, ...rest } = snapshot.genesis;
    expect(() => WorldState.fromSnapshot({ ...snapshot, genesis: rest as typeof snapshot.genesis })).toThrow(/gate authority/);
  });
});

describe('the pool and gossip', () => {
  it('relays only an update that is valid against the current state', async () => {
    const h = await harness();
    const good = txOf(h, body(h, { add: [K4], approvers: [K1, K2] }));
    expect(h.chain.checkGossipedTransaction(good)).toEqual({ ok: true });
    const minority = txOf(h, body(h, { add: [K4], approvers: [K1] }));
    const verdict = h.chain.checkGossipedTransaction(minority);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe(ErrCode.GATE_AUTHORITY_INVALID);
    const garbage = h.sign(makeWallet(), TxType.GATE_AUTHORITY, new Uint8Array([1, 2, 3]), { gas: 0n });
    expect(h.chain.checkGossipedTransaction(garbage).ok).toBe(false);
  });

  it('bounds how many updates the pool holds, in total and per sender', async () => {
    const h = await harness();
    const pool = new Mempool({ maxPendingGateUpdates: 3, maxGateUpdatesPerSender: 2, maxTransactions: 100, maxBytes: 1 << 20, maxPerSender: 64, maxPendingEvidence: 8, maxEvidencePerSender: 2, maxEvidenceBytes: 1 << 20 });
    const sender = makeWallet();
    const mk = (who: ReturnType<typeof makeWallet>, nonce: number) => h.sign(who, TxType.GATE_AUTHORITY, encodeGateAuthorityBody(body(h, { add: [K4], approvers: [K1, K2] })), { gas: 0n, nonce });
    expect(pool.add(mk(sender, 0)).accepted).toBe(true);
    expect(pool.add(mk(sender, 1)).accepted).toBe(true);
    const third = pool.add(mk(sender, 2));
    expect(third.accepted).toBe(false);
    expect(third.reason).toMatch(/sender gate update quota/);
    expect(pool.add(mk(makeWallet(), 0)).accepted).toBe(true);
    const fourth = pool.add(mk(makeWallet(), 0));
    expect(fourth.accepted).toBe(false);
    expect(fourth.reason).toMatch(/pending gate update quota/);
  });
});
