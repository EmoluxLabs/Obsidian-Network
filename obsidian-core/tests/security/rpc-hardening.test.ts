/**
 * Security suite: RPC surface hardening.
 *
 * These tests drive the real HTTP server (no mocks): a node must refuse to be
 * the weakest link. Covered here: CORS deny-by-default, rate limiting, body
 * size limits, address privacy (no balances and no full addresses on public
 * explorer output), request validation, and the guarantee that no private key
 * material can ever appear in a node response.
 */

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { Indexer } from '../../src/indexer/indexer.js';
import type { Block, ProtocolEvent } from '../../src/protocol/types.js';
import { RpcServer } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';
import { parseObs } from '../../src/protocol/amount.js';
import { TxType } from '../../src/protocol/types.js';
import { encodePaymentBody } from '../../src/transactions/executors/payment.js';
import { encodeSignedTx, signTransaction } from '../../src/transactions/encode.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { addressFromPublicKey, generateKeyPair } from '../../src/crypto/keys.js';

const NET = getNetwork('devnet');
let dir: string;
let chain: ChainManager;
let indexer: Indexer;
let server: RpcServer;
let base: string;
let config: NodeConfig;

const ALLOWED_ORIGIN = 'https://interface.example';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obsidian-security-'));
  chain = new ChainManager({
    dataDir: dir,
    net: NET,
    genesisDocument: {
      networkId: NET.networkId,
      chainId: NET.chainId,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: 1_767_225_600,
      note: 'security suite',
    },
  });
  await chain.init();
  indexer = new Indexer(dir);
  config = {
    ...DEFAULT_CONFIG,
    network: 'devnet',
    rpcPort: 0,
    rpcHost: '127.0.0.1',
    rpcCorsOrigins: [ALLOWED_ORIGIN],
    rpcRateLimitPerMinute: 0,
    dataDir: dir,
  };
  server = new RpcServer({
    chain,
    indexer,
    net: NET,
    config,
    genesisId: computeGenesisId(chain.genesisDocument, NET),
    log: () => undefined,
  });
  const port = await server.listen();
  base = `http://127.0.0.1:${port}`;
});

afterEach(() => {
  config.rpcRateLimitPerMinute = 0;
});

process.on('exit', () => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string; headers: Headers }> {
  const response = await fetch(`${base}${path}`, { headers });
  const raw = await response.text();
  let body: any = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON body */
  }
  return { status: response.status, body, raw, headers: response.headers };
}

async function post(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string; headers: Headers }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  const raw = await response.text();
  let body: any = raw;
  try {
    body = JSON.parse(raw);
  } catch {
    /* non-JSON body */
  }
  return { status: response.status, body, raw, headers: response.headers };
}

