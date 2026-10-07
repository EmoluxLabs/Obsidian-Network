/**
 * Genesis Allocation rules (spec §10–§13).
 *
 * THE RULE
 *   - Allocation size: exactly 100,000 OBS, issued ONCE.
 *   - It is NOT granted at registration. A newly registered account holds 0 OBS.
 *   - It is granted to the wallet attached to the FIRST protocol-valid mining
 *     claim accepted by consensus, in canonical block order, and never again.
 *   - Once granted, that wallet becomes the protocol treasury wallet.
 *
 * ATOMICITY
 *   The transition genesis.allocationClaimed false -> true happens inside the
 *   state transition of one transaction in one block, under the same
 *   deterministic execution that every node replays. Two wallets cannot both
 *   receive it: whichever block becomes canonical defines the winner, and every
 *   node recomputes that block's state from scratch during reorgs.
 *
 * WHAT CAN NEVER DETERMINE THE WINNER
 *   frontend timestamps, server timestamps, browser clocks, database insertion
 *   order, Google account age, email verification time, administrator choice.
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { ErrCode, reject } from '../protocol/errors.js';
import type { GenesisState } from '../protocol/types.js';
import type { WorldState, ApplyContext } from '../blockchain/state.js';

export const GENESIS_ALLOCATION_AMOUNT = CONSENSUS_PARAMS.genesisAllocation;

/** The legacy 3,000,000 OBS allocation must never be issued again. */
export const LEGACY_GENESIS_ALLOCATION = CONSENSUS_PARAMS.legacyGenesisAllocationRemoved;

export interface GenesisOutcome {
  awarded: boolean;
  recipient: string;
  amount: bigint;
  reason: string;
}

/**
 * Attempt to award the Genesis Allocation to `claimant`.
 * Returns awarded=false when the allocation was already taken (normal case).
 * Throws only for protocol violations that must reject the whole transaction.
 */
export function awardGenesisAllocation(
  state: WorldState,
  claimant: string,
  ctx: ApplyContext,
): GenesisOutcome {
  const genesis: GenesisState = state.s.genesis;
  if (genesis.allocationClaimed) {
    return {
      awarded: false,
      recipient: genesis.recipient,
      amount: 0n,
      reason: 'genesis allocation already claimed',
    };
  }
  if (genesis.amount !== GENESIS_ALLOCATION_AMOUNT) {
    // Defence in depth: the state's allocation size is consensus data.
    reject(ErrCode.SUPPLY_EXCEEDED, 'genesis allocation size does not match consensus parameters');
  }
  if (!claimant) reject(ErrCode.GENESIS_NOT_ELIGIBLE, 'genesis claimant must be a wallet address');

  // 1. Issue the allocation (supply invariant enforced inside issue()).
  state.issue('GENESIS_ALLOCATION', GENESIS_ALLOCATION_AMOUNT, ctx, 'first valid miner genesis allocation');
  // 2. Credit the winning wallet.
  state.credit(claimant, GENESIS_ALLOCATION_AMOUNT, ctx, 'genesis allocation reward');
  // 3. Flip the one-way switch and record the recipient permanently.
  genesis.allocationClaimed = true;
  genesis.recipient = claimant;
  genesis.claimedAtHeight = ctx.height;
  genesis.claimedByTxId = ctx.txId;
  // 4. Treasury designation: initially identical to the genesis recipient.
  genesis.treasuryWallet = claimant;
  // 5. Anything the treasury was owed before it existed is paid now, in this same transaction,
  //    not at some later settlement. (Normally nothing is owed: nobody holds OBS before the
  //    first claim, so nothing can have been paid in. This is the guarantee, not the usual case.)
  state.claimUnclaimedRevenue(ctx);

  state.emit(
    'GENESIS_ALLOCATION_CLAIMED',
    {
      recipient: claimant,
      amount: GENESIS_ALLOCATION_AMOUNT.toString(),
      treasuryWallet: claimant,
      height: ctx.height,
    },
    ctx,
  );

  return {
    awarded: true,
    recipient: claimant,
    amount: GENESIS_ALLOCATION_AMOUNT,
    reason: 'genesis allocation awarded to first protocol-valid miner',
  };
}

/**
 * Treasury designation. The treasury wallet is protocol state, not a
 * configuration value: it is set by the genesis rule and can only ever move by
 * an explicit, documented consensus upgrade — never by an administrator, an
 * environment variable, a database row, or a frontend constant.
 */
export function treasuryWallet(state: WorldState): string {
  return state.s.genesis.treasuryWallet;
}

export function assertTreasuryConfigured(state: WorldState): void {
  if (!state.s.genesis.treasuryWallet) {
    reject(
      ErrCode.ORACLE_UNAVAILABLE,
      'the protocol treasury wallet is not yet designated: no valid mining claim has been accepted',
    );
  }
}
