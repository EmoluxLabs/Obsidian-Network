// @vitest-environment jsdom
/**
 * The browser vault: what protects a recovery phrase that lives in this
 * browser's storage.
 *
 * Several of these exist because of one fact: from 1.3.0 key derivation is real
 * BIP-32. `Wallet.sign()` re-derives the key from the phrase but stamps the
 * transaction with the address STORED in the vault, so a vault written by an
 * earlier release produced transactions that failed with a bare "bad signature"
 * and no hint why. Unlocking such a vault now says what is wrong.
 */

import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InsecureContextError,
  LegacyVaultError,
  MIN_VAULT_PASSPHRASE_LENGTH,
  Wallet,
  webCryptoAvailable,
  type VaultFile,
  type VaultPayload,
} from '../web/src/lib/wallet.js';
import { deriveWallet, generateRecoveryPhrase } from '../web/core/crypto/mnemonic.js';
import { addressFromPublicKey, verifyDigest, verifyMessage } from '../web/core/crypto/keys.js';
import { decodeSignedTxFromBytes, signingDigest } from '../web/core/transactions/encode.js';

const STORAGE_KEY = 'obsidian.vault.v1';
const PASSPHRASE = 'a passphrase long enough for the vault';

beforeEach(() => {
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true, writable: true });
  window.localStorage.clear();
});

/** Write a vault the way an OLDER build would have: chosen iterations, optionally un-normalised passphrase. */
async function writeVault(
  payload: VaultPayload,
  passphrase: string,
  options: { iterations?: number; normalise?: boolean } = {},
): Promise<void> {
  const iterations = options.iterations ?? 210_000;
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(options.normalise === false ? passphrase : passphrase.normalize('NFKC'));
  const material = await webcrypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
  const key = await webcrypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const ciphertext = new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const b64 = (data: Uint8Array) => Buffer.from(data).toString('base64');
  const vault: VaultFile = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: b64(salt),
    iv: b64(iv),
    ciphertext: b64(ciphertext),
    address: payload.accounts[0]!.address,
    addressHrp: payload.addressHrp,
    createdAt: Date.now(),
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
}

function honestPayload(phrase = generateRecoveryPhrase()): VaultPayload {
  const derived = deriveWallet(phrase, 0, 0);
  return {
    phrase,
    addressHrp: 'dobs',
    accounts: [{ address: addressFromPublicKey(derived.publicKey, 'dobs'), publicKey: derived.publicKey, label: 'Main wallet', createdAt: 1, account: 0, index: 0 }],
  };
}

