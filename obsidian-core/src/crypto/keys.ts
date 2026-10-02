/**
 * Obsidian key management and addresses.
 *
 * Cryptographic choices (documented in /docs/cryptography.md):
 *   - Curve:        secp256k1 (the same curve family as Bitcoin/Ethereum, with
 *                   the widest library and hardware-wallet support).
 *   - Signatures:   ECDSA over secp256k1, RFC 6979 deterministic nonces,
 *                   64-byte compact r||s, low-S enforced.
 *   - Address:      bech32("obs", RIPEMD160(SHA256(compressed pubkey))).
 *   - Identifier:   bech32m("obs", payload) for names/parcels/capsules.
 *
 * No primitive here is invented by Obsidian: all are from @noble/curves and
 * @noble/hashes (audited, extensively fuzzed implementations).
 *
 * PRIVATE KEY HANDLING RULE
 * -------------------------
 * Keys are pure data in this module. This module MUST NOT log, serialize to
 * disk outside an explicit encrypted keystore, or transmit private key material
 * over the network. The node's own networking key is the only key Obsidian Core
 * persists, and it is always stored encrypted at rest (see crypto/keystore.ts).
 */

import { secp256k1 } from '@noble/curves/secp256k1';
import { randomBytes } from '@noble/hashes/utils';
import { sha256, ripemd160, toHex, fromHex, bytesEqual, domainHash, utf8 } from './hash.js';
import { encodePayload, decodePayload } from './bech32.js';

export const ADDRESS_HRP = 'obs';
export const ID_HRP = 'obsid';
export const PRIVATE_KEY_BYTES = 32;
export const PUBLIC_KEY_BYTES = 33; // compressed
export const SIGNATURE_BYTES = 64; // compact r||s

export interface KeyPair {
  /** 32-byte secp256k1 private key (hex). NEVER transmit or log. */
  privateKey: string;
  /** 33-byte compressed public key (hex). */
  publicKey: string;
  /** bech32 obs1... address derived from the public key. */
  address: string;
}

/**
 * Derive the canonical Obsidian address for a compressed public key.
 * address = bech32("obs", RIPEMD160(SHA256(pubkey)))
 */
export function addressFromPublicKey(publicKeyHex: string, hrp: string = ADDRESS_HRP): string {
  const pub = fromHex(publicKeyHex);
  if (pub.length !== PUBLIC_KEY_BYTES) {
    throw new Error(`public key must be ${PUBLIC_KEY_BYTES} bytes compressed`);
  }
  if (pub[0] !== 0x02 && pub[0] !== 0x03) throw new Error('public key must be compressed');
  const digest = ripemd160(sha256(pub));
  return encodePayload(hrp, digest);
}

/** True if `address` is a syntactically and checksum-valid obs1 address. */
export function isValidAddress(address: string, hrp: string = ADDRESS_HRP): boolean {
  try {
    const payload = decodePayload(hrp, address);
    return payload.length === 20;
  } catch {
    return false;
  }
}

/** Decode an address to its 20-byte hash160 payload, or throw. */
export function addressPayload(address: string, hrp: string = ADDRESS_HRP): Uint8Array {
  const payload = decodePayload(hrp, address);
  if (payload.length !== 20) throw new Error('address payload must be 20 bytes');
  return payload;
}

/**
 * Generate a cryptographically random secp256k1 key pair.
 *
 * SECURITY: the entropy source is the operating system CSPRNG
 * (node:crypto randomBytes). Wallet keys are NEVER derived from email, Google
 * ID, username, phone number, birth date, account ID, timestamp, or any other
 * predictable application value.
 */
export function generateKeyPair(addressHrp: string = ADDRESS_HRP): KeyPair {
  let privateKeyBytes: Uint8Array;
  do {
    privateKeyBytes = randomBytes(PRIVATE_KEY_BYTES);
  } while (!isValidPrivateKey(privateKeyBytes));
  return keyPairFromPrivateKey(privateKeyBytes, addressHrp);
}

