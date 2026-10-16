/**
 * ONS MARKETPLACE — fixed-price listings, purchases and owner-directed offers with protocol escrow (protocol 2.0.0).
 * Specified in docs/marketplace-v2.0.0.md.
 *
 * LISTING STATE MACHINE (per name)
 *     (none) --LIST--> LISTED --UPDATE_PRICE--> LISTED
 *     LISTED --DELIST (owner)--> (none)          LISTED --BUY (anyone else)--> (none), ownership moves
 *   While LISTED the owner cannot use or manage the name (executors/ons.ts: ERR_NAME_LISTED), no offer can be made,
 *   and LIST itself refunds every offer that was pending (their escrow returns to their makers, exactly once).
 *
 * OFFER STATE MACHINE (per offer)
 *     OFFER --> PENDING --ACCEPT (owner)--> ACCEPTED   name -> maker, escrow -> owner
 *                       --DECLINE (owner)--> DECLINED  escrow -> maker
 *                       --CANCEL (maker)---> CANCELLED escrow -> maker
 *                       --lapse-----------> EXPIRED    escrow -> maker   (block routine, economy/market.ts)
 *                       --listing, owner change, name expiry--> INVALIDATED  escrow -> maker
 *   PENDING is the only state that holds escrow, and leaving it is the only way to release it, so an offer settles at
 *   most once however the transactions that race for it are ordered.
 *
 * MONEY
 *   - A purchase debits price + gas from the buyer, credits the SELLER the full price, and sends gas to the Mining
 *     Pool. There is no marketplace commission: nothing is deducted from the seller and nothing is minted.
 *   - An offer moves `amount` from the maker's spendable balance into escrow (so it cannot be spent elsewhere) and
 *     charges gas on top, from the maker's balance, never from escrow.
 *   - Accepting, declining, cancelling, listing, re-pricing and delisting move no new value in, so they carry no gas
 *     (exactly like the existing ONS ownership operations); the seller therefore needs no balance to receive proceeds
 *     or to accept an offer.
 *   - Every transition either completes or throws before the state machine commits it: the state machine rejects the
 *     whole transaction (and any block carrying it), so a buyer can never pay without receiving the name.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import { MarketOp, type MarketBody, type MarketOffer, type OnsRecord, type TxEnvelope } from '../../protocol/types.js';
import { MAX_SUPPLY_SEALS } from '../../protocol/amount.js';
import { assertAmount, assertCanonicalAddress, assertGas } from '../helpers.js';
import { canonicalAddressText } from '../../crypto/keys.js';
import { closeOffer, voidPendingOffers } from '../../economy/market.js';
import { assertNotListed, changeOwner, normalizeName } from './ons.js';
import type { ExecutorContext } from '../types.js';

const OFFER_ID = /^[0-9a-f]{64}$/;

export function decodeMarketBody(body: Uint8Array): MarketBody {
  const r = new Reader(body);
  const op = r.u8() as MarketOp;
  const name = r.string();
  const amount = r.u128();
  const counterparty = r.string();
  const offerId = r.string();
  r.ensureConsumed();
  const decoded = { op, name, amount, counterparty, offerId };
  // Canonical bytes only: a body that decodes but would not re-encode to itself (invalid UTF-8, for example) is refused,
  // so one Marketplace action has exactly one valid encoding.
  const again = encodeMarketBody(decoded);
  if (again.length !== body.length || again.some((byte, i) => byte !== body[i])) {
    throw new Error('Marketplace body is not canonically encoded');
  }
  return decoded;
}

export function encodeMarketBody(body: MarketBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(body.name);
  w.u128(body.amount);
  w.string(canonicalAddressText(body.counterparty));
  w.string(body.offerId);
  return w.finish();
}

export function marketOpName(op: number): string {
  return MarketOp[op] ?? `OP_${op}`;
}

/** A registered, unexpired name. Expired names cannot be listed, bought, offered on or accepted on. */
function liveName(ctx: ExecutorContext, name: string): OnsRecord {
  const record = ctx.state.s.names.get(name);
  if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
  if (record.expiresAt <= ctx.apply.timestamp) {
    reject(ErrCode.NAME_TAKEN, `"${name}.obs" has expired: its owner must renew it before it can trade`);
  }
  return record;
}