describe('RPC origin policy', () => {
  it('denies an origin that is not on the allowlist', async () => {
    const response = await get('/status', { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'ERR_FORBIDDEN' });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the configured origin and never sends a wildcard', async () => {
    const response = await get('/status', { origin: ALLOWED_ORIGIN });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('answers preflight without exposing any data', async () => {
    const response = await fetch(`${base}/tx/submit`, {
      method: 'OPTIONS',
      headers: { origin: ALLOWED_ORIGIN },
    });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('RPC request limits', () => {
  it('sets transport deadlines and connection/header ceilings before routing', () => {
    const transport = (server as any).server;
    expect(transport.headersTimeout).toBe(10_000);
    expect(transport.requestTimeout).toBe(15_000);
    expect(transport.keepAliveTimeout).toBe(5_000);
    expect(transport.timeout).toBe(20_000);
    expect(transport.maxHeadersCount).toBe(100);
    expect(transport.maxConnections).toBe(1_024);
  });

  it('rejects a body larger than the protocol limit', async () => {
    const huge = 'x'.repeat(600 * 1024);
    const response = await post('/tx/submit', { tx: huge });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'ERR_BODY_TOO_LARGE' });
    // the connection is still good afterwards: the next request over it is answered, not reset
    for (let i = 0; i < 3; i += 1) expect((await get('/status')).status).toBe(200);
  });

  it('rate limits a flood once the limit is configured', async () => {
    config.rpcRateLimitPerMinute = 5;
    try {
      let limited = 0;
      for (let i = 0; i < 20; i += 1) {
        const response = await get('/status');
        if (response.status === 429) limited += 1;
      }
      expect(limited).toBeGreaterThan(0);
      const blocked = await get('/status');
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({ code: 'ERR_RATE_LIMITED' });
    } finally {
      config.rpcRateLimitPerMinute = 0;
    }
  });

  it('rejects malformed JSON and unknown routes', async () => {
    const malformed = await post('/wallet/balance', '{not json');
    expect(malformed.status).toBeGreaterThanOrEqual(400);
    expect(malformed.status).toBeLessThan(500);

    const missing = await get('/definitely-not-a-route');
    expect(missing.status).toBe(404);
  });

  /**
   * Every JSON endpoint must answer 400 to a body it cannot parse.
   *
   * Testing one route was not enough: `/wallet/balance` was guarded and
   * `/tx/encode`, `/tx/gas` and `/wallet/quote` were not, so a client that sent
   * an empty or malformed body got `500 ERR_INTERNAL` from those three — the
   * node reporting *its own* failure for the caller's syntax error, and hiding
   * any real 500 behind the same code. This sweeps the whole surface so the
   * distinction cannot drift back.
   */
  it('answers 400, never 500, for an unparseable body on every POST route', async () => {
    const routes = ['/tx/submit', '/tx/simulate', '/tx/encode', '/tx/gas', '/wallet/balance', '/wallet/quote', '/rpc'];
    const bodies = ['', '{', 'not json at all', '[1,2,3', 'null', '"a string"', '123', '[]', '[{"jsonrpc":"2.0","method":"getstatus","id":1}]'];
    const offenders: string[] = [];
    for (const route of routes) {
      for (const body of bodies) {
        const response = await post(route, body);
        if (response.status >= 500) offenders.push(`${route} <= ${JSON.stringify(body.slice(0, 20))} -> ${response.status}`);
        else if (response.status !== 400) offenders.push(`${route} <= ${JSON.stringify(body.slice(0, 20))} -> ${response.status} (expected 400)`);
      }
    }
    expect(offenders, `unparseable bodies that did not answer 400:\n${offenders.join('\n')}`).toEqual([]);
  });

  /**
   * The HTTP verb is part of the contract. A read endpoint used to answer PUT, DELETE and
   * PATCH exactly like GET, and a POST to a read endpoint was served too. Reads answer
   * GET/HEAD, the body-carrying endpoints answer POST, everything else is 405 with Allow.
   */
  it('enforces the HTTP verb: reads are GET/HEAD, body endpoints are POST, nothing else is served', async () => {
    for (const method of ['PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${base}/health`, { method });
      expect(response.status, `${method} /health`).toBe(405);
      expect(response.headers.get('allow')).toContain('GET');
    }
    const postToRead = await fetch(`${base}/health`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(postToRead.status).toBe(405);
    expect(postToRead.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
    const getToWrite = await get('/tx/submit');
    expect(getToWrite.status).toBe(405);
    expect(getToWrite.headers.get('allow')).toBe('POST, OPTIONS');
    for (const route of ['/tx/submit', '/tx/simulate', '/tx/encode', '/tx/gas', '/wallet/balance', '/wallet/quote', '/rpc']) {
      expect((await get(route)).status, `GET ${route}`).toBe(405);
    }
    // the reads and the writes themselves still work, and a trailing slash is the same route
    expect((await get('/health')).status).toBe(200);
    expect((await get('/health/')).status).toBe(200);
    expect((await fetch(`${base}/health`, { method: 'HEAD' })).status).toBe(200);
    expect((await post('/tx/submit/', {})).status).toBe(400);
  });

  it('names the missing transaction type instead of trailing off', async () => {
    const empty = await post('/tx/encode', {});
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ error: 'transaction type is required', code: 'ERR_MALFORMED' });

    const unknown = await post('/tx/encode', { type: 'NOT_A_TYPE' });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ error: 'unknown transaction type NOT_A_TYPE', code: 'ERR_MALFORMED' });
  });

  it('requires a valid address for balance lookups', async () => {
    const bad = await post('/wallet/balance', { address: 'obs1notarealaddress' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('ERR_BAD_ADDRESS');

    const missing = await post('/wallet/balance', {});
    expect(missing.status).toBe(400);
  });
});

describe('explorer privacy (spec §32)', () => {
  it('never exposes a wallet balance from public explorer routes', async () => {
    const pair = generateKeyPair();
    const address = addressFromPublicKey(pair.publicKey, NET.addressHrp);
    for (const path of ['/status', '/supply', `/address/${address}`, '/blocks', '/params', '/names']) {
      const response = await get(path);
      // `/wallet/balance` is the only route allowed to answer with a wallet
      // balance, and it is a POST that names the address it belongs to. The
      // mining pool balance shown by /status is protocol state, not a wallet.
      expect(response.raw, `${path} must not carry a wallet balance field`).not.toContain('"balanceObs"');
      expect(response.raw, `${path} must not echo the queried address`).not.toContain(address);
    }
  });

  it('masks addresses on public history output', async () => {
    const pair = generateKeyPair();
    const address = addressFromPublicKey(pair.publicKey, NET.addressHrp);
    const response = await get(`/address/${address}`);
    expect(response.status).toBe(200);
    expect(response.body.address).toContain('…');
    expect(response.raw).not.toContain(address);
  });

  it('masks the miner inside mining claim records as well', async () => {
    // Regression: `/address/:address` echoed `miningClaims[].miner` verbatim,
    // so the one field the explorer is required to hide leaked through the
    // claims list. Index a real claim event and check the whole response.
    const pair = generateKeyPair();
    const address = addressFromPublicKey(pair.publicKey, NET.addressHrp);
    indexer.indexBlock(
      {
        header: {
          protocolVersion: PROTOCOL_VERSION,
          chainId: NET.chainId,
          height: 900_001,
          prevHash: '0'.repeat(64),
          txRoot: '0'.repeat(64),
          stateRoot: '0'.repeat(64),
          paramsHash: '0'.repeat(64),
          timestamp: 1_767_225_600,
          producer: address,
          cumulativePotWeight: 1n,
          txCount: 0,
          eventsRoot: '0'.repeat(64),
          producerSignature: { publicKey: pair.publicKey, signature: '00' },
        },
        transactions: [],
      } as unknown as Block,
      [
        {
          type: 'MINING_CLAIM',
          height: 900_001,
          txId: 'ab'.repeat(32),
          data: {
            miner: address,
            reward: '166666666666666',
            claimId: 'claim-regression-1',
            genesisAwarded: false,
            protocolTime: 1_767_225_600,
          },
        } as unknown as ProtocolEvent,
      ],
      chain.world,
    );

    const history = await get(`/address/${address}`);
    expect(history.status).toBe(200);
    expect(history.body.miningClaims.length).toBeGreaterThan(0);
    expect(history.body.miningClaims[0].miner).toContain('…');
    expect(history.raw, 'no explorer route may echo the full address').not.toContain(address);

    const claims = await get(`/mining/claims?miner=${address}`);
    expect(claims.status).toBe(200);
    expect(claims.raw).not.toContain(address);
  });

  it('rejects an address belonging to another network', async () => {
    const pair = generateKeyPair();
    const mainnetAddress = addressFromPublicKey(pair.publicKey, 'obs');
    const response = await get(`/address/${mainnetAddress}`);
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('ERR_BAD_ADDRESS');
  });
});

describe('transaction submission guardrails', () => {
  it('rejects a transaction for the wrong chain', async () => {
    const pair = generateKeyPair();
    const address = addressFromPublicKey(pair.publicKey, NET.addressHrp);
    const tx = signTransaction({
      sender: address,
      privateKeyHex: pair.privateKey,
      publicKeyHex: pair.publicKey,
      chainId: 7777, // mainnet chain id on a devnet node
      protocolVersion: PROTOCOL_VERSION,
      nonce: 0,
      type: TxType.PAYMENT,
      gas: expectedGas(parseObs('1')),
      body: encodePaymentBody({ to: address, amount: parseObs('1') }),
      validUntil: chain.protocolTime + 600,
    });
    const response = await post('/tx/submit', { tx: Buffer.from(encodeSignedTx(tx)).toString('hex') });
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('ERR_WRONG_CHAIN_ID');
  });

  it('rejects garbage hex and a missing body', async () => {
    const garbage = await post('/tx/submit', { tx: 'deadbeef' });
    expect(garbage.status).toBeGreaterThanOrEqual(400);
    expect(garbage.status).toBeLessThan(500);

    const empty = await post('/tx/submit', {});
    expect(empty.status).toBe(400);
  });

  it('JSON-RPC: odd field types are an error object, never a crash, and a list is bounded', async () => {
    for (const request of [
      { jsonrpc: '2.0', id: { a: 1 }, method: { b: 1 }, params: 'x' },
      { jsonrpc: '2.0', id: 1, method: 'getblocks', params: { from: -5, limit: 1e12 } },
      { jsonrpc: '2.0', id: 1, method: 'getblocks', params: { from: 'x', limit: 'y' } },
      { jsonrpc: '2.0', id: 1, method: 'getblocks', params: [1, 2] },
      { jsonrpc: '2.0', id: 1, method: '__proto__', params: { __proto__: { polluted: true } } },
      { jsonrpc: '2.0', id: 1, method: 'constructor' },
    ]) {
      const response = await post('/rpc', request);
      expect(response.status, JSON.stringify(request)).toBe(200);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const list = await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'getblocks', params: { from: 0, limit: 1e12 } });
    expect(Array.isArray((list.body as { result: unknown[] }).result)).toBe(true);
    expect(((list.body as { result: unknown[] }).result).length).toBeLessThanOrEqual(500);
  });

  it('the name registry is paged and bounded on every route that reads it (REST and JSON-RPC)', async () => {
    const registry = chain.world.s.names;
    const before = new Map(registry);
    try {
      const owner = addressFromPublicKey(generateKeyPair().publicKey, NET.addressHrp);
      for (let i = 0; i < 1_200; i += 1) {
        const name = `${i % 3 === 0 ? 'alpha' : 'beta'}${String(i).padStart(4, '0')}`;
        registry.set(name, { name, owner, address: owner, registeredAtHeight: 1, registeredAt: 1, expiresAt: 2, transferCount: 0 });
      }
      const total = registry.size;
      const first = (await get('/names')).body;
      expect(first.names.length).toBe(200);
      expect(first).toMatchObject({ count: total, offset: 0, limit: 200, hasMore: true });
      const huge = (await get('/names?limit=99999999')).body;
      expect(huge.names.length).toBe(500);
      expect(huge.limit).toBe(500);
      expect((await get('/names?limit=-3')).body.limit).toBe(1);
      expect((await get('/names?limit=abc&offset=zzz')).body).toMatchObject({ limit: 200, offset: 0 });
      // pages do not overlap and the last one says there is no more
      const page2 = (await get('/names?limit=500&offset=500')).body;
      expect(page2.names[0].name).not.toBe(huge.names[0].name);
      const last = (await get(`/names?limit=500&offset=${total - 10}`)).body;
      expect(last.names.length).toBe(10);
      expect(last.hasMore).toBe(false);
      // prefix narrows (and is honoured at all: it used to be ignored)
      const alpha = (await get('/names?prefix=ALPHA&limit=500')).body;
      expect(alpha.matched).toBe(400);
      expect(alpha.names.every((n: { name: string }) => n.name.startsWith('alpha'))).toBe(true);
      // JSON-RPC: bounded the same way, and a hostile prefix or offset is just an empty or clamped page
      const rpc = async (params: unknown) => ((await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'getnames', params })).body as { result: string[] }).result;
      expect((await rpc({})).length).toBe(200);
      expect((await rpc({ limit: 1e12 })).length).toBe(500);
      expect((await rpc({ prefix: 'alpha', limit: 3 })).every((n) => n.startsWith('alpha'))).toBe(true);
      expect((await rpc({ offset: 1e15 })).length).toBe(0);
      expect((await rpc({ prefix: { $ne: 1 }, limit: 'x' })).length).toBe(200);
    } finally {
      registry.clear();
      for (const [key, value] of before) registry.set(key, value);
    }
  });

  it('an oversized JSON-RPC body is 413, like every other route', async () => {
    const response = await post('/rpc', '{"jsonrpc":"2.0","method":"x","params":["' + 'a'.repeat(600 * 1024) + '"],"id":1}');
    expect(response.status).toBe(413);
  });

  it('answers a JSON-RPC batch without leaking internal state', async () => {
    const response = await post('/rpc', { jsonrpc: '2.0', id: 1, method: 'getstatus', params: [] });
    expect(response.status).toBe(200);
    expect(response.raw).not.toMatch(/privateKey|mnemonic|seedPhrase/i);
  });
});

/** Every field name appearing anywhere in a JSON document. */
function fieldNames(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) fieldNames(entry, out);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key.toLowerCase());
      fieldNames(entry, out);
    }
  }
  return out;
}

