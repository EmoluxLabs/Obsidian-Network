/**
 * H-01 — "no validators are registered" and "every validator left" are different
 * states, and the chain can now tell them apart.
 *
 * Before 1.6.1 the proposer schedule answered `null` for an empty active set, and
 * every caller read `null` as "genesis-open mode: anyone may produce". That is
 * the correct answer exactly once — before the first validator exists, or the
 * first validator can never arrive. After it, the same `null` meant the chain had
 * no validators, and the response was to let any key that could sign a block take
 * over the network. One unbonding transaction, one jail, or one slash was enough
 * to hand a live chain to an unauthenticated producer.
 *
 * The fix is an explicit, committed indicator, not an inference from a count. A
 * count is exactly what a jail, an unbonding or a slash can empty, and it cannot
 * say whether the set was ever non-empty. So:
 *
 *   - `validatorModeEstablished` is consensus state, committed in the state root
 *     AHEAD of the validator list it qualifies, restored from the snapshot, and
 *     set only by the state transition of the first successful registration;
 *   - while it is false the chain is in bootstrap mode and any node may propose;
 *   - once it is true the rotation is closed for ever, and an empty active set
 *     HALTS: every producer is refused, in every round, including the validator
 *     that just left;
 *   - the chain restarts by consensus — a jail term lapsing in time, or a fresh
 *     20,000 OBS registration — never by an operator and never by falling
 *     through to open production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChainManager } from '../../src/blockchain/chain.js';
import { computeStateRoot } from '../../src/blockchain/state-root.js';
import { jailIsOver } from '../../src/blockchain/state.js';
import {
  chainIsHaltedForWantOfValidators,
  proposerDecision,
  scheduledProposer,
  validatorRotationIsOpen,
} from '../../src/consensus/proposer.js';
import { CONSENSUS_PARAMS, VALIDATOR_JAIL_SECONDS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { TxType, ValidatorOp, type TxEnvelope, type ValidatorState } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import {
  createHarness,
  makeWallet,
  signedClaim,
  signedPayment,
  validatorBody,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';

const BOND = CONSENSUS_PARAMS.consensus.validatorBond;
const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const open: Harness[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
});
afterEach(() => {
  while (open.length) open.pop()!.close();
  vi.useRealTimers();
});

const advanceClock = (milliseconds: number): void => {
  vi.advanceTimersByTime(milliseconds);
};

/** Produce a block that keeps the node's clock inside the protocol's drift rule. */
function produceAt(h: Harness, producer: TestWallet, timestamp: number) {
  const clockSeconds = Math.floor(Date.now() / 1000);
  if (timestamp + 2 > clockSeconds) advanceClock((timestamp + 2 - clockSeconds) * 1_000);
  void 0;
  return h.produce([], { producer, timestamp });
}

function validatorOf(h: Harness, address: string): ValidatorState | undefined {
  return h.chain.world.getAccount(address)?.validator;
}

async function fundedHarness(): Promise<{ h: Harness; validator: TestWallet; byAddress: Map<string, TestWallet> }> {
  const validator = makeWallet();
  const h = await createHarness({ producer: validator, bootstrapValidatorPublicKeys: [validator.publicKey] });
  open.push(h);
  h.produce();
  h.produce([signedClaim(h, validator)]);
  const byAddress = new Map<string, TestWallet>([[validator.address, validator]]);
  return { h, validator, byAddress };
}

/**
 * Produce with whichever wallet the rotation schedules.
 *
 * The harness defaults to the wallet it was created with, which stops being the
 * scheduled proposer as soon as a second validator registers — and a block from
 * the wrong validator is refused by consensus, which is the rule under test and
 * not something these fixtures may trip over by accident.
 */
