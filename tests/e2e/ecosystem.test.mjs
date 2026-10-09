/**
 * The interface's own code, driving a real node through a real interface server.
 *
 *   node --test tests/e2e/ecosystem.test.mjs
 *   SKIP_E2E=1 node --test tests/e2e/ecosystem.test.mjs     # skip on a slow machine
 *
 * Every defect this test pins was found the same way a user finds it: by clicking. The browser signed
 * transactions the node refused, nothing could say where revenue went, and nothing could prove that a
 * validator's bond was the one consensus demands. The unit tests cannot see those, because each side
 * was self-consistent; only the two together disagree.
 *
 * So this bundles the REAL `operations.ts`, `client.ts` and `wallet.ts` the browser ships, runs them in
 * Node against a devnet node started the way the guides say, in front of the real interface server, and
 * checks the outcome on the chain through the same API a page uses.
 *
 * Needs both packages built (npm --prefix obsidian-core run build && npm --prefix obsidian-interface run build).
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { after, before } from 'node:test';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CORE = join(ROOT, 'obsidian-core');
const IFACE = join(ROOT, 'obsidian-interface');
const NODE_ENTRY = join(CORE, 'dist', 'index.js');
const IFACE_ENTRY = join(IFACE, 'dist', 'server', 'main.js');
const RPC = 49130;
const P2P = 49131;
const UI = 49288;
const NODE_URL = `http://127.0.0.1:${RPC}`;
const UI_URL = `http://127.0.0.1:${UI}`;
const PASSPHRASE = 'a passphrase long enough for the vault';

const skip = process.env.SKIP_E2E === '1' ? 'SKIP_E2E=1' : !existsSync(NODE_ENTRY) || !existsSync(IFACE_ENTRY) ? 'build obsidian-core and obsidian-interface first' : false;
const SCALE = (() => {
  const fromEnv = Number(process.env.OBSIDIAN_E2E_TIMEOUT_SCALE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = cpus()?.length || 1;
  return cores >= 6 ? 1 : cores >= 4 ? 2 : 3;
})();
const ms = (base) => Math.round(base * SCALE);

const children = [];
const dirs = [];
let lib; // the bundled browser code
let client;
const wallets = {};

function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `obsidian-eco-${label}-`));
  dirs.push(dir);
  return dir;
}

function launch(label, entry, args, cwd) {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...process.env, OBSIDIAN_KEYSTORE_PASSPHRASE: PASSPHRASE }, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { label, child, log: [], code: null };
  child.stdout.on('data', (chunk) => record.log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => record.log.push(chunk.toString()));
  child.on('exit', (code) => {
    record.code = code ?? -1;
  });
  children.push(record);
  return record;
}

const tail = (record) => record.log.join('').split('\n').slice(-12).join('\n');

async function waitFor(condition, timeout, what, record) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    if (record && record.code !== null) throw new Error(`${record.label} exited early (code ${record.code}) while waiting for ${what}\n${tail(record)}`);
    try {
      const value = await condition();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 400));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}${record ? `\n${tail(record)}` : ''}`);
}

const get = async (url, init) => {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
};

/**
 * The next nonce the chain expects from a wallet. Waiting is done against the node itself, not through the
 * interface: the interface rate-limits each client (as it should), and polling it every few hundred
 * milliseconds is not what a page does. The interface sees only the calls this test is about.
 */
const nonceOf = async (wallet) => (await get(`${NODE_URL}/wallet/${encodeURIComponent(wallet.address)}/next-nonce`)).body.nextNonce;

/** Wait until the chain has accepted every transaction `address` has sent so far (its nonce moved on). */
async function mined(address, afterNonce) {
  await waitFor(async () => (await get(`${NODE_URL}/wallet/${encodeURIComponent(address)}/next-nonce`)).body.nextNonce > afterNonce, ms(60_000), `a transaction from ${address.slice(0, 12)}… to be mined`);
}

