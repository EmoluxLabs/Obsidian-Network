/**
 * CAPSULE — the Obsidian Time Capsule Wall (spec §41–§44).
 *
 * Model
 *   - A capsule commits to an encrypted payload (never stored in plaintext on
 *     chain) and locks a creator commitment of at least 0.0001 OBS.
 *   - The locked commitment is NOT a balance: it is removed from circulation
 *     into the capsule and counted by the supply invariant while LOCKED.
 *   - At the exact unlock protocol time the commitment is transferred to the
 *     Mining Pool automatically, by state transition, with no action required
 *     from the creator — it works even if the creator is offline forever.
 *   - Each account may Time Travel a given capsule exactly once, paying
 *     1000 x creator commitment, which goes entirely to the Mining Pool.
 *
 * Honest limitation (documented in /docs/time-capsule.md): the protocol can
 * release only data that needs no online party. The creator therefore publishes
 * a teaser at creation, and the *Time Travel gate* is a protocol-recorded,
 * paid access right. Genuinely secret content stays inside the encrypted
 * payload and is released by a REVEAL transaction only at or after unlockAt,
 * which the protocol rejects before that time.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { DOMAIN } from '../../protocol/domains.js';
import { domainHash, fromHex, toHex } from '../../crypto/hash.js';
import { encodePayload } from '../../crypto/bech32.js';
import { ID_HRP } from '../../crypto/keys.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import { CapsuleOp, type CapsuleBody, type CapsuleRecord, type TxEnvelope } from '../../protocol/types.js';
import { assertAmount, assertGas } from '../helpers.js';
import type { ExecutorContext } from '../types.js';

const MAX_PREVIEW_BYTES = 4096;

export function decodeCapsuleBody(body: Uint8Array): CapsuleBody {
  const r = new Reader(body);
  const op = r.u8() as CapsuleOp;
  const capsuleId = r.string();
  const contentCommitment = r.string();
  const contentBytes = r.u32();
  const commitment = r.u128();
  const contentNonce = r.string();
  const unlockAt = Number(r.u64());
  const previewChunk = r.string();
  const payment = r.u128();
  r.ensureConsumed();
  return {
    op,
    capsuleId,
    contentCommitment: contentCommitment.length ? contentCommitment : undefined,
    contentBytes: contentBytes || undefined,
    commitment: commitment > 0n ? commitment : undefined,
    contentNonce: contentNonce.length ? contentNonce : undefined,
    unlockAt: unlockAt || undefined,
    previewChunk: previewChunk.length ? previewChunk : undefined,
    payment: payment > 0n ? payment : undefined,
  };
}

export function encodeCapsuleBody(body: CapsuleBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(body.capsuleId);
  w.string(body.contentCommitment ?? '');
  w.u32(body.contentBytes ?? 0);
  w.u128(body.commitment ?? 0n);
  w.string(body.contentNonce ?? '');
  w.u64(BigInt(Math.trunc(body.unlockAt ?? 0)));
  w.string(body.previewChunk ?? '');
  w.u128(body.payment ?? 0n);
  return w.finish();
}

/**
 * Canonical capsule id. Deterministic from (owner, contentCommitment, unlockAt,
 * contentNonce) so no attacker can mint a colliding or spoofed id.
 */
export function computeCapsuleId(
  owner: string,
  contentCommitment: string,
  unlockAt: number,
  contentNonce: string,
): string {
  const digest = domainHash(
    DOMAIN.CAPSULE_ID,
    new TextEncoder().encode(`CAPSULE|${owner}|${contentCommitment}|${unlockAt}|${contentNonce}`),
  );
  return encodePayload(ID_HRP, digest.slice(0, 20), 0x2bc830a3 /* bech32m */);
}

export function isCapsuleId(value: string): boolean {
  try {
    return value.startsWith(`${ID_HRP}1`);
  } catch {
    return false;
  }
}

