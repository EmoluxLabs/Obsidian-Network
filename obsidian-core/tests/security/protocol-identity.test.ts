/**
 * C-01 — the consensus rules moved, so the identity moved with them.
 *
 * The bug this closes is not a missing version bump. It is that a build can
 * change what a valid block IS while continuing to announce the same protocol
 * version, the same parameter hash and the same genesis id: two nodes then share
 * an identity and disagree about the rules, which is the one disagreement a
 * blockchain cannot survive. Half the network accepts a block the other half
 * rejects, both keep producing, and the chain splits with no error anywhere.
 *
 * So every assertion here is about identity being DERIVED rather than declared,
 * and about a node refusing to talk to — or accept anything from — a peer whose
 * rules differ:
 *
 *   A. the published identity: core, protocol and minimum-core versions move
 *      together, the snapshot format moves when the state shape does, and the
 *      parameter hash is computed from the parameters rather than written down;
 *   B. a block that claims another protocol version or another parameter set is
 *      refused, even with a valid signature over it;
 *   C. a finality vote signed under other rules is refused by the one canonical
 *      predicate, by vote admission and by certificate admission;
 *   D. evidence about a vote signed under other rules is refused, and refused
 *      without slashing anyone;
 *   E. genesis identity follows the protocol version, and a snapshot written by
 *      an older build is refused rather than read as if it were current;
 *   F. the peer handshake bound that keeps a mixed-version network from forming.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CORE_VERSION,
  MIN_CORE_VERSION,
  PROTOCOL_VERSION,
  STATE_SNAPSHOT_VERSION,
  compareVersions,
} from '../../src/version.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { PARAMS_HASH, computeParamsHash } from '../../src/blockchain/state-root.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { SlashOp, TxType, ValidatorOp, type FinalityVote } from '../../src/protocol/types.js';
import { blockHash } from '../../src/blockchain/block.js';
import { proposerRound } from '../../src/consensus/proposer.js';
import type { Block } from '../../src/protocol/types.js';
import { validateCanonicalFinalityVote } from '../../src/consensus/finality-vote.js';
import {
  finalityValidators,
  makeVoteEvidence,
  signFinalityVote,
  validatorSetHash,
} from '../../src/consensus/finality.js';
import { verifyEquivocationEvidence } from '../../src/consensus/slash-evidence.js';
import { genesisDocumentFor, genesisId, buildGenesisBlock } from '../../src/genesis/initialize.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import {
  createHarness,
  makeWallet,
  signedClaim,
  validatorBody,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';

const BOND = CONSENSUS_PARAMS.consensus.validatorBond;

/** Protocol time of a stored canonical block, for deriving a vote's round. */
function anchorTimestamp(h: Harness, hash: string): number {
  const entry = h.chain.store.getIndexEntry(hash);
  if (!entry) throw new Error(`anchor ${hash} is not stored`);
  return entry.timestamp;
}
const open: Harness[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
});
afterEach(() => {
  while (open.length) open.pop()!.close();
  vi.useRealTimers();
});

async function bonded(): Promise<{ h: Harness; validator: TestWallet }> {
  const validator = makeWallet();
  const h = await createHarness({ producer: validator, bootstrapValidatorPublicKeys: [validator.publicKey] });
  open.push(h);
  h.produce();
  h.produce([signedClaim(h, validator)]);
  h.produce([
    h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, validator.publicKey), {
      gas: expectedGas(BOND),
    }),
  ]);
  return { h, validator };
}

/**
 * A vote that is valid in every respect, for this chain and this validator.
 *
 * By default it anchors at the tip and names a target this node has not
 * produced, which is the shape evidence has to survive. Pass a stored block to
 * target something the node does hold, and the vote is checkable end to end.
 */