describe('creating a vault', () => {
  it('asks for a passphrase that is actually hard to guess offline', async () => {
    expect(MIN_VAULT_PASSPHRASE_LENGTH).toBeGreaterThanOrEqual(12);
    await expect(Wallet.create('dobs', 'short-one')).rejects.toThrow(/at least 12 characters/);
    await expect(Wallet.create('dobs', 'x'.repeat(MIN_VAULT_PASSPHRASE_LENGTH - 1))).rejects.toThrow(/at least 12 characters/);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('stretches the passphrase with 600,000 PBKDF2 iterations and records the figure', async () => {
    await Wallet.create('dobs', PASSPHRASE);
    const vault = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as VaultFile;
    expect(vault.iterations).toBe(600_000);
    expect(vault.ciphertext).not.toContain('abandon');
  }, 30_000);

  it('opens again with the same passphrase and refuses a wrong one', async () => {
    const created = await Wallet.create('dobs', PASSPHRASE);
    const reopened = await Wallet.unlock(PASSPHRASE);
    expect(reopened.address).toBe(created.address);
    await expect(Wallet.unlock('not the passphrase at all')).rejects.toThrow(/wrong passphrase/);
  }, 30_000);
});

describe('vaults written by earlier releases', () => {
  it('still opens a vault stretched with the old 210,000 iterations', async () => {
    const payload = honestPayload();
    await writeVault(payload, PASSPHRASE, { iterations: 210_000 });
    expect((await Wallet.unlock(PASSPHRASE)).address).toBe(payload.accounts[0]!.address);
  }, 30_000);

  it('refuses a vault whose keys the phrase can no longer reproduce, and says exactly why', async () => {
    const phrase = generateRecoveryPhrase();
    const payload = honestPayload(phrase);
    // What a pre-1.3.0 vault holds: an address and public key from the old,
    // non-standard derivation. Any key that is not the BIP-32 one will do.
    const stranger = deriveWallet(generateRecoveryPhrase(), 0, 0);
    payload.accounts[0] = {
      ...payload.accounts[0]!,
      publicKey: stranger.publicKey,
      address: addressFromPublicKey(stranger.publicKey, 'dobs'),
    };
    await writeVault(payload, PASSPHRASE);
    const failure = await Wallet.unlock(PASSPHRASE).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LegacyVaultError);
    expect((failure as Error).message).toMatch(/before 1\.3\.0/);
    expect((failure as Error).message).toMatch(/create a new wallet/);
    expect((failure as Error).message).toContain(payload.accounts[0]!.address);
  }, 30_000);
});

describe('passphrase spelling', () => {
  const composed = 'caf\u00e9 au lait numero quatre'; // é as ONE code point
  const decomposed = 'cafe\u0301 au lait numero quatre'; // é as e + combining accent

  it('opens on a device that types the same passphrase in the other Unicode form', async () => {
    expect(composed).not.toBe(decomposed);
    await Wallet.create('dobs', composed);
    expect((await Wallet.unlock(decomposed)).address).toBe((await Wallet.unlock(composed)).address);
  }, 60_000);

  it('opens an older vault that was stretched from the un-normalised spelling', async () => {
    const payload = honestPayload();
    await writeVault(payload, decomposed, { normalise: false });
    expect((await Wallet.unlock(decomposed)).address).toBe(payload.accounts[0]!.address);
  }, 30_000);
});

describe('a page the browser gives no cryptography to', () => {
  const withoutSubtle = () =>
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
      configurable: true,
      writable: true,
    });

  it('is detected, and is not mistaken for a working page', () => {
    expect(webCryptoAvailable()).toBe(true);
    withoutSubtle();
    expect(webCryptoAvailable()).toBe(false);
  });

  it('cannot create a vault, says why, and writes nothing', async () => {
    withoutSubtle();
    const failure = await Wallet.create('dobs', PASSPHRASE).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(InsecureContextError);
    expect((failure as Error).message).toMatch(/HTTPS/);
    expect((failure as Error).message).toMatch(/127\.0\.0\.1/);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

// ── Adversarial: what happens when the stored vault is not what this build wrote ─────────────────────────────

const readStored = (): VaultFile => JSON.parse(window.localStorage.getItem(STORAGE_KEY)!) as VaultFile;
const writeStored = (vault: unknown): void => window.localStorage.setItem(STORAGE_KEY, typeof vault === 'string' ? vault : JSON.stringify(vault));

describe('a stored vault that was damaged, altered or written by something else', () => {
  it('round-trips, and the phrase is nowhere in storage in the clear', async () => {
    const created = await Wallet.create('dobs', PASSPHRASE);
    const raw = window.localStorage.getItem(STORAGE_KEY)!;
    for (const word of created.revealPhrase().split(' ').slice(0, 6)) expect(raw).not.toContain(word);
    expect(raw).not.toContain(created.revealPrivateKey(0));
    expect((await Wallet.unlock(PASSPHRASE)).address).toBe(created.address);
  }, 30_000);

  it('refuses an unsupported version, an unknown KDF, and says so (instead of guessing)', async () => {
    await writeVault(honestPayload(), PASSPHRASE);
    const good = readStored();
    writeStored({ ...good, version: 2 });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/version 2.*not supported/);
    writeStored({ ...good, version: undefined });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/not supported/);
    writeStored({ ...good, kdf: 'scrypt' });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/cannot open/);
  });

  it('refuses an iteration count outside the accepted range BEFORE spending the work (a modified vault cannot freeze the page)', async () => {
    await writeVault(honestPayload(), PASSPHRASE);
    const good = readStored();
    for (const iterations of [2_000_000_000, 1, 0, -5, 99_999, 10_000_001, 1.5, '600000', null]) {
      writeStored({ ...good, iterations });
      const started = Date.now();
      await expect(Wallet.unlock(PASSPHRASE), String(iterations)).rejects.toThrow(/outside the accepted range/);
      expect(Date.now() - started, `iterations ${String(iterations)} must be refused immediately`).toBeLessThan(250);
    }
  });

  it('says "damaged" for unreadable JSON, a non-object, bad base64, and truncated fields', async () => {
    await writeVault(honestPayload(), PASSPHRASE);
    const good = readStored();
    writeStored('{"version":1,"kdf"');
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/damaged/);
    writeStored('null');
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/damaged/);
    writeStored('[]');
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/not supported|damaged/);
    writeStored({ ...good, salt: '***not base64***' });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/damaged/);
    writeStored({ ...good, iv: good.iv.slice(0, 8) });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/damaged/);
    writeStored({ ...good, ciphertext: good.ciphertext.slice(0, 12) });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/damaged/);
    writeStored({ ...good, salt: Buffer.alloc(4096).toString('base64') });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/damaged/);
  });

  it('detects a flipped ciphertext bit or a swapped salt as "wrong passphrase (or modified)", never as a wallet', async () => {
    await writeVault(honestPayload(), PASSPHRASE);
    const good = readStored();
    const bytes = Buffer.from(good.ciphertext, 'base64');
    bytes[Math.floor(bytes.length / 2)]! ^= 0x01;
    writeStored({ ...good, ciphertext: bytes.toString('base64') });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/wrong passphrase \(or the vault was modified\)/);
    const salt = Buffer.from(good.salt, 'base64');
    salt[0]! ^= 0xff;
    writeStored({ ...good, salt: salt.toString('base64') });
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toThrow(/wrong passphrase/);
  });

  it('refuses a vault whose payload is not a wallet even when it decrypts', async () => {
    await writeVault({ phrase: 'abandon abandon abandon', addressHrp: 'dobs', accounts: [{ address: 'dobs1x', publicKey: '00', label: 'x', createdAt: 1, account: 0, index: 0 }] } as VaultPayload, PASSPHRASE);
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toBeInstanceOf(Error);
  });

  it('writes no secret to the console while creating, unlocking and failing to unlock', async () => {
    const seen: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void seen.push(args.map(String).join(' '))));
    try {
      const created = await Wallet.create('dobs', PASSPHRASE);
      const phrase = created.revealPhrase();
      const priv = created.revealPrivateKey(0);
      await Wallet.unlock(PASSPHRASE);
      await Wallet.unlock('a completely wrong passphrase').catch(() => undefined);
      const text = seen.join('\n');
      expect(text).not.toContain(PASSPHRASE);
      expect(text).not.toContain(priv);
      for (const word of phrase.split(' ').slice(0, 4)) expect(text).not.toContain(word);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
  }, 30_000);
});

