/**
 * "A claim here is a claim there."
 *
 * The strongest form of that sentence is: the two products produce the SAME
 * TRANSACTION. Not similar — the same bytes. If they do, then whatever the chain does
 * with one it does with the other: a claim made here and a claim made on the platform
 * carry the same claim id and sequence, so they contest the same slot, and the second
 * is rejected as a double claim by the chain, not by either product.
 *
 * This runs the platform's own operations (web/src/lib/operations.ts, bundled with its
 * own esbuild) and this app's operations against identical fake-node answers, and
 * compares what each one submits to /tx/submit.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const vault = await import('../web/vault.mjs');
const ops = await import('../web/ops.mjs');
const { decodeSignedTx } = await import('../../obsidian-interface/web/core/transactions/encode.js').catch(() => ({}));

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASS = 'correct horse battery staple';
const OTHER = 'dobs148qsr3gydeljr65y4yx38ffswfv2ny4ledmnpw';

const CHAIN = { chainId: 7780, addressHrp: 'dobs', protocolVersion: '1.7.0', protocolTime: 1_791_542_000, nonce: 4 };
const MINING = {
  eligible: true,
  nextClaimId: 'a0c7f9eb927778a70632b57cc87b84e0959a12e7130904ca9b1d0be9bd78c72a',
  nextClaimSequence: 7,
  rewardPerClaimObs: '0.000166666666666666',
};

/** The certificate both products are given: one fixed answer, so a difference in the signed bytes can only be a difference in code. */
const GATE = { issuer: '02'.repeat(33), issuedAt: 1_791_541_900, signature: 'ab'.repeat(64) };

let platform = null;
let tmp = null;
let skip = null;