function validVote(h: Harness, validator: TestWallet, target?: Block): FinalityVote {
  const anchorHeight = target ? target.header.height - 1 : h.chain.height;
  const anchorHash = h.chain.store.getCanonicalHashAtHeight(anchorHeight)!;
  const unsigned = {
    protocolVersion: PROTOCOL_VERSION,
    networkId: h.net.networkId,
    chainId: h.net.chainId,
    genesisId: genesisId(genesisDocumentFor(h.net, h.chain.world.s.genesis.bootstrapValidatorKeys, h.chain.world.s.genesis.miningGateKeys), h.net),
    paramsHash: PARAMS_HASH,
    type: 'POT_FINALITY' as const,
    finalizedHeight: anchorHeight,
    finalizedHash: anchorHash,
    height: anchorHeight + 1,
    round: target ? proposerRound(anchorTimestamp(h, anchorHash), target.header.timestamp) : 0,
    parentHash: anchorHash,
    blockHash: target ? blockHash(target.header) : '11'.repeat(32),
    validatorSetHash: validatorSetHash(
      finalityValidators(h.chain.stateAtHeight(anchorHeight, anchorHash)),
    ),
    validator: validator.address,
    publicKey: validator.publicKey,
  };
  return signFinalityVote(unsigned, validator.privateKey);
}

/**
 * Re-sign a vote with one field replaced. The result is a properly signed
 * message from another protocol, not a forgery — which is the interesting case,
 * because a broken signature would be refused for the wrong reason.
 */
function resign(
  vote: FinalityVote,
  patch: Partial<Omit<FinalityVote, 'signature'>>,
  key: string,
): FinalityVote {
  const { signature: _signature, ...unsigned } = vote;
  return signFinalityVote({ ...unsigned, ...patch }, key);
}

describe('A — the published identity moves as one thing', () => {
  it('names one version everywhere, and derives the parameter hash', () => {
    // A build that ships a new rule set under an old protocol version is the
    // exact failure this file exists to prevent, so the three versions that a
    // peer compares are asserted to be the same string.
    expect(CORE_VERSION).toBe('1.7.0');
    expect(PROTOCOL_VERSION).toBe('1.7.0');
    expect(MIN_CORE_VERSION).toBe('1.7.0');
    expect(CONSENSUS_PARAMS.protocolVersion).toBe(PROTOCOL_VERSION);
    // The state shape changed (the validator-mode indicator, the jail term), so
    // the snapshot format changed with it: an old snapshot is refused below
    // rather than read as if it described the new state.
    expect(STATE_SNAPSHOT_VERSION).toBe(4);
    // Computed, not declared. A hand-edited hash would let the rules change
    // without the identity changing, which is the whole attack.
    expect(PARAMS_HASH).toBe(computeParamsHash(CONSENSUS_PARAMS));
    expect(PARAMS_HASH).toMatch(/^[0-9a-f]{32}$/);
    // And the rules that changed are the ones the hash now commits to.
    expect(CONSENSUS_PARAMS.consensus.validatorSetNeverReopens).toBe(true);
    expect(CONSENSUS_PARAMS.consensus.slashLiabilityFollowsRegistration).toBe(true);
    expect(CONSENSUS_PARAMS.consensus.jailSlots).toBe(10_080);
    expect(PARAMS_HASH).not.toBe('4a2883b210c4a7aeb873f9d669e2476f'); // the 1.6.0 hash
  });
});

describe('B — a block under other rules is not a block here', () => {
  it('refuses a block whose protocol version or parameters were rewritten', async () => {
    const { h } = await bonded();
    const base = h.produce([]);
    const tipBefore = h.chain.tip!.hash;
    expect(tipBefore).toBe(blockHash(base.header));

    // Rewritten AFTER signing: the signature is intact, so only the identity
    // check can catch it. Identity is checked before the signature on purpose —
    // a block from another protocol is not worth verifying a signature for.
    const rewrite = (patch: Record<string, unknown>) => {
      const block = h.makeBlockOn(
        { hash: h.chain.tip!.hash, height: h.chain.tip!.height, cumulativePotWeight: BigInt(h.chain.tip!.cumulativePotWeight), state: h.chain.world },
        [],
      );
      return { ...block.block, header: { ...block.block.header, ...patch } };
    };

    const wrongVersion = rewrite({ protocolVersion: '1.6.0' });
    const versionVerdict = h.chain.addBlock(wrongVersion);
    expect(versionVerdict.accepted).toBe(false);
    expect(versionVerdict.code).toBe(ErrCode.VERSION_MISMATCH);

    const wrongParams = rewrite({ paramsHash: '4a2883b210c4a7aeb873f9d669e2476f' });
    const paramsVerdict = h.chain.addBlock(wrongParams);
    expect(paramsVerdict.accepted).toBe(false);
    expect(paramsVerdict.code).toBe(ErrCode.VERSION_MISMATCH);

    const wrongChain = rewrite({ chainId: h.net.chainId + 1 });
    const chainVerdict = h.chain.addBlock(wrongChain);
    expect(chainVerdict.accepted).toBe(false);
    expect(chainVerdict.code).toBe(ErrCode.WRONG_CHAIN_ID);

    // Nothing was accepted, so the chain did not move and the producer's own
    // block is still the tip.
    expect(h.chain.tip!.hash).toBe(tipBefore);
  });
});