describe('signing is domain-separated', () => {
  it('a wallet-link proof is not a transaction signature, and a transaction for one chain is not valid on another', async () => {
    const wallet = await Wallet.create('dobs', PASSPHRASE);
    const proof = wallet.signMessageFor(wallet.address, 'OBSIDIAN:WALLET_LINK:v1', 'link me to account 7');
    // The same bytes under any other domain do not verify: the proof cannot be replayed as something else.
    expect(verifyMessage('OBSIDIAN:WALLET_LINK:v1', new TextEncoder().encode('link me to account 7'), proof.signature, proof.publicKey)).toBe(true);
    for (const other of ['OBSIDIAN:TX:v1', 'OBSIDIAN:MINING_GATE:v1', 'OBSIDIAN:WALLET_LINK:v2', '']) {
      expect(verifyMessage(other, new TextEncoder().encode('link me to account 7'), proof.signature, proof.publicKey), `domain ${other}`).toBe(false);
    }
    expect(verifyMessage('OBSIDIAN:WALLET_LINK:v1', new TextEncoder().encode('link me to account 8'), proof.signature, proof.publicKey)).toBe(false);

    const body = new Uint8Array([1, 2, 3]);
    const input = { protocolVersion: '1.9.0', type: 1 as never, nonce: 0, gas: 0n, body, validUntil: 2_000_000_000 };
    const forDev = decodeSignedTxFromBytes(wallet.sign({ ...input, chainId: 7780 }));
    const forMain = decodeSignedTxFromBytes(wallet.sign({ ...input, chainId: 7777 }));
    expect(verifyDigest(signingDigest(forDev), forDev.signature.signature, forDev.signature.publicKey)).toBe(true);
    // Re-labelling the signed transaction with another chain id invalidates the signature.
    expect(verifyDigest(signingDigest({ ...forDev, chainId: 7777 }), forDev.signature.signature, forDev.signature.publicKey)).toBe(false);
    expect(forDev.signature.signature).not.toBe(forMain.signature.signature);
  }, 30_000);
});

