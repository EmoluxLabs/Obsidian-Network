/**
 * The Mining Pool, end to end: consensus state -> RPC -> the view an interface draws.
 *
 * Drives a real chain with real signed transactions and the real HTTP server. It shows (a) which field is the
 * Mining Pool and that it is read from consensus state, not derived from supply or mined, (b) that gas fills it and
 * the next mining claim drains it, so a genuine 0 is a normal reading, (c) that the interface view reports that zero
 * as a real zero but never reports a missing or wrong-chain answer as one, and (d) that mainnet is chain 7777 with
 * prefix `obs`. Nothing here changes a consensus rule.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Indexer } from '../../src/indexer/indexer.js';
import { RpcServer } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG } from '../../src/config/config.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { TxType } from '../../src/protocol/types.js';
import { claimRewardForActiveMiners } from '../../src/mining/schedule.js';
import { describeMiningPool } from '../../src/protocol/display.js';
import { advance, createHarness, makeWallet, miningBody, paymentGas, rewindMiningTimer, signedPayment, type Harness } from '../helpers/harness.js';

const CLAIM_REWARD = claimRewardForActiveMiners(0);
const open: Array<() => void> = [];
afterEach(() => {
  while (open.length > 0) open.pop()!();
});

async function node(): Promise<{ h: Harness; get: (path: string) => Promise<any> }> {
  const h = await createHarness();
  const indexer = new Indexer(h.dir);
  const config = { ...DEFAULT_CONFIG, network: 'devnet' as const, rpcPort: 0, rpcHost: '127.0.0.1', rpcRateLimitPerMinute: 0, p2pEnabled: false, dataDir: h.dir };
  const server = new RpcServer({
    chain: h.chain, indexer, net: h.net, config, genesisId: computeGenesisId(h.chain.genesisDocument, h.net), log: () => undefined,
  });
  const port = await server.listen();
  open.push(() => {
    void server.close?.();
    h.close();
  });
  return { h, get: async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json() };
}

const claim = (h: Harness, w: ReturnType<typeof makeWallet>) => h.sign(w, TxType.MINING_CLAIM, miningBody(h, w), { gas: 0n });

describe('Mining Pool: consensus state -> RPC -> view', () => {
  it('reads state.pool.balance, a genuine zero first, then gas, then drained by the next claim', async () => {
    const { h, get } = await node();
    const alice = makeWallet();
    const bob = makeWallet();

    // Fresh chain: the pool really is empty, and the node says so.
    let supply = await get('/supply');
    let status = await get('/status');
    expect(h.chain.world.s.pool.balance).toBe(0n);
    expect(supply.poolBalanceObs).toBe(formatObs(0n));
    expect(status.pool.balance).toBe(formatObs(0n));
    expect(describeMiningPool({ expectedChainId: h.net.chainId, status, supply })).toMatchObject({ state: 'ok', value: '0 OBS', zero: true });

    advance(h, 1);
    h.produce([claim(h, alice)]);

    // A payment pays gas into the pool.
    // 0.2 OBS pays 0.00004 OBS gas (0.02%): less than one claim reward, so the next claim drains it completely.
    const amount = parseObs('0.2');
    const gas = paymentGas(amount);
    h.produce([signedPayment(h, alice, bob.address, amount, { nonce: 1 })]);
    supply = await get('/supply');
    status = await get('/status');
    expect(h.chain.world.s.pool.balance).toBe(gas);
    expect(supply.poolBalanceObs).toBe(formatObs(gas)); // the field the interfaces read
    expect(status.pool.balance).toBe(formatObs(gas));
    expect(status.pool.lifetimeInflow).toBe(formatObs(gas));
    expect(status.pool.lifetimeDistributed).toBe(formatObs(0n));
    // the pool is its own quantity: not supply, not mined, not genesis
    expect(supply.poolBalanceObs).not.toBe(supply.totalSupplyObs);
    expect(supply.poolBalanceObs).not.toBe(supply.minedSupplyObs);
    expect(supply.poolBalanceObs).not.toBe(supply.genesisIssuedObs);
    expect(gas).toBe(parseObs('0.00004'));
    const withFees = describeMiningPool({ expectedChainId: h.net.chainId, status, supply });
    expect(withFees.state).toBe('ok');
    expect(withFees.zero).toBe(false);
    expect(withFees.exact).toBe(`${formatObs(gas).replace(/0+$/, '')} OBS`);

    // The next claim is paid from the pool first; only the shortfall is newly mined.
    const minedBefore = h.chain.world.s.metrics.minedSupply;
    rewindMiningTimer(h, alice.address);
    h.produce([claim(h, alice)]);
    supply = await get('/supply');
    status = await get('/status');
    const fromPool = gas < CLAIM_REWARD ? gas : CLAIM_REWARD;
    expect(h.chain.world.s.pool.balance).toBe(gas - fromPool);
    expect(h.chain.world.s.metrics.minedSupply - minedBefore).toBe(CLAIM_REWARD - fromPool);
    expect(status.pool.lifetimeDistributed).toBe(formatObs(fromPool));
    // the pool is zero because every fee that came in was paid to a miner: inflow == distributed
    const drained = describeMiningPool({ expectedChainId: h.net.chainId, status, supply });
    expect(drained).toMatchObject({ state: 'ok', value: '0 OBS', zero: true });
    expect(drained.lifetimeInflow).toBe(drained.lifetimeDistributed);
    // mined + genesis is the whole supply and the node's own invariant still holds
    expect(supply.invariantOk).toBe(true);
    // the reading the operator saw: the claim minted its reward less the fees it recycled, and the pool is empty
    expect(CLAIM_REWARD - fromPool).toBe(parseObs('0.000126666666666666'));
  });

  it('shows no figure when the answer is missing or from another chain', async () => {
    const { h, get } = await node();
    const supply = await get('/supply');
    const status = await get('/status');
    expect(status.chainId).toBe(h.net.chainId);
    // an interface built for mainnet (7777) must refuse a devnet node's pool figure
    expect(describeMiningPool({ expectedChainId: 7777, status, supply })).toMatchObject({ state: 'mismatch', value: '—', zero: false });
    // a node that did not answer is not a node that said zero
    expect(describeMiningPool({ expectedChainId: h.net.chainId, status, supply: null })).toMatchObject({ state: 'unavailable', value: '—', zero: false });
    expect(describeMiningPool({ expectedChainId: h.net.chainId, status, supply: { ...supply, poolBalanceObs: undefined } })).toMatchObject({ state: 'unavailable', value: '—' });
  });

  it('mainnet is chain 7777 with the obs prefix; the other networks cannot be mistaken for it', () => {
    const mainnet = getNetwork('mainnet');
    expect(mainnet.chainId).toBe(7777);
    expect(mainnet.addressHrp).toBe('obs');
    for (const name of ['testnet', 'staging', 'devnet']) {
      const other = getNetwork(name);
      expect(other.chainId).not.toBe(7777);
      expect(other.addressHrp).not.toBe('obs');
    }
  });
});
