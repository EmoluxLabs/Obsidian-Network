/**
 * Non-custodial wallet, entirely client-side.
 *
 * Guarantees (spec §11, §12, §28):
 *   - Keys are generated with the platform CSPRNG (WebCrypto).
 *   - Keys are never derived from an email address, a Google id, a username, a
 *     date of birth, an account id or anything else guessable.
 *   - The private key, the recovery phrase and the signing function live in the
 *     browser only. Nothing in this module ever posts key material anywhere.
 *   - At rest the vault is stored encrypted with AES-GCM under a key derived
 *     from the user's passphrase with PBKDF2-SHA256 (210,000 iterations).
 */

import { encodeSignedTx, signTransaction, type UnsignedTx } from '../../core/transactions/encode.js';
import { deriveWallet, generateRecoveryPhrase, isValidRecoveryPhrase } from '../../core/crypto/mnemonic.js';
import { addressFromPublicKey } from '../../core/crypto/keys.js';
import { TxType } from '../../core/protocol/types.js';

export interface WalletAccount {
  address: string;
  publicKey: string;
  /** Present only while unlocked, in memory, in this tab. Never persisted raw. */
  privateKey: string;
  label: string;
  createdAt: number;
  /** BIP44 account/address index used to derive this wallet. */
  account: number;
  index: number;
}

export interface VaultFile {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  address: string;
  createdAt: number;
}

const STORAGE_KEY = 'obsidian.vault.v1';
const PBKDF2_ITERATIONS = 210_000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface VaultPayload {
  phrase: string;
  accounts: Array<{ address: string; publicKey: string; label: string; createdAt: number; account: number; index: number }>;
}

export class Wallet {
  private constructor(private readonly payload: VaultPayload) {}

  static async create(passphrase: string, label = 'Main wallet'): Promise<Wallet> {
    if (passphrase.length < 8) throw new Error('use a passphrase of at least 8 characters');
    const phrase = generateRecoveryPhrase();
    const wallet = await Wallet.fromPhrase(phrase, passphrase, label);
    return wallet;
  }

  static async fromPhrase(phrase: string, passphrase: string, label = 'Main wallet'): Promise<Wallet> {
    if (!isValidRecoveryPhrase(phrase)) throw new Error('that recovery phrase is not valid');
    const derived = deriveWallet(phrase, 0, 0);
    const payload: VaultPayload = {
      phrase,
      accounts: [
        {
          address: derived.address,
          publicKey: derived.publicKey,
          label,
          createdAt: Date.now(),
          account: 0,
          index: 0,
        },
      ],
    };
    await persist(payload, passphrase);
    return new Wallet(payload);
  }

  static async unlock(passphrase: string): Promise<Wallet> {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) throw new Error('no wallet exists in this browser');
    const vault = JSON.parse(stored) as VaultFile;
    const key = await deriveVaultKey(passphrase, base64ToBytes(vault.salt), vault.iterations);
    let plaintext: Uint8Array;
    try {
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: base64ToBytes(vault.iv) as unknown as BufferSource },
          key,
          base64ToBytes(vault.ciphertext) as unknown as BufferSource,
        ),
      );
    } catch {
      throw new Error('wrong passphrase (or the vault was modified)');
    }
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as VaultPayload;
    return new Wallet(payload);
  }

  static exists(): boolean {
    return localStorage.getItem(STORAGE_KEY) !== null;
  }

  static storedAddress(): string | undefined {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return undefined;
    try {
      return (JSON.parse(stored) as VaultFile).address;
    } catch {
      return undefined;
    }
  }

  static erase(): void {
    localStorage.removeItem(STORAGE_KEY);
  }

  get address(): string {
    return this.payload.accounts[0]!.address;
  }

  get accounts(): VaultPayload['accounts'] {
    return this.payload.accounts;
  }

  /** The recovery phrase. Only ever returned on an explicit user action. */
  revealPhrase(): string {
    return this.payload.phrase;
  }

  revealPrivateKey(index = 0): string {
    return deriveWallet(this.payload.phrase, this.payload.accounts[index]!.account, this.payload.accounts[index]!.index)
      .privateKey;
  }

  async save(passphrase: string): Promise<void> {
    await persist(this.payload, passphrase);
  }

  addressFor(account: number, index: number): string {
    return deriveWallet(this.payload.phrase, account, index).address;
  }

  /**
   * Sign a transaction locally. The signed bytes are the only thing that ever
   * leaves the browser.
   */
  sign(input: {
    chainId: number;
    protocolVersion: string;
    type: TxType;
    nonce: number;
    gas: bigint;
    body: Uint8Array;
    validUntil: number;
    memo?: string;
    index?: number;
  }): Uint8Array {
    const entry = this.payload.accounts[input.index ?? 0]!;
    const derived = deriveWallet(this.payload.phrase, entry.account, entry.index);
    const unsigned: UnsignedTx = {
      protocolVersion: input.protocolVersion,
      chainId: input.chainId,
      sender: entry.address,
      nonce: input.nonce,
      type: input.type,
      gas: input.gas,
      body: input.body,
      validUntil: input.validUntil,
      memo: input.memo,
    };
    const signed = signTransaction({
      ...unsigned,
      privateKeyHex: derived.privateKey,
      publicKeyHex: derived.publicKey,
    });
    return encodeSignedTx(signed);
  }

  /** Derive an additional address from the same phrase (same wallet, new index). */
  async addAccount(passphrase: string, index: number, label: string): Promise<string> {
    const derived = deriveWallet(this.payload.phrase, 0, index);
    const address = addressFromPublicKey(derived.publicKey, addressHrpOf(this.address));
    this.payload.accounts.push({
      address,
      publicKey: derived.publicKey,
      label,
      createdAt: Date.now(),
      account: 0,
      index,
    });
    await persist(this.payload, passphrase);
    return address;
  }
}

function addressHrpOf(address: string): string {
  const match = /^([a-z]+)1/.exec(address);
  return match?.[1] ?? 'obs';
}

async function persist(payload: VaultPayload, passphrase: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveVaultKey(passphrase, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as unknown as BufferSource },
      key,
      plaintext as unknown as BufferSource,
    ),
  );
  const vault: VaultFile = {
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    address: payload.accounts[0]!.address,
    createdAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(vault));
}

/** Export bundle the user can keep offline: address, private key, phrase. */
export function exportBundle(wallet: Wallet, index = 0): string {
  const account = wallet.accounts[index]!;
  return [
    'OBSIDIAN NETWORK WALLET EXPORT',
    '=============================',
    `Address:        ${account.address}`,
    `Label:          ${account.label}`,
    `Derivation:     m/44'/7777'/${account.account}'/0/${account.index}`,
    '',
    `Private key:    ${wallet.revealPrivateKey(index)}`,
    '',
    'Recovery phrase (24 words):',
    wallet.revealPhrase(),
    '',
    'Keep this file offline. Anyone with the private key or the phrase controls',
    'the wallet and no one — including Obsidian — can reverse a transfer.',
    'Obsidian will never ask you for this file.',
  ].join('\n');
}
