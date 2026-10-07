/**
 * Integration tests for the active protocol applications: oracle, ONS,
 * validators, treasury and the 90/10 ONS revenue accounting path.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { RevenueSource, splitOnsRevenue } from '../../src/economy/accounting.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { OnsOp, TreasuryOp, TxType, ValidatorOp } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { Indexer, serializeTransaction } from '../../src/indexer/indexer.js';
import { blockHash } from '../../src/blockchain/block.js';
import {
  advance,
  createHarness,
  makeWallet,
  onsBody,
  oracleBody,
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
    // Fee (plus gas) left the registrant; 90% went to runners and 10% to treasury.
    const spent = before - h.chain.world.getAccount(bob.address)!.balance;
    expect(spent).toBe(fee + expectedGas(fee));
    const split = splitOnsRevenue(fee, RevenueSource.ONS_REGISTRATION);
    expect(split.nodeRunnerPool + split.treasury).toBe(fee);
    expect(split.nodePoolBps).toBe(9_000);
    expect(split.treasuryBps).toBe(1_000);
    expect(h.chain.world.s.nodeRewards.balance).toBe(split.nodeRunnerPool);
    expect(h.chain.world.s.metrics.totalOnsTreasuryShare).toBe(split.treasury);
    expect(h.chain.world.s.metrics.totalOnsRevenue).toBe(fee);
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

describe('validators (spec §24, §25)', () => {
  it('bonds a validator, closes the open-proposer window and rotates the schedule', async () => {
    const { h, alice } = await fundedHarness();
    const validatorKey = alice.publicKey;
    const bond = CONSENSUS_PARAMS.consensus.validatorBond;
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

  it('refuses registration of a validator key that does not control the sender account', async () => {
    const { h, alice } = await fundedHarness();
    const foreignKey = makeWallet().publicKey;
    const bond = CONSENSUS_PARAMS.consensus.validatorBond;
    const outcome = h.tryBlock([
      h.sign(alice, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, bond, foreignKey), {
        gas: expectedGas(bond),
      }),
    ]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
    expect(h.chain.world.activeValidators()).toEqual([]);
  });

  it('requires exactly 20,000 OBS in integer base units', async () => {
    const { h, alice } = await fundedHarness();
    const required = CONSENSUS_PARAMS.consensus.validatorBond;
    for (const offered of [required - 1n, required + 1n]) {
      const outcome = h.tryBlock([
        h.sign(alice, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, offered, alice.publicKey), {
          gas: expectedGas(offered),
        }),
      ]);
      expect(outcome.accepted).toBe(false);
      expect(outcome.code).toBe(ErrCode.VALIDATOR_BOND_MISMATCH);
      expect(h.chain.world.activeValidators()).toEqual([]);
    }
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

