/**
 * The recovery-phrase vault.
 *
 * The last piece standing between a proven-correct signer and one a person can
 * actually use. Its whole job is to make sure a recovery phrase is never at rest in
 * the clear, and never leaves this device.
 *
 * Nothing about the format is chosen here. It is obsidian-interface's own vault
 * (web/src/lib/wallet.ts), byte for byte: the same storage key (`obsidian.vault.v1`),
 * the same versioned envelope, the same JSON payload, PBKDF2-HMAC-SHA256 at 600,000
 * iterations with AES-GCM, the same NFKC passphrase normalisation and the same
 * twelve-character minimum. Two products that seal the same phrase differently are two
 * ways to lose a wallet, and one that seals it the same way can open the other's vault
 * wherever they share an origin (tests/vault-interop.test.mjs opens each with the other's
 * real code). A vault from before this format — a bare encrypted phrase under
 * `obsidian.vault` — is still opened, and never deleted until it is replaced.
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
import { walletFromPhrase } from './signing.mjs';

/** The platform's key. A vault written here is the platform's vault. */
const STORAGE_KEY = 'obsidian.vault.v1';
/** This app's own earlier key: an envelope around a bare phrase. Read, then replaced. */
const LEGACY_STORAGE_KEY = 'obsidian.vault';
const ADDRESS_KEY = 'obsidian.address';
/** The platform's MIN_VAULT_PASSPHRASE_LENGTH: a vault sits in browser storage, where it can be guessed at offline. */
const MIN_PASSPHRASE_LENGTH = 12;

/**
 * Thrown when a passphrase does not open a vault.
 *
 * Typed because the caller has to tell two failures apart. "That passphrase is
 * wrong" is the user's problem to fix; a signing error is not, and reporting the
 * second as the first would send someone hunting for a typo that is not there.
 */
export class PassphraseError extends Error {
  constructor(message = 'That passphrase is not correct.') {
    super(message);
    this.name = 'PassphraseError';
  }
}

// The vault envelope, as stored: { kdf, iterations, salt, iv, ciphertext }.
// It holds no plaintext, which is why persisting it is not a leak.

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/**
 * NFKC-normalise before encoding, exactly as the platform does: one typed passphrase
 * can be composed or decomposed Unicode depending on the keyboard, and without this a
 * vault sealed on one phone would not open on another.
 */
async function deriveKey(passphrase, salt, iterations, normalise = true) {
  const text = normalise ? String(passphrase).normalize('NFKC') : String(passphrase);
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(text), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt a recovery phrase under a passphrase, in the platform's vault format.
 *
 * `addressHrp` is required and has no default, as it has none in the platform: a
 * default would mint mainnet-looking addresses on every other network. The address and
 * public key stored beside the phrase are derived here, from the phrase, so a vault can
 * never describe a key its phrase does not produce.
 *
 * A fresh salt and IV every time, so encrypting the same phrase twice yields different
 * ciphertext — the stored blob cannot be compared against another to tell whether two
 * devices hold the same wallet.
 */
export async function createVault(phrase, passphrase, addressHrp) {
  if (typeof addressHrp !== 'string' || !addressHrp) {
    throw new Error('a vault needs the address prefix of the network it is for');
  }
  if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  const words = String(phrase ?? '').trim();
  const derived = walletFromPhrase(words, addressHrp);
  const payload = {
    phrase: words,
    addressHrp,
    accounts: [
      {
        address: derived.address,
        publicKey: derived.publicKey,
        label: 'Main wallet',
        createdAt: Date.now(),
        account: 0,
        index: 0,
      },
    ],
  };

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return {
    version: 1,
    kdf: KDF,
    iterations: PBKDF2_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ciphertext: toB64(ciphertext),
    address: derived.address,
    addressHrp,
    createdAt: Date.now(),
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
  const salt = fromB64(vault.salt);
  const iv = fromB64(vault.iv);
  const ciphertext = fromB64(vault.ciphertext);
  const decrypt = async (normalise) =>
    new Uint8Array(
      await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        await deriveKey(passphrase, salt, vault.iterations, normalise),
        ciphertext,
      ),
    );

  let plain;
  try {
    plain = await decrypt(true);
  } catch {
    // A vault sealed before passphrases were normalised, opened with a passphrase that
    // normalisation changes. Only worth a second try when it would change anything.
    if (String(passphrase).normalize('NFKC') === String(passphrase)) throw new PassphraseError();
    try {
      plain = await decrypt(false);
    } catch {
      // OperationError from a failed tag check. Not distinguished from other decrypt
      // failures: telling a caller which happened would leak information about the
      // stored blob. What survives is only "wrong passphrase", and that is all a
      // caller needs.
      throw new PassphraseError();
    }
  }

  const text = new TextDecoder().decode(plain);
  if (vault.version === 1) {
    // The platform's format: the phrase is one field of a JSON payload.
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('This vault opened, but its contents are not a wallet this build understands.');
    }
    if (typeof payload?.phrase !== 'string' || !payload.phrase) {
      throw new Error('This vault opened, but it holds no recovery phrase.');
    }
    return payload.phrase;
  }
  // This app's earlier format: the plaintext IS the phrase.
  return text;
}

/** Persist the envelope. It holds no plaintext, so storage is not a leak. */
export function saveVault(vault) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
  // The earlier-format copy is replaced, not orphaned: left behind it would be a second
  // encrypted copy of a phrase the user believes lives in one place.
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function loadVault() {
  try {
    // The shared key first; this app's earlier key only if there is nothing there.
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Remember the address the vault holds.
 *
 * An address is public — it is published on the chain the moment the wallet is
 * used — so caching it is not a disclosure. It is what lets the mining and wallet
 * screens show a balance and an eligibility window without decrypting a recovery
 * phrase first, and it is what lets an operation check the chain before it puts a
 * phrase in memory.
 */
export function saveWalletAddress(address) {
  try {
    localStorage.setItem(ADDRESS_KEY, String(address));
  } catch {
    /* private mode can refuse storage; the address is re-derived on unlock */
  }
}

export function loadWalletAddress() {
  try {
    return localStorage.getItem(ADDRESS_KEY) || null;
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
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(ADDRESS_KEY);
  } catch {
    /* nothing left to remove */
  }
}

export { PBKDF2_ITERATIONS, KDF, STORAGE_KEY, LEGACY_STORAGE_KEY, ADDRESS_KEY, MIN_PASSPHRASE_LENGTH };
