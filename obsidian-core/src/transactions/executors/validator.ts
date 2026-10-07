/**
 * VALIDATOR — registration and bonding for consensus participation.
 *
 * A validator bonds exactly params.consensus.validatorBond OBS. Bonded OBS
 * is locked value: it leaves the spendable balance, and it is counted by the
 * supply invariant while bonded. Unbonding takes params.consensus.unbondingBlocks
 * blocks, after which the bond returns to the owner's balance.
 *
 * Bonded stake is the *only* role it plays here: it does not vote on consensus
 * outcomes, and no validator can mint, alter balances, or rewrite history. It
 * establishes who may propose blocks in rotation (see consensus/proposer.ts).
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import { ValidatorOp, type TxEnvelope, type ValidatorBody } from '../../protocol/types.js';
import { assertAmount, assertGas } from '../helpers.js';
import { formatObs } from '../../protocol/amount.js';
import { addressFromPublicKey } from '../../crypto/keys.js';
import type { ExecutorContext } from '../types.js';

export function decodeValidatorBody(body: Uint8Array): ValidatorBody {
  const r = new Reader(body);
  const op = r.u8() as ValidatorOp;
  const bond = r.u128();
  const validatorKey = r.string();
  const commissionBps = r.u32();
  r.ensureConsumed();
  return { op, bond, validatorKey, commissionBps: commissionBps || undefined };
}

export function encodeValidatorBody(body: ValidatorBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.u128(body.bond);
  w.string(body.validatorKey);
  w.u32(body.commissionBps ?? 0);
  return w.finish();
}

export function executeValidator(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply } = ctx;
  const body = decodeValidatorBody(tx.body);

  switch (body.op) {
    case ValidatorOp.REGISTER: {
      assertAmount(body.bond, { label: 'bond' });
      if (body.bond !== CONSENSUS_PARAMS.consensus.validatorBond) {
        reject(
          ErrCode.VALIDATOR_BOND_MISMATCH,
          `validator bond must equal exactly ${formatObs(CONSENSUS_PARAMS.consensus.validatorBond)} OBS`,
          { required: CONSENSUS_PARAMS.consensus.validatorBond.toString(), offered: body.bond.toString() },
        );
      }
      if (!/^0[23][0-9a-f]{64}$/.test(body.validatorKey)) {
        reject(ErrCode.MALFORMED, 'validatorKey must be a lowercase 33-byte compressed public key');
      }
      let validatorAddress: string;
      try {
        validatorAddress = addressFromPublicKey(body.validatorKey, ctx.net.addressHrp);
      } catch {
        reject(ErrCode.MALFORMED, 'validatorKey is not a valid compressed secp256k1 public key');
      }
      if (validatorAddress !== tx.sender) {
        reject(
          ErrCode.UNAUTHORIZED,
          'validatorKey must be the public key that controls the registering account',
        );
      }
      const commission = body.commissionBps ?? 0;
      if (commission > 10_000) reject(ErrCode.MALFORMED, 'commission is expressed in basis points (0-10000)');
      const account = state.touchAccount(tx.sender, apply);
      if (!account.validator && state.s.validators.size >= CONSENSUS_PARAMS.consensus.finality.maxValidators) {
        reject(ErrCode.RATE_LIMITED, `validator registry is capped at ${CONSENSUS_PARAMS.consensus.finality.maxValidators}`);
      }
      if (account.validator) {
        // Registering over an UNBONDING record used to be allowed. It could
        // not be: `setValidator` overwrites the record wholesale, so the bond
        // still held by the old one was erased without ever being credited
        // back — destroying it, breaking the supply invariant, and throwing
        // out of finalizeBlock. The unbonded stake has to be claimed first.
        reject(
          ErrCode.REPLAY,
          account.validator.status === 'UNBONDING'
            ? 'this account is unbonding: claim the stake (VALIDATOR CLAIM_UNBONDED) before registering again'
            : 'this account is already a registered validator',
        );
      }
      assertGas(tx.gas, body.bond);
      state.debit(tx.sender, body.bond + tx.gas, apply, 'validator bond + gas');
      if (tx.gas > 0n) {
        state.poolInflow(tx.gas, 'validator bond gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += tx.gas;
      }
      state.setValidator(
        tx.sender,
        {
          validatorKey: body.validatorKey,
          bond: body.bond,
          commissionBps: commission,
          registeredAtHeight: apply.height,
          missedSlots: 0,
          status: 'ACTIVE',
        },
        apply,
      );
      state.emit('VALIDATOR_REGISTERED', {
        validator: tx.sender,
        bond: body.bond.toString(),
        commissionBps: commission,
        height: apply.height,
      }, apply);
      return { gasBase: body.bond, detail: { validator: tx.sender, bond: body.bond.toString() } };
    }

    case ValidatorOp.UNREGISTER: {
      const account = state.getAccount(tx.sender);
      if (!account?.validator) reject(ErrCode.NOT_FOUND, 'this account is not a validator');
      if (account.validator.status === 'UNBONDING') reject(ErrCode.REPLAY, 'unbonding is already in progress');
      assertGas(tx.gas, 0n);
      account.validator.status = 'UNBONDING';
      account.validator.unbondingStartHeight = apply.height;
      state.emit('VALIDATOR_UNBONDING', {
        validator: tx.sender,
        availableAtHeight: apply.height + CONSENSUS_PARAMS.consensus.unbondingBlocks,
      }, apply);
      return { gasBase: 0n, detail: { status: 'UNBONDING' } };
    }

    case ValidatorOp.CLAIM_UNBONDED: {
      const account = state.getAccount(tx.sender);
      if (!account?.validator) reject(ErrCode.NOT_FOUND, 'this account is not a validator');
      const validator = account.validator;
      if (validator.status !== 'UNBONDING' || validator.unbondingStartHeight === undefined) {
        reject(ErrCode.UNAUTHORIZED, 'there is no unbonding balance to claim');
      }
      const readyAt = validator.unbondingStartHeight + CONSENSUS_PARAMS.consensus.unbondingBlocks;
      if (apply.height < readyAt) {
        reject(ErrCode.NOT_YET_VALID, `unbonding completes at height ${readyAt}`);
      }
      assertGas(tx.gas, 0n);
      const bond = validator.bond;
      state.removeValidator(tx.sender);
      state.credit(tx.sender, bond, apply, 'validator bond returned after unbonding');
      state.emit('VALIDATOR_UNBONDED', { validator: tx.sender, bond: bond.toString() }, apply);
      return { gasBase: 0n, detail: { bond: bond.toString() } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported validator operation ${body.op}`);
  }
}

/**
 * Per-block validator bookkeeping: jail validators that keep missing their slot
 * and release jails whose term has ended. Deterministic and height-driven — no
 * administrator, no dashboard action.
 *
 * The counter is a LEAKY one:
 *   - a slot the chain records as missed adds 1;
 *   - a block the validator itself produces subtracts 1 (floor 0);
 *   - more than `maxMissedSlotsPerWindow` net misses jails it.
 *
 * It used to subtract 1 on every block the validator was not named in. That can
 * never jail anyone in a set of three or more: a validator that is absent is
 * the round-0 proposer of only one block in n, so it earned +1 once and -1
 * for each of the other n-1 blocks and sat at zero for ever. Decay now has to
 * be earned by actually producing, so an absent validator's count only goes
 * one way.
 */
