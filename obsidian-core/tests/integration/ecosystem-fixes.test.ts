/**
 * ONS revenue accounting edge cases exercised against a real node and RPC API.
 * These checks keep the 90/10 split, treasury designation and period settlement
 * consistent without a generic/non-ONS revenue injection path.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { RpcServer } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { OnsOp, TxType } from '../../src/protocol/types.js';
import { parseObs } from '../../src/protocol/amount.js';
import { RevenueSource, splitOnsRevenue } from '../../src/economy/accounting.js';
import { processNodeRewardRoutine } from '../../src/economy/settlement.js';
import { rewardPeriodAt } from '../../src/economy/node-rewards.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import {
  DEVNET,
  createHarness,
  makeWallet,
  onsBody,
  signedClaim,
  signedPayment,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';

const open: Array<{ close: () => void | Promise<void> }> = [];
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}

/** A chain whose first miner (alice) is the treasury, plus a funded buyer (bob). */
async function fundedChain(): Promise<{ h: Harness; alice: TestWallet; bob: TestWallet }> {
  const h = await harness();
  const alice = makeWallet();
  const bob = makeWallet();
  h.produce([]);
  h.produce([signedClaim(h, alice)]);
  h.produce([signedPayment(h, alice, bob.address, parseObs('5000'))]);
  return { h, alice, bob };
}

async function serve(h: Harness): Promise<{ call: (path: string) => Promise<{ status: number; body: any }> }> {
  const config: NodeConfig = { ...DEFAULT_CONFIG, network: 'devnet', rpcPort: 0, rpcHost: '127.0.0.1', rpcCorsOrigins: [], rpcRateLimitPerMinute: 0, dataDir: h.dir };
  const server = new RpcServer({
    chain: h.chain,
    indexer: new Indexer(h.dir),
    net: DEVNET,
    config,
    genesisId: computeGenesisId(h.chain.genesisDocument, DEVNET),
    log: () => undefined,
  });
  const base = `http://127.0.0.1:${await server.listen()}`;
  open.push({ close: () => server.close() });
  return {
    async call(path: string) {
      const response = await fetch(`${base}${path}`);
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: text };
      }
    },
  };
}

