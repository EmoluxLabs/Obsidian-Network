/**
 * VALIDATOR — registration and bonding for consensus participation.
 *
 * A validator bonds at least params.consensus.minValidatorBond OBS. Bonded OBS
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
import { fromHex } from '../../crypto/hash.js';
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
      if (body.bond < CONSENSUS_PARAMS.consensus.minValidatorBond) {
        reject(
          ErrCode.INSUFFICIENT_FUNDS,
          `validator bond must be at least ${CONSENSUS_PARAMS.consensus.minValidatorBond} seals`,
        );
      }
      const key = fromHex(body.validatorKey);
      if (key.length !== 33) reject(ErrCode.MALFORMED, 'validatorKey must be a 33-byte compressed public key');
      const commission = body.commissionBps ?? 0;
      if (commission > 10_000) reject(ErrCode.MALFORMED, 'commission is expressed in basis points (0-10000)');
      const account = state.touchAccount(tx.sender, apply);
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
 * Per-block validator bookkeeping: jail validators that miss too many slots in
 * a rolling window and release jails whose term has ended. Deterministic and
 * height-driven — no administrator, no dashboard action.
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
    } else {
      validator.missedSlots = Math.max(0, validator.missedSlots - 1);
    }
  }
}
