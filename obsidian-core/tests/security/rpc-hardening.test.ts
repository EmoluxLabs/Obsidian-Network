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
import { mkdtempSync, rmSync } from 'node:fs';
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

async function post(path: string, payload: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any; raw: string }> {
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
  return { status: response.status, body, raw };
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
  it('rejects a body larger than the protocol limit', async () => {
    const huge = 'x'.repeat(600 * 1024);
    const response = await post('/tx/submit', { tx: huge });
    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({ code: 'ERR_BODY_TOO_LARGE' });
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

describe('Circle registry reads', () => {
  it('lists a country first-level divisions with live GLVs', async () => {
    const response = await get('/land/divisions?country=NG');
    expect(response.status).toBe(200);
    const body = response.body as { country: string; divisions: Array<Record<string, unknown>>; count: number };
    expect(body.country).toBe('NG');
    expect(body.count).toBeGreaterThan(0);
    for (const division of body.divisions) {
      expect(String(division.divisionId).startsWith('NG-') || division.divisionId === 'NG').toBe(true);
      // GLV is denominated in OBS now, not USD: a plain decimal, no currency sign.
      expect(String(division.glvObs)).toMatch(/^\d+\.\d+$/);
      expect(typeof division.protocolPurchases).toBe('number');
    }
  });

  it('refuses a country code that is not alpha-2 and answers an unknown code honestly', async () => {
    expect((await get('/land/divisions?country=Nigeria')).status).toBe(400);
    expect((await get('/land/divisions?country=NG-GEN')).status).toBe(400);
    const unknown = await get('/land/divisions?country=ZZ');
    expect(unknown.status).toBe(200);
    expect((unknown.body as { divisions: unknown[] }).divisions).toEqual([]);
  });
});

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
      '/land/countries',
      '/land/divisions?country=NG',
      '/land/search?q=Lagos',
      '/land/parcels',
      '/capsules',
      '/social/feed',
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
    expect(response.body.revenueSplitEnforced.evidence).toContain('40% node runners / 60% treasury');
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

  it('publishes revenue accounting without exposing a single wallet balance', async () => {
    const response = await get('/revenue');
    expect(response.status).toBe(200);
    expect(response.body.split.nodePoolBps).toBe(4_000);
    expect(response.body.split.treasuryBps).toBe(6_000);
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
