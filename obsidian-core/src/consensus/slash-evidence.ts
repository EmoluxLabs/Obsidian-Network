/**
 * Equivocation evidence verification — the single path that decides whether a
 * slash may be applied.
 *
 * WHAT IS SLASHABLE, AND WHAT IS NOT
 *
 *   Only objectively provable double-signing by a validator that is bonded at
 *   the moment the evidence is applied:
 *
 *     - PROPOSER_EQUIVOCATION: one validator signed two different block headers
 *       for the same height *and the same round*. Two proposals in different
 *       rounds are legitimate (a slot can elapse and the turn move on), so the
 *       round is checked, not assumed.
 *     - VOTE_EQUIVOCATION: one validator signed two conflicting finality votes
 *       for the same finalized anchor — the exact conflict rule the node's own
 *       finality admission already uses.
 *
 *   Being offline, missing a slot, failing to vote, restarting or losing the
 *   network is NOT slashable. Those are handled by the missed-slot jail
 *   (transactions/executors/validator.ts), which costs time, not capital.
 *
 * THE EVIDENCE IS SELF-CONTAINED
 *
 *   Every honest node must reach the same verdict from the evidence and the
 *   chain state alone — no local observations, no "a node told me", no
 *   administrator. Signature verification, identity binding, domain binding and
 *   the conflict itself are all recomputed here.
 *
 *   Block headers do not carry their parent's timestamp, but the round is a
 *   function of it. A proposer evidence transaction therefore also carries both
 *   parent headers, bound to the children by
 *   `child.prevHash === blockHash(parent)`. A fabricated parent cannot satisfy
 *   that without finding a SHA-256 preimage, so a submitter can neither invent a
 *   round nor claim one that never existed.
 *
 *   Vote equivocation is verified against the local chain's genesis identity
 *   (recomputed from consensus state, never from the submitter) and against the
 *   running protocol version and params hash, so evidence from another network,
 *   another chain or another rule set cannot slash anyone here.
 *
 * IDEMPOTENCE
 *
 *   `state.s.slashes` is keyed by the canonical evidence id, and the validator's
 *   status becomes SLASHED. Replaying the same evidence — in another block, from
 *   another peer, after a restart — finds one of the two and is rejected. A
 *   second, genuinely different equivocation by the same validator at the same
 *   height is also rejected: one registration is slashed once.
 *
 * WHERE THE LIABILITY LIVES
 *
 *   The offence is charged to the registration, not to the address: an offence
 *   must fall inside `[registeredAtHeight, unbondingStartHeight]` of the record
 *   that holds the bond now (`WorldState.offenceChargesToCurrentRegistration`).
 *   Two consequences, both deliberate:
 *
 *     - unregistering does not escape the penalty. `UNBONDING`, `JAILED` and
 *       `ACTIVE` all still hold the escrowed bond, so the offence stays
 *       chargeable for the whole unbonding window; the offending validator
 *       cannot make the window run out, it can only start the clock;
 *     - a fresh registration cannot be charged for an earlier tenure. Claiming
 *       the remainder and registering again with a full bond is a new liability,
 *       so evidence about the old one is refused rather than confiscating an
 *       innocent bond that happens to reuse the same key.
 *
 *   Once the remainder has been claimed the registration is gone and the
 *   evidence is refused with NOT_FOUND — deterministically, on every node. That
 *   is the boundary of the mechanism: the window is the unbonding delay, and it
 *   is the protocol's only guarantee about how long a proven offence can still
 *   be charged (see the audit report, section I).
 */

import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { ErrCode } from '../protocol/errors.js';
import { PROTOCOL_VERSION } from '../version.js';
import { PARAMS_HASH } from '../blockchain/state-root.js';
import { blockHash, decodeSignedHeader, verifyBlockSignature } from '../blockchain/block.js';
import type {
  BlockHeader,
  ConsensusEvidenceContext,
  EquivocationEvidence,
  FinalityVote,
  SlashBody,
} from '../protocol/types.js';
import { validateCanonicalFinalityVote } from './finality-vote.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { WorldState } from '../blockchain/state.js';
import { fromHex } from '../crypto/hash.js';
import { addressFromPublicKey } from '../crypto/keys.js';
import {
  evidenceSerializedBytes,
  finalityVoteShape,
  makeProposerEvidence,
  makeVoteEvidence,
  verifyFinalityVoteSignature,
} from './finality.js';
import { proposerRound } from './proposer.js';
import { genesisDocumentFor, genesisId } from '../genesis/initialize.js';