/** An exact OBS decimal string (`0.050000000000000000`) as a seal count, without a float. */
function seals(obs) {
  const [whole, fraction = ''] = String(obs).split('.');
  return BigInt(whole + fraction.padEnd(18, '0').slice(0, 18));
}

/** Run one operation, wait for it to be mined, return what it returned. */
async function done(wallet, run) {
  const before = await nonceOf(wallet);
  const result = await run();
  await mined(wallet.address, before);
  return result;
}

before(async () => {
  if (skip) return;
  // The browser's own modules, bundled for Node: the same sources scripts/build-web.mjs ships.
  const dir = scratch('bundle');
  const entry = join(dir, 'entry.ts');
  const lib_ = join(IFACE, 'web', 'src', 'lib');
  writeFileSync(
    entry,
    [
      `export { operations, gasFor } from ${JSON.stringify(join(lib_, 'operations.ts'))};`,
      `export { ObsidianClient, ChainError } from ${JSON.stringify(join(lib_, 'client.ts'))};`,
      `export { Wallet } from ${JSON.stringify(join(lib_, 'wallet.ts'))};`,
      `export { decodeOnsBody, encodeOnsBody } from ${JSON.stringify(join(IFACE, 'web', 'core', 'transactions', 'executors', 'ons.js'))};`,
      `export { decodeValidatorBody, encodeValidatorBody } from ${JSON.stringify(join(IFACE, 'web', 'core', 'transactions', 'executors', 'validator.js'))};`,
      `export { decodeSignedTxFromBytes } from ${JSON.stringify(join(IFACE, 'web', 'core', 'transactions', 'encode.js'))};`,
      `export { TxType, OnsOp, ValidatorOp } from ${JSON.stringify(join(IFACE, 'web', 'core', 'protocol', 'types.js'))};`,
      `export { CONSENSUS_PARAMS } from ${JSON.stringify(join(IFACE, 'web', 'core', 'protocol', 'params.js'))};`,
      `export { PROTOCOL_VERSION } from ${JSON.stringify(join(IFACE, 'web', 'core', 'version.js'))};`,
      `export { parseObs } from ${JSON.stringify(join(IFACE, 'web', 'core', 'protocol', 'amount.js'))};`,
    ].join('\n'),
  );
  const { build } = createRequire(join(IFACE, 'package.json'))('esbuild');
  const outfile = join(dir, 'browser-lib.mjs');
  // The same lookup path scripts/build-web.mjs uses: the crypto libraries live with the core.
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', absWorkingDir: IFACE, nodePaths: [join(CORE, 'node_modules'), join(IFACE, 'node_modules')] });

  // The vault lives in localStorage in a browser; give Node a stand-in.
  const store = new Map();
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, String(v)), removeItem: (k) => void store.delete(k) };
  lib = await import(pathToFileURL(outfile).href);
  client = new lib.ObsidianClient(UI_URL);

  const node = launch('node', NODE_ENTRY, ['start', '--network', 'devnet', '--data-dir', scratch('node'), '--rpc-port', String(RPC), '--p2p-port', String(P2P), '--log-level', 'warn'], CORE);
  await waitFor(async () => (await get(`${NODE_URL}/status`)).body.height >= 1, ms(60_000), 'the node to make a block', node);
  const ui = launch('interface', IFACE_ENTRY, ['--network', 'devnet', '--port', String(UI), '--nodes', NODE_URL, '--data-dir', scratch('ui')], IFACE);
  await waitFor(async () => (await get(`${UI_URL}/api/health`)).body.healthyNodes === 1, ms(60_000), 'the interface to see the node', ui);

  wallets.miner = await lib.Wallet.create('dobs', PASSPHRASE, 'miner');
  wallets.buyer = await lib.Wallet.create('dobs', PASSPHRASE, 'buyer');
});