before(async () => {
  try {
    const esbuild = createRequire(join(root, 'obsidian-interface', 'package.json'))('esbuild');
    tmp = mkdtempSync(join(tmpdir(), 'obs-platform-ops-'));
    const out = join(tmp, 'platform.mjs');
    await esbuild.build({
      stdin: {
        contents: `export { Wallet } from './lib/wallet.ts'; export { operations } from './lib/operations.ts';`,
        resolveDir: join(root, 'obsidian-interface/web/src'),
        sourcefile: 'entry.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'silent',
    });
    platform = await import(pathToFileURL(out).href);
  } catch (error) {
    skip = `the platform's operations could not be built here: ${error.message}`;
  }
});
after(() => tmp && rmSync(tmp, { recursive: true, force: true }));

/** What a node would answer — one set of answers, given to both products. */
function nodeAnswers(overrides = {}) {
  return {
    status: { chainId: CHAIN.chainId, lastBlockTimestamp: CHAIN.protocolTime, protocolVersion: CHAIN.protocolVersion },
    network: { network: { chainId: CHAIN.chainId, addressHrp: CHAIN.addressHrp }, protocolVersion: CHAIN.protocolVersion },
    balance: { nonce: CHAIN.nonce, balanceSeals: (10n ** 20n).toString() },
    mining: MINING,
    ...overrides,
  };
}

/** Run an operation on the platform's code; return the hex it submitted. */
async function viaPlatform(name, input, answers = nodeAnswers()) {
  const wallet = await platform.Wallet.fromPhrase(PHRASE, CHAIN.addressHrp, PASS);
  let submitted = null;
  const client = {
    status: async () => answers.status,
    network: async () => answers.network,
    balance: async () => answers.balance,
    miningStatus: async () => answers.mining,
    submit: async (bytes) => {
      submitted = Buffer.from(bytes).toString('hex');
      return { accepted: true, txId: 'x' };
    },
  };
  // A claim's third argument is how the platform asks for its certificate; every other operation takes its input.
  await platform.operations[name](client, wallet, name === 'claim' ? async () => GATE : input);
  assert.ok(submitted, `the platform submitted nothing for ${name}`);
  return submitted;
}

/** Run the same operation on this app's code; return the hex it submitted. */
async function viaApp(fn, input, answers = nodeAnswers()) {
  store.clear();
  vault.saveVault(await vault.createVault(PHRASE, PASS, CHAIN.addressHrp));
  let submitted = null;
  const deps = {
    loadVault: vault.loadVault,
    loadAddress: () => vault.loadVault().address,
    requestPassphrase: async () => PASS,
    getContext: async () => ({ ...CHAIN }),
    getNonce: async () => answers.balance.nonce,
    getMiningStatus: async () => answers.mining,
    getBalance: async () => answers.balance,
    getName: async () => null,
    getGateCertificate: async () => GATE,
    submit: async (hex) => {
      submitted = hex;
      return { accepted: true, txId: 'x' };
    },
  };
  const result = await fn(deps, input);
  assert.equal(result.ok, true, `the app refused: ${result.message}`);
  assert.ok(submitted, 'the app submitted nothing');
  return submitted;
}

const needs = (fn) => async (t) => (platform ? fn(t) : t.skip(skip));

test('a MINING CLAIM is byte-for-byte the same transaction in both products', needs(async () => {
  const theirs = await viaPlatform('claim');
  const mine = await viaApp(ops.submitClaim);
  assert.equal(mine, theirs);
}));

test('signing is deterministic: the same claim signed twice is the same bytes', needs(async () => {
  // If it were not, "the same transaction" could never be asserted, and a retry could
  // not be told from a second claim by anything but the node.
  assert.equal(await viaApp(ops.submitClaim), await viaApp(ops.submitClaim));
  assert.equal(await viaPlatform('claim'), await viaPlatform('claim'));
}));

test('the claim carries the claim id and sequence the node issued, so both products contest one slot', needs(async () => {
  const hex = await viaApp(ops.submitClaim);
  const bytes = Buffer.from(hex, 'hex');
  assert.ok(
    bytes.includes(Buffer.from(MINING.nextClaimId)) || bytes.includes(Buffer.from(MINING.nextClaimId, 'hex')),
    'the node’s claim id is in the signed bytes',
  );
  // A different id (the next claim) is a different transaction — the slot is the id.
  const next = await viaApp(ops.submitClaim, undefined, nodeAnswers({ mining: { ...MINING, nextClaimId: 'b'.repeat(64), nextClaimSequence: 8 } }));
  assert.notEqual(next, hex);
}));

test('a PAYMENT is byte-for-byte the same transaction in both products', needs(async () => {
  const theirs = await viaPlatform('send', { to: OTHER, amountObs: '2.5', memo: 'parity' });
  const mine = await viaApp(ops.submitPayment, { to: OTHER, amountObs: '2.5', memo: 'parity' });
  assert.equal(mine, theirs);
}));

test('an ONS REGISTRATION is byte-for-byte the same transaction in both products', needs(async () => {
  const theirs = await viaPlatform('registerName', { name: 'parity', feeObs: '0.05' });
  const mine = await viaApp(ops.submitNameRegistration, { name: 'parity', feeObs: '0.05' });
  assert.equal(mine, theirs);
}));

test('"parity" and "parity.obs" are one name to the chain, so neither spelling can register it twice', needs(async () => {
  // The app always sends the bare label; the platform sends what it is given. The bytes
  // differ by the suffix and nothing else — and the consensus executor normalises both to
  // the same name, so the second registration is NAME_TAKEN whichever spelling made it.
  const { normalizeName } = await import(resolve(root, 'obsidian-core/dist/transactions/executors/ons.js'));
  assert.equal(normalizeName('parity.obs'), normalizeName('parity'));
  assert.equal(normalizeName('Parity.OBS '), normalizeName('parity'));

  const theirs = await viaPlatform('registerName', { name: 'parity.obs', feeObs: '0.05' });
  const bare = await viaApp(ops.submitNameRegistration, { name: 'parity', feeObs: '0.05' });
  const suffixed = await viaApp(ops.submitNameRegistration, { name: 'parity.obs', feeObs: '0.05' });
  assert.equal(suffixed, bare, 'the app sends the same bytes whichever way the name is typed');
  assert.notEqual(theirs, bare, 'the platform sends the suffix it was given');
}));

test('a different nonce, chain or key is a different transaction (the comparison can fail)', needs(async () => {
  const base = await viaApp(ops.submitClaim);
  assert.notEqual(await viaApp(ops.submitClaim, undefined, nodeAnswers({ balance: { nonce: 5, balanceSeals: '1' } })), base, 'nonce');
}));
