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
import { readFileSync, existsSync, chmodSync } from 'node:fs';
import { atomicWriteFile } from '../storage/atomic.js';
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
    // Atomic (temp file, fsync, rename) and created 0600: a crash in the middle
    // of the first write must not leave a truncated identity file behind.
    atomicWriteFile(path, `${JSON.stringify(file, null, 2)}\n`);
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
    let plaintext: Uint8Array;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, fromHex(file.iv));
      decipher.setAuthTag(fromHex(file.tag));
      plaintext = concatBytes(
        new Uint8Array(decipher.update(fromHex(file.ciphertext))),
        new Uint8Array(decipher.final()),
      );
    } catch {
      throw new Error(
        `could not decrypt the node keystore at ${path}: the passphrase is wrong, or the file is damaged. ` +
          'Check OBSIDIAN_KEYSTORE_PASSPHRASE (or OBSIDIAN_KEYSTORE_PASSPHRASE_FILE) is the one used when the keystore was created.',
      );
    } finally {
      key.fill(0);
    }
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
  // Service managers (systemd, container entrypoints) often prefer a file over
  // an environment variable: /proc/<pid>/environ is readable by the same user,
  // so a root-owned 0600 file is strictly better than an exported secret.
  const file = process.env.OBSIDIAN_KEYSTORE_PASSPHRASE_FILE;
  const value =
    process.env.OBSIDIAN_KEYSTORE_PASSPHRASE ??
    (file && existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined);
  if (!value || value.length < 12) {
    throw new Error(
      'OBSIDIAN_KEYSTORE_PASSPHRASE (or OBSIDIAN_KEYSTORE_PASSPHRASE_FILE pointing at a ' +
        'root-owned 0600 file) must provide a passphrase of at least 12 characters. ' +
        'Never commit the passphrase to the repository.',
    );
  }
  return value;
}

/**
 * Ask a person for the keystore passphrase on their own terminal, without echoing it.
 *
 * Returns undefined when there is no terminal to ask (a service, a container, a pipe): nothing is ever guessed,
 * generated or kept in a file. The prompt writes to stderr so a passphrase can never end up in captured stdout, and the
 * typed characters are never logged. Only a real TTY is ever prompted.
 */
export async function promptKeystorePassphrase(question: string): Promise<string | undefined> {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== 'function') return undefined;
  process.stderr.write(question);
  return new Promise<string | undefined>((resolvePrompt) => {
    let typed = '';
    const wasRaw = input.isRaw;
    const finish = (value: string | undefined) => {
      input.setRawMode(wasRaw);
      input.pause();
      input.off('data', onData);
      process.stderr.write('\n');
      resolvePrompt(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n' || character === '\u0004') return finish(typed);
        if (character === '\u0003') return finish(undefined); // Ctrl-C: give up, never continue with half a passphrase
        if (character === '\u007f' || character === '\b') typed = typed.slice(0, -1);
        else typed += character;
      }
      return undefined;
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}

/**
 * The passphrase for the node key: the environment (or a file the environment names), else a prompt on a real
 * terminal. There is no other source. In particular nothing is generated and nothing is written beside the keystore,
 * on any network: a passphrase kept next to the key it protects protects nothing.
 */
export async function resolveKeystorePassphrase(options: { creating: boolean }): Promise<string> {
  try {
    return keystorePassphraseFromEnv();
  } catch (error) {
    const first = await promptKeystorePassphrase(
      options.creating ? 'Choose a passphrase for the new node key (12+ characters): ' : 'Passphrase for the node key: ',
    );
    if (first === undefined) {
      throw new Error(
        `${(error as Error).message} No terminal is attached to ask on, and the node never generates a passphrase or stores one beside the keystore.`,
      );
    }
    if (first.length < 12) throw new Error('the passphrase must be at least 12 characters.');
    if (options.creating) {
      const again = await promptKeystorePassphrase('Type it again to confirm: ');
      if (again !== first) throw new Error('the two passphrases did not match; nothing was created.');
    }
    return first;
  }
}
