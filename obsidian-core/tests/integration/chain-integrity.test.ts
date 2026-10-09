/**
 * Chain-manager integrity: the defects found by the pre-launch audit that the
 * original suite could not see because its fork tests used empty blocks (two
 * different blocks that leave identical state look the same to every assertion).
 *
 * Each test here is written so that it FAILS on the code it was written
 * against, not merely passes on the fix:
 *   - siblings carry different transactions, so their states genuinely differ;
 *   - the canonical log is checked by inode, so a rewrite-per-block cannot hide;
 *   - restarts are real: a second ChainManager is opened on the same directory.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { blockHash } from '../../src/blockchain/block.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { TxType, ValidatorOp } from '../../src/protocol/types.js';
import { WorldState } from '../../src/blockchain/state.js';
import { missedProposersFor, proposerRound, scheduledProposer } from '../../src/consensus/proposer.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import {
  createHarness,
  forkParent,
  makeWallet,
  signedClaim,
  validatorBody,
  type Block,
  type ForkParent,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';

const GENESIS_TS = 1_767_225_600;

const open: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

interface BranchBlock {
  timestamp: number;
  txs?: Parameters<Harness['makeBlockOn']>[1];
  producer?: TestWallet;
}

/** Mine `blocks` on top of `from` WITHOUT touching the canonical chain's own producer. */
function mineBranch(h: Harness, from: ForkParent, blocks: BranchBlock[]): { tip: ForkParent; blocks: Block[] } {
  let parent = from;
  const mined: Block[] = [];
  for (const spec of blocks) {
    const built = h.makeBlockOn(parent, spec.txs ?? [], { timestamp: spec.timestamp, producer: spec.producer });
    const result = h.chain.addBlock(built.block);
    expect(result.accepted, `${result.code}: ${result.message}`).toBe(true);
    mined.push(built.block);
    parent = {
      hash: blockHash(built.block.header),
      height: built.block.header.height,
      cumulativePotWeight: built.block.header.cumulativePotWeight,
      state: built.state,
    };
  }
  return { tip: parent, blocks: mined };
}

function reopen(h: Harness): Promise<ChainManager> {
  const chain = new ChainManager({
    dataDir: h.dir,
    net: h.net,
    genesisDocument: h.chain.genesisDocument,
    enforceProposerRotation: true,
  });
  return chain.init().then(() => chain);
}

describe('a losing sibling must not poison the canonical state (C-6)', () => {
  it('still extends the canonical head after a lower-ranked sibling with different content arrived', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    for (let i = 1; i <= 3; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    // Canonical block 4 carries Alice's claim.
    h.produce([signedClaim(h, alice, GENESIS_TS + 4)], { timestamp: GENESIS_TS + 4 });
    const head = h.chain.tip!;

    // A sibling at height 4 carrying BOB's claim, tuned to lose the hash tie-break.
    const parent = forkParent(h, 3);
    let sibling: ReturnType<Harness['makeBlockOn']> | undefined;
    // A sibling must hash HIGHER than the head so it stays a side chain. The head's hash varies from run to run, so
    // a bound of 600 candidates failed about once in a few hundred runs when the head hash was unusually high.
    for (let t = 1; t < 20_000 && !sibling; t += 1) {
      const timestamp = GENESIS_TS + 100 + t;
      const built = h.makeBlockOn(parent, [signedClaim(h, bob, timestamp)], { timestamp });
      if (blockHash(built.block.header) > head.hash) sibling = built;
    }
    expect(sibling).toBeDefined();
    const result = h.chain.addBlock(sibling!.block);
    expect(result.accepted).toBe(true);
    expect(result.reorged).toBe(false);
    expect(h.chain.tip!.hash).toBe(head.hash);

    // The state a child of the canonical head is validated against is the
    // canonical head's, not the sibling's.
    const parentState = h.chain.stateAtHeight(4, head.hash);
    expect(parentState.getAccount(alice.address)).toBeDefined();
    expect(parentState.getAccount(bob.address)).toBeUndefined();

    // And the honest chain keeps moving.
    const next = h.tryBlock([], { timestamp: GENESIS_TS + 5 });
    expect(next.accepted, `${next.code}: ${next.message}`).toBe(true);
    expect(h.chain.world.getAccount(bob.address)).toBeUndefined();
  });
});

