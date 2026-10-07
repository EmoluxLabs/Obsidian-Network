/**
 * Adversarial tests for validator slashing.
 *
 * Everything here goes through the real pipeline: a real chain, real signed
 * transactions, the real state transition. No executor is called directly and no
 * state is poked by hand, because the property under test is "every honest node
 * reaches the same verdict from the canonical evidence alone".
 *
 *   1. the penalty itself — a consensus ratio applied to the validator's own bond
 *   2. the single registration bond — 19,999 / 20,000 / 20,001, and nowhere else
 *   3. proposer equivocation, end to end, submitted by an uninterested party
 *   4. finality-vote equivocation, end to end, plus the offline counter-case
 *   5. forged and altered evidence of every kind
 *   6. replay — twice, ten times, from other submitters, after a restart
 *   7. reorgs — a losing slash never touches canonical state; a winning one
 *      applies exactly once and reverts with the block that carried it
 *   8. the after-life of a slashed registration
 *   9. accounting — nothing created, nothing destroyed, nothing to the treasury
 *  10. fuzz and property checks
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { applyBlock } from '../../src/blockchain/state-machine.js';
import { blockHash, buildBlock, encodeSignedHeader } from '../../src/blockchain/block.js';
import { proposerRound, scheduledProposer } from '../../src/consensus/proposer.js';
import { finalityValidators, makeProposerEvidence, makeVoteEvidence, signFinalityVote, validatorSetHash } from '../../src/consensus/finality.js';
import { genesisIdForState, slashAmountFor } from '../../src/consensus/slash-evidence.js';
import { encodeSlashBody } from '../../src/transactions/executors/slash.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { Writer } from '../../src/protocol/encoding.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { toHex } from '../../src/crypto/hash.js';
import {
  SlashOp,
  TxType,
  ValidatorOp,
  type Block,
  type EquivocationEvidence,
  type FinalityVote,
  type ProposerEquivocationEvidence,
  type SlashBody,
  type TxEnvelope,
  type ValidatorState,
  type VoteEquivocationEvidence,
} from '../../src/protocol/types.js';
import {
  createHarness,
  forkParent,
  makeWallet,
  signedClaim,
  signedPayment,
  validatorBody,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';

const BOND = CONSENSUS_PARAMS.consensus.validatorBond;
const SLASH = parseObs('10000');
const open: Harness[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
});
afterEach(() => {
  while (open.length) open.pop()!.close();
  vi.useRealTimers();
});

const advance = (seconds = 1_000): void => {
  vi.advanceTimersByTime(seconds);
};

function validatorOf(h: Harness, address: string): ValidatorState | undefined {
  return h.chain.world.getAccount(address)?.validator;
}

/**
 * A chain with one bonded, active validator that also produces blocks, plus a
 * wallet that has never held a seal. The validator is the genesis recipient
 * (100,000 OBS from the first mining claim), the only way a wallet can afford a
 * 20,000 OBS bond on a fresh chain — exactly the documented launch sequence.
 */
async function slashHarness(): Promise<{
  h: Harness;
  validator: TestWallet;
  outsider: TestWallet;
  addValidator: () => Promise<TestWallet>;
}> {
  const validator = makeWallet();
  const h = await createHarness({ producer: validator, bootstrapValidatorPublicKeys: [validator.publicKey] });
  open.push(h);
  h.produce();
  h.produce([signedClaim(h, validator)]);
  h.produce([
    h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, validator.publicKey), {
      gas: expectedGas(BOND),
    }),
  ]);
  const outsider = makeWallet();
  const byAddress = new Map<string, TestWallet>([[validator.address, validator]]);

  /**
   * Produce with whichever wallet the rotation schedules — the tests must never
   * assume an ordering of randomly generated addresses, and a block from the
   * wrong validator is refused by consensus (which is the point of the rule).
   */
  const produceScheduled = (txs: TxEnvelope[] = []): void => {
    const scheduled = h.chain.scheduledProposerNow();
    // With no active validator the protocol is in genesis-open mode and any
    // producer is accepted, so falling back to the harvester is correct there.
    const producer = byAddress.get(scheduled ?? '') ?? validator;
    h.produce(txs, { producer });
  };

  const addValidator = async (): Promise<TestWallet> => {
    const added = makeWallet();
    produceScheduled([signedPayment(h, validator, added.address, BOND + expectedGas(BOND))]);
    byAddress.set(added.address, added);
    produceScheduled([
      h.sign(added, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, added.publicKey), {
        gas: expectedGas(BOND),
      }),
    ]);
    return added;
  };
  return { h, validator, outsider, addValidator };
}

const slashTx = (h: Harness, submitter: TestWallet, body: SlashBody): TxEnvelope =>
  h.sign(submitter, TxType.SLASH, encodeSlashBody(body), { gas: 0n });

/** Two same-round conflicting proposals by one validator, with both parents. */
function proposerEquivocation(h: Harness, validator: TestWallet): { evidence: ProposerEquivocationEvidence; body: SlashBody } {
  const parent = forkParent(h, h.chain.height);
  const parentBlock = h.chain.store.getBlockByHash(parent.hash);
  if (!parentBlock) throw new Error('fork parent is not stored');
  const parentTs = parentBlock.header.timestamp;
  const firstSlot = Math.max(1, Math.ceil((h.chain.protocolTime - parentTs) / CONSENSUS_PARAMS.block.targetBlockSeconds));
  for (let slot = firstSlot; slot <= firstSlot + 4; slot += 1) {
    for (let a = 1; a <= 4; a += 1) {
      for (let b = 1; b <= 4; b += 1) {
        if (a === b) continue;
        const ta = parentTs + CONSENSUS_PARAMS.block.targetBlockSeconds * slot + a;
        const tb = parentTs + CONSENSUS_PARAMS.block.targetBlockSeconds * slot + b;
        if (proposerRound(parentTs, ta) !== proposerRound(parentTs, tb)) continue;
        const first = h.makeBlockOn(parent, [], { timestamp: ta, producer: validator });
        const second = h.makeBlockOn(parent, [], { timestamp: tb, producer: validator });
        if (blockHash(first.block.header) === blockHash(second.block.header)) continue;
        const evidence = makeProposerEvidence({
          validator: validator.address,
          height: first.block.header.height,
          round: proposerRound(parentTs, ta),
          firstId: blockHash(first.block.header),
          secondId: blockHash(second.block.header),
          firstHeader: toHex(encodeSignedHeader(first.block.header)),
          secondHeader: toHex(encodeSignedHeader(second.block.header)),
        });
        return {
          evidence,
          body: {
            op: SlashOp.EQUIVOCATION,
            evidence,
            firstParentHeader: toHex(encodeSignedHeader(parentBlock.header)),
            secondParentHeader: toHex(encodeSignedHeader(parentBlock.header)),
          },
        };
      }
    }
  }
  throw new Error('could not build two same-round conflicting proposals');
}

