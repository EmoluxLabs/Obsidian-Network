/**
 * THE canonical validity predicate for a Proof-of-Time finality vote.
 *
 * A finality vote moves value: three of four signatures certify a block, that
 * certificate becomes the anchor fork choice may not cross, and two conflicting
 * votes are the evidence that confiscates half a validator's bond. One question
 * therefore has to have exactly one answer everywhere it is asked — in P2P
 * admission, in ordinary vote processing, in certificate construction and
 * verification, in crash recovery, in vote restoration after a restart, in
 * equivocation detection and in slash-evidence verification.
 *
 * Until 1.6.1 that question was answered in several places: a private method on
 * the chain manager for votes, a second, shorter list of checks inside the
 * certificate envelope validator, a third inside the evidence verifier and a
 * fourth inside the evidence detector on the P2P path. They agreed by luck. Any
 * rule added to one and not the others turned a message that one code path
 * accepted into a message another refused — and for slash evidence, "accepted by
 * the detector, refused by the verifier" is exactly the gap that lets a peer
 * relay an accusation no node can act on, or act on one no node would accept.
 *
 * So this file holds the whole rule set, and every caller supplies the same
 * `ConsensusEvidenceContext` of historical lookups. The predicate is pure: it
 * mutates nothing, it takes no clock of its own, and it never substitutes the
 * validating node's current state for the state that was in force when the vote
 * was cast. A lookup it cannot answer comes back null and is reported as such —
 * consensus paths fail closed, an admission path may treat it as "unknown".
 *
 * THE RULES, in the order they are applied (cheapest first, so a peer cannot
 * buy public-key work with garbage):
 *
 *   1. SHAPE. Bounded integers, exact field set, well-formed hashes and keys,
 *      target strictly above the anchor. No unknown fields: a vote carrying
 *      fields this build does not sign is refused rather than truncated.
 *   2. IDENTITY. protocolVersion, networkId, chainId, genesisId and paramsHash
 *      must all be this node's. A vote signed under other rules is not a vote
 *      here, which is what makes "same protocol id, different consensus rules"
 *      impossible to express as a finality message.
 *   3. LOCAL ANCHOR (opt-in). Admission of a new vote additionally requires it
 *      to extend THIS node's own finalized anchor.
 *   4. PARENT. The parent the vote names must exist, and the target height must
 *      be exactly one above it.
 *   5. COMMITTEE. The validator set hash must equal the hash of the committee
 *      that was in force at that parent, and the signer must be a member of it
 *      with the very key it registered under. This is the eligibility check, and
 *      it is a state lookup, so it runs BEFORE any signature arithmetic.
 *   6. SIGNATURE. Valid over the protocol's own finality domain, by the public
 *      key named in the vote, from the address named in the vote.
 *   7. TARGET. The block the vote points at must exist when the caller requires
 *      it, and must agree with the vote on height, parent hash and round. It
 *      must also have been produced by the address the schedule named.
 *   8. EXTENSION. Either the target is the ordinary next block above the anchor
 *      (height = anchor + 1 and parent = anchor hash), or — only while nothing
 *      is finalized yet and only for the bootstrap form the caller allows — the
 *      target sits above a stable genesis-committed committee.
 */

import type { Block, ConsensusEvidenceContext, FinalityVote } from '../protocol/types.js';
import { PROTOCOL_VERSION } from '../version.js';
import { finalityVoteShape, validatorSetHash, verifyFinalityVoteSignature } from './finality.js';
import { proposerRound } from './proposer.js';

/** Which of the caller-dependent rules apply to this particular question. */
export interface FinalityVoteRules {
  /**
   * Refuse a vote that does not extend this node's own finalized anchor. Vote
   * admission needs it; a vote carried inside evidence or a certificate is
   * judged on its own terms, because the offence may predate this node's anchor.
   */
  requireLocalAnchor?: { height: number; hash: string } | false;
  /**
   * Refuse a vote whose target block this node does not hold. True for anything
   * that acts on the vote (certifying, finalizing). Evidence verification sets
   * it false: the offence is proven by the two signatures and the committee,
   * and a node that never saw the equivocated block must still be able to
   * recognise the offence — otherwise an attacker escapes slashing by hiding the
   * block from some peers.
   */
  requireTargetBlock?: boolean;
  /** Report an unavailable target as `unknown` rather than as a plain refusal. */
  allowUnknownTarget?: boolean;
  /** Accept the bootstrap form of a target (a pre-committee chain). */
  allowBootstrapTarget?: boolean;
}

export type FinalityVoteVerdict = { ok: true } | { ok: false; message: string; unknown?: boolean };

const DEFAULT_RULES: Required<Pick<FinalityVoteRules, 'requireTargetBlock' | 'allowUnknownTarget' | 'allowBootstrapTarget'>> = {
  requireTargetBlock: true,
  allowUnknownTarget: false,
  allowBootstrapTarget: true,
};

/**
 * Is `vote` a valid consensus vote for the chain `context` describes?
 *
 * Pure and deterministic: the same vote against the same context and rules
 * gives the same verdict on every node. It never mutates the context, never
 * reads a clock, and never falls back to current state when a historical lookup
 * comes back empty.
 */
