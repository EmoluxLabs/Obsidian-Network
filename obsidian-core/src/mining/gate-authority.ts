/**
 * Mining gate authority: rotating and revoking the issuer keys, in consensus (protocol 1.8.0).
 *
 * WHY THIS EXISTS
 *   Through 1.7.0 the issuer set was fixed by the genesis id. A leaked or lost issuer key could only be handled by
 *   starting a new network. A key that can open the mining gate for anyone must be removable, and an operator must
 *   be able to replace one without restarting the chain.
 *
 * THE RULE (everything the chain checks, and nothing more)
 *   An update names the epoch it creates (current + 1), the keys to add and the keys to remove, and carries
 *   approvals: compact signatures, by keys of the CURRENT active set, over one fixed message. It applies when
 *     - epoch = current epoch + 1                (an update can be applied once, and in order)
 *     - approvals come from distinct current keys and are at least a strict majority: floor(n/2) + 1
 *     - every signature is valid                 (a bad one rejects the update; it is never skipped)
 *     - every key removed is active, every key added is a valid new key that is neither active nor ever revoked
 *     - the result has between 1 and `maxIssuers` keys, and the revoked list stays within `maxRevoked`
 *   Who submits it, and with which account, decides nothing: the transaction carries no gas and its sender is only
 *   the party that signed the envelope.
 *
 * WHAT THIS DOES AND DOES NOT PROTECT
 *   - With n >= 3 keys held by separate people or machines, one stolen key cannot change the set, and the other
 *     holders can revoke it. A stolen key still mints certificates until the update is included; certificates live
 *     15 minutes, so the exposure is bounded by how fast the holders act.
 *   - With a single key (n = 1), that key IS the majority: whoever holds it can replace it. It is valid, and it is
 *     the weakest setting. Run three or more.
 *   - If a majority of keys is lost, nobody can sign an update. The chain cannot recover itself from that: the way
 *     out is a new genesis. That is a property of any threshold scheme, stated here so it is never a surprise.
 *   - An update cannot empty the set (that would close mining for ever), cannot exceed the maximum, and cannot
 *     re-admit a revoked key.
 *
 * Certificates are checked against the ACTIVE set at the block that includes the claim, so a certificate signed by a
 * key before its revocation stops working as soon as the revoking update is in the chain, wherever the claim is.
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { Reader, Writer } from '../protocol/encoding.js';
import { DOMAIN } from '../protocol/domains.js';
import { ErrCode, ProtocolError, reject } from '../protocol/errors.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { GateAuthorityOp, type GateApproval, type GateAuthorityBody } from '../protocol/types.js';
import { signMessage, verifyMessage } from '../crypto/keys.js';
import { utf8 } from '../crypto/hash.js';

export interface GateAuthorityState {
  active: readonly string[];
  revoked: readonly string[];
  epoch: number;
}

export interface GateAuthorityContext {
  networkId: string;
  chainId: number;
}

export interface GateUpdateOutcome {
  active: string[];
  revoked: string[];
  epoch: number;
  added: string[];
  removed: string[];
  approvedBy: string[];
}

/** Strict majority of `n` keys. n = 0 has no majority: a chain with no issuer cannot be updated. */
export function gateQuorum(n: number): number {
  return n <= 0 ? Number.POSITIVE_INFINITY : Math.floor(n / 2) + 1;
}

const KEY_PATTERN = /^0[23][0-9a-f]{64}$/;

/** A lowercase compressed secp256k1 public key that is a real curve point, or a protocol rejection. */
export function normalizeGateKey(raw: unknown): string {
  if (typeof raw !== 'string') reject(ErrCode.GATE_AUTHORITY_INVALID, 'a gate key must be a string');
  const key = raw.trim().toLowerCase();
  if (!KEY_PATTERN.test(key)) reject(ErrCode.GATE_AUTHORITY_INVALID, 'gate keys must be lowercase compressed secp256k1 public keys');
  try {
    secp256k1.ProjectivePoint.fromHex(key).assertValidity();
  } catch {
    reject(ErrCode.GATE_AUTHORITY_INVALID, `gate key is not a valid secp256k1 point: ${key}`);
  }
  return key;
}

/** The exact bytes every approver signs. Lists are sorted so the same change has one message. */
export function gateUpdateMessage(ctx: GateAuthorityContext, epoch: number, add: readonly string[], remove: readonly string[]): Uint8Array {
  return utf8(`GATEUPDATE|${ctx.networkId}|${ctx.chainId}|${epoch}|${[...add].sort().join(',')}|${[...remove].sort().join(',')}`);
}

/** Sign an update as one issuer. Used by operator tooling and tests; never by a node. */
export function approveGateUpdate(
  issuerPrivateKeyHex: string,
  issuerPublicKeyHex: string,
  ctx: GateAuthorityContext,
  epoch: number,
  add: readonly string[],
  remove: readonly string[],
): GateApproval {
  return {
    key: issuerPublicKeyHex.toLowerCase(),
    signature: signMessage(DOMAIN.GATE_AUTHORITY, gateUpdateMessage(ctx, epoch, add, remove), issuerPrivateKeyHex),
  };
}

const MAX_APPROVALS = CONSENSUS_PARAMS.miningGate.maxIssuers;

export function encodeGateAuthorityBody(body: GateAuthorityBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.u32(body.epoch);
  w.stringList(body.add);
  w.stringList(body.remove);
  w.u32(body.approvals.length);
  for (const approval of body.approvals) {
    w.string(approval.key);
    w.string(approval.signature);
  }
  return w.finish();
}

