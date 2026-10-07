/**
 * The indexer is a cache of the chain, so the property that matters is that it
 * can never keep describing a chain the node no longer follows. These tests make
 * it wrong on purpose (reorg, crash gap, deleted directory) and require it to
 * repair itself from the stored blocks.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer } from '../../src/indexer/indexer.js';
import { blockHash } from '../../src/blockchain/block.js';
import {
  createHarness,
  forkParent,
  makeWallet,
  signedClaim,
  type Block,
  type ForkParent,
  type Harness,
} from '../helpers/harness.js';

const GENESIS_TS = 1_767_225_600;

const open: Harness[] = [];
const dirs: string[] = [];
async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}
function indexDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obs-index-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Wire an indexer to a chain exactly the way node.ts does. */
function attach(h: Harness, dir = indexDir()): Indexer {
  const indexer = new Indexer(dir);
  h.chain.on('block', (block: Block, events) => indexer.indexBlock(block, events, h.chain.world));
  h.chain.on('reorg', () => indexer.reconcile(h.chain));
  return indexer;
}

function branch(h: Harness, from: ForkParent, specs: Array<{ timestamp: number; txs?: Parameters<Harness['makeBlockOn']>[1] }>): void {
  let parent = from;
  for (const spec of specs) {
    const built = h.makeBlockOn(parent, spec.txs ?? [], { timestamp: spec.timestamp });
    expect(h.chain.addBlock(built.block).accepted).toBe(true);
    parent = {
      hash: blockHash(built.block.header),
      height: built.block.header.height,
      cumulativePotWeight: built.block.header.cumulativePotWeight,
      state: built.state,
    };
  }
}

function assertDescribesChain(h: Harness, indexer: Indexer): void {
  for (let height = 1; height <= h.chain.height; height += 1) {
    expect(indexer.indexedHashAt(height), `height ${height}`).toBe(h.chain.canonicalHashAt(height));
  }
  expect(indexer.height).toBe(h.chain.height);
}

describe('indexing', () => {
  it('records each block once, however many times it is announced', async () => {
    const h = await harness();
    const indexer = attach(h);
    const alice = makeWallet();
    const claim = signedClaim(h, alice, GENESIS_TS + 2);
    h.produce([], { timestamp: GENESIS_TS + 1 });
    const block = h.produce([claim], { timestamp: GENESIS_TS + 2 });
    indexer.indexBlock(block, h.chain.eventsForBlock(blockHash(block.header)), h.chain.world);
    indexer.indexBlock(block, h.chain.eventsForBlock(blockHash(block.header)), h.chain.world);
    expect(indexer.transactionsInBlock(2)).toHaveLength(1);
    expect(indexer.miningClaims(10)).toHaveLength(1);
    expect(indexer.summary().transactions).toBe(1);
  });
});

