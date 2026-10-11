/**
 * Security suite: the mining gate (consensus rule, protocol 1.7.0).
 *
 * The account system (sign-in, second factor, one wallet per account) used to be enforced only by the platform, so a
 * person could skip it by posting a claim straight to a node. These tests prove the CHAIN now refuses that, at block
 * production, validation and sync replay — the one place the rule can actually be enforced, because a certificate's
 * validity is a function of the including block's protocol time.
 *
 * The other doors are covered where they belong, and the split is deliberate:
 *   - the node's HTTP endpoint: rpc-hardening.test.ts (a bad claim is the caller's 4xx, never a node fault);
 *   - gossip: the last describe here. A body that cannot DECODE is refused before a pool, because it can never apply
 *     to any state. A body that decodes but carries no certificate, or an expired one, is still relayed: only a
 *     producer knows the protocol time, so judging it at gossip would penalise an honest relayer.
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

describe('the gossip door: a claim body that cannot decode is refused before a pool', () => {
  // A SLASH body is decoded at gossip for exactly this reason (see slashing.test.ts): an
  // undecodable body can never apply to any state, on any node, at any height, so relaying it
  // is free work for the receiver and the peer that forwarded it is answerable. A MINING_CLAIM
  // body has the same property, and since 1.7.0 it carries a certificate whose half-present
  // form decodeMiningBody already calls MALFORMED — but nothing decoded it before the pool, so
  // every node pooled and re-broadcast a claim no producer could ever execute.
  //
  // Only the SHAPE is judged here. Whether the certificate is valid is deliberately NOT decided
  // at gossip: that is a function of the including block's protocol time, so a relayer whose
  // clock differs would penalise an honest peer for a claim that is perfectly minable.
  it('refuses an undecodable or half-certified claim body at gossip, and pools a well-formed one', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);

    const good = signedClaim(h, bob);
    expect(h.chain.checkGossipedTransaction(good).ok, 'a well-formed claim must still be relayed').toBe(true);
    expect(h.chain.mempool.add(good).accepted).toBe(true);

    const full = miningBody(h, bob);
    const claimId = decodeMiningBody(full).claimId;
    const halfCert = encodeMiningBody({
      claimId,
      claimSequence: 1,
      gate: { issuer: GATE_ISSUER.publicKey, issuedAt: h.chain.protocolTime, signature: '' },
    });
    const garbage: Array<[string, Uint8Array]> = [
      ['empty-body', new Uint8Array(0)],
      ['truncated', full.slice(0, full.length - 1)],
      ['half-present-certificate', halfCert],
    ];
    for (const [label, raw] of garbage) {
      const verdict = h.chain.checkGossipedTransaction(h.sign(bob, TxType.MINING_CLAIM, raw, { gas: 0n }));
      expect(verdict.ok, `${label} must be refused at gossip`).toBe(false);
      if (!verdict.ok) expect(verdict.code, label).toBe(ErrCode.MALFORMED);
    }
  });

  it('does not judge the certificate at gossip: an ungated or stale claim is still relayed for a producer to refuse', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    // No certificate at all. The chain refuses it (proven above), but a relayer cannot know
    // that without reading state and clocks, so gossip passes it and the producer refuses it.
    const ungated = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: 'none' }), { gas: 0n });
    expect(h.chain.checkGossipedTransaction(ungated).ok).toBe(true);
    // An expired certificate is the same case: it is well-formed, so gossip relays it.
    const stale = h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob, { gate: { issuedAt: 1 } }), { gas: 0n });
    expect(h.chain.checkGossipedTransaction(stale).ok).toBe(true);
    // And the producer is the one that refuses both.
    expect(h.tryBlock([ungated], { simulate: false }).code).toBe(ErrCode.MINING_GATE_REQUIRED);
  });
});
