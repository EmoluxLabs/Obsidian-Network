/**
 * PAYMENT — value transfer between wallets.
 *
 * Rules:
 *   - amount > 0 and >= the protocol dust minimum;
 *   - gas must equal min(0.02% of amount, 0.01 OBS);
 *   - sender balance must cover amount + gas (no negative balances, ever);
 *   - gas is remitted to the Mining Pool;
 *   - the recipient's address must be valid for this network's HRP.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import type { TxEnvelope } from '../../protocol/types.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { assertAddress, assertAmount, assertGas } from '../helpers.js';
import type { ExecutorContext } from '../types.js';

export interface PaymentDecoded {
  to: string;
  amount: bigint;
  memo?: string;
}

export function decodePaymentBody(body: Uint8Array): PaymentDecoded {
  const r = new Reader(body);
  const to = r.string();
  const amount = r.u128();
  const memo = r.string();
  r.ensureConsumed();
  return { to, amount, memo: memo.length ? memo : undefined };
}

export function encodePaymentBody(body: PaymentDecoded): Uint8Array {
  const w = new Writer();
  w.string(body.to);
  w.u128(body.amount);
  w.string(body.memo ?? '');
  return w.finish();
}

export function paymentBaseAmount(decoded: PaymentDecoded): bigint {
  return decoded.amount;
}

export function executePayment(ctx: ExecutorContext, tx: TxEnvelope): void {
  const { state, apply, net } = ctx;
  const decoded = decodePaymentBody(tx.body);
  assertAddress(decoded.to, net, 'recipient');
  assertAmount(decoded.amount, { label: 'amount' });
  if (decoded.amount < CONSENSUS_PARAMS.tx.minTransfer) {
    reject(ErrCode.AMOUNT_ZERO, `amount is below the protocol minimum of ${CONSENSUS_PARAMS.tx.minTransfer} seal(s)`);
  }
  if (decoded.memo && Buffer.byteLength(decoded.memo, 'utf8') > CONSENSUS_PARAMS.tx.maxMemoBytes) {
    reject(ErrCode.MALFORMED, 'memo too long');
  }
  const gas = assertGas(tx.gas, decoded.amount);

  // Atomic: debit then credit inside one state transition. If the debit fails
  // the executor throws and the whole transaction is rolled back with the block.
  state.debit(tx.sender, decoded.amount + gas, apply, 'payment debit (amount + gas)');
  state.credit(decoded.to, decoded.amount, apply, 'payment credit');
  if (gas > 0n) {
    state.poolInflow(gas, 'payment gas to mining pool');
    state.s.metrics.totalGasBurnedToPool += gas;
  }

  state.emit('PAYMENT', {
    from: tx.sender,
    to: decoded.to,
    amount: decoded.amount.toString(),
    gas: gas.toString(),
    memo: decoded.memo ?? null,
  }, apply);
}