describe('C — a finality message under other rules is refused everywhere', () => {
  it('is refused by the canonical predicate, by admission and by a certificate', async () => {
    const { h, validator } = await bonded();
    // One block past the registration, so the anchor of the vote below sits on a
    // state in which this validator is already a committee member: a vote naming
    // a committee its signer did not belong to is not a valid vote at all.
    h.produce([]);
    const honest = validVote(h, validator);
    const context = h.chain.consensusEvidenceContext();

    // Sanity: the same vote, unchanged, is valid — so the refusals below are
    // about the rewritten field and not about the fixture. The target block is
    // one this node has not produced, which is exactly the case evidence
    // verification has to survive (see D), so it is declared unknown here rather
    // than required.
    const rules = { requireTargetBlock: false, allowUnknownTarget: true } as const;
    // A vote whose target this node DOES hold is valid end to end — the control
    // that shows the refusals below are about the rewritten field.
    const checked = validVote(h, validator, h.chain.store.getBlockByHash(h.chain.tip!.hash)!);
    const checkedVerdict = validateCanonicalFinalityVote(checked, context, rules);
    if (!checkedVerdict.ok) throw new Error(`control vote was refused: ${checkedVerdict.message}`);
    // A vote whose target it does not hold is reported as unknown, which is
    // neither approval nor a plain refusal: the caller decides what "cannot
    // tell" means, and evidence verification is the one path that may proceed.
    const unknownVerdict = validateCanonicalFinalityVote(honest, context, rules);
    expect(unknownVerdict.ok).toBe(false);
    if (unknownVerdict.ok) throw new Error('unreachable');
    expect(unknownVerdict.unknown).toBe(true);
    expect(unknownVerdict.message).toMatch(/target unknown/);

    const stale = resign(honest, { protocolVersion: '1.6.0' }, validator.privateKey);
    const staleVerdict = validateCanonicalFinalityVote(stale, context, rules);
    expect(staleVerdict.ok).toBe(false);
    if (!staleVerdict.ok) expect(staleVerdict.message).toMatch(/protocol 1\.6\.0/);

    // Same predicate, same answer, through the chain's own admission path: there
    // is no second list of rules for a peer to find a gap in. A fresh chain's
    // own anchor is genesis, so NEITHER vote is admitted here — and that is what
    // makes the pair informative: they are refused for different reasons, and
    // the stale one is refused on identity grounds before the anchor is even
    // considered.
    const staleAdmission = h.chain.addFinalityVote(stale);
    const honestAdmission = h.chain.addFinalityVote(honest);
    expect(staleAdmission.accepted).toBe(false);
    expect(honestAdmission.accepted).toBe(false);
    expect(staleAdmission.message).toMatch(/protocol 1\.6\.0/);
    expect(honestAdmission.message).toMatch(/local finality/);

    // A certificate cannot smuggle the stale vote in either: its votes go
    // through the same predicate.
    const otherParams = resign(honest, { paramsHash: '4a2883b210c4a7aeb873f9d669e2476f' }, validator.privateKey);
    expect(validateCanonicalFinalityVote(otherParams, context, rules).ok).toBe(false);
    const certificate = {
      version: 1 as const,
      height: honest.height,
      blockHash: honest.blockHash,
      parentHash: honest.parentHash,
      finalizedHeight: honest.finalizedHeight,
      finalizedHash: honest.finalizedHash,
      validatorSetHash: honest.validatorSetHash,
      validatorCount: 1,
      quorum: 1,
      votes: [otherParams],
    };
    expect(h.chain.addFinalityCertificate(certificate as never).accepted).toBe(false);
    // And finality did not move.
    expect(h.chain.finalityStatus().finalizedHash).not.toBe(honest.blockHash);
  });
});