export function executeCapsule(ctx: ExecutorContext, tx: TxEnvelope): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply } = ctx;
  const body = decodeCapsuleBody(tx.body);
  const protocolTime = apply.timestamp;

  switch (body.op) {
    case CapsuleOp.CREATE: {
      if (!body.contentCommitment || !/^[0-9a-f]{64}$/.test(body.contentCommitment)) {
        reject(ErrCode.MALFORMED, 'contentCommitment must be a 32-byte SHA-256 digest in hex');
      }
      if (!body.contentNonce || !/^[0-9a-f]{16,64}$/.test(body.contentNonce)) {
        reject(ErrCode.MALFORMED, 'contentNonce must be 8-32 bytes in hex (AEAD nonce)');
      }
      assertAmount(body.commitment ?? 0n, { label: 'commitment' });
      const commitment = body.commitment!;
      if (commitment < CONSENSUS_PARAMS.capsules.minCommitment) {
        reject(
          ErrCode.CAPSULE_COMMITMENT_TOO_LOW,
          `commitment must be at least ${CONSENSUS_PARAMS.capsules.minCommitment} seals`,
        );
      }
      if (!body.unlockAt) reject(ErrCode.MALFORMED, 'unlockAt is required');
      const unlockAt = body.unlockAt;
      if (unlockAt < protocolTime + CONSENSUS_PARAMS.capsules.minLockSeconds) {
        reject(ErrCode.MALFORMED, 'unlock time must be at least one hour in the future');
      }
      if (unlockAt > protocolTime + CONSENSUS_PARAMS.capsules.maxLockSeconds) {
        reject(ErrCode.MALFORMED, 'unlock time exceeds the protocol maximum lock duration');
      }
      if ((body.contentBytes ?? 0) <= 0 || body.contentBytes! > CONSENSUS_PARAMS.capsules.maxContentBytes) {
        reject(ErrCode.MALFORMED, `content must be between 1 and ${CONSENSUS_PARAMS.capsules.maxContentBytes} bytes`);
      }
      if (body.previewChunk && fromHex(body.previewChunk).length > MAX_PREVIEW_BYTES) {
        reject(ErrCode.MALFORMED, `preview chunk may not exceed ${MAX_PREVIEW_BYTES} bytes`);
      }
      const canonicalId = computeCapsuleId(
        tx.sender,
        body.contentCommitment,
        unlockAt,
        body.contentNonce,
      );
      if (body.capsuleId !== canonicalId) {
        reject(ErrCode.MALFORMED, 'capsule id does not match its canonical derivation', {
          expected: canonicalId,
          received: body.capsuleId,
        });
      }
      if (state.s.capsules.has(canonicalId)) {
        reject(ErrCode.REPLAY, 'that capsule already exists');
      }
      const gas = assertGas(tx.gas, commitment);
      // Lock the commitment: debited from the owner's balance, held by state.
      state.debit(tx.sender, commitment + gas, apply, 'capsule commitment locked');
      if (gas > 0n) {
        state.poolInflow(gas, 'capsule creation gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      state.touchAccount(tx.sender, apply);
      const record: CapsuleRecord = {
        capsuleId: canonicalId,
        owner: tx.sender,
        creatorCommitment: commitment,
        contentCommitment: body.contentCommitment,
        contentBytes: body.contentBytes!,
        contentNonce: body.contentNonce,
        createdAt: protocolTime,
        createdAtHeight: apply.height,
        unlockAt,
        status: 'LOCKED',
        teaser: body.previewChunk,
        previewedBy: [],
        previewCount: 0,
        totalTimeTravelRevenue: 0n,
      };
      state.s.capsules.set(canonicalId, record);
      state.s.metrics.totalCapsulesCreated += 1;
      state.emit('CAPSULE_CREATED', {
        capsuleId: canonicalId,
        owner: tx.sender,
        commitment: commitment.toString(),
        contentCommitment: body.contentCommitment,
        unlockAt,
        size: body.contentBytes!,
        teaser: body.previewChunk ?? null,
      }, apply);
      return { gasBase: commitment, detail: { capsuleId: canonicalId, unlockAt } };
    }

    case CapsuleOp.PREVIEW: {
      const capsule = state.s.capsules.get(body.capsuleId);
      if (!capsule) reject(ErrCode.CAPSULE_NOT_FOUND, 'no such capsule');
      if (capsule.status !== 'LOCKED') {
        reject(ErrCode.CAPSULE_UNLOCKED, 'this capsule has unlocked; its content is public and free');
      }
      if (capsule.previewedBy.includes(tx.sender)) {
        reject(ErrCode.CAPSULE_ALREADY_PREVIEWED, 'each account may Time Travel a capsule once');
      }
      const price = capsule.creatorCommitment * CONSENSUS_PARAMS.capsules.timeTravelMultiplier;
      if (!body.payment) reject(ErrCode.MALFORMED, 'Time Travel payment is required');
      if (body.payment < price) {
        reject(ErrCode.INSUFFICIENT_FUNDS, `Time Travel costs ${price} seals`, { required: price.toString() });
      }
      const gas = assertGas(tx.gas, body.payment);
      state.debit(tx.sender, body.payment + gas, apply, 'Time Travel payment + gas');
      state.poolInflow(body.payment, 'Time Travel revenue to mining pool');
      if (gas > 0n) {
        state.poolInflow(gas, 'Time Travel gas to mining pool');
        state.s.metrics.totalGasBurnedToPool += gas;
      }
      state.touchAccount(tx.sender, apply);
      capsule.previewedBy = [...capsule.previewedBy, tx.sender].sort();
      capsule.previewCount += 1;
      capsule.totalTimeTravelRevenue += body.payment;
      state.emit('CAPSULE_PREVIEWED', {
        capsuleId: capsule.capsuleId,
        viewer: tx.sender,
        payment: body.payment.toString(),
        previewSeconds: CONSENSUS_PARAMS.capsules.previewSeconds,
      }, apply);
      return {
        gasBase: body.payment,
        detail: {
          capsuleId: capsule.capsuleId,
          payment: body.payment.toString(),
          previewSeconds: CONSENSUS_PARAMS.capsules.previewSeconds,
          unlockAt: capsule.unlockAt,
        },
      };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported capsule operation ${body.op}`);
  }
}

/**
 * Deterministic per-block unlock routine, executed by the state machine for
 * every block: any LOCKED capsule whose unlockAt has arrived flips to UNLOCKED
 * and its commitment is transferred to the Mining Pool. No transaction, no
 * owner action and no scheduler are involved — the block itself is the trigger.
 */
export function processCapsuleUnlocks(ctx: ExecutorContext): void {
  const { state, apply } = ctx;
  for (const capsule of state.s.capsules.values()) {
    if (capsule.status !== 'LOCKED') continue;
    if (capsule.unlockAt > apply.timestamp) continue;
    capsule.status = 'UNLOCKED';
    capsule.unlockedAtHeight = apply.height;
    capsule.poolContribution = capsule.creatorCommitment;
    state.poolInflow(capsule.creatorCommitment, 'capsule commitment released to mining pool at unlock');
    state.emit('CAPSULE_UNLOCKED', {
      capsuleId: capsule.capsuleId,
      owner: capsule.owner,
      commitmentToPool: capsule.creatorCommitment.toString(),
      unlockAt: capsule.unlockAt,
    }, apply);
  }
}

export function capsuleTeaser(capsule: CapsuleRecord): string | null {
  return capsule.teaser ?? null;
}

export function capsuleIdHash(capsuleId: string): string {
  return toHex(domainHash(DOMAIN.CAPSULE_SECRET, new TextEncoder().encode(capsuleId)));
}