describe('the canonical log is append-only', () => {
  it('extends the chain by appending one record, never rewriting the file (O(1) per block)', async () => {
    const h = await harness();
    const path = join(h.dir, 'chain', 'canonical.jsonl');
    for (let i = 1; i <= 3; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const before = statSync(path);
    const linesBefore = readFileSync(path, 'utf8').trim().split('\n').length;
    for (let i = 4; i <= 9; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const after = statSync(path);
    // A rewrite replaces the file (new inode); an append keeps it.
    expect(after.ino).toBe(before.ino);
    expect(readFileSync(path, 'utf8').trim().split('\n').length).toBe(linesBefore + 6);
  });

  it('records a reorganisation as a marker plus the new tail, and a restart compacts it', async () => {
    const h = await harness();
    const alice = makeWallet();
    for (let i = 1; i <= 3; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const path = join(h.dir, 'chain', 'canonical.jsonl');
    const inode = statSync(path).ino;

    // A heavier branch from height 1 (Alice's claim makes block 2' heavier).
    const fork = mineBranch(h, forkParent(h, 1), [
      { timestamp: GENESIS_TS + 1_002, txs: [signedClaim(h, alice, GENESIS_TS + 1_002)] },
      { timestamp: GENESIS_TS + 1_003 },
      { timestamp: GENESIS_TS + 1_004 },
    ]);
    expect(h.chain.tip!.hash).toBe(blockHash(fork.blocks[2]!.header));
    expect(statSync(path).ino).toBe(inode);
    expect(readFileSync(path, 'utf8')).toContain('"reorgTo":1');

    // Restart: same head, same state, and the log is compacted.
    const restarted = await reopen(h);
    expect(restarted.tip!.hash).toBe(h.chain.tip!.hash);
    expect(restarted.stateRoot).toBe(h.chain.stateRoot);
    expect(restarted.world.getAccount(alice.address)).toBeDefined();
    expect(readFileSync(path, 'utf8')).not.toContain('reorgTo');
    expect(restarted.verifyIntegrity()).toEqual({ ok: true, problems: [] });
  });
});

describe('a snapshot from an abandoned branch is never used (restart after a reorg)', () => {
  it('rebuilds the state of the branch the node actually follows', async () => {
    const h = await harness();
    const alice = makeWallet();
    const bob = makeWallet();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    h.produce([], { timestamp: GENESIS_TS + 2 });
    h.produce([signedClaim(h, alice, GENESIS_TS + 3)], { timestamp: GENESIS_TS + 3 });
    // A snapshot of branch A, saved while branch A is canonical.
    (h.chain as unknown as { persistCheckpoint(force: boolean): void }).persistCheckpoint(true);

    // Branch B forks at height 1, carries BOB's claim instead, and outweighs A.
    mineBranch(h, forkParent(h, 1), [
      { timestamp: GENESIS_TS + 1_002, txs: [signedClaim(h, bob, GENESIS_TS + 1_002)] },
      { timestamp: GENESIS_TS + 1_003 },
      { timestamp: GENESIS_TS + 1_004 },
      { timestamp: GENESIS_TS + 1_005 },
    ]);
    expect(h.chain.world.getAccount(bob.address)).toBeDefined();
    expect(h.chain.world.getAccount(alice.address)).toBeUndefined();

    const restarted = await reopen(h);
    expect(restarted.stateRoot).toBe(h.chain.stateRoot);
    expect(restarted.world.getAccount(bob.address)).toBeDefined();
    expect(restarted.world.getAccount(alice.address)).toBeUndefined();
  });
});

describe('blocks that cannot matter are refused cheaply', () => {
  it('refuses a block that forks deeper than the protocol reorg limit before validating anything', async () => {
    const h = await harness();
    const depth = CONSENSUS_PARAMS.consensus.maxReorgDepth + 2;
    for (let i = 1; i <= depth; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const stale = h.makeBlockOn(forkParent(h, 1), [], { timestamp: GENESIS_TS + 5_000 });
    const result = h.chain.addBlock(stale.block);
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(ErrCode.STALE_BLOCK);
  });

  it('bounds the orphan pool in count, and does not queue blocks from the far future', async () => {
    const h = await harness();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    const template = h.makeBlock([], { timestamp: GENESIS_TS + 2 });
    for (let i = 0; i < 200; i += 1) {
      const orphan: Block = {
        header: {
          ...template.header,
          prevHash: i.toString(16).padStart(64, 'a'),
          timestamp: GENESIS_TS + 10 + i,
        },
        transactions: [],
      };
      const result = h.chain.addBlock(orphan);
      expect(result.code).toBe(ErrCode.ORPHAN_BLOCK);
    }
    expect(h.chain.orphanCount).toBeLessThanOrEqual(64);

    const before = h.chain.orphanCount;
    const farFuture: Block = {
      header: { ...template.header, height: h.chain.height + 5_000, prevHash: 'f'.repeat(64), timestamp: GENESIS_TS + 999 },
      transactions: [],
    };
    expect(h.chain.addBlock(farFuture).code).toBe(ErrCode.ORPHAN_BLOCK);
    expect(h.chain.orphanCount).toBe(before);
  });

  it('does not re-validate a side-chain block it already holds', async () => {
    const h = await harness();
    for (let i = 1; i <= 4; i += 1) h.produce([], { timestamp: GENESIS_TS + i });
    const head = h.chain.tip!;
    let sibling: Block | undefined;
    // A sibling must hash HIGHER than the head so it stays a side chain. The head's hash varies from run to run, so
    // a bound of 600 candidates failed about once in a few hundred runs when the head hash was unusually high.
    for (let t = 1; t < 20_000 && !sibling; t += 1) {
      const built = h.makeBlockOn(forkParent(h, 3), [], { timestamp: GENESIS_TS + 100 + t });
      if (blockHash(built.block.header) > head.hash) sibling = built.block;
    }
    expect(sibling, 'found a side-chain candidate that hashes above the head').toBeDefined();
    expect(h.chain.addBlock(sibling!).accepted).toBe(true);
    const again = h.chain.addBlock(sibling!);
    expect(again.accepted).toBe(false);
    expect(again.code).toBe(ErrCode.DUPLICATE_BLOCK);
  });
});

describe('transactions survive a reorganisation (C-5) and leave the pool when mined (H-10)', () => {
  it('returns a transaction from the losing branch to the pool, and drops it again once re-mined', async () => {
    const h = await harness();
    const bob = makeWallet();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    h.produce([], { timestamp: GENESIS_TS + 2 });
    const claim = signedClaim(h, bob, GENESIS_TS + 3);
    h.produce([claim], { timestamp: GENESIS_TS + 3 });
    expect(h.chain.world.getAccount(bob.address)!.nonce).toBe(1);

    // A heavier branch that does NOT contain the claim. (Timestamps stay inside
    // the claim's 600 s validity window, or re-mining it would be refused.)
    mineBranch(h, forkParent(h, 2), [
      { timestamp: GENESIS_TS + 103 },
      { timestamp: GENESIS_TS + 104 },
    ]);
    expect(h.chain.world.getAccount(bob.address)).toBeUndefined();
    expect(h.chain.mempool.has(claim.id)).toBe(true);

    // Mined again: it must leave the pool.
    h.produce([claim], { timestamp: GENESIS_TS + 105 });
    expect(h.chain.world.getAccount(bob.address)!.nonce).toBe(1);
    expect(h.chain.mempool.has(claim.id)).toBe(false);
  });

  it('does not re-queue a transaction the winning branch already includes', async () => {
    const h = await harness();
    const bob = makeWallet();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    h.produce([], { timestamp: GENESIS_TS + 2 });
    const claim = signedClaim(h, bob, GENESIS_TS + 3);
    h.produce([claim], { timestamp: GENESIS_TS + 3 });

    mineBranch(h, forkParent(h, 2), [
      { timestamp: GENESIS_TS + 103, txs: [claim] },
      { timestamp: GENESIS_TS + 104 },
    ]);
    expect(h.chain.world.getAccount(bob.address)!.nonce).toBe(1);
    expect(h.chain.mempool.has(claim.id)).toBe(false);
  });
});

describe('mempool admission and assembly', () => {
  it('rejects gossiped gas priority that the current sender balance cannot fund', async () => {
    const h = await harness();
    const attacker = makeWallet();
    const advertised = h.sign(attacker, TxType.GOVERNANCE, new Uint8Array(), { gas: 10_000n });
    expect(h.chain.checkGossipedTransaction(advertised)).toMatchObject({
      ok: false,
      code: ErrCode.INSUFFICIENT_FUNDS,
    });
  });

  it('evicts an invalid candidate after one assembly attempt instead of retrying it forever', async () => {
    const h = await harness();
    const attacker = makeWallet();
    const invalid = h.sign(attacker, TxType.GOVERNANCE, new Uint8Array(), { gas: 0n });
    expect(h.chain.mempool.add(invalid).accepted).toBe(true);
    expect(h.chain.mempool.has(invalid.id)).toBe(true);
    const block = h.chain.buildNextBlock(h.producer);
    expect(block).not.toBeNull();
    expect(block!.transactions).toEqual([]);
    expect(h.chain.mempool.has(invalid.id)).toBe(false);
  });
});

describe('validators', () => {
  async function fundedValidatorHarness(): Promise<{ h: Harness; alice: TestWallet }> {
    const h = await harness();
    const alice = makeWallet();
    h.produce([signedClaim(h, alice, GENESIS_TS + 1)], { timestamp: GENESIS_TS + 1 });
    const bond = CONSENSUS_PARAMS.consensus.validatorBond;
    h.produce(
      [
        h.sign(alice, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, bond, alice.publicKey), {
          gas: expectedGas(bond),
          protocolTime: GENESIS_TS + 2,
        }),
      ],
      { timestamp: GENESIS_TS + 2 },
    );
    expect(h.chain.world.activeValidators()).toEqual([alice.address]);
    return { h, alice };
  }

  it('cannot register over an unbonding record, which used to destroy the bond (C-2)', async () => {
    const { h, alice } = await fundedValidatorHarness();
    h.produce(
      [h.sign(alice, TxType.VALIDATOR, validatorBody(ValidatorOp.UNREGISTER, 0n, alice.publicKey), { gas: 0n, protocolTime: GENESIS_TS + 3 })],
      { timestamp: GENESIS_TS + 3, producer: alice },
    );
    expect(h.chain.world.getAccount(alice.address)!.validator!.status).toBe('UNBONDING');
    const bond = CONSENSUS_PARAMS.consensus.validatorBond;
    const again = h.tryBlock(
      [h.sign(alice, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, bond, alice.publicKey), { gas: expectedGas(bond), protocolTime: GENESIS_TS + 4 })],
      { timestamp: GENESIS_TS + 4 },
    );
    expect(again.accepted).toBe(false);
    expect(again.code).toBe(ErrCode.REPLAY);
    // The bond is still counted and the supply invariant still holds.
    expect(h.chain.world.getAccount(alice.address)!.validator!.bond).toBe(bond);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('never lets an unregistered key use a timeout round to bypass the validator set', async () => {
    const { h, alice } = await fundedValidatorHarness();
    const outsider = makeWallet();
    const timestamp = GENESIS_TS + 12; // round 1; the old fallback was open here with one validator
    const rejected = h.tryBlock([], { timestamp, producer: outsider });
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe(ErrCode.NOT_PRODUCER_TURN);

    h.produce([], { timestamp, producer: alice });
    expect(h.chain.height).toBe(3);
    expect(h.chain.world.getAccount(alice.address)!.validator!.missedSlots).toBe(0);
  });

  it('cycles every later round through the registered set', async () => {
    const { h, alice } = await fundedValidatorHarness();
    const outsider = makeWallet();
    const veryLate = GENESIS_TS + 2 + 20 * CONSENSUS_PARAMS.block.targetBlockSeconds;
    expect(h.tryBlock([], { timestamp: veryLate, producer: outsider }).code).toBe(ErrCode.NOT_PRODUCER_TURN);
    h.produce([], { timestamp: veryLate, producer: alice });
    expect(h.chain.tip?.producer).toBe(alice.address);
  });
});

describe('proposer rounds and the missed-slot list (pure functions)', () => {
  function stateWith(addresses: string[]): WorldState {
    const state = new WorldState();
    for (const address of addresses) {
      state.setValidator(
        address,
        { validatorKey: '', bond: 1n, commissionBps: 0, registeredAtHeight: 0, missedSlots: 0, status: 'ACTIVE' },
        { height: 1, timestamp: 1 },
      );
    }
    return state;
  }
  const slot = CONSENSUS_PARAMS.block.targetBlockSeconds;

  it('derives the round from elapsed slots: round 0 for the first two slot-lengths, then one per slot', () => {
    expect(proposerRound(100, 100)).toBe(0);
    expect(proposerRound(100, 99)).toBe(0);
    expect(proposerRound(100, 100 + slot - 1)).toBe(0);
    expect(proposerRound(100, 100 + 2 * slot - 1)).toBe(0);
    expect(proposerRound(100, 100 + 2 * slot)).toBe(1);
    expect(proposerRound(100, 100 + 3 * slot)).toBe(2);
    expect(proposerRound(100, Number.NaN)).toBe(0);
  });

  it('hands the turn on one validator per round and cycles without opening the set', () => {
    const state = stateWith(['dobs1a', 'dobs1b', 'dobs1c']);
    expect(scheduledProposer(state, 3, 0)).toBe('dobs1a');
    expect(scheduledProposer(state, 3, 1)).toBe('dobs1b');
    expect(scheduledProposer(state, 3, 2)).toBe('dobs1c');
    expect(scheduledProposer(state, 3, 3)).toBe('dobs1a');
    expect(scheduledProposer(state, 3, 4)).toBe('dobs1b');
    expect(scheduledProposer(state, 3, 30)).toBe('dobs1a');
    expect(scheduledProposer(stateWith([]), 3, 0)).toBeNull();
  });

  it('names at most one validator as having missed a slot: the round-0 proposer', () => {
    const state = stateWith(['dobs1a', 'dobs1b', 'dobs1c']);
    // Round 0 block: nobody missed anything.
    expect(missedProposersFor(state, 3, 100, 100 + slot, 'dobs1a')).toEqual([]);
    // Round 1 block by someone else: the round-0 proposer missed.
    expect(missedProposersFor(state, 3, 100, 100 + 2 * slot, 'dobs1b')).toEqual(['dobs1a']);
    // Round 2 block: still ONE name, not every skipped validator.
    expect(missedProposersFor(state, 3, 100, 100 + 3 * slot, 'dobs1c')).toEqual(['dobs1a']);
    // The round-0 proposer itself produced late: not a miss.
    expect(missedProposersFor(state, 3, 100, 100 + 3 * slot, 'dobs1a')).toEqual([]);
    // Open mode: nobody to blame.
    expect(missedProposersFor(stateWith([]), 3, 100, 100 + 3 * slot, 'dobs1x')).toEqual([]);
  });
});

describe('transactions a peer gossips are checked before they are pooled', () => {
  it('accepts a good one and refuses bad signatures, stale nonces and expired transactions', async () => {
    const h = await harness();
    const alice = makeWallet();
    const now = h.chain.protocolTime;

    const good = h.sign(alice, TxType.MINING_CLAIM, new Uint8Array(), { gas: 0n });
    // Only the structural checks run here, so any well-formed body will do.
    expect(h.chain.checkGossipedTransaction(good)).toEqual({ ok: true });

    const forged = { ...good, signature: { ...good.signature, signature: '00'.repeat(64) } };
    const forgedVerdict = h.chain.checkGossipedTransaction(forged);
    expect(forgedVerdict.ok).toBe(false);
    if (!forgedVerdict.ok) expect(forgedVerdict.code).toBe(ErrCode.BAD_SIGNATURE);

    const stale = h.sign(alice, TxType.MINING_CLAIM, new Uint8Array(), { gas: 0n, nonce: 7 });
    const staleVerdict = h.chain.checkGossipedTransaction(stale);
    expect(staleVerdict.ok).toBe(false);
    if (!staleVerdict.ok) expect(staleVerdict.code).toBe(ErrCode.BAD_NONCE);

    const expired = h.sign(alice, TxType.MINING_CLAIM, new Uint8Array(), { gas: 0n, validUntil: now - 10 });
    const expiredVerdict = h.chain.checkGossipedTransaction(expired);
    expect(expiredVerdict.ok).toBe(false);
    if (!expiredVerdict.ok) expect(expiredVerdict.code).toBe(ErrCode.EXPIRED);
  });
});
