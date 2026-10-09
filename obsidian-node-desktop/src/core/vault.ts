/**
 * The recovery-phrase vault, in the Obsidian platform's own format (`obsidian.vault.v1`).
 *
 * Nothing about the format is chosen here: it is the same versioned envelope, the same JSON
 * payload, PBKDF2-HMAC-SHA256 at 600,000 iterations with AES-GCM, the same NFKC passphrase
 * normalisation and the same 12-character minimum as obsidian-interface/web/src/lib/wallet.ts
 * and obsidian-app-web/web/vault.mjs. A vault sealed by either of them opens here and the
 * reverse (tests/vault-interop.test.ts proves it against the real code when the monorepo is
 * present). The only difference is where the envelope is stored: a file in the app's
 * per-network wallet directory instead of browser storage.
 *
 *  - The phrase exists in clear only inside `openVault`'s caller, only for the duration of one
 *    signing call. Nothing here caches it.
 *  - A wrong passphrase is a PassphraseError (AES-GCM authenticates), never garbage.
 *  - Nothing here touches the network.
 */
import { webcrypto } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { writeFileAtomic } from './atomic-file.js';
import type { CoreModules } from './core-loader.js';

const subtle = webcrypto.subtle;
export const PBKDF2_ITERATIONS = 600_000;
export const KDF = 'PBKDF2-SHA256';
export const MIN_PASSPHRASE_LENGTH = 12;

export class PassphraseError extends Error {
  constructor(message = 'That passphrase is not correct.') {
    super(message);
    this.name = 'PassphraseError';
  }
}

export interface VaultEnvelope {
  version: 1;
  kdf: string;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  /** Public. Derived from the phrase when the vault is sealed and re-checked when it is opened. */
  address: string;
  addressHrp: string;
  createdAt: number;
}

const toB64 = (bytes: ArrayBuffer | Uint8Array): string => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
const fromB64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number, normalise = true): Promise<webcrypto.CryptoKey> {
  const text = normalise ? passphrase.normalize('NFKC') : passphrase;
  const material = await subtle.importKey('raw', new TextEncoder().encode(text), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealVault(core: CoreModules, phrase: string, passphrase: string, addressHrp: string): Promise<VaultEnvelope> {
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  const words = core.mnemonic.normalizePhrase(String(phrase ?? '').trim());
  if (!core.mnemonic.isValidRecoveryPhrase(words)) throw new Error('That recovery phrase is not valid.');
  const derived = core.mnemonic.deriveWallet(words, 0, 0, undefined, addressHrp);
  const address = derived.address ?? core.keys.addressFromPublicKey(derived.publicKey, addressHrp);
  const payload = {
    phrase: words,
    addressHrp,
    accounts: [{ address, publicKey: derived.publicKey, label: 'Main wallet', createdAt: Date.now(), account: 0, index: 0 }],
  };
  const salt = webcrypto.getRandomValues(new Uint8Array(16));
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { version: 1, kdf: KDF, iterations: PBKDF2_ITERATIONS, salt: toB64(salt), iv: toB64(iv), ciphertext: toB64(ciphertext), address, addressHrp, createdAt: Date.now() };
}

/** Decrypt and return the phrase. The caller uses it once and drops it. */
export async function openVaultPhrase(vault: VaultEnvelope, passphrase: string): Promise<string> {
  if (vault.version !== 1) throw new Error('This vault format is not supported by this version of the app.');
  if (vault.kdf !== KDF) throw new Error(`This vault was sealed with ${vault.kdf}, which this build cannot open.`);
  if (!Number.isInteger(vault.iterations) || vault.iterations < 100_000 || vault.iterations > 10_000_000) {
    throw new Error('This vault declares an unusable key-derivation cost, so it was not opened.');
  }
  const salt = fromB64(vault.salt);
  const iv = fromB64(vault.iv);
  const ciphertext = fromB64(vault.ciphertext);
  const decrypt = async (normalise: boolean): Promise<Uint8Array> =>
    new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(passphrase, salt, vault.iterations, normalise), ciphertext));
  let plain: Uint8Array;
  try {
    plain = await decrypt(true);
  } catch {
    if (passphrase.normalize('NFKC') === passphrase) throw new PassphraseError();
    try {
      plain = await decrypt(false);
    } catch {
      throw new PassphraseError();
    }
  }
  let payload: { phrase?: unknown };
  try {
    payload = JSON.parse(new TextDecoder().decode(plain)) as { phrase?: unknown };
  } catch {
    throw new Error('This vault opened, but its contents are not a wallet this version understands.');
  }
  if (typeof payload.phrase !== 'string' || !payload.phrase) throw new Error('This vault opened, but it holds no recovery phrase.');
  return payload.phrase;
}

export function readVaultFile(path: string): VaultEnvelope | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<VaultEnvelope>;
  if (
    raw.version !== 1 ||
    typeof raw.kdf !== 'string' ||
    typeof raw.iterations !== 'number' ||
    typeof raw.salt !== 'string' ||
    typeof raw.iv !== 'string' ||
    typeof raw.ciphertext !== 'string' ||
    typeof raw.address !== 'string' ||
    typeof raw.addressHrp !== 'string'
  ) {
    throw new Error('The wallet file is damaged or not an Obsidian vault.');
  }
  return raw as VaultEnvelope;
}

export function writeVaultFile(path: string, vault: VaultEnvelope): void {
  writeFileAtomic(path, `${JSON.stringify(vault)}\n`, 0o600);
}

export function removeVaultFile(path: string): void {
  rmSync(path, { force: true });
}
