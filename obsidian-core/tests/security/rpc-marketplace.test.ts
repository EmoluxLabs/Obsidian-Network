/**
 * What the node tells the world about the ONS Marketplace (protocol 2.0.0). These read the real routes of a real RPC
 * server over a chain built from real blocks. Every answer is derived from consensus state; the indexer is only asked
 * for history and is never asked who owns what.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RpcServer } from '../../src/rpc/server.js';
import { Indexer } from '../../src/indexer/indexer.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { MarketOp, OnsOp, TxType, type TxEnvelope } from '../../src/protocol/types.js';
import { encodeSignedTx } from '../../src/transactions/encode.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { blockHash } from '../../src/blockchain/block.js';
import { resolveOnsName } from '../../src/protocol/recipient.js';
import { formatObs } from '../../src/protocol/amount.js';
import { createHarness, makeWallet, marketBody, onsBody, paymentBody, parseObs, signedClaim, type Harness, type TestWallet } from '../helpers/harness.js';

const ONS = CONSENSUS_PARAMS.ons;
const T0 = 1_767_225_600 + 100;
const PRICE = parseObs('100');
const servers: RpcServer[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
  while (harnesses.length) harnesses.pop()!.close();
});

async function world() {
  const h = await createHarness();
  harnesses.push(h);
  const [alice, bob, carol] = [makeWallet(), makeWallet(), makeWallet()];
  let now = T0;
  const indexer = new Indexer(h.dir);
  h.chain.on('block', (block, events) => indexer.indexBlock(block, events, h.chain.world));
  const step = (txs: TxEnvelope[]) => {
    now += 5;
    return h.produce(txs, { timestamp: now });
  };
  step([signedClaim(h, alice, now)]);
  step([bob, carol].map((w, i) => h.sign(alice, TxType.PAYMENT, paymentBody(w.address, '1000'), { gas: expectedGas(parseObs('1000')), nonce: 1 + i - 1 + h.chain.world.getAccount(alice.address)!.nonce, protocolTime: now })));
  step(['alpha', 'beta'].map((name, i) => h.sign(alice, TxType.ONS, onsBody(OnsOp.REGISTER, name, { fee: ONS.registrationFee }), { gas: expectedGas(ONS.registrationFee), nonce: h.chain.world.getAccount(alice.address)!.nonce + i, protocolTime: now })));
  const config: NodeConfig = { ...DEFAULT_CONFIG, network: 'devnet', rpcPort: 0, rpcHost: '127.0.0.1', rpcCorsOrigins: [], rpcRateLimitPerMinute: 0, dataDir: h.dir };
  const server = new RpcServer({ chain: h.chain, indexer, net: h.net, config, genesisId: computeGenesisId(h.chain.genesisDocument, h.net), log: () => undefined });
  servers.push(server);
  const base = `http://127.0.0.1:${await server.listen()}`;
  const sign = (w: TestWallet, body: Uint8Array, gas = 0n) => h.sign(w, TxType.ONS_MARKET, body, { gas, protocolTime: now });
  return { h, alice, bob, carol, base, step, sign, now: () => now };
}

const get = async (base: string, path: string) => {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, any> };
};
const post = async (base: string, path: string, body: unknown) => {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
};

describe('Marketplace RPC', () => {
  it('search states: available, owned and unlisted, listed', async () => {
    const w = await world();
    expect((await get(w.base, '/market/name/freshname')).json).toMatchObject({ status: 'AVAILABLE', canRegister: true, canBuy: false, canOffer: false });
    expect((await get(w.base, '/market/name/alpha.obs')).json).toMatchObject({ status: 'OWNED', canOffer: true, canBuy: false, locked: false });
    w.step([w.sign(w.alice, marketBody(MarketOp.LIST, 'alpha', { amount: PRICE }))]);
    const listed = (await get(w.base, '/market/name/alpha')).json;
    expect(listed).toMatchObject({ status: 'LISTED', canBuy: true, canOffer: false, locked: true, owner: w.alice.address });
    expect(listed.listing).toMatchObject({ seller: w.alice.address, priceSeals: PRICE.toString(), priceObs: formatObs(PRICE) });
  });

  it('/names/:name reports the lock and does not resolve a listed name; /names flags listings', async () => {
    const w = await world();
    expect((await get(w.base, '/names/alpha')).json).toMatchObject({ locked: false, resolved: true, marketStatus: 'OWNED' });
    expect((await get(w.base, '/names/nothere')).json).toMatchObject({ marketStatus: 'AVAILABLE' });
    w.step([w.sign(w.alice, marketBody(MarketOp.LIST, 'alpha', { amount: PRICE }))]);
    const record = (await get(w.base, '/names/alpha')).json;
    expect(record).toMatchObject({ locked: true, resolved: false, marketStatus: 'LISTED' });
    const names = (await get(w.base, `/names?owner=${w.alice.address}`)).json.names as Array<{ name: string; listed: boolean; priceSeals: string | null }>;
    expect(names.find((n) => n.name === 'alpha.obs')).toMatchObject({ listed: true, priceSeals: PRICE.toString() });
    expect(names.find((n) => n.name === 'beta.obs')).toMatchObject({ listed: false, priceSeals: null });
    // the payment-recipient resolver refuses a locked name with its own reason and never falls back
    const net = { chainId: w.h.net.chainId, addressHrp: w.h.net.addressHrp };
    const result = await resolveOnsName('alpha.obs', {
      expected: async () => net,
      lookup: async () => record,
      context: async () => ({ ...net, protocolTime: w.now() }),
    });
    expect(result).toMatchObject({ ok: false, code: 'NAME_LISTED' });
  });

  it('paginates listings and filters by seller; rejects bad parameters', async () => {
    const w = await world();
    w.step([w.sign(w.alice, marketBody(MarketOp.LIST, 'alpha', { amount: PRICE })), w.h.sign(w.alice, TxType.ONS_MARKET, marketBody(MarketOp.LIST, 'beta', { amount: PRICE * 2n }), { gas: 0n, nonce: w.h.chain.world.getAccount(w.alice.address)!.nonce + 1, protocolTime: w.now() })]);
    const all = (await get(w.base, '/market/listings?sort=price_desc&limit=1')).json;
    expect(all).toMatchObject({ total: 2, hasMore: true, limit: 1 });
    expect(all.listings[0].name).toBe('beta.obs');
    const second = (await get(w.base, '/market/listings?sort=price_desc&limit=1&offset=1')).json;
    expect(second.listings[0].name).toBe('alpha.obs');
    expect((await get(w.base, `/market/listings?seller=${w.alice.address}`)).json.total).toBe(2);
    expect((await get(w.base, `/market/listings?seller=${w.bob.address}`)).json.total).toBe(0);
    expect((await get(w.base, '/market/listings?sort=bogus')).status).toBe(400);
    expect((await get(w.base, '/market/listings?seller=notanaddress')).status).toBe(400);
    expect((await get(w.base, '/market/listing/alpha')).json.listing.priceSeals).toBe(PRICE.toString());
    expect((await get(w.base, '/market/listing/notlisted')).status).toBe(404);
    expect((await get(w.base, '/market')).json).toMatchObject({ activeListings: 2, commissionBps: 0 });
  });

  it('offers: by name, incoming, outgoing, one offer with its escrow; wallet shows locked vs spendable', async () => {
    const w = await world();
    const before = (await post(w.base, '/wallet/balance', { address: w.bob.address })).json;
    const offer = w.sign(w.bob, marketBody(MarketOp.OFFER, 'alpha', { amount: PRICE, counterparty: w.alice.address }), expectedGas(PRICE));
    w.step([offer]);
    const after = (await post(w.base, '/wallet/balance', { address: w.bob.address })).json;
    expect(BigInt(after.lockedSeals)).toBe(PRICE);
    expect(BigInt(after.totalSeals)).toBe(BigInt(after.spendableSeals) + PRICE);
    expect(BigInt(before.spendableSeals) - BigInt(after.spendableSeals)).toBe(PRICE + expectedGas(PRICE));
    expect(before.lockedSeals).toBe('0');

    const one = (await get(w.base, `/market/offer/${offer.id}`)).json;
    expect(one.offer).toMatchObject({ status: 'PENDING', escrowHeld: true, maker: w.bob.address, owner: w.alice.address, currentOwner: w.alice.address });
    expect(one.escrow).toMatchObject({ held: true, amountSeals: PRICE.toString() });
    expect((await get(w.base, '/market/offers/name/alpha?status=PENDING')).json.offers).toHaveLength(1);
    expect((await get(w.base, `/market/offers/incoming/${w.alice.address}`)).json.total).toBe(1);
    expect((await get(w.base, `/market/offers/incoming/${w.bob.address}`)).json.total).toBe(0);
    expect((await get(w.base, `/market/offers/outgoing/${w.bob.address}`)).json.offers[0].id).toBe(offer.id);
    expect((await get(w.base, '/market/offers/name/alpha?status=NOPE')).status).toBe(400);
    expect((await get(w.base, `/market/offer/${'0'.repeat(64)}`)).status).toBe(404);

    w.step([w.sign(w.bob, marketBody(MarketOp.CANCEL_OFFER, 'alpha', { offerId: offer.id }))]);
    const cancelled = (await get(w.base, `/market/offer/${offer.id}`)).json;
    expect(cancelled.offer.status).toBe('CANCELLED');
    expect(cancelled.escrow).toMatchObject({ held: false, amountSeals: '0' });
    expect((await post(w.base, '/wallet/balance', { address: w.bob.address })).json.lockedSeals).toBe('0');
    expect((await get(w.base, '/supply')).json.marketEscrowObs).toBe(formatObs(0n));
  });

  it('encodes and decodes Marketplace bodies, simulates a purchase, and refuses a stale one', async () => {
    const w = await world();
    w.step([w.sign(w.alice, marketBody(MarketOp.LIST, 'alpha', { amount: PRICE }))]);
    const encoded = await post(w.base, '/tx/encode', { type: 'ONS_MARKET', payload: { op: 'BUY', name: 'alpha', amount: PRICE.toString(), counterparty: w.alice.address } });
    expect(encoded.status).toBe(200);
    expect(encoded.json.body).toBe(Buffer.from(marketBody(MarketOp.BUY, 'alpha', { amount: PRICE, counterparty: w.alice.address })).toString('hex'));
    const decoded = await post(w.base, '/tx/encode', { type: 'ONS_MARKET', body: encoded.json.body });
    expect(decoded.json.decoded).toMatchObject({ op: MarketOp.BUY, name: 'alpha', amount: PRICE.toString(), counterparty: w.alice.address });
    expect((await post(w.base, '/tx/encode', { type: 'ONS_MARKET', payload: { op: 'NOPE' } })).status).toBe(400);

    const live = (gas: bigint, body: Uint8Array) => w.h.sign(w.bob, TxType.ONS_MARKET, body, { gas, protocolTime: w.h.chain.protocolTime });
    const buy = live(expectedGas(PRICE), marketBody(MarketOp.BUY, 'alpha', { amount: PRICE, counterparty: w.alice.address }));
    const sim = (await post(w.base, '/tx/simulate', { tx: Buffer.from(encodeSignedTx(buy)).toString('hex') })).json;
    expect(sim.error).toBeNull();
    expect(sim.valid).toBe(true);
    expect(sim.events.map((e: { type: string }) => e.type)).toEqual(expect.arrayContaining(['ONS_SOLD', 'ONS_TRANSFERRED']));
    // simulating changed nothing
    expect((await get(w.base, '/market/name/alpha')).json.status).toBe('LISTED');

    const stale = live(expectedGas(PRICE - 1n), marketBody(MarketOp.BUY, 'alpha', { amount: PRICE - 1n, counterparty: w.alice.address }));
    const staleSim = (await post(w.base, '/tx/simulate', { tx: Buffer.from(encodeSignedTx(stale)).toString('hex') })).json;
    expect(staleSim.valid).toBe(false);
    expect(staleSim.error).toMatch(/ERR_MARKET_PRICE_MISMATCH/);

    // a real submit goes through the same validation and is included
    const submitted = await post(w.base, '/tx/submit', { tx: Buffer.from(encodeSignedTx(buy)).toString('hex') });
    expect(submitted.status).toBeLessThan(300);
  });

  it('serves Marketplace history from the indexer, filterable by name and address', async () => {
    const w = await world();
    w.step([w.sign(w.alice, marketBody(MarketOp.LIST, 'alpha', { amount: PRICE }))]);
    w.step([w.sign(w.bob, marketBody(MarketOp.BUY, 'alpha', { amount: PRICE, counterparty: w.alice.address }), expectedGas(PRICE))]);
    const events = (await get(w.base, '/market/events?name=alpha')).json.events as Array<{ type: string }>;
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['ONS_LISTED', 'ONS_SOLD']));
    expect((await get(w.base, `/market/events?address=${w.bob.address}`)).json.events.length).toBeGreaterThan(0);
    expect((await get(w.base, '/market/events?name=beta')).json.events).toHaveLength(0);
    const tx = (await get(w.base, `/address/${w.alice.address}`)).json;
    expect(JSON.stringify(tx)).toContain('MARKET_LIST');
    void blockHash;
  });
});