/** Everything two finality votes need to be individually valid. */
function voteTemplate(h: Harness, wallet: TestWallet) {
  const anchorHash = h.chain.store.getCanonicalHashAtHeight(1);
  if (!anchorHash) throw new Error('no canonical anchor block');
  const genesisId = genesisIdForState(h.chain.world, h.net);
  if (!genesisId) throw new Error('this node cannot derive its own genesis identity');
  return {
    protocolVersion: PROTOCOL_VERSION,
    networkId: h.net.networkId,
    chainId: h.net.chainId,
    genesisId,
    paramsHash: PARAMS_HASH,
    type: 'POT_FINALITY' as const,
    finalizedHeight: 1,
    finalizedHash: anchorHash,
    height: 2,
    round: 0,
    parentHash: anchorHash,
    validatorSetHash: validatorSetHash([{ address: wallet.address, publicKey: wallet.publicKey }]),
    validator: wallet.address,
    publicKey: wallet.publicKey,
  };
}

/** Two conflicting finality votes for one anchor, signed by one validator. */
function voteEquivocation(h: Harness, validator: TestWallet): { evidence: VoteEquivocationEvidence; first: FinalityVote; second: FinalityVote } {
  const base = voteTemplate(h, validator);
  const first = signFinalityVote({ ...base, blockHash: '11'.repeat(32) }, validator.privateKey);
  const second = signFinalityVote({ ...base, blockHash: '22'.repeat(32) }, validator.privateKey);
  return { evidence: makeVoteEvidence(first, second), first, second };
}

/** Re-sign a vote with different fields — i.e. what a Byzantine signer did. */
function voteWith(wallet: TestWallet, vote: FinalityVote, patch: Partial<FinalityVote>): FinalityVote {
  const { signature: _signature, ...unsigned } = vote;
  return signFinalityVote({ ...unsigned, ...patch }, wallet.privateKey);
}

/** Raw slash body bytes, so the negative tests drive the real decoder. */
function rawSlash(op: number, evidenceJson: string, first = '', second = ''): Uint8Array {
  const w = new Writer();
  w.u8(op);
  w.string(evidenceJson);
  w.string(first);
  w.string(second);
  return w.finish();
}

describe('the equivocation penalty is a consensus ratio, not a number in the code', () => {
  it('takes exactly half the consensus bond, in integers, with nothing lost', () => {
    expect(CONSENSUS_PARAMS.consensus.equivocationSlashBps).toBe(5_000);
    expect(slashAmountFor(BOND)).toBe(SLASH);
    expect(BOND / 2n).toBe(SLASH);
    expect(formatObs(slashAmountFor(BOND))).toBe('10000.000000000000000000');
    for (const bond of [BOND, BOND + 1n, 20_001n, 3n, 1n]) {
      const amount = slashAmountFor(bond);
      expect(amount).toBe((bond * 5_000n) / 10_000n);
      expect(amount).toBeGreaterThanOrEqual(0n);
      expect(amount).toBeLessThanOrEqual(bond);
      expect(amount + (bond - amount)).toBe(bond);
      expect(typeof amount).toBe('bigint');
    }
    expect(slashAmountFor(0n)).toBe(0n);
  });
});

describe('the protocol has exactly one registration bond', () => {
  it('publishes no node-runner registration bond in consensus parameters', () => {
    expect(CONSENSUS_PARAMS.consensus.validatorBond).toBe(parseObs('20000'));
    const nodeRewards = CONSENSUS_PARAMS.nodeRewards as unknown as Record<string, unknown>;
    expect('registrationBond' in nodeRewards).toBe(false);
    expect(Object.keys(nodeRewards).filter((key) => /bond/i.test(key))).toEqual([]);
  });

  it('registers a node runner without moving funds and exposes no bond field on the record', async () => {
    const h = await createHarness();
    open.push(h);
    h.produce();
    h.produce([signedClaim(h, h.producer)]);
    const { makeNode, registerNode } = await import('../helpers/harness.js');
    const penniless = makeWallet();
    const node = makeNode(penniless);
    registerNode(h, node);
    const record = h.chain.world.node(node.nodeId)!;
    expect(record.rewardWallet).toBe(penniless.address);
    expect(Object.keys(record)).not.toContain('bond');
    expect(h.chain.world.getAccount(penniless.address)?.balance ?? 0n).toBe(0n);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('keeps the validator bond exact: 19,999 and 20,001 are refused, 20,000 is accepted', async () => {
    const h = await createHarness();
    open.push(h);
    h.produce();
    h.produce([signedClaim(h, h.producer)]);
    const wallet = h.producer;
    expect(h.chain.world.getAccount(wallet.address)!.balance).toBeGreaterThanOrEqual(BOND + expectedGas(BOND));
    for (const offered of [parseObs('19999'), parseObs('20001')]) {
      const outcome = h.tryBlock(
        [h.sign(wallet, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, offered, wallet.publicKey), { gas: expectedGas(offered) })],
        { simulate: false },
      );
      expect(outcome.accepted).toBe(false);
      expect(outcome.code).toBe(ErrCode.VALIDATOR_BOND_MISMATCH);
    }
    // Zero is refused as "no amount", not as a wrong bond: there is no such
    // thing as a validator seat bought for nothing.
    const zero = h.tryBlock(
      [h.sign(wallet, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, 0n, wallet.publicKey), { gas: 0n })],
      { simulate: false },
    );
    expect(zero.code).toBe(ErrCode.AMOUNT_ZERO);
    expect(validatorOf(h, wallet.address)).toBeUndefined();
    h.produce([
      h.sign(wallet, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, wallet.publicKey), { gas: expectedGas(BOND) }),
    ]);
    expect(validatorOf(h, wallet.address)!.bond).toBe(BOND);
    expect(validatorOf(h, wallet.address)!.status).toBe('ACTIVE');
  });
});