export function validateCanonicalFinalityVote(
  vote: FinalityVote,
  context: ConsensusEvidenceContext,
  rules: FinalityVoteRules = {},
): FinalityVoteVerdict {
  const requireTargetBlock = rules.requireTargetBlock ?? DEFAULT_RULES.requireTargetBlock;
  const allowUnknownTarget = rules.allowUnknownTarget ?? DEFAULT_RULES.allowUnknownTarget;
  const allowBootstrapTarget = rules.allowBootstrapTarget ?? DEFAULT_RULES.allowBootstrapTarget;

  // 1. SHAPE — bounded, exact, well-formed. Nothing is parsed or hashed before
  //    this, so a peer cannot hand us an object that makes a later step throw.
  const shape = finalityVoteShape(vote);
  if (!shape.ok) return { ok: false, message: shape.reason };

  // 2. IDENTITY — this protocol, this network, this chain, this genesis, these
  //    parameters. Each field is named in the refusal so a node that cannot
  //    agree with a peer can say which fact they disagree about.
  if (vote.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, message: `vote belongs to protocol ${vote.protocolVersion}, this node runs ${PROTOCOL_VERSION}` };
  }
  if (vote.networkId !== context.networkId) return { ok: false, message: 'vote belongs to another network' };
  if (vote.chainId !== context.chainId) return { ok: false, message: 'vote belongs to another chain id' };
  if (vote.genesisId !== context.genesisId) return { ok: false, message: 'vote belongs to another genesis' };
  if (vote.paramsHash !== context.paramsHash) {
    return { ok: false, message: 'vote was signed under other consensus parameters' };
  }

  // 3. LOCAL ANCHOR (admission only).
  const local = rules.requireLocalAnchor;
  if (local && (vote.finalizedHeight !== local.height || vote.finalizedHash !== local.hash)) {
    return { ok: false, message: 'vote does not extend local finality' };
  }

  // 4. PARENT — the anchor the vote claims to sit on must exist, and the target
  //    must be exactly the block above it.
  const parent = context.anchorFor(vote.parentHash);
  if (!parent) return { ok: false, message: 'vote parent unknown or height inconsistent' };
  if (vote.height !== parent.height + 1) return { ok: false, message: 'vote parent unknown or height inconsistent' };

  // 5. COMMITTEE — eligibility, decided by the state at the anchor's parent.
  //    A state lookup, deliberately ahead of the signature: refusing a vote
  //    whose signer was never in the committee costs a hash comparison, and a
  //    peer should not be able to make this node do public-key arithmetic on a
  //    vote from a validator that does not exist.
  const committee = context.committeeFor(vote.parentHash, vote.finalizedHeight);
  if (committee === null) {
    return { ok: false, message: 'the state that named this committee is not available on this node' };
  }
  if (validatorSetHash([...committee]) !== vote.validatorSetHash) {
    return { ok: false, message: 'validator not eligible in target parent state' };
  }
  if (!committee.some((member) => member.address === vote.validator && member.publicKey === vote.publicKey)) {
    return { ok: false, message: 'validator not eligible in target parent state' };
  }

  // 6. SIGNATURE — over the protocol's own finality domain, by the named key,
  //    from the named address. Domain separation and the key/address binding are
  //    inside verifyFinalityVoteSignature, so there is one implementation of it.
  if (!verifyFinalityVoteSignature(vote, context.addressHrp)) {
    return { ok: false, message: 'vote signature or address invalid' };
  }

  // 7. TARGET — the block the vote points at.
  const target: Block | null = context.blockByHash(vote.blockHash);
  if (!target) {
    return {
      ok: false,
      message: 'vote target unknown',
      // `unknown` is only meaningful to a caller that asked for the target to
      // be optional: where the target is required, "not held here" is simply a
      // refusal, and must not be softened into "cannot tell".
      unknown: allowUnknownTarget && !requireTargetBlock,
    };
  }
  if (target.header.height !== vote.height) return { ok: false, message: 'vote target metadata mismatch' };
  if (target.header.prevHash !== vote.parentHash) return { ok: false, message: 'vote target metadata mismatch' };
  if (proposerRound(parent.timestamp, target.header.timestamp) !== vote.round) {
    return { ok: false, message: 'vote target metadata mismatch' };
  }
  // A vote may only certify a block the proposer schedule authorised. The
  // schedule is read at the target's own protocol time, exactly as it is read
  // when the block itself is validated, so the two answers cannot differ.
  const scheduled = context.scheduledProposerFor(vote.parentHash, target.header.height, vote.round, target.header.timestamp);
  if (scheduled !== null && target.header.producer !== scheduled) {
    return { ok: false, message: 'vote target was not produced by the scheduled proposer' };
  }

  // 8. EXTENSION — the ordinary next block, or the bootstrap form.
  const ordinary = vote.height === vote.finalizedHeight + 1 && vote.parentHash === vote.finalizedHash;
  const bootstrap =
    allowBootstrapTarget &&
    vote.finalizedHeight === 0 &&
    context.isBootstrapTarget(target, vote.validatorSetHash, !rules.requireLocalAnchor);
  if (!ordinary && !bootstrap) return { ok: false, message: 'vote target does not extend anchor' };

  return { ok: true };
}
