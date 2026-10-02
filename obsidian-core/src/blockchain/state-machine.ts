/**
 * The block state machine.
 *
 * This is the ONLY code path that ever changes protocol state. It is
 * deterministic: given (parent state, ordered transactions, block context,
 * network) every node produces byte-identical state or rejects the block. That
 * property is what makes independent validation possible, and the state root is
 * the proof that two nodes agree.
 *
 * Fixed execution order for a block:
 *   1. per-transaction structural validation (version, chain id, size, expiry,
 *      nonce, signature, replay);
 *   2. the type-specific executor, in block order;
 *   3. ONS name expiry routine;
 *   4. Time Capsule unlock routine;
 *   5. validator booking (jailing / unjailing);
 *   6. metrics recount;
 *   7. supply-invariant verification;
 *   8. state root + events root computation and comparison with the header.
 */

import { Reader } from '../protocol/encoding.js';
import type { Block, ProtocolEvent, TxEnvelope } from '../protocol/types.js';
import { TxType } from '../protocol/types.js';
import { ErrCode, ProtocolError, reject } from '../protocol/errors.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import { validateTxStructure, decodeSignedTx } from '../transactions/encode.js';
import { executeTransaction } from '../transactions/index.js';
import { processNameExpiry } from '../transactions/executors/ons.js';
import { processNodeRewardRoutine } from '../economy/settlement.js';
import { processCapsuleUnlocks } from '../transactions/executors/capsule.js';
import { processValidatorBookkeeping } from '../transactions/executors/validator.js';
import { merkleRootHex } from './merkle.js';
import { computeStateRoot } from './state-root.js';
import { WorldState, type ApplyContext } from './state.js';
import { encodeEventForRoot } from './events.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';

export interface BlockContext {
  height: number;
  timestamp: number;
  chainId: number;
  producer: string;
}

export interface BlockRoutinesOptions {
  /** Validators that failed to propose in their slot, for jailing bookkeeping. */
  missedProposers?: string[];
}

export interface ApplyTransactionsResult {
  state: WorldState;
  events: ProtocolEvent[];
  gasBaseTotal: bigint;
}

export const SUPPORTED_PROTOCOL_VERSIONS: string[] = [CONSENSUS_PARAMS.protocolVersion];

/** Decode the canonical byte form of a block's transactions. */
export function decodeBlockTransactions(payloads: Uint8Array[]): TxEnvelope[] {
  return payloads.map((payload) => {
    const reader = new Reader(payload);
    const tx = decodeSignedTx(reader);
    reader.ensureConsumed();
    return tx;
  });
}

/**
 * Apply an ordered transaction list to `state` (mutating it) and return the
 * events emitted. Used both by full block validation and by block production.
 */
export function applyTransactions(
  state: WorldState,
  transactions: TxEnvelope[],
  ctx: BlockContext,
  net: NetworkDefinition,
): ApplyTransactionsResult {
  const seenInBlock = new Set<string>();
  const claimsPerWallet = new Map<string, number>();
  let gasBaseTotal = 0n;

  for (const tx of transactions) {
    const txId = tx.id;
    if (seenInBlock.has(txId)) {
      reject(ErrCode.DUPLICATE_TX, 'the same transaction appears twice in one block', { txId });
    }
    seenInBlock.add(txId);
    if (state.hasTxId(txId)) {
      reject(ErrCode.REPLAY, 'transaction was already applied in an earlier block', { txId });
    }

    const account = state.getAccount(tx.sender);
    const apply: ApplyContext = {
      height: ctx.height,
      timestamp: ctx.timestamp,
      txId,
      producer: ctx.producer,
    };

    validateTxStructure(tx, {
      chainId: ctx.chainId,
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      protocolTime: ctx.timestamp,
      expectedNonce: account?.nonce ?? 0,
      height: ctx.height,
      addressHrp: net.addressHrp,
    });

    if (tx.type === TxType.MINING_CLAIM) {
      const count = claimsPerWallet.get(tx.sender) ?? 0;
      if (count >= CONSENSUS_PARAMS.mining.maxClaimsPerBlockPerWallet) {
        reject(ErrCode.MINING_CYCLE_LIMIT, 'too many claims from one wallet in a single block');
      }
      claimsPerWallet.set(tx.sender, count + 1);
    }

    const result = executeTransaction({ state, apply, net, chainId: ctx.chainId }, tx);
    gasBaseTotal += result.gasBase;

    state.setNonce(tx.sender, tx.nonce + 1, apply);
    state.rememberTxId(txId);
    state.s.metrics.totalTransactions += 1;
  }

  return { state, events: state.takeEvents(), gasBaseTotal };
}