describe('proposer equivocation', () => {
  it('slashes exactly half the bond into the mining pool when a third party submits the proof', async () => {
    const { h, validator, outsider } = await slashHarness();
    expect(h.chain.world.getAccount(outsider.address)).toBeUndefined();
    const { evidence, body } = proposerEquivocation(h, validator);

    const supplyBefore = h.chain.world.s.metrics.totalSupply;
    const poolBefore = h.chain.world.s.pool.balance;
    const treasuryBefore = h.chain.world.s.metrics.totalTreasuryRevenue;
    const unclaimedBefore = h.chain.world.s.nodeRewards.unclaimedRevenue;
    const balanceBefore = h.chain.world.getAccount(validator.address)!.balance;

    h.produce([slashTx(h, outsider, body)]);

    expect(h.chain.world.s.slashes.get(evidence.id)).toMatchObject({
      evidenceId: evidence.id,
      type: 'PROPOSER_EQUIVOCATION',
      validator: validator.address,
      round: evidence.round,
      amount: SLASH,
      bondBefore: BOND,
      bondAfter: SLASH,
      slashedAtHeight: h.chain.height,
    });
    expect(validatorOf(h, validator.address)).toMatchObject({
      bond: SLASH,
      status: 'SLASHED',
      slashEvidenceId: evidence.id,
    });
    // The submitter paid nothing, gained nothing, and is now recorded as the
    // sender of an ordinary transaction — nothing more.
    expect(h.chain.world.getAccount(outsider.address)!.nonce).toBe(1);
    expect(h.chain.world.getAccount(outsider.address)!.balance).toBe(0n);

    // Accounting: the slashed half moved to the mining pool, the remaining half
    // is still bonded, the treasury did not move and the supply is unchanged.
    expect(h.chain.world.s.pool.balance - poolBefore).toBe(SLASH);
    expect(h.chain.world.s.pool.balance - poolBefore).toBe(BOND / 2n);
    expect(h.chain.world.s.metrics.totalTreasuryRevenue).toBe(treasuryBefore);
    expect(h.chain.world.s.nodeRewards.unclaimedRevenue).toBe(unclaimedBefore);
    expect(h.chain.world.s.metrics.totalSupply).toBe(supplyBefore);
    expect(h.chain.world.getAccount(validator.address)!.balance).toBe(balanceBefore);
    expect(h.chain.world.s.metrics.totalSlashedToPool).toBe(SLASH);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
    expect(h.chain.verifyIntegrity().ok).toBe(true);
  });

  it('leaves the rotation and the finality committee in the same block, with no restart', async () => {
    const { h, validator, outsider, addValidator } = await slashHarness();
    const second = await addValidator();
    const byAddress = new Map([[validator.address, validator], [second.address, second]]);
    const { body } = proposerEquivocation(h, validator);
    const activeBefore = h.chain.world.activeValidators();
    expect(activeBefore).toEqual([validator.address, second.address].sort());
    expect(finalityValidators(h.chain.world).map((entry) => entry.address)).toHaveLength(2);

    // Whichever of the two the rotation schedules must produce the slash block.
    const producer = byAddress.get(h.chain.scheduledProposerNow()!)!;
    h.produce([slashTx(h, outsider, body)], { producer, timestamp: h.chain.protocolTime });

    expect(h.chain.world.activeValidators()).toEqual([second.address]);
    expect(h.chain.scheduledProposerNow()).toBe(second.address);
    expect(finalityValidators(h.chain.world).map((entry) => entry.address)).toEqual([second.address]);
    // The chain keeps producing with the surviving validator, immediately: a
    // slashed registration is gone from the rotation, not merely flagged.
    advance(1_000);
    const next = h.produce([], { producer: second });
    expect(next.header.producer).toBe(second.address);
    expect(validatorOf(h, validator.address)!.status).toBe('SLASHED');
  });

  it('never slashes for going offline: missed slots are a jail, not a penalty', async () => {
    const { h, validator, addValidator } = await slashHarness();
    const second = await addValidator();
    const third = await addValidator();
    const byAddress = new Map([[validator.address, validator], [second.address, second], [third.address, third]]);
    const poolBefore = h.chain.world.s.pool.balance;

    // Produce the next block in an exact round, by the wallet the rotation
    // schedules for it. The timestamp is passed explicitly so the round the
    // chain derives is the round the test intends, and the clock is kept close
    // enough that the protocol's own drift rule accepts it.
    const produceInRound = (round: number): void => {
      const head = h.chain.tip!;
      const height = head.height + 1;
      const timestamp = head.timestamp + CONSENSUS_PARAMS.block.targetBlockSeconds * (round + 1) + 1;
      const scheduled = scheduledProposer(h.chain.world, height, round);
      expect(scheduled).not.toBeNull();
      const clock = Math.floor(Date.now() / 1000);
      if (timestamp + 2 > clock) advance((timestamp + 2 - clock) * 1_000);
      h.produce([], { producer: byAddress.get(scheduled!)!, timestamp });
    };

    // Every block whose round-0 holder is the target is produced a round late by
    // someone else, so the target is recorded as having missed its slot — the
    // exact behaviour a slashing-for-liveness rule would confiscate capital for.
    // The target never produces, so its counter cannot decay.
    const target = validator.address;
    for (let step = 0; step < 400; step += 1) {
      if (validatorOf(h, validator.address)!.status === 'JAILED') break;
      const roundZero = scheduledProposer(h.chain.world, h.chain.height + 1, 0);
      produceInRound(roundZero === target ? 1 : 0);
    }

    // Missing slots costs a validator its turns, for a fixed term, and nothing
    // else: the bond is untouched, no slash exists, and the pool only ever saw
    // registration gas.
    const blamed = validatorOf(h, validator.address)!;
    expect(blamed.status).toBe('JAILED');
    expect(blamed.bond).toBe(BOND);
    expect(blamed.jailedUntilHeight).toBeGreaterThan(h.chain.height);
    expect(h.chain.world.getAccount(validator.address)!.balance).toBeGreaterThan(0n);
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(0);
    expect(h.chain.world.s.metrics.totalSlashedToPool).toBe(0n);
    expect(h.chain.world.s.pool.balance).toBe(poolBefore);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);

    // And a jailed validator is not slashable at all: its registration is
    // already excluded from the committee, so equivocation evidence against it
    // is refused rather than converted into a second punishment.
    const { evidence } = voteEquivocation(h, validator);
    const outsider = makeWallet();
    const scheduled = h.chain.scheduledProposerNow()!;
    const outcome = h.tryBlock(
      [slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence })],
      { producer: byAddress.get(scheduled)!, simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
    expect(h.chain.world.s.slashes.size).toBe(0);
  });
});

