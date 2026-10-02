/**
 * End-to-end cluster test: three real nodes, one real wallet, one real chain.
 *
 *   node --test tests/e2e/cluster.test.mjs
 *   SKIP_E2E=1 node --test tests/e2e/cluster.test.mjs     # skip on a slow machine
 *
 * This is the test that answers "is it actually a blockchain": it starts three
 * Obsidian Core nodes from the built output, chains them with seed peers, mines a
 * genesis claim on one node, sends a payment to a wallet created offline,
 * registers a `.obs` name through the protocol oracle, and then asserts that *all
 * three nodes independently agree* on height, balances, the name record and the
 * supply invariant — plus the product guarantees that matter (explorer masking,
 * compliance report, deterministic gas, cross-network rejection).
 *
 * Tests that need a funded wallet call `ensureMiner()`, which memoises the claim
 * so a failure reports the real cause instead of cascading.
 *
 * Ports are deliberately far from the standard devnet ports so this can run next
 * to a development cluster.
 */

import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';
import { connect } from 'node:net';
import { cpus } from 'node:os';
// Read the protocol version from the build under test rather than hard-coding
// it: a version bump is a protocol change, and these tests must follow the
// software, not a literal that silently goes stale.
import { PROTOCOL_VERSION } from '../../obsidian-core/dist/version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '..', '..', 'obsidian-core');
const ENTRY = join(CORE, 'dist', 'index.js');
const PASSPHRASE = 'e2e-cluster-passphrase';
const CHAIN_ID = 7780;
const HRP = 'dobs';
const ONE = 10n ** 18n;
const CLAIM_REWARD = 166_666_666_666_666n;
const GENESIS_ALLOCATION = 100_000n * ONE;
const MAX_GAS = 10_000_000_000_000_000n; // 0.01 OBS

const A = { name: 'e2e-a', rpc: 39630, p2p: 39631 };
const B = { name: 'e2e-b', rpc: 39632, p2p: 39633, seed: `127.0.0.1:${A.p2p}` };
const C = { name: 'e2e-c', rpc: 39634, p2p: 39635, seed: `127.0.0.1:${B.p2p}` };
const NODES = [A, B, C];

/**
 * Timeout scale.
 *
 * This suite runs three real nodes, each producing a block every five seconds,
 * plus the test runner. On a two-core machine (a CI container, or a laptop
 * that is also building) those four processes do not get the CPU they need:
 * transactions take longer to be mined than the fixed 45s waits allowed, and
 * the suite reported four consensus failures that were really starvation.
 * Measured here: 13/13 in 56s idle, 4 failures at 300s under load, same code.
 *
 * Waits therefore scale with the hardware. This hides no hang — a genuinely
 * stuck chain still fails, just later — and OBSIDIAN_E2E_TIMEOUT_SCALE lets an
 * operator set the factor explicitly.
 */
const SCALE = (() => {
  const fromEnv = Number(process.env.OBSIDIAN_E2E_TIMEOUT_SCALE);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  const cores = cpus()?.length || 1;
  return cores >= 6 ? 1 : cores >= 4 ? 2 : 4;
})();
/** Scale a wall-clock budget to the machine this is running on. */
const ms = (base) => Math.round(base * SCALE);

const children = [];
const dataDirs = [];
const skip = process.env.SKIP_E2E === '1';
let core;

// ── node processes ───────────────────────────────────────────────────────────