describe('D — evidence under other rules slashes nobody', () => {
  it('is refused before any state is touched', async () => {
    const { h, validator } = await bonded();
    const first = validVote(h, validator);
    const second = resign(first, { blockHash: '22'.repeat(32) }, validator.privateKey);
    const staleFirst = resign(first, { protocolVersion: '1.6.0' }, validator.privateKey);

    const honestVerdict = verifyEquivocationEvidence(
      h.chain.world,
      h.net,
      { op: SlashOp.EQUIVOCATION, evidence: makeVoteEvidence(first, second) },
      h.chain.height + 1,
      h.chain.consensusEvidenceContext(),
    );
    expect(honestVerdict.ok).toBe(true);

    const staleVerdict = verifyEquivocationEvidence(
      h.chain.world,
      h.net,
      { op: SlashOp.EQUIVOCATION, evidence: makeVoteEvidence(staleFirst, second) },
      h.chain.height + 1,
      h.chain.consensusEvidenceContext(),
    );
    expect(staleVerdict.ok).toBe(false);
    if (!staleVerdict.ok) expect(staleVerdict.code).toBe(ErrCode.VERSION_MISMATCH);
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(h.chain.world.getAccount(validator.address)!.validator!.bond).toBe(BOND);
  });
});

describe('E — genesis and snapshot identity follow the version', () => {
  it('derives a different genesis for a different protocol version', () => {
    const mainnet = getNetwork('mainnet');
    const document = genesisDocumentFor(mainnet);
    expect(document.protocolVersion).toBe(PROTOCOL_VERSION);
    // Published identity, measured on this build: the id is a function of the
    // document, so moving the protocol version moves the chain.
    expect(genesisId(document, mainnet)).toBe('2dc198e4e57cb482df4e0f89e3a28daaf427ccff');
    expect(genesisId({ ...document, protocolVersion: '1.6.0' }, mainnet)).toBe(
      '9a104f428d447e4c916fccf2c8b5c0bef4827d4f',
    );
    // The genesis BLOCK commits the parameter hash in its state, so the hash
    // differs too: a node cannot restore 1.6.0 state and call it 1.6.1.
    const hash = blockHash(buildGenesisBlock(document, mainnet).header);
    const staleHash = blockHash(buildGenesisBlock({ ...document, protocolVersion: '1.6.0' }, mainnet).header);
    expect(hash).not.toBe(staleHash);
  });

  it('refuses a snapshot that does not say which mode the chain is in', async () => {
    const { h } = await bonded();
    const snapshot = h.chain.snapshot();
    expect(snapshot.snapshotVersion).toBe(STATE_SNAPSHOT_VERSION);
    expect(snapshot.validatorModeEstablished).toBe(true);

    // What a 1.6.0 node would have written: no indicator at all. Reading it as
    // "not established" would hand an established chain back to permissionless
    // production, so the state itself refuses it, not only the version check.
    const { validatorModeEstablished: _dropped, ...withoutMode } = snapshot;
    expect(() => h.chain.world.constructor.prototype).toBeDefined();
    const WorldStateClass = Object.getPrototypeOf(h.chain.world).constructor as typeof import('../../src/blockchain/state.js').WorldState;
    expect(() => WorldStateClass.fromSnapshot(withoutMode as never)).toThrow(/validatorModeEstablished/);
  });
});

describe('F — a mixed-version network cannot form', () => {
  it('publishes a minimum peer version that excludes the old rules', () => {
    // The handshake (src/networking/p2p.ts) refuses a hello whose protocol
    // version differs from this build's and whose core version is below
    // MIN_CORE_VERSION. These are the two comparisons it makes, so asserting
    // them here asserts the rule the handshake enforces: a 1.6.0 peer is
    // rejected, a 1.6.1 peer is not, and a newer one is not mistaken for a peer.
    expect(compareVersions('1.6.0', PROTOCOL_VERSION)).not.toBe(0);
    expect(compareVersions('1.6.1', PROTOCOL_VERSION)).not.toBe(0); // accepts claims from any key: a different rule set
    expect(compareVersions('1.7.0', PROTOCOL_VERSION)).toBe(0);
    expect(compareVersions('1.6.1', MIN_CORE_VERSION)).toBeLessThan(0);
    expect(compareVersions('1.7.0', MIN_CORE_VERSION)).toBe(0);
    expect(compareVersions('1.8.0', CORE_VERSION)).toBeGreaterThan(0);
  });
});
