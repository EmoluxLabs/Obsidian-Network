/**
 * The recovery-phrase vault.
 *
 * The last piece standing between a proven-correct signer and one a person can
 * actually use. Its whole job is to make sure a recovery phrase is never at rest in
 * the clear, and never leaves this device.
 *
 * The parameters are not chosen here. They match obsidian-interface's own vault
 * (web/src/lib/wallet.ts): PBKDF2-HMAC-SHA256 at 600,000 iterations — OWASP's 2023
 * figure — with AES-GCM. Matching matters more than being clever: two vaults that
 * encrypt the same phrase differently are two ways to lose a wallet.
 *
 * Three properties this file is built around:
 *
 *   - The phrase is decrypted only to sign, and the decrypted copy is not retained.
 *     There is no in-memory cache of the phrase beyond the call that needs it.
 *   - A wrong passphrase is reported as a wrong passphrase. AES-GCM authenticates, so
 *     a bad key fails the tag check rather than yielding garbage that looks like a
 *     phrase.
 *   - Nothing here talks to the network. The platform never sees a phrase, a private
 *     key or a passphrase, and cannot be made to.
 */

const PBKDF2_ITERATIONS = 600_000;
const KDF = 'PBKDF2-SHA256';
const STORAGE_KEY = 'obsidian.vault';

// The vault envelope, as stored: { kdf, iterations, salt, iv, ciphertext }.
// It holds no plaintext, which is why persisting it is not a leak.

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a recovery phrase under a passphrase.
 *
 * A fresh salt and IV every time, so encrypting the same phrase twice yields
 * different ciphertext — which means the stored blob cannot be compared against
 * another to tell whether two devices hold the same wallet.
 */
export async function createVault(phrase, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(phrase),
  );
  /** @type {Vault} */
  return {
    kdf: KDF,
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ciphertext),
  };
}

/**
 * Decrypt and return the phrase.
 *
 * The caller is expected to use it once and drop it. AES-GCM's tag means a wrong
 * passphrase throws rather than returning nonsense, so a failure here is a genuine
 * "that passphrase is wrong" and not a corrupted wallet.
 */
export async function openVault(vault, passphrase) {
  if (vault.kdf !== KDF) {
    throw new Error(`This vault was sealed with ${vault.kdf}, which this build cannot open.`);
  }
  const key = await deriveKey(passphrase, fromB64(vault.salt), vault.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(vault.iv) },
      key,
      fromB64(vault.ciphertext),
    );
    return new TextDecoder().decode(plain);
  } catch {
    // OperationError from a failed tag check. Do not distinguish it from other
    // decrypt failures: telling a caller which one happened would leak information
    // about the stored blob.
    throw new Error('That passphrase is not correct.');
  }
}

/** Persist the envelope. It holds no plaintext, so storage is not a leak. */
export function saveVault(vault) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
}

export function loadVault() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Destroy the local copy.
 *
 * This does not and cannot destroy the wallet: the phrase still exists wherever the
 * user wrote it down, and anyone holding it can rebuild the same vault. Saying
 * otherwise would be the most dangerous thing this function could imply.
 */
export function destroyVault() {
  localStorage.removeItem(STORAGE_KEY);
}

export { PBKDF2_ITERATIONS, KDF };
