/**
 * C-01 — the consensus rules moved, so the identity moved with them (protocol 2.0.0).
 *
 * The bug this closes is not a missing version bump. It is that a build can change what a valid block IS while
 * continuing to announce the same protocol version, the same parameter hash and the same genesis id: two nodes then
 * share an identity and disagree about the rules, which is the one disagreement a blockchain cannot survive.
 *
 * Protocol 1.9.0 removes validators, bonds and finality votes altogether. A v1.8.x node therefore holds a chain that
 * 1.9.0 cannot even interpret, and the rule is a fresh start: nothing is migrated. So every assertion here is about
 * identity being DERIVED rather than declared, and about a node refusing to talk to — or accept anything from — a peer
 * whose rules differ:
 *
 *   A. the published identity: core, protocol and minimum-core versions move together, the snapshot format moved
 *      with the state shape, and the parameter hash is computed from the parameters rather than written down;
 *   B. a block that claims another protocol version or another parameter set is refused, even with a valid signature;
 *   C. the validator-era surface is gone: no validator tx type, no finality votes, no certificates;
 *   D. evidence under other rules bans nobody;
 *   E. genesis identity follows the protocol version, and a snapshot written by an older build is refused;
 *   F. the peer handshake bound that keeps a mixed-version network from forming.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
import { NodeRegistryOp, TxType } from '../../src/protocol/types.js';
import { WorldState } from '../../src/blockchain/state.js';
import { blockHash } from '../../src/blockchain/block.js';
import { genesisDocumentFor, genesisId, buildGenesisBlock } from '../../src/genesis/initialize.js';
import { getNetwork } from '../../src/protocol/networks.js';
import {
  createHarness,
  makeNode,
  makeWallet,
  nodeSigner,
  nodeStatement,
  registerNode,
  type Harness,
} from '../helpers/harness.js';

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}

const OLD_HASHES = [
  '4a2883b210c4a7aeb873f9d669e2476f', // 1.6.0
  'bffeacb35532ba3df70cda8c27ed6c96', // 1.7.0: gate authority moved it
  '38dd9243481cd35a68003648e2710001', // 1.9.0: the Marketplace parameters moved it
];

describe('A — the published identity moves as one thing', () => {
  it('names one version everywhere, and derives the parameter hash', () => {
    expect(CORE_VERSION).toBe('2.0.4');
    expect(PROTOCOL_VERSION).toBe('2.0.2');
    // A software patch moves the core version and leaves the protocol alone (the protocol is part of every genesis id): 2.0.4 is
    // the same network as 2.0.2, and it is not older than the oldest software that speaks these rules.
    expect(compareVersions(CORE_VERSION, PROTOCOL_VERSION)).toBeGreaterThanOrEqual(0);
    expect(compareVersions(CORE_VERSION, MIN_CORE_VERSION)).toBeGreaterThanOrEqual(0);
    // 2.0.2 is a hard boundary: the oldest software that speaks these rules is 2.0.2 itself (2.0.1 accepts a one-seal payment for no gas and blocks dated a minute ahead; 2.0.0 also accepts a registration inside the grace period and non-canonical addresses).
    expect(MIN_CORE_VERSION).toBe('2.0.2');
    expect(CONSENSUS_PARAMS.protocolVersion).toBe(PROTOCOL_VERSION);
    // The state shape changed (Marketplace listings, offers and escrow on top of the 1.9.0 node registry, finality and ONS transfer state), so the snapshot format changed.
    expect(STATE_SNAPSHOT_VERSION).toBe(7);
    // Computed, not declared. A hand-edited hash would let the rules change without the identity changing.
    expect(PARAMS_HASH).toBe(computeParamsHash(CONSENSUS_PARAMS));
    expect(PARAMS_HASH).toMatch(/^[0-9a-f]{32}$/);
    for (const old of OLD_HASHES) expect(PARAMS_HASH).not.toBe(old);
    // The parameters that define the new rules are the ones the hash commits to.
    expect(CONSENSUS_PARAMS.consensus.producers.maturityBlocks).toBeGreaterThan(0);
    expect(CONSENSUS_PARAMS.miningGate.maxRevoked).toBe(64);
  });

  it('commits to the producer and finality parameters: changing one changes the hash', () => {
    const changed = structuredClone(CONSENSUS_PARAMS) as typeof CONSENSUS_PARAMS;
    (changed.consensus.producers as { maturityBlocks: number }).maturityBlocks += 1;
    expect(computeParamsHash(changed)).not.toBe(PARAMS_HASH);
    const rewards = structuredClone(CONSENSUS_PARAMS) as typeof CONSENSUS_PARAMS;
    (rewards.nodeRewards as { minUptimeBps: number }).minUptimeBps += 1;
    expect(computeParamsHash(rewards)).not.toBe(PARAMS_HASH);
  });
});

describe('B — a block under other rules is not a block here', () => {
  it('refuses a block whose protocol version or parameters were rewritten', async () => {
    const h = await harness();
    const base = h.produce([]);
    const tipBefore = h.chain.tip!.hash;
    expect(tipBefore).toBe(blockHash(base.header));

    // Rewritten AFTER signing: the signature is intact, so only the identity check can catch it. Identity is checked
    // before the signature on purpose — a block from another protocol is not worth verifying a signature for.
    const rewrite = (patch: Record<string, unknown>) => {
      const built = h.makeBlockOn(
        { hash: h.chain.tip!.hash, height: h.chain.tip!.height, cumulativePotWeight: BigInt(h.chain.tip!.cumulativePotWeight), state: h.chain.world },
        [],
      );
      return { ...built.block, header: { ...built.block.header, ...patch } };
    };

    for (const old of ['1.9.0', '1.8.2', '1.8.0', '1.6.0']) {
      const verdict = h.chain.addBlock(rewrite({ protocolVersion: old }));
      expect(verdict.accepted, `protocol ${old}`).toBe(false);
      expect(verdict.code).toBe(ErrCode.VERSION_MISMATCH);
    }
    const paramsVerdict = h.chain.addBlock(rewrite({ paramsHash: OLD_HASHES[0] }));
    expect(paramsVerdict.accepted).toBe(false);
    expect(paramsVerdict.code).toBe(ErrCode.VERSION_MISMATCH);
    const chainVerdict = h.chain.addBlock(rewrite({ chainId: h.net.chainId + 1 }));
    expect(chainVerdict.accepted).toBe(false);
    expect(chainVerdict.code).toBe(ErrCode.WRONG_CHAIN_ID);
    // Nothing was accepted, so the chain did not move.
    expect(h.chain.tip!.hash).toBe(tipBefore);
  });
});

describe('C — the validator-era surface is gone', () => {
  it('has no validator transaction type, no bond parameter and no vote or certificate entry point', async () => {
    expect((TxType as Record<string, unknown>).VALIDATOR).toBeUndefined();
    expect((TxType as Record<string, unknown>).SLASH).toBeUndefined();
    const consensusParams = JSON.stringify(CONSENSUS_PARAMS.consensus);
    expect(consensusParams).not.toMatch(/validatorBond|slash|unbond|jail|committee|quorumBps/i);
    const h = await harness();
    const chain = h.chain as unknown as Record<string, unknown>;
    for (const gone of ['addFinalityVote', 'addFinalityCertificate', 'consensusEvidenceContext', 'scheduledProposerNow']) {
      expect(chain[gone], gone).toBeUndefined();
    }
    // A raw type number from the old protocol is simply not a transaction type any more.
    const stray = h.tryBlock([h.sign(makeWallet(), 9 as TxType, new Uint8Array([1]), { gas: 0n })], { simulate: false });
    expect(stray.accepted).toBe(false);
  });
});

describe('D — evidence under other rules bans nobody', () => {
  it('refuses an equivocation report built from headers of another protocol, before any state is touched', async () => {
    const h = await harness();
    const target = makeNode(makeWallet());
    const reporter = makeNode(makeWallet());
    h.produce([nodeStatement(h, target, { op: NodeRegistryOp.REGISTER }), nodeStatement(h, reporter, { op: NodeRegistryOp.REGISTER })]);
    h.signers.set(target.address, nodeSigner(target));
    h.signers.set(reporter.address, nodeSigner(reporter));
    const refused = h.tryBlock([
      nodeStatement(h, reporter, {
        op: NodeRegistryOp.REPORT_EQUIVOCATION,
        nodeId: target.nodeId,
        firstHeader: 'aa'.repeat(40),
        secondHeader: 'bb'.repeat(40),
      }),
    ]);
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe(ErrCode.EQUIVOCATION_INVALID);
    expect(h.chain.world.node(target.nodeId)!.bannedAtHeight).toBeUndefined();
    expect(h.chain.world.registeredNodes()).toHaveLength(2);
  });
});

describe('E — genesis and snapshot identity follow the version', () => {
  it('derives a different genesis for a different protocol version', () => {
    const mainnet = getNetwork('mainnet');
    const document = genesisDocumentFor(mainnet);
    expect(document.protocolVersion).toBe(PROTOCOL_VERSION);
    const id = genesisId(document, mainnet);
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    for (const old of ['1.9.0', '1.8.2', '1.8.0', '1.6.0']) {
      expect(genesisId({ ...document, protocolVersion: old }, mainnet)).not.toBe(id);
    }
    // The genesis BLOCK commits the parameter hash in its state, so a node cannot restore older state and call it 2.0.0.
    const hash = blockHash(buildGenesisBlock(document, mainnet).header);
    const staleHash = blockHash(buildGenesisBlock({ ...document, protocolVersion: '1.8.2' }, mainnet).header);
    expect(hash).not.toBe(staleHash);
  });

  it('refuses a snapshot written by a validator-era build rather than reading it as current', async () => {
    const h = await harness();
    h.produce([]);
    const snapshot = h.chain.snapshot();
    expect(snapshot.snapshotVersion).toBe(STATE_SNAPSHOT_VERSION);
    expect(Object.keys(snapshot)).not.toContain('validatorModeEstablished');
    expect(Object.keys(snapshot.genesis ?? {})).not.toContain('bootstrapValidatorKeys');

    // What a 1.8.x node wrote: no finality state, an old format number. Reading it as "nothing finalized yet"
    // would silently reset the finality floor, so the state itself refuses it, not only the version check.
    const { finality: _dropped, ...withoutFinality } = snapshot;
    expect(() => WorldState.fromSnapshot({ ...withoutFinality, snapshotVersion: 5 } as never)).toThrow(/finality state/);
    expect(() => WorldState.fromSnapshot(snapshot)).not.toThrow();
  });
});

describe('F — a mixed-version network cannot form', () => {
  it('publishes a minimum peer version that excludes every older rule set', () => {
    // The handshake (src/networking/p2p.ts) refuses a hello whose protocol version differs from this build's and whose
    // core version is below MIN_CORE_VERSION. These are the two comparisons it makes, so asserting them here asserts
    // the rule the handshake enforces: every validator-era peer is rejected.
    for (const old of ['1.6.0', '1.6.1', '1.7.0', '1.8.0', '1.8.1', '1.8.2', '1.9.0', '1.9.9', '2.0.0', '2.0.1']) {
      expect(compareVersions(old, PROTOCOL_VERSION), old).toBeLessThan(0);
      expect(compareVersions(old, MIN_CORE_VERSION), old).toBeLessThan(0);
    }
    expect(compareVersions('2.0.2', PROTOCOL_VERSION)).toBe(0);
    expect(compareVersions('2.0.2', MIN_CORE_VERSION)).toBe(0);
    expect(compareVersions('2.0.4', CORE_VERSION)).toBe(0);
    expect(compareVersions('2.0.5', CORE_VERSION)).toBeGreaterThan(0);
  });

  it('registers a node on the new network without any of the removed machinery', async () => {
    const h = await harness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    expect(h.chain.world.registeredNodes()).toHaveLength(1);
  });
});
