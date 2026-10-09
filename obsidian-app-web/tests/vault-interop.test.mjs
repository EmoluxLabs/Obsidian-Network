/**
 * One wallet, two products.
 *
 * A person who created a wallet on the Obsidian Web platform and one who created it
 * here are the same kind of person holding the same kind of object: a recovery phrase
 * sealed under a passphrase. This file proves the two products seal and open each
 * other's vaults, by running the PLATFORM'S OWN CODE (web/src/lib/wallet.ts, bundled
 * with its own esbuild) — not a copy of its algorithm that could drift from it.
 *
 * Browser storage is per-origin, so this matters wherever the two are served from one
 * origin (a shared domain behind one reverse proxy). On separate origins the phrase is
 * the portable thing, and the last test shows both derive the same address from it.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

// A localStorage both sides share, as one origin would.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const vault = await import('../web/vault.mjs');
const { walletFromPhrase } = await import('../web/signing.mjs');
const { MIN_PASSPHRASE_LENGTH } = await import('../public/data.mjs');

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASS = 'correct horse battery staple';
const BY_HRP = {
  obs: 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj',
  tobs: 'tobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rgcp8kr',
  sobs: 'sobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66ra0j5mt',
  dobs: 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0',
};

let platform = null;
let skipReason = null;
let tmp = null;

before(async () => {
  try {
    const requireFromInterface = createRequire(join(root, 'obsidian-interface', 'package.json'));
    const esbuild = requireFromInterface('esbuild');
    tmp = mkdtempSync(join(tmpdir(), 'obs-platform-wallet-'));
    const out = join(tmp, 'wallet.mjs');
    await esbuild.build({
      entryPoints: [join(root, 'obsidian-interface/web/src/lib/wallet.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      outfile: out,
      logLevel: 'silent',
    });
    platform = await import(pathToFileURL(out).href);
  } catch (error) {
    skipReason = `the platform's wallet could not be built here: ${error.message}`;
  }
});

after(() => tmp && rmSync(tmp, { recursive: true, force: true }));

const needsPlatform = (fn) => async (t) => {
  if (!platform) return t.skip(skipReason);
  store.clear();
  return fn(t);
};

test('a vault sealed here is the platform’s vault: it finds it, reads its address, and unlocks it', needsPlatform(async () => {
  const sealed = await vault.createVault(PHRASE, PASS, 'dobs');
  vault.saveVault(sealed);

  assert.equal(platform.Wallet.exists(), true, 'the platform sees a wallet in storage');
  assert.equal(platform.Wallet.storedAddress(), BY_HRP.dobs);
  assert.equal(platform.Wallet.storedHrp(), 'dobs');

  const unlocked = await platform.Wallet.unlock(PASS);
  assert.equal(unlocked.revealPhrase(), PHRASE);
  assert.equal(unlocked.address, BY_HRP.dobs);
  assert.equal(unlocked.addressHrp, 'dobs');
  assert.equal(unlocked.accounts.length, 1);
  assert.equal(unlocked.accounts[0].account, 0);
  assert.equal(unlocked.accounts[0].index, 0);
}));

test('a vault sealed by the platform opens here, and yields the same address', needsPlatform(async () => {
  const made = await platform.Wallet.fromPhrase(PHRASE, 'dobs', PASS);
  const stored = vault.loadVault();
  assert.equal(stored.version, 1);
  const phrase = await vault.openVault(stored, PASS);
  assert.equal(phrase, PHRASE);
  assert.equal(walletFromPhrase(phrase, 'dobs').address, made.address, 'same phrase, same address, both products');
}));

test('a wrong passphrase is a wrong passphrase on both sides', needsPlatform(async () => {
  vault.saveVault(await vault.createVault(PHRASE, PASS, 'dobs'));
  await assert.rejects(vault.openVault(vault.loadVault(), 'not the passphrase!!'), { name: 'PassphraseError' });
  await assert.rejects(platform.Wallet.unlock('not the passphrase!!'), /wrong passphrase/);
}));

test('a passphrase typed composed or decomposed opens the same vault, in either product', needsPlatform(async () => {
  const composed = 'caf\u00e9 au lait 2026';
  const decomposed = 'cafe\u0301 au lait 2026';
  assert.notEqual(composed, decomposed);

  vault.saveVault(await vault.createVault(PHRASE, composed, 'dobs'));
  assert.equal(await vault.openVault(vault.loadVault(), decomposed), PHRASE, 'here');
  assert.equal((await platform.Wallet.unlock(decomposed)).revealPhrase(), PHRASE, 'on the platform');

  await platform.Wallet.fromPhrase(PHRASE, 'dobs', decomposed);
  assert.equal(await vault.openVault(vault.loadVault(), composed), PHRASE, 'sealed there, opened here');
}));

test('the passphrase minimum is the platform’s, and is enforced where the vault is made', needsPlatform(async () => {
  assert.equal(MIN_PASSPHRASE_LENGTH, platform.MIN_VAULT_PASSPHRASE_LENGTH);
  assert.equal(vault.MIN_PASSPHRASE_LENGTH, platform.MIN_VAULT_PASSPHRASE_LENGTH);
  assert.equal(MIN_PASSPHRASE_LENGTH, 12);
  await assert.rejects(vault.createVault(PHRASE, 'x'.repeat(11), 'dobs'), /at least 12/);
  assert.ok(await vault.createVault(PHRASE, 'x'.repeat(12), 'dobs'));
  // The platform enforces the same minimum, so neither product can create a vault the
  // other would have refused.
  await assert.rejects(platform.Wallet.create('dobs', 'x'.repeat(11)), /at least 12/);
}));

test('a vault needs a network: there is no default prefix to mint a wrong address with', async () => {
  await assert.rejects(vault.createVault(PHRASE, PASS), /address prefix/);
  await assert.rejects(vault.createVault(PHRASE, PASS, ''), /address prefix/);
});

test('a vault from this app’s earlier format still opens, and is replaced rather than duplicated', async () => {
  store.clear();
  // Build the old envelope exactly as the old code did: the plaintext IS the phrase.
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(PASS), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(PHRASE));
  const b64 = (b) => btoa(String.fromCharCode(...new Uint8Array(b)));
  const legacy = { kdf: 'PBKDF2-SHA256', iterations: 600_000, salt: b64(salt), iv: b64(iv), ciphertext: b64(ct) };
  store.set('obsidian.vault', JSON.stringify(legacy));

  assert.deepEqual(vault.loadVault(), legacy, 'found under the old key');
  assert.equal(await vault.openVault(vault.loadVault(), PASS), PHRASE, 'and opened');

  vault.saveVault(await vault.createVault(PHRASE, PASS, 'dobs'));
  assert.equal(store.has('obsidian.vault'), false, 'the old copy is replaced, not left behind');
  assert.equal(vault.loadVault().version, 1);
});

test('destroying the vault removes every copy this app wrote', () => {
  store.set('obsidian.vault', '{}');
  store.set('obsidian.vault.v1', '{}');
  vault.saveWalletAddress(BY_HRP.dobs);
  vault.destroyVault();
  assert.deepEqual([...store.keys()], []);
});

test('the same words are the same wallet in both products on all four networks', needsPlatform(async () => {
  for (const [hrp, expected] of Object.entries(BY_HRP)) {
    const there = await platform.Wallet.fromPhrase(PHRASE, hrp, PASS);
    assert.equal(there.address, expected, `platform ${hrp}`);
    assert.equal(walletFromPhrase(PHRASE, hrp).address, expected, `app ${hrp}`);
  }
}));

test('the stored envelope never contains the phrase or the passphrase in the clear', async () => {
  const sealed = await vault.createVault(PHRASE, PASS, 'dobs');
  const text = JSON.stringify(sealed);
  for (const word of ['abandon', 'about', PASS]) assert.ok(!text.includes(word), `leaked "${word}"`);
  assert.deepEqual(Object.keys(sealed).sort(), ['address', 'addressHrp', 'ciphertext', 'createdAt', 'iterations', 'iv', 'kdf', 'salt', 'version']);
  assert.equal(readFileSync(resolve(here, '../web/vault.mjs'), 'utf8').includes('fetch('), false, 'the vault module never touches the network');
});
