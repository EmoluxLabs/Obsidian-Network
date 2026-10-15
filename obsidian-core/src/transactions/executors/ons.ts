/**
 * ONS — Obsidian Name Service (spec §39).
 *
 * A `.obs` name maps to exactly one wallet address at a time and the mapping is
 * blockchain state, not a database row. Names are priced in OBS by a consensus
 * parameter (a flat 0.05 OBS to register or renew); the fee is protocol revenue
 * and is remitted to the designated treasury wallet on-chain (it cannot be
 * minted, and the treasury cannot change except by the protocol rule).
 *
 * Registration is a commitment: anyone may register an available name.
 *
 * OWNERSHIP (protocol 1.9.0)
 *   A name never changes hands because its owner said so. The owner OFFERS it to one recipient (TRANSFER); the
 *   recipient ACCEPTS from its own key (ACCEPT_TRANSFER) before the offer lapses, or the owner CANCELS it. Accepting
 *   moves ownership, the resolved address and the remaining term in one step: the expiry travels with the name and
 *   the new owner is the only one who can renew it. A transfer to a mistyped address therefore costs nothing — it is
 *   an offer nobody accepts.
 *
 *   The address a name RESOLVES to (UPDATE_ADDRESS) is separate from who OWNS it, and separate from any node reward
 *   wallet: editing it needs the owner's signature and touches nothing else.
 *
 * RECOVERY (delayed, cancellable, credential-based)
 *   The owner may name a RECOVERY ADDRESS (SET_RECOVERY). That address can START a recovery to a new owner address;
 *   it takes effect only after `recoveryDelaySeconds` (seven days) and only if the current owner has not cancelled it
 *   (CANCEL_RECOVERY) in the meantime. The recovery address has no other power: it cannot transfer, renew or edit.
 *   Completing or accepting a change of owner wipes the old owner's recovery address and any open offer, so a new
 *   owner never inherits the previous owner's recovery path.
 *
 *   LIMITS, plainly: if the owner key is stolen, the thief is the owner and can cancel a recovery, clear the recovery
 *   address and keep the name. If the owner key is lost and no recovery address was set (or its key is lost too),
 *   the name cannot be recovered by anyone — there is no administrator and no override. See docs/ons.md.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import {
  OnsOp,
  type OnsBody,
  type OnsRecord,
  type TxEnvelope,
} from '../../protocol/types.js';
import { assertAddress, assertAmount, assertCanonicalAddress, assertGas } from '../helpers.js';
import { RevenueSource } from '../../economy/accounting.js';
import type { ExecutorContext } from '../types.js';

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function decodeOnsBody(body: Uint8Array): OnsBody {
  const r = new Reader(body);
  const op = r.u8() as OnsOp;
  const name = r.string();
  const address = r.string();
  const to = r.string();
  const fee = r.u128();
  r.ensureConsumed();
  return {
    op,
    name,
    address: address.length ? address : undefined,
    to: to.length ? to : undefined,
    fee,
  };
}

export function encodeOnsBody(body: OnsBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(body.name);
  w.string(body.address ?? '');
  w.string(body.to ?? '');
  w.u128(body.fee);
  return w.finish();
}

export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.obs$/, '');
}

export function validateNameFormat(name: string): void {
  if (name.length < CONSENSUS_PARAMS.ons.minLength || name.length > CONSENSUS_PARAMS.ons.maxLength) {
    reject(ErrCode.NAME_INVALID, `name must be ${CONSENSUS_PARAMS.ons.minLength}-${CONSENSUS_PARAMS.ons.maxLength} characters`);
  }
  if (!NAME_PATTERN.test(name)) {
    reject(ErrCode.NAME_INVALID, 'name may contain only a-z, 0-9 and interior hyphens');
  }
  if (name.includes('--')) reject(ErrCode.NAME_INVALID, 'consecutive hyphens are not permitted');
  if ((CONSENSUS_PARAMS.ons.reserved as readonly string[]).includes(name)) {
    reject(ErrCode.NAME_RESERVED, `"${name}.obs" is reserved by the protocol`);
  }
}

/**
 * The protocol fee for a name, in seals.
 *
 * Fees are denominated in OBS, so this is a constant lookup: no oracle, no
 * staleness window, no way for an absent price feed to make registration
 * impossible. The signature keeps `state`/`protocolTime` so callers and future
 * term-dependent pricing need not change shape.
 */
