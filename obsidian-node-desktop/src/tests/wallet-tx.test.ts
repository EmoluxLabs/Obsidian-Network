import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { loadCore } from '../core/core-loader.js';
import { createPaths } from '../core/paths.js';
import { WalletService } from '../core/wallet-service.js';
import { tempDir } from './helpers.js';

const PASS = 'correct horse battery staple';

test('wallet service: create needs the confirmation words, import, throttle, remove — and no secret on disk in clear', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const paths = createPaths(dir);
    const wallets = new WalletService(paths, () => loadCore());
    assert.equal((await wallets.status('devnet')).exists, false);

    const pending = await wallets.beginCreate('devnet');
    const words = pending.phrase.split(' ');
    assert.equal(words.length, 24);
    assert.equal(pending.confirmPositions.length, 3);
    await assert.rejects(wallets.finishCreate({ pendingId: pending.pendingId, passphrase: PASS, confirmWords: ['no', 'no', 'no'] }), /do not match|wrong|words/i);
    assert.equal((await wallets.status('devnet')).exists, false, 'a wrong word creates nothing');
    const created = await wallets.finishCreate({ pendingId: pending.pendingId, passphrase: PASS, confirmWords: pending.confirmPositions.map((p) => words[p - 1]!) });
    assert.match(created.address!, /^dobs1/);

    const vaultPath = paths.forNetwork('devnet').vault;
    const raw = readFileSync(vaultPath, 'utf8');
    for (const w of words.slice(0, 6)) assert.ok(!raw.includes(`${w} ${words[words.indexOf(w) + 1]}`), 'phrase is not stored in clear');
    if (process.platform !== 'win32') assert.equal(statSync(vaultPath).mode & 0o077, 0, 'vault file is owner-only');

    // each network has its own wallet
    assert.equal((await wallets.status('testnet')).exists, false);

    // signing access needs the passphrase every time and never returns it
    const addr = await wallets.withWallet('devnet', PASS, async (w) => w.address);
    assert.equal(addr, created.address);
    for (let i = 0; i < 5; i += 1) await assert.rejects(wallets.withWallet('devnet', 'wrong passphrase!!', async () => 1), /passphrase/i);
    await assert.rejects(wallets.withWallet('devnet', PASS, async () => 1), /too many|wait|try again/i, 'throttled after repeated failures');

    await assert.rejects(wallets.remove('devnet', 'wrong passphrase!!'));
    assert.ok(existsSync(vaultPath));
  } finally {
    cleanup();
  }
});

test('wallet service: importing a known phrase gives the known address; duplicate import is refused', async () => {
  const { dir, cleanup } = tempDir();
  try {
    const wallets = new WalletService(createPaths(dir), () => loadCore());
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const s = await wallets.importPhrase('devnet', phrase, PASS);
    assert.equal(s.address, 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0');
    await assert.rejects(wallets.importPhrase('devnet', phrase, PASS), /already/i);
    await assert.rejects(wallets.importPhrase('testnet', 'nonsense words here', PASS));
    await wallets.remove('devnet', PASS);
    assert.equal((await wallets.status('devnet')).exists, false);
  } finally {
    cleanup();
  }
});
