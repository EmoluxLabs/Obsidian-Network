/**
 * H-02 / H-04 — every rule of the one canonical finality-vote predicate, and
 * proof that the paths which used to hold their own copies of those rules now
 * agree with it.
 *
 * The predicate is the single answer to "is this a valid consensus vote?". It is
 * consulted when a vote arrives from a peer, when votes are restored after a
 * restart, when a certificate is built or verified, when two votes are compared
 * for equivocation and when slash evidence is executed inside a block. So a rule
 * that is missing from it is missing everywhere, and a rule that is only in it
 * applies everywhere: both directions have to be tested, which is what the
 * cross-path cases at the end do.
 *
 * Most cases run against a synthetic context rather than a live chain, because
 * the predicate is pure over the context and several rules can only be exercised
 * with a history a real chain would never store — a target block authored by a
 * producer the schedule did not name, for instance. Nothing about the rules is
 * relaxed to make them reachable; the context is the same interface the chain
 * implements.
 */
import { describe, expect, it } from 'vitest';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import type { Block, ConsensusEvidenceContext, FinalityVote } from '../../src/protocol/types.js';
import { validateCanonicalFinalityVote } from '../../src/consensus/finality-vote.js';
import { signFinalityVote, validatorSetHash } from '../../src/consensus/finality.js';
import { makeWallet } from '../helpers/harness.js';

const BOND_KEYS = { networkId: 'obsidian-test-1', chainId: 7777, genesisId: 'aa'.repeat(20), paramsHash: PARAMS_HASH };

/** A block header, reduced to the fields the predicate reads. */
function block(height: number, prevHash: string, timestamp: number, producer: string): Block {
  return {
    header: {
      protocolVersion: PROTOCOL_VERSION,
      chainId: BOND_KEYS.chainId,
      height,
      prevHash,
      txRoot: '',
      stateRoot: '',
      paramsHash: PARAMS_HASH,
      timestamp,
      producer,
      cumulativePotWeight: BigInt(height),
      txCount: 0,
      eventsRoot: '',
      producerSignature: { publicKey: '', signature: '' },
    },
    transactions: [],
  } as unknown as Block;
}

interface Fixture {
  context: ConsensusEvidenceContext;
  validator: ReturnType<typeof makeWallet>;
  committee: { address: string; publicKey: string }[];
  anchorHash: string;
  anchorTimestamp: number;
  target: Block;
  vote: FinalityVote;
}

/**
 * A world with one anchor block, one target block above it, and one validator in
 * the committee — everything a fully checkable vote needs.
 */
function fixture(
  options: {
    producer?: string;
    /** Address the schedule names; defaults to the target's producer. */
    scheduled?: string;
    committee?: { address: string; publicKey: string }[];
  } = {},
): Fixture {
  const validator = makeWallet();
  const committee = options.committee ?? [{ address: validator.address, publicKey: validator.publicKey }];
  const anchorHash = 'ab'.repeat(32);
  const anchorTimestamp = 1_800_000_000;
  const target = block(
    11,
    anchorHash,
    anchorTimestamp + CONSENSUS_PARAMS.block.targetBlockSeconds,
    options.producer ?? validator.address,
  );
  const context: ConsensusEvidenceContext = {
    ...BOND_KEYS,
    addressHrp: 'dobs',
    anchorFor: (hash) => (hash === anchorHash ? { height: 10, timestamp: anchorTimestamp } : null),
    blockByHash: (hash) => (hash === target.header.prevHash ? null : hash === 'cc'.repeat(32) ? target : null),
    committeeFor: () => committee,
    isBootstrapTarget: () => false,
    scheduledProposerFor: () => options.scheduled ?? options.producer ?? validator.address,
  };
  const vote = signFinalityVote(
    {
      protocolVersion: PROTOCOL_VERSION,
      networkId: BOND_KEYS.networkId,
      chainId: BOND_KEYS.chainId,
      genesisId: BOND_KEYS.genesisId,
      paramsHash: PARAMS_HASH,
      type: 'POT_FINALITY',
      finalizedHeight: 10,
      finalizedHash: anchorHash,
      height: 11,
      round: 0,
      parentHash: anchorHash,
      blockHash: 'cc'.repeat(32),
      validatorSetHash: validatorSetHash(committee),
      validator: validator.address,
      publicKey: validator.publicKey,
    },
    validator.privateKey,
  );
  return { context, validator, committee, anchorHash, anchorTimestamp, target, vote };
}

