/**
 * ATTACK ROUND 1 — starving the transaction pool at no cost.
 *
 * The pool is a per-node, local policy, so the defence has to live in each node's own admission check and cannot rely on
 * any coordinator. These tests drive the exact path a peer's transaction takes (`checkGossipedTransaction`, then the
 * first-seen-per-nonce check, then `Mempool.add`) with an attacker who owns unlimited fresh keys and no funds.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHarness,
  makeNode,
  makeWallet,
  nodeHeartbeat,
  nodeStatement,
  paymentBody,
  registerNode,
  signedClaim,
  type Harness,
} from '../helpers/harness.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { Mempool } from '../../src/blockchain/mempool.js';
import { NodeRegistryOp, TxType } from '../../src/protocol/types.js';
import type { TxEnvelope } from '../../src/protocol/types.js';

const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

/** What a peer's `newtx` message does on arrival. */
function gossip(h: Harness, tx: TxEnvelope): boolean {
  if (h.chain.mempool.has(tx.id)) return false;
  if (!h.chain.checkGossipedTransaction(tx).ok) return false;
  if (h.chain.mempool.findBySenderNonce(tx.sender, tx.nonce)) return false;
  return h.chain.mempool.add(tx).accepted;
}

async function chainWithNode() {
  const alice = makeWallet();
  const h = await createHarness({ producer: alice });
  harnesses.push(h);
  h.produce([signedClaim(h, alice)]);
  const honest = makeNode(makeWallet());
  registerNode(h, honest);
  return { h, alice, honest };
}

describe('round 1b: state and block-space spam must not be free', () => {
  it('a one-seal payment to a fresh address (a free new account) is refused', async () => {
    const { h, alice } = await chainWithNode();
    const fresh = makeWallet();
    const outcome = h.tryBlock([h.sign(alice, TxType.PAYMENT, paymentBody(fresh.address, 1n), { gas: 0n })]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.AMOUNT_ZERO);
  });

  it('even the smallest allowed payment pays the gas floor to the Mining Pool', async () => {
    const { h, alice } = await chainWithNode();
    const min = CONSENSUS_PARAMS.tx.minTransfer;
    expect(expectedGas(min)).toBe(CONSENSUS_PARAMS.gas.minGas);
    expect(CONSENSUS_PARAMS.gas.minGas > 0n).toBe(true);
    const fresh = makeWallet();
    const free = h.tryBlock([h.sign(alice, TxType.PAYMENT, paymentBody(fresh.address, min), { gas: 0n })]);
    expect(free.accepted).toBe(false);
    expect(free.code).toBe(ErrCode.BAD_GAS);
    const paid = h.tryBlock([h.sign(alice, TxType.PAYMENT, paymentBody(fresh.address, min), { gas: expectedGas(min) })]);
    expect(paid.accepted).toBe(true);
  });

  it('block selection cannot be monopolised by transactions whose ids were ground to sort first', () => {
    const pool = new Mempool();
    // 500 free node-statement-class transactions that arrived first, then one honest claim.
    const spam = Array.from({ length: 500 }, (_, i) => fakeTx(`00${i.toString(16).padStart(4, '0')}`, TxType.ONS, `s${i}`));
    const claim = fakeTx('ffffff', TxType.MINING_CLAIM, 'honest');
    for (const tx of spam) pool.add(tx);
    pool.add(claim);
    const chosen = pool.selectForBlock(100, () => 0);
    expect(chosen).toHaveLength(100);
    expect(chosen.some((tx) => tx.id === claim.id)).toBe(true);
  });

  it('transactions that pay gas still go first, highest gas first', () => {
    const pool = new Mempool();
    pool.add(fakeTx('01', TxType.ONS, 'a', 0n));
    pool.add(fakeTx('02', TxType.PAYMENT, 'b', 5n));
    pool.add(fakeTx('03', TxType.PAYMENT, 'c', 9n));
    expect(pool.selectForBlock(10, () => 0).map((tx) => tx.sender)).toEqual(['c', 'b', 'a']);
  });
});

function fakeTx(id: string, type: TxType, sender: string, gas = 0n): TxEnvelope {
  return {
    id,
    protocolVersion: '2.0.2',
    chainId: 7780,
    sender,
    nonce: 0,
    type,
    gas,
    body: new Uint8Array([1, 2, 3]),
    memo: '',
    validUntil: 9_999_999_999,
    signature: { publicKey: '', signature: '' },
  } as unknown as TxEnvelope;
}

describe('round 1: pool starvation by fresh keys', () => {
  it('free node registrations from fresh keys cannot take the places honest node statements need', async () => {
    const { h, honest } = await chainWithNode();
    let accepted = 0;
    for (let i = 0; i < 600; i += 1) {
      const stranger = makeNode(makeWallet());
      const tx = nodeStatement(h, stranger, { op: NodeRegistryOp.REGISTER, endpoint: '203.0.113.9:8631' });
      if (gossip(h, tx)) accepted += 1;
    }
    // The flood may keep a handful of registrations pooled, but never the pool's whole node-statement class.
    expect(accepted).toBeLessThanOrEqual(32);
    expect(gossip(h, nodeHeartbeat(h, honest))).toBe(true);
  });

  it('a node statement from a key that is not a registered node is not pooled (it can never apply)', async () => {
    const { h } = await chainWithNode();
    const stranger = makeNode(makeWallet());
    const heartbeat = nodeHeartbeat(h, stranger);
    expect(gossip(h, heartbeat)).toBe(false);
    for (const op of [NodeRegistryOp.ATTEST, NodeRegistryOp.DEREGISTER, NodeRegistryOp.CHANGE_WALLET]) {
      expect(gossip(h, nodeStatement(h, stranger, { op, subject: 'x' } as never)), String(op)).toBe(false);
    }
  });

  it('zero-gas transactions from accounts that do not exist cannot fill the pool', async () => {
    const { h } = await chainWithNode();
    const victim = makeWallet();
    let accepted = 0;
    for (let i = 0; i < 400; i += 1) {
      const attacker = makeWallet();
      const tx = h.sign(attacker, TxType.PAYMENT, paymentBody(victim.address, 1n), { gas: 0n });
      if (gossip(h, tx)) accepted += 1;
    }
    expect(accepted).toBe(0);
    expect(h.chain.mempool.size).toBe(0);
  });

  it('a claim for a wallet nobody holds a gate certificate for is not pooled, a real one is', async () => {
    const { h } = await chainWithNode();
    const real = makeWallet();
    expect(gossip(h, signedClaim(h, real))).toBe(true);
    // Same body but with the certificate stripped: the account system never issued it.
    const stripped = makeWallet();
    const honestClaim = signedClaim(h, stripped);
    const forged = h.sign(stripped, TxType.MINING_CLAIM, honestClaimBodyWithoutGate(honestClaim), { gas: 0n });
    expect(gossip(h, forged)).toBe(false);
  });
});

import { decodeMiningBody, encodeMiningBody } from '../../src/transactions/executors/mining.js';
function honestClaimBodyWithoutGate(tx: TxEnvelope): Uint8Array {
  const body = decodeMiningBody(tx.body);
  return encodeMiningBody({ ...body, gate: undefined });
}
