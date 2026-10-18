/**
 * ONS owner actions: who may do what to a name, and what is refused before a passphrase is asked for.
 *
 * Pure functions, no DOM and no network. Consensus makes every one of these checks again when a transaction is included
 * (`transactions/executors/ons.ts`); these exist so a person is told the reason in words, early, and is never asked to sign
 * something the chain is certain to refuse. The chain is the authority; a stale screen can never authorise anything.
 */

import { canonicalAddressText, isValidAddress } from '../../core/crypto/keys.js';

export interface OwnerNameRecord {
  name: string;
  owner: string;
  address?: string;
  expiresAt?: number;
  marketStatus?: 'OWNED' | 'LISTED' | 'EXPIRED';
  locked?: boolean;
  listing?: unknown;
  pendingTransfer?: { to: string; offeredAt?: number; offerExpiresAt?: number } | null;
  recoveryAddress?: string | null;
  pendingRecovery?: { by: string; newAddress: string; startedAt?: number; effectiveAt?: number } | null;
}

/** A wallet address for this network, never an email, never a name. Returns the reason in words, or null when it is fine. */
export function addressProblem(raw: string, hrp: string | undefined, what = 'the address'): string | null {
  const text = raw.trim();
  if (!text) return `Enter ${what}.`;
  if (text.includes('@')) return `${what[0].toUpperCase()}${what.slice(1)} must be a wallet address, not an email address.`;
  if (/\.obs$/i.test(text)) return `${what[0].toUpperCase()}${what.slice(1)} must be a wallet address; a .obs name is not accepted here.`;
  if (hrp && !isValidAddress(canonicalAddressText(text), hrp)) return `${what[0].toUpperCase()}${what.slice(1)} is not a valid ${hrp}1… wallet address for this network.`;
  return null;
}

export const addressOf = (raw: string): string => canonicalAddressText(raw.trim());

export interface OwnerRoles {
  isOwner: boolean;
  /** A listing locks the name: consensus refuses change of address, offer, recovery changes and recovery completion. */
  locked: boolean;
  expired: boolean;
  /** An offer that has not lapsed. */
  offerOpen: boolean;
  /** An open offer that names this wallet. */
  offeredToMe: boolean;
  offerLapsedForMe: boolean;
  /** This wallet is the recovery address and no recovery is in flight. */
  canStartRecovery: boolean;
  recoveryInFlight: boolean;
  /** This wallet may complete the recovery in flight (the recovery address or the new owner). */
  inRecovery: boolean;
  /** Seconds until the recovery delay has passed (0 = ready); null when no recovery is in flight. */
  recoveryWaitSeconds: number | null;
  /** True when the wallet has any part in this name. */
  involved: boolean;
}

export function ownerRoles(record: OwnerNameRecord, me: string | undefined, now: number): OwnerRoles {
  const isOwner = Boolean(me) && record.owner === me;
  const locked = Boolean(record.locked) || record.marketStatus === 'LISTED' || Boolean(record.listing);
  const expired = record.marketStatus === 'EXPIRED' || (record.expiresAt !== undefined && record.expiresAt < now);
  const transfer = record.pendingTransfer ?? null;
  const lapse = transfer?.offerExpiresAt === undefined ? Number.POSITIVE_INFINITY : Number(transfer.offerExpiresAt);
  const offerOpen = Boolean(transfer) && lapse >= now;
  const offeredToMe = Boolean(me) && offerOpen && transfer?.to === me;
  const offerLapsedForMe = Boolean(me) && Boolean(transfer) && !offerOpen && transfer?.to === me;
  const recovery = record.pendingRecovery ?? null;
  const isRecoveryAddress = Boolean(me) && record.recoveryAddress === me;
  const inRecovery = Boolean(me) && Boolean(recovery) && (recovery?.by === me || recovery?.newAddress === me);
  const wait = recovery ? Math.max(0, Number(recovery.effectiveAt ?? 0) - now) : null;
  return {
    isOwner,
    locked,
    expired,
    offerOpen,
    offeredToMe,
    offerLapsedForMe,
    canStartRecovery: isRecoveryAddress && !recovery,
    recoveryInFlight: Boolean(recovery),
    inRecovery,
    recoveryWaitSeconds: wait,
    involved: isOwner || offeredToMe || offerLapsedForMe || isRecoveryAddress || inRecovery,
  };
}

/** What the chain compares a review against: if any of this changed, the review is stale and nothing is signed. */
export function ownerSnapshot(record: OwnerNameRecord | null | undefined): string {
  return JSON.stringify({
    owner: record?.owner ?? null,
    address: record?.address ?? null,
    transfer: record?.pendingTransfer ? [record.pendingTransfer.to, record.pendingTransfer.offerExpiresAt ?? null] : null,
    recoveryAddress: record?.recoveryAddress ?? null,
    recovery: record?.pendingRecovery ? [record.pendingRecovery.by, record.pendingRecovery.newAddress, record.pendingRecovery.effectiveAt ?? null] : null,
    locked: Boolean(record?.locked) || record?.marketStatus === 'LISTED',
  });
}

export type OwnerKind =
  | 'update'
  | 'transfer'
  | 'withdraw'
  | 'accept'
  | 'recoverySet'
  | 'recoveryClear'
  | 'recoveryStart'
  | 'recoveryCancel'
  | 'recoveryFinalize';

/** The refusal for an address typed into an owner action, including the rules that depend on the name's current record. */
export function targetProblem(kind: OwnerKind, raw: string, hrp: string | undefined, record: OwnerNameRecord, now: number): string | null {
  const what = kind === 'transfer' ? 'the recipient' : kind === 'recoverySet' ? 'the recovery address' : kind === 'recoveryStart' ? 'the new owner' : 'the new address';
  const bad = addressProblem(raw, hrp, what);
  if (bad) return bad;
  const target = addressOf(raw);
  if (kind === 'transfer') {
    if (target === record.owner) return 'The recipient already owns this name.';
    if (ownerRoles(record, record.owner, now).offerOpen) return 'An offer is already open on this name: withdraw it first.';
  }
  if (kind === 'recoverySet') {
    if (record.pendingRecovery) return 'A recovery is in flight: cancel it before changing the recovery address.';
    if (target === record.owner) return 'The recovery address must be a different wallet from the owner.';
  }
  if (kind === 'recoveryStart' && target === record.owner) return 'The new owner is already the owner.';
  return null;
}
