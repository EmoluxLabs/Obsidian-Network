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
import { beforeEach, describe, expect, it } from 'vitest';
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
import { addressFromPublicKey } from '../web/core/crypto/keys.js';

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
