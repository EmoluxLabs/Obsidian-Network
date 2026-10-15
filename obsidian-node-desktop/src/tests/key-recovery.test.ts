import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { loadCore } from '../core/core-loader.js';
import { createPaths } from '../core/paths.js';
import { WalletService } from '../core/wallet-service.js';
import { KEY_SECRET_PREFIX, isKeySecret, openVaultPhrase, sealVault } from '../core/vault.js';
import { tempDir } from './helpers.js';

const PASS = 'correct horse battery staple';
const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('key recovery: creation shows the phrase and the private key it controls, and the key restores the same address', async () => {
  const a = tempDir();
  const b = tempDir();
  try {
    const first = new WalletService(createPaths(a.dir), () => loadCore());
    const pending = await first.beginCreate('devnet');
    assert.match(pending.privateKey, /^[0-9a-f]{64}$/);
    const words = pending.phrase.split(' ');
    const created = await first.finishCreate({ pendingId: pending.pendingId, passphrase: PASS, confirmWords: pending.confirmPositions.map((p) => words[p - 1]!) });
    const signingKey = await first.withWallet('devnet', PASS, async (w) => w.privateKeyHex);
    assert.equal(signingKey, pending.privateKey, 'the key shown is the key that signs');

    const second = new WalletService(createPaths(b.dir), () => loadCore());
    const preview = await second.previewPrivateKey('devnet', pending.privateKey);
    assert.equal(preview.address, created.address, 'the confirmation address is the phrase wallet’s address');
    assert.equal((await second.status('devnet')).exists, false, 'previewing stores nothing');
    const restored = await second.importPrivateKey('devnet', pending.privateKey, PASS, preview.address);
    assert.equal(restored.address, created.address);
    const again = await second.withWallet('devnet', PASS, async (w) => ({ address: w.address, key: w.privateKeyHex, pub: w.publicKey }));
    assert.equal(again.address, created.address);
    assert.equal(again.key, pending.privateKey);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test('key recovery: accepts 0x and upper case; refuses bad keys, a wrong confirmation and a weak passphrase, storing nothing', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const paths = createPaths(dir);
    const wallets = new WalletService(paths, () => loadCore());
    const core = await loadCore();
    const known = core.mnemonic.deriveWallet(PHRASE, 0, 0, undefined, 'dobs');
    const vault = paths.forNetwork('devnet').vault;

    const good = await wallets.previewPrivateKey('devnet', `  0x${known.privateKey.toUpperCase()} `);
    assert.equal(good.address, known.address ?? core.keys.addressFromPublicKey(known.publicKey, 'dobs'));

    const bad = ['', '   ', 'zz'.repeat(32), known.privateKey.slice(2), `${known.privateKey}00`, '00'.repeat(32), 'ff'.repeat(32), `02${known.privateKey}`, PHRASE];
    for (const input of bad) {
      await assert.rejects(wallets.previewPrivateKey('devnet', input), (error: Error) => {
        if (input.trim()) assert.ok(!error.message.includes(input.trim()), 'the refusal never echoes the input');
        return true;
      });
      await assert.rejects(wallets.importPrivateKey('devnet', input, PASS, good.address));
    }
    await assert.rejects(wallets.importPrivateKey('devnet', known.privateKey, PASS, 'dobs1notthisaddress'), /not the one this key controls/);
    await assert.rejects(wallets.importPrivateKey('devnet', known.privateKey, 'short', good.address), /at least 12/);
    assert.equal(existsSync(vault), false, 'no refusal left a vault behind');

    await wallets.importPrivateKey('devnet', known.privateKey, PASS, good.address);
    const raw = readFileSync(vault, 'utf8');
    assert.ok(!raw.includes(known.privateKey), 'the key is not in the vault file in clear');
    await assert.rejects(wallets.importPrivateKey('devnet', known.privateKey, PASS, good.address), /already exists/);
  } finally {
    cleanup();
  }
});

test('key recovery: the vault secret marker matches the web app wallet and is recognised', async () => {
  const core = await loadCore();
  assert.equal(KEY_SECRET_PREFIX, 'obsidian-key:v1:');
  assert.equal(isKeySecret(`${KEY_SECRET_PREFIX}${'ab'.repeat(32)}`), true);
  assert.equal(isKeySecret(PHRASE), false);
  const key = core.mnemonic.deriveWallet(PHRASE, 0, 0, undefined, 'dobs').privateKey;
  const sealed = await sealVault(core, `${KEY_SECRET_PREFIX}${key}`, PASS, 'dobs');
  assert.equal(await openVaultPhrase(sealed, PASS), `${KEY_SECRET_PREFIX}${key}`);
  await assert.rejects(sealVault(core, `${KEY_SECRET_PREFIX}nothex`, PASS, 'dobs'));
});