/** Share of the bond a proven equivocation costs, in basis points. */
export const EQUIVOCATION_SLASH_BPS = CONSENSUS_PARAMS.consensus.equivocationSlashBps;

export interface VerifiedSlash {
  ok: true;
  evidenceId: string;
  type: 'PROPOSER_EQUIVOCATION' | 'VOTE_EQUIVOCATION';
  validator: string;
  /** Height of the equivocation (not of the block applying it). */
  height: number;
  round: number;
  bondBefore: bigint;
  /** Taken from the bond and credited to the Mining Pool. */
  amount: bigint;
  /** Still held by the validator, claimable after the unbonding delay. */
  remaining: bigint;
}

export interface SlashRejection {
  ok: false;
  code: ErrCode;
  message: string;
}

export type SlashVerification = VerifiedSlash | SlashRejection;

const reject = (code: ErrCode, message: string): SlashRejection => ({ ok: false, code, message });

/**
 * Penalty for a proven equivocation: `bond × bps / 10_000`, integer-exact, with
 * the remainder staying with the validator. Nothing is hard-coded: the amount
 * follows the consensus ratio and the validator's own recorded bond, so a
 * submitter cannot name a number and a change to the ratio is a visible,
 * hash-committed protocol change.
 */
export function slashAmountFor(bond: bigint): bigint {
  if (bond <= 0n) return 0n;
  return (bond * BigInt(EQUIVOCATION_SLASH_BPS)) / 10_000n;
}

/** True when the two amounts re-add to the whole bond, with nothing lost. */
export function slashSumsBack(amount: bigint, remaining: bigint, bond: bigint): boolean {
  return amount >= 0n && remaining >= 0n && amount + remaining === bond;
}

/**
 * The genesis identity this chain is on, recomputed from consensus state.
 * A submitter never supplies it; a vote that names another network's genesis id
 * is therefore rejected here rather than trusted.
 */
export function genesisIdForState(state: WorldState, net: NetworkDefinition): string | null {
  try {
    return genesisId(genesisDocumentFor(net, state.s.genesis.bootstrapValidatorKeys, state.s.genesis.miningGateKeys), net);
  } catch {
    return null;
  }
}

function decodeHeaderHex(hex: string): BlockHeader | null {
  try {
    return decodeSignedHeader(fromHex(hex));
  } catch {
    return null;
  }
}

/**
 * The single authoritative verification path. Returns the exact amounts to
 * apply on success; every rejection carries the protocol error code the node
 * reports.
 *
 * PURE: it reads state and `consensus`, mutates nothing and applies nothing, so
 * the very same function can run in P2P admission, in the mempool, in a
 * simulation and inside the state transition of a block — and every one of
 * those callers gets the same verdict. Applying the penalty is a separate step
 * (see the SLASH executor), which is what keeps "looks valid" from ever being
 * confused with "has been paid out".
 *
 * `consensus` supplies the historical lookups (committee at the anchor, block by
 * hash, schedule) that vote evidence needs. It is optional in the signature but
 * NOT in practice: without it this function refuses vote evidence rather than
 * guessing, because a node that cannot check the committee cannot check the
 * accusation.
 */