describe('ONS revenue and the treasury', () => {
  it('pays the treasury share in the same block as ONS registration', async () => {
    const { h, alice, bob } = await fundedChain();
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    const before = h.chain.world.getAccount(alice.address)!.balance;
    h.produce([h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'revenue', { fee }), { gas: expectedGas(fee) })]);
    const after = h.chain.world.getAccount(alice.address)!.balance;
    expect(after - before).toBe(splitOnsRevenue(fee, RevenueSource.ONS_REGISTRATION).treasury);
    expect(h.chain.world.s.nodeRewards.unclaimedRevenue).toBe(0n);
  });

  it('reports the treasury in full, what it holds, and exactly when each share is paid', async () => {
    const { h, alice, bob } = await fundedChain();
    h.produce([h.sign(bob, TxType.ONS, onsBody(OnsOp.REGISTER, 'revenue', { fee: CONSENSUS_PARAMS.ons.registrationFee }), { gas: expectedGas(CONSENSUS_PARAMS.ons.registrationFee) })]);
    const { call } = await serve(h);
    const revenue = (await call('/revenue')).body;

    expect(revenue.treasury.designated).toBe(true);
    expect(revenue.treasury.wallet).toBe(alice.address);
    expect(revenue.treasury.lifetimeCreditedObs).toBe(revenue.split.treasuryCreditedObs);
    expect(revenue.split.treasuryObs).toBe(revenue.split.treasuryCreditedObs);
    expect(revenue.split.treasuryUnclaimedObs).toBe('0.000000000000000000');
    expect(revenue.split.sumsBack).toBe(true);
    // The route has never shown a wallet balance and still does not: the address is enough to ask for one.
    expect(JSON.stringify(revenue)).not.toContain('"balanceObs"');

    const period = rewardPeriodAt(h.chain.protocolTime);
    const periodSeconds = CONSENSUS_PARAMS.nodeRewards.periodSeconds;
    expect(revenue.timing.treasuryShare.paid).toMatch(/credited.*same block/i);
    expect(revenue.timing.nodeRunnerShare.periodSeconds).toBe(periodSeconds);
    expect(revenue.timing.nodeRunnerShare.currentPeriod).toBe(period);
    expect(revenue.timing.nodeRunnerShare.nextSettlementAt).toBe((period + 1) * periodSeconds);
    expect(revenue.timing.nodeRunnerShare.secondsUntilNextSettlement).toBe((period + 1) * periodSeconds - h.chain.protocolTime);
    expect(revenue.timing.nodeRunnerShare.registeredNodes).toBe(0);
    expect(revenue.timing.nodeRunnerShare.carriedWhenNoNodes).toBe(true);

    const rewards = (await call('/nodes/rewards')).body;
    expect(rewards.pool.nextSettlementAt).toBe((period + 1) * periodSeconds);
  });

  it('reports the exact unclaimed 10% treasury allocation before a wallet is designated', async () => {
    const h = await harness();
    h.produce([]);
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    h.chain.world.s.metrics.totalSupply += fee;
    h.chain.world.creditOnsRevenue(RevenueSource.ONS_REGISTRATION, fee, {
      height: h.chain.height + 1,
      timestamp: h.chain.protocolTime,
    }, 'test ONS fee before treasury designation');
    h.chain.world.takeEvents();

    const { call } = await serve(h);
    const revenue = (await call('/revenue')).body;
    const split = splitOnsRevenue(fee, RevenueSource.ONS_REGISTRATION);
    expect(revenue.treasury.designated).toBe(false);
    expect(revenue.treasury.wallet).toBeNull();
    expect(revenue.treasury.lifetimeCreditedObs).toBe('0.000000000000000000');
    expect(revenue.onsRevenueObs).toBe('0.050000000000000000');
    expect(revenue.split.nodeRunnerPoolObs).toBe('0.045000000000000000');
    expect(revenue.split.treasuryObs).toBe('0.005000000000000000');
    expect(revenue.split.treasuryCreditedObs).toBe('0.000000000000000000');
    expect(revenue.split.treasuryUnclaimedObs).toBe('0.005000000000000000');
    expect(revenue.split.sumsBack).toBe(true);
    expect(revenue.timing.treasuryShare.paid).toMatch(/held as an unclaimed treasury obligation/i);
    expect(revenue.accounts.miningPoolObs).toBe('0.005000000000000000');
    expect(split.nodeRunnerPool + split.treasury).toBe(fee);
  });

  it('pays what was owed to a treasury in the transaction that designates it', async () => {
    // Control: the same two blocks with nothing owed, to know what a first miner holds.
    const control = await harness();
    const miner = makeWallet();
    control.produce([]);
    control.produce([signedClaim(control, miner)]);
    const baseline = control.chain.world.getAccount(miner.address)!.balance;

    const h = await harness();
    h.produce([]);
    const sale = parseObs('10');
    const owed = splitOnsRevenue(sale, RevenueSource.ONS_REGISTRATION).treasury;
    // Value cannot appear from nowhere: account for the payer's OBS so the supply invariant still balances.
    h.chain.world.s.metrics.totalSupply += sale;
    h.chain.world.creditOnsRevenue(RevenueSource.ONS_REGISTRATION, sale, { height: 2, timestamp: h.chain.protocolTime }, 'an ONS fee before any treasury');
    h.chain.world.takeEvents();
    expect(h.chain.world.s.nodeRewards.unclaimedRevenue).toBe(owed);
    expect(h.chain.world.s.genesis.treasuryWallet).toBe('');

    h.produce([signedClaim(h, miner)]);

    expect(h.chain.world.s.genesis.treasuryWallet).toBe(miner.address);
    expect(h.chain.world.s.nodeRewards.unclaimedRevenue).toBe(0n);
    expect(h.chain.world.getAccount(miner.address)!.balance).toBe(baseline + owed);
    expect(h.chain.world.s.metrics.totalOnsTreasuryShare).toBe(owed);
  });

  it('settles revenue that was parked even when no node runner is registered', async () => {
    const { h, alice } = await fundedChain();
    const owed = parseObs('3');
    // The state an older build left behind: a share recorded as owed, held by the Mining Pool.
    h.chain.world.s.nodeRewards.unclaimedRevenue = owed;
    h.chain.world.s.pool.balance += owed;
    h.chain.world.s.metrics.totalSupply += owed;
    expect(h.chain.world.registeredNodes()).toHaveLength(0);
    const before = h.chain.world.getAccount(alice.address)!.balance;

    const period = rewardPeriodAt(h.chain.protocolTime);
    processNodeRewardRoutine({
      state: h.chain.world,
      apply: { height: (h.chain.store.head?.height ?? 0) + 1, timestamp: (period + 1) * CONSENSUS_PARAMS.nodeRewards.periodSeconds + 1 },
    });
    h.chain.world.takeEvents();

    expect(h.chain.world.s.nodeRewards.unclaimedRevenue).toBe(0n);
    expect(h.chain.world.getAccount(alice.address)!.balance - before).toBe(owed);
  });
});

beforeAll(() => {
  // The consensus constants these tests lean on; if one changes, say so here rather than by a wrong number below.
  expect(CONSENSUS_PARAMS.nodeRewards.nodePoolShareBps + CONSENSUS_PARAMS.nodeRewards.treasuryShareBps).toBe(10_000);
});
