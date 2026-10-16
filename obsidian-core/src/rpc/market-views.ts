/**
 * Read-only views of the ONS Marketplace, built from authoritative world state (protocol 2.0.0). Pure functions: the
 * RPC server wraps them in routes, and tests call them directly. Nothing here is cached or stored — an index is only
 * ever a convenience over what these read, and `indexer` records are never consulted for ownership, listing or escrow.
 */

import type { WorldState } from '../blockchain/state.js';
import { formatObs } from '../protocol/amount.js';
import type { MarketOffer, OnsRecord } from '../protocol/types.js';

export type NameMarketStatus = 'AVAILABLE' | 'EXPIRED' | 'OWNED' | 'LISTED';

export interface ListingView {
  name: string;
  seller: string;
  owner: string;
  priceSeals: string;
  priceObs: string;
  listedAt: number;
  listedAtHeight: number;
  expiresAt: number;
  pendingOffers: number;
}

export interface OfferView {
  id: string;
  name: string;
  maker: string;
  owner: string;
  amountSeals: string;
  amountObs: string;
  status: MarketOffer['status'];
  createdAt: number;
  createdAtHeight: number;
  expiresAt: number;
  resolvedAt: number | null;
  resolvedAtHeight: number | null;
  resolvedBy: string | null;
  resolvedTxId: string | null;
  /** True only while the escrow for this offer is held: exactly the PENDING offers. */
  escrowHeld: boolean;
  /** The name's CURRENT owner, so a client can show an offer made to a previous owner as stale. */
  currentOwner: string | null;
}

export function listingView(record: OnsRecord): ListingView | null {
  const listing = record.listing;
  if (!listing) return null;
  return {
    name: `${record.name}.obs`,
    seller: listing.seller,
    owner: record.owner,
    priceSeals: listing.price.toString(),
    priceObs: formatObs(listing.price),
    listedAt: listing.listedAt,
    listedAtHeight: listing.listedAtHeight,
    expiresAt: record.expiresAt,
    pendingOffers: 0,
  };
}

export function offerView(state: WorldState, offer: MarketOffer): OfferView {
  return {
    id: offer.id,
    name: `${offer.name}.obs`,
    maker: offer.maker,
    owner: offer.owner,
    amountSeals: offer.amount.toString(),
    amountObs: formatObs(offer.amount),
    status: offer.status,
    createdAt: offer.createdAt,
    createdAtHeight: offer.createdAtHeight,
    expiresAt: offer.expiresAt,
    resolvedAt: offer.resolvedAt ?? null,
    resolvedAtHeight: offer.resolvedAtHeight ?? null,
    resolvedBy: offer.resolvedBy ?? null,
    resolvedTxId: offer.resolvedTxId ?? null,
    escrowHeld: offer.status === 'PENDING',
    currentOwner: state.s.names.get(offer.name)?.owner ?? null,
  };
}

/** What a client needs to decide between register / buy / make-offer, computed from the chain at `now`. */
export function nameMarketStatus(state: WorldState, name: string, now: number): {
  status: NameMarketStatus;
  owner: string | null;
  listing: ListingView | null;
  pendingOffers: number;
  /** True while the owner cannot use or manage the name as an ordinary name (the Marketplace lock). */
  locked: boolean;
  canRegister: boolean;
  canBuy: boolean;
  canOffer: boolean;
} {
  const record = state.s.names.get(name);
  if (!record) {
    return { status: 'AVAILABLE', owner: null, listing: null, pendingOffers: 0, locked: false, canRegister: true, canBuy: false, canOffer: false };
  }
  const live = record.expiresAt > now;
  const pending = state.offersForName(name, 'PENDING').length;
  const listing = listingView(record);
  if (listing) listing.pendingOffers = pending;
  const listed = Boolean(record.listing) && live;
  return {
    status: !live ? 'EXPIRED' : listed ? 'LISTED' : 'OWNED',
    owner: record.owner,
    listing,
    pendingOffers: pending,
    locked: Boolean(record.listing),
    canRegister: false,
    canBuy: listed,
    canOffer: live && !record.listing,
  };
}