export function requiredFeeSeals(
  _state: ExecutorContext['state'],
  _protocolTime: number,
  feeSeals: bigint,
): bigint {
  return feeSeals;
}

function requireLiveName(state: ExecutorContext['state'], name: string, protocolTime: number): OnsRecord {
  const record = state.s.names.get(name);
  if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
  if (record.expiresAt <= protocolTime) {
    reject(ErrCode.NAME_TAKEN, `"${name}.obs" has expired: renew it before changing hands`);
  }
  return record;
}

/** The single place where ownership of a name changes. Everything tied to the old owner is cleared. */
function changeOwner(record: OnsRecord, owner: string): void {
  record.owner = owner;
  record.address = owner;
  record.transferCount += 1;
  record.pendingTransfer = undefined;
  record.pendingRecovery = undefined;
  record.recoveryAddress = undefined;
}

/** Registration is never allowed to silently renew an existing name. */
export function executeOns(ctx: ExecutorContext, tx: TxEnvelope): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeOnsBody(tx.body);
  const name = normalizeName(body.name);
  const protocolTime = apply.timestamp;

  switch (body.op) {
    case OnsOp.REGISTER: {
      validateNameFormat(name);
      const existing = state.s.names.get(name);
      if (existing && existing.expiresAt > protocolTime) {
        reject(ErrCode.NAME_TAKEN, `"${name}.obs" is already registered until ${existing.expiresAt}`);
      }
      const fee = requiredFeeSeals(state, protocolTime, CONSENSUS_PARAMS.ons.registrationFee);
      assertAmount(body.fee, { label: 'fee' });
      if (body.fee < fee) {
        reject(ErrCode.INSUFFICIENT_FUNDS, `offered fee ${body.fee} is below the protocol fee ${fee}`, {
          required: fee.toString(),
        });
      }
      const gas = assertGas(tx.gas, body.fee);
      state.debit(tx.sender, body.fee + gas, apply, 'ONS registration fee + gas');
      if (gas > 0n) {
        state.poolInflow(gas, 'ONS gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      // ONS is the only protocol-revenue source. Its exact 90% / 10%
      // split is applied in integer base units by the shared accounting path.
      // Before a treasury wallet is designated, the 10% share remains visible
      // as an amount owed to the eventual first valid miner.
      state.creditOnsRevenue(RevenueSource.ONS_REGISTRATION, body.fee, apply, `ONS registration ${name}`);
      const record: OnsRecord = {
        name,
        owner: tx.sender,
        address: tx.sender,
        registeredAtHeight: apply.height,
        registeredAt: protocolTime,
        expiresAt: protocolTime + CONSENSUS_PARAMS.ons.termSeconds,
        transferCount: 0,
      };
      state.s.names.set(name, record);
      state.s.metrics.totalNamesRegistered += 1;
      state.emit('ONS_REGISTERED', {
        name,
        owner: tx.sender,
        address: record.address,
        expiresAt: record.expiresAt,
        fee: body.fee.toString(),
      }, apply);
      return { gasBase: body.fee, detail: { name, address: record.address, expiresAt: record.expiresAt } };
    }

    case OnsOp.UPDATE_ADDRESS: {
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may update a name');
      if (!body.address) reject(ErrCode.MALFORMED, 'a target address is required');
      assertAddress(body.address, net, 'target address');
      assertGas(tx.gas, 0n);
      record.address = body.address;
      state.emit('ONS_ADDRESS_UPDATED', { name, owner: tx.sender, address: body.address }, apply);
      return { gasBase: 0n, detail: { name, address: body.address } };
    }

    case OnsOp.TRANSFER: {
      const record = requireLiveName(state, name, protocolTime);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may offer a name');
      if (!body.to) reject(ErrCode.MALFORMED, 'a recipient address is required');
      assertCanonicalAddress(body.to, net, 'recipient');
      if (body.to === record.owner) reject(ErrCode.MALFORMED, 'the recipient already owns this name');
      if (record.pendingTransfer && record.pendingTransfer.offerExpiresAt >= protocolTime) {
        reject(ErrCode.NAME_TRANSFER_STATE, `an offer to ${record.pendingTransfer.to} is already open: cancel it first`);
      }
      assertGas(tx.gas, 0n);
      record.pendingTransfer = {
        to: body.to,
        offeredAt: protocolTime,
        offerExpiresAt: protocolTime + CONSENSUS_PARAMS.ons.transferOfferSeconds,
      };
      state.emit('ONS_TRANSFER_OFFERED', {
        name,
        from: tx.sender,
        to: body.to,
        offerExpiresAt: record.pendingTransfer.offerExpiresAt,
      }, apply);
      return { gasBase: 0n, detail: { name, offeredTo: body.to, offerExpiresAt: record.pendingTransfer.offerExpiresAt } };
    }

    case OnsOp.ACCEPT_TRANSFER: {
      const record = requireLiveName(state, name, protocolTime);
      const offer = record.pendingTransfer;
      if (!offer) reject(ErrCode.NAME_TRANSFER_STATE, `"${name}.obs" has no open transfer offer`);
      if (offer.to !== tx.sender) reject(ErrCode.UNAUTHORIZED, 'only the address the name was offered to may accept it');
      if (offer.offerExpiresAt < protocolTime) {
        reject(ErrCode.NAME_TRANSFER_STATE, 'the transfer offer has lapsed');
      }
      assertGas(tx.gas, 0n);
      const previousOwner = record.owner;
      // Ownership, resolution and the remaining term move together. The seller's recovery address and any recovery
      // in flight are wiped: the buyer must never inherit them.
      changeOwner(record, tx.sender);
      state.touchAccount(tx.sender, apply);
      state.emit('ONS_TRANSFERRED', { name, from: previousOwner, to: tx.sender, expiresAt: record.expiresAt }, apply);
      return { gasBase: 0n, detail: { name, owner: tx.sender } };
    }

    case OnsOp.CANCEL_TRANSFER: {
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may cancel an offer');
      if (!record.pendingTransfer) reject(ErrCode.NAME_TRANSFER_STATE, `"${name}.obs" has no open transfer offer`);
      assertGas(tx.gas, 0n);
      const cancelled = record.pendingTransfer.to;
      record.pendingTransfer = undefined;
      state.emit('ONS_TRANSFER_CANCELLED', { name, owner: tx.sender, to: cancelled }, apply);
      return { gasBase: 0n, detail: { name, cancelledOffer: cancelled } };
    }

    case OnsOp.SET_RECOVERY: {
      const record = requireLiveName(state, name, protocolTime);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may set the recovery address');
      if (record.pendingRecovery) {
        reject(ErrCode.NAME_RECOVERY_STATE, 'a recovery is in flight: cancel it before changing the recovery address');
      }
      assertGas(tx.gas, 0n);
      if (!body.address) {
        record.recoveryAddress = undefined;
        state.emit('ONS_RECOVERY_CLEARED', { name, owner: tx.sender }, apply);
        return { gasBase: 0n, detail: { name, recoveryAddress: null } };
      }
      assertCanonicalAddress(body.address, net, 'recovery address');
      if (body.address === record.owner) reject(ErrCode.MALFORMED, 'the recovery address must differ from the owner');
      record.recoveryAddress = body.address;
      state.emit('ONS_RECOVERY_SET', { name, owner: tx.sender, recoveryAddress: body.address }, apply);
      return { gasBase: 0n, detail: { name, recoveryAddress: body.address } };
    }

    case OnsOp.START_RECOVERY: {
      const record = requireLiveName(state, name, protocolTime);
      if (!record.recoveryAddress) reject(ErrCode.NAME_RECOVERY_STATE, `"${name}.obs" has no recovery address`);
      if (tx.sender !== record.recoveryAddress) {
        reject(ErrCode.UNAUTHORIZED, 'only the recovery address may start a recovery');
      }
      if (record.pendingRecovery) reject(ErrCode.NAME_RECOVERY_STATE, 'a recovery is already in flight');
      if (!body.address) reject(ErrCode.MALFORMED, 'the new owner address is required');
      assertCanonicalAddress(body.address, net, 'new owner address');
      if (body.address === record.owner) reject(ErrCode.MALFORMED, 'the new owner is already the owner');
      assertGas(tx.gas, 0n);
      record.pendingRecovery = {
        by: tx.sender,
        newAddress: body.address,
        startedAt: protocolTime,
        effectiveAt: protocolTime + CONSENSUS_PARAMS.ons.recoveryDelaySeconds,
      };
      state.emit('ONS_RECOVERY_STARTED', {
        name,
        owner: record.owner,
        newOwner: body.address,
        effectiveAt: record.pendingRecovery.effectiveAt,
      }, apply);
      return { gasBase: 0n, detail: { name, newOwner: body.address, effectiveAt: record.pendingRecovery.effectiveAt } };
    }

    case OnsOp.CANCEL_RECOVERY: {
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the current owner may cancel a recovery');
      if (!record.pendingRecovery) reject(ErrCode.NAME_RECOVERY_STATE, `"${name}.obs" has no recovery in flight`);
      assertGas(tx.gas, 0n);
      const cancelled = record.pendingRecovery;
      record.pendingRecovery = undefined;
      state.emit('ONS_RECOVERY_CANCELLED', { name, owner: tx.sender, newOwner: cancelled.newAddress }, apply);
      return { gasBase: 0n, detail: { name, cancelledRecoveryTo: cancelled.newAddress } };
    }

    case OnsOp.FINALIZE_RECOVERY: {
      const record = requireLiveName(state, name, protocolTime);
      const recovery = record.pendingRecovery;
      if (!recovery) reject(ErrCode.NAME_RECOVERY_STATE, `"${name}.obs" has no recovery in flight`);
      if (tx.sender !== recovery.by && tx.sender !== recovery.newAddress) {
        reject(ErrCode.UNAUTHORIZED, 'only the recovery address or the new owner may complete a recovery');
      }
      if (protocolTime < recovery.effectiveAt) {
        reject(ErrCode.NAME_RECOVERY_STATE, `the recovery delay has not passed: it takes effect at ${recovery.effectiveAt}`);
      }
      assertGas(tx.gas, 0n);
      const previousOwner = record.owner;
      changeOwner(record, recovery.newAddress);
      state.touchAccount(record.owner, apply);
      state.emit('ONS_RECOVERED', { name, from: previousOwner, to: record.owner, expiresAt: record.expiresAt }, apply);
      return { gasBase: 0n, detail: { name, owner: record.owner } };
    }

    case OnsOp.RENEW: {
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may renew a name');
      const fee = requiredFeeSeals(state, protocolTime, CONSENSUS_PARAMS.ons.renewalFee);
      assertAmount(body.fee, { label: 'fee' });
      if (body.fee < fee) {
        reject(ErrCode.INSUFFICIENT_FUNDS, `offered fee ${body.fee} is below the protocol renewal fee ${fee}`);
      }
      const gas = assertGas(tx.gas, body.fee);
      state.debit(tx.sender, body.fee + gas, apply, 'ONS renewal fee + gas');
      if (gas > 0n) {
        state.poolInflow(gas, 'ONS gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      state.creditOnsRevenue(RevenueSource.ONS_RENEWAL, body.fee, apply, `ONS renewal ${name}`);
      const base = record.expiresAt > protocolTime ? record.expiresAt : protocolTime;
      record.expiresAt = base + CONSENSUS_PARAMS.ons.termSeconds;
      state.emit('ONS_RENEWED', { name, owner: tx.sender, expiresAt: record.expiresAt }, apply);
      return { gasBase: body.fee, detail: { name, expiresAt: record.expiresAt } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported ONS operation ${body.op}`);
  }
}

/**
 * Expire names whose term has ended. Called once per block by the state
 * machine: deterministic, height-derived, and never driven by an external
 * scheduler. Expired names return to the pool for re-registration.
 */
export function processNameExpiry(ctx: ExecutorContext): void {
  const { state, apply } = ctx;
  const grace = CONSENSUS_PARAMS.ons.graceSeconds;
  for (const [name, record] of [...state.s.names.entries()]) {
    if (record.expiresAt + grace < apply.timestamp) {
      state.s.names.delete(name);
      state.emit('ONS_EXPIRED', { name, formerOwner: record.owner }, apply);
    }
  }
}