describe('finality-vote equivocation', () => {
  it('slashes a validator that signs two conflicting votes for one anchor', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence } = voteEquivocation(h, validator);
    const supplyBefore = h.chain.world.s.metrics.totalSupply;
    const poolBefore = h.chain.world.s.pool.balance;

    h.produce([slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence })]);

    expect(h.chain.world.s.slashes.get(evidence.id)).toMatchObject({
      type: 'VOTE_EQUIVOCATION',
      validator: validator.address,
      amount: SLASH,
    });
    expect(validatorOf(h, validator.address)).toMatchObject({ bond: SLASH, status: 'SLASHED' });
    expect(h.chain.world.s.pool.balance - poolBefore).toBe(SLASH);
    expect(h.chain.world.s.metrics.totalSupply).toBe(supplyBefore);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a pair that is not a conflict: one block voted twice', async () => {
    const { h, validator, outsider } = await slashHarness();
    const base = voteTemplate(h, validator);
    const first = signFinalityVote({ ...base, height: 2, round: 0, blockHash: 'ab'.repeat(32) }, validator.privateKey);
    const again = signFinalityVote({ ...base, height: 3, round: 0, blockHash: 'ab'.repeat(32) }, validator.privateKey);
    const outcome = h.tryBlock(
      [slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence: makeVoteEvidence(first, again) })],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.REPLAY);
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(validatorOf(h, validator.address)!.bond).toBe(BOND);
  });

  it('refuses evidence about a validator that has left the committee', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence } = voteEquivocation(h, validator);
    h.produce([
      h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.UNREGISTER, 0n, validator.publicKey), { gas: 0n }),
    ]);
    expect(validatorOf(h, validator.address)!.status).toBe('UNBONDING');
    const outcome = h.tryBlock([slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence })], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
    expect(h.chain.world.s.slashes.size).toBe(0);
  });
});