/** Protocol routines that run once per block, after all transactions. */
export function runBlockRoutines(
  state: WorldState,
  ctx: BlockContext,
  net: NetworkDefinition,
  options: BlockRoutinesOptions = {},
): ProtocolEvent[] {
  const routineContext = {
    state,
    net,
    chainId: ctx.chainId,
    apply: { height: ctx.height, timestamp: ctx.timestamp, producer: ctx.producer },
  };
  processNameExpiry(routineContext);
  processCapsuleUnlocks(routineContext);
  // Proof of Time node rewards settle by period, inside consensus, with no
  // operator or service online — see src/economy/settlement.ts.
  processNodeRewardRoutine(routineContext);
  processValidatorBookkeeping(routineContext, options.missedProposers ?? []);
  state.recountActiveMiners();
  return state.takeEvents();
}

export interface FinalizeResult {
  stateRoot: string;
  eventsRoot: string;
  events: ProtocolEvent[];
  supply: bigint;
}

/**
 * Verify invariants and compute the roots a block header must commit to.
 * Throws (rejecting the block) when the supply invariant is violated.
 */
export function finalizeBlock(state: WorldState, events: ProtocolEvent[]): FinalizeResult {
  const invariant = state.verifySupplyInvariant();
  if (!invariant.ok) {
    reject(ErrCode.SUPPLY_EXCEEDED, `supply invariant violated: ${invariant.reason}`);
  }
  const eventsRoot = merkleRootHex(events.map(encodeEventForRoot));
  return {
    stateRoot: computeStateRoot(state.s),
    eventsRoot,
    events,
    supply: invariant.totalSupply,
  };
}

export interface ApplyBlockResult {
  state: WorldState;
  stateRoot: string;
  eventsRoot: string;
  events: ProtocolEvent[];
  gasBaseTotal: bigint;
  applied: number;
  supply: bigint;
}

export interface ApplyBlockOptions {
  net: NetworkDefinition;
  /** Skip header root equality checks (block production / trusted replay). */
  skipRootCheck?: boolean;
  missedProposers?: string[];
}

/**
 * Full block application: clone the parent state, execute, verify invariants and
 * compare the resulting roots with the header.
 */
export function applyBlock(
  parentState: WorldState,
  block: Block,
  options: ApplyBlockOptions,
): ApplyBlockResult {
  const { net, skipRootCheck = false } = options;
  const state = parentState.clone();
  state.advanceBlock(block.header.height, block.header.timestamp);
  state.clearDeltas();

  const ctx: BlockContext = {
    height: block.header.height,
    timestamp: block.header.timestamp,
    chainId: block.header.chainId,
    producer: block.header.producer,
  };

  const applied = applyTransactions(state, block.transactions, ctx, net);
  const routineEvents = runBlockRoutines(state, ctx, net, { missedProposers: options.missedProposers });
  const events = [...applied.events, ...routineEvents];
  const finalized = finalizeBlock(state, events);

  if (!skipRootCheck) {
    if (finalized.stateRoot !== block.header.stateRoot) {
      reject(ErrCode.BAD_STATE_ROOT, 'state root mismatch: this node disagrees with the block producer', {
        expected: block.header.stateRoot,
        computed: finalized.stateRoot,
        height: block.header.height,
      });
    }
    if (finalized.eventsRoot !== block.header.eventsRoot) {
      reject(ErrCode.BAD_STATE_ROOT, 'events root mismatch', {
        expected: block.header.eventsRoot,
        computed: finalized.eventsRoot,
      });
    }
  }

  return {
    state,
    stateRoot: finalized.stateRoot,
    eventsRoot: finalized.eventsRoot,
    events,
    gasBaseTotal: applied.gasBaseTotal,
    applied: block.transactions.length,
    supply: finalized.supply,
  };
}

export interface SimulationResult {
  state: WorldState;
  events: ProtocolEvent[];
  root: string;
  results: Array<{ txId: string; ok: boolean; error?: string }>;
}

/**
 * Simulate a set of transactions without committing anything. Used by the RPC
 * layer for fee/eligibility previews. A failure never affects stored state.
 */
export function simulateTransactions(
  baseState: WorldState,
  transactions: TxEnvelope[],
  ctx: BlockContext,
  net: NetworkDefinition,
): SimulationResult {
  let state = baseState.clone();
  state.advanceBlock(ctx.height, ctx.timestamp);
  const events: ProtocolEvent[] = [];
  const results: Array<{ txId: string; ok: boolean; error?: string }> = [];

  for (const tx of transactions) {
    const trial = state.clone();
    trial.advanceBlock(ctx.height, ctx.timestamp);
    try {
      const outcome = applyTransactions(trial, [tx], ctx, net);
      state = outcome.state;
      events.push(...outcome.events);
      results.push({ txId: tx.id, ok: true });
    } catch (error) {
      const message = error instanceof ProtocolError ? `${error.code}: ${error.message}` : (error as Error).message;
      results.push({ txId: tx.id, ok: false, error: message });
    }
  }

  const routineEvents = runBlockRoutines(state, ctx, net);
  const finalized = finalizeBlock(state, [...events, ...routineEvents]);
  return { state, events: finalized.events, root: finalized.stateRoot, results };
}