after(() => {
  for (const record of children) if (record.code === null) record.child.kill('SIGKILL');
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('the first claim funds a wallet and designates it the treasury', { skip, timeout: ms(120_000) }, async () => {
  const { miner, buyer } = wallets;
  // The interface refuses a mining claim from anyone who is not signed in with a linked wallet (the platform's
  // gate; the full signed-in flow is covered by obsidian-app-web/tests/e2e-cross-product.mjs). The chain itself
  // has no accounts, so the claim that funds this test wallet goes straight to the node, as the first claim on a
  // fresh devnet does for a real operator.
  await assert.rejects(lib.operations.claim(client, miner), /sign in required/i, 'an anonymous browser cannot claim through the interface');
  // The same client code, pointed at the node's own RPC instead of the interface proxy.
  class DirectClient extends lib.ObsidianClient {
    async request(path, init) {
      const response = await fetch(`${NODE_URL}${path}`, { ...init, headers: { 'content-type': 'application/json' } });
      const payload = await response.json();
      if (!response.ok) throw new lib.ChainError(payload.error, response.status, payload.code);
      return payload;
    }
  }
  const direct = new DirectClient(NODE_URL);
  await done(miner, () => lib.operations.claim(direct, miner));
  const revenue = await client.revenue();
  assert.equal(revenue.treasury.designated, true);
  assert.equal(revenue.treasury.wallet, miner.address, 'the treasury is shown in full, and is the first miner');
  assert.ok(!revenue.treasury.wallet.includes('…'), 'a masked address cannot be looked up');

  await done(miner, () => lib.operations.send(client, miner, { to: buyer.address, amountObs: '1000' }));
  assert.equal(BigInt((await client.balance(buyer.address)).balanceSeals), 1000n * 10n ** 18n);
});

test('a name registered from the browser code is accepted, priced in OBS, and produces the 90/10 split', { skip, timeout: ms(180_000) }, async () => {
  const { miner } = wallets;
  const params = await get(`${NODE_URL}/params`).then((r) => r.body);
  assert.equal(params.ons.registrationFeeObs, '0.050000000000000000', 'the fee is a consensus parameter, not a quote');

  const before = await client.revenue();
  const height = (await client.status()).height;
  const result = await done(miner, () => lib.operations.registerName(client, miner, { name: 'ecosystem.obs', feeObs: params.ons.registrationFeeObs }));
  assert.ok(result.accepted, 'the node accepted the browser-signed ONS transaction');

  // The record exists, maps to a wallet, and is readable through the explorer route.
  const record = await client.name('ecosystem.obs');
  assert.equal(record.owner, miner.address);

  const after = await client.revenue();
  const fee = seals(params.ons.registrationFeeObs);
  const runnerShare = (fee * 9000n) / 10_000n;
  const treasuryShare = fee - runnerShare;
  assert.equal(seals(after.onsRevenueObs) - seals(before.onsRevenueObs), fee, 'the fee is recorded as ONS revenue');
  assert.equal(seals(after.split.treasuryCreditedObs) - seals(before.split.treasuryCreditedObs), treasuryShare, 'the treasury got exactly 10%');
  assert.equal(seals(after.split.nodeRunnerPoolObs) - seals(before.split.nodeRunnerPoolObs), runnerShare, 'the runner pool got exactly 90%');
  assert.equal(after.split.sumsBack, true);
  assert.equal(seals(after.split.nodeRunnerPoolObs) + seals(after.split.treasuryObs) === seals(after.onsRevenueObs), true, 'the two shares add back to the whole revenue');

  // And the transaction itself carries what the node reads.
  const tx = await client.transaction(result.txId).catch(() => undefined);
  if (tx) assert.equal(tx.type, 2, 'ONS is transaction type 2');

  const current = await client.status();
  assert.ok(current.height > height, 'the chain kept producing blocks');
});

test('a renewal is ONS revenue too, and the split adds back to the whole', { skip, timeout: ms(180_000) }, async () => {
  const { miner } = wallets;
  const before = await client.revenue();
  await done(miner, () => lib.operations.renewName(client, miner, { name: 'ecosystem.obs', feeObs: '0.050000000000000000' }));
  const after = await client.revenue();
  const sources = after.bySource.map((entry) => entry.source);
  assert.ok(sources.includes('ONS_RENEWAL'), `a renewal is classified as ONS revenue (saw ${sources.join(', ')})`);
  assert.equal(after.split.sumsBack, true);
  assert.ok(seals(after.split.treasuryCreditedObs) > seals(before.split.treasuryCreditedObs), 'the treasury designation means the share is credited, not owed');
  assert.equal(after.split.treasuryUnclaimedObs, '0.000000000000000000', 'a designated treasury leaves nothing unclaimed');
});

test('validator registration carries exactly the 20,000 OBS bond, and anything else is refused', { skip, timeout: ms(180_000) }, async () => {
  const { miner } = wallets;
  const bond = lib.CONSENSUS_PARAMS.consensus.validatorBond;
  assert.equal(bond, 20_000n * 10n ** 18n, 'the protocol fixes the bond at exactly 20,000 OBS');

  // Too little: the node refuses it in the mempool simulation, naming the protocol
  // code in the message, and nothing is ever signed into a block.
  await assert.rejects(
    lib.operations.registerValidator(client, miner, { bondObs: '1000', validatorKey: '02' + 'ab'.repeat(32) }),
    (error) =>
      error instanceof lib.ChainError &&
      error.code === 'ERR_REJECTED' &&
      /ERR_VALIDATOR_BOND_MISMATCH: validator bond must equal exactly 20000\.000000000000000000 OBS/.test(error.message),
    'a bond that is not exactly 20,000 OBS is refused with the protocol code',
  );

  const nonce = await nonceOf(miner);
  const status = await client.status();
  const signed = miner.sign({
    chainId: status.chainId,
    protocolVersion: lib.PROTOCOL_VERSION,
    type: lib.TxType.VALIDATOR,
    nonce,
    gas: lib.gasFor(bond),
    body: lib.encodeValidatorBody({ op: lib.ValidatorOp.REGISTER, bond, validatorKey: '02' + 'ab'.repeat(32), commissionBps: 0 }),
    validUntil: status.lastBlockTimestamp + 600,
  });
  const decoded = lib.decodeValidatorBody(lib.decodeSignedTxFromBytes(signed).body);
  assert.equal(decoded.bond, bond, 'the bytes the browser signed carry the exact bond');
  assert.equal(lib.decodeSignedTxFromBytes(signed).type, lib.TxType.VALIDATOR);
});

test('the interface proxy refuses every route of a discontinued product', { skip }, async () => {
  for (const path of ['/land/search?q=Kano', '/land/parcels', '/capsules', '/social/feed']) {
    const response = await get(`${UI_URL}/api/rpc?path=${encodeURIComponent(path)}`);
    assert.equal(response.status, 400, `${path} must not be proxied`);
    assert.equal(response.body.code, 'ERR_REJECTED', `${path} is refused, not forwarded`);
  }
  // And the node itself has no such routes any more.
  for (const path of ['/land/search?q=Kano', '/capsules', '/social/feed']) {
    assert.equal((await get(`${NODE_URL}${path}`)).status, 404, `${path} must not exist on the node`);
  }
});

test('the revenue report says where the treasury is, what it holds, and when each share is paid', { skip }, async () => {
  const { miner } = wallets;
  const revenue = await client.revenue();
  const holds = BigInt((await client.balance(miner.address)).balanceSeals);
  assert.equal(revenue.treasury.wallet, miner.address);
  assert.equal(revenue.treasury.lifetimeCreditedObs, revenue.split.treasuryCreditedObs, 'what the treasury was credited is the 10% share, nothing else');
  assert.equal(revenue.split.nodePoolBps, 9_000);
  assert.equal(revenue.split.treasuryBps, 1_000);
  assert.ok(!JSON.stringify(revenue).includes('"balanceObs"'), 'no wallet balance leaks through /revenue');
  assert.ok(holds > 0n, 'the full address is enough to ask for the treasury\'s balance the ordinary way');
  assert.match(revenue.timing.treasuryShare.paid, /same block as the ONS fee/);
  assert.equal(revenue.timing.nodeRunnerShare.periodSeconds, 86_400);
  assert.ok(revenue.timing.nodeRunnerShare.secondsUntilNextSettlement > 0 && revenue.timing.nodeRunnerShare.secondsUntilNextSettlement <= 86_400);
  assert.equal(revenue.timing.nodeRunnerShare.registeredNodes, 0);
  assert.equal(revenue.timing.nodeRunnerShare.carriedWhenNoNodes, true);
  assert.equal(revenue.split.sumsBack, true, 'the 90/10 split adds back to the whole');
  assert.ok(Number(revenue.onsRevenueObs) > 0, 'the name fees are recorded as ONS revenue');
  // Nothing that is not ONS revenue may appear as a revenue source.
  assert.deepEqual(revenue.bySource.map((entry) => entry.source).sort(), ['ONS_REGISTRATION', 'ONS_RENEWAL']);
  const rewards = await client.nodeRewards(5);
  assert.equal(rewards.pool.nextSettlementAt, revenue.timing.nodeRunnerShare.nextSettlementAt);
});

test('only the designated treasury can spend from the treasury, and the chain carries on', { skip, timeout: ms(120_000) }, async () => {
  const { miner, buyer } = wallets;
  const height = (await client.status()).height;
  const revenue = await client.revenue();
  const credited = seals(revenue.split.treasuryCreditedObs);
  assert.ok(credited > 0n, 'the treasury has something credited to spend');

  // A wallet that is not the treasury signs a grant: the node refuses, and no state moves.
  await assert.rejects(
    lib.operations.payRevenue(client, buyer, { amountObs: '0.01', purpose: 'not yours' }),
    (error) => error instanceof lib.ChainError,
    'a grant from a wallet that is not the designated treasury is refused',
  );
  assert.equal((await client.revenue()).split.treasuryCreditedObs, revenue.split.treasuryCreditedObs);

  await waitFor(async () => (await get(`${NODE_URL}/status`)).body.height >= height + 2, ms(60_000), 'the chain to keep producing blocks');
});

test('pages on the official domain can read this node and this interface, and nothing else can', { skip }, async () => {
  const official = 'https://wallet.obsmainnet.us.ci';
  // The node.
  const node = await get(`${NODE_URL}/status`, { headers: { origin: official } });
  assert.equal(node.status, 200);
  assert.equal(node.headers.get('access-control-allow-origin'), official);
  assert.equal(node.headers.get('access-control-allow-credentials'), null);
  for (const origin of ['https://evil.test', 'https://obsmainnet.us.ci.evil.test', 'http://wallet.obsmainnet.us.ci']) {
    assert.equal((await get(`${NODE_URL}/status`, { headers: { origin } })).status, 403, origin);
  }
  // The interface: chain reads yes, accounts no.
  const read = await get(`${UI_URL}/api/rpc?path=${encodeURIComponent('/status')}`, { headers: { origin: official } });
  assert.equal(read.status, 200);
  assert.equal(read.headers.get('access-control-allow-origin'), official);
  assert.equal(read.headers.get('access-control-allow-credentials'), null, 'no cookies for a sibling subdomain');
  assert.equal((await get(`${UI_URL}/api/auth/me`, { headers: { origin: official } })).status, 403);
  // Each network names only its own hostnames.
  const network = (await get(`${NODE_URL}/network`)).body;
  assert.deepEqual(network.domains, ['devnet.obsmainnet.us.ci']);
  assert.equal(network.trust.officialDomains, true);
});
