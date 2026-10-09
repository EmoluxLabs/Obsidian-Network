/**
 * Security suite: the mining gate (consensus rule, protocol 1.7.0).
 *
 * The account system (sign-in, second factor, one wallet per account) used to be enforced only by the platform, so a
 * person could skip it by posting a claim straight to a node. These tests prove the CHAIN now refuses that, through
 * every door a claim can arrive by: a block, the mempool, and the node's own HTTP endpoint.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ErrCode } from '../../src/protocol/errors.js';
import { TxType } from '../../src/protocol/types.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { decodeMiningBody, encodeMiningBody, computeClaimId } from '../../src/transactions/executors/mining.js';
import { assertMiningGate, issueMiningGateCertificate, miningGateMessage } from '../../src/mining/gate.js';
import { genesisDocumentFor, genesisId, normalizeMiningGatePublicKeys, resolveMiningGateKeys } from '../../src/genesis/initialize.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { generateKeyPair } from '../../src/crypto/keys.js';
import { WorldState } from '../../src/blockchain/state.js';
import {
  FOREIGN_GATE_ISSUER,
  GATE_ISSUER,
  advance,
  createHarness,
  gateFor,
  makeWallet,
  miningBody,
  signedClaim,
  type Harness,
} from '../helpers/harness.js';

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});
async function harness(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = await createHarness(options);
  open.push(h);
  return h;
}
const { certificateTtlSeconds: TTL, clockSkewSeconds: SKEW } = CONSENSUS_PARAMS.miningGate;

describe('a claim is valid only through the gate', () => {
  it('accepts a claim carrying a certificate from a committed issuer', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const outcome = h.tryBlock([signedClaim(h, bob)]);
    expect(outcome.accepted, outcome.message).toBe(true);
    expect(h.chain.world.getAccount(bob.address)?.mining?.totalClaims).toBe(1);
  });

  it('refuses a claim with no certificate at all (the direct-to-node bypass)', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const tx = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: 'none' }), { gas: 0n });
    const outcome = h.tryBlock([tx], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_REQUIRED);
    expect(h.chain.world.getAccount(bob.address)?.mining).toBeUndefined();
    expect(h.chain.world.s.genesis.allocationClaimed).toBe(false);
  });

  it('refuses a certificate signed by a key the chain did not commit', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const tx = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: 'foreign' }), { gas: 0n });
    const outcome = h.tryBlock([tx], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_INVALID);
  });

  it('refuses a certificate issued for another wallet', async () => {
    const h = await harness();
    const bob = makeWallet();
    const carol = makeWallet();
    advance(h, 1);
    const carolsBody = decodeMiningBody(miningBody(h, carol));
    const claimId = computeClaimId(h.net.chainId, bob.address, 1, 0);
    const body = encodeMiningBody({ claimId, claimSequence: 1, gate: carolsBody.gate });
    const outcome = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_INVALID);
  });

  it('refuses a certificate issued for a different claim of the same wallet', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const claimId = computeClaimId(h.net.chainId, bob.address, 1, 0);
    const otherId = computeClaimId(h.net.chainId, bob.address, 2, 5);
    const body = encodeMiningBody({ claimId, claimSequence: 1, gate: gateFor(h, bob.address, otherId) });
    const outcome = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_INVALID);
  });

  it('refuses a certificate carried over from another network', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const claimId = computeClaimId(h.net.chainId, bob.address, 1, 0);
    const cert = issueMiningGateCertificate(
      GATE_ISSUER.privateKey,
      GATE_ISSUER.publicKey,
      { networkId: 'obsidian-testnet-1', chainId: h.net.chainId, address: bob.address, claimId },
      h.chain.protocolTime,
    );
    const body = encodeMiningBody({ claimId, claimSequence: 1, gate: cert });
    const outcome = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_INVALID);
  });

  it('refuses a tampered signature, and a half-present certificate is malformed', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const good = decodeMiningBody(miningBody(h, bob));
    const flipped = good.gate!.signature.replace(/.$/, (c) => (c === '0' ? '1' : '0'));
    const tampered = encodeMiningBody({ ...good, gate: { ...good.gate!, signature: flipped } });
    const outcome = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, tampered, { gas: 0n })], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_INVALID);

    const half = encodeMiningBody({ ...good, gate: { ...good.gate!, signature: '' } });
    expect(() => decodeMiningBody(half)).toThrow(/incomplete/);
  });
});

describe('a certificate is short-lived', () => {
  it('is refused once it is older than the lifetime, and accepted just inside it', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const now = h.chain.protocolTime;
    const stale = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: { issuedAt: now - TTL - 1 } }), { gas: 0n });
    const refused = h.tryBlock([stale], { simulate: false, timestamp: now + 1 });
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe(ErrCode.MINING_GATE_INVALID);
    expect(refused.message).toMatch(/expired/);

    const fresh = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: { issuedAt: now - TTL + 5 } }), { gas: 0n });
    expect(h.tryBlock([fresh], { timestamp: now + 1 }).accepted).toBe(true);
  });

  it('is refused when it is dated well after the block, so it cannot be signed in advance', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const now = h.chain.protocolTime;
    const early = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: { issuedAt: now + SKEW + 120 } }), { gas: 0n });
    const outcome = h.tryBlock([early], { simulate: false, timestamp: now + 1 });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_INVALID);
  });

  it('cannot be reused: the claim id it names is replay-protected', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const body = miningBody(h, bob);
    h.produce([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })]);
    const again = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })], { simulate: false });
    expect(again.accepted).toBe(false);
    expect([ErrCode.MINING_CLAIM_REPLAY, ErrCode.MINING_NOT_ELIGIBLE, ErrCode.MINING_TOO_SOON, ErrCode.MINING_BAD_PROOF]).toContain(again.code);
  });
});

describe('the gate fails closed and does not decide eligibility', () => {
  it('a chain that commits no issuer key accepts no claim at all', async () => {
    const h = await harness({ miningGatePublicKeys: [] });
    const bob = makeWallet();
    advance(h, 1);
    const outcome = h.tryBlock([signedClaim(h, bob)], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_GATE_REQUIRED);
    expect(outcome.message).toMatch(/commits no mining gate/);
  });

  it('a certificate does not override the protocol timing: the second claim is still too soon', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([signedClaim(h, bob)]);
    const tooSoon = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob), { gas: 0n })], { simulate: false });
    expect(tooSoon.accepted).toBe(false);
    expect([ErrCode.MINING_TOO_SOON, ErrCode.MINING_NOT_ELIGIBLE, ErrCode.MINING_CYCLE_LIMIT]).toContain(tooSoon.code);
  });

  it('an issuer is not a validator: its key cannot produce blocks or vote', async () => {
    const h = await harness();
    expect(h.chain.world.s.genesis.bootstrapValidatorKeys).not.toContain(GATE_ISSUER.publicKey);
    expect(h.chain.world.s.validators.has(GATE_ISSUER.address)).toBe(false);
  });
});

describe('the issuer set is part of the chain identity', () => {
  const devnet = getNetwork('devnet');
  it('moves the genesis id and the state root, so nodes with different issuers cannot share a chain', async () => {
    const a = generateKeyPair(devnet.addressHrp).publicKey;
    const b = generateKeyPair(devnet.addressHrp).publicKey;
    const ids = [[], [a], [b], [a, b]].map((keys) => genesisId(genesisDocumentFor(devnet, [], keys), devnet));
    expect(new Set(ids).size).toBe(4);
    // order does not matter, only the set
    expect(genesisId(genesisDocumentFor(devnet, [], [a, b]), devnet)).toBe(genesisId(genesisDocumentFor(devnet, [], [b, a]), devnet));

    const x = await harness({ miningGatePublicKeys: [GATE_ISSUER.publicKey] });
    const y = await harness({ miningGatePublicKeys: [FOREIGN_GATE_ISSUER.publicKey] });
    expect(x.chain.tip!.hash).not.toBe(y.chain.tip!.hash);
  });

  it('rejects malformed, duplicated and oversized issuer lists', () => {
    const a = generateKeyPair(devnet.addressHrp).publicKey;
    expect(() => normalizeMiningGatePublicKeys(['zz'])).toThrow();
    expect(() => normalizeMiningGatePublicKeys([a, a])).toThrow(/unique/);
    expect(() => normalizeMiningGatePublicKeys(Array.from({ length: CONSENSUS_PARAMS.miningGate.maxIssuers + 1 }, () => generateKeyPair().publicKey))).toThrow(/exceeds/);
    expect(resolveMiningGateKeys(devnet, [])).toEqual([]);
  });

  it('a snapshot without the issuer keys is refused, not read as "no keys"', async () => {
    const h = await harness();
    const snapshot = h.chain.snapshot();
    const { miningGateKeys: _gone, ...genesis } = snapshot.genesis;
    expect(() => WorldState.fromSnapshot({ ...snapshot, genesis } as never)).toThrow(/miningGateKeys/);
  });
});

describe('the certificate primitive', () => {
  const subject = { networkId: 'obsidian-devnet-1', chainId: 7780, address: 'dobs1abc', claimId: 'ab'.repeat(32) };
  it('verifies exactly its own subject and time window', () => {
    const cert = issueMiningGateCertificate(GATE_ISSUER.privateKey, GATE_ISSUER.publicKey, subject, 1_000_000);
    const keys = [GATE_ISSUER.publicKey];
    expect(() => assertMiningGate(keys, cert, subject, 1_000_000)).not.toThrow();
    expect(() => assertMiningGate(keys, cert, { ...subject, address: 'dobs1abd' }, 1_000_000)).toThrow();
    expect(() => assertMiningGate(keys, cert, { ...subject, claimId: 'cd'.repeat(32) }, 1_000_000)).toThrow();
    expect(() => assertMiningGate(keys, cert, subject, 1_000_000 + TTL)).not.toThrow();
    expect(() => assertMiningGate(keys, cert, subject, 1_000_000 + TTL + 1)).toThrow(/expired/);
    expect(() => assertMiningGate(keys, cert, subject, 1_000_000 - SKEW)).not.toThrow();
    expect(() => assertMiningGate(keys, cert, subject, 1_000_000 - SKEW - 1)).toThrow(/after the block/);
    expect(() => assertMiningGate([], cert, subject, 1_000_000)).toThrow(/commits no/);
    expect(() => assertMiningGate(keys, undefined, subject, 1_000_000)).toThrow(/must carry/);
  });

  it('messages differ for every field, so no two subjects share a signature', () => {
    const base = miningGateMessage(subject, 5);
    const variants = [
      { ...subject, networkId: 'x' },
      { ...subject, chainId: 1 },
      { ...subject, address: 'y' },
      { ...subject, claimId: 'z' },
    ].map((s) => Buffer.from(miningGateMessage(s, 5)).toString('hex'));
    variants.push(Buffer.from(miningGateMessage(subject, 6)).toString('hex'));
    expect(new Set([Buffer.from(base).toString('hex'), ...variants]).size).toBe(6);
  });

  it('an issuer key cannot be smuggled in through the claim: the key must already be committed', () => {
    const rogue = generateKeyPair();
    const cert = issueMiningGateCertificate(rogue.privateKey, rogue.publicKey, subject, 1_000_000);
    expect(() => assertMiningGate([GATE_ISSUER.publicKey], cert, subject, 1_000_000)).toThrow(/not issued by a key this chain committed/);
  });
});
