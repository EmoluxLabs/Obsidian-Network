/**
 * RPC error contract and client identification.
 *
 * What the CALLER got wrong is a 4xx, never a 500: a 500 blames the node for the
 * client's typo and buries real internal failures among them. And behind a
 * reverse proxy every connection arrives from the proxy, so rate limiting only
 * means anything if it can tell the clients apart.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import { Indexer } from '../../src/indexer/indexer.js';
import { RpcServer, usdToMicro } from '../../src/rpc/server.js';
import { DEFAULT_CONFIG, type NodeConfig } from '../../src/config/config.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { genesisId as computeGenesisId } from '../../src/genesis/initialize.js';

const NET = getNetwork('devnet');
let dir: string;
let chain: ChainManager;
let server: RpcServer;
let base: string;
let config: NodeConfig;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'obsidian-rpc-contract-'));
  chain = new ChainManager({
    dataDir: dir,
    net: NET,
    genesisDocument: { networkId: NET.networkId, chainId: NET.chainId, protocolVersion: PROTOCOL_VERSION, timestamp: 1_767_225_600, note: 'rpc contract suite' },
  });
  await chain.init();
  config = { ...DEFAULT_CONFIG, network: 'devnet', rpcPort: 0, rpcHost: '127.0.0.1', rpcCorsOrigins: [], rpcRateLimitPerMinute: 0, dataDir: dir };
  server = new RpcServer({
    chain,
    indexer: new Indexer(dir),
    net: NET,
    config,
    genesisId: computeGenesisId(chain.genesisDocument, NET),
    log: () => undefined,
  });
  base = `http://127.0.0.1:${await server.listen()}`;
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  config.rpcRateLimitPerMinute = 0;
  config.rpcTrustProxy = false;
});

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();
  try {
    return { status: response.status, body: JSON.parse(raw) };
  } catch {
    return { status: response.status, body: raw };
  }
}
const post = (path: string, payload: unknown, headers: Record<string, string> = {}) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(payload) });

describe('client mistakes are 400, not 500', () => {
  it('malformed percent-encoding in a path', async () => {
    for (const path of ['/block/%E0%A4%A', '/names/%', '/tx/%zz', '/address/%C0%AF']) {
      const result = await call(path);
      expect(result.status, path).toBe(400);
      expect(result.body.code, path).toBe('ERR_MALFORMED');
    }
  });

  it('/tx/simulate: text that is not hex, and hex that is not a transaction', async () => {
    const notHex = await post('/tx/simulate', { tx: 'zz-not-hex' });
    expect(notHex.status).toBe(400);
    const undecodable = await post('/tx/simulate', { tx: '00' });
    expect(undecodable.status).toBe(400);
    expect(undecodable.body.code).toBe('ERR_MALFORMED');
    expect((await post('/tx/simulate', {})).status).toBe(400);
  });

  it('quotes: a USD amount or OBS amount that is not a number', async () => {
    const address = 'dobs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
    expect((await post('/tx/gas', { usd: 'abc' })).status).toBe(400);
    expect((await post('/tx/gas', { usd: '-1' })).status).toBe(400);
    expect((await post('/tx/gas', { usd: '1.1234567' })).status).toBe(400); // more precision than micro-USD
    expect((await post('/tx/gas', { amountObs: 'many' })).status).toBe(400);
    expect((await post('/tx/gas', { amountObs: '1.5', usd: '2.25' })).status).toBe(200);
    // wallet/quote validates the address first, then the amounts
    expect((await post('/wallet/quote', { address, usd: 'abc' })).status).toBe(400);
  });

  it('a Host header that cannot form a URL', async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const url = new URL(base);
        const req = request({ host: url.hostname, port: url.port, path: '/health', headers: { Host: 'bad host with spaces' } }, (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0 });
        });
        req.on('error', reject);
        req.end();
      });
    });
    expect([400, 200]).toContain(result.status); // never a 500
    expect(result.status).not.toBe(500);
  });
});

describe('exact decimal USD', () => {
  it('parses without going through a float', () => {
    expect(usdToMicro('0.29')).toBe(290_000n); // 0.29 * 1e6 is 290000.00000000006 in floating point
    expect(usdToMicro('12')).toBe(12_000_000n);
    expect(usdToMicro('0.000001')).toBe(1n);
    expect(usdToMicro('1234567.123456')).toBe(1_234_567_123_456n);
    for (const bad of ['', 'abc', '-1', '1e3', '1.', '.5', '1.1234567', 'NaN', 'Infinity', '1,5']) {
      expect(() => usdToMicro(bad), JSON.stringify(bad)).toThrow(/invalid USD amount/);
    }
  });
});

describe('same-origin browsers are not blocked, cross-origin ones still are', () => {
  it('lets a page served from this node call it, and refuses an unlisted foreign origin', async () => {
    const same = await call('/health', { headers: { origin: base } });
    expect(same.status).toBe(200);
    const foreign = await call('/health', { headers: { origin: 'https://evil.example' } });
    expect(foreign.status).toBe(403);
    // A foreign origin that merely CONTAINS our host is not "same origin".
    const lookalike = await call('/health', { headers: { origin: `${base}.evil.example` } });
    expect(lookalike.status).toBe(403);
  });
});

describe('rate limiting tells clients apart behind a proxy', () => {
  it('without rpcTrustProxy every client shares the proxy\'s bucket, and a spoofed header changes nothing', async () => {
    config.rpcRateLimitPerMinute = 4;
    config.rpcTrustProxy = false;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) statuses.push((await call('/version', { headers: { 'x-forwarded-for': `10.0.0.${i}` } })).status);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });

  it('with rpcTrustProxy each real client gets its own bucket, taken from the LAST forwarded entry', async () => {
    config.rpcRateLimitPerMinute = 3;
    config.rpcTrustProxy = true;
    const hit = (xff: string) => call('/version', { headers: { 'x-forwarded-for': xff } });
    // Client A uses up its budget...
    const a: number[] = [];
    for (let i = 0; i < 5; i += 1) a.push((await hit('198.51.100.1')).status);
    expect(a.slice(0, 3)).toEqual([200, 200, 200]);
    expect(a.slice(3)).toEqual([429, 429]);
    // ...which does not touch client B.
    expect((await hit('198.51.100.2')).status).toBe(200);
    // A client cannot shed its limit by PREPENDING addresses: the proxy's own
    // entry is the last one, and that is the one that counts.
    expect((await hit('203.0.113.77, 198.51.100.1')).status).toBe(429);
    // Garbage in the header falls back to the socket address rather than crashing.
    expect([200, 429]).toContain((await hit('not an ip')).status);
  });
});

describe('one pending transaction per sender and nonce', () => {
  it('refuses a second transaction with the same nonce, and treats a re-send of the same one as success', async () => {
    const { generateKeyPair } = await import('../../src/crypto/keys.js');
    const { signTransaction, encodeSignedTx } = await import('../../src/transactions/encode.js');
    const { TxType } = await import('../../src/protocol/types.js');
    const { encodeMiningBody, computeClaimId } = await import('../../src/transactions/executors/mining.js');
    const keys = generateKeyPair(NET.addressHrp);
    const build = (validUntilOffset: number) =>
      signTransaction({
        sender: keys.address,
        privateKeyHex: keys.privateKey,
        publicKeyHex: keys.publicKey,
        chainId: NET.chainId,
        protocolVersion: PROTOCOL_VERSION,
        nonce: 0,
        type: TxType.MINING_CLAIM,
        gas: 0n,
        body: encodeMiningBody({ claimId: computeClaimId(NET.chainId, keys.address, 1, 0), claimSequence: 1 }),
        validUntil: chain.protocolTime + validUntilOffset,
      });
    const first = build(300);
    const second = build(301); // same sender, same nonce, different transaction
    const hex = (tx: ReturnType<typeof build>) => Buffer.from(encodeSignedTx(tx)).toString('hex');

    const accepted = await post('/tx/submit', { tx: hex(first) });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body.accepted).toBe(true);

    const clash = await post('/tx/submit', { tx: hex(second) });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('ERR_NONCE_PENDING');
    expect(clash.body.pendingTxId).toBe(first.id);

    const again = await post('/tx/submit', { tx: hex(first) });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(chain.mempool.size).toBeGreaterThanOrEqual(1);
    expect(chain.mempool.findBySenderNonce(keys.address, 0)?.tx.id).toBe(first.id);
  });
});

describe('a node says only what is true of the network it follows', () => {
  it('a devnet node names its own hostname and none of mainnet\'s', async () => {
    // Those names are what people use to check a wallet address. A practice
    // chain answering "these are the official domains" with mainnet's list
    // trains them to trust the wrong thing; each network names only its own.
    const result = await call('/network');
    expect(result.status).toBe(200);
    expect(result.body.network.name).toBe('devnet');
    expect(result.body.domains).toEqual(['devnet.obsmainnet.us.ci']);
    for (const mainnetHost of ['obsmainnet.us.ci', 'api.obsmainnet.us.ci', 'wallet.obsmainnet.us.ci']) {
      expect(result.body.domains).not.toContain(mainnetHost);
    }
  });

  it('the decentralisation audit lists no Google dependency, because there is none', async () => {
    // Google sign-in was removed in 1.2.0: accounts are an email address, a
    // password and TOTP. An audit endpoint that still named it would be a
    // false statement about the system, served by the system.
    const audit = await call('/audit/decentralization');
    expect(audit.status).toBe(200);
    const components = (audit.body.centralisedDependencies as Array<{ component: string }>).map((d) => d.component);
    expect(components).not.toContain('Google OAuth');
    expect(JSON.stringify(audit.body)).not.toMatch(/OAuth/);
    expect(audit.body.questions.every((q: { answer: string }) => q.answer === 'NO')).toBe(true);
  });
});

describe('the public surface tells the truth about bonds and slashing', () => {
  it('/validators publishes the slash rule, its destination and the applied ledger', async () => {
    const result = await call('/validators');
    expect(result.status).toBe(200);
    const slashing = result.body.slashing;
    expect(slashing.slashBps).toBe(CONSENSUS_PARAMS.consensus.equivocationSlashBps);
    expect(slashing.bondObs).toBe('20000.000000000000000000');
    expect(slashing.slashObs).toBe('10000.000000000000000000');
    expect(slashing.destination).toBe('MINING_POOL');
    expect(slashing.treasuryShareObs).toBe('0');
    // A slash is a state transition, and the endpoint says who may start one.
    // The API is not the enforcement point: it reports what consensus did.
    expect(slashing.submitter).toMatch(/any account may submit/i);
    expect(slashing.rule).toMatch(/offline|missed-slot jail/i);
    expect(slashing.count).toBe(0);
    expect(slashing.shown).toBe(0);
    // The ledger in consensus state is unbounded, the response is not: a reader
    // gets a page and the exact total.
    expect(result.body.appliedSlashes).toEqual([]);
  });

  it('no endpoint publishes a node-runner registration bond, because none exists', async () => {
    const params = await call('/params');
    expect(params.status).toBe(200);
    expect(JSON.stringify(params.body)).not.toMatch(/registrationBond/);
    const rewards = await call('/nodes/rewards');
    expect(rewards.status).toBe(200);
    expect(JSON.stringify(rewards.body)).not.toMatch(/registrationBond|bondObs/);
    const registry = await call('/nodes');
    expect(registry.status).toBe(200);
    expect(JSON.stringify(registry.body)).not.toMatch(/bondObs/);
  });
});