export function decodeGateAuthorityBody(bytes: Uint8Array): GateAuthorityBody {
  const limit = CONSENSUS_PARAMS.miningGate.maxChangesPerUpdate;
  try {
    const r = new Reader(bytes);
    const op = r.u8() as GateAuthorityOp;
    if (op !== GateAuthorityOp.UPDATE) reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported gate authority operation ${op}`);
    const epoch = r.u32();
    const readList = (label: string): string[] => {
      const count = r.u32();
      if (count > limit) reject(ErrCode.MALFORMED, `a gate authority update may ${label} at most ${limit} keys`);
      const out: string[] = [];
      for (let i = 0; i < count; i += 1) out.push(r.string());
      return out;
    };
    const add = readList('add');
    const remove = readList('remove');
    const approvalCount = r.u32();
    if (approvalCount > MAX_APPROVALS) reject(ErrCode.MALFORMED, `a gate authority update carries at most ${MAX_APPROVALS} approvals`);
    const approvals: GateApproval[] = [];
    for (let i = 0; i < approvalCount; i += 1) approvals.push({ key: r.string(), signature: r.string() });
    r.ensureConsumed();
    return { op, epoch, add, remove, approvals };
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    reject(ErrCode.MALFORMED, `gate authority body is not canonically encoded: ${(error as Error).message}`);
  }
}

export interface GateUpdatePlan {
  add: string[];
  remove: string[];
  nextActive: string[];
  nextRevoked: string[];
}

/**
 * Every rule that does not need a signature. Operator tooling runs it before asking anyone to sign, so nobody signs
 * a change the chain would refuse; the verifier runs it first so a bad update costs nothing.
 */
export function planGateUpdate(
  state: GateAuthorityState,
  change: { epoch: number; add: readonly string[]; remove: readonly string[] },
): GateUpdatePlan {
  const params = CONSENSUS_PARAMS.miningGate;
  const bad = (message: string): never => reject(ErrCode.GATE_AUTHORITY_INVALID, message);

  if (state.active.length === 0) bad('this chain has no active gate issuer, so there is nobody who can authorise an update');
  if (change.epoch !== state.epoch + 1) bad(`this update creates epoch ${change.epoch}, but the next epoch is ${state.epoch + 1}`);

  const add = change.add.map(normalizeGateKey);
  const remove = change.remove.map(normalizeGateKey);
  if (add.length === 0 && remove.length === 0) bad('an update must add or remove at least one key');
  if (new Set(add).size !== add.length || new Set(remove).size !== remove.length) bad('a key is listed twice');
  for (const key of add) {
    if (remove.includes(key)) bad('a key cannot be added and removed in the same update');
    if (state.active.includes(key)) bad(`key ${key} is already an active issuer`);
    if (state.revoked.includes(key)) bad(`key ${key} was revoked earlier and can never be admitted again`);
  }
  for (const key of remove) {
    if (!state.active.includes(key)) bad(`key ${key} is not an active issuer, so it cannot be removed`);
  }
  const nextActive = [...state.active.filter((key) => !remove.includes(key)), ...add].sort();
  if (nextActive.length === 0) bad('an update may not leave the gate with no issuer: that would close mining for ever');
  if (nextActive.length > params.maxIssuers) bad(`the gate may have at most ${params.maxIssuers} active issuers`);
  const nextRevoked = [...state.revoked, ...remove].sort();
  if (nextRevoked.length > params.maxRevoked) bad(`the revoked list is full (${params.maxRevoked}); this network cannot revoke more keys`);
  return { add: [...add].sort(), remove: [...remove].sort(), nextActive, nextRevoked };
}

/**
 * Decide whether `body` is a valid update of `state`, and return the state it produces. Pure: it reads nothing but
 * its arguments, so a block executor and the mempool gate give the same answer. Cheap checks run before any
 * signature is verified, so a malformed or stale update costs almost nothing.
 */
export function verifyGateUpdate(state: GateAuthorityState, body: GateAuthorityBody, ctx: GateAuthorityContext): GateUpdateOutcome {
  const bad = (message: string): never => reject(ErrCode.GATE_AUTHORITY_INVALID, message);
  const plan = planGateUpdate(state, body);

  // Approvals: distinct keys of the CURRENT set, a strict majority, every signature valid.
  const need = gateQuorum(state.active.length);
  if (body.approvals.length < need) bad(`this update needs ${need} of ${state.active.length} current issuers to approve it, and has ${body.approvals.length}`);
  if (body.approvals.length > state.active.length) bad('more approvals than there are issuers');
  const seen = new Set<string>();
  const approvedBy: string[] = [];
  const message = gateUpdateMessage(ctx, body.epoch, plan.add, plan.remove);
  for (const approval of body.approvals) {
    const key = normalizeGateKey(approval.key);
    if (seen.has(key)) bad(`issuer ${key} approved twice`);
    seen.add(key);
    if (!state.active.includes(key)) bad(`approver ${key} is not a current issuer`);
    if (typeof approval.signature !== 'string' || !/^[0-9a-f]{128}$/.test(approval.signature)) bad('an approval signature must be 128 lowercase hex characters');
    if (!verifyMessage(DOMAIN.GATE_AUTHORITY, message, approval.signature, key)) bad(`the approval by ${key} does not match this update`);
    approvedBy.push(key);
  }
  return { active: plan.nextActive, revoked: plan.nextRevoked, epoch: body.epoch, added: plan.add, removed: plan.remove, approvedBy: approvedBy.sort() };
}
