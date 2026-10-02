/**
 * LAND — Obsidian Circle, the blockchain land registry (spec §45–§56).
 *
 * Two distinct markets exist and must never be confused:
 *
 *  1. PROTOCOL MARKET (PROTOCOL_BUY / PROTOCOL_SELL)
 *     The protocol issues or buys back exactly ONE square metre per transaction
 *     — multiple purchases must be separate transactions, each recomputing GLV
 *     before the next, so no single transaction can bypass the value sequence.
 *     GLV (official Global Location Value) is the price. A purchase raises the
 *     division's GLV; a buyback lowers it.
 *
 *  2. USER MARKETPLACE (LIST / DELIST / BUY_LISTED / GIFT)
 *     Owners set an MSP (asking price in OBS). Trading at MSP establishes the
 *     parcel's ILV as protocol state and never changes GLV. Gifting transfers
 *     ownership and charges standard gas.
 *
 * PARCEL IDENTITY
 *   Parcels are content-addressed: parcelId = bech32m("obsid",
 *   SHA-256("PARCEL|division|level|subId|plotIndex")). Transactions carry the
 *   human-readable descriptor and every node re-derives the id, so a caller can
 *   never fabricate or alias a parcel.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { domainHash } from '../../crypto/hash.js';
import { encodePayload } from '../../crypto/bech32.js';
import { ID_HRP } from '../../crypto/keys.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import { LandOp, type LandBody, type ParcelRecord, type TxEnvelope } from '../../protocol/types.js';
import { applyBasisPoints } from '../../protocol/amount.js';
import {
  assertAddress,
  assertAmount,
  assertGas,
} from '../helpers.js';
import { treasuryWallet } from '../../genesis/rules.js';
import { divisionSeed, normaliseDivisionId, DIVISION_LEVEL_CODES } from '../../land/registry.js';
import { RevenueSource } from '../../economy/accounting.js';
import type { ExecutorContext } from '../types.js';

export function decodeLandBody(body: Uint8Array): LandBody {
  const r = new Reader(body);
  const op = r.u8() as LandOp;
  const divisionId = r.string();
  const countryCode = r.string();
  const level = r.u8();
  const subId = r.string();
  const plotIndex = r.u128();
  const latMicro = Number(r.i128());
  const lonMicro = Number(r.i128());
  const price = r.u128();
  const to = r.string();
  const usdValueAtPurchase = r.u128();
  r.ensureConsumed();
  return {
    op,
    divisionId,
    countryCode,
    level,
    subId,
    plotIndex,
    latMicro: latMicro || undefined,
    lonMicro: lonMicro || undefined,
    price: price > 0n ? price : undefined,
    to: to.length ? to : undefined,
    usdValueAtPurchase: usdValueAtPurchase > 0n ? usdValueAtPurchase : undefined,
  };
}

export function encodeLandBody(body: LandBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(body.divisionId);
  w.string(body.countryCode);
  w.u8(body.level);
  w.string(body.subId);
  w.u128(body.plotIndex);
  w.i128(BigInt(Math.trunc(body.latMicro ?? 0)));
  w.i128(BigInt(Math.trunc(body.lonMicro ?? 0)));
  w.u128(body.price ?? 0n);
  w.string(body.to ?? '');
  w.u128(body.usdValueAtPurchase ?? 0n);
  return w.finish();
}

/** Canonical, content-addressed parcel identity. */
export function computeParcelId(body: Pick<LandBody, 'divisionId' | 'level' | 'subId' | 'plotIndex'>): string {
  const digest = domainHash(
    DOMAIN_LAND,
    new TextEncoder().encode(
      `PARCEL|${normaliseDivisionId(body.divisionId)}|${body.level}|${body.subId}|${body.plotIndex.toString()}`,
    ),
  );
  return encodePayload(ID_HRP, digest.slice(0, 20), 0x2bc830a3 /* bech32m */);
}

const DOMAIN_LAND = 'OBSIDIAN:LAND_PARCEL:v1';

function ensureDivision(ctx: ExecutorContext, divisionId: string, countryCode: string): void {
  const id = normaliseDivisionId(divisionId);
  if (ctx.state.s.divisions.has(id)) return;
  const seed = divisionSeed(id, countryCode);
  ctx.state.s.divisions.set(id, {
    divisionId: id,
    countryCode,
    glvSeals: seed.glvSeals,
    protocolPurchases: 0,
    protocolBuybacks: 0,
    lastUpdatedAtHeight: ctx.apply.height,
  });
}

