/**
 * Executor context and dispatch contract.
 *
 * Every transaction type implements the same signature so the state machine can
 * treat them uniformly and so "unknown type" can never silently no-op.
 */

import type { TxEnvelope } from '../protocol/types.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { WorldState, ApplyContext } from '../blockchain/state.js';

import type { ConsensusEvidenceContext } from '../protocol/types.js';

export interface ExecutorContext {
  state: WorldState;
  apply: ApplyContext;
  net: NetworkDefinition;
  chainId: number;
  /**
   * Historical lookups for consensus-critical evidence, supplied by the chain
   * that is applying the block. Only an executor that has to judge something
   * signed in the PAST needs it (today: SLASH), and it is deliberately optional
   * so an executor cannot pretend to have history it was not given — it must
   * refuse instead.
   */
  evidence?: ConsensusEvidenceContext;
}

export interface ExecutorResult {
  /** Base amount the gas formula is applied to (for audit + explorer). */
  gasBase: bigint;
  /** Optional structured detail returned to the RPC caller. */
  detail?: Record<string, unknown>;
}

export type Executor = (ctx: ExecutorContext, tx: TxEnvelope) => ExecutorResult;
