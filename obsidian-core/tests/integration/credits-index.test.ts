/**
 * OBS the protocol credits to an address without a transaction naming it (the treasury's 10% of an ONS fee, a Node Runner's
 * reward) must show up in that address's history. Before this, the treasury wallet's balance rose with every name sold but
 * its transaction list stayed empty, because there is no transaction whose recipient is the treasury: the share is credited
 * inside the ONS transaction's own execution. These tests drive a real chain, real signed transactions and the real HTTP route.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Indexer } from '../../src/indexer/indexer.js';
import { RpcServer } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { splitOnsRevenue, RevenueSource } from '../../src/economy/accounting.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { OnsOp, TxType } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { createHarness, forkParent, makeWallet, onsBody, signedClaim, signedPayment, type Block, type Harness } from '../helpers/harness.js';
import { blockHash } from '../../src/blockchain/block.js';

const open: Array<() => void> = [];
const dirs: string[] = [];
afterEach(() => {
  while (open.length > 0) open.pop()!();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function node(indexDirectory?: string): Promise<{ h: Harness; indexer: Indexer; get: (path: string) => Promise<any> }> {
  const h = await createHarness();
  const dir = indexDirectory ?? mkdtempSync(join(tmpdir(), 'obs-credits-'));
  if (!indexDirectory) dirs.push(dir);
  const indexer = new Indexer(dir);
  h.chain.on('block', (block: Block, events) => indexer.indexBlock(block, events, h.chain.world));
  h.chain.on('reorg', () => indexer.reconcile(h.chain));
  const config = { ...DEFAULT_CONFIG, network: 'devnet' as const, rpcPort: 0, rpcHost: '127.0.0.1', rpcRateLimitPerMinute: 0, p2pEnabled: false, dataDir: h.dir };
  const server = new RpcServer({ chain: h.chain, indexer, net: h.net, config, genesisId: computeGenesisId(h.chain.genesisDocument, h.net), log: () => undefined });
  const port = await server.listen();
  open.push(() => {
    void server.close?.();
    h.close();
  });
  return { h, indexer, get: async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json() };
}

/** Alice claims first, so she is the treasury; Bob is paid 5 OBS and registers `bob`. */
async function treasuryAndBuyer() {
  const ctx = await node();
  const { h } = ctx;
  const alice = makeWallet();
  const bob = makeWallet();
  h.produce([]);
  h.produce([signedClaim(h, alice)]);
  expect(h.chain.world.s.genesis.treasuryWallet).toBe(alice.address);
  h.produce([signedPayment(h, alice, bob.address, parseObs('5'), { nonce: 1 })]);
  const before = h.chain.world.getAccount(alice.address)!.balance;
  const fee = CONSENSUS_PARAMS.ons.registrationFee;
  const register = h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'bob', { fee }), { gas: expectedGas(fee) });
  h.produce([register]);
  const after = h.chain.world.getAccount(alice.address)!.balance;
  return { ...ctx, alice, bob, fee, register, before, after, share: splitOnsRevenue(fee, RevenueSource.ONS_REGISTRATION).treasury };
}

