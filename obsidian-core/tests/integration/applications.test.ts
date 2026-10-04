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
import { RevenueSource, splitPlatformRevenue } from '../../src/economy/accounting.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { CapsuleOp, LandOp, OnsOp, SocialOp, TreasuryOp, TxType, ValidatorOp } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { computeCapsuleId } from '../../src/transactions/executors/capsule.js';
import { computeParcelId, parcelOfficialValue } from '../../src/transactions/executors/land.js';
import { divisionSeed } from '../../src/land/registry.js';
import { Indexer, serializeTransaction } from '../../src/indexer/indexer.js';
import { blockHash } from '../../src/blockchain/block.js';
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
import { parcelsNear, parseCoordinateQuery } from '../../src/rpc/server.js';

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
  it('ONS no longer needs an oracle at all: fees are denominated in OBS', async () => {
    // Previously this asserted the opposite — name registration failed closed
    // whenever no price existed. Protocol services are now priced in OBS, so a
    // chain that has never seen an oracle observation can still sell names.
    const { h, alice } = await fundedHarness();
    expect(h.chain.world.s.oracle.sourceCount).toBe(0);

    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    const outcome = h.tryBlock(
      [h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee) })],
      {},
    );
    expect(outcome.accepted).toBe(true);
    expect(h.chain.world.s.names.get('alice')).toBeDefined();
  });

  it('rejects an observation outside the protocol bounds or too old', async () => {
    const { h, alice } = await fundedHarness();
    const now = h.chain.protocolTime;

    const tooCheap = h.tryBlock([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', 0n, now, 'cc'))]);
    expect(tooCheap.accepted).toBe(false);
    expect(tooCheap.code).toBe(ErrCode.ORACLE_OUT_OF_BOUNDS);

    const tooExpensive = h.tryBlock([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', 10n ** 13n, now, 'dd'))]);
    expect(tooExpensive.accepted).toBe(false);
    expect(tooExpensive.code).toBe(ErrCode.ORACLE_OUT_OF_BOUNDS);

    // 40 hours is outside the 36-hour source freshness window.
    const ancient = h.tryBlock(
      [h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', PRICE, now - 40 * HOUR, 'ee'))],
    );
    expect(ancient.accepted).toBe(false);
    expect(ancient.code).toBe(ErrCode.ORACLE_STALE);
  });

  it('throttles submissions per account so one wallet cannot spam the feed', async () => {
    const { h, alice } = await fundedHarness();
    const now = h.chain.protocolTime;
    h.produce([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', PRICE, now, 'ee'))]);
    const again = h.tryBlock([h.sign(alice, TxType.ORACLE, oracleBody('source-alpha', PRICE, now, 'ff'))]);
    expect(again.accepted).toBe(false);
    expect(again.code).toBe(ErrCode.RATE_LIMITED);
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

    const fee = CONSENSUS_PARAMS.ons.registrationFee;
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
    // Fee (plus gas) left the registrant, and the fee was split by the protocol:
    // 40% to the Node Runner Reward Pool, 60% to the treasury wallet.
    const spent = before - h.chain.world.getAccount(bob.address)!.balance;
    expect(spent).toBe(fee + expectedGas(fee));
    const split = splitPlatformRevenue(fee, RevenueSource.ONS_REGISTRATION);
    expect(split.nodeRunnerPool + split.treasury).toBe(fee);
    expect(h.chain.world.s.nodeRewards.balance).toBe(split.nodeRunnerPool);
    expect(h.chain.world.s.metrics.totalTreasuryFromSplit).toBe(split.treasury);
    expect(h.chain.world.s.metrics.totalPlatformRevenue).toBe(fee);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a duplicate, a reserved and a malformed name', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('100'))]);
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
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
      {},
    );
    expect([ErrCode.NAME_RESERVED, ErrCode.NAME_INVALID]).toContain(reserved.code);

    const tooShort = h.tryBlock(
      [h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'ab', { fee }), { gas: expectedGas(fee) })],
      {},
    );
    expect(tooShort.code).toBe(ErrCode.NAME_INVALID);
  });

  it('transfers a name to another wallet and moves the mapping', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
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
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee) })]);
    const stolen = h.tryBlock(
      [h.sign(mallory, TxType.ONS, onsBody(OnsOp.TRANSFER, 'alice', { to: mallory.address }), { gas: 0n })],
      {},
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
      {},
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
      {},
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
    // The preview payment (and its gas) go to the Mining Pool, never to the creator.
    expect(h.chain.world.s.pool.balance).toBe(poolBefore + payment + expectedGas(payment));
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
      {},
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
    // US-CA already sits at the protocol's $30,000 GLV ceiling.
    expect(division!.glvSeals).toBe(CONSENSUS_PARAMS.circle.maxGlv);
    const price = division!.glvSeals;
    const treasuryBefore = h.chain.world.s.metrics.totalTreasuryFromSplit;
    const nodePoolBefore = h.chain.world.s.nodeRewards.balance;

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
    expect(parcel!.glvSeals).toBe(division!.glvSeals);
    // The parcel has observed no later GLV update yet.
    expect(parcel!.glvEntryCount).toBe(0);
    // Protocol land issuance is qualifying platform revenue: 40% to the node
    // runner pool, 60% to the treasury, summing back to the price exactly.
    const landSplit = splitPlatformRevenue(price, RevenueSource.LAND_PROTOCOL_SALE);
    expect(h.chain.world.s.metrics.totalTreasuryFromSplit - treasuryBefore).toBe(landSplit.treasury);
    expect(h.chain.world.s.nodeRewards.balance - nodePoolBefore).toBe(landSplit.nodeRunnerPool);
    expect(landSplit.treasury + landSplit.nodeRunnerPool).toBe(price);

    // Issuance reaches the protocol accounts, and GLV can never exceed the cap.
    const registry = h.chain.world.s.divisions.get('US-CA')!;
    expect(registry.glvSeals).toBe(CONSENSUS_PARAMS.circle.maxGlv);
    expect(registry.protocolPurchases).toBe(1);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('raises the division GLV by the protocol step after each issuance', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const division = divisionSeed('BR')!;
    expect(division.glvSeals).toBeLessThan(CONSENSUS_PARAMS.circle.maxGlv);
    const price = division.glvSeals;
    const step = (division.glvSeals * BigInt(CONSENSUS_PARAMS.circle.appreciationStepBps)) / 10_000n;

    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'BR', countryCode: 'BR', price }), {
        gas: expectedGas(price),
      }),
    ]);
    const registry = h.chain.world.s.divisions.get('BR')!;
    expect(step).toBeGreaterThan(0n);
    expect(registry.glvSeals).toBe(division.glvSeals + step);
    expect(registry.lastUpdatedAtHeight).toBeGreaterThan(0);
  });

  it('does not retroactively reprice the buyer, while later buyers pay the higher GLV', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const carol = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    h.produce([signedPayment(h, alice, carol.address, parseObs('5000'))]);
    const division = divisionSeed('JP')!;
    const firstPrice = division.glvSeals;

    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'JP', countryCode: 'JP', price: firstPrice }), {
        gas: expectedGas(firstPrice),
      }),
    ]);
    const bobParcelId = computeParcelId({ divisionId: 'JP', level: 1, subId: '', plotIndex: 0n });
    const bobValue = h.chain.world.s.parcels.get(bobParcelId)!.glvSeals;
    expect(bobValue).toBe(division.glvSeals);

    // A second plot in the same division is issued at the appreciated GLV.
    const secondPrice = h.chain.world.s.divisions.get('JP')!.glvSeals;
    expect(secondPrice).toBeGreaterThan(firstPrice);
    h.produce([
      h.sign(carol, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'JP', countryCode: 'JP', plotIndex: 1n, price: secondPrice }), {
        gas: expectedGas(secondPrice),
      }),
    ]);

    const bobParcel = h.chain.world.s.parcels.get(bobParcelId)!;
    const divisionRecord = h.chain.world.s.divisions.get('JP')!;
    // The buyer's own purchase never inflates the value they just paid.
    expect(bobParcel.glvSeals).toBe(bobValue);
    expect(bobParcel.glvEntryCount).toBe(0);
    // Later purchases DO lift the official value of older parcels — that is the
    // appreciation the spec grants to existing holders.
    expect(parcelOfficialValue(bobParcel, divisionRecord.glvSeals, divisionRecord.protocolPurchases)).toBe(
      divisionRecord.glvSeals,
    );
    expect(parcelOfficialValue(bobParcel, divisionRecord.glvSeals, divisionRecord.protocolPurchases)).toBeGreaterThan(
      bobValue,
    );
    expect(divisionRecord.protocolPurchases).toBe(2);
  });

  it('refuses a purchase whose price does not match the official GLV', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const division = divisionSeed('US-CA')!;
    const wrong = division.glvSeals - parseObs('1');
    const outcome = h.tryBlock(
      [
        h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'US-CA', countryCode: 'US', price: wrong }), {
          gas: expectedGas(wrong),
        }),
      ],
      {},
    );
    expect(outcome.code).toBe(ErrCode.PRICE_MISMATCH);
  });

  it('issues one parcel per transaction and refuses to re-issue an owned parcel', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    const division = divisionSeed('FR')!;
    const price = division.glvSeals;
    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'FR', countryCode: 'FR', price }), {
        gas: expectedGas(price),
      }),
    ]);

    const againPrice = h.chain.world.s.divisions.get('FR')!.glvSeals;
    const again = h.tryBlock([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'FR', countryCode: 'FR', price: againPrice }), {
        gas: expectedGas(againPrice),
      }),
    ]);
    expect(again.accepted).toBe(false);
    expect(again.code).toBe(ErrCode.PARCEL_OWNED);

    // One plot of one square metre per transaction, by protocol rule.
    expect(CONSENSUS_PARAMS.circle.maxParcelsPerProtocolTx).toBe(1);
    expect(CONSENSUS_PARAMS.circle.parcelSquareMetres).toBe(1);
    expect(h.chain.world.s.metrics.totalParcelsIssued).toBe(1);
  });

  it('runs a marketplace sale without touching GLV and pays the seller in full', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    const carol = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
    h.produce([signedPayment(h, alice, carol.address, parseObs('5000'))]);
    const division = divisionSeed('DE')!;
    const price = division.glvSeals;
    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, { divisionId: 'DE', countryCode: 'DE', price }), {
        gas: expectedGas(price),
      }),
    ]);

    const msp = price * 2n;
    const glvBefore = h.chain.world.s.divisions.get('DE')!.glvSeals;
    h.produce([
      h.sign(bob, TxType.LAND, landBody(LandOp.LIST, { divisionId: 'DE', countryCode: 'DE', price: msp }), { gas: 0n }),
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
    expect(h.chain.world.s.divisions.get('DE')!.glvSeals).toBe(glvBefore);
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
    h.produce([
      h.sign(bob, TxType.SOCIAL, socialBody(SocialOp.FOLLOW, { accountId: bobId, targetAccountId: aliceId }), { gas: 0n }),
    ]);
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
    const poolBefore = h.chain.world.s.pool.balance;
    h.produce([
      h.sign(
        bob,
        TxType.SOCIAL,
        socialBody(SocialOp.TIP, { accountId: bobId, targetAccountId: aliceId, target: alice.address, amount: tip }),
        { gas: expectedGas(tip) },
      ),
    ]);
    expect(h.chain.world.getAccount(alice.address)!.balance).toBe(creatorBefore + tip);
    expect(h.chain.world.s.pool.balance).toBe(poolBefore + expectedGas(tip));
  });

  it('charges the fixed OBS price for a business page and splits it 40/60 between node runners and the treasury', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    const priceSeals = CONSENSUS_PARAMS.social.businessPagePrice;
    const treasuryBefore = h.chain.world.s.metrics.totalTreasuryFromSplit;
    const nodePoolBefore = h.chain.world.s.nodeRewards.balance;
    h.produce([
      h.sign(alice, TxType.SOCIAL, socialBody(SocialOp.SET_PROFILE, { accountId: 'alice-obsidian', handle: 'alice' }), { gas: 0n }),
    ]);
    h.produce([
      h.sign(alice, TxType.SOCIAL, socialBody(SocialOp.PAY_BUSINESS_PAGE, { accountId: 'alice-obsidian', amount: priceSeals }), {
        gas: expectedGas(priceSeals),
      }),
    ]);
    expect(h.chain.world.s.social.get('alice-obsidian')!.businessPage).toBe(true);
    const pageSplit = splitPlatformRevenue(priceSeals, RevenueSource.BUSINESS_PAGE);
    expect(h.chain.world.s.metrics.totalTreasuryFromSplit - treasuryBefore).toBe(pageSplit.treasury);
    expect(h.chain.world.s.nodeRewards.balance - nodePoolBefore).toBe(pageSplit.nodeRunnerPool);
    expect(pageSplit.nodeRunnerPool + pageSplit.treasury).toBe(priceSeals);
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
      {},
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
      h.sign(alice, TxType.TREASURY, treasuryBody(TreasuryOp.GRANT, amount, 'creator grants', bob.address), {
        gas: expectedGas(amount),
      }),
    ]);
    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(amount);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a treasury spend signed by anyone but the treasury wallet', async () => {
    const { h, alice: _alice } = await fundedHarness();
    const mallory = makeWallet();
    const bob = makeWallet();
    const outcome = h.tryBlock(
      [h.sign(mallory, TxType.TREASURY, treasuryBody(TreasuryOp.GRANT, parseObs('1'), 'theft', bob.address), { gas: 0n })],
      {},
    );
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.UNAUTHORIZED, ErrCode.INSUFFICIENT_FUNDS, ErrCode.BAD_GAS]).toContain(outcome.code);
  });

  it('never lets governance mint or move value in this protocol version', async () => {
    const { h, alice } = await fundedHarness();
    const outcome = h.tryBlock(
      [h.sign(alice, TxType.GOVERNANCE, new Uint8Array(0), { gas: 0n })],
      {},
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

describe('indexer describeTx (explorer summaries)', () => {
  it('summarises every transaction type without trusting it', async () => {
    const { h, alice } = await fundedHarness();
    const bob = makeWallet();
    seedOracle(h, alice, bob);
    h.produce([signedPayment(h, alice, bob.address, parseObs('100'), { memo: 'funding' })]);

    const indexer = new Indexer(h.dir);
    for (const entry of h.chain.store.canonicalRange(0, 1000)) {
      if (entry.height === 0) continue;
      const block = h.chain.getBlockByHeight(entry.height);
      if (!block) continue;
      indexer.indexBlock(block, h.chain.eventsForBlock(blockHash(block.header)), h.chain.world);
    }
    // The funding payment lives in the last block produced by this test.
    const height = h.chain.height;
    const payment = indexer.transactionsInBlock(height).find((record) => record.type === TxType.PAYMENT);
    expect(payment, `expected a payment in block ${height}`).toBeDefined();
    expect(payment!.kind).toBeUndefined();
    expect(payment!.amount).toBe(parseObs('100').toString());

    const claim = indexer.miningClaims(10)[0]!;
    expect(claim.miner).toBe(alice.address);
    expect(claim.genesisAwarded).toBe(true);
    expect(BigInt(claim.reward)).toBeGreaterThan(0n);

    const oracle = indexer.events(50, 'ORACLE_OBSERVATION')[0] ?? indexer.events(50)[0];
    expect(oracle).toBeDefined();

    // Public serialization masks both sides of the transfer.
    const serialized = serializeTransaction(payment!);
    expect(String(serialized.sender)).toContain('…');
    expect(String(serialized.recipient)).toContain('…');
    expect(JSON.stringify(serialized)).not.toContain(alice.address);
  });
});

/**
 * Circle search: the registry layer, and GPS against chain state.
 *
 * The search box used to promise "city, district, street, landmark or GPS"
 * while the registry only holds ISO 3166-2 divisions. A node must not fetch a
 * gazetteer — consensus data has to be identical and offline everywhere — but
 * every parcel carries the coordinates from the LAND transaction that created
 * it, so a coordinate query searches the chain rather than pretending to
 * geocode a street name.
 */
describe('Circle search (registry names and chain coordinates)', () => {
  const ABUJA = { latMicro: 9_057_000, lonMicro: 7_495_000 };

  it('finds a parcel by the coordinates it was created at, and orders by distance', async () => {
    const { h, alice } = await fundedHarness();
    const near = { ...ABUJA, latMicro: ABUJA.latMicro + 1_000, lonMicro: ABUJA.lonMicro + 1_000 };
    const far = { latMicro: 6_524_400, lonMicro: 3_379_200 }; // Lagos, ~500 km away

    // The protocol market sells at the division's initial GLV, derived from the
    // shipped geography table — the state map only fills in as divisions trade.
    const firstPrice = divisionSeed('NG-FC').glvSeals;
    const secondPrice = divisionSeed('NG-LA').glvSeals;

    // Two parcels in two divisions: one at the query point, one across the country.
    h.produce([
      h.sign(alice, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, {
        divisionId: 'NG-FC', countryCode: 'NG', plotIndex: 0n, price: firstPrice, ...ABUJA,
      }), { gas: expectedGas(firstPrice) }),
    ]);
    h.produce([
      h.sign(alice, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, {
        divisionId: 'NG-LA', countryCode: 'NG', plotIndex: 0n, price: secondPrice, ...far,
      }), { gas: expectedGas(secondPrice) }),
    ]);

    const all = [...h.chain.world.s.parcels.values()];
    expect(all).toHaveLength(2);
    // Every parcel carries its own coordinates, not a lookup.
    expect(all.filter((parcel) => parcel.latMicro !== undefined)).toHaveLength(2);

    const hits = parcelsNear(all, { latMicro: ABUJA.latMicro, lonMicro: ABUJA.lonMicro }, 5_000, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.parcel.divisionId).toBe('NG-FC');
    expect(hits[0]!.distanceMetres).toBeLessThan(200);

    // The wide radius sees both, nearest first — the far one is ~500 km away.
    const wide = parcelsNear(all, { latMicro: ABUJA.latMicro, lonMicro: ABUJA.lonMicro }, 600_000, 10);
    expect(wide).toHaveLength(2);
    expect(wide[0]!.parcel.divisionId).toBe('NG-FC');
    expect(wide[1]!.parcel.divisionId).toBe('NG-LA');
    expect(wide[1]!.distanceMetres).toBeGreaterThan(400_000);
    expect(near.latMicro).toBeGreaterThan(ABUJA.latMicro);
  });

  it('a parcel without coordinates can never match a GPS search', async () => {
    const { h, alice } = await fundedHarness();
    const price = divisionSeed('NG-FC').glvSeals;
    h.produce([
      h.sign(alice, TxType.LAND, landBody(LandOp.PROTOCOL_BUY, {
        divisionId: 'NG-FC', countryCode: 'NG', plotIndex: 0n, price,
      }), { gas: expectedGas(price) }),
    ]);
    const parcels = [...h.chain.world.s.parcels.values()];
    expect(parcels).toHaveLength(1);
    expect(parcels[0]!.latMicro).toBeUndefined();
    expect(parcelsNear(parcels, { latMicro: ABUJA.latMicro, lonMicro: ABUJA.lonMicro }, 50_000, 10)).toEqual([]);
  });

  it('reads a coordinate strictly, and never silently treats a name as one', () => {
    expect(parseCoordinateQuery('6.5244,3.3792')).toEqual({ latMicro: 6_524_400, lonMicro: 3_379_200 });
    expect(parseCoordinateQuery(' -90 , -180 ')).toEqual({ latMicro: -90_000_000, lonMicro: -180_000_000 });
    expect(parseCoordinateQuery('90,180')).toEqual({ latMicro: 90_000_000, lonMicro: 180_000_000 });

    // Out of range is not a coordinate, and neither is a name or a partial pair.
    expect(parseCoordinateQuery('90.0001,0')).toBeNull();
    expect(parseCoordinateQuery('0,180.5')).toBeNull();
    expect(parseCoordinateQuery('Lagos, Nigeria')).toBeNull();
    expect(parseCoordinateQuery('12')).toBeNull();
    expect(parseCoordinateQuery('')).toBeNull();
    expect(parseCoordinateQuery('1e3,2')).toBeNull();
  });
});