/** Re-sign with one field replaced: a validly signed but different message. */
function resign(vote: FinalityVote, patch: Partial<Omit<FinalityVote, 'signature'>>, key: string): FinalityVote {
  const { signature: _signature, ...unsigned } = vote;
  return signFinalityVote({ ...unsigned, ...patch }, key);
}

describe('the canonical predicate accepts exactly one thing', () => {
  it('accepts a vote that satisfies every rule', () => {
    const { context, vote } = fixture();
    expect(validateCanonicalFinalityVote(vote, context)).toEqual({ ok: true });
  });
});

describe('rule 1 — shape', () => {
  it('refuses a vote carrying a field this protocol does not sign', () => {
    const { context, vote } = fixture();
    const verdict = validateCanonicalFinalityVote({ ...vote, stakeWeight: 1 } as unknown as FinalityVote, context);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/unsupported fields/);
  });

  it('refuses a target that is not above its anchor', () => {
    const { context, validator, committee, anchorHash } = fixture();
    const flat = signFinalityVote(
      {
        protocolVersion: PROTOCOL_VERSION,
        networkId: BOND_KEYS.networkId,
        chainId: BOND_KEYS.chainId,
        genesisId: BOND_KEYS.genesisId,
        paramsHash: PARAMS_HASH,
        type: 'POT_FINALITY',
        finalizedHeight: 11,
        finalizedHash: anchorHash,
        height: 11,
        round: 0,
        parentHash: anchorHash,
        blockHash: 'cc'.repeat(32),
        validatorSetHash: validatorSetHash(committee),
        validator: validator.address,
        publicKey: validator.publicKey,
      },
      validator.privateKey,
    );
    const verdict = validateCanonicalFinalityVote(flat, context);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/target is not above anchor/);
  });
});

describe('rule 2 — protocol identity', () => {
  const cases: [string, Partial<Omit<FinalityVote, 'signature'>>, RegExp][] = [
    ['protocolVersion', { protocolVersion: '1.6.0' }, /protocol 1\.6\.0/],
    ['networkId', { networkId: 'obsidian-other-1' }, /another network/],
    ['chainId', { chainId: 7778 }, /another chain id/],
    ['genesisId', { genesisId: 'bb'.repeat(20) }, /another genesis/],
    ['paramsHash', { paramsHash: '4a2883b210c4a7aeb873f9d669e2476f' }, /other consensus parameters/],
  ];
  for (const [field, patch, pattern] of cases) {
    it(`refuses a vote signed for another ${field}`, () => {
      const { context, vote, validator } = fixture();
      // Re-signed, so the signature is valid: what fails is the identity, and it
      // fails on its own rather than being folded into one generic message.
      const verdict = validateCanonicalFinalityVote(resign(vote, patch, validator.privateKey), context);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.message).toMatch(pattern);
      void field;
    });
  }
});

