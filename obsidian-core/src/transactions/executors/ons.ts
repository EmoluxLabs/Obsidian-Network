/**
 * ONS — Obsidian Name Service (spec §39).
 *
 * A `.obs` name maps to exactly one wallet address at a time and the mapping is
 * blockchain state, not a database row. Names are priced in OBS by a consensus
 * parameter (a flat 0.05 OBS to register or renew); the fee is protocol revenue
 * and is remitted to the designated treasury wallet on-chain (it cannot be
 * minted, and the treasury cannot change except by the protocol rule).
 *
 * Registration is a commitment: anyone may register an available name, and
 * ownership can be transferred or sold according to protocol rules.
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
import { assertAddress, assertAmount, assertGas } from '../helpers.js';
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
      // Qualifying platform revenue: 40% to the Node Runner Reward Pool, 60% to
      // the treasury. Before a treasury wallet is designated the treasury share
      // is recorded as unclaimed and held by the pool — never destroyed and
      // never silently reassigned.
      state.creditPlatformRevenue(RevenueSource.ONS_REGISTRATION, body.fee, apply, `ONS registration ${name}`);
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
      const record = state.s.names.get(name);
      if (!record) reject(ErrCode.NOT_FOUND, `"${name}.obs" is not registered`);
      if (record.owner !== tx.sender) reject(ErrCode.NAME_NOT_OWNED, 'only the owner may transfer a name');
      if (!body.to) reject(ErrCode.MALFORMED, 'a recipient address is required');
      assertAddress(body.to, net, 'recipient');
      assertGas(tx.gas, 0n);
      state.touchAccount(body.to, apply);
      const previous = record.address;
      record.owner = body.to;
      // The mapping is chain state and travels with the name: a transferred name
      // resolves to the new owner's wallet, never back to the seller's.
      record.address = body.to;
      record.transferCount += 1;
      state.emit('ONS_TRANSFERRED', { name, from: tx.sender, to: body.to, previousAddress: previous }, apply);
      return { gasBase: 0n, detail: { name, owner: body.to } };
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
      state.creditPlatformRevenue(RevenueSource.ONS_RENEWAL, body.fee, apply, `ONS renewal ${name}`);
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