export function processValidatorBookkeeping(ctx: ExecutorContext, missedBy: string[]): void {
  const { state, apply } = ctx;
  for (const address of [...state.s.validators].sort()) {
    const validator = state.s.accounts.get(address)?.validator;
    if (!validator) continue;
    if (validator.status === 'JAILED') {
      if ((validator.jailedUntilHeight ?? 0) <= apply.height) {
        validator.status = 'ACTIVE';
        validator.missedSlots = 0;
        delete validator.jailedUntilHeight;
        state.emit('VALIDATOR_UNJAILED', { validator: address }, apply);
      }
      continue;
    }
    if (validator.status !== 'ACTIVE') continue;
    if (missedBy.includes(address)) {
      validator.missedSlots += 1;
      if (validator.missedSlots > CONSENSUS_PARAMS.consensus.maxMissedSlotsPerWindow) {
        validator.status = 'JAILED';
        validator.jailedUntilHeight = apply.height + CONSENSUS_PARAMS.consensus.jailBlocks;
        validator.missedSlots = 0;
        state.emit('VALIDATOR_JAILED', {
          validator: address,
          untilHeight: validator.jailedUntilHeight,
          reason: 'missed slot budget exceeded',
        }, apply);
      }
    } else if (apply.producer === address) {
      validator.missedSlots = Math.max(0, validator.missedSlots - 1);
    }
  }
}