export function verifyEquivocationEvidence(
  state: WorldState,
  net: NetworkDefinition,
  body: SlashBody,
  atHeight: number,
  consensus?: ConsensusEvidenceContext,
): SlashVerification {
  const evidence = body.evidence as EquivocationEvidence | undefined;
  if (!evidence || typeof evidence !== 'object' || evidence.version !== 1) {
    return reject(ErrCode.MALFORMED, 'slash evidence is missing or of an unsupported version');
  }
  if (evidenceSerializedBytes(evidence) > CONSENSUS_PARAMS.consensus.finality.maxEvidenceBytes) {
    return reject(ErrCode.MALFORMED, 'slash evidence exceeds the protocol size limit');
  }

  // The validator must exist, still hold an escrowed bond of exactly the
  // consensus size, and be liable for *this* offence. Liability is a window,
  // not a status: while the bond is escrowed — active, jail-waiting or
  // unbonding — the registration answers for what it did between its
  // registration and the moment it left the active set. A slashed registration
  // is closed (one bond is slashed once), and a claimed one no longer exists,
  // so an offending validator cannot make the evidence window run out by
  // unregistering: it only starts the clock.
  const account = state.getAccount(evidence.validator);
  const validator = account?.validator;
  if (!validator) return reject(ErrCode.NOT_FOUND, 'the evidence names an address that is not a registered validator');
  if (validator.status === 'SLASHED') return reject(ErrCode.REPLAY, 'this validator has already been slashed; its registration is closed');
  const bond = validator.bond;
  if (bond !== CONSENSUS_PARAMS.consensus.validatorBond) {
    return reject(ErrCode.VALIDATOR_BOND_MISMATCH, 'the validator does not hold the exact consensus bond');
  }

  let height: number;
  let round: number;
  let signingKey: string;
  /** Votes that must each satisfy the canonical finality-vote predicate. */
  let votesToValidate: [FinalityVote, FinalityVote] | null = null;

  if (evidence.type === 'VOTE_EQUIVOCATION') {
    const first = evidence.firstVote;
    const second = evidence.secondVote;
    const firstShape = finalityVoteShape(first);
    if (!firstShape.ok) return reject(ErrCode.MALFORMED, `first vote: ${firstShape.reason}`);
    const secondShape = finalityVoteShape(second);
    if (!secondShape.ok) return reject(ErrCode.MALFORMED, `second vote: ${secondShape.reason}`);

    // Cryptography first: both signatures must be valid, over the protocol's own
    // finality domain, and both must belong to the same validator key.
    if (!verifyFinalityVoteSignature(first, net.addressHrp) || !verifyFinalityVoteSignature(second, net.addressHrp)) {
      return reject(ErrCode.BAD_SIGNATURE, 'a finality vote signature is invalid or does not match its validator');
    }
    if (first.validator !== second.validator || first.publicKey !== second.publicKey) {
      return reject(ErrCode.BAD_SIGNATURE, 'the two votes do not belong to the same validator key');
    }
    if (first.validator !== evidence.validator) {
      return reject(ErrCode.UNAUTHORIZED, 'the evidence validator does not match the validator that signed');
    }
    if (validator.validatorKey !== first.publicKey) {
      return reject(ErrCode.UNAUTHORIZED, 'the signing key is not the key this validator registered with');
    }

    // Domain and identity binding: this network, this chain, this genesis, these
    // rules. A vote signed for another network can never slash here.
    const genesisIdentifier = genesisIdForState(state, net);
    if (!genesisIdentifier) return reject(ErrCode.MALFORMED, 'this node cannot derive its own genesis identity');
    for (const [label, vote] of [['first', first], ['second', second]] as const) {
      if (vote.protocolVersion !== PROTOCOL_VERSION) return reject(ErrCode.VERSION_MISMATCH, `${label} vote was signed for protocol ${vote.protocolVersion}`);
      if (vote.networkId !== net.networkId) return reject(ErrCode.WRONG_NETWORK, `${label} vote names network ${vote.networkId}`);
      if (vote.chainId !== net.chainId) return reject(ErrCode.WRONG_CHAIN_ID, `${label} vote names chain id ${vote.chainId}`);
      if (vote.genesisId !== genesisIdentifier) return reject(ErrCode.WRONG_CHAIN_ID, `${label} vote names another genesis`);
      if (vote.paramsHash !== PARAMS_HASH) return reject(ErrCode.VERSION_MISMATCH, `${label} vote was signed under other consensus parameters`);
      if (vote.type !== 'POT_FINALITY') return reject(ErrCode.MALFORMED, `${label} vote is not a POT_FINALITY vote`);
    }
    if (first.finalizedHash !== second.finalizedHash || first.finalizedHeight !== second.finalizedHeight) {
      return reject(ErrCode.BAD_SIGNATURE, 'the two votes do not share a finalized anchor, so they are not a conflict');
    }
    // The conflict itself. Two signatures only prove equivocation when they
    // assert something different: a second vote for the same block (even at a
    // different target height) is redundant, not contradictory, and the node's
    // own evidence detector keeps such pairs as observations — never as a
    // slashable offence. Requiring differing block hashes makes false positives
    // impossible even at the cost of missing a harmless repeat vote.
    // Both votes must name the same validator set. Mutating one half of a pair
    // is then refused instead of being "verified": the set hash is covered by
    // the signature, and a pair that disagrees about the set is not evidence
    // about any one set.
    if (first.validatorSetHash !== second.validatorSetHash) {
      return reject(ErrCode.MALFORMED, 'the two votes name different validator sets');
    }
    if (first.blockHash === second.blockHash) {
      return reject(ErrCode.REPLAY, 'the two votes name the same block, so they do not conflict');
    }

    const rebuilt = makeVoteEvidence(first, second);
    if (rebuilt.id !== evidence.id || rebuilt.height !== evidence.height || rebuilt.round !== evidence.round
      || rebuilt.messageType !== evidence.messageType
      || rebuilt.firstId !== evidence.firstId || rebuilt.secondId !== evidence.secondId) {
      return reject(ErrCode.MALFORMED, 'the vote evidence is not in canonical form');
    }
    if (state.s.slashes.has(rebuilt.id)) return reject(ErrCode.REPLAY, 'this evidence has already been applied');
    height = rebuilt.height;
    round = rebuilt.round;
    signingKey = first.publicKey;
    votesToValidate = [first, second];
  } else if (evidence.type === 'PROPOSER_EQUIVOCATION') {
    const first = decodeHeaderHex(evidence.firstHeader);
    const second = decodeHeaderHex(evidence.secondHeader);
    const firstParent = typeof body.firstParentHeader === 'string' && body.firstParentHeader ? decodeHeaderHex(body.firstParentHeader) : null;
    const secondParent = typeof body.secondParentHeader === 'string' && body.secondParentHeader ? decodeHeaderHex(body.secondParentHeader) : null;
    if (!first || !second) return reject(ErrCode.MALFORMED, 'a proposed header cannot be decoded');
    if (!firstParent || !secondParent) return reject(ErrCode.MALFORMED, 'proposer evidence must carry both parent headers');

    // Every header is bound to this chain, this protocol and these parameters.
    for (const [label, header] of [['first', first], ['second', second], ['first parent', firstParent], ['second parent', secondParent]] as const) {
      if (header.protocolVersion !== PROTOCOL_VERSION) return reject(ErrCode.VERSION_MISMATCH, `${label} header was produced under protocol ${header.protocolVersion}`);
      if (header.chainId !== net.chainId) return reject(ErrCode.WRONG_CHAIN_ID, `${label} header names chain id ${header.chainId}`);
      if (header.paramsHash !== PARAMS_HASH) return reject(ErrCode.VERSION_MISMATCH, `${label} header commits to other consensus parameters`);
    }

    // Parent binding: the children commit to the parents by hash, so a parent
    // cannot be swapped or invented to manufacture a round.
    if (first.prevHash !== blockHash(firstParent) || second.prevHash !== blockHash(secondParent)) {
      return reject(ErrCode.MALFORMED, 'a proposed header does not descend from the parent header supplied with it');
    }
    if (first.height !== firstParent.height + 1 || second.height !== secondParent.height + 1) {
      return reject(ErrCode.MALFORMED, 'parent and child heights do not agree');
    }
    if (first.cumulativePotWeight !== firstParent.cumulativePotWeight + 1n || second.cumulativePotWeight !== secondParent.cumulativePotWeight + 1n) {
      return reject(ErrCode.MALFORMED, 'parent and child PoT weight do not agree');
    }

    // Signatures: a child header must be signed by the address that produced it.
    if (first.producer !== evidence.validator || second.producer !== evidence.validator) {
      return reject(ErrCode.UNAUTHORIZED, 'the evidence validator is not the producer of both headers');
    }
    if (!verifyBlockSignature({ header: first, transactions: [] }, net.addressHrp) || !verifyBlockSignature({ header: second, transactions: [] }, net.addressHrp)) {
      return reject(ErrCode.BAD_SIGNATURE, 'a proposed header signature is invalid');
    }
    if (first.producerSignature.publicKey !== second.producerSignature.publicKey) {
      return reject(ErrCode.BAD_SIGNATURE, 'the two proposals were signed by different keys');
    }
    if (validator.validatorKey !== first.producerSignature.publicKey) {
      return reject(ErrCode.UNAUTHORIZED, 'the signing key is not the key this validator registered with');
    }
    // A parent is a real block: its producer signed it, except the genesis block
    // which is identified by hash and has no key. Its timestamp decides the round.
    for (const [label, parent] of [['first parent', firstParent], ['second parent', secondParent]] as const) {
      if (parent.height === 0) continue;
      if (!verifyBlockSignature({ header: parent, transactions: [] }, net.addressHrp)) {
        return reject(ErrCode.BAD_SIGNATURE, `${label} header is not a properly signed block`);
      }
    }

    // The conflict itself: same height, same round, different block.
    if (first.height !== second.height) return reject(ErrCode.MALFORMED, 'the two proposals are not at the same height');
    if (blockHash(first) === blockHash(second)) return reject(ErrCode.REPLAY, 'the two proposals are identical blocks');
    const firstRound = proposerRound(firstParent.timestamp, first.timestamp);
    const secondRound = proposerRound(secondParent.timestamp, second.timestamp);
    if (firstRound !== secondRound) return reject(ErrCode.MALFORMED, 'the two proposals are in different rounds; a later round may be legitimate');
    if (firstRound !== evidence.round) return reject(ErrCode.MALFORMED, 'the evidence round does not match the headers');

    const rebuilt = makeProposerEvidence({
      validator: first.producer,
      height: first.height,
      round: firstRound,
      firstId: blockHash(first),
      secondId: blockHash(second),
      firstHeader: evidence.firstHeader,
      secondHeader: evidence.secondHeader,
    });
    if (rebuilt.id !== evidence.id || rebuilt.height !== evidence.height || rebuilt.round !== evidence.round
      || rebuilt.messageType !== evidence.messageType
      || rebuilt.firstHeader !== evidence.firstHeader || rebuilt.secondHeader !== evidence.secondHeader) {
      return reject(ErrCode.MALFORMED, 'the proposer evidence is not in canonical form');
    }
    if (state.s.slashes.has(rebuilt.id)) return reject(ErrCode.REPLAY, 'this evidence has already been applied');
    height = rebuilt.height;
    round = rebuilt.round;
    signingKey = first.producerSignature.publicKey;
  } else {
    return reject(ErrCode.MALFORMED, 'unknown evidence type');
  }

  // The signing key must control the validator address the evidence names.
  try {
    if (addressFromPublicKey(signingKey, net.addressHrp) !== evidence.validator) {
      return reject(ErrCode.UNAUTHORIZED, 'the signing key does not control the validator address');
    }
  } catch {
    return reject(ErrCode.MALFORMED, 'the signing key is not a valid public key');
  }

  // Evidence can only punish behaviour that the chain already contains: an
  // equivocation "at" a height this chain has not reached is not verifiable.
  if (!Number.isSafeInteger(height) || height < 1) return reject(ErrCode.MALFORMED, 'the evidence height is not bounded');
  if (height > atHeight) return reject(ErrCode.NOT_YET_VALID, 'the evidence names a height the chain has not reached');
  if (!Number.isSafeInteger(round) || round < 0) return reject(ErrCode.MALFORMED, 'the evidence round is not bounded');
  if (validator.slashedAtHeight !== undefined) return reject(ErrCode.REPLAY, 'this registration has already been slashed');
  // The offence must belong to the registration that is bonded now. This is what
  // stops an unregistration from escaping a penalty, and equally what stops
  // evidence about an old tenure from charging a fresh, innocent registration
  // that happens to reuse the same key.
  if (!state.offenceChargesToCurrentRegistration(evidence.validator, height)) {
    return reject(
      ErrCode.UNAUTHORIZED,
      'the offence falls outside the tenure of the registration that is bonded now, so it cannot be charged to this bond',
    );
  }

  // BOTH halves of the accusation must independently be valid consensus votes,
  // judged by the SAME canonical predicate a node applies to a vote it receives
  // off the wire (consensus/finality-vote.ts). Not a second, shorter list of
  // rules: if the two ever disagreed, an accusation one code path relayed could
  // be one no node would act on, or one that confiscated a bond from a validator
  // whose votes were never valid here.
  //
  // The target block is NOT required. An offence is proven by two signatures
  // over conflicting blocks, cast by a member of a committee this node can
  // verify — and a node that never received the equivocated block must still be
  // able to recognise the offence, or an attacker would escape slashing simply
  // by withholding the block from some peers. What is unverifiable here is
  // reported as unknown and left unjudged, never turned into approval.
  if (votesToValidate !== null) {
    if (!consensus) {
      return reject(
        ErrCode.UNAUTHORIZED,
        'this node has no historical context for the vote evidence, so it cannot verify the accusation',
      );
    }
    for (const [index, vote] of votesToValidate.entries()) {
      const verdict = validateCanonicalFinalityVote(vote, consensus, {
        requireLocalAnchor: false,
        requireTargetBlock: false,
        allowUnknownTarget: true,
        // A bootstrap-form vote is still a signed vote by a bonded validator, so
        // it stays punishable: leaving it out would open a window in which
        // equivocation on the first checkpoints could not be charged at all.
        allowBootstrapTarget: true,
      });
      if (!verdict.ok && !verdict.unknown) {
        return reject(
          ErrCode.UNAUTHORIZED,
          `${index === 0 ? 'first' : 'second'} vote is not a valid consensus vote: ${verdict.message}`,
        );
      }
    }
  }

  const amount = slashAmountFor(bond);
  const remaining = bond - amount;
  if (amount <= 0n || amount >= bond || !slashSumsBack(amount, remaining, bond)) {
    return reject(ErrCode.MALFORMED, 'the configured slash ratio does not produce a valid penalty for this bond');
  }

  return {
    ok: true,
    evidenceId: evidence.id,
    type: evidence.type,
    validator: evidence.validator,
    height,
    round,
    bondBefore: bond,
    amount,
    remaining,
  };
}