describe('forged and altered evidence cannot slash anyone', () => {
  it('refuses proposals signed by a key that is not the validator’s', async () => {
    const { h, validator, outsider } = await slashHarness();
    const impostor = makeWallet();
    const parent = forkParent(h, h.chain.height);
    const parentBlock = h.chain.store.getBlockByHash(parent.hash)!;
    const ts = parentBlock.header.timestamp;
    const first = h.makeBlockOn(parent, [], { timestamp: ts + 5, producer: impostor });
    const second = h.makeBlockOn(parent, [], { timestamp: ts + 6, producer: impostor });
    const evidence = makeProposerEvidence({
      validator: validator.address,
      height: first.block.header.height,
      round: proposerRound(ts, ts + 5),
      firstId: blockHash(first.block.header),
      secondId: blockHash(second.block.header),
      firstHeader: toHex(encodeSignedHeader(first.block.header)),
      secondHeader: toHex(encodeSignedHeader(second.block.header)),
    });
    const outcome = h.tryBlock(
      [
        slashTx(h, outsider, {
          op: SlashOp.EQUIVOCATION,
          evidence,
          firstParentHeader: toHex(encodeSignedHeader(parentBlock.header)),
          secondParentHeader: toHex(encodeSignedHeader(parentBlock.header)),
        }),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(validatorOf(h, validator.address)!.bond).toBe(BOND);
  });

  it('refuses cross-network, cross-chain, cross-genesis and cross-rule evidence', async () => {
    const { h, validator, outsider } = await slashHarness();
    const honest = voteEquivocation(h, validator);
    const stranger = makeWallet();
    const cases: Array<[string, [FinalityVote, FinalityVote], ErrCode]> = [
      ['network', [voteWith(validator, honest.first, { networkId: 'obsidian-mainnet-1' }), honest.second], ErrCode.WRONG_NETWORK],
      ['chain', [voteWith(validator, honest.first, { chainId: h.net.chainId + 1 }), honest.second], ErrCode.WRONG_CHAIN_ID],
      ['genesis', [voteWith(validator, honest.first, { genesisId: 'ab'.repeat(20) }), honest.second], ErrCode.WRONG_CHAIN_ID],
      ['params', [voteWith(validator, honest.first, { paramsHash: 'cd'.repeat(16) }), honest.second], ErrCode.VERSION_MISMATCH],
      ['protocol', [voteWith(validator, honest.first, { protocolVersion: '1.5.0' }), honest.second], ErrCode.VERSION_MISMATCH],
      ['validator-set', [voteWith(validator, honest.first, { validatorSetHash: 'ef'.repeat(32) }), honest.second], ErrCode.MALFORMED],
      ['anchor-hash', [voteWith(validator, honest.first, { finalizedHash: 'aa'.repeat(32) }), honest.second], ErrCode.BAD_SIGNATURE],
      ['other-key', [voteWith(stranger, honest.first, { validator: stranger.address, publicKey: stranger.publicKey }), honest.second], ErrCode.NOT_FOUND],
      ['two-validators', [voteWith(validator, honest.first, { finalizedHash: 'bb'.repeat(32) }), voteWith(stranger, honest.second, { validator: stranger.address, publicKey: stranger.publicKey })], ErrCode.BAD_SIGNATURE],
    ];
    for (const [label, [first, second], code] of cases) {
      const outcome = h.tryBlock(
        [slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence: makeVoteEvidence(first, second) })],
        { simulate: false },
      );
      expect(outcome.accepted, `${label} evidence must be refused`).toBe(false);
      expect(outcome.code, `${label} evidence must be refused with ${code}`).toBe(code);
      expect(h.chain.world.s.slashes.size, `${label} must not slash`).toBe(0);
    }
    expect(validatorOf(h, validator.address)!.bond).toBe(BOND);
  });

  it('refuses evidence whose id, height, round or validator was rewritten', async () => {
    const { h, validator, outsider } = await slashHarness();
    const honest = voteEquivocation(h, validator);
    const cases: Array<[string, Record<string, unknown>, ErrCode]> = [
      ['id', { id: '00'.repeat(32) }, ErrCode.MALFORMED],
      ['height', { height: honest.evidence.height + 5 }, ErrCode.MALFORMED],
      ['round', { round: honest.evidence.round + 3 }, ErrCode.MALFORMED],
      ['messageType', { messageType: 'BLOCK_PROPOSAL' }, ErrCode.MALFORMED],
      ['version', { version: 7 }, ErrCode.MALFORMED],
      ['validator', { validator: makeWallet().address }, ErrCode.NOT_FOUND],
      ['firstId', { firstId: '00'.repeat(32) }, ErrCode.MALFORMED],
      ['secondId', { secondId: 'ff'.repeat(32) }, ErrCode.MALFORMED],
    ];
    for (const [label, patch, code] of cases) {
      const tampered = { ...honest.evidence, ...patch } as EquivocationEvidence;
      const outcome = h.tryBlock([slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence: tampered })], { simulate: false });
      expect(outcome.accepted, `rewriting ${label} must be refused`).toBe(false);
      expect(outcome.code, `rewriting ${label} must be refused with ${code}`).toBe(code);
    }
    expect(h.chain.world.s.slashes.size).toBe(0);
  });

  it('refuses a proposal header that was altered after signing, and a fabricated parent', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence, body } = proposerEquivocation(h, validator);

    // (a) one byte of the producer's SIGNATURE changes: the header still decodes
    //     and binds to its parent, so the signature is what refuses it
    const flipped = `${evidence.firstHeader.slice(0, -8)}${evidence.firstHeader.at(-8) === 'a' ? 'b' : 'a'}${evidence.firstHeader.slice(-7)}`;
    const altered = makeProposerEvidence({
      validator: evidence.validator,
      height: evidence.height,
      round: evidence.round,
      firstId: evidence.firstId,
      secondId: evidence.secondId,
      firstHeader: flipped,
      secondHeader: evidence.secondHeader,
    });
    const alteredOutcome = h.tryBlock([slashTx(h, outsider, { ...body, evidence: altered })], { simulate: false });
    expect(alteredOutcome.accepted).toBe(false);
    expect([ErrCode.BAD_SIGNATURE, ErrCode.MALFORMED]).toContain(alteredOutcome.code);

    // (b) an unrelated real header claimed as the second parent: the second
    //     child commits to its own parent's hash, so this cannot be satisfied
    const genesisHash = h.chain.store.getCanonicalHashAtHeight(0)!;
    const genesisHeader = h.chain.store.getBlockByHash(genesisHash)!.header;
    const wrongParent = h.tryBlock(
      [slashTx(h, outsider, { ...body, secondParentHeader: toHex(encodeSignedHeader(genesisHeader)) })],
      { simulate: false },
    );

    // (c) an invented parent whose header does not hash to the child's prevHash
    const tip = h.chain.store.getBlockByHash(h.chain.tip!.hash)!;
    const invented = { ...body, firstParentHeader: toHex(encodeSignedHeader({ ...tip.header, height: tip.header.height - 1 })) };
    const brokenBinding = h.tryBlock([slashTx(h, outsider, invented)], { simulate: false });

    // (d) a real pair of proposals claimed to be in a round they are not in
    const wrongRound = h.tryBlock(
      [slashTx(h, outsider, { ...body, evidence: { ...body.evidence, round: (body.evidence as ProposerEquivocationEvidence).round + 1 } })],
      { simulate: false },
    );

    for (const outcome of [wrongParent, brokenBinding, wrongRound]) {
      expect(outcome.accepted).toBe(false);
      expect([ErrCode.MALFORMED, ErrCode.BAD_SIGNATURE]).toContain(outcome.code);
    }
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(validatorOf(h, validator.address)!.bond).toBe(BOND);
  });

  it('refuses evidence for a height the chain has not reached, and for a stranger', async () => {
    const { h, validator, outsider } = await slashHarness();
    const base = voteTemplate(h, validator);
    const future = makeVoteEvidence(
      signFinalityVote({ ...base, height: 10_000, blockHash: '31'.repeat(32) }, validator.privateKey),
      signFinalityVote({ ...base, height: 10_000, blockHash: '32'.repeat(32) }, validator.privateKey),
    );
    const futureOutcome = h.tryBlock([slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence: future })], { simulate: false });
    expect(futureOutcome.accepted).toBe(false);
    expect(futureOutcome.code).toBe(ErrCode.NOT_YET_VALID);

    const stranger = makeWallet();
    const strangerBase = voteTemplate(h, stranger);
    const strangerPair = makeVoteEvidence(
      signFinalityVote({ ...strangerBase, height: 2, blockHash: '41'.repeat(32) }, stranger.privateKey),
      signFinalityVote({ ...strangerBase, height: 2, blockHash: '42'.repeat(32) }, stranger.privateKey),
    );
    const strangerOutcome = h.tryBlock([slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence: strangerPair })], { simulate: false });
    expect(strangerOutcome.accepted).toBe(false);
    expect(strangerOutcome.code).toBe(ErrCode.NOT_FOUND);
    expect(h.chain.world.s.slashes.size).toBe(0);
  });

  it('refuses malformed bodies, unknown operations, out-of-band gas and unsigned senders', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence, body } = proposerEquivocation(h, validator);
    const evidenceJson = JSON.stringify(evidence);
    const oversized = `${JSON.stringify({ ...evidence, firstHeader: 'ab'.repeat(20_000) })}`;

    const bodies: Array<[string, Uint8Array, ErrCode]> = [
      ['unknown-op', rawSlash(9, evidenceJson, body.firstParentHeader, body.secondParentHeader), ErrCode.UNKNOWN_TX_TYPE],
      ['truncated', encodeSlashBody(body).slice(0, encodeSlashBody(body).length - 1), ErrCode.MALFORMED],
      ['bad-json', rawSlash(SlashOp.EQUIVOCATION, '{', body.firstParentHeader, body.secondParentHeader), ErrCode.MALFORMED],
      ['null-evidence', rawSlash(SlashOp.EQUIVOCATION, 'null', body.firstParentHeader, body.secondParentHeader), ErrCode.MALFORMED],
      ['array-evidence', rawSlash(SlashOp.EQUIVOCATION, '[]', body.firstParentHeader, body.secondParentHeader), ErrCode.MALFORMED],
      ['wrong-version', rawSlash(SlashOp.EQUIVOCATION, JSON.stringify({ ...evidence, version: 7 }), body.firstParentHeader, body.secondParentHeader), ErrCode.MALFORMED],
      ['missing-parents', encodeSlashBody({ op: SlashOp.EQUIVOCATION, evidence }), ErrCode.MALFORMED],
      ['oversized-evidence', rawSlash(SlashOp.EQUIVOCATION, oversized, body.firstParentHeader, body.secondParentHeader), ErrCode.MALFORMED],
    ];
    for (const [label, raw, code] of bodies) {
      const outcome = h.tryBlock([h.sign(outsider, TxType.SLASH, raw, { gas: 0n })], { simulate: false });
      expect(outcome.accepted, `${label} must be refused`).toBe(false);
      expect(outcome.code, `${label} must be refused with ${code}`).toBe(code);
    }

    // Reporting a crime is free by rule: paying gas for it is refused outright,
    // so nobody can be priced out of reporting one.
    const paid = h.tryBlock([h.sign(outsider, TxType.SLASH, encodeSlashBody(body), { gas: CONSENSUS_PARAMS.gas.maxGas })], { simulate: false });
    expect(paid.accepted).toBe(false);
    expect(paid.code).toBe(ErrCode.BAD_GAS);

    // A transaction whose envelope names someone else is not signed by them.
    const forged: TxEnvelope = {
      ...slashTx(h, outsider, body),
      sender: validator.address,
      nonce: h.chain.world.getAccount(validator.address)!.nonce,
    };
    const forgedOutcome = h.tryBlock([forged], { simulate: false });
    expect(forgedOutcome.accepted).toBe(false);
    expect(forgedOutcome.code).toBe(ErrCode.BAD_SIGNATURE);
    expect(h.chain.world.s.slashes.size).toBe(0);
  });
});

