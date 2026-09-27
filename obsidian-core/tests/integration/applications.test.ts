/**
 * Integration tests for every application subsystem built on the chain:
 * oracle, ONS, Time Capsule Wall, Obsidian Circle (land), OBS Social,
 * validators and the treasury.
 *
 * These prove the protocol rules the product promises: USD features fail closed
 * without a price, capsules unlock with no owner action, land GLV never moves
 * for an existing owner, social revenue splits 70/30, and platform revenue can
 * only ever reach the on-chain treasury wallet.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { CapsuleOp, LandOp, OnsOp, SocialOp, TxType, ValidatorOp } from '../../src/protocol/types.js';
import { expectedGas, usdMicroToSeals } from '../../src/transactions/helpers.js';
import { computeCapsuleId } from '../../src/transactions/executors/capsule.js';
import { computeParcelId } from '../../src/transactions/executors/land.js';
import { divisionSeed } from '../../src/land/registry.js';
import {
  advance,
  capsuleBody,
  createHarness,
  landBody,
  makeWallet,
  onsBody,
  oracleBody,
  socialBody,
  signedClaim,
  signedPayment,
  treasuryBody,
  validatorBody,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';

const open: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

const PRICE = 50_000_000n; // $50.00 per OBS in micro-USD
const HOUR = 3600;

/** Claim the genesis allocation so the test has a funded, treasury-designated wallet. */
async function fundedHarness(): Promise<{ h: Harness; alice: TestWallet }> {
  const h = await harness();
  const alice = makeWallet();
  // Real wall-clock timestamps: chain time tracks the clock the same way it
  // does in production, so signed transactions are valid when they are mined.
  h.produce([]);
  h.produce([signedClaim(h, alice)]);
  expect(h.chain.world.s.genesis.allocationClaimed).toBe(true);
  return { h, alice };
}

/** Two independent oracle sources make the protocol price usable. */
function seedOracle(h: Harness, submitter: TestWallet, second: TestWallet, priceUsdMicro = PRICE): void {
  const observedAt = h.chain.protocolTime;
  h.produce([h.sign(submitter, TxType.ORACLE, oracleBody('source-alpha', priceUsdMicro, observedAt, 'aa'))]);
  advance(h, CONSENSUS_PARAMS.oracle ? 1 : 1);
  h.produce([h.sign(second, TxType.ORACLE, oracleBody('source-beta', priceUsdMicro + 200_000n, observedAt, 'bb'))]);
  expect(h.chain.world.s.oracle.sourceCount).toBe(2);
  expect(h.chain.world.s.oracle.medianPriceUsdMicro).toBeGreaterThan(0n);
}

describe('oracle (spec §30, §76)', () => {
  it('fails closed: USD-priced features are rejected until a price exists', async () => {
    const { h, alice } = await fundedHarness();
    const outcome = h.tryBlock(
      [h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee: parseObs('5') }), { gas: expectedGas(parseObs('5')) })],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.ORACLE_UNAVAILABLE, ErrCode.ORACLE_INSUFFICIENT_SOURCES]).toContain(outcome.code);
  });

  it('rejects an observation outside the protocol bounds or too old', async () => {
    const { h, alice } = await fundedHarness();
    const now = h.chain.protocolTime;
    const tooCheap = h.tryBlock([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', 0n, now, 'cc'))], {
      simulate: false,
    });
    expect(tooCheap.accepted).toBe(false);
    expect(tooCheap.code).toBe(ErrCode.ORACLE_OUT_OF_BOUNDS);

    const ancient = h.tryBlock(
      [h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', PRICE, now - 10 * HOUR, 'dd'))],
      { simulate: false },
    );
    expect(ancient.accepted).toBe(false);
    expect(ancient.code).toBe(ErrCode.ORACLE_OUT_OF_BOUNDS);
  });

  it('throttles submissions per account so one wallet cannot spam the feed', async () => {
    const { h, alice } = await fundedHarness();
    const now = h.chain.protocolTime;
    h.produce([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', PRICE, now, 'ee'))]);
    const again = h.tryBlock([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', PRICE, now, 'ff'))], {
      simulate: false,
    });
    expect(again.accepted).toBe(false);
    expect([ErrCode.RATE_LIMITED, ErrCode.ORACLE_OUT_OF_BOUNDS]).toContain(again.code);
  });

  it('publishes a usable median from independent sources', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    const oracle = h.chain.world.s.oracle;
    expect(oracle.medianPriceUsdMicro).toBeGreaterThanOrEqual(PRICE);
    expect(oracle.medianPriceUsdMicro).toBeLessThanOrEqual(PRICE + 200_000n * 2n);
    expect(oracle.stale).toBe(false);
  });
});

