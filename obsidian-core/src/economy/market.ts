/**
 * ONS Marketplace: offer settlement primitives and the per-block routine (protocol 2.0.0).
 *
 * Everything that moves escrow goes through `closeOffer`, which is the ONLY function that releases it. An offer can
 * be closed once: it must be PENDING, and it is never PENDING again, so no path can pay the same escrow twice (an
 * accept, a decline, a cancel, a listing, an ownership change and an expiry all race for the same offer, and the
 * first to run in block order wins deterministically).
 *
 * Nothing here reads a clock or a random source: every decision comes from committed state and the block's protocol
 * time, so every node reaches the same result.
 */

import { ErrCode, reject } from '../protocol/errors.js';
import type { MarketOffer, MarketOfferStatus } from '../protocol/types.js';
import type { WorldState, ApplyContext } from '../blockchain/state.js';

/** Why an offer ended without its owner or maker deciding. Stored in `resolvedBy` and carried by the event. */
export type MarketSystemReason = 'LISTED' | 'OWNER_CHANGED' | 'NAME_EXPIRED' | 'OFFER_EXPIRED';

const EVENT_FOR: Record<Exclude<MarketOfferStatus, 'PENDING'>, string> = {
  ACCEPTED: 'ONS_OFFER_ACCEPTED',
  DECLINED: 'ONS_OFFER_DECLINED',
  CANCELLED: 'ONS_OFFER_CANCELLED',
  EXPIRED: 'ONS_OFFER_EXPIRED',
  INVALIDATED: 'ONS_OFFER_INVALIDATED',
};

/**
 * End a pending offer and release its escrow to `payTo` — the offer maker for every ending except ACCEPTED, the
 * name's owner for ACCEPTED. Throws (changing nothing) if the offer is not pending.
 */
export function closeOffer(
  state: WorldState,
  apply: ApplyContext,
  offer: MarketOffer,
  status: Exclude<MarketOfferStatus, 'PENDING'>,
  resolvedBy: string,
  payTo: string,
): void {
  if (offer.status !== 'PENDING') {
    reject(ErrCode.MARKET_STATE, `offer ${offer.id.slice(0, 16)}… is already ${offer.status.toLowerCase()}`);
  }
  // Release first: if escrow cannot cover the offer (it always can; this is the invariant) nothing is marked settled.
  state.escrowRelease(payTo, offer.amount, apply, `ONS offer ${status.toLowerCase()} ${offer.name}`);
  offer.status = status;
  offer.resolvedAt = apply.timestamp;
  offer.resolvedAtHeight = apply.height;
  offer.resolvedBy = resolvedBy;
  offer.resolvedTxId = apply.txId;
  state.emit(EVENT_FOR[status], {
    offerId: offer.id,
    name: offer.name,
    maker: offer.maker,
    owner: offer.owner,
    amount: offer.amount.toString(),
    resolvedBy,
    status,
  }, apply);
}

/**
 * Refund every pending offer on a name (the name is being listed, is changing hands by another route, or has left
 * the registry). Deterministic: oldest first, ties by id.
 */
export function voidPendingOffers(
  state: WorldState,
  apply: ApplyContext,
  name: string,
  reason: MarketSystemReason,
  status: 'INVALIDATED' | 'EXPIRED' = 'INVALIDATED',
): number {
  const pending = state.offersForName(name, 'PENDING');
  for (const offer of pending) closeOffer(state, apply, offer, status, reason, offer.maker);
  return pending.length;
}

/**
 * Per-block routine: lapse offers whose time is up, refund offers whose name no longer exists or whose owner is no
 * longer the owner they were addressed to, and prune settled offers past retention. Runs after the name-expiry
 * routine so a name that just left the registry takes its offers with it in the same block.
 */
export function processMarketRoutine(state: WorldState, apply: ApplyContext): void {
  const pending = [...state.s.offers.values()].filter((offer) => offer.status === 'PENDING').sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const offer of pending) {
    const record = state.s.names.get(offer.name);
    if (!record) closeOffer(state, apply, offer, 'INVALIDATED', 'NAME_EXPIRED', offer.maker);
    else if (record.owner !== offer.owner) closeOffer(state, apply, offer, 'INVALIDATED', 'OWNER_CHANGED', offer.maker);
    else if (record.listing) closeOffer(state, apply, offer, 'INVALIDATED', 'LISTED', offer.maker);
    else if (offer.expiresAt <= apply.timestamp) closeOffer(state, apply, offer, 'EXPIRED', 'OFFER_EXPIRED', offer.maker);
  }
  state.pruneOffers(apply.timestamp);
}