describe('slashing is idempotent', () => {
  it('slashes once for twelve submissions of the same evidence from ten submitters', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence, body } = proposerEquivocation(h, validator);
    const submitters = [outsider, ...Array.from({ length: 9 }, () => makeWallet())];

    h.produce([slashTx(h, outsider, body)]);
    const poolAfterFirst = h.chain.world.s.pool.balance;
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);

    for (let index = 0; index < 11; index += 1) {
      const submitter = submitters[index % submitters.length]!;
      const outcome = h.tryBlock([slashTx(h, submitter, body)], { simulate: false });
      expect(outcome.accepted).toBe(false);
      expect(outcome.code).toBe(ErrCode.REPLAY);
    }
    expect(h.chain.world.s.slashes.size).toBe(1);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);
    expect(h.chain.world.s.pool.balance).toBe(poolAfterFirst);
    expect(h.chain.world.s.slashes.get(evidence.id)!.amount).toBe(SLASH);
  });

  it('refuses a second, genuinely different equivocation by a closed registration', async () => {
    const { h, validator, outsider } = await slashHarness();
    const first = proposerEquivocation(h, validator);
    h.produce([slashTx(h, outsider, first.body)]);
    advance(5_000);
    const second = proposerEquivocation(h, validator);
    expect(second.evidence.id).not.toBe(first.evidence.id);

    const outcome = h.tryBlock([slashTx(h, outsider, second.body)], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.REPLAY, ErrCode.VALIDATOR_BOND_MISMATCH]).toContain(outcome.code);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);
    expect(validatorOf(h, validator.address)!.slashEvidenceId).toBe(first.evidence.id);
  });

  it('remembers the slash across a restart and still refuses the replay', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence, body } = proposerEquivocation(h, validator);
    h.produce([slashTx(h, outsider, body)]);
    const poolAfter = h.chain.world.s.pool.balance;
    const supplyAfter = h.chain.world.s.metrics.totalSupply;

    const restored = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: h.chain.genesisDocument,
      enforceProposerRotation: true,
    });
    await restored.init();
    expect(restored.verifyIntegrity().ok).toBe(true);
    expect(restored.world.s.slashes.get(evidence.id)).toMatchObject({
      validator: validator.address,
      amount: SLASH,
      bondBefore: BOND,
      bondAfter: SLASH,
    });
    expect(restored.world.getAccount(validator.address)!.validator).toMatchObject({
      bond: SLASH,
      status: 'SLASHED',
      slashEvidenceId: evidence.id,
    });
    expect(restored.world.s.pool.balance).toBe(poolAfter);
    expect(restored.world.s.metrics.totalSupply).toBe(supplyAfter);
    expect(restored.world.s.metrics.totalSlashes).toBe(1);
    expect(restored.world.verifySupplyInvariant().ok).toBe(true);
    // Still out of the committee, with no restart required and none available.
    expect(restored.world.activeValidators()).toEqual([]);

    // Another peer replays the evidence against the restarted node.
    const replaySubmitter = makeWallet();
    const replayTx = slashTx(h, replaySubmitter, body);
    const replayed = restored.addBlock(blockOn(h.net.chainId, restored, replaySubmitter, [replayTx]));
    expect(replayed.accepted).toBe(false);
    expect(replayed.code).toBe(ErrCode.REPLAY);
    expect(restored.world.s.metrics.totalSlashes).toBe(1);
    expect(restored.world.s.pool.balance).toBe(poolAfter);
    expect(restored.world.verifySupplyInvariant().ok).toBe(true);
  });
});

