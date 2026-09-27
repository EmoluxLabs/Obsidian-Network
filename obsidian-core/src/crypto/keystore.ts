/**
 * Encrypted-at-rest keystore for the node identity key.
 *
 * Format: AES-256-GCM with a key derived by scrypt (N=2^17, r=8, p=1) from an
 * operator-supplied passphrase read from the OBSIDIAN_KEYSTORE_PASSPHRASE
 * environment variable. This is the ONLY secret Obsidian Core persists, and it
 * is the node's p2p identity key — never a user wallet key.
 *
 * The node never persists user wallet private keys. Users hold their own keys
 * client-side (see /docs/wallets.md and the Obsidian Interface wallet module).
 */

import { scryptSync, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { keyPairFromPrivateKey, generateKeyPair, type KeyPair } from './keys.js';
import { toHex, fromHex, sha256, utf8, concatBytes } from './hash.js';

export interface KeystoreFile {
  version: 1;
  kdf: 'scrypt';
  kdfParams: { N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  ciphertext: string;
  tag: string;
  /** SHA-256 of the node public key: integrity check without decrypting. */
  publicKeyHash: string;
  publicKey: string;
  createdAt: string;
}

const SCRYPT_N = 1 << 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

/**
 * scrypt key derivation. maxmem must be set explicitly: the default OpenSSL
 * limit (32 MiB) is below what N=2^17, r=8 requires (128*N*r = 128 MiB).
 */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

function deriveKey(passphrase: string, salt: Uint8Array): Uint8Array {
  return scryptSync(passphrase, salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  }) as Uint8Array;
}

/** AES-256-GCM with scrypt key derivation. No bespoke cryptography. */
export class Keystore {
  /** Create a fresh node identity keystore at `path`. */
  static create(path: string, passphrase: string): KeyPair {
    const pair = generateKeyPair();
    Keystore.write(path, pair.privateKey, passphrase);
    return pair;
  }

  static write(path: string, privateKeyHex: string, passphrase: string): void {
    const pair = keyPairFromPrivateKey(privateKeyHex);
    const salt = randomBytes(32);
    const iv = randomBytes(12);
    const key = deriveKey(passphrase, salt);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = concatBytes(
      new Uint8Array(cipher.update(fromHex(privateKeyHex))),
      new Uint8Array(cipher.final()),
    );
    const tag = cipher.getAuthTag();
    const file: KeystoreFile = {
      version: 1,
      kdf: 'scrypt',
      kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: toHex(salt) },
      cipher: 'aes-256-gcm',
      iv: toHex(iv),
      ciphertext: toHex(ciphertext),
      tag: toHex(new Uint8Array(tag)),
      publicKeyHash: toHex(sha256(utf8(pair.publicKey))),
      publicKey: pair.publicKey,
      createdAt: new Date().toISOString(),
    };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort on platforms without POSIX modes */
    }
    key.fill(0);
  }

  static read(path: string, passphrase: string): KeyPair {
    if (!existsSync(path)) throw new Error(`keystore not found: ${path}`);
    const file = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFile;
    if (file.version !== 1 || file.cipher !== 'aes-256-gcm') {
      throw new Error('unsupported keystore format');
    }
    const salt = fromHex(file.kdfParams.salt);
    const key = deriveKey(passphrase, salt);
    const decipher = createDecipheriv('aes-256-gcm', key, fromHex(file.iv));
    decipher.setAuthTag(fromHex(file.tag));
    const plaintext = concatBytes(
      new Uint8Array(decipher.update(fromHex(file.ciphertext))),
      new Uint8Array(decipher.final()),
    );
    key.fill(0);
    const pair = keyPairFromPrivateKey(plaintext);
    plaintext.fill(0);
    const expected = fromHex(file.publicKeyHash);
    if (!timingSafeEqual(sha256(utf8(pair.publicKey)), expected)) {
      throw new Error('keystore integrity check failed (public key mismatch)');
    }
    return pair;
  }

  static exists(path: string): boolean {
    return existsSync(path);
  }
}

/** Resolve the keystore passphrase from the environment without ever logging it. */
export function keystorePassphraseFromEnv(): string {
  const value = process.env.OBSIDIAN_KEYSTORE_PASSPHRASE;
  if (!value || value.length < 12) {
    throw new Error(
      'OBSIDIAN_KEYSTORE_PASSPHRASE must be set to at least 12 characters. ' +
        'Export it in the node service environment; never commit it to disk.',
    );
  }
  return value;
}