/** Public helper used by the RPC layer and tests. */
export function parcelOfficialValue(
  parcel: ParcelRecord,
  divisionGlv: bigint,
  divisionPurchases: number,
): bigint {
  const entry = parcel.glvEntryCount ?? 0;
  return entry < divisionPurchases ? divisionGlv : parcel.glvSeals;
}

function validateDescriptor(body: LandBody, net: { name: string }): void {
  const divisionId = normaliseDivisionId(body.divisionId);
  if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(divisionId)) {
    reject(ErrCode.PARCEL_NOT_FOUND, `divisionId "${body.divisionId}" is not a valid administrative division id`);
  }
  if (!/^[A-Z]{2}$/.test(body.countryCode)) {
    reject(ErrCode.PARCEL_NOT_FOUND, 'countryCode must be an ISO 3166-1 alpha-2 code');
  }
  if (!divisionId.startsWith(body.countryCode)) {
    reject(ErrCode.PARCEL_NOT_FOUND, 'divisionId does not belong to the declared countryCode');
  }
  // `DIVISION_LEVEL_CODES` maps level NAMES to numbers, so membership must be
  // tested against its values — testing `body.level in DIVISION_LEVEL_CODES`
  // would compare a number against the name keys and reject every parcel.
  if (!(Object.values(DIVISION_LEVEL_CODES) as number[]).includes(body.level)) {
    reject(ErrCode.PARCEL_NOT_FOUND, `unknown administrative level ${body.level} on ${net.name}`);
  }
  if (body.level !== DIVISION_LEVEL_CODES.DIVISION && !body.subId) {
    reject(ErrCode.PARCEL_NOT_FOUND, 'a sub-division id is required below division level');
  }
  if (body.subId.length > 64) reject(ErrCode.PARCEL_NOT_FOUND, 'sub-division id is too long');
  if (body.latMicro !== undefined && (body.latMicro < -90_000_000 || body.latMicro > 90_000_000)) {
    reject(ErrCode.PARCEL_NOT_FOUND, 'latitude out of range');
  }
  if (body.lonMicro !== undefined && (body.lonMicro < -180_000_000 || body.lonMicro > 180_000_000)) {
    reject(ErrCode.PARCEL_NOT_FOUND, 'longitude out of range');
  }
}

