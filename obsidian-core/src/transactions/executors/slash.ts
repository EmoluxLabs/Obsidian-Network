/**
 * SLASH — the equivocation penalty, applied inside the state transition.
 *
 * WHY THIS IS A TRANSACTION
 *
 *   The penalty has to be identical on every honest node, so it cannot be an
 *   RPC action, a dashboard button or a node-local decision. A transaction is
 *   the protocol's existing machinery for "something happened at a height, in a
 *   canonical order, verified by everyone": the block carring it is validated by
 *   every node, the effect is committed in the state root, and a reorg removes
 *   it exactly the way it removes any other transaction.
 *
 * THE SUBMITTER CHOOSES NOTHING
 *
 *   Anyone may submit: an operator, a node, a wallet, a script. The submitter
 *   cannot name the offender (the evidence does), cannot name an amount (the
 *   consensus ratio over the validator's own bond does), cannot name a
 *   destination (the Mining Pool is fixed by consensus) and cannot make a
 *   second slash happen (the evidence id is recorded, and the registration
 *   closes). Paying for the transaction is the only thing they contribute.
 *
 *   The transaction carries no value and pays no gas: it moves no funds of its
 *   own, and pricing it would create a reason not to report equivocation. Its
 *   cost is block space, bounded by the ordinary transaction limits.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { ErrCode, ProtocolError, reject } from '../../protocol/errors.js';
import { SlashOp, type EquivocationEvidence, type SlashBody, type TxEnvelope } from '../../protocol/types.js';
import { assertGas } from '../helpers.js';
import { verifyEquivocationEvidence } from '../../consensus/slash-evidence.js';
import type { ExecutorContext } from '../types.js';

export function decodeSlashBody(body: Uint8Array): SlashBody {
  let op: SlashOp;
  let evidenceJson: string;
  let firstParentHeader: string;
  let secondParentHeader: string;
  try {
    const r = new Reader(body);
    op = r.u8() as SlashOp;
    if (op !== SlashOp.EQUIVOCATION) {
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported slash operation ${op}`);
    }
    evidenceJson = r.string();
    firstParentHeader = r.string();
    secondParentHeader = r.string();
    r.ensureConsumed();
  } catch (error) {
    // A truncated or overrun body is the SENDER's mistake — including the
    // reader's own bounds errors, which are plain Errors and not protocol ones.
    // Reporting it as an internal node fault would hide a hostile peer behind
    // the same error code as a genuine bug, so the decoder converts every
    // encoding failure into MALFORMED. The block is refused either way; only
    // the diagnosis changes.
    if (error instanceof ProtocolError) throw error;
    reject(ErrCode.MALFORMED, `slash transaction body is not canonically encoded: ${(error as Error).message}`);
  }
  if (Buffer.byteLength(evidenceJson, 'utf8') > 64 * 1024) {
    reject(ErrCode.MALFORMED, 'slash evidence is larger than the protocol allows');
  }
  let evidence: EquivocationEvidence;
  try {
    evidence = JSON.parse(evidenceJson) as EquivocationEvidence;
  } catch {
    reject(ErrCode.MALFORMED, 'slash evidence is not valid JSON');
  }
  return {
    op,
    evidence,
    firstParentHeader: firstParentHeader || undefined,
    secondParentHeader: secondParentHeader || undefined,
  };
}

/**
 * The canonical size, in bytes, of the evidence a SLASH body carries — or null
 * when the body does not decode.
 *
 * One ruler for every budget in the protocol (per-block count and bytes,
 * mempool reservation, producer throttle), so no two limits can disagree about
 * how big the same report is. A body that does not decode measures as null and
 * is left to the decoder's own canonical MALFORMED a few lines later: nothing is
 * hidden here, and a report that cannot be measured is never counted against a
 * budget it was refused for other reasons anyway.
 */
export function slashEvidenceBytes(body: Uint8Array): number | null {
  try {
    const r = new Reader(body);
    const op = r.u8();
    if (op !== SlashOp.EQUIVOCATION) return null;
    return Buffer.byteLength(r.string(), 'utf8');
  } catch {
    return null;
  }
}

export function encodeSlashBody(body: SlashBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(JSON.stringify(body.evidence));
  w.string(body.firstParentHeader ?? '');
  w.string(body.secondParentHeader ?? '');
  return w.finish();
}

export function executeSlash(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeSlashBody(tx.body);
  assertGas(tx.gas, 0n);

  // Pure verification first: nothing about the validator, the bond or the pool
  // is touched until the evidence has been proven, and the proof itself is the
  // same function every other caller runs.
  const verified = verifyEquivocationEvidence(state, net, body, apply.height, ctx.evidence);
  if (!verified.ok) {
    reject(verified.code, `slash rejected: ${verified.message}`);
  }

  const record = state.applyEquivocationSlash(
    {
      evidenceId: verified.evidenceId,
      type: verified.type,
      validator: verified.validator,
      height: verified.height,
      round: verified.round,
      amount: verified.amount,
      bondBefore: verified.bondBefore,
      remaining: verified.remaining,
    },
    apply,
  );

  return {
    gasBase: 0n,
    detail: {
      op: 'EQUIVOCATION',
      validator: record.validator,
      evidenceId: record.evidenceId,
      evidenceType: record.type,
      slashed: record.amount.toString(),
      remaining: record.bondAfter.toString(),
      destination: 'MINING_POOL',
      submitter: tx.sender,
    },
  };
}