describe('slashes reorg with the blocks that carry them', () => {
  it('keeps a losing slash entirely out of canonical state', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence, body } = proposerEquivocation(h, validator);
    const parent = forkParent(h, h.chain.height);
    const parentBlock = h.chain.store.getBlockByHash(parent.hash)!;
    const poolBefore = h.chain.world.s.pool.balance;
    const ts = Math.max(parentBlock.header.timestamp + 1, h.chain.protocolTime);

    const withSlash = h.makeBlockOn(parent, [slashTx(h, outsider, body)], { timestamp: ts });
    const withoutSlash = h.makeBlockOn(parent, [], { timestamp: ts + 1 });
    const heavier = blockHash(withSlash.block.header) > blockHash(withoutSlash.block.header) ? withoutSlash : withSlash;
    const lighter = heavier === withoutSlash ? withSlash : withoutSlash;
    expect(h.chain.addBlock(heavier.block).accepted).toBe(true);
    expect(h.chain.addBlock(lighter.block).accepted).toBe(true);
    expect(h.chain.tip!.hash).toBe(blockHash(heavier.block.header));

    // Canonical state holds exactly what its own branch contains: a slash if the
    // winning block carried one, and nothing at all if it did not.
    const state = h.chain.world;
    const applied = state.s.slashes.get(evidence.id);
    if (applied) {
      expect(validatorOf(h, validator.address)!.status).toBe('SLASHED');
      expect(state.s.pool.balance - poolBefore).toBe(SLASH);
    } else {
      expect(validatorOf(h, validator.address)!.status).toBe('ACTIVE');
      expect(state.s.pool.balance - poolBefore).toBe(0n);
    }
    expect(state.verifySupplyInvariant().ok).toBe(true);
    expect(h.chain.verifyIntegrity().ok).toBe(true);
  });

  it('applies a reorged-in slash exactly once, and reverts it when the branch loses', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { evidence, body } = proposerEquivocation(h, validator);
    const parent = forkParent(h, h.chain.height);
    const poolBefore = h.chain.world.s.pool.balance;

    // Branch A carries the slash and becomes canonical first.
    const branchA = h.makeBlockOn(parent, [slashTx(h, outsider, body)], { timestamp: Math.max(parent.state.s.timestamp + 1, h.chain.protocolTime) });
    expect(h.chain.addBlock(branchA.block).accepted).toBe(true);
    expect(h.chain.world.s.slashes.size).toBe(1);

    // Branch B has no slash and is longer, so it wins and the slash reverts.
    let cursor = parent;
    let timestamp = parent.state.s.timestamp;
    for (let index = 0; index < 3; index += 1) {
      timestamp += 5;
      const extension = h.makeBlockOn(cursor, [], { timestamp });
      expect(h.chain.addBlock(extension.block).accepted).toBe(true);
      cursor = {
        hash: blockHash(extension.block.header),
        height: extension.block.header.height,
        cumulativePotWeight: extension.block.header.cumulativePotWeight,
        state: extension.state,
      };
    }
    expect(h.chain.tip!.height).toBeGreaterThan(branchA.block.header.height);
    expect(h.chain.world.s.slashes.has(evidence.id)).toBe(false);
    expect(validatorOf(h, validator.address)!.status).toBe('ACTIVE');
    expect(h.chain.world.s.pool.balance).toBe(poolBefore);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);

    // On this branch the same evidence is valid again — and applies once.
    const reapply = h.tryBlock([slashTx(h, outsider, body)]);
    expect(reapply.accepted).toBe(true);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);
    expect(h.chain.world.s.pool.balance - poolBefore).toBe(SLASH);
    expect(h.chain.world.s.slashes.size).toBe(1);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
    expect(h.chain.verifyIntegrity().ok).toBe(true);
  });
});

describe('the after-life of a slashed registration', () => {
  it('cannot re-register cheaply, cannot claim early, and gets the remainder back in full', async () => {
    const { h, validator, outsider } = await slashHarness();
    const { body } = proposerEquivocation(h, validator);
    h.produce([slashTx(h, outsider, body)]);

    // The surviving half must never discount a new 20,000 OBS seat.
    const reregister = h.tryBlock(
      [h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, validator.publicKey), { gas: expectedGas(BOND) })],
      { simulate: false },
    );
    expect(reregister.accepted).toBe(false);
    expect(reregister.code).toBe(ErrCode.REPLAY);

    const early = h.tryBlock(
      [h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.CLAIM_UNBONDED, 0n, validator.publicKey), { gas: 0n })],
      { simulate: false },
    );
    expect(early.accepted).toBe(false);

    // Unbonding is height-gated (20,160 blocks), so the claim is driven through
    // the real state transition at the height it becomes legal — the same
    // function a node runs when that block arrives, fed the height that block
    // will have. Nothing about the claim rule is mocked.
    const balanceBefore = h.chain.world.getAccount(validator.address)!.balance;
    const supplyBefore = h.chain.world.s.metrics.totalSupply;
    const poolBefore = h.chain.world.s.pool.balance;
    const liveNonce = h.chain.world.getAccount(validator.address)!.nonce;
    const claimHeight = h.chain.height + CONSENSUS_PARAMS.consensus.unbondingBlocks;
    const claimTx = h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.CLAIM_UNBONDED, 0n, validator.publicKey), { gas: 0n });
    const claimed = applyBlock(h.chain.world, atHeight(h, claimHeight, [claimTx]), { net: h.net, skipRootCheck: true });

    expect(claimed.state.getAccount(validator.address)!.balance - balanceBefore).toBe(SLASH);
    expect(claimed.state.getAccount(validator.address)!.validator).toBeUndefined();
    expect(claimed.state.s.metrics.totalSupply).toBe(supplyBefore);
    expect(claimed.state.s.pool.balance).toBe(poolBefore);
    expect(claimed.events.some((event) => event.type === 'VALIDATOR_UNBONDED' && event.data?.afterSlash === true)).toBe(true);
    expect(claimed.state.verifySupplyInvariant().ok).toBe(true);

    // The wallet registers again, at the full bond, in the next block — and the
    // slashed half stays where consensus put it. Only the new registration's gas
    // reaches the pool.
    const registerTx = h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, validator.publicKey), {
      gas: expectedGas(BOND),
      nonce: liveNonce + 1,
    });
    const reregistered = applyBlock(claimed.state, atHeight(h, claimHeight + 1, [registerTx]), { net: h.net, skipRootCheck: true });
    expect(reregistered.state.getAccount(validator.address)!.validator).toMatchObject({ bond: BOND, status: 'ACTIVE' });
    expect(reregistered.state.s.pool.balance - poolBefore).toBe(expectedGas(BOND));
    expect(reregistered.state.s.metrics.totalSupply).toBe(supplyBefore);
    expect(reregistered.state.verifySupplyInvariant().ok).toBe(true);
  });
});

describe('fuzz and property checks', () => {
  it('derives exactly half for a thousand random bonds, never a rounded or invented amount', () => {
    let seed = 12_345;
    const next = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_647;
      return seed;
    };
    for (let index = 0; index < 1_000; index += 1) {
      const bond = BigInt(next()) + 1n;
      const amount = slashAmountFor(bond);
      expect(amount).toBe((bond * BigInt(CONSENSUS_PARAMS.consensus.equivocationSlashBps)) / 10_000n);
      expect(amount).toBeLessThanOrEqual(bond);
      expect(bond - amount).toBeGreaterThanOrEqual(0n);
      expect(amount + (bond - amount)).toBe(bond);
    }
  });

  it('refuses a mutated vote evidence blob for every field and every junk value', async () => {
    const { h, validator, outsider } = await slashHarness();
    const honest = voteEquivocation(h, validator);
    const fields: Array<keyof VoteEquivocationEvidence> = ['id', 'height', 'round', 'validator', 'firstId', 'secondId', 'messageType', 'version'];
    for (const field of fields) {
      for (const value of [0, 1, '0'.repeat(64), 'zz', null] as unknown[]) {
        // A "mutation" that writes back the current value proves nothing.
        if (JSON.stringify(value) === JSON.stringify(honest.evidence[field])) continue;
        const tampered = { ...honest.evidence, [field]: value } as EquivocationEvidence;
        const outcome = h.tryBlock([slashTx(h, outsider, { op: SlashOp.EQUIVOCATION, evidence: tampered })], { simulate: false });
        expect(outcome.accepted, `mutating ${String(field)} to ${String(value)} must be refused`).toBe(false);
      }
    }
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(validatorOf(h, validator.address)!.bond).toBe(BOND);
  });
});