function assertPrice(amount: bigint, label: string): void {
  assertAmount(amount, { label });
  if (amount < CONSENSUS_PARAMS.ons.market.minPriceSeals) {
    reject(ErrCode.AMOUNT_ZERO, `${label} is below the Marketplace minimum of ${CONSENSUS_PARAMS.ons.market.minPriceSeals} seals`, {
      minimum: CONSENSUS_PARAMS.ons.market.minPriceSeals.toString(),
    });
  }
  if (amount > MAX_SUPPLY_SEALS) reject(ErrCode.SUPPLY_EXCEEDED, `${label} exceeds the maximum supply`);
}

function requireOffer(ctx: ExecutorContext, body: MarketBody, name: string): MarketOffer {
  if (!OFFER_ID.test(body.offerId)) reject(ErrCode.MALFORMED, 'offerId must be a 64-character lowercase hex transaction id');
  const offer = ctx.state.offer(body.offerId);
  if (!offer || offer.name !== name) reject(ErrCode.NOT_FOUND, `no offer ${body.offerId.slice(0, 16)}… exists for "${name}.obs"`);
  if (offer.status !== 'PENDING') {
    reject(ErrCode.MARKET_STATE, `the offer is already ${offer.status.toLowerCase()}`, { status: offer.status });
  }
  return offer;
}

