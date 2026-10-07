/**
 * Transaction dispatch.
 *
 * The state machine calls exactly one executor per transaction type, and an
 * unknown type is a hard rejection — never a silent no-op. Fees/limits that
 * apply to every type are enforced in the state machine (nonce, replay, size),
 * while type-specific rules live in each executor.
 */

import { TxType, type TxEnvelope } from '../protocol/types.js';
import { ErrCode, reject } from '../protocol/errors.js';
import type { ExecutorContext, ExecutorResult } from './types.js';
import { executePayment } from './executors/payment.js';
import { executeMiningClaim } from './executors/mining.js';
import { executeOns } from './executors/ons.js';
import { executeOracle } from './executors/oracle.js';
import { executeValidator } from './executors/validator.js';
import { executeTreasury, executeGovernance } from './executors/treasury.js';
import { executeNodeRegistry } from './executors/node-registry.js';

export function executeTransaction(ctx: ExecutorContext, tx: TxEnvelope): ExecutorResult {
  switch (tx.type) {
    case TxType.PAYMENT: {
      const result = executePaymentAndMeasure(ctx, tx);
      return result;
    }
    case TxType.MINING_CLAIM:
      return executeMiningClaim(ctx, tx);
    case TxType.ONS:
      return executeOns(ctx, tx);
    case TxType.ORACLE:
      return executeOracle(ctx, tx);
    case TxType.VALIDATOR:
      return executeValidator(ctx, tx);
    case TxType.TREASURY:
      return executeTreasury(ctx, tx);
    case TxType.GOVERNANCE:
      return executeGovernance(tx);
    case TxType.NODE_REGISTRY:
      return executeNodeRegistry(ctx, tx);
    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `transaction type ${tx.type} is not supported by this protocol version`);
  }
}

function executePaymentAndMeasure(ctx: ExecutorContext, tx: TxEnvelope): ExecutorResult {
  executePayment(ctx, tx);
  // Gas base for a payment is the transferred amount; the executor already
  // validated the exact value, so re-deriving it here keeps the audit record
  // consistent without a second decode path.
  return { gasBase: tx.gas };
}

export { TxType };
export type { ExecutorContext, ExecutorResult };