describe('the double-sign lock: an honest proposer signs once per slot', () => {
  /**
   * The stored safety lock, read from the file a node would read after a crash.
   * The lock is what makes a retry — or a restart — unable to produce the second
   * header of an equivocation pair, so it is asserted where it lives, not just
   * through behaviour.
   */
  const storedLock = (h: Harness): { height: number; round: number } | null => {
    const state = JSON.parse(readFileSync(join(h.dir, 'finality', 'state.json'), 'utf8')) as {
      state: { lastProposal: { height: number; round: number } | null };
    };
    return state.state.lastProposal;
  };

  it('refuses a second signature for a slot it has already signed, and records the slot', async () => {
    const h = await createHarness();
    open.push(h);
    const height = h.chain.height + 1;
    const round = proposerRound(h.chain.tip!.timestamp, h.chain.protocolTime);

    // The first proposal is signed and then never connected, which is exactly
    // the situation a retry loop creates: a locally rejected block must not be
    // followed by a second, different signature for the same slot.
    const first = h.chain.buildNextBlock(h.producer);
    expect(first).not.toBeNull();
    expect(storedLock(h)).toEqual({ height, round });

    const again = h.chain.buildNextBlock(h.producer);
    expect(again).toBeNull();
    expect(storedLock(h)).toEqual({ height, round });
  });

  it('locks nothing for a node that is not the scheduled proposer', async () => {
    const { h, validator, addValidator } = await slashHarness();
    const second = await addValidator();
    const byAddress = new Map([[validator.address, validator], [second.address, second]]);
    const height = h.chain.height + 1;
    const round = proposerRound(h.chain.tip!.timestamp, h.chain.protocolTime);
    const scheduled = scheduledProposer(h.chain.world, height, round);
    expect(scheduled).not.toBeNull();
    // Whichever of the two the rotation did *not* schedule at this slot.
    const waiting = byAddress.get(scheduled === validator.address ? second.address : validator.address)!;

    expect(h.chain.buildNextBlock(waiting)).toBeNull();
    // A node that produces nothing must not burn its own turn: the lock is armed
    // only by an actual signature.
    expect(storedLock(h)).toBeNull();
  });

  it('still allows a later round of the same height, and the next height', async () => {
    const h = await createHarness();
    open.push(h);
    const height = h.chain.height + 1;
    const first = h.chain.buildNextBlock(h.producer);
    expect(first).not.toBeNull();
    expect(h.chain.buildNextBlock(h.producer)).toBeNull();

    // Past the slot: a new round of the same height is a different turn, so the
    // liveness backstop (produce late rather than stall) keeps working.
    advance((CONSENSUS_PARAMS.block.targetBlockSeconds * 2 + 1) * 1_000);
    const later = h.chain.buildNextBlock(h.producer);
    expect(later).not.toBeNull();
    expect(later!.header.height).toBe(height);
    expect(blockHash(later!.header)).not.toBe(blockHash(first!.header));
    expect(proposerRound(h.chain.tip!.timestamp, later!.header.timestamp)).toBeGreaterThan(
      proposerRound(h.chain.tip!.timestamp, first!.header.timestamp),
    );
    expect(h.chain.addBlock(later!).accepted).toBe(true);

    // A new height is a new slot, with no restart and no manual reset.
    advance(1_000);
    const next = h.chain.buildNextBlock(h.producer);
    expect(next).not.toBeNull();
    expect(next!.header.height).toBe(height + 1);
    expect(h.chain.addBlock(next!).accepted).toBe(true);
  });

  it('survives a restart: the lock is on disk before the signature exists', async () => {
    const h = await createHarness();
    open.push(h);
    const height = h.chain.height + 1;
    const round = proposerRound(h.chain.tip!.timestamp, h.chain.protocolTime);
    const signed = h.chain.buildNextBlock(h.producer);
    expect(signed).not.toBeNull();

    const restored = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: h.chain.genesisDocument,
      enforceProposerRotation: true,
    });
    await restored.init();
    expect(restored.buildNextBlock(h.producer)).toBeNull();
    expect(storedLock(h)).toEqual({ height, round });

    // And the slot after that is still available to the restarted node.
    advance((CONSENSUS_PARAMS.block.targetBlockSeconds * 2 + 1) * 1_000);
    expect(restored.buildNextBlock(h.producer)).not.toBeNull();
  });
});

// ── helpers for chains and heights the harness does not construct ────────────

/**
 * A block that will sit at `height` on an arbitrary chain, with the transaction
 * roots left zero: every caller either rejects the transaction before the roots
 * are compared, or applies with `skipRootCheck`.
 */
function atHeight(h: Harness, height: number, transactions: TxEnvelope[], producer: TestWallet = h.producer): Block {
  const head = h.chain.tip!;
  return buildBlock({
    protocolVersion: PROTOCOL_VERSION,
    chainId: h.net.chainId,
    height,
    prevHash: head.hash,
    stateRoot: '0'.repeat(64),
    eventsRoot: '0'.repeat(64),
    timestamp: Math.max(h.chain.protocolTime, head.timestamp + 1),
    producer: producer.address,
    producerPrivateKey: producer.privateKey,
    producerPublicKey: producer.publicKey,
    parentCumulativePotWeight: BigInt(head.cumulativePotWeight),
    transactions,
  });
}

/** The same, for a chain that was opened directly rather than by the harness. */
function blockOn(chainId: number, chain: ChainManager, producer: TestWallet, transactions: TxEnvelope[]): Block {
  const head = chain.tip!;
  return buildBlock({
    protocolVersion: PROTOCOL_VERSION,
    chainId,
    height: head.height + 1,
    prevHash: head.hash,
    stateRoot: '0'.repeat(64),
    eventsRoot: '0'.repeat(64),
    timestamp: Math.max(chain.protocolTime, head.timestamp + 1),
    producer: producer.address,
    producerPrivateKey: producer.privateKey,
    producerPublicKey: producer.publicKey,
    parentCumulativePotWeight: BigInt(head.cumulativePotWeight),
    transactions,
  });
}