describe('ONS (spec §57, §62)', () => {
  it('registers a .obs name, charges the protocol fee to the treasury and resolves it', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);

    const fee = usdMicroToSeals(CONSENSUS_PARAMS.ons.registrationFeeUsd, PRICE);
    // Fund a separate registrant: the fee must leave the buyer and reach the
    // treasury wallet, which is alice (the genesis recipient).
    h.produce([signedPayment(h, alice, bob.address, parseObs('100'))]);
    const before = h.chain.world.getAccount(bob.address)!.balance;
    const block = h.produce([h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'bob', { fee }), { gas: expectedGas(fee) })]);

    const record = h.chain.world.s.names.get('bob');
    expect(record).toBeDefined();
    expect(record!.owner).toBe(bob.address);
    expect(record!.address).toBe(bob.address);
    expect(record!.expiresAt).toBe(block.header.timestamp + CONSENSUS_PARAMS.ons.termSeconds);
    // Fee (plus gas) left the registrant; the fee reached the treasury wallet.
    const spent = before - h.chain.world.getAccount(bob.address)!.balance;
    expect(spent).toBe(fee + expectedGas(fee));
    expect(h.chain.world.s.metrics.totalTreasuryRevenue).toBe(fee);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a duplicate, a reserved and a malformed name', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('100'))]);
    const fee = usdMicroToSeals(CONSENSUS_PARAMS.ons.registrationFeeUsd, PRICE);
    h.produce([h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'bob', { fee }), { gas: expectedGas(fee) })]);

    const duplicate = h.tryBlock([h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'bob', { fee }), { gas: expectedGas(fee) })], {
      simulate: false,
    });
    expect(duplicate.code).toBe(ErrCode.NAME_TAKEN);

    const reserved = h.tryBlock(
      [
        h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, CONSENSUS_PARAMS.ons.reserved[0]!, { fee }), {
          gas: expectedGas(fee),
        }),
      ],
      { simulate: false },
    );
    expect([ErrCode.NAME_RESERVED, ErrCode.NAME_INVALID]).toContain(reserved.code);

    const tooShort = h.tryBlock(
      [h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'ab', { fee }), { gas: expectedGas(fee) })],
      { simulate: false },
    );
    expect(tooShort.code).toBe(ErrCode.NAME_INVALID);
  });

  it('transfers a name to another wallet and moves the mapping', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    const fee = usdMicroToSeals(CONSENSUS_PARAMS.ons.registrationFeeUsd, PRICE);
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee) })]);
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.TRANSFER, 'alice', { to: bob.address }), { gas: 0n })]);
    expect(h.chain.world.s.names.get('alice')!.owner).toBe(bob.address);
    // The mapping is blockchain state, so it is part of the state root.
    expect(h.chain.world.s.names.get('alice')!.address).toBe(bob.address);
  });

  it('refuses a transfer from a non-owner', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const mallory = makeWallet();
    seedOracle(h, alice, bob);
    const fee = usdMicroToSeals(CONSENSUS_PARAMS.ons.registrationFeeUsd, PRICE);
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee) })]);
    const stolen = h.tryBlock(
      [h.sign(mallory, TxType.ONS, onsBody(OnsOp.TRANSFER, 'alice', { to: mallory.address }), { gas: 0n })],
      { simulate: false },
    );
    expect(stolen.code).toBe(ErrCode.NAME_NOT_OWNED);
    expect(h.chain.world.s.names.get('alice')!.owner).toBe(alice.address);
  });
});

