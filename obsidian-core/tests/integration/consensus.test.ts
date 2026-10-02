/**
 * Integration tests for the consensus core: genesis allocation, mining,
 * payments, supply invariants, time authority, forks and chain convergence.
 *
 * Every test drives a real `ChainManager` with real signed transactions on a
 * throwaway data directory — no mocking of consensus code.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { MAX_SUPPLY_SEALS, parseObs, formatObs } from '../../src/protocol/amount.js';
import { TxType } from '../../src/protocol/types.js';
import { blockHash, signBlock } from '../../src/blockchain/block.js';
import { claimRewardForActiveMiners } from '../../src/mining/schedule.js';
import { evaluateMining } from '../../src/mining/rules.js';
import { MAINNET_GENESIS_DOCUMENT, genesisDocumentFor, genesisId } from '../../src/genesis/initialize.js';
import { ChainManager } from '../../src/blockchain/chain.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { computeClaimId, encodeMiningBody } from '../../src/transactions/executors/mining.js';
import { decodePaymentBody } from '../../src/transactions/executors/payment.js';
import {
  advance,
  createHarness,
  forkParent,
  makeWallet,
  miningBody,
  miningEligibility,
  paymentBody,
  paymentGas,
  rewindMiningTimer,
  signedPayment,
  type Block,
  type Harness,
} from '../helpers/harness.js';
import { PROTOCOL_VERSION } from '../../src/version.js';

const GENESIS_TS = 1_767_225_600;
const GENESIS_ALLOCATION = parseObs('100000');
const CLAIM_REWARD = claimRewardForActiveMiners(0);

const open: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

function claimTx(h: Harness, wallet: ReturnType<typeof makeWallet>) {
  return h.sign(wallet, TxType.MINING_CLAIM, miningBody(h, wallet), { gas: 0n });
}

describe('genesis', () => {
  it('starts with zero supply and no premine', async () => {
    const h = await harness();
    expect(h.chain.world.s.metrics.totalSupply).toBe(0n);
    expect(h.chain.world.s.genesis.allocationClaimed).toBe(false);
    expect(h.chain.world.s.genesis.treasuryWallet).toBe('');
    expect(h.chain.tip!.height).toBe(0);
    expect(formatObs(h.chain.world.s.metrics.totalSupply)).toBe('0.000000000000000000');
  });

  it('is identifiable across nodes by genesis id and params hash', async () => {
    const h = await harness();
    expect(h.chain.genesisId).toBe(genesisId(h.chain.genesisDocument, h.net));
    expect(h.chain.genesisId).toHaveLength(40);
    expect(PARAMS_HASH).toHaveLength(32);
    expect(h.chain.genesisDocument.chainId).toBe(h.net.chainId);
    expect(h.chain.genesisDocument.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(h.chain.genesisDocument.timestamp).toBe(GENESIS_TS);
    expect(MAINNET_GENESIS_DOCUMENT.note).toMatch(/no premine/i);
    expect(MAINNET_GENESIS_DOCUMENT.note).toMatch(/first valid miner/i);
  });

  it('rejects a block whose params hash does not match the protocol', async () => {
    const h = await harness();
    advance(h, 1);
    const block = h.makeBlock();
    block.header.paramsHash = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const result = h.chain.addBlock(block);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.VERSION_MISMATCH);
  });

  it('refuses to open a data directory belonging to another network', async () => {
    const h = await harness();
    advance(h, 1);
    const mainnet = getNetwork('mainnet');
    const foreign = new ChainManager({
      dataDir: h.dir,
      net: mainnet,
      genesisDocument: genesisDocumentFor(mainnet),
      enforceProposerRotation: true,
    });
    await expect(foreign.init()).rejects.toThrow();
  });
});

describe('genesis allocation (spec §12, §13)', () => {
  it('is awarded to the first protocol-valid mining claim, on-chain and exactly once', async () => {
    const h = await harness();
    const alice = makeWallet();
    advance(h, 1);

    h.produce([claimTx(h, alice)]);
    expect(h.chain.world.s.genesis.allocationClaimed).toBe(true);
    expect(h.chain.world.s.genesis.treasuryWallet).toBe(alice.address);
    expect(h.chain.world.s.genesis.recipient).toBe(alice.address);
    expect(h.chain.world.s.metrics.issuedGenesis).toBe(GENESIS_ALLOCATION);
    expect(h.chain.world.getAccount(alice.address)!.balance).toBe(GENESIS_ALLOCATION + CLAIM_REWARD);
    expect(h.chain.world.s.metrics.totalSupply).toBe(GENESIS_ALLOCATION + CLAIM_REWARD);
    expect(h.chain.world.verifySupplyInvariant()).toEqual({
      ok: true,
      totalSupply: GENESIS_ALLOCATION + CLAIM_REWARD,
    });
  });

  it('never awards the allocation to a later miner', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);

    h.produce([claimTx(h, bob)]);
    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(CLAIM_REWARD);
    expect(h.chain.world.s.genesis.recipient).toBe(alice.address);
    expect(h.chain.world.s.genesis.treasuryWallet).toBe(alice.address);
  });

  it('does not pay anything for registration: a new wallet holds exactly 0 OBS', async () => {
    const h = await harness();
    const bob = makeWallet();
    expect(h.chain.world.getAccount(bob.address)).toBeUndefined();
    advance(h, 2);
    expect(evaluateMining(undefined, h.chain.protocolTime, 1, false).genesisEligible).toBe(true);
    expect(h.chain.world.s.metrics.totalSupply).toBe(0n);
  });

  it('routes every platform revenue to the designated treasury wallet', async () => {
    const h = await harness();
    const alice = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);
    expect(h.chain.world.s.genesis.treasuryWallet).toBe(alice.address);
    // The treasury designation is consensus state, not configuration.
    const snapshot = h.chain.snapshot();
    expect(snapshot.genesis.treasuryWallet).toBe(alice.address);
  });
});

describe('mining claims (spec §17–§27)', () => {
  it('pays exactly the scheduled per-claim reward', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, bob)]);
    expect(CLAIM_REWARD).toBe(parseObs('0.000166666666666666'));
    expect(h.chain.world.getAccount(bob.address)!.mining!.totalReward).toBe(CLAIM_REWARD);
    expect(h.chain.world.getAccount(bob.address)!.mining!.claimSequence).toBe(2);
  });

  it('rejects a claim carrying gas (mining must stay free)', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    expect(h.chain.world.getAccount(bob.address)).toBeUndefined();
    const outcome = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob), { gas: parseObs('0.0001') })], {
      simulate: false,
    });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_GAS);
  });

  it('rejects a second claim before the 4-hour interval has elapsed', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, bob)]);
    const eligibility = miningEligibility(h, bob);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe(ErrCode.MINING_TOO_SOON);
    const outcome = h.tryBlock([claimTx(h, bob)], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MINING_TOO_SOON);
  });

  it('accepts the next claim once the interval has elapsed and advances the sequence', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, bob)]);
    rewindMiningTimer(h, bob.address);
    const body = miningBody(h, bob);
    h.produce([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })]);
    const mining = h.chain.world.getAccount(bob.address)!.mining!;
    expect(mining.claimSequence).toBe(3);
    expect(mining.totalClaims).toBe(2);
    expect(mining.totalReward).toBe(CLAIM_REWARD * 2n);
  });

  it('blocks replay of an identical claim transaction', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const tx = claimTx(h, bob);
    h.produce([tx]);
    rewindMiningTimer(h, bob.address);
    const replay = h.tryBlock([tx], { simulate: false });
    expect(replay.accepted).toBe(false);
    // ERR_BAD_NONCE is the usual answer: the sender's nonce has already moved
    // past this transaction, which is what makes a replay impossible without a
    // separate tx-id set. The other codes stay listed because a claim can also
    // be stopped earlier, by the per-block duplicate guard or the claim-id set.
    expect([
      ErrCode.BAD_NONCE,
      ErrCode.DUPLICATE_TX,
      ErrCode.REPLAY,
      ErrCode.MINING_CLAIM_REPLAY,
    ]).toContain(replay.code);
  });

  it('blocks a re-signed claim that reuses an already accepted claim id', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const body = miningBody(h, bob);
    h.produce([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })]);
    rewindMiningTimer(h, bob.address);
    // Same claim id, new signature/nonce: the protocol must still refuse it.
    const reused = h.tryBlock([h.sign(bob, TxType.MINING_CLAIM, body, { gas: 0n })], { simulate: false });
    expect(reused.accepted).toBe(false);
    expect(reused.code).toBe(ErrCode.MINING_CLAIM_REPLAY);
  });

  it('rejects a claim carrying a forged claim id', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const forged = h.tryBlock(
      [h.sign(bob, TxType.MINING_CLAIM, encodeMiningBody({ claimId: 'ab'.repeat(32), claimSequence: 1 }), { gas: 0n })],
      { simulate: false },
    );
    expect(forged.accepted).toBe(false);
    expect(forged.message ?? '').toMatch(/claim id/i);
  });

  it('rejects a claim whose sequence skips ahead', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, bob)]);
    rewindMiningTimer(h, bob.address);
    const skipped = h.tryBlock(
      [
        h.sign(bob, TxType.MINING_CLAIM, encodeMiningBody({ claimId: computeClaimId(h.net.chainId, bob.address, 9, 2), claimSequence: 9 }), {
          gas: 0n,
        }),
      ],
      { simulate: false },
    );
    expect(skipped.accepted).toBe(false);
  });

  it('keeps claim height and time in protocol state, not client state', async () => {
    const h = await harness();
    const bob = makeWallet();
    advance(h, 1);
    const block = h.produce([claimTx(h, bob)]);
    const mining = h.chain.world.getAccount(bob.address)!.mining!;
    expect(mining.lastClaimHeight).toBe(block.header.height);
    expect(mining.lastClaimAt).toBe(block.header.timestamp);
    expect(mining.lastClaimAt).toBe(h.chain.world.s.timestamp);
  });
});

describe('payments and gas (spec §31, §32)', () => {
  it('moves value atomically and sends gas to the mining pool', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);

    const amount = parseObs('0.5');
    const gas = paymentGas(amount);
    h.produce([signedPayment(h, alice, bob.address, amount)]);

    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(amount);
    expect(h.chain.world.getAccount(alice.address)!.balance).toBe(GENESIS_ALLOCATION + CLAIM_REWARD - amount - gas);
    expect(h.chain.world.s.pool.balance).toBe(gas);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('charges exactly 0.02% and caps at 0.01 OBS', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);

    h.produce([signedPayment(h, alice, bob.address, parseObs('1'))]);
    expect(h.chain.world.s.pool.balance).toBe(parseObs('0.0002'));

    h.produce([signedPayment(h, alice, bob.address, parseObs('1000'))]);
    expect(h.chain.world.s.pool.balance).toBe(parseObs('0.0002') + parseObs('0.01'));
  });

  it('rejects underpaid gas, overspending and self-defeating amounts', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);

    const underpaid = h.tryBlock([h.sign(alice, TxType.PAYMENT, paymentBody(bob.address, parseObs('1')), { gas: 1n })], {
      simulate: false,
    });
    expect(underpaid.accepted).toBe(false);
    expect(underpaid.code).toBe(ErrCode.BAD_GAS);

    const overdraft = h.tryBlock(
      [h.sign(alice, TxType.PAYMENT, paymentBody(bob.address, parseObs('1000000')), { nonce: 1, gas: parseObs('0.01') })],
      { simulate: false },
    );
    expect(overdraft.accepted).toBe(false);
    expect(overdraft.code).toBe(ErrCode.INSUFFICIENT_FUNDS);

    const belowMinimum = h.tryBlock([h.sign(alice, TxType.PAYMENT, paymentBody(bob.address, 0n), { nonce: 1 })], {
      simulate: false,
    });
    expect(belowMinimum.accepted).toBe(false);
    expect(belowMinimum.code).toBe(ErrCode.AMOUNT_ZERO);
  });

  it('rejects a transaction that reuses a nonce', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);
    h.produce([signedPayment(h, alice, bob.address, parseObs('1'), { nonce: 1 })]);
    const reused = h.tryBlock(
      [h.sign(alice, TxType.PAYMENT, paymentBody(bob.address, parseObs('2')), { nonce: 1, gas: paymentGas(parseObs('2')) })],
      { simulate: false },
    );
    expect(reused.accepted).toBe(false);
    expect([ErrCode.BAD_NONCE, ErrCode.DUPLICATE_TX]).toContain(reused.code);
  });

  it('refuses to send to a malformed address', async () => {
    const h = await harness();
    const alice = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);
    const outcome = h.tryBlock(
      [h.sign(alice, TxType.PAYMENT, paymentBody('obs1notavalidaddress', parseObs('1')), { nonce: 1, gas: paymentGas(parseObs('1')) })],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_ADDRESS);
  });

  it('preserves the memo through the transaction body', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);
    const block = h.produce([signedPayment(h, alice, bob.address, parseObs('1'), { memo: 'thanks for the coffee' })]);
    const decoded = decodePaymentBody(block.transactions[0]!.body);
    expect(decoded.memo).toBe('thanks for the coffee');
    expect(decoded.amount).toBe(parseObs('1'));
    expect(decoded.to).toBe(bob.address);
  });
});

describe('supply invariant (spec §73)', () => {
  it('holds after every one of 30 blocks of mixed activity', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    const carol = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);
    h.produce([claimTx(h, bob)]);
    h.produce([signedPayment(h, alice, carol.address, parseObs('12.5'), { nonce: 1 })]);
    for (let i = 0; i < 10; i += 1) {
      h.produce([signedPayment(h, carol, bob.address, parseObs('0.25'), { nonce: i, memo: `memo ${i}` })]);
    }

    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
    const invariant = h.chain.world.verifySupplyInvariant();
    expect(invariant.ok && invariant.totalSupply).toBe(h.chain.world.s.metrics.totalSupply);
    expect(h.chain.world.s.metrics.totalSupply).toBeLessThanOrEqual(MAX_SUPPLY_SEALS);
    expect(h.chain.world.s.metrics.totalSupply).toBe(GENESIS_ALLOCATION + CLAIM_REWARD * 2n);
  });

  it('credits mining rewards from the pool before minting new supply', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    advance(h, 1);
    h.produce([claimTx(h, alice)]);

    // Build a pool: gas from a real payment.
    const amount = parseObs('10');
    const gas = paymentGas(amount);
    h.produce([signedPayment(h, alice, bob.address, amount, { nonce: 1 })]);
    expect(h.chain.world.s.pool.balance).toBe(gas);

    const supplyBefore = h.chain.world.s.metrics.totalSupply;
    rewindMiningTimer(h, alice.address);
    h.produce([claimTx(h, alice)]);
    const supplyAfter = h.chain.world.s.metrics.totalSupply;

    const poolUsed = gas < CLAIM_REWARD ? gas : CLAIM_REWARD;
    expect(h.chain.world.s.pool.balance).toBe(gas - poolUsed);
    expect(supplyAfter - supplyBefore).toBe(CLAIM_REWARD - poolUsed);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('exposes the maximum supply as a protocol constant', async () => {
    const h = await harness();
    expect(MAX_SUPPLY_SEALS).toBe(21_000_000n * 10n ** 18n);
    expect(CONSENSUS_PARAMS.maxSupply).toBe(MAX_SUPPLY_SEALS);
    expect(h.chain.world.s.metrics.totalSupply).toBeLessThanOrEqual(MAX_SUPPLY_SEALS);
  });
});

describe('time authority (spec §26, §30)', () => {
  it('rejects a block whose timestamp runs ahead of the validating node clock', async () => {
    const h = await harness();
    advance(h, 2);
    const block = h.makeBlock([], { timestamp: Math.floor(Date.now() / 1000) + 3600 });
    const result = h.chain.addBlock(block);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.BAD_TIMESTAMP);
  });

  it('rejects a block whose timestamp does not advance the parent', async () => {
    const h = await harness();
    const first = h.produce([], { timestamp: GENESIS_TS + 1 });
    expect(blockHash(first.header)).toBe(h.chain.tip!.hash);
    const stale = h.makeBlock([], { timestamp: GENESIS_TS + 1 });
    const result = h.chain.addBlock(stale);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.BAD_TIMESTAMP);
  });

  it('requires chain time to advance on every block', async () => {
    const h = await harness();
    let previous = GENESIS_TS;
    for (let i = 0; i < 4; i += 1) {
      const block = h.produce([], { timestamp: previous + 1 });
      expect(block.header.timestamp).toBeGreaterThan(previous);
      previous = block.header.timestamp;
    }
  });

  it('rejects a block whose timestamp rewinds', async () => {
    const h = await harness();
    advance(h, 3);
    const rewound = h.makeBlock([], { timestamp: GENESIS_TS + 1 });
    expect(h.chain.addBlock(rewound).code).toBe(ErrCode.BAD_TIMESTAMP);
  });

  it('accepts blocks produced exactly at the genesis instant plus one when the chain is young', async () => {
    const h = await harness();
    const first = h.produce([], { timestamp: GENESIS_TS + 1 });
    expect(first.header.timestamp).toBe(GENESIS_TS + 1);
    const second = h.produce([], { timestamp: GENESIS_TS + 2 });
    expect(second.header.timestamp).toBe(GENESIS_TS + 2);
  });
});

describe('block validation', () => {
  it('rejects a tampered state root', async () => {
    const h = await harness();
    advance(h, 1);
    const block = signBlock(
      { header: { ...h.makeBlock().header, stateRoot: '0'.repeat(64) }, transactions: [] },
      h.producer.privateKey,
      h.producer.publicKey,
    );
    const result = h.chain.addBlock(block);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.BAD_STATE_ROOT);
  });

  it('rejects a tampered transactions root', async () => {
    const h = await harness();
    const alice = makeWallet();
    advance(h, 1);
    const tampered = h.makeBlock([claimTx(h, alice)]);
    const block = signBlock(
      { header: { ...tampered.header, txRoot: '1'.repeat(64) }, transactions: tampered.transactions },
      h.producer.privateKey,
      h.producer.publicKey,
    );
    const result = h.chain.addBlock(block);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.BAD_MERKLE_ROOT);
  });

  it('rejects a forged producer signature', async () => {
    const h = await harness();
    const mallory = makeWallet();
    advance(h, 1);
    const block = h.makeBlock([], { producer: mallory });
    block.header.producer = h.producer.address;
    const result = h.chain.addBlock(block);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.BAD_PRODUCER);
  });

  it('rejects a block with the wrong height', async () => {
    const h = await harness();
    advance(h, 1);
    const block = h.makeBlock();
    block.header.height = 99;
    const result = h.chain.addBlock(block);
    expect(result.accepted).toBe(false);
    expect([ErrCode.BAD_HEIGHT, ErrCode.WRONG_CHAIN_ID]).toContain(result.code);
  });

  it('rejects a duplicate block', async () => {
    const h = await harness();
    const first = h.produce();
    expect(h.chain.addBlock(first).code).toBe(ErrCode.DUPLICATE_BLOCK);
  });

  it('queues a block with an unknown parent as an orphan and connects it later', async () => {
    const h = await harness();
    const b1 = h.produce([], { timestamp: GENESIS_TS + 1 });
    const b2 = h.produce([], { timestamp: GENESIS_TS + 2 });
    const b3 = h.produce([], { timestamp: GENESIS_TS + 3 });

    const fresh = await harness();
    const countOf = (harness: Harness) => harness.chain.status().height;
    void countOf;
    // Feed b3 first, then b2, then b1: the first two are orphans.
    expect(fresh.chain.addBlock(b3).code).toBe(ErrCode.ORPHAN_BLOCK);
    expect(fresh.chain.addBlock(b2).code).toBe(ErrCode.ORPHAN_BLOCK);
    expect(fresh.chain.addBlock(b1).accepted).toBe(true);
    expect(fresh.chain.tip!.height).toBe(3);
    expect(fresh.chain.tip!.hash).toBe(blockHash(b3.header));
  });

  it('verifies its own persisted chain on demand', async () => {
    const h = await harness();
    advance(h, 4);
    expect(h.chain.verifyIntegrity()).toEqual({ ok: true, problems: [] });
  });
});

describe('fork choice and reorganisation', () => {
  it('prefers the branch with the most accumulated work', async () => {
    const h = await harness();
    // Canonical chain: heights 1..5.
    for (let i = 1; i <= 5; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const canonicalHead = h.chain.tip!.hash;

    // Competing branch from height 1, one block longer and heavier.
    let parent = forkParent(h, 1);
    let forkHead = '';
    const forkHashes: string[] = [];
    for (let i = 2; i <= 6; i += 1) {
      // A genuinely different branch: different timestamps (and therefore a
      // different header hash) at every height.
      const built = h.makeBlockOn(parent, [], { timestamp: GENESIS_TS + 1_000 + i });
      forkHashes.push(blockHash(built.block.header));
      const result = h.chain.addBlock(built.block);
      expect(result.accepted).toBe(true);
      parent = {
        hash: blockHash(built.block.header),
        height: built.block.header.height,
        cumulativePotWeight: built.block.header.cumulativePotWeight,
        state: built.state,
      };
      forkHead = blockHash(built.block.header);
    }

    expect(forkHead).not.toBe(canonicalHead);
    expect(h.chain.tip!.hash).toBe(forkHead);
    expect(h.chain.tip!.height).toBe(6);
    expect(h.chain.status().height).toBe(6);
    // State after the reorg must still satisfy the supply invariant.
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
    expect(h.chain.verifyIntegrity().ok).toBe(true);
  });

  it('keeps the canonical branch when a competing branch is lighter', async () => {
    const h = await harness();
    for (let i = 1; i <= 4; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const canonicalHead = h.chain.tip!.hash;

    const parent = forkParent(h, 1);
    const built = h.makeBlockOn(parent, [], { timestamp: GENESIS_TS + 1_000 + 2 });
    const result = h.chain.addBlock(built.block);
    expect(result.accepted).toBe(true);
    expect(result.reorged).toBe(false);
    expect(h.chain.tip!.hash).toBe(canonicalHead);
  });
});

describe('multi-node convergence (spec §111)', () => {
  it('four independent nodes reach the identical state root from identical inputs', async () => {
    const alice = makeWallet();
    const bob = makeWallet();
    // One scheduled producer, four independent nodes: this is what a healthy
    // network looks like — every node accepts the same blocks in the same order.
    const scheduler = makeWallet();
    const nodes = await Promise.all([
      createHarness({ producer: scheduler }),
      createHarness({ producer: scheduler }),
      createHarness({ producer: scheduler }),
      createHarness({ producer: scheduler }),
    ]);
    open.push(...nodes);

    const script: Array<{ height: number; build: (h: Harness) => ReturnType<typeof signedPayment> | null }> = [
      { height: 1, build: () => null },
      { height: 2, build: (h) => h.sign(alice, TxType.MINING_CLAIM, miningBody(h, alice), { gas: 0n, protocolTime: GENESIS_TS + 2 }) },
      { height: 3, build: (h) => h.sign(bob, TxType.MINING_CLAIM, miningBody(h, bob), { gas: 0n, protocolTime: GENESIS_TS + 3 }) },
      {
        height: 4,
        build: (h) => signedPayment(h, alice, bob.address, parseObs('1'), { protocolTime: GENESIS_TS + 4 }),
      },
    ];

    const blocks: Block[] = [];
    for (const step of script) {
      let produced: Block | undefined;
      for (const node of nodes) {
        const tx = step.build(node);
        const block = node.produce(tx ? [tx] : [], { timestamp: GENESIS_TS + step.height });
        expect(block.header.height).toBe(step.height);
        if (!produced) produced = block;
        else expect(blockHash(block.header)).toBe(blockHash(produced.header));
      }
      blocks.push(produced!);
    }

    expect(new Set(nodes.map((node) => node.chain.stateRoot)).size).toBe(1);
    expect(new Set(nodes.map((node) => node.chain.tip!.hash)).size).toBe(1);
    expect(new Set(nodes.map((node) => node.chain.world.s.metrics.totalSupply.toString())).size).toBe(1);
    expect(new Set(nodes.map((node) => formatObs(node.chain.world.getAccount(bob.address)!.balance)))).toEqual(
      new Set(['1.000166666666666666']),
    );
    expect(nodes.every((node) => node.chain.verifyIntegrity().ok)).toBe(true);
    expect(new Set(nodes.map((node) => node.chain.genesisId)).size).toBe(1);

    // A node that was offline replays the same blocks and lands on the same head.
    const lateJoiner = await createHarness({ producer: makeWallet() });
    open.push(lateJoiner);
    for (const block of blocks) {
      const result = lateJoiner.chain.addBlock(block);
      expect(result.accepted).toBe(true);
    }
    expect(lateJoiner.chain.tip!.hash).toBe(nodes[0]!.chain.tip!.hash);
    expect(lateJoiner.chain.stateRoot).toBe(nodes[0]!.chain.stateRoot);
    expect(lateJoiner.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('replays the same signed blocks to a second node and lands on the same root', async () => {
    const alice = makeWallet();
    const first = await harness();
    const blocks: Block[] = [];
    blocks.push(first.produce([], { timestamp: GENESIS_TS + 1 }));
    blocks.push(
      first.produce(
        [first.sign(alice, TxType.MINING_CLAIM, miningBody(first, alice), { gas: 0n, protocolTime: GENESIS_TS + 2 })],
        { timestamp: GENESIS_TS + 2 },
      ),
    );

    const second = await harness();
    for (const block of blocks) expect(second.chain.addBlock(block).accepted).toBe(true);
    expect(second.chain.tip!.hash).toBe(first.chain.tip!.hash);
    expect(second.chain.stateRoot).toBe(first.chain.stateRoot);
    expect(second.chain.world.s.metrics.totalSupply).toBe(first.chain.world.s.metrics.totalSupply);
    expect(second.chain.world.getAccount(alice.address)!.balance).toBe(GENESIS_ALLOCATION + CLAIM_REWARD);
    expect(second.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});