export function executeLand(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeLandBody(tx.body);
  validateDescriptor(body, net);
  const treasury = treasuryWallet(state);
  const parcelId = computeParcelId(body);
  const divisionId = normaliseDivisionId(body.divisionId);
  const existing = state.s.parcels.get(parcelId);
  const division = state.s.divisions.get(divisionId);

  switch (body.op) {
    case LandOp.PROTOCOL_BUY: {
      if (existing) {
        reject(ErrCode.PARCEL_OWNED, 'that parcel is already owned; acquire it on the marketplace instead');
      }
      ensureDivision(ctx, divisionId, body.countryCode);
      const record = state.s.divisions.get(divisionId)!;
      const glvAtPurchase = record.glvSeals;
      // GLV is denominated in OBS: the parcel price is the GLV itself.
      const priceObs = glvAtPurchase;
      // The client must quote the official price it was shown. A stale or
      // tampered quote is rejected instead of silently charging another amount.
      if (body.price !== priceObs) {
        reject(ErrCode.PRICE_MISMATCH, 'the quoted price does not match the official GLV price', {
          expected: priceObs.toString(),
          received: (body.price ?? 0n).toString(),
          glvSeals: glvAtPurchase.toString(),
        });
      }
      const gas = assertGas(tx.gas, priceObs);
      state.debit(tx.sender, priceObs + gas, apply, 'protocol land purchase + gas');
      if (gas > 0n) {
        state.poolInflow(gas, 'land gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      // Protocol land issuance is qualifying platform revenue: the protocol is
      // the seller. Split 40/60 like every other platform sale. A user-to-user
      // marketplace sale is NOT revenue and never reaches this path.
      state.creditPlatformRevenue(RevenueSource.LAND_PROTOCOL_SALE, priceObs, apply, `protocol land issuance ${parcelId}`);

      const parcel: ParcelRecord = {
        parcelId,
        divisionId,
        countryCode: body.countryCode,
        districtId: body.level >= DIVISION_LEVEL_CODES.DISTRICT ? body.subId : undefined,
        streetId: body.level === DIVISION_LEVEL_CODES.STREET ? body.subId : undefined,
        cityId: body.level === DIVISION_LEVEL_CODES.CITY ? body.subId : undefined,
        latMicro: body.latMicro,
        lonMicro: body.lonMicro,
        squareMetres: CONSENSUS_PARAMS.circle.parcelSquareMetres,
        owner: tx.sender,
        glvSeals: glvAtPurchase,
        status: 'OWNED',
        acquiredAtHeight: apply.height,
        issuedAtHeight: apply.height,
        transferCount: 0,
        glvUpdatedAtHeight: apply.height,
        glvEntryCount: record.protocolPurchases,
        plotIndex: bigintToSafeNumber(body.plotIndex),
        level: body.level,
        subId: body.subId,
      };
      state.s.parcels.set(parcelId, parcel);
      state.s.metrics.totalParcelsIssued += 1;

      // Appreciation: existing eligible owners benefit from this purchase. The
      // buyer's own parcel starts at its purchase value and only begins tracking
      // the division GLV after a LATER purchase (spec §52).
      const step = applyBasisPoints(record.glvSeals, CONSENSUS_PARAMS.circle.appreciationStepBps);
      const raised = record.glvSeals + (step > 0n ? step : 1n);
      record.glvSeals = raised > CONSENSUS_PARAMS.circle.maxGlv ? CONSENSUS_PARAMS.circle.maxGlv : raised;
      record.protocolPurchases += 1;
      record.lastUpdatedAtHeight = apply.height;

      state.emit('LAND_PROTOCOL_PURCHASE', {
        parcelId,
        buyer: tx.sender,
        divisionId,
        priceObs: priceObs.toString(),
        glvAtPurchase: glvAtPurchase.toString(),
        glvAfter: record.glvSeals.toString(),
        purchaseIndex: record.protocolPurchases,
        treasury: treasury || null,
      }, apply);
      return {
        gasBase: priceObs,
        detail: {
          parcelId,
          priceObs: priceObs.toString(),
          glvAtPurchase: glvAtPurchase.toString(),
          glvAfter: record.glvSeals.toString(),
          purchaseIndex: record.protocolPurchases,
        },
      };
    }

    case LandOp.PROTOCOL_SELL: {
      if (!existing) reject(ErrCode.PARCEL_NOT_FOUND, 'that parcel does not exist');
      if (existing.owner !== tx.sender) reject(ErrCode.PARCEL_NOT_OWNED, 'only the owner may sell to the protocol');
      if (!treasury) reject(ErrCode.ORACLE_UNAVAILABLE, 'protocol buyback requires an on-chain treasury designation');
      if (!division) reject(ErrCode.PARCEL_NOT_FOUND, 'division record missing for that parcel');
      const officialValue = parcelOfficialValue(existing, division.glvSeals, division.protocolPurchases);
      // Buybacks pay the current official value, already in OBS.
      const payout = officialValue;
      const treasuryAccount = state.getAccount(treasury);
      if (!treasuryAccount || treasuryAccount.balance < payout) {
        reject(ErrCode.INSUFFICIENT_FUNDS, 'the protocol land reserve cannot fund this buyback');
      }
      assertGas(tx.gas, 0n);
      state.debit(treasury, payout, apply, 'protocol land buyback payout');
      state.credit(tx.sender, payout, apply, 'protocol land buyback received');

      const drop = applyBasisPoints(division.glvSeals, CONSENSUS_PARAMS.circle.depreciationStepBps);
      const lowered = division.glvSeals - drop;
      division.glvSeals = lowered < CONSENSUS_PARAMS.circle.minGlv ? CONSENSUS_PARAMS.circle.minGlv : lowered;
      division.protocolBuybacks += 1;
      division.lastUpdatedAtHeight = apply.height;
      state.s.parcels.delete(parcelId);

      state.emit('LAND_PROTOCOL_BUYBACK', {
        parcelId,
        seller: tx.sender,
        divisionId,
        payoutObs: payout.toString(),
        glvAfter: division.glvSeals.toString(),
      }, apply);
      return { gasBase: 0n, detail: { parcelId, payoutObs: payout.toString(), glvAfter: division.glvSeals.toString() } };
    }

    case LandOp.LIST: {
      if (!existing) reject(ErrCode.PARCEL_NOT_FOUND, 'that parcel does not exist');
      if (existing.owner !== tx.sender) reject(ErrCode.PARCEL_NOT_OWNED, 'only the owner may list a parcel');
      assertAmount(body.price ?? 0n, { label: 'MSP price' });
      assertGas(tx.gas, 0n);
      existing.mspObs = body.price!;
      existing.status = 'LISTED';
      state.emit('LAND_LISTED', { parcelId, seller: tx.sender, mspObs: body.price!.toString() }, apply);
      return { gasBase: 0n, detail: { parcelId, mspObs: body.price!.toString(), note: 'MSP does not change GLV' } };
    }

    case LandOp.DELIST: {
      if (!existing) reject(ErrCode.PARCEL_NOT_FOUND, 'that parcel does not exist');
      if (existing.owner !== tx.sender) reject(ErrCode.PARCEL_NOT_OWNED, 'only the owner may delist a parcel');
      assertGas(tx.gas, 0n);
      delete existing.mspObs;
      existing.status = 'OWNED';
      state.emit('LAND_DELISTED', { parcelId, seller: tx.sender }, apply);
      return { gasBase: 0n, detail: { parcelId } };
    }

    case LandOp.BUY_LISTED: {
      if (!existing) reject(ErrCode.PARCEL_NOT_FOUND, 'that parcel does not exist');
      if (existing.status !== 'LISTED' || !existing.mspObs) reject(ErrCode.PARCEL_NOT_LISTED, 'that parcel is not listed');
      const seller = existing.owner;
      if (seller === tx.sender) reject(ErrCode.PARCEL_OWNED, 'the seller cannot buy their own listing');
      if (!body.price) reject(ErrCode.MALFORMED, 'the accepted price is required');
      if (body.price !== existing.mspObs) {
        reject(ErrCode.PRICE_MISMATCH, "the accepted price does not match the seller's MSP", {
          expected: existing.mspObs.toString(),
          received: body.price.toString(),
        });
      }
      const gas = assertGas(tx.gas, body.price);
      state.debit(tx.sender, body.price + gas, apply, 'marketplace purchase + gas');
      state.credit(seller, body.price, apply, 'marketplace proceeds (100% to seller, no platform cut)');
      if (gas > 0n) {
        state.poolInflow(gas, 'marketplace gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      const record = existing;
      record.owner = tx.sender;
      record.status = 'OWNED';
      delete record.mspObs;
      record.transferCount += 1;
      record.acquiredAtHeight = apply.height;
      // ILV (individual land value) is simply what the parcel last traded for, in OBS.
      record.ilvSeals = body.price;
      if (division) {
        record.glvEntryCount = division.protocolPurchases;
        record.glvSeals = parcelOfficialValue(record, division.glvSeals, division.protocolPurchases);
      }
      state.emit('LAND_TRADED', {
        parcelId,
        seller,
        buyer: tx.sender,
        priceObs: body.price.toString(),
        ilvObs: record.ilvSeals.toString(),
        glvChanged: false,
      }, apply);
      return { gasBase: body.price, detail: { parcelId, priceObs: body.price.toString(), glvChanged: false } };
    }

    case LandOp.GIFT: {
      if (!existing) reject(ErrCode.PARCEL_NOT_FOUND, 'that parcel does not exist');
      if (existing.owner !== tx.sender) reject(ErrCode.PARCEL_NOT_OWNED, 'only the owner may transfer a parcel');
      if (!body.to) reject(ErrCode.MALFORMED, 'a recipient address is required');
      assertAddress(body.to, net, 'recipient');
      state.touchAccount(body.to, apply);
      const officialValue = division
        ? parcelOfficialValue(existing, division.glvSeals, division.protocolPurchases)
        : existing.glvSeals;
      const gasBase = officialValue;
      const gas = assertGas(tx.gas, gasBase);
      if (gas > 0n) {
        state.debit(tx.sender, gas, apply, 'land transfer gas');
        state.poolInflow(gas, 'land gift gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      existing.owner = body.to;
      existing.transferCount += 1;
      existing.acquiredAtHeight = apply.height;
      existing.status = existing.mspObs ? 'LISTED' : 'OWNED';
      state.emit('LAND_GIFTED', { parcelId, from: tx.sender, to: body.to, gas: gas.toString() }, apply);
      return { gasBase, detail: { parcelId, to: body.to, gas: gas.toString() } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported land operation ${body.op}`);
  }
}

function bigintToSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    reject(ErrCode.PARCEL_NOT_FOUND, 'plot index is out of range');
  }
  return Number(value);
}
