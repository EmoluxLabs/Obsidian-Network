/**
 * TREASURY — explicit, auditable protocol revenue flows (spec §13, §14, §70).
 *
 * Two rules define this executor:
 *
 *   1. PAY_REVENUE moves funds from the signer's OWN balance to the designated
 *      treasury wallet. It can never mint, never overdraw, and never touch
 *      another user's balance.
 *
 *   2. GRANT moves funds from the treasury wallet to a recipient, and must be
 *      signed by the treasury wallet itself. It is the foundation's normal
 *      spending path: transparent, on-chain and auditable.
 *
 * User mining rewards, marketplace proceeds, creator earnings, buyer funds and
 * unrelated transfers are never routed through here — the protocol only sends
 * explicitly platform-owned revenue to the treasury.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import { TreasuryOp, type TreasuryBody, type TxEnvelope } from '../../protocol/types.js';
import { assertAddress, assertAmount, assertGas } from '../helpers.js';
import { treasuryWallet } from '../../genesis/rules.js';
import type { ExecutorContext } from '../types.js';

export function decodeTreasuryBody(body: Uint8Array): TreasuryBody {
  const r = new Reader(body);
  const op = r.u8() as TreasuryOp;
  const amount = r.u128();
  const purpose = r.string();
  const to = r.string();
  r.ensureConsumed();
  return { op, amount, purpose, to: to || undefined };
}

export function encodeTreasuryBody(body: TreasuryBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.u128(body.amount);
  w.string(body.purpose);
  w.string(body.to ?? '');
  return w.finish();
}

export function executeTreasury(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeTreasuryBody(tx.body);
  assertAmount(body.amount, { label: 'amount' });
  if (body.purpose.length < 3 || body.purpose.length > 160) {
    reject(ErrCode.MALFORMED, 'purpose must be 3-160 characters and is stored on-chain for audit');
  }
  const treasury = treasuryWallet(state);
  if (!treasury) {
    reject(
      ErrCode.ORACLE_UNAVAILABLE,
      'the treasury wallet is not yet designated: it is set by the genesis rule when the first valid mining claim is accepted',
    );
  }

  switch (body.op) {
    case TreasuryOp.PAY_REVENUE: {
      const gas = assertGas(tx.gas, body.amount);
      state.debit(tx.sender, body.amount + gas, apply, 'protocol revenue payment + gas');
      state.credit(treasury, body.amount, apply, 'protocol revenue received by treasury');
      if (gas > 0n) {
        state.poolInflow(gas, 'treasury payment gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      state.s.metrics.totalTreasuryRevenue += body.amount;
      state.emit('TREASURY_REVENUE', {
        payer: tx.sender,
        treasury,
        amount: body.amount.toString(),
        purpose: body.purpose,
      }, apply);
      return { gasBase: body.amount, detail: { treasury, amount: body.amount.toString() } };
    }

    case TreasuryOp.GRANT: {
      if (tx.sender !== treasury) {
        reject(ErrCode.UNAUTHORIZED, 'only the designated treasury wallet may issue a grant');
      }
      if (!body.to) reject(ErrCode.MALFORMED, 'a recipient address is required');
      assertAddress(body.to, net, 'grant recipient');
      const gas = assertGas(tx.gas, body.amount);
      state.debit(tx.sender, body.amount + gas, apply, 'treasury grant + gas');
      state.credit(body.to, body.amount, apply, 'treasury grant received');
      if (gas > 0n) {
        state.poolInflow(gas, 'treasury grant gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      state.emit('TREASURY_GRANT', {
        treasury,
        recipient: body.to,
        amount: body.amount.toString(),
        purpose: body.purpose,
      }, apply);
      return { gasBase: body.amount, detail: { to: body.to, amount: body.amount.toString(), purpose: body.purpose } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported treasury operation ${body.op}`);
  }
}

/**
 * GOVERNANCE transactions are reserved and always rejected in protocol 1.0.0.
 * Parameter changes require a documented protocol version upgrade because every
 * consensus parameter participates in PARAMS_HASH, which peers verify during
 * the handshake. This is deliberate: no transaction, and no administrator, can
 * silently change consensus rules at runtime.
 */
export function executeGovernance(tx: TxEnvelope): never {
  reject(
    ErrCode.UNAUTHORIZED,
    `governance transactions are not enabled in protocol ${tx.protocolVersion}: ` +
      'consensus parameters change only through a signed protocol version upgrade',
  );
}
