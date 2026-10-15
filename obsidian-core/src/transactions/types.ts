/**
 * Executor context and dispatch contract.
 *
 * Every transaction type implements the same signature so the state machine can
 * treat them uniformly and so "unknown type" can never silently no-op.
 */

import type { TxEnvelope } from '../protocol/types.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { WorldState, ApplyContext } from '../blockchain/state.js';

export interface ExecutorContext {
  state: WorldState;
  apply: ApplyContext;
  net: NetworkDefinition;
  chainId: number;
  /**
   * Per-block counters for admission limits that are consensus rules (node registrations and equivocation reports
   * per block). Created fresh for every block application, so they can never leak between blocks.
   */
  counters: { registrations: number; equivocationReports: number };
}

export interface ExecutorResult {
  /** Base amount the gas formula is applied to (for audit + explorer). */
  gasBase: bigint;
  /** Optional structured detail returned to the RPC caller. */
  detail?: Record<string, unknown>;
}

export type Executor = (ctx: ExecutorContext, tx: TxEnvelope) => ExecutorResult;