function produceScheduled(h: Harness, byAddress: Map<string, TestWallet>, txs: TxEnvelope[] = []): void {
  const scheduled = h.chain.scheduledProposerNow();
  // In bootstrap mode the schedule names nobody and any node may propose, so the
  // harness's own wallet is the right producer. Once the rotation is closed
  // there is no fallback: a mismatch is a bug in the fixture, not something to
  // paper over.
  const producer =
    byAddress.get(scheduled ?? '') ?? (validatorRotationIsOpen(h.chain.world) ? h.producer : undefined);
  if (!producer) throw new Error(`no test wallet for the scheduled proposer ${scheduled}`);
  h.produce(txs, { producer });
}

function register(h: Harness, wallet: TestWallet, byAddress: Map<string, TestWallet>): void {
  produceScheduled(h, byAddress, [
    h.sign(wallet, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, wallet.publicKey), {
      gas: expectedGas(BOND),
    }),
  ]);
}

describe('H-01 the mode is an explicit, committed indicator', () => {
  it('starts open (state A), closes for ever on the first registration (state B), and is state-root committed', async () => {
    const { h, validator, byAddress } = await fundedHarness();
    // STATE A — genesis, pre-validator. No registration has ever been accepted,
    // so any node may propose. This is not an inference from an empty set: it is
    // a committed flag that has never been set.
    expect(h.chain.world.s.validatorModeEstablished).toBe(false);
    expect(validatorRotationIsOpen(h.chain.world)).toBe(true);
    expect(chainIsHaltedForWantOfValidators(h.chain.world)).toBe(false);
    expect(proposerDecision(h.chain.world, h.chain.height + 1, 0)).toEqual({ kind: 'OPEN' });
    const stranger = makeWallet();
    expect(h.produce([], { producer: stranger }).header.producer).toBe(stranger.address);

    // The state root distinguishes the two empty sets: an identical validator
    // list, a different root, because the mode is committed ahead of it.
    const rootBefore = computeStateRoot(h.chain.world.s);

    register(h, validator, byAddress);
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    expect(validatorRotationIsOpen(h.chain.world)).toBe(false);
    expect(computeStateRoot(h.chain.world.s)).not.toBe(rootBefore);

    // STATE B — established. Production belongs to the active set from here on,
    // and the indicator is not something a later state can unset.
    expect(scheduledProposer(h.chain.world, h.chain.height + 1, 0)).toBe(validator.address);
    expect(h.chain.world.activeValidators()).toEqual([validator.address]);

    // A second registration does not touch it, and neither does a restart.
    const second = makeWallet();
    produceScheduled(h, byAddress, [signedPayment(h, validator, second.address, BOND + expectedGas(BOND))]);
    byAddress.set(second.address, second);
    register(h, second, byAddress);
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    expect(h.chain.world.activeValidators()).toEqual([validator.address, second.address].sort());
  });

  it('persists the mode, so a restart cannot change it', async () => {
    const { h, validator, byAddress } = await fundedHarness();
    register(h, validator, byAddress);
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    const rootBefore = computeStateRoot(h.chain.world.s);

    const restored = new ChainManager({
      dataDir: h.dir,
      net: h.net,
      genesisDocument: h.chain.genesisDocument,
      enforceProposerRotation: true,
    });
    await restored.init();
    expect(restored.verifyIntegrity().ok).toBe(true);
    // Restored, not defaulted: a node that came back up believing the chain was
    // still in bootstrap mode would accept a block from any key.
    expect(restored.world.s.validatorModeEstablished).toBe(true);
    expect(computeStateRoot(restored.world.s)).toBe(rootBefore);
    expect(validatorRotationIsOpen(restored.world)).toBe(false);
  });

  it('refuses every block once the last validator leaves: the ex-validator, a stranger, every round', async () => {
    const { h, validator, byAddress } = await fundedHarness();
    register(h, validator, byAddress);
    produceScheduled(h, byAddress, [
      h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.UNREGISTER, 0n, validator.publicKey), { gas: 0n }),
    ]);
    expect(validatorOf(h, validator.address)!.status).toBe('UNBONDING');

    // Zero active validators on an established chain: the halt. The indicator is
    // still set, so this is not bootstrap mode and the schedule names nobody.
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    expect(h.chain.world.activeValidators()).toEqual([]);
    expect(validatorRotationIsOpen(h.chain.world)).toBe(false);
    expect(chainIsHaltedForWantOfValidators(h.chain.world)).toBe(true);
    expect(proposerDecision(h.chain.world, h.chain.height + 1, 0).kind).toBe('HALTED');

    const stranger = makeWallet();
    const heightBefore = h.chain.height;
    for (const producer of [validator, stranger]) {
      for (const round of [0, 1, 5, 50]) {
        const timestamp = h.chain.tip!.timestamp + SLOT * (round + 1) + 1;
        // The clock has to reach the timestamp, or the trial is refused by the
        // timestamp rule before the schedule is ever consulted — which would
        // test the wrong thing.
        advanceClock(Math.max(0, (timestamp + 2 - Math.floor(Date.now() / 1000)) * 1_000));
        const outcome = h.tryBlock([], { producer, timestamp });
        expect(outcome.accepted, `${producer.address} in round ${round}`).toBe(false);
        expect(outcome.code).toBe(ErrCode.NOT_PRODUCER_TURN);
        expect(outcome.message).toMatch(/halted for want of validators/);
      }
    }
    expect(h.chain.height).toBe(heightBefore);
  });

  it('keeps producing while any validator is left, and the mode never reopens', async () => {
    const { h, validator, byAddress } = await fundedHarness();
    register(h, validator, byAddress);
    const second = makeWallet();
    produceScheduled(h, byAddress, [signedPayment(h, validator, second.address, BOND + expectedGas(BOND))]);
    byAddress.set(second.address, second);
    register(h, second, byAddress);

    // One of the two leaves: the rotation still has a member, so the chain runs.
    const scheduled = byAddress.get(h.chain.scheduledProposerNow()!)!;
    h.produce(
      [h.sign(scheduled, TxType.VALIDATOR, validatorBody(ValidatorOp.UNREGISTER, 0n, scheduled.publicKey), { gas: 0n })],
      { producer: scheduled },
    );
    expect(h.chain.world.activeValidators()).toHaveLength(1);
    expect(chainIsHaltedForWantOfValidators(h.chain.world)).toBe(false);
    const remaining = byAddress.get(h.chain.world.activeValidators()[0]!)!;
    expect(produceAt(h, remaining, h.chain.tip!.timestamp + SLOT + 1).header.height).toBe(h.chain.height);

    // Historical fact: the indicator was set at the first registration and stays
    // set through every departure. Nothing in the protocol clears it, so a node
    // can never re-derive bootstrap mode from a later state.
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    expect(validatorOf(h, validator.address)!.registeredAtHeight).toBeLessThan(h.chain.height);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('names the exact instant a jail ends, and restores the validator in the block that reaches it', async () => {
    const { h, validator, byAddress } = await fundedHarness();
    register(h, validator, byAddress);

    // The chain stops for this validator at a known instant, and the term is a
    // duration of PROTOCOL TIME committed in the state — not a number of blocks,
    // which could never be reached on a chain that has stopped producing.
    const start = h.chain.tip!.timestamp;
    expect(validatorOf(h, validator.address)!.status).toBe('ACTIVE');

    const jailed = { status: 'JAILED', jailedUntilTime: start + VALIDATOR_JAIL_SECONDS } as const;
    expect(VALIDATOR_JAIL_SECONDS).toBe(CONSENSUS_PARAMS.consensus.jailSlots * SLOT);
    expect(jailIsOver(jailed, start + VALIDATOR_JAIL_SECONDS - 1)).toBe(false);
    expect(jailIsOver(jailed, start + VALIDATOR_JAIL_SECONDS)).toBe(true);
    // A JAILED record with no term is jailed for ever, not free: the term is what
    // makes a jail end, and guessing a default would release a validator the
    // chain had removed.
    expect(jailIsOver({ status: 'JAILED' }, start + VALIDATOR_JAIL_SECONDS * 10)).toBe(false);
    expect(jailIsOver({ status: 'ACTIVE', jailedUntilTime: start }, start + 1)).toBe(false);
  });

  it('halts when every remaining validator is gone or jailed, and the lapse alone brings it back', async () => {
    const { h, validator, byAddress } = await fundedHarness();
    register(h, validator, byAddress);
    const second = makeWallet();
    produceScheduled(h, byAddress, [signedPayment(h, validator, second.address, BOND + expectedGas(BOND))]);
    byAddress.set(second.address, second);
    register(h, second, byAddress);
    expect(h.chain.world.activeValidators()).toHaveLength(2);

    // Jail the first validator the way the protocol does: it holds round 0 and
    // the other validator produces those blocks a round late, past
    // `maxMissedSlotsPerWindow`. (A SOLE validator can never be jailed this way —
    // the round-0 holder is itself, and a validator that produces its own block
    // is never named as having missed it. That asymmetry is why the halt below
    // needs a second seat to be reachable at all.)
    for (let step = 0; step < 400; step += 1) {
      if (validatorOf(h, validator.address)?.status === 'JAILED') break;
      const head = h.chain.tip!;
      const roundZero = scheduledProposer(h.chain.world, head.height + 1, 0, head.timestamp + SLOT + 1);
      const round = roundZero === validator.address ? 1 : 0;
      const timestamp = head.timestamp + SLOT * (round + 1) + 1;
      const scheduled = scheduledProposer(h.chain.world, head.height + 1, round, timestamp);
      expect(scheduled).not.toBeNull();
      // The fake clock moves with the chain: a candidate block dated more than
      // the drift allowance ahead of this node's clock is refused for its
      // timestamp, not for its proposer.
      produceAt(h, byAddress.get(scheduled!) ?? second, timestamp);
    }
    const jailed = validatorOf(h, validator.address)!;
    expect(jailed.status).toBe('JAILED');
    const lapse = jailed.jailedUntilTime!;
    expect(h.chain.world.activeValidators()).toEqual([second.address]);

    // The other validator leaves the rotation as well. The established set now
    // has nobody: the halt, not open production.
    const scheduledNow = byAddress.get(h.chain.scheduledProposerNow()!)!;
    h.produce(
      [
        h.sign(scheduledNow, TxType.VALIDATOR, validatorBody(ValidatorOp.UNREGISTER, 0n, scheduledNow.publicKey), {
          gas: 0n,
        }),
      ],
      { producer: scheduledNow },
    );
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    expect(h.chain.world.activeValidators()).toEqual([]);
    expect(chainIsHaltedForWantOfValidators(h.chain.world)).toBe(true);
    expect(validatorRotationIsOpen(h.chain.world)).toBe(false);

    const stranger = makeWallet();
    const heightBefore = h.chain.height;
    for (const producer of [validator, second, stranger]) {
      for (const round of [0, 1]) {
        const timestamp = h.chain.tip!.timestamp + SLOT * (round + 1) + 1;
        advanceClock(Math.max(0, (timestamp + 2 - Math.floor(Date.now() / 1000)) * 1_000));
        const outcome = h.tryBlock([], { producer, timestamp });
        expect(outcome.accepted, `${producer.address} in round ${round}`).toBe(false);
        expect(outcome.code).toBe(ErrCode.NOT_PRODUCER_TURN);
      }
    }
    expect(h.chain.height).toBe(heightBefore);

    // The jail is a duration of protocol time, so it lapses on a chain that is
    // producing nothing. The block that reaches the instant is proposed by the
    // validator the jail ends for, and the same block's bookkeeping restores it —
    // the chain resumes without ever having opened production to an unbonded key.
    expect(lapse).toBeGreaterThan(h.chain.tip!.timestamp);
    produceAt(h, validator, lapse);
    expect(validatorOf(h, validator.address)!.status).toBe('ACTIVE');
    expect(validatorOf(h, validator.address)!.jailedUntilTime).toBeUndefined();
    expect(h.chain.world.activeValidators()).toEqual([validator.address]);
    expect(chainIsHaltedForWantOfValidators(h.chain.world)).toBe(false);
    expect(h.chain.world.s.validatorModeEstablished).toBe(true);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});