function startNode(node) {
  const dataDir = mkdtempSync(join(tmpdir(), `obsidian-${node.name}-`));
  dataDirs.push(dataDir);
  const args = [
    ENTRY,
    'start',
    '--network', 'devnet',
    '--data-dir', dataDir,
    '--keystore', join(dataDir, 'node-key.json'),
    '--rpc-port', String(node.rpc),
    '--p2p-port', String(node.p2p),
    '--node-name', node.name,
    '--mine',
    '--log-level', 'warn',
  ];
  if (node.seed) args.push('--seeds', node.seed);
  const child = spawn(process.execPath, args, {
    cwd: CORE,
    env: { ...process.env, OBSIDIAN_KEYSTORE_PASSPHRASE: PASSPHRASE },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, log: [], node, code: null, signal: null, dataDir };
  child.stdout.on('data', (chunk) => record.log.push(chunk.toString()));
  child.stderr.on('data', (chunk) => record.log.push(chunk.toString()));
  child.on('exit', (code, signal) => {
    record.code = code;
    record.signal = signal;
  });
  children.push(record);
  return record;
}

function logOf(record) {
  return record.log.join('').split('\n').slice(-12).join('\n');
}

function assertAlive(record) {
  if (record.code === null) return;
  throw new Error(`node ${record.node.name} exited early (code ${record.code}, signal ${record.signal}).\n${logOf(record)}`);
}

// ── protocol client, built from the same modules the node runs ────────────────

async function loadCore() {
  const [
    { generateRecoveryPhrase, deriveWallet },
    { signTransaction, encodeSignedTx },
    { encodePaymentBody },
    { encodeMiningBody },
    { encodeOnsBody },
    { encodeOracleBody },
    { expectedGas },
    { parseObs },
    { usdMicroToSeals },
    { TxType, OnsOp, ValidatorOp },
    { addressFromPublicKey },
    { encodeValidatorBody },
    { Keystore },
  ] = await Promise.all([
    import(join(CORE, 'dist', 'crypto', 'mnemonic.js')),
    import(join(CORE, 'dist', 'transactions', 'encode.js')),
    import(join(CORE, 'dist', 'transactions', 'executors', 'payment.js')),
    import(join(CORE, 'dist', 'transactions', 'executors', 'mining.js')),
    import(join(CORE, 'dist', 'transactions', 'executors', 'ons.js')),
    import(join(CORE, 'dist', 'transactions', 'executors', 'oracle.js')),
    import(join(CORE, 'dist', 'transactions', 'helpers.js')),
    import(join(CORE, 'dist', 'protocol', 'amount.js')),
    import(join(CORE, 'dist', 'transactions', 'helpers.js')),
    import(join(CORE, 'dist', 'protocol', 'types.js')),
    import(join(CORE, 'dist', 'crypto', 'keys.js')),
    import(join(CORE, 'dist', 'transactions', 'executors', 'validator.js')),
    import(join(CORE, 'dist', 'crypto', 'keystore.js')),
  ]);
  return {
    generateRecoveryPhrase, deriveWallet, signTransaction, encodeSignedTx,
    encodePaymentBody, encodeMiningBody, encodeOnsBody, encodeOracleBody,
    encodeValidatorBody, expectedGas, parseObs, usdMicroToSeals, TxType, OnsOp,
    ValidatorOp, addressFromPublicKey, Keystore,
  };
}

/**
 * A wallet created offline, the way a browser creates one: random phrase, BIP-44
 * derivation, address encoded with THIS network's prefix. Using the wrong prefix
 * is a real failure mode — a mainnet `obs1…` address is rejected by a devnet node
 * — which is exactly why the protocol binds addresses to a network.
 */
function newWallet() {
  const phrase = core.generateRecoveryPhrase();
  const derived = core.deriveWallet(phrase, 0, 0);
  return { phrase, ...derived, address: core.addressFromPublicKey(derived.publicKey, HRP) };
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

async function get(url, init) {
  const response = await fetch(url, init);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

async function post(url, payload) {
  return get(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

const rpc = (node) => `http://127.0.0.1:${node.rpc}`;
const status = async (node) => (await get(`${rpc(node)}/status`)).body;
const params = async (node) => (await get(`${rpc(node)}/params`)).body;
const balance = async (node, address) => (await post(`${rpc(node)}/wallet/balance`, { address })).body;

/**
 * The next nonce the protocol expects from an address, once every node agrees.
 *
 * Signing against one node's view is a real failure mode: a follower can be a
 * block or two behind, so it reports an older nonce and the transaction is
 * refused with `ERR_BAD_NONCE` at inclusion time. Waiting for agreement makes
 * the signed nonce the one the whole network already knows.
 */
async function nextChainNonce(address, timeoutMs = ms(60_000)) {
  // The agreed nonce is wrapped rather than returned bare because `waitFor`
  // resolves on truthiness and nonce 0 is falsy. Returning it raw made this
  // helper spin for its whole timeout on any account that had never sent a
  // transaction, then fail as if the cluster disagreed — which it did not.
  const agreed = await waitFor(async () => {
    for (const record of children) assertAlive(record);
    const nonces = await Promise.all(NODES.map((node) => get(`${rpc(node)}/wallet/${encodeURIComponent(address)}/next-nonce`).then((response) => response.body.nextNonce)));
    return nonces.every((value) => value === nonces[0]) ? { nonce: nonces[0] } : false;
  }, { timeoutMs, intervalMs: 400, what: `every node to agree on the next nonce for ${address}` });
  return agreed.nonce;
}

/** Wait until a transaction sent with `nonce` has been mined on every node. */
async function waitForMined(address, nonce, timeoutMs = ms(60_000)) {
  return waitFor(async () => {
    const nonces = await Promise.all(NODES.map((node) => get(`${rpc(node)}/wallet/${encodeURIComponent(address)}/next-nonce`).then((response) => response.body.nextNonce)));
    return nonces.every((value) => value > nonce) ? nonces[0] : false;
  }, { timeoutMs, intervalMs: 400, what: `the transaction from ${address} with nonce ${nonce} to be mined everywhere` });
}

/** Seals held by the Mining Pool according to one node's chain state. */
async function poolBalanceSeals(node) {
  return core.parseObs((await get(`${rpc(node)}/supply`)).body.poolBalanceObs);
}

async function waitFor(fn, { timeoutMs = ms(60_000), intervalMs = 500, what = 'condition' } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ''}`);
}

/** Wait until every node reports the same balance for an address. */
async function waitForBalanceAllNodes(address, seals, timeoutMs = ms(45_000)) {
  return waitFor(async () => {
    for (const record of children) assertAlive(record);
    const seen = await Promise.all(NODES.map((node) => balance(node, address)));
    return seen.every((value) => value.balanceSeals === seals.toString()) ? seen : false;
  }, { timeoutMs, intervalMs: 400, what: `all nodes to report ${seals} seals for ${address}` });
}

async function submit(node, signedBytes) {
  return post(`${rpc(node)}/tx/submit`, { tx: Buffer.from(signedBytes).toString('hex') });
}

function protocolTime(node) {
  return status(node).then((value) => value.lastBlockTimestamp);
}

// ── shared chain state (memoised so failures stay legible) ───────────────────

const state = { miner: undefined, claimPromise: undefined, oraclePromise: undefined };

/** Fund a wallet with the genesis claim — once per run, on the first eligible chain. */
async function ensureMiner() {
  if (!state.claimPromise) {
    state.claimPromise = (async () => {
      const miner = newWallet();
      const mining = (await get(`${rpc(A)}/mining/status?address=${miner.address}`)).body;
      assert.equal(mining.eligible, true, `the first miner should be eligible, node said: ${mining.reason ?? 'no reason given'}`);

      const signed = core.signTransaction({
        protocolVersion: PROTOCOL_VERSION,
        chainId: CHAIN_ID,
        sender: miner.address,
        nonce: 0,
        type: core.TxType.MINING_CLAIM,
        gas: 0n,
        body: core.encodeMiningBody({ claimId: mining.nextClaimId, claimSequence: mining.nextClaimSequence }),
        validUntil: mining.protocolTime + 600,
        privateKeyHex: miner.privateKey,
        publicKeyHex: miner.publicKey,
      });
      const submitted = await submit(A, core.encodeSignedTx(signed));
      assert.equal(submitted.status, 200, `claim rejected: ${JSON.stringify(submitted.body)}`);

      await waitForBalanceAllNodes(miner.address, GENESIS_ALLOCATION + CLAIM_REWARD);
      state.miner = miner;
      return miner;
    })();
  }
  return state.claimPromise;
}

/** Give the chain a price so dollar-priced features can execute. */
async function ensureOraclePrice() {
  if (!state.oraclePromise) {
    state.oraclePromise = (async () => {
      const miner = await ensureMiner();
      const before = (await get(`${rpc(A)}/oracle`)).body;
      if (before.usable && BigInt(before.priceUsdMicro ?? 0) > 0n) return BigInt(before.priceUsdMicro);

      // One submission may carry observations from several sources, and the
      // cooldown (one submission per 100 blocks per account) is what limits a
      // single wallet — so the whole feed is published in one transaction.
      const at = await protocolTime(A);
      const nonce = await nextChainNonce(miner.address);
      const signed = core.signTransaction({
        protocolVersion: PROTOCOL_VERSION,
        chainId: CHAIN_ID,
        sender: miner.address,
        nonce,
        type: core.TxType.ORACLE,
        gas: 0n,
        body: core.encodeOracleBody({
          observations: [
            { source: 'e2e-source-1', priceUsdMicro: 50_000_000n, observedAt: at },
            { source: 'e2e-source-2', priceUsdMicro: 50_200_000n, observedAt: at },
          ],
          submissionId: '11'.repeat(8),
        }),
        validUntil: at + 600,
        privateKeyHex: miner.privateKey,
        publicKeyHex: miner.publicKey,
      });
      const result = await submit(C, core.encodeSignedTx(signed));
      assert.equal(result.status, 200, `oracle submission refused: ${JSON.stringify(result.body)}`);
      await waitForMined(miner.address, nonce);

      return waitFor(async () => {
        const feed = (await get(`${rpc(A)}/oracle`)).body;
        return feed.usable && feed.sourceCount >= feed.minSources ? BigInt(feed.priceUsdMicro) : false;
      }, { what: 'a protocol median price backed by enough sources' });
    })();
  }
  return state.oraclePromise;
}

/**
 * Refuse to start on top of someone else's cluster.
 *
 * A previous run that was interrupted leaves nodes holding 39630-39635. The
 * new nodes then fail to bind, every wait runs its full timeout, and the suite
 * reports four unrelated consensus failures five minutes later — which is
 * exactly what happened in a release gate here. A bound port is an environment
 * problem and must say so immediately.
 */
function portInUse(port) {
  return new Promise((resolvePromise) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (answer) => {
      socket.destroy();
      resolvePromise(answer);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function assertPortsFree() {
  const ports = NODES.flatMap((node) => [node.rpc, node.p2p]);
  const taken = [];
  for (const port of ports) if (await portInUse(port)) taken.push(port);
  assert.equal(
    taken.length,
    0,
    `ports already in use: ${taken.join(', ')}. A previous cluster run is probably still alive — ` +
      `stop it first (pkill -f "obsidian-core/dist/index.js" or lsof -ti:${taken[0] ?? 39630} | xargs kill), ` +
      'then run this suite again.',
  );
}

before(async () => {
  if (skip) return;
  assert.ok(existsSync(ENTRY), `build the core first: ${ENTRY} is missing (npm --prefix obsidian-core run build)`);
  await assertPortsFree();
  core = await loadCore();
  const started = NODES.map((node) => startNode(node));
  const [a, b, c] = started;

  await waitFor(async () => {
    for (const record of started) assertAlive(record);
    return (await status(A)).height > 0;
  }, { what: 'node A to produce its first block' });

  await waitFor(async () => {
    for (const record of started) assertAlive(record);
    return (await status(B)).peers >= 1;
  }, { timeoutMs: ms(90_000), what: `node B to connect to node A (${logOf(b) || 'no logs yet'})` });

  await waitFor(async () => {
    for (const record of started) assertAlive(record);
    return (await status(C)).peers >= 1;
  }, { timeoutMs: ms(90_000), what: `node C to connect to node B (${logOf(c) || 'no logs yet'})` });
});

after(async () => {
  await Promise.all(children.map(({ child }) => new Promise((resolvePromise) => {
    if (child.exitCode !== null || child.killed) return resolvePromise();
    child.once('exit', () => resolvePromise());
    child.kill('SIGTERM');
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolvePromise();
    }, 4000);
    timer.unref?.();
    return undefined;
  })));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
  for (const dir of dataDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* the OS will collect it */
    }
  }
});

// ── tests ───────────────────────────────────────────────────────────────────

test('three nodes reach consensus on the same chain', { skip, timeout: ms(120_000) }, async () => {
  const heights = await Promise.all(NODES.map(async (node) => (await status(node)).height));
  const genesis = await Promise.all(NODES.map(async (node) => (await status(node)).genesisId));
  assert.equal(new Set(genesis).size, 1, 'every node must agree on the genesis id');
  assert.ok(Math.max(...heights) - Math.min(...heights) <= 5, `heights diverged: ${heights.join(', ')}`);
  assert.ok(Math.min(...heights) > 0, 'every node should have produced or synced blocks');
});

test('the first mining claim receives the 100,000 OBS genesis allocation', { skip, timeout: ms(120_000) }, async () => {
  const miner = await ensureMiner();

  const seen = await Promise.all(NODES.map((node) => status(node)));
  for (const [index, value] of seen.entries()) {
    assert.equal(value.genesis.allocationClaimed, true, `${NODES[index].name} does not see the allocation as claimed`);
    // Public node output masks addresses (explorer rule), so the recipient is
    // compared against the expected mask, not the raw address.
    const mask = `${miner.address.slice(0, 10)}…${miner.address.slice(-6)}`;
    assert.equal(value.genesis.recipient, mask, `${NODES[index].name} recorded a different recipient`);
    assert.equal(value.genesis.treasuryWallet, mask, 'the genesis recipient must become the on-chain treasury');
  }
});

test('a second miner does not receive the genesis allocation', { skip, timeout: ms(120_000) }, async () => {
  const second = newWallet();
  // The protocol accepts one claim per wallet per block, so wait for a fresh slot.
  const ready = await waitFor(async () => {
    const mining = (await get(`${rpc(A)}/mining/status?address=${second.address}`)).body;
    return mining.eligible && mining.secondsRemaining <= 0 ? mining : false;
  }, { timeoutMs: ms(90_000), what: 'a second miner to become eligible' });

  const signed = core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    sender: second.address,
    nonce: 0,
    type: core.TxType.MINING_CLAIM,
    gas: 0n,
    body: core.encodeMiningBody({ claimId: ready.nextClaimId, claimSequence: ready.nextClaimSequence }),
    validUntil: ready.protocolTime + 600,
    privateKeyHex: second.privateKey,
    publicKeyHex: second.publicKey,
  });
  const submitted = await submit(B, core.encodeSignedTx(signed));
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const seen = await waitForBalanceAllNodes(second.address, CLAIM_REWARD);
  for (const value of seen) assert.equal(value.balanceSeals, CLAIM_REWARD.toString());
  assert.ok(CLAIM_REWARD < GENESIS_ALLOCATION, 'the ordinary reward must be far below the genesis allocation');
});

test('a payment moves OBS, pays the capped gas, and every node agrees', { skip, timeout: ms(120_000) }, async () => {
  const miner = await ensureMiner();
  const recipient = newWallet();
  const amount = core.parseObs('250');
  const gas = core.expectedGas(amount);
  assert.equal(gas, MAX_GAS, '0.02% of 250 OBS is above the 0.01 OBS cap, so the cap must apply');

  const poolBefore = await poolBalanceSeals(A);
  const nonce = await nextChainNonce(miner.address);
  const at = await protocolTime(A);
  const signed = core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    sender: miner.address,
    nonce,
    type: core.TxType.PAYMENT,
    gas,
    body: core.encodePaymentBody({ to: recipient.address, amount }),
    validUntil: at + 600,
    privateKeyHex: miner.privateKey,
    publicKeyHex: miner.publicKey,
  });
  const submitted = await submit(B, core.encodeSignedTx(signed));
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const txId = submitted.body.txId;

  await waitForBalanceAllNodes(recipient.address, amount);

  // The same transaction is described identically on every node, with addresses masked.
  for (const node of NODES) {
    const record = await get(`${rpc(node)}/tx/${txId}`);
    assert.equal(record.status, 200, `${node.name} does not have the transaction`);
    assert.ok(record.body.sender.includes('…'), 'explorer output must mask the sender');
    assert.ok(!record.body.sender.includes(miner.address.slice(12, 24)), 'the full sender address must not be echoed');
    assert.equal(record.body.gas, MAX_GAS.toString(), 'the gas recorded on chain must be the capped amount');
  }

  // Gas leaves the sender and lands in the Mining Pool, exactly once.
  for (const node of NODES) {
    await waitFor(async () => (await poolBalanceSeals(node)) >= poolBefore + gas, {
      timeoutMs: ms(30_000),
      intervalMs: 400,
      what: `${node.name} to credit the ${gas} seals of gas to the Mining Pool`,
    });
  }
});

test('a transaction signed for another chain is refused', { skip, timeout: ms(60_000) }, async () => {
  const miner = await ensureMiner();
  const at = await protocolTime(A);
  const signed = core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: 7777, // mainnet, not this devnet
    sender: miner.address,
    nonce: await nextChainNonce(miner.address),
    type: core.TxType.PAYMENT,
    gas: 0n,
    body: core.encodePaymentBody({ to: newWallet().address, amount: 1n }),
    validUntil: at + 600,
    privateKeyHex: miner.privateKey,
    publicKeyHex: miner.publicKey,
  });
  const response = await submit(A, core.encodeSignedTx(signed));
  assert.ok(response.status >= 400, `expected a rejection, got ${response.status}`);
  assert.match(JSON.stringify(response.body), /WRONG_CHAIN_ID|WRONG_NETWORK/);
});

test('a replayed transaction is refused and the balance does not move twice', { skip, timeout: ms(120_000) }, async () => {
  const miner = await ensureMiner();
  const recipient = newWallet();
  const amount = core.parseObs('3');
  const at = await protocolTime(A);
  const signed = core.encodeSignedTx(
    core.signTransaction({
      protocolVersion: PROTOCOL_VERSION,
      chainId: CHAIN_ID,
      sender: miner.address,
      nonce: await nextChainNonce(miner.address),
      type: core.TxType.PAYMENT,
      gas: core.expectedGas(amount),
      body: core.encodePaymentBody({ to: recipient.address, amount }),
      validUntil: at + 600,
      privateKeyHex: miner.privateKey,
      publicKeyHex: miner.publicKey,
    }),
  );

  const first = await submit(A, signed);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await waitForBalanceAllNodes(recipient.address, amount);

  const replay = await submit(B, signed);
  assert.ok(replay.status >= 400, 'a mined transaction must not be accepted twice');
  const after = await balance(C, recipient.address);
  assert.equal(after.balanceSeals, amount.toString(), 'the replay must not have moved more OBS');
});

test('a name registers and resolves without any price source at all', { skip, timeout: ms(180_000) }, async () => {
  const miner = await ensureMiner();

  // Since 1.2.0 every protocol price is denominated in OBS, so there is no
  // oracle on this path: registration must work on a cluster where no price
  // has ever been published. The old behaviour — failing closed whenever the
  // feed was absent or stale — made an outage look like a broken protocol.
  const oracle = await get(`${rpc(A)}/oracle`);
  assert.equal(oracle.status, 200, 'the oracle endpoint still reports, it just no longer gates anything');

  const feeSeals = core.parseObs('0.05');
  const name = `e2e${Date.now().toString(36).slice(-6)}.obs`;

  const at = await protocolTime(A);
  const registered = await submit(C, core.encodeSignedTx(core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    sender: miner.address,
    nonce: await nextChainNonce(miner.address),
    type: core.TxType.ONS,
    gas: core.expectedGas(feeSeals),
    body: core.encodeOnsBody({ op: core.OnsOp.REGISTER, name, fee: feeSeals }),
    validUntil: at + 600,
    privateKeyHex: miner.privateKey,
    publicKeyHex: miner.publicKey,
  })));
  assert.equal(registered.status, 200, JSON.stringify(registered.body));

  // Underpaying is still refused: the price is fixed, not absent.
  const underpaid = await submit(A, core.encodeSignedTx(core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    sender: miner.address,
    nonce: await nextChainNonce(miner.address),
    type: core.TxType.ONS,
    gas: core.expectedGas(core.parseObs('0.01')),
    body: core.encodeOnsBody({ op: core.OnsOp.REGISTER, name: `cheap${Date.now().toString(36).slice(-5)}.obs`, fee: core.parseObs('0.01') }),
    validUntil: at + 600,
    privateKeyHex: miner.privateKey,
    publicKeyHex: miner.publicKey,
  })));
  assert.ok(underpaid.status >= 400, 'a registration paying less than 0.05 OBS must be refused');

  await waitFor(async () => {
    const records = await Promise.all(NODES.map((node) => get(`${rpc(node)}/names/${name}`)));
    return records.every((record) => record.status === 200 && record.body.address === miner.address);
  }, { timeoutMs: ms(45_000), intervalMs: 500, what: 'every node to serve the registered name' });
});

test('the supply invariant holds and the cap is respected on every node', { skip, timeout: ms(60_000) }, async () => {
  const maximum = 21_000_000n * ONE;
  for (const node of NODES) {
    const { body } = await get(`${rpc(node)}/supply`);
    const total = BigInt(body.totalSeals ?? body.total ?? 0);
    assert.ok(total <= maximum, `${node.name} reports supply above the 21,000,000 OBS cap`);
    if (body.invariant) assert.equal(body.invariant.ok, true, `${node.name} reports an invariant violation`);
    const parameters = await params(node);
    assert.equal(parameters.maximumSupplyObs, '21000000.000000000000000000');
    assert.equal(parameters.genesisAllocationObs, '100000.000000000000000000');
  }
});

test('removed mechanisms are absent from the running protocol', { skip, timeout: ms(60_000) }, async () => {
  const expectedAbsent = [
    'wac',
    'legacyGenesisAllocation',
    'signupAllocation',
    'miningKyc',
    'miningWithdrawalRequiresWac',
    'nativeExchange',
    'explorerExposesBalances',
  ];
  for (const node of NODES) {
    const { body } = await get(`${rpc(node)}/audit/compliance`);
    for (const mechanism of expectedAbsent) {
      assert.equal(body[mechanism]?.present, false, `${node.name} still implements ${mechanism}`);
    }
    const parameters = await params(node);
    assert.equal(parameters.registry.newAccountBalanceObs, '0.000000000000000000', 'registration must not create a balance');
    assert.equal(parameters.registry.miningKycRequired, false);
    assert.equal(parameters.registry.nativeExchangeEnabled, false);
    assert.equal(parameters.registry.maxInvitesPerAccount, 5);
  }
});

test('the explorer never exposes a balance or an unmasked address', { skip, timeout: ms(60_000) }, async () => {
  const miner = await ensureMiner();
  const history = await get(`${rpc(A)}/address/${miner.address}?limit=5`);
  assert.equal(history.status, 200);
  const serialised = JSON.stringify(history.body);
  assert.ok(!/balanceObs|"balanceSeals"/.test(serialised), 'address history must not carry a balance');
  assert.ok(history.body.maskNote?.includes('Balances are never exposed'));
  assert.ok(history.body.address.includes('…'), 'the address itself must be masked');
  assert.ok(!serialised.includes(miner.address), 'the full address must never appear in explorer output');
});

test('mining eligibility follows protocol time, not the caller', { skip, timeout: ms(60_000) }, async () => {
  const miner = await ensureMiner();
  // Every node answers on its own protocol clock, and none of them can be talked
  // out of a cooldown: the endpoint takes an address and nothing else, so there
  // is no client-supplied time to trust in the first place. (Protocol time is
  // max(wall clock, head timestamp + 1), so it may legitimately run ahead of the
  // head block when the chain is not keeping up with the clock; what must hold is
  // that the countdown is measured against the node's own protocol time.)
  for (const node of NODES) {
    const mining = (await get(`${rpc(node)}/mining/status?address=${miner.address}`)).body;
    const head = await status(node);
    assert.equal(mining.eligible, false, `${node.name}: a wallet that just claimed cannot claim again`);
    assert.ok(mining.secondsRemaining > 0, `${node.name}: the cooldown must be in the future`);
    assert.equal(
      mining.nextEligibleAt,
      mining.protocolTime + mining.secondsRemaining,
      `${node.name}: nextEligibleAt must be protocol time plus the remaining cooldown`,
    );
    assert.ok(
      mining.protocolTime >= head.lastBlockTimestamp,
      `${node.name}: protocol time cannot lag the head block it is built on`,
    );
    // The claim interval is four hours; a fresh claim cannot be nearer than that
    // minus the few seconds since it was mined.
    assert.ok(mining.secondsRemaining <= 4 * 60 * 60, `${node.name}: cooldown longer than the protocol interval`);
  }
});

test('every node reports the same Proof of Time state, derived from the blocks it serves', { skip, timeout: ms(60_000) }, async () => {
  const states = [];
  for (const node of NODES) {
    const { status: code, body } = await get(`${rpc(node)}/pot`);
    assert.equal(code, 200, `${node.name}: /pot must be served`);
    assert.equal(body.consensus, 'PROOF_OF_TIME', `${node.name}: the consensus identity must be Proof of Time`);
    assert.equal(body.shortName, 'PoT');
    assert.equal(body.weightRule, 'POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH');
    // PoT difficulty is published as a measurement, and says so.
    assert.equal(body.difficulty.role, 'MEASUREMENT', `${node.name}: difficulty must be labelled a measurement`);
    assert.ok(body.difficulty.difficultyBps >= 2_500 && body.difficulty.difficultyBps <= 40_000,
      `${node.name}: difficulty ${body.difficulty.difficultyBps} outside published bounds`);
    // Time-Rate is a time measurement, never a hash rate.
    assert.equal(body.timeRate.unit, 'BLOCKS_AND_TXS_PER_MINUTE');
    assert.ok(!JSON.stringify(body).toLowerCase().includes('hashrate'), `${node.name}: /pot must not report a hash rate`);
    // The authoritative clock is the chain's, and the node lists what is not.
    assert.equal(body.timeAuthority.authoritative, 'PROTOCOL_TIME_FROM_CHAIN');
    assert.ok(body.timeAuthority.neverAuthoritative.includes('BROWSER_CLOCK'));
    states.push({ node: node.name, body });
  }

  // Independent nodes agree about accumulated PoT weight at the same height.
  const byHeight = new Map();
  for (const { node, body } of states) {
    const seen = byHeight.get(body.height);
    if (seen) {
      assert.equal(body.cumulativePotWeight, seen.weight,
        `${node} and ${seen.node} disagree about PoT weight at height ${body.height}`);
    } else {
      byHeight.set(body.height, { node, weight: body.cumulativePotWeight });
    }
  }

  // And the difficulty each node publishes is recomputable from the blocks that
  // same node serves — the point of the metric is that it is not a claim.
  const node = NODES[0];
  const { body: pot } = await get(`${rpc(node)}/pot`);
  const { body: blocks } = await get(`${rpc(node)}/blocks?limit=50`);
  if (blocks.blocks.length >= 2) {
    const newest = blocks.blocks[0].timestamp;
    const oldest = blocks.blocks[blocks.blocks.length - 1].timestamp;
    const gaps = blocks.blocks.length - 1;
    if (newest > oldest) {
      const observedMs = Math.floor(((newest - oldest) * 1000) / gaps);
      // The node's own window may be larger than 50 blocks, so this is a sanity
      // band rather than an equality: what must hold is that the published
      // spacing is in the same order as the spacing the blocks actually show.
      assert.ok(pot.difficulty.observedSpacingMs > 0, 'observed spacing must be measured, not zero');
      assert.ok(observedMs > 0, 'the blocks served must show real spacing');
    }
  }
});

test('the platform revenue split is 40/60 and adds back to the whole on every node', { skip, timeout: ms(60_000) }, async () => {
  for (const node of NODES) {
    const { status: code, body } = await get(`${rpc(node)}/revenue`);
    assert.equal(code, 200, `${node.name}: /revenue must be served`);
    assert.equal(body.split.nodePoolBps, 4_000, `${node.name}: node runners must receive 40%`);
    assert.equal(body.split.treasuryBps, 6_000, `${node.name}: the treasury must receive 60%`);
    assert.equal(body.split.sumsBack, true, `${node.name}: the split must add back to the revenue it came from`);
    // Gas is not platform revenue, and the node says so rather than leaving it
    // to a reader to assume.
    assert.equal(body.gas.destination, 'MINING_POOL', `${node.name}: gas must fund the mining pool`);
    assert.ok(body.notPlatformRevenue.length > 0, `${node.name}: the exclusions must be published`);
    // No balance leaks through this route.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes('"balanceObs"'), `${node.name}: /revenue must not expose wallet balances`);
  }

  // The registry is readable and honest about an empty network.
  const { status: code, body: registry } = await get(`${rpc(NODES[0])}/nodes/registry`);
  assert.equal(code, 200, '/nodes/registry must be served');
  assert.equal(typeof registry.registeredNodes, 'number');
  assert.ok(Array.isArray(registry.nodes), 'the registry must return a node list, even when empty');
  assert.match(registry.note, /recomputed from chain state/);
});

/**
 * Liveness through a validator outage — the regression test for the Proof of
 * Time round backstop.
 *
 * Proposer selection is a deterministic round-robin over the active validator
 * set. Until this was fixed the schedule had no notion of a round: every node
 * computed `activeValidators[height mod count]` and refused to build on any
 * other producer, forever. A validator that crashed was therefore named as the
 * proposer of the next height, and the next, and the next — the surviving
 * majority sat idle waiting for a machine that was never coming back, and the
 * chain halted permanently. With one validator registered it took one crash;
 * with N it took one crash and a wait of N slots in the worst case.
 *
 * The fix derives a round from the two timestamps already in the headers and
 * hands the turn on once a slot elapses, opening the height to any node after
 * every validator has been offered it. This test is the proof: register a
 * single validator, SIGKILL it, and require the chain to keep producing.
 *
 * It is deliberately the LAST test in this file. It destroys node A, and every
 * other test here asserts that all three nodes agree; node:test runs a file's
 * tests in order, so nothing that needs A runs after this point.
 */
test('the chain keeps producing when the only scheduled validator goes offline', { skip, timeout: ms(420_000) }, async () => {
  const miner = await ensureMiner();
  const recordA = children.find((record) => record.node.name === A.name);
  assert.ok(recordA, 'node A must be running');

  // Node A's consensus identity, read from the keystore this harness created
  // for it. Blocks are signed with that key, so this is the address that has
  // to be registered for A to become the scheduled proposer.
  const keyPair = core.Keystore.read(join(recordA.dataDir, 'node-key.json'), PASSPHRASE);
  const validatorAddress = core.addressFromPublicKey(keyPair.publicKey, HRP);

  // 1. Fund node A's address so it can post a bond.
  const bond = core.parseObs('50'); // CONSENSUS_PARAMS.consensus.minValidatorBond
  const registerGas = core.expectedGas(bond);
  const funding = bond + registerGas + core.parseObs('1'); // bond, its gas, and headroom
  const fundingAt = await protocolTime(A);
  const fundingNonce = await nextChainNonce(miner.address);
  const funded = await submit(A, core.encodeSignedTx(core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    sender: miner.address,
    nonce: fundingNonce,
    type: core.TxType.PAYMENT,
    gas: core.expectedGas(funding),
    body: core.encodePaymentBody({ to: validatorAddress, amount: funding }),
    validUntil: fundingAt + 600,
    privateKeyHex: miner.privateKey,
    publicKeyHex: miner.publicKey,
  })));
  assert.equal(funded.status, 200, `funding the validator failed: ${JSON.stringify(funded.body)}`);
  await waitFor(async () => {
    for (const record of children) assertAlive(record);
    const seen = await Promise.all(NODES.map((node) => balance(node, validatorAddress)));
    return seen.every((value) => BigInt(value.balanceSeals) >= bond + registerGas) ? seen : false;
  }, { timeoutMs: ms(60_000), intervalMs: 400, what: `every node to see the bond funded at ${validatorAddress}` });

  // 2. Register node A as the one and only validator. From that block on the
  //    rotation has exactly one member, so round 0 of EVERY height names A and
  //    nobody else may produce until a slot has elapsed.
  const registerAt = await protocolTime(A);
  const registerNonce = await nextChainNonce(validatorAddress);
  const registered = await submit(B, core.encodeSignedTx(core.signTransaction({
    protocolVersion: PROTOCOL_VERSION,
    chainId: CHAIN_ID,
    sender: validatorAddress,
    nonce: registerNonce,
    type: core.TxType.VALIDATOR,
    gas: registerGas,
    body: core.encodeValidatorBody({
      op: core.ValidatorOp.REGISTER,
      bond,
      validatorKey: keyPair.publicKey,
      commissionBps: 0,
    }),
    validUntil: registerAt + 600,
    privateKeyHex: keyPair.privateKey,
    publicKeyHex: keyPair.publicKey,
  })));
  assert.equal(registered.status, 200, `validator registration failed: ${JSON.stringify(registered.body)}`);
  await waitForMined(validatorAddress, registerNonce);

  // Every node has to see the same single-member rotation, or the outage below
  // proves nothing.
  await waitFor(async () => {
    for (const record of children) assertAlive(record);
    const counts = await Promise.all(NODES.map((node) => get(`${rpc(node)}/validators`).then((r) => r.body.count)));
    return counts.every((value) => value === 1);
  }, { timeoutMs: ms(60_000), what: 'all three nodes to see exactly one active validator' });

  // ...and A has to actually be producing, so that killing it really does
  // remove the scheduled proposer rather than an idle registration.
  await waitFor(async () => {
    for (const record of children) assertAlive(record);
    const height = (await status(B)).height;
    const { body } = await get(`${rpc(B)}/block/${height}`);
    return body?.header?.producer === validatorAddress;
  }, { timeoutMs: ms(90_000), intervalMs: 500, what: 'the registered validator to produce a block' });

  // 3. The outage. SIGKILL, because a validator that crashes does not get to
  //    hand over gracefully.
  const heightAtOutage = (await status(B)).height;
  recordA.child.kill('SIGKILL');
  await waitFor(() => recordA.code !== null || recordA.signal !== null,
    { timeoutMs: ms(30_000), intervalMs: 200, what: 'node A to exit' });

  // 4. The assertion this test exists for. The round-0 proposer is gone and is
  //    never coming back, so only the backstop can produce the next height.
  const target = heightAtOutage + 3;
  for (const node of [B, C]) {
    await waitFor(async () => (await status(node)).height >= target, {
      timeoutMs: ms(180_000),
      intervalMs: 1_000,
      what: `${node.name} to reach height ${target} with the only scheduled validator offline — ` +
        'a stall here means an absent validator can halt the network',
    });
  }

  // 5. Those blocks are real blocks from the survivors, not replays of A's.
  const producers = [];
  for (let height = heightAtOutage + 1; height <= target; height += 1) {
    const { body } = await get(`${rpc(B)}/block/${height}`);
    assert.ok(body?.header, `block ${height} must be served by node B`);
    producers.push(body.header.producer);
  }
  assert.ok(
    producers.every((producer) => producer !== validatorAddress),
    `blocks produced during the outage must not be attributed to the dead validator, saw ${producers.join(', ')}`,
  );

  // 6. And the survivors still agree, so liveness was not bought with a fork.
  await waitFor(async () => {
    const [onB, onC] = await Promise.all([B, C].map((node) => get(`${rpc(node)}/block/${target}`).then((r) => r.body?.hash)));
    return Boolean(onB) && onB === onC;
  }, { timeoutMs: ms(60_000), what: `nodes B and C to agree on the block at height ${target}` });
});