describe('private material never crosses the wire', () => {
  it('no route echoes a private key, mnemonic or keystore secret', async () => {
    const forbiddenFields = ['privatekey', 'secretkey', 'mnemonic', 'seedphrase', 'recoveryphrase', 'passphrase'];
    const wallet = generateKeyPair();
    const routes = [
      '/health',
      '/status',
      '/params',
      '/version',
      '/genesis',
      '/supply',
      '/nodes',
      '/peers',
      '/oracle',
      '/validators',
      '/blocks',
      '/mempool',
      '/names',
      '/finality',
      '/revenue',
      '/nodes/rewards',
      '/network',
      '/audit/decentralization',
      '/audit/compliance',
    ];
    for (const path of routes) {
      const response = await get(path);
      expect(response.status, `${path} should succeed`).toBe(200);
      for (const field of fieldNames(response.body)) {
        expect(forbiddenFields, `${path} exposes a "${field}" field`).not.toContain(field);
      }
      expect(response.raw, `${path} leaked a private key`).not.toContain(wallet.privateKey);
    }
  });

  it('the compliance audit reports the removed mechanics as absent', async () => {
    const response = await get('/audit/compliance');
    expect(response.status).toBe(200);
    for (const key of [
      'wac',
      'legacyGenesisAllocation',
      'signupAllocation',
      'miningKyc',
      'miningWithdrawalRequiresWac',
      'nativeExchange',
      'explorerExposesBalances',
      // Proof of Time and node runner guarantees, asserted the same way: the
      // running parameters must say these mechanisms are not there.
      'proofOfWorkConsensus',
      'blockHeaderNonce',
      'selfReportedNodeMetrics',
      'adminRewardOverride',
      'gasCountedAsPlatformRevenue',
      'nodeIdentityIsIpAddress',
    ]) {
      expect(response.body[key], `${key} must exist in the audit`).toBeDefined();
      expect(response.body[key].present, `${key} must be reported absent`).toBe(false);
    }

    // And one positive claim: the split is enforced, with the numbers stated.
    expect(response.body.revenueSplitEnforced.present).toBe(true);
    expect(response.body.revenueSplitEnforced.evidence).toContain('90% node runners / 10% treasury');

    // The CI job greps this same document for a list of forbidden names, and a
    // missing row reads as "present" to that check. Read the list out of the
    // workflow and assert the running node answers every single one: a row
    // renamed in one place and not the other has broken this job before.
    const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const list = /const forbidden = \[([\s\S]*?)\];/.exec(workflow);
    expect(list, 'CI still carries the removed-feature list').not.toBeNull();
    const checked = [...list![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
    expect(checked.length).toBeGreaterThanOrEqual(16);
    for (const key of checked) {
      expect(response.body[key], `${key} is checked by CI and must exist in the audit`).toBeDefined();
      expect(response.body[key].present, `${key} is checked by CI and must be reported absent`).toBe(false);
    }
    expect(checked).toContain('gasCountedAsPlatformRevenue');
  });

  it('publishes the Proof of Time state without a hash rate anywhere in it', async () => {
    const response = await get('/pot');
    expect(response.status).toBe(200);
    expect(response.body.consensus).toBe('PROOF_OF_TIME');
    expect(response.body.difficulty.role).toBe('MEASUREMENT');
    expect(response.body.timeAuthority.authoritative).toBe('PROTOCOL_TIME_FROM_CHAIN');
    expect(response.body.timeAuthority.neverAuthoritative).toContain('BROWSER_CLOCK');
    expect(response.raw.toLowerCase()).not.toContain('hashrate');
    expect(response.raw.toLowerCase()).not.toContain('hash rate');
  });

  it('publishes the v1.6 validator bond and ONS revenue split', async () => {
    const response = await get('/params');
    expect(response.status).toBe(200);
    expect(response.body.consensus.validatorBondObs).toBe('20000.000000000000000000');
    expect(response.body.nodeRewards.nodePoolBps).toBe(9_000);
    expect(response.body.nodeRewards.treasuryBps).toBe(1_000);
  });

  it('publishes ONS-only revenue accounting without exposing a wallet balance', async () => {
    const response = await get('/revenue');
    expect(response.status).toBe(200);
    expect(response.body.split.nodePoolBps).toBe(9_000);
    expect(response.body.split.treasuryBps).toBe(1_000);
    expect(response.body.onsRevenueObs).toBeDefined();
    expect(response.body.notOnsRevenue).toBeDefined();
    expect(response.body.split.sumsBack).toBe(true);
    expect(response.body.gas.destination).toBe('MINING_POOL');
    // The explorer privacy rule still holds on the new route.
    for (const field of fieldNames(response.body)) {
      expect(['balance', 'balanceObs', 'balanceSeals'], `/revenue exposes "${field}"`).not.toContain(field);
    }
  });

  it('serves the node registry honestly on a chain with no registered nodes', async () => {
    const response = await get('/nodes/registry');
    expect(response.status).toBe(200);
    expect(response.body.registeredNodes).toBe(0);
    expect(response.body.nodes).toEqual([]);
    expect(response.body.note).toContain('recomputed from chain state');

    const unknown = await get('/nodes/status/' + 'ab'.repeat(20));
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('ERR_NODE_NOT_REGISTERED');
  });
});

/**
 * `/metrics` is the route most likely to be exposed to a whole monitoring
 * network, so what it must NOT contain matters as much as what it does.
 */
describe('GET /metrics', () => {
  it('serves Prometheus text with the numbers an operator alerts on', async () => {
    {
      const response = await fetch(`${base}/metrics`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/plain; version=0.0.4');
      const body = await response.text();

      for (const name of [
        'obsidian_chain_height',
        'obsidian_peers',
        'obsidian_mempool_transactions',
        'obsidian_supply_obs',
        'obsidian_max_supply_obs',
        'obsidian_pool_balance_obs',
        'obsidian_active_miners',
        'obsidian_supply_invariant_ok',
        'obsidian_uptime_seconds',
      ]) {
        expect(body, `missing ${name}`).toContain(`# TYPE ${name} `);
        expect(new RegExp(`^${name}\\{[^}]*\\} -?[0-9.]+$`, 'm').test(body), `${name} has no numeric sample`).toBe(true);
      }

      // Every sample carries the network it came from, so one Prometheus can
      // scrape a mainnet and a devnet node without conflating them.
      expect(body).toContain('network="devnet"');
      expect(body).toContain('chain_id="7780"');
      expect(body).toContain('obsidian_supply_invariant_ok{network="devnet",chain_id="7780"} 1');
    }
  });

  /**
   * The dashboard and the alert rules are shipped files referencing metric
   * names by string. A renamed metric would leave an operator watching an
   * empty panel and an alert that can never fire — silent, and exactly when
   * monitoring matters. So both directions are checked: nothing referenced is
   * missing, and nothing served is unwatched.
   */
  it('matches the shipped Grafana dashboard and alert rules', async () => {
    const body = await (await fetch(`${base}/metrics`)).text();
    const served = new Set([...body.matchAll(/^([a-z_]+)\{/gm)].map((m) => m[1]));
    expect(served.size).toBeGreaterThan(10);

    const root = new URL('../../deployment/monitoring/', import.meta.url);
    const dashboard = readFileSync(new URL('grafana-dashboard.json', root), 'utf8');
    const alerts = readFileSync(new URL('obsidian-alerts.yml', root), 'utf8');
    JSON.parse(dashboard); // a dashboard that will not parse cannot be imported

    const referenced = new Set([
      ...[...dashboard.matchAll(/(obsidian_[a-z_]+)/g)].map((m) => m[1]),
      ...[...alerts.matchAll(/(obsidian_[a-z_]+)/g)].map((m) => m[1]),
    ]);

    const missing = [...referenced].filter((name) => !served.has(name)).sort();
    expect(missing, `referenced by monitoring but not served: ${missing.join(', ')}`).toEqual([]);

    const unwatched = [...served].filter((name) => !referenced.has(name)).sort();
    expect(unwatched, `served but on no panel or alert: ${unwatched.join(', ')}`).toEqual([]);
  });

  /**
   * Routing is half of monitoring. These assert the shipped Alertmanager file
   * is coherent with the rules beside it, and that it cannot be deployed by
   * accident: every destination is a placeholder, so Alertmanager refuses to
   * start until a human supplies a real one.
   */
  it('routes every alert it defines, and refuses to ship a working destination', () => {
    const root = new URL('../../deployment/monitoring/', import.meta.url);
    const alerts = readFileSync(new URL('obsidian-alerts.yml', root), 'utf8');
    const routing = readFileSync(new URL('alertmanager.yml', root), 'utf8');

    // Every receiver referenced by the routing tree must be defined.
    const referenced = [...routing.matchAll(/receiver: ([a-z-]+)/g)].map((m) => m[1]);
    const defined = [...routing.matchAll(/^  - name: ([a-z-]+)$/gm)].map((m) => m[1]);
    const undefinedReceivers = referenced.filter((name) => !defined.includes(name));
    expect(undefinedReceivers, `routed to undefined receivers: ${undefinedReceivers.join(', ')}`).toEqual([]);

    // The alert that must never be batched is routed with no group wait.
    expect(routing).toMatch(/alertname = "ObsidianSupplyInvariantBroken"[\s\S]*?group_wait: 0s/);

    // Any alertname mentioned in the routing must actually exist in the rules.
    const ruleNames = [...alerts.matchAll(/- alert: (\w+)/g)].map((m) => m[1]);
    expect(ruleNames.length).toBeGreaterThanOrEqual(6);
    for (const match of routing.matchAll(/alertname = "(\w+)"/g)) {
      expect(ruleNames, `routing references unknown alert ${match[1]}`).toContain(match[1]);
    }

    // And nothing here is a usable destination.
    const liveUrls = [...routing.matchAll(/url: '([^']+)'/g)].map((m) => m[1]).filter((url) => !url.includes('CHANGE-ME'));
    expect(liveUrls, `a real destination is committed: ${liveUrls.join(', ')}`).toEqual([]);
  });

  it('leaks no address, balance or key material', async () => {
    {
      const body = await (await fetch(`${base}/metrics`)).text();
      // No bech32 address of any network, and nothing that looks like a key.
      expect(/\b(obs|tobs|sobs|dobs)1[02-9ac-hj-np-z]{10,}/.test(body)).toBe(false);
      expect(/[0-9a-f]{64}/.test(body)).toBe(false);
      expect(body.toLowerCase()).not.toContain('passphrase');
      expect(body.toLowerCase()).not.toContain('recipient');
      expect(body.toLowerCase()).not.toContain('privatekey');
    }
  });
});