export function keyPairFromPrivateKey(
  privateKey: Uint8Array | string,
  addressHrp: string = ADDRESS_HRP,
): KeyPair {
  const bytes = typeof privateKey === 'string' ? fromHex(privateKey) : privateKey;
  if (!isValidPrivateKey(bytes)) throw new Error('invalid secp256k1 private key');
  const pub = secp256k1.getPublicKey(bytes, true);
  const pubHex = toHex(pub);
  return { privateKey: toHex(bytes), publicKey: pubHex, address: addressFromPublicKey(pubHex, addressHrp) };
}

export function isValidPrivateKey(bytes: Uint8Array): boolean {
  if (bytes.length !== PRIVATE_KEY_BYTES) return false;
  const n = BigInt(`0x${toHex(bytes)}`);
  const order = secp256k1.CURVE.n;
  return n > 0n && n < order;
}

/**
 * Sign a 32-byte digest. Deterministic (RFC 6979) so signatures are
 * reproducible, which makes the network's test suite bit-exact.
 */
export function signDigest(digest: Uint8Array, privateKeyHex: string): Uint8Array {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  const sig = secp256k1.sign(digest, fromHex(privateKeyHex), { lowS: true, prehash: false });
  return sig.toCompactRawBytes();
}

export function verifyDigest(digest: Uint8Array, signature: Uint8Array | string, publicKeyHex: string): boolean {
  try {
    if (digest.length !== 32) return false;
    const sigBytes = typeof signature === 'string' ? fromHex(signature) : signature;
    if (sigBytes.length !== SIGNATURE_BYTES) return false;
    const pub = fromHex(publicKeyHex);
    if (pub.length !== PUBLIC_KEY_BYTES) return false;
    return secp256k1.verify(sigBytes, digest, pub, { lowS: true, prehash: false });
  } catch {
    return false;
  }
}

/** Sign an arbitrary domain-separated message (used by P2P handshakes). */
export function signMessage(domain: string, message: Uint8Array, privateKeyHex: string): string {
  return toHex(signDigest(domainHash(domain, message), privateKeyHex));
}

export function verifyMessage(
  domain: string,
  message: Uint8Array,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  return verifyDigest(domainHash(domain, message), signatureHex, publicKeyHex);
}

/** Derive a deterministic 33-byte node identity public key from a seed. */
export function nodeIdFromPublicKey(publicKeyHex: string): string {
  const digest = sha256(utf8(publicKeyHex));
  return toHex(digest).slice(0, 40);
}

/**
 * Random identifier. Uses WebCrypto when the runtime provides it (browsers and
 * Node >= 19 both expose `globalThis.crypto`), so the same code path serves the
 * node software and the browser wallet.
 */
export function randomId(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  return [
    toHex(randomBytes(4)),
    toHex(randomBytes(2)),
    toHex(randomBytes(2)),
    toHex(randomBytes(2)),
    toHex(randomBytes(6)),
  ].join('-');
}

/** 32 bytes of CSPRNG output as hex — used for nonces, salts, capsule keys. */
export function randomHex(bytes = 32): string {
  return toHex(randomBytes(bytes));
}

export function publicKeysEqual(a: string, b: string): boolean {
  try {
    return bytesEqual(fromHex(a), fromHex(b));
  } catch {
    return false;
  }
}

/**
 * Verify that a signature was produced by the private key controlling
 * `address`. Used before any state change touches an account.
 */
export function verifyAddressSignature(
  address: string,
  digest: Uint8Array,
  signatureHex: string,
  publicKeyHex: string,
  hrp: string = ADDRESS_HRP,
): boolean {
  if (!verifyDigest(digest, signatureHex, publicKeyHex)) return false;
  try {
    return addressFromPublicKey(publicKeyHex, hrp) === address;
  } catch {
    return false;
  }
}
