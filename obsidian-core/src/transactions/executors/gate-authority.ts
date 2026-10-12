/**
 * GATE_AUTHORITY — rotate or revoke the mining gate issuer keys (protocol 1.8.0).
 *
 * The rules live in `mining/gate-authority.ts`; this executor only runs them against the world state and records
 * the result. The transaction carries no value and no gas: it is authorised by the issuers' signatures inside it,
 * not by whoever pays for block space, and pricing it would put a fee between an operator and the removal of a
 * stolen key.
 */

import { ErrCode, reject } from '../../protocol/errors.js';
import type { TxEnvelope } from '../../protocol/types.js';
import { decodeGateAuthorityBody, verifyGateUpdate } from '../../mining/gate-authority.js';
import type { ExecutorContext, ExecutorResult } from '../types.js';

export function executeGateAuthority(ctx: ExecutorContext, tx: TxEnvelope): ExecutorResult {
  const { state, net, chainId } = ctx;
  if (tx.gas !== 0n) reject(ErrCode.BAD_GAS, 'a gate authority update carries no gas');
  const body = decodeGateAuthorityBody(tx.body);
  const g = state.s.genesis;
  const outcome = verifyGateUpdate(
    { active: g.gateKeysActive, revoked: g.gateKeysRevoked, epoch: g.gateEpoch },
    body,
    { networkId: net.networkId, chainId },
  );
  state.applyGateUpdate(outcome);
  return {
    gasBase: 0n,
    detail: {
      op: 'UPDATE',
      epoch: outcome.epoch,
      added: outcome.added,
      removed: outcome.removed,
      active: outcome.active,
      approvedBy: outcome.approvedBy,
      submitter: tx.sender,
    },
  };
}
