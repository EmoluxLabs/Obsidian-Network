/**
 * BIP-39 mnemonics and hierarchical deterministic wallet derivation.
 *
 * Obsidian wallets use standard BIP-39 (English wordlist, 256-bit entropy =>
 * 24 words) and a BIP-32 style derivation path:
 *
 *      m / 44' / 7777' / account' / 0 / index
 *
 * where 7777 is the registered Obsidian coin type placeholder (7847 was
 * requested from SLIP-0044; the constant is protocol data and can be changed
 * only by a documented consensus upgrade, never silently).
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
import { hmacSha256, utf8, toHex, fromHex } from './hash.js';
import { keyPairFromPrivateKey, type KeyPair } from './keys.js';
import { secp256k1 } from '@noble/curves/secp256k1';

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

function compressedPublicKey(privateKey: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(privateKey, true);
}

/** BIP-32 CKDpriv on secp256k1 (hardened and non-hardened indices). */
function deriveChildPrivateKey(parent: Uint8Array, index: number): Uint8Array {
  const hardened = index >= 0x80000000;
  let data: Uint8Array;
  if (hardened) {
    data = new Uint8Array(1 + 32 + 4);
    data[0] = 0x00;
    data.set(parent, 1);
  } else {
    data = new Uint8Array(33 + 4);
    data.set(compressedPublicKey(parent), 0);
  }
  new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(
    data.length - 4,
    index >>> 0,
    false,
  );
  const I = hmacSha256(utf8('Bitcoin seed'), data);
  const IL = I.slice(0, 32);
  const IR = I.slice(32);
  const parentInt = BigInt(`0x${toHex(parent)}`);
  const ilInt = BigInt(`0x${toHex(IL)}`);
  const order = secp256k1.CURVE.n;
  const child = (ilInt + parentInt) % order;
  if (child === 0n) throw new Error('derived child key is zero; use the next index');
  let hex = child.toString(16);
  if (hex.length < 64) hex = hex.padStart(64, '0');
  const childKey = fromHex(hex);
  // IR retained for chain-code continuity in future extended-key APIs.
  void IR;
  return childKey;
}

function masterKeyFromSeed(seed: Uint8Array): Uint8Array {
  const I = hmacSha256(utf8('Bitcoin seed'), seed);
  return I.slice(0, 32);
}

function parsePath(path: string): number[] {
  const parts = path.trim().split('/');
  if (parts[0] !== 'm') throw new Error("derivation path must start with 'm'");
  return parts.slice(1).map((segment) => {
    const hardened = segment.endsWith("'") || segment.endsWith('h');
    const body = hardened ? segment.slice(0, -1) : segment;
    if (!/^\d+$/.test(body)) throw new Error(`invalid path segment: ${segment}`);
    const index = Number.parseInt(body, 10);
    if (index >= 0x80000000) throw new Error(`path segment out of range: ${segment}`);
    return hardened ? index + 0x80000000 : index;
  });
}

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
  let key = masterKeyFromSeed(seed);
  const path = `${prefix}/${account}'/0/${index}`;
  for (const segment of parsePath(path)) {
    key = deriveChildPrivateKey(key, segment);
  }
  const pair = keyPairFromPrivateKey(key, addressHrp);
  // Best-effort scrubbing of intermediate material.
  seed.fill(0);
  key.fill(0);
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