export type ListingSort = 'newest' | 'oldest' | 'price_asc' | 'price_desc' | 'name';

/** Active listings, filtered and sorted deterministically (ties broken by name), then paginated. */
export function activeListings(
  state: WorldState,
  options: { seller?: string; prefix?: string; sort?: ListingSort; limit: number; offset: number; now: number },
): { listings: ListingView[]; total: number; offset: number; limit: number; hasMore: boolean } {
  const rows: OnsRecord[] = [];
  for (const record of state.s.names.values()) {
    if (!record.listing || record.expiresAt <= options.now) continue;
    if (options.seller && record.listing.seller !== options.seller) continue;
    if (options.prefix && !record.name.startsWith(options.prefix)) continue;
    rows.push(record);
  }
  const byName = (a: OnsRecord, b: OnsRecord): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const price = (r: OnsRecord): bigint => r.listing!.price;
  switch (options.sort ?? 'newest') {
    case 'oldest':
      rows.sort((a, b) => a.listing!.listedAtHeight - b.listing!.listedAtHeight || byName(a, b));
      break;
    case 'price_asc':
      rows.sort((a, b) => (price(a) < price(b) ? -1 : price(a) > price(b) ? 1 : byName(a, b)));
      break;
    case 'price_desc':
      rows.sort((a, b) => (price(a) > price(b) ? -1 : price(a) < price(b) ? 1 : byName(a, b)));
      break;
    case 'name':
      rows.sort(byName);
      break;
    default:
      rows.sort((a, b) => b.listing!.listedAtHeight - a.listing!.listedAtHeight || byName(a, b));
  }
  const page = rows.slice(options.offset, options.offset + options.limit);
  const listings = page.map((record) => {
    const view = listingView(record)!;
    view.pendingOffers = state.offersForName(record.name, 'PENDING').length;
    return view;
  });
  return {
    listings,
    total: rows.length,
    offset: options.offset,
    limit: options.limit,
    hasMore: options.offset + listings.length < rows.length,
  };
}

/** Offers made TO the owner of any name `address` currently owns (the owner's inbox). */
export function incomingOffers(state: WorldState, address: string, status?: MarketOffer['status']): OfferView[] {
  const out: MarketOffer[] = [];
  for (const record of state.s.names.values()) {
    if (record.owner !== address) continue;
    for (const offer of state.offersForName(record.name, status)) {
      if (offer.owner === address) out.push(offer);
    }
  }
  out.sort((a, b) => b.createdAtHeight - a.createdAtHeight || (a.id < b.id ? -1 : 1));
  return out.map((offer) => offerView(state, offer));
}

/** Offers `address` has made (the maker's outbox), including settled ones still inside the retention window. */
export function outgoingOffers(state: WorldState, address: string, status?: MarketOffer['status']): OfferView[] {
  return state
    .offersByMaker(address, status)
    .sort((a, b) => b.createdAtHeight - a.createdAtHeight || (a.id < b.id ? -1 : 1))
    .map((offer) => offerView(state, offer));
}

export function marketSummary(state: WorldState, now: number): Record<string, unknown> {
  let active = 0;
  let pending = 0;
  for (const record of state.s.names.values()) if (record.listing && record.expiresAt > now) active += 1;
  for (const offer of state.s.offers.values()) if (offer.status === 'PENDING') pending += 1;
  const m = state.s.market;
  return {
    activeListings: active,
    pendingOffers: pending,
    escrowBalanceSeals: m.escrowBalance.toString(),
    escrowBalanceObs: formatObs(m.escrowBalance),
    listingsCreated: m.listingsCreated,
    salesCount: m.salesCount,
    salesVolumeSeals: m.salesVolume.toString(),
    salesVolumeObs: formatObs(m.salesVolume),
    offersMade: m.offersMade,
    offersAccepted: m.offersAccepted,
    commissionBps: 0,
  };
}