describe('private-key recovery (1.9.0)', () => {
  const HRP = 'tobs';

  it('a key from a created wallet restores the SAME address and byte-identical signatures', async () => {
    const created = await Wallet.create(HRP, PASSPHRASE);
    const key = created.revealPrivateKey(0);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const shown = Wallet.addressForPrivateKey(key, HRP);
    expect(shown).toEqual({ ok: true, address: created.address });
    window.localStorage.clear();
    const restored = await Wallet.fromPrivateKey(key, HRP, PASSPHRASE);
    expect(restored.address).toBe(created.address);
    expect(restored.hasPhrase).toBe(false);
    expect(restored.revealPrivateKey(0)).toBe(key);
    const sign = (w: Wallet) => w.signMessageFor(w.address, 'obsidian.test', 'hello');
    expect(sign(restored)).toEqual(sign(created));
  });

  it('accepts upper case and a 0x prefix, and persists a vault that unlocks with the vault passphrase', async () => {
    const reference = await Wallet.fromPhrase(generateRecoveryPhrase(), HRP, PASSPHRASE);
    const key = reference.revealPrivateKey(0);
    window.localStorage.clear();
    const restored = await Wallet.fromPrivateKey(`  0x${key.toUpperCase()}  `, HRP, PASSPHRASE);
    expect(restored.address).toBe(reference.address);
    const reopened = await Wallet.unlock(PASSPHRASE);
    expect(reopened.address).toBe(reference.address);
    expect(reopened.revealPrivateKey(0)).toBe(key);
    expect(reopened.hasPhrase).toBe(false);
    expect(reopened.revealPhrase()).toBe('');
  });

  it('refuses invalid keys safely: nothing is stored and the message never repeats the input', async () => {
    const good = 'ab'.repeat(32);
    const bad: string[] = [
      '',
      '   ',
      'zz'.repeat(32),
      good.slice(0, 62),
      `${good}00`,
      '00'.repeat(32),
      'ff'.repeat(32),
      `02${good}`,
      `04${good}${good}`,
      'one two three four five six seven eight nine ten eleven twelve',
      'KxL5notarealwifkeyKxL5notarealwifkeyKxL5notarealwifkey',
    ];
    for (const input of bad) {
      const preview = Wallet.addressForPrivateKey(input, HRP);
      expect(preview.ok).toBe(false);
      await expect(Wallet.fromPrivateKey(input, HRP, PASSPHRASE)).rejects.toThrow();
      try {
        await Wallet.fromPrivateKey(input, HRP, PASSPHRASE);
      } catch (error) {
        if (input.trim()) expect((error as Error).message).not.toContain(input.trim());
      }
      expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
    }
  });

  it('a short vault passphrase and a bad address prefix are refused before anything is stored', async () => {
    await expect(Wallet.fromPrivateKey('ab'.repeat(32), HRP, 'short')).rejects.toThrow(/at least/);
    await expect(Wallet.fromPrivateKey('ab'.repeat(32), 'NOT-A-PREFIX', PASSPHRASE)).rejects.toThrow(/prefix/);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('the stored vault holds the key encrypted: no plaintext key or hex in localStorage', async () => {
    const key = 'cd'.repeat(32);
    await Wallet.fromPrivateKey(key, HRP, PASSPHRASE);
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toContain(key);
  });

  it('a key wallet signs transactions that verify against its address, can switch network, and cannot derive more addresses', async () => {
    const wallet = await Wallet.fromPrivateKey('11'.repeat(32), HRP, PASSPHRASE);
    await wallet.switchNetwork('obs', PASSPHRASE);
    expect(wallet.address.startsWith('obs1')).toBe(true);
    await expect(wallet.addAccount(PASSPHRASE, 1, 'second')).rejects.toThrow(/one address only/);
    const proof = wallet.signMessageFor(wallet.address, 'obsidian.test', 'm');
    expect(verifyMessage('obsidian.test', new TextEncoder().encode('m'), proof.signature, proof.publicKey)).toBe(true);
  });

  it('a tampered key-wallet vault (public key not matching its key) is refused at unlock, not silently used', async () => {
    const good = await Wallet.fromPrivateKey('22'.repeat(32), HRP, PASSPHRASE);
    const other = await Wallet.fromPrivateKey('33'.repeat(32), HRP, PASSPHRASE);
    window.localStorage.clear();
    await writeVault({ phrase: '', importedKey: '22'.repeat(32), addressHrp: HRP, accounts: [{ ...(other as unknown as { payload: VaultPayload }).payload.accounts[0]!, label: 'x' }] }, PASSPHRASE);
    await expect(Wallet.unlock(PASSPHRASE)).rejects.toBeInstanceOf(LegacyVaultError);
    expect(good.address).not.toBe(other.address);
  });
});