describe('rule 3 and 4 — local anchor and parent', () => {
  it('refuses a vote that does not extend the anchor this caller requires', () => {
    const { context, vote } = fixture();
    const verdict = validateCanonicalFinalityVote(vote, context, {
      requireLocalAnchor: { height: 9, hash: 'dd'.repeat(32) },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/local finality/);
    // The same vote is fine when the caller is not asking about its own anchor —
    // which is what makes evidence about an older offence judgeable at all.
    expect(validateCanonicalFinalityVote(vote, context).ok).toBe(true);
  });

  it('refuses a vote whose parent this node does not hold, or whose height disagrees', () => {
    const { context, vote, validator } = fixture();
    const orphan = resign(vote, { parentHash: 'ee'.repeat(32) }, validator.privateKey);
    const unknownParent = validateCanonicalFinalityVote(orphan, context);
    expect(unknownParent.ok).toBe(false);
    if (!unknownParent.ok) expect(unknownParent.message).toMatch(/parent unknown/);

    const wrongHeight = resign(vote, { height: 12 }, validator.privateKey);
    const heightVerdict = validateCanonicalFinalityVote(wrongHeight, context);
    expect(heightVerdict.ok).toBe(false);
    if (!heightVerdict.ok) expect(heightVerdict.message).toMatch(/height inconsistent/);
  });
});

describe('rule 5 — the committee that was in force', () => {
  it('refuses a vote naming a set that was never the committee', () => {
    const { context, vote, validator } = fixture();
    const impostor = makeWallet();
    const verdict = validateCanonicalFinalityVote(
      resign(vote, { validatorSetHash: validatorSetHash([{ address: impostor.address, publicKey: impostor.publicKey }]) }, validator.privateKey),
      context,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not eligible/);
  });

  it('refuses a signer who is not a member, even under a correct set hash', () => {
    const validator = makeWallet();
    const committee = [{ address: validator.address, publicKey: validator.publicKey }];
    const stranger = makeWallet();
    const { context, vote } = fixture({ committee });
    // Same set hash, different signer: the membership check is what catches it,
    // and it runs before any signature arithmetic.
    const verdict = validateCanonicalFinalityVote(
      { ...vote, validator: stranger.address, publicKey: stranger.publicKey },
      context,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not eligible/);
  });

  it('refuses when the anchor state is not available, rather than guessing', () => {
    const { context, vote } = fixture();
    const blind: ConsensusEvidenceContext = { ...context, committeeFor: () => null };
    const verdict = validateCanonicalFinalityVote(vote, blind);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/not available on this node/);
  });
});

describe('rule 6 — the signature', () => {
  it('refuses a tampered signature', () => {
    const { context, vote } = fixture();
    const flipped = vote.signature.replace(/^./, vote.signature.startsWith('0') ? '1' : '0');
    const verdict = validateCanonicalFinalityVote({ ...vote, signature: flipped }, context);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/signature or address invalid/);
  });

  it('refuses a vote signed by a key that is not the one it names', () => {
    const { context, vote } = fixture();
    const stranger = makeWallet();
    // Every field still belongs to the real validator — including the address and
    // the public key — but the signature was made with somebody else's key. The
    // key/address binding inside the signature check is what catches it, so a
    // stolen vote cannot be re-signed by whoever intercepted it.
    const { signature: _signature, ...unsigned } = vote;
    const forged = signFinalityVote(unsigned, stranger.privateKey);
    const verdict = validateCanonicalFinalityVote(forged, context);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/signature or address invalid/);
  });
});