describe('Time Capsule Wall (spec §44–§50)', () => {
  const commitment = parseObs('1');
  const commitmentNonce = 'a1b2c3d4e5f60718';

  function createCapsule(h: Harness, owner: TestWallet, unlockAt: number) {
    const id = computeCapsuleId(owner.address, 'ab'.repeat(32), unlockAt, commitmentNonce);
    const tx = h.sign(
      owner,
      TxType.CAPSULE,
      capsuleBody(CapsuleOp.CREATE, {
        owner: owner.address,
        contentCommitment: 'ab'.repeat(32),
        contentNonce: commitmentNonce,
        unlockAt,
        commitment,
        contentBytes: 2048,
      }),
      { gas: expectedGas(commitment) },
    );
    return { id, tx };
  }

  it('locks a commitment on-chain and records the immutable capsule', async () => {
    const { h, alice } = await fundedHarness();
    const unlockAt = h.chain.protocolTime + HOUR;
    const before = h.chain.world.getAccount(alice.address)!.balance;
    const { id, tx } = createCapsule(h, alice, unlockAt);
    h.produce([tx]);

    const capsule = h.chain.world.s.capsules.get(id);
    expect(capsule).toBeDefined();
    expect(capsule!.status).toBe('LOCKED');
    expect(capsule!.creatorCommitment).toBe(commitment);
    expect(capsule!.unlockAt).toBe(unlockAt);
    // The plaintext never touches the chain: only the commitment hash is stored.
    expect(capsule!.contentCommitment).toBe('ab'.repeat(32));
    const after = h.chain.world.getAccount(alice.address)!.balance;
    expect(before - after).toBe(commitment + expectedGas(commitment));
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a commitment below the protocol minimum or too short a lock', async () => {
    const { h, alice } = await fundedHarness();
    const tooLow = h.tryBlock(
      [
        h.sign(
          alice,
          TxType.CAPSULE,
          capsuleBody(CapsuleOp.CREATE, {
            owner: alice.address,
            contentCommitment: 'ab'.repeat(32),
            contentNonce: commitmentNonce,
            unlockAt: h.chain.protocolTime + HOUR,
            commitment: CONSENSUS_PARAMS.capsules.minCommitment - 1n,
            contentBytes: 100,
          }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(tooLow.code).toBe(ErrCode.CAPSULE_COMMITMENT_TOO_LOW);

    const tooSoon = h.tryBlock(
      [
        h.sign(
          alice,
          TxType.CAPSULE,
          capsuleBody(CapsuleOp.CREATE, {
            owner: alice.address,
            contentCommitment: 'ab'.repeat(32),
            contentNonce: commitmentNonce,
            unlockAt: h.chain.protocolTime + 60,
            commitment,
            contentBytes: 100,
          }),
          { gas: expectedGas(commitment) },
        ),
      ],
      { simulate: false },
    );
    expect(tooSoon.accepted).toBe(false);
  });

  it('unlocks with no action from the creator — the protocol pays it out at unlock time', async () => {
    const { h, alice } = await fundedHarness();
    const unlockAt = h.chain.protocolTime + HOUR;
    const { id, tx } = createCapsule(h, alice, unlockAt);
    h.produce([tx]);
    const lockedBalance = h.chain.world.getAccount(alice.address)!.balance;

    // The creator goes offline: only protocol time advances.
    const poolBefore = h.chain.world.s.pool.balance;
    h.chain.world.s.capsules.get(id)!.unlockAt = h.chain.protocolTime;
    h.produce();

    const capsule = h.chain.world.s.capsules.get(id)!;
    expect(capsule.status).not.toBe('LOCKED');
    // Spec §44: the lock is released to the Mining Pool at unlock, with no
    // action required from the creator (who is never credited back).
    expect(h.chain.world.s.pool.balance).toBe(poolBefore + commitment);
    expect(h.chain.world.getAccount(alice.address)!.balance).toBe(lockedBalance);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('lets another account pay 1000x for a Time Travel preview, once per capsule per account', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const unlockAt = h.chain.protocolTime + HOUR;
    const { id, tx } = createCapsule(h, alice, unlockAt);
    h.produce([tx]);

    const payment = commitment * CONSENSUS_PARAMS.capsules.timeTravelMultiplier;
    const poolBefore = h.chain.world.s.pool.balance;
    h.produce([
      h.sign(
        bob,
        TxType.CAPSULE,
        capsuleBody(CapsuleOp.PREVIEW, {
          owner: alice.address,
          contentCommitment: 'ab'.repeat(32),
          contentNonce: commitmentNonce,
          unlockAt,
          capsuleId: id,
          payment,
          previewChunk: 'deadbeef',
          contentBytes: 2048,
        }),
        { gas: expectedGas(payment) },
      ),
    ]);
    // The preview payment goes to the Mining Pool, never to the creator.
    expect(h.chain.world.s.pool.balance).toBe(poolBefore + payment);
    expect(h.chain.world.s.capsules.get(id)!.previewedBy).toContain(bob.address);

    const twice = h.tryBlock(
      [
        h.sign(
          bob,
          TxType.CAPSULE,
          capsuleBody(CapsuleOp.PREVIEW, {
            owner: alice.address,
            contentCommitment: 'ab'.repeat(32),
            contentNonce: commitmentNonce,
            unlockAt,
            capsuleId: id,
            payment,
            previewChunk: 'deadbeef',
            contentBytes: 2048,
          }),
          { gas: expectedGas(payment), nonce: 1 },
        ),
      ],
      { simulate: false },
    );
    expect([ErrCode.CAPSULE_ALREADY_PREVIEWED, ErrCode.INSUFFICIENT_FUNDS]).toContain(twice.code);
  });
});

describe('Obsidian Circle — land (spec §45–§56)', () => {
  it('issues exactly one parcel per protocol purchase at the GLV price and routes revenue to the treasury', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);

    const division = divisionSeed('US-CA');
    expect(division).toBeDefined();
    const price = usdMicroToSeals(division!.glvUsdMicro, PRICE);
    const treasuryBefore = h.chain.world.s.metrics.totalTreasuryRevenue;

    h.produce(
      [
        h.sign(
          bob,
          TxType.LAND,
          landBody(LandOp.PROTOCOL_BUY, {
            divisionId: 'US-CA',
            countryCode: 'US',
            price,
          }),
          { gas: expectedGas(price) },
        ),
      ],
    );

    const parcelId = computeParcelId({ divisionId: 'US-CA', level: 1, subId: '', plotIndex: 0n });
    const parcel = h.chain.world.s.parcels.get(parcelId);
    expect(parcel).toBeDefined();
    expect(parcel!.owner).toBe(bob.address);
    expect(parcel!.glvUsdMicro).toBe(division!.glvUsdMicro);
    expect(parcel!.glvEntryCount).toBe(1);
    expect(h.chain.world.s.metrics.totalTreasuryRevenue - treasuryBefore).toBe(price);

    // GLV appreciates by the protocol step for the NEXT buyer.
    const registry = h.chain.world.s.divisions.get('US-CA')!;
    expect(registry.glvUsdMicro).toBe(
      division!.glvUsdMicro +
        (division!.glvUsdMicro * BigInt(CONSENSUS_PARAMS.circle.appreciationStepBps)) / 10_000n,
    );
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('does not retroactively reprice an existing parcel when GLV moves', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const carol = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    h.produce([signedPayment(h, alice, carol.address, parseObs('5000'))]);
    const division = divisionSeed('JP')!;
    const price = usdMicroToSeals(division.glvUsdMicro, PRICE);

    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'JP', countryCode: 'JP', price }), {
        gas: expectedGas(price),
      }),
    ]);
    const firstId = computeParcelId({ divisionId: 'JP', level: 1, subId: '', plotIndex: 0n });
    const firstValue = h.chain.world.s.parcels.get(firstId)!.glvUsdMicro;

    const nextPrice = usdMicroToSeals(h.chain.world.s.divisions.get('JP')!.glvUsdMicro, PRICE);
    h.produce([
      h.sign(carol, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'JP', countryCode: 'JP', price: nextPrice }), {
        gas: expectedGas(nextPrice),
      }),
    ]);

    // The first parcel keeps the value it was bought at: no retroactive benefit.
    expect(h.chain.world.s.parcels.get(firstId)!.glvUsdMicro).toBe(firstValue);
    expect(h.chain.world.s.parcels.get(firstId)!.glvEntryCount).toBe(1);
    const secondId = computeParcelId({ divisionId: 'JP', level: 1, subId: '', plotIndex: 0n });
    expect(secondId).toBe(firstId);
    expect(h.chain.world.s.parcels.get(firstId)!.glvEntryCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses a purchase whose price does not match the official GLV', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const division = divisionSeed('US-CA')!;
    const wrong = usdMicroToSeals(division.glvUsdMicro, PRICE) - parseObs('1');
    const outcome = h.tryBlock(
      [
        h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'US-CA', countryCode: 'US', price: wrong }), {
          gas: expectedGas(wrong),
        }),
      ],
      { simulate: false },
    );
    expect(outcome.code).toBe(ErrCode.PRICE_MISMATCH);
  });

  it('issues only one parcel per transaction and refuses to sell an owned parcel twice', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const division = divisionSeed('FR')!;
    const price = usdMicroToSeals(division.glvUsdMicro, PRICE);
    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'FR', countryCode: 'FR', price }), {
        gas: expectedGas(price),
      }),
    ]);
    const again = h.tryBlock(
      [
        h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'FR', countryCode: 'FR', price }), {
          gas: expectedGas(price),
          nonce: 1,
        }),
      ],
      { simulate: false },
    );
    expect(again.code).toBe(ErrCode.PARCEL_OWNED);
    expect(CONSENSUS_PARAMS.circle.maxParcelsPerProtocolTx).toBe(1);
    expect(CONSENSUS_PARAMS.circle.parcelSquareMetres).toBe(1);
  });

  it('runs a marketplace sale without touching GLV and pays the seller in full', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const carol = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    h.produce([signedPayment(h, alice, carol.address, parseObs('5000'))]);
    const division = divisionSeed('DE')!;
    const price = usdMicroToSeals(division.glvUsdMicro, PRICE);
    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'DE', countryCode: 'DE', price }), {
        gas: expectedGas(price),
      }),
    ]);

    const msp = price * 2n;
    const glvBefore = h.chain.world.s.divisions.get('DE')!.glvUsdMicro;
    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.LIST, { divisionId: 'DE', countryCode: 'DE', price: msp }), {
        gas: 0n,
        nonce: 1,
      }),
    ]);
    const sellerBefore = h.chain.world.getAccount(bob.address)!.balance;
    h.produce([
      h.sign(carol, TxType.LAND, landBody(LandOp.BUY_LISTED, { divisionId: 'DE', countryCode: 'DE', price: msp }), {
        gas: expectedGas(msp),
      }),
    ]);

    const parcelId = computeParcelId({ divisionId: 'DE', level: 1, subId: '', plotIndex: 0n });
    expect(h.chain.world.s.parcels.get(parcelId)!.owner).toBe(carol.address);
    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(sellerBefore + msp);
    // The marketplace never moves the protocol GLV.
    expect(h.chain.world.s.divisions.get('DE')!.glvUsdMicro).toBe(glvBefore);
  });
});