export function executeMarket(ctx: ExecutorContext, tx: TxEnvelope): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  let body: MarketBody;
  try {
    body = decodeMarketBody(tx.body);
  } catch (error) {
    // A short, overlong or otherwise undecodable body is a protocol error, never an uncaught exception.
    reject(ErrCode.MALFORMED, `malformed Marketplace body: ${(error as Error).message}`);
  }
  const name = normalizeName(body.name);
  const now = apply.timestamp;
  const market = CONSENSUS_PARAMS.ons.market;

  switch (body.op) {
    case MarketOp.LIST: {
      const record = liveName(ctx, name);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may list a name');
      if (record.listing) reject(ErrCode.MARKET_STATE, `"${name}.obs" is already listed: change its price or remove it first`);
      assertPrice(body.amount, 'price');
      assertGas(tx.gas, 0n);
      if (record.pendingTransfer && record.pendingTransfer.offerExpiresAt >= now) {
        reject(ErrCode.NAME_TRANSFER_STATE, `an ordinary transfer offer to ${record.pendingTransfer.to} is open: cancel it before listing`);
      }
      if (record.pendingRecovery) {
        reject(ErrCode.NAME_RECOVERY_STATE, 'a recovery is in flight: cancel it before listing');
      }
      record.pendingTransfer = undefined; // a lapsed offer, kept only until now
      // Offers that were pending are refunded, not accepted and not left locked: the maker's escrow returns now.
      const refunded = voidPendingOffers(state, apply, name, 'LISTED');
      record.listing = { price: body.amount, seller: tx.sender, listedAt: now, listedAtHeight: apply.height };
      state.s.market.listingsCreated += 1;
      state.emit('ONS_LISTED', { name, seller: tx.sender, price: body.amount.toString(), refundedOffers: refunded }, apply);
      return { gasBase: 0n, detail: { name, price: body.amount.toString(), refundedOffers: refunded } };
    }

    case MarketOp.UPDATE_PRICE: {
      const record = liveName(ctx, name);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may change a listing');
      if (!record.listing) reject(ErrCode.MARKET_STATE, `"${name}.obs" is not listed`);
      assertPrice(body.amount, 'price');
      if (body.amount === record.listing.price) reject(ErrCode.MARKET_STATE, 'the listing already has this price');
      assertGas(tx.gas, 0n);
      const previous = record.listing.price;
      record.listing = { ...record.listing, price: body.amount };
      state.emit('ONS_LISTING_UPDATED', {
        name,
        seller: tx.sender,
        previousPrice: previous.toString(),
        price: body.amount.toString(),
      }, apply);
      return { gasBase: 0n, detail: { name, previousPrice: previous.toString(), price: body.amount.toString() } };
    }

    case MarketOp.DELIST: {
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may remove a listing');
      if (!record.listing) reject(ErrCode.MARKET_STATE, `"${name}.obs" is not listed`);
      assertGas(tx.gas, 0n);
      const price = record.listing.price;
      record.listing = undefined;
      state.emit('ONS_DELISTED', { name, seller: tx.sender, price: price.toString() }, apply);
      return { gasBase: 0n, detail: { name } };
    }

    case MarketOp.BUY: {
      const record = liveName(ctx, name);
      const listing = record.listing;
      if (!listing) reject(ErrCode.MARKET_STATE, `"${name}.obs" is not listed for sale (it may already have been sold)`);
      if (tx.sender === record.owner) reject(ErrCode.MARKET_STATE, 'the seller cannot buy their own listing');
      assertCanonicalAddress(body.counterparty, net, 'seller');
      if (body.counterparty !== listing.seller || listing.seller !== record.owner) {
        reject(ErrCode.MARKET_STATE, 'the listing is no longer the seller\'s you reviewed', { seller: listing.seller });
      }
      assertPrice(body.amount, 'price');
      if (body.amount !== listing.price) {
        reject(ErrCode.MARKET_PRICE_MISMATCH, `the listing price is ${listing.price} seals, not ${body.amount}`, {
          price: listing.price.toString(),
        });
      }
      const gas = assertGas(tx.gas, listing.price);
      const seller = listing.seller;
      const price = listing.price;
      // One state transition: pay, credit, move ownership, drop the listing. Any throw before the end rolls the
      // whole transaction back (the state machine rejects it), so there is no half-finished purchase.
      state.debit(tx.sender, price + gas, apply, 'ONS purchase price + gas');
      state.credit(seller, price, apply, `ONS sale of ${name}`);
      if (gas > 0n) {
        state.poolInflow(gas, 'ONS purchase gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      changeOwner(state, apply, record, tx.sender);
      state.touchAccount(tx.sender, apply);
      state.s.market.salesCount += 1;
      state.s.market.salesVolume += price;
      state.emit('ONS_SOLD', {
        name,
        seller,
        buyer: tx.sender,
        price: price.toString(),
        gas: gas.toString(),
        expiresAt: record.expiresAt,
      }, apply);
      state.emit('ONS_TRANSFERRED', { name, from: seller, to: tx.sender, expiresAt: record.expiresAt, via: 'MARKET' }, apply);
      return { gasBase: price, detail: { name, seller, buyer: tx.sender, price: price.toString(), gas: gas.toString() } };
    }

    case MarketOp.OFFER: {
      const record = liveName(ctx, name);
      if (record.listing) {
        reject(ErrCode.NAME_LISTED, `"${name}.obs" is listed for ${record.listing.price} seals: buy it instead of making an offer`, {
          price: record.listing.price.toString(),
        });
      }
      if (record.owner === tx.sender) reject(ErrCode.MARKET_STATE, 'an owner cannot make an offer on their own name');
      assertCanonicalAddress(body.counterparty, net, 'owner');
      if (body.counterparty !== record.owner) {
        reject(ErrCode.MARKET_STATE, 'the name has a different owner than the one this offer was addressed to', { owner: record.owner });
      }
      assertPrice(body.amount, 'offer');
      const gas = assertGas(tx.gas, body.amount);
      const pendingOnName = state.offersForName(name, 'PENDING');
      if (pendingOnName.length >= market.maxPendingOffersPerName) {
        reject(ErrCode.MARKET_STATE, `"${name}.obs" already holds ${market.maxPendingOffersPerName} pending offers`);
      }
      if (pendingOnName.some((offer) => offer.maker === tx.sender)) {
        reject(ErrCode.MARKET_STATE, 'you already have a pending offer on this name: cancel it first');
      }
      if (state.offersByMaker(tx.sender, 'PENDING').length >= market.maxPendingOffersPerMaker) {
        reject(ErrCode.MARKET_STATE, `an account may hold at most ${market.maxPendingOffersPerMaker} pending offers`);
      }
      const id = apply.txId ?? tx.id;
      if (state.offer(id)) reject(ErrCode.DUPLICATE_TX, 'an offer with this id exists');
      // Lock first: if the maker cannot cover amount + gas this throws and nothing exists.
      state.escrowLock(tx.sender, body.amount, apply, `ONS offer escrow ${name}`);
      state.debit(tx.sender, gas, apply, 'ONS offer gas');
      if (gas > 0n) {
        state.poolInflow(gas, 'ONS offer gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      const offer: MarketOffer = {
        id,
        name,
        maker: tx.sender,
        owner: record.owner,
        amount: body.amount,
        status: 'PENDING',
        createdAt: now,
        createdAtHeight: apply.height,
        expiresAt: Math.min(now + market.offerSeconds, record.expiresAt),
      };
      state.putOffer(offer);
      state.s.market.offersMade += 1;
      state.emit('ONS_OFFER_MADE', {
        offerId: id,
        name,
        maker: tx.sender,
        owner: record.owner,
        amount: body.amount.toString(),
        gas: gas.toString(),
        expiresAt: offer.expiresAt,
      }, apply);
      return { gasBase: body.amount, detail: { offerId: id, name, amount: body.amount.toString(), expiresAt: offer.expiresAt } };
    }

    case MarketOp.ACCEPT_OFFER: {
      const record = liveName(ctx, name);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may accept an offer');
      assertNotListed(record, 'accept an offer');
      const offer = requireOffer(ctx, body, name);
      if (offer.owner !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'this offer was made to a previous owner');
      if (offer.expiresAt <= now) reject(ErrCode.MARKET_STATE, 'the offer has lapsed');
      assertAmount(body.amount, { label: 'amount' });
      if (body.amount !== offer.amount) {
        reject(ErrCode.MARKET_PRICE_MISMATCH, `the offer is for ${offer.amount} seals, not ${body.amount}`, { amount: offer.amount.toString() });
      }
      assertGas(tx.gas, 0n);
      const maker = offer.maker;
      // Settle this offer first (escrow to the owner, status ACCEPTED); changeOwner then refunds every OTHER pending
      // offer on the name, so each escrow is released exactly once and the name changes hands in the same step.
      closeOffer(state, apply, offer, 'ACCEPTED', tx.sender, tx.sender);
      changeOwner(state, apply, record, maker);
      state.touchAccount(maker, apply);
      state.s.market.offersAccepted += 1;
      state.s.market.salesCount += 1;
      state.s.market.salesVolume += offer.amount;
      state.emit('ONS_TRANSFERRED', { name, from: tx.sender, to: maker, expiresAt: record.expiresAt, via: 'OFFER' }, apply);
      return { gasBase: 0n, detail: { name, offerId: offer.id, seller: tx.sender, buyer: maker, amount: offer.amount.toString() } };
    }

    case MarketOp.DECLINE_OFFER: {
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may decline an offer');
      const offer = requireOffer(ctx, body, name);
      if (offer.owner !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'this offer was made to a previous owner');
      assertGas(tx.gas, 0n);
      closeOffer(state, apply, offer, 'DECLINED', tx.sender, offer.maker);
      return { gasBase: 0n, detail: { name, offerId: offer.id, refunded: offer.amount.toString() } };
    }

    case MarketOp.CANCEL_OFFER: {
      if (!OFFER_ID.test(body.offerId)) reject(ErrCode.MALFORMED, 'offerId must be a 64-character lowercase hex transaction id');
      const offer = state.offer(body.offerId);
      if (!offer || offer.name !== name) reject(ErrCode.NOT_FOUND, `no offer ${body.offerId.slice(0, 16)}… exists for "${name}.obs"`);
      if (offer.maker !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'only the offer maker may cancel an offer');
      if (offer.status !== 'PENDING') reject(ErrCode.MARKET_STATE, `the offer is already ${offer.status.toLowerCase()}`, { status: offer.status });
      assertGas(tx.gas, 0n);
      closeOffer(state, apply, offer, 'CANCELLED', tx.sender, offer.maker);
      return { gasBase: 0n, detail: { name, offerId: offer.id, refunded: offer.amount.toString() } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported Marketplace operation ${body.op}`);
  }
}