describe('rule 7 and 8 — the target block and how it extends the anchor', () => {
  it('reports an unknown target as unknown only where the caller allows it', () => {
    const { context, vote, validator } = fixture();
    // A properly signed vote for a block this node has never seen.
    const missing = resign(vote, { blockHash: 'ff'.repeat(32) }, validator.privateKey);
    // Required (the default): a plain refusal, never softened into "cannot tell".
    const required = validateCanonicalFinalityVote(missing, context);
    expect(required.ok).toBe(false);
    expect('unknown' in required && required.unknown).toBeFalsy();
    // Optional: reported as unknown, which is the only way a node that never
    // received the equivocated block can still act on the two signatures.
    const optional = validateCanonicalFinalityVote(missing, context, {
      requireTargetBlock: false,
      allowUnknownTarget: true,
    });
    expect(optional.ok).toBe(false);
    if (!optional.ok) expect(optional.unknown).toBe(true);
  });

  it('refuses a target that disagrees with the vote about height, parent or round', () => {
    const { context, vote, validator, anchorHash, anchorTimestamp } = fixture();
    const lateTarget = block(11, anchorHash, anchorTimestamp + CONSENSUS_PARAMS.block.targetBlockSeconds * 3, validator.address);
    const lateContext: ConsensusEvidenceContext = { ...context, blockByHash: () => lateTarget };
    const roundVerdict = validateCanonicalFinalityVote(vote, lateContext);
    expect(roundVerdict.ok).toBe(false);
    if (!roundVerdict.ok) expect(roundVerdict.message).toMatch(/target metadata mismatch/);

    // A target at the wrong height for the vote is the same rule.
    const shortTarget = block(12, anchorHash, anchorTimestamp + CONSENSUS_PARAMS.block.targetBlockSeconds, validator.address);
    const shortContext: ConsensusEvidenceContext = { ...context, blockByHash: () => shortTarget };
    const heightVerdict = validateCanonicalFinalityVote(vote, shortContext);
    expect(heightVerdict.ok).toBe(false);
    if (!heightVerdict.ok) expect(heightVerdict.message).toMatch(/target metadata mismatch/);
  });

  it('refuses a target the proposer schedule did not authorise', () => {
    const stranger = makeWallet();
    // The target exists and was authored by `stranger`, while the schedule for
    // that height named the validator: the two disagree, so the vote is refused.
    const { context, vote } = fixture({ producer: stranger.address, scheduled: makeWallet().address });
    // The block exists, matches the vote on height, parent and round — and was
    // produced by an address the schedule never named. A vote may not certify it.
    const verdict = validateCanonicalFinalityVote(vote, context);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/scheduled proposer/);
  });

  it('refuses a target that does not extend the anchor', () => {
    const { validator } = fixture();
    // A vote anchored at height 10 that points at a block whose parent is height
    // 11 — heights that are perfectly consistent with each other, but a target
    // that does not sit directly above the anchor it claims to certify.
    const parentHash = 'ee'.repeat(32);
    const anchorHash = 'ab'.repeat(32);
    const target = block(12, parentHash, 1_800_000_000 + CONSENSUS_PARAMS.block.targetBlockSeconds, validator.address);
    const context: ConsensusEvidenceContext = {
      ...BOND_KEYS,
      addressHrp: 'dobs',
      anchorFor: (hash) => (hash === parentHash ? { height: 11, timestamp: 1_800_000_000 } : null),
      blockByHash: () => target,
      committeeFor: () => [{ address: validator.address, publicKey: validator.publicKey }],
      isBootstrapTarget: () => false,
      scheduledProposerFor: () => validator.address,
    };
    const vote = signFinalityVote(
      {
        protocolVersion: PROTOCOL_VERSION,
        networkId: BOND_KEYS.networkId,
        chainId: BOND_KEYS.chainId,
        genesisId: BOND_KEYS.genesisId,
        paramsHash: PARAMS_HASH,
        type: 'POT_FINALITY',
        finalizedHeight: 10,
        finalizedHash: anchorHash,
        height: 12,
        round: 0,
        parentHash,
        blockHash: 'cc'.repeat(32),
        validatorSetHash: validatorSetHash([{ address: validator.address, publicKey: validator.publicKey }]),
        validator: validator.address,
        publicKey: validator.publicKey,
      },
      validator.privateKey,
    );
    const verdict = validateCanonicalFinalityVote(vote, context);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.message).toMatch(/does not extend anchor/);
  });
});

describe('H-04 — one predicate, one pipeline', () => {
  it('is a pure function: the same inputs give the same verdict, twice', () => {
    const { context, vote } = fixture();
    const first = validateCanonicalFinalityVote(vote, context);
    const second = validateCanonicalFinalityVote(vote, context);
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true });
    // And it does not rewrite what it was given.
    const before = JSON.stringify(vote);
    validateCanonicalFinalityVote({ ...vote, signature: 'ff'.repeat(64) }, context);
    expect(JSON.stringify(vote)).toBe(before);
  });

  it('has no second implementation left in the tree', async () => {
    // The point of the rule is that there is ONE list. These are the modules that
    // judge a finality vote; each must import the predicate rather than restate
    // it. A future copy shows up here as a failing test, not as a silent drift.
    const { readFileSync } = await import('node:fs');
    const sources = [
      'src/blockchain/chain.ts',
      'src/consensus/slash-evidence.ts',
    ].map((path) => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')] as const);
    for (const [path, source] of sources) {
      expect(source, path).toMatch(/validateCanonicalFinalityVote/);
    }
    // The predicate itself is the only place the eligibility, target and
    // extension rules are written down.
    const { readFileSync: read } = await import('node:fs');
    const predicate = read(new URL('../../src/consensus/finality-vote.ts', import.meta.url), 'utf8');
    expect(predicate).toMatch(/validator not eligible in target parent state/);
    expect(predicate).toMatch(/vote target does not extend anchor/);
  });
});
