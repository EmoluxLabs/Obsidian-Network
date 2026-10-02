/**
 * BIP-39 mnemonics and hierarchical deterministic wallet derivation.
 *
 * Obsidian wallets use standard BIP-39 (English wordlist, 256-bit entropy =>
 * 24 words) and a standard BIP-32 / BIP-44 derivation path:
 *
 *      m / 44' / 7777' / account' / 0 / index
 *
 * where 7777 is the registered Obsidian coin type placeholder (7847 was
 * requested from SLIP-0044; the constant is protocol data and can be changed
 * only by a documented consensus upgrade, never silently).
 *
 * "Standard" is load-bearing: the words a user writes down must restore the
 * same keys in any BIP-32 wallet, because that is what the exported recovery
 * sheet promises them. Derivation therefore goes through @scure/bip32 and is
 * pinned by the official BIP-32 test vectors in the unit tests.
 *
 * Guarantees enforced here:
 *   - Entropy comes exclusively from the OS CSPRNG.
 *   - No application identifier (email, Google sub, username, account id,
 *     timestamp) ever participates in key derivation.
 *   - The phrase is never serialized by the node except into an encrypted
 *     keystore the user explicitly creates.
 */

import { generateMnemonic as bip39Generate, validateMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { HDKey } from '@scure/bip32';
import { keyPairFromPrivateKey, type KeyPair } from './keys.js';

export const OBSIDIAN_COIN_TYPE = 7777;
export const DEFAULT_DERIVATION_PREFIX = `m/44'/${OBSIDIAN_COIN_TYPE}'`;

/**
 * Generate a 24-word recovery phrase from CSPRNG entropy.
 * 256 bits of entropy is the strongest BIP-39 offers.
 */
export function generateRecoveryPhrase(): string {
  return bip39Generate(wordlist, 256);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  const normalized = normalizePhrase(phrase);
  return validateMnemonic(normalized, wordlist);
}

export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * BIP-32 derivation is delegated to @scure/bip32 — the reference
 * implementation from the same authors as the @noble primitives this package
 * already depends on.
 *
 * It is NOT hand-rolled here, and must not be again. The previous version
 * HMAC'd with the literal string "Bitcoin seed" at every level instead of the
 * parent chain code, and used HMAC-SHA256 where BIP-32 specifies HMAC-SHA512 —
 * so `I` was 32 bytes and the chain code (`I.slice(32)`) was an empty array
 * that got discarded outright. Two consequences, both severe:
 *
 *   - The keys were not BIP-32 keys. A user's 24 words restored nothing in any
 *     standard wallet, despite the export file printing a BIP-44 path at them.
 *   - Substituting a public constant for the secret chain code collapses the
 *     hardened/non-hardened boundary: the per-index offset becomes publicly
 *     computable, so sibling keys stop being independent.
 *
 * The BIP-32 test vectors in tests/unit/crypto-and-amounts.test.ts exist to
 * keep both of those from coming back.
 */

export interface DerivedWallet extends KeyPair {
  derivationPath: string;
  account: number;
  index: number;
}

/**
 * Derive a wallet from a recovery phrase.
 * Default path m/44'/7777'/account'/0/index keeps one phrase able to control
 * many independent wallets (useful for ONS identity separation).
 */
export function deriveWallet(
  phrase: string,
  account = 0,
  index = 0,
  prefix = DEFAULT_DERIVATION_PREFIX,
  addressHrp?: string,
): DerivedWallet {
  const normalized = normalizePhrase(phrase);
  if (!validateMnemonic(normalized, wordlist)) throw new Error('invalid recovery phrase');
  const seed = mnemonicToSeedSync(normalized);
  const path = `${prefix}/${account}'/0/${index}`;
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) throw new Error(`derivation path ${path} produced no private key`);
  const pair = keyPairFromPrivateKey(node.privateKey, addressHrp);
  // Best-effort scrubbing of intermediate material.
  node.wipePrivateData();
  seed.fill(0);
  return { ...pair, derivationPath: path, account, index };
}

/** Derive many addresses from one phrase (account discovery in the UI). */
export function deriveWalletRange(
  phrase: string,
  count: number,
  account = 0,
  addressHrp?: string,
): DerivedWallet[] {
  const out: DerivedWallet[] = [];
  for (let i = 0; i < count; i += 1) out.push(deriveWallet(phrase, account, i, undefined, addressHrp));
  return out;
}
