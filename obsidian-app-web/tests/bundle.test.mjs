/**
 * The artefact, not the sources.
 *
 * Everything else in this suite imports web/*.mjs, which is the code a reviewer
 * reads. The browser never sees it: it loads public/js/obsidian.js, produced by
 * esbuild with --platform=browser. A bundle can differ from its sources in ways
 * that matter — a dependency resolved to a different copy, a Node built-in that
 * only exists in one of them, a tree-shaken export that silently became undefined.
 *
 * So this file exercises the shipped bundle the way the page does.
 *
 * It skips when the bundle has not been built, rather than failing: the bundle is
 * generated and gitignored, and "you have not run npm run build:web yet" is a
 * different statement from "the bundle is wrong".
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = resolve(here, '..', 'public/js/obsidian.js');
const built = existsSync(BUNDLE);

// web/vault.mjs is browser code and reaches for localStorage, which Node has no
// equivalent of. Installed before the bundle is imported, and only a Map — the
// point of this file is the bundle, not the storage.
globalThis.localStorage = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
})();

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ADDRESS = 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj';

const options = { skip: built ? false : 'run npm run build:web first' };

let obsidian;

before(async () => {
  if (!built) return;
  obsidian = await import(BUNDLE);
});

test('the bundle exports the surface the app imports', options, () => {
  for (const name of [
    'walletFromPhrase',
    'isValidPhrase',
    'sign',
    'submitClaim',
    'submitPayment',
    'submitNameRegistration',
    'createVault',
    'openVault',
    'saveVault',
    'loadVault',
    'saveWalletAddress',
    'loadWalletAddress',
    'PassphraseError',
    'parseObs',
    'formatObs',
  ]) {
    assert.equal(typeof obsidian[name], 'function', `the bundle must export ${name}`);
  }
  // TxType and OnsOp are numeric enums, so they arrive as objects.
  for (const name of ['TxType', 'OnsOp']) {
    assert.equal(typeof obsidian[name], 'object', `the bundle must export ${name}`);
  }
  assert.equal(obsidian.TxType.MINING_CLAIM, 7);
  assert.equal(obsidian.OnsOp.REGISTER, 1);
  assert.equal(obsidian.PROTOCOL_VERSION, '1.7.0');
});

test('the bundle derives the pinned address', options, () => {
  assert.equal(obsidian.isValidPhrase(PHRASE), true);
  assert.equal(obsidian.walletFromPhrase(PHRASE).address, ADDRESS);
});

test('the bundle seals and opens a real vault', options, async () => {
  const vault = await obsidian.createVault(PHRASE, 'correct horse battery staple', 'dobs');
  obsidian.saveVault(vault);
  assert.equal(await obsidian.openVault(vault, 'correct horse battery staple'), PHRASE);
  assert.equal(obsidian.loadVault().ciphertext, vault.ciphertext);
  obsidian.saveWalletAddress(ADDRESS);
  assert.equal(obsidian.loadWalletAddress(), ADDRESS);
});

test('the bundle signs and submits a real claim', options, async () => {
  const sent = [];
  const result = await obsidian.submitClaim({
    loadVault: () => obsidian.loadVault(),
    loadAddress: () => ADDRESS,
    requestPassphrase: async () => 'correct horse battery staple',
    getContext: async () => ({ chainId: 7777, protocolVersion: '1.7.0', protocolTime: 1_700_000_000 }),
    getNonce: async () => 7,
    getMiningStatus: async () => ({
      eligible: true,
      nextClaimId: 'ab'.repeat(32),
      nextClaimSequence: 3,
      rewardPerClaimObs: '0.000166666666666666',
    }),
    getName: async () => null,
    getGateCertificate: async () => ({ issuer: '02'.repeat(33), issuedAt: 1_700_000_000, signature: 'ab'.repeat(64) }),
    getBalance: async () => ({ balanceSeals: (10n ** 18n).toString() }),
    submit: async (hex, txId) => {
      sent.push(hex);
      return { accepted: true, txId };
    },
  });

  assert.equal(result.ok, true, result.message);
  assert.equal(result.address, ADDRESS);
  assert.match(result.txId, /^[0-9a-f]{64}$/);
  // Hex, because that is what /tx/submit takes — and 64 hex characters of id plus
  // a body is well past a string that could be all zeroes by accident.
  assert.match(sent[0], /^[0-9a-f]+$/);
  assert.ok(sent[0].length > 200, `a signed claim should be a few hundred hex chars, got ${sent[0].length}`);
});

test('the bundle refuses a wrong passphrase rather than signing garbage', options, async () => {
  const result = await obsidian.submitClaim({
    loadVault: () => obsidian.loadVault(),
    loadAddress: () => ADDRESS,
    requestPassphrase: async () => 'wrong',
    getContext: async () => ({ chainId: 7777, protocolVersion: '1.7.0', protocolTime: 1_700_000_000 }),
    getNonce: async () => 7,
    getMiningStatus: async () => ({ eligible: true, nextClaimId: 'ab'.repeat(32), nextClaimSequence: 3 }),
    submit: async () => ({}),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BAD_PASSPHRASE');
});

test('the bundle holds no Node built-in and no Node global', options, async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(BUNDLE, 'utf8');
  for (const pattern of [/from\s*["']node:/, /\bprocess\.env\b/, /\bnew\s+Buffer\b/, /\b__dirname\b/]) {
    assert.doesNotMatch(source, pattern, `the bundle must not contain ${pattern}`);
  }
});