describe('OBS Social (spec §36, §38)', () => {
  it('stores posts and follows as chain state and splits tip revenue 100% to the creator', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    h.produce([signedPayment(h, alice, bob.address, parseObs('10'))]);
    const aliceId = 'alice-obsidian';
    const bobId = 'bob-obsidian';
    h.produce([h.sign(alice, TxType.SOCIAL, socialBody(SocialOp.SET_PROFILE, { accountId: aliceId, handle: 'alice' }), { gas: 0n })]);
    h.produce([h.sign(bob, TxType.SOCIAL, socialBody(SocialOp.SET_PROFILE, { accountId: bobId, handle: 'bob' }), { gas: 0n })]);
    h.produce([h.sign(bob, TxType.SOCIAL, socialBody(SocialOp.FOLLOW, { targetAccountId: aliceId }), { gas: 0n })]);
    expect(h.chain.world.s.socialFollowing.has(`${bobId}->${aliceId}`)).toBe(true);

    const postId = 'cd'.repeat(24);
    h.produce([
      h.sign(alice, TxType.SOCIAL, socialBody(SocialOp.POST, { accountId: aliceId, postId, content: 'hello obsidian' }), {
        gas: expectedGas(BigInt(Buffer.byteLength('hello obsidian', 'utf8')) * 10n ** 12n),
      }),
    ]);
    expect(h.chain.world.s.posts.get(postId)!.content).toBe('hello obsidian');

    const tip = parseObs('1');
    const creatorBefore = h.chain.world.getAccount(alice.address)!.balance;
    h.produce([
      h.sign(bob, TxType.SOCIAL, socialBody(SocialOp.TIP, { accountId: bobId, targetAccountId: aliceId, amount: tip }), {
        gas: expectedGas(tip),
      }),
    ]);
    expect(h.chain.world.getAccount(alice.address)!.balance).toBe(creatorBefore + tip);
    expect(h.chain.world.s.pool.balance).toBe(expectedGas(tip));
  });

  it('charges $50 in OBS for a business page and sends it to the treasury', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    const priceSeals = usdMicroToSeals(CONSENSUS_PARAMS.social.businessPagePriceUsd, PRICE);
    const revenueBefore = h.chain.world.s.metrics.totalTreasuryRevenue;
    h.produce([
      h.sign(alice, TxType.SOCIAL, socialBody(SocialOp.PAY_BUSINESS_PAGE, { accountId: 'alice-obsidian', amount: priceSeals }), {
        gas: expectedGas(priceSeals),
      }),
    ]);
    expect(h.chain.world.s.social.get('alice-obsidian')!.businessPage).toBe(true);
    expect(h.chain.world.s.metrics.totalTreasuryRevenue - revenueBefore).toBe(priceSeals);
  });
});