describe('after a reorganisation', () => {
  it('stops reporting the losing branch\'s transactions as included and indexes the winning branch in full', async () => {
    const h = await harness();
    const indexer = attach(h);
    const alice = makeWallet();
    const bob = makeWallet();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    const aliceClaim = signedClaim(h, alice, GENESIS_TS + 2);
    h.produce([aliceClaim], { timestamp: GENESIS_TS + 2 });
    h.produce([], { timestamp: GENESIS_TS + 3 });
    expect(indexer.getTransaction(aliceClaim.id)).toBeDefined();

    // A heavier branch from height 1 that carries BOB's claim instead.
    const bobClaim = signedClaim(h, bob, GENESIS_TS + 102);
    branch(h, forkParent(h, 1), [
      { timestamp: GENESIS_TS + 102, txs: [bobClaim] },
      { timestamp: GENESIS_TS + 103 },
      { timestamp: GENESIS_TS + 104 },
    ]);
    expect(h.chain.height).toBe(4);

    // The losing branch is gone from the index...
    expect(indexer.getTransaction(aliceClaim.id)).toBeUndefined();
    expect(indexer.miningClaims(10).map((claim) => claim.miner)).toEqual([bob.address]);
    // ...and the winning branch's INTERMEDIATE blocks (only the tip raises a
    // `block` event) were indexed too.
    expect(indexer.getTransaction(bobClaim.id)?.height).toBe(2);
    assertDescribesChain(h, indexer);
  });

  it('writes the repair to disk, so a restart sees the repaired index', async () => {
    const h = await harness();
    const dir = indexDir();
    const indexer = attach(h, dir);
    const alice = makeWallet();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    const claim = signedClaim(h, alice, GENESIS_TS + 2);
    h.produce([claim], { timestamp: GENESIS_TS + 2 });
    branch(h, forkParent(h, 1), [{ timestamp: GENESIS_TS + 102 }, { timestamp: GENESIS_TS + 103 }]);
    expect(indexer.getTransaction(claim.id)).toBeUndefined();
    expect(readFileSync(join(dir, 'index', 'transactions.jsonl'), 'utf8')).not.toContain(claim.id);

    const reloaded = new Indexer(dir);
    expect(reloaded.getTransaction(claim.id)).toBeUndefined();
    expect(reloaded.reconcile(h.chain)).toEqual({ rolledBackTo: h.chain.height, indexed: 0 });
  });
});

describe('catching up', () => {
  it('rebuilds a deleted index from the stored blocks', async () => {
    const h = await harness();
    const original = attach(h);
    const alice = makeWallet();
    const bob = makeWallet();
    h.produce([signedClaim(h, alice, GENESIS_TS + 1)], { timestamp: GENESIS_TS + 1 });
    h.produce([], { timestamp: GENESIS_TS + 2 });
    h.produce([signedClaim(h, bob, GENESIS_TS + 3)], { timestamp: GENESIS_TS + 3 });

    const rebuilt = new Indexer(indexDir());
    const outcome = rebuilt.reconcile(h.chain);
    expect(outcome.indexed).toBe(h.chain.height + 1); // genesis included
    expect(rebuilt.summary().transactions).toBe(original.summary().transactions);
    expect(rebuilt.miningClaims(10).map((claim) => claim.miner).sort()).toEqual([alice.address, bob.address].sort());
    assertDescribesChain(h, rebuilt);
  });

  it('repairs the crash gap: blocks committed to the chain but never indexed', async () => {
    const h = await harness();
    const alice = makeWallet();
    h.produce([], { timestamp: GENESIS_TS + 1 });
    const dir = indexDir();
    const indexer = new Indexer(dir); // attached late: it missed block 1
    indexer.reconcile(h.chain);
    h.chain.on('block', (block: Block, events) => indexer.indexBlock(block, events, h.chain.world));
    h.produce([signedClaim(h, alice, GENESIS_TS + 2)], { timestamp: GENESIS_TS + 2 });

    // Simulate a crash between "committed" and "indexed" for the next two blocks.
    const detached = new Indexer(dir);
    h.chain.removeAllListeners('block');
    h.produce([], { timestamp: GENESIS_TS + 3 });
    h.produce([], { timestamp: GENESIS_TS + 4 });
    expect(detached.height).toBe(2);

    const outcome = detached.reconcile(h.chain);
    expect(outcome).toEqual({ rolledBackTo: 2, indexed: 2 });
    assertDescribesChain(h, detached);
  });

  it('treats an index that predates per-block records as unverifiable and rebuilds it', async () => {
    const h = await harness();
    const dir = indexDir();
    const alice = makeWallet();
    const first = attach(h, dir);
    h.produce([signedClaim(h, alice, GENESIS_TS + 1)], { timestamp: GENESIS_TS + 1 });
    expect(first.summary().transactions).toBe(1);
    rmSync(join(dir, 'index', 'blocks.jsonl')); // an index written by an older build

    const legacy = new Indexer(dir);
    const outcome = legacy.reconcile(h.chain);
    expect(outcome.rolledBackTo).toBe(-1);
    expect(legacy.summary().transactions).toBe(1);
    assertDescribesChain(h, legacy);
  });
});