describe('protocol credits in an address history', () => {
  it('the treasury balance rises with a sale, the transaction list stays empty of it, and the credit list explains it', async () => {
    const { indexer, get, alice, bob, register, before, after, share } = await treasuryAndBuyer();
    // The reported problem, stated as a fact: the balance changed by exactly the treasury share...
    expect(after - before).toBe(share);
    // ...and no transaction in the treasury's list is the sale, because no transaction names the treasury.
    expect(indexer.addressHistory(alice.address, 50).map((tx) => tx.txId)).not.toContain(register.id);
    // The credit record is what explains the balance change.
    const credits = indexer.creditsFor(alice.address);
    expect(credits).toHaveLength(1);
    expect(credits[0]).toMatchObject({ kind: 'ONS_TREASURY_SHARE', amount: share.toString(), txId: register.id, reference: 'bob.obs', address: alice.address });
    expect(BigInt(credits[0].amount)).toBeGreaterThan(0n);
    // The buyer is not credited with anything.
    expect(indexer.creditsFor(bob.address)).toHaveLength(0);

    const route = await get(`/address/${alice.address}`);
    expect(route.counts.credits).toBe(1);
    expect(route.credits[0]).toMatchObject({ kind: 'ONS_TREASURY_SHARE', amount: share.toString(), amountObs: formatObs(share), txId: register.id, reference: 'bob.obs' });
    expect(JSON.stringify(route.credits)).not.toContain(alice.address); // the caller knows it; the public route does not repeat it
    expect((await get(`/address/${bob.address}`)).credits).toEqual([]);
  });

  it('a renewal is credited too, and the treasury paying itself is recorded', async () => {
    const { h, indexer, alice, bob } = await treasuryAndBuyer();
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'alice', { fee }), { gas: expectedGas(fee), nonce: 2 })]);
    h.produce([h.sign(bob, TxType.ONS, onsBody(OnsOp.RENEW, 'bob', { fee: CONSENSUS_PARAMS.ons.renewalFee }), { gas: expectedGas(CONSENSUS_PARAMS.ons.renewalFee) })]);
    const credits = indexer.creditsFor(alice.address, 10);
    expect(credits.map((credit) => credit.note)).toEqual([
      expect.stringContaining('renewal'),
      expect.stringContaining('registration'),
      expect.stringContaining('registration'),
    ]);
    // The sum of the credits equals what the chain says the treasury was credited.
    const total = credits.reduce((sum, credit) => sum + BigInt(credit.amount), 0n);
    expect(total).toBe(h.chain.world.s.metrics.totalOnsTreasuryShare);
  });

  it('survives a restart, and an index written before credits existed is rebuilt from the blocks', async () => {
    const { h, indexer, alice, share } = await treasuryAndBuyer();
    const dir = (indexer as unknown as { directory: string }).directory;
    const reloaded = new Indexer(join(dir, '..'));
    expect(reloaded.creditsFor(alice.address)).toHaveLength(1);
    expect(reloaded.reconcile(h.chain)).toEqual({ rolledBackTo: h.chain.height, indexed: 0 });

    // A legacy index: blocks and transactions, no credits file.
    unlinkSync(join(dir, 'credits.jsonl'));
    const legacy = new Indexer(join(dir, '..'));
    expect(legacy.creditsFor(alice.address)).toHaveLength(0);
    const repaired = legacy.reconcile(h.chain);
    expect(repaired.indexed).toBeGreaterThanOrEqual(h.chain.height);
    expect(legacy.creditsFor(alice.address)).toHaveLength(1);
    expect(legacy.creditsFor(alice.address)[0].amount).toBe(share.toString());
    expect(readFileSync(join(dir, 'credits.jsonl'), 'utf8')).toContain(share.toString());
    // And the next restart does not rebuild again.
    expect(new Indexer(join(dir, '..')).reconcile(h.chain)).toEqual({ rolledBackTo: h.chain.height, indexed: 0 });
  });

  it('a credit on a branch that lost a reorganisation is forgotten', async () => {
    const { h, indexer, alice } = await treasuryAndBuyer();
    expect(indexer.creditsFor(alice.address)).toHaveLength(1);
    const registerHeight = h.chain.height;
    // A heavier branch from before the sale, without it.
    let parent = forkParent(h, registerHeight - 1);
    const forkTime = h.chain.getBlockByHeight(registerHeight - 1)!.header.timestamp;
    for (let i = 1; i <= 3; i += 1) {
      const built = h.makeBlockOn(parent, [], { timestamp: forkTime + i });
      expect(h.chain.addBlock(built.block).accepted).toBe(true);
      parent = { hash: blockHash(built.block.header), height: built.block.header.height, cumulativePotWeight: built.block.header.cumulativePotWeight, state: built.state };
    }
    expect(h.chain.height).toBeGreaterThan(registerHeight);
    expect(indexer.creditsFor(alice.address)).toHaveLength(0);
    expect(h.chain.world.s.metrics.totalOnsTreasuryShare).toBe(0n);
  });

  it('a Node Runner reward is credited to the reward wallet named in the settlement event; a zero payout is not', async () => {
    const { h, indexer } = await node();
    const runner = makeWallet();
    const other = makeWallet();
    const block = h.produce([]);
    indexer.indexBlock(
      { ...block, header: { ...block.header, height: 900 } } as Block,
      [
        {
          type: 'NODE_REWARDS_SETTLED',
          height: 900,
          data: { period: 41, payouts: `nodeaa|${runner.address}|1234567|9000|5000;nodebb|${other.address}|0|0|0;broken|${runner.address}|notanumber|1|1` },
        },
      ],
      h.chain.world,
    );
    expect(indexer.creditsFor(runner.address)).toHaveLength(1);
    expect(indexer.creditsFor(runner.address)[0]).toMatchObject({ kind: 'NODE_REWARD', amount: '1234567', reference: 'nodeaa', height: 900 });
    expect(indexer.creditsFor(other.address)).toHaveLength(0);
  });

  it('a name sent with its .obs suffix (as the platform wallet does) is labelled once, not twice', async () => {
    const { h, indexer, alice } = await treasuryAndBuyer();
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    const tx = h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, 'suffixed.obs', { fee }), { gas: expectedGas(fee), nonce: 2 });
    h.produce([tx]);
    expect(indexer.getTransaction(tx.id)?.reference).toBe('suffixed.obs');
    expect(indexer.creditsFor(alice.address)[0].reference).toBe('suffixed.obs');
  });
});