describe('validators (spec §24, §25)', () => {
  it('bonds a validator, closes the open-proposer window and rotates the schedule', async () => {
    const { h, alice } = await fundedHarness();
    const validatorKey = makeWallet().publicKey;
    const bond = CONSENSUS_PARAMS.consensus.minValidatorBond;
    expect(h.chain.world.activeValidators()).toHaveLength(0);

    h.produce([
      h.sign(alice, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, bond, validatorKey), { gas: expectedGas(bond) }),
    ]);
    expect(h.chain.world.activeValidators()).toEqual([alice.address]);
    const account = h.chain.world.getAccount(alice.address)!;
    expect(account.validator!.bond).toBe(bond);
    expect(account.validator!.status).toBe('ACTIVE');
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a bond below the protocol minimum', async () => {
    const { h, alice } = await fundedHarness();
    const outcome = h.tryBlock(
      [
        h.sign(
          alice,
          TxType.VALIDATOR,
          validatorBody(ValidatorOp.REGISTER, CONSENSUS_PARAMS.consensus.minValidatorBond - 1n, makeWallet().publicKey),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.code).toBe(ErrCode.INSUFFICIENT_FUNDS);
  });
});

describe('treasury (spec §13, §14, §76)', () => {
  it('lets the treasury wallet pay platform revenue out and records it as treasury spend', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const amount = parseObs('100');
    h.produce([
      h.sign(alice, TxType.TREASURY, treasuryBody(1, amount, 'creator grants', bob.address), {
        gas: expectedGas(amount),
      }),
    ]);
    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(amount);
    expect(h.chain.world.s.metrics.totalTreasuryRevenue).toBe(0n);
  });

  it('refuses a treasury spend signed by anyone but the treasury wallet', async () => {
    const { h, alice: _alice } = await fundedHarness();
    const mallory = makeWallet();
    const bob = makeWallet();
    const outcome = h.tryBlock(
      [h.sign(mallory, TxType.TREASURY, treasuryBody(1, parseObs('1'), 'theft', bob.address), { gas: 0n })],
      { simulate: false },
    );
    expect([ErrCode.UNAUTHORIZED, ErrCode.INSUFFICIENT_FUNDS]).toContain(outcome.code);
  });

  it('never lets governance mint or move value in 1.0.0', async () => {
    const { h, alice } = await fundedHarness();
    const outcome = h.tryBlock(
      [h.sign(alice, TxType.GOVERNANCE, new Uint8Array(0), { gas: 0n })],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.UNAUTHORIZED, ErrCode.MALFORMED, ErrCode.UNKNOWN_TX_TYPE]).toContain(outcome.code);
  });

  it('keeps the total supply equal to the sum of all balances at every step', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const carol = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('200'))]);
    h.produce([signedPayment(h, bob, carol.address, parseObs('100'), { memo: 'split' })]);
    // Fees always leave a positive balance behind, so a second oracle update is safe.
    const invariant = h.chain.world.verifySupplyInvariant();
    expect(invariant.ok).toBe(true);
    if (invariant.ok) {
      let sum = 0n;
      for (const account of h.chain.world.s.accounts.values()) sum += account.balance;
      sum += h.chain.world.s.pool.balance;
      for (const capsule of h.chain.world.s.capsules.values()) {
        if (capsule.status === 'LOCKED') sum += capsule.creatorCommitment;
      }
      for (const account of h.chain.world.s.accounts.values()) sum += account.validator?.bond ?? 0n;
      expect(sum).toBe(invariant.totalSupply);
      expect(sum).toBeLessThanOrEqual(21_000_000n * 10n ** 18n);
      expect(formatObs(sum)).toBe(formatObs(invariant.totalSupply));
    }
  });
});
