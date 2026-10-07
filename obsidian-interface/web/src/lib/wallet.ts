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
 *     from the user's passphrase with PBKDF2-SHA256 (600,000 iterations).
 *   - **An address is network-specific.** The same 24 words derive the same key
 *     pair everywhere, but the address string is bech32 with a per-network
 *     prefix: `obs1` on mainnet, `tobs1` on testnet, `sobs1` on staging,
 *     `dobs1` on devnet. A vault therefore records the network it was created
 *     for, and the caller must say which network it is deriving for. Minting an
 *     `obs1…` address while connected to devnet produces something no node on
 *     that network will accept — which is what used to happen here.
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
  /**
   * Address prefix this vault's addresses were derived with. Absent in vaults
   * written before 1.2.2; those are read as `obs`, which is what they in fact
   * contained whatever network they were created on.
   */
  addressHrp?: string;
}

/** What an address would look like on another network. Derives nothing new. */
export function previewAddress(publicKeyHex: string, addressHrp: string): string {
  return addressFromPublicKey(publicKeyHex, addressHrp);
}

/** Address prefix of an address string, e.g. `dobs1qqq…` -> `dobs`. */
export function hrpOfAddress(address: string): string {
  const match = /^([a-z]+)1/.exec(address);
  return match?.[1] ?? 'obs';
}

const STORAGE_KEY = 'obsidian.vault.v1';
/**
 * OWASP's 2023 figure for PBKDF2-HMAC-SHA256. It was 210,000. A vault records
 * its own iteration count, so vaults written at the old figure still open and
 * are re-written at the new one the next time they are saved.
 */
const PBKDF2_ITERATIONS = 600_000;
/**
 * A vault passphrase protects a recovery phrase sitting in this browser's
 * storage, where anyone with the disk — or a stray script — can try to guess it
 * offline. Eight characters is within reach of that; twelve with a few words is
 * not. It matches the account password policy.
 */
export const MIN_VAULT_PASSPHRASE_LENGTH = 12;

/** Raised when a vault holds keys that this release's derivation can no longer produce. */
export class LegacyVaultError extends Error {
  constructor(address: string) {
    super(
      `This wallet (${address}) was created by a release before 1.3.0, which derived keys with a non-standard algorithm. ` +
        'Its keys cannot be reproduced from the recovery phrase any more, so it cannot sign anything. ' +
        'No mainnet existed before 1.3.0, so nothing of value can be on it: create a new wallet. ' +
        'Keep the old phrase only if a test network from that era still matters to you.',
    );
    this.name = 'LegacyVaultError';
  }
}

/**
 * Raised when the browser withholds WebCrypto.
 *
 * Browsers only expose `crypto.subtle` to a "secure context": an HTTPS page, or
 * `http://localhost` / `http://127.0.0.1`. Opened at `http://192.168.1.42:38788`
 * (another phone on the same Wi-Fi) the object is simply `undefined`, and the
 * vault code used to die with "Cannot read properties of undefined". Say what is
 * wrong and what to do about it instead.
 */
export class InsecureContextError extends Error {
  constructor() {
    super(
      'This page cannot use the browser’s cryptography at this address, so it cannot create or open a wallet. ' +
        'Browsers allow it only on HTTPS pages and on http://localhost or http://127.0.0.1. ' +
        'Open the interface at http://127.0.0.1 on the device that runs it, or serve it over HTTPS, then reload. Nothing was created.',
    );
    this.name = 'InsecureContextError';
  }
}

/** True when this page may use WebCrypto (HTTPS, or localhost). */
export function webCryptoAvailable(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle !== 'undefined';
}

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

/**
 * NFKC-normalise before encoding. The same typed passphrase can be composed or
 * decomposed Unicode depending on the keyboard and platform ("é" as one code
 * point or as "e" plus an accent); without this a vault made on one phone would
 * not open on another.
 */
function passphraseBytes(passphrase: string, normalise = true): Uint8Array {
  return new TextEncoder().encode(normalise ? passphrase.normalize('NFKC') : passphrase);
}

async function deriveVaultKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  normalise = true,
): Promise<CryptoKey> {
  if (!webCryptoAvailable()) throw new InsecureContextError();
  const material = await crypto.subtle.importKey('raw', passphraseBytes(passphrase, normalise) as unknown as BufferSource, 'PBKDF2', false, [
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
  /** Network prefix every address in this vault was derived with. */
  addressHrp: string;
  accounts: Array<{ address: string; publicKey: string; label: string; createdAt: number; account: number; index: number }>;
}

export class Wallet {
  private constructor(private readonly payload: VaultPayload) {}

  /**
   * Create a wallet for a specific network.
   *
   * `addressHrp` is not optional on purpose: a default would silently mint
   * mainnet-looking addresses on every other network, which is the bug this
   * signature exists to make impossible.
   */
  static async create(addressHrp: string, passphrase: string, label = 'Main wallet'): Promise<Wallet> {
    if (passphrase.length < MIN_VAULT_PASSPHRASE_LENGTH) {
      throw new Error(`use a passphrase of at least ${MIN_VAULT_PASSPHRASE_LENGTH} characters`);
    }
    const phrase = generateRecoveryPhrase();
    const wallet = await Wallet.fromPhrase(phrase, addressHrp, passphrase, label);
    return wallet;
  }

  static async fromPhrase(phrase: string, addressHrp: string, passphrase: string, label = 'Main wallet'): Promise<Wallet> {
    if (!isValidRecoveryPhrase(phrase)) throw new Error('that recovery phrase is not valid');
    if (!/^[a-z]{2,8}$/.test(addressHrp)) throw new Error(`"${addressHrp}" is not a usable address prefix`);
    const derived = deriveWallet(phrase, 0, 0);
    const payload: VaultPayload = {
      phrase,
      addressHrp,
      accounts: [
        {
          address: addressFromPublicKey(derived.publicKey, addressHrp),
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
    const salt = base64ToBytes(vault.salt);
    const iv = base64ToBytes(vault.iv) as unknown as BufferSource;
    const ciphertext = base64ToBytes(vault.ciphertext) as unknown as BufferSource;
    const decrypt = async (normalise: boolean): Promise<Uint8Array> => {
      const key = await deriveVaultKey(passphrase, salt, vault.iterations, normalise);
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
    };
    let plaintext: Uint8Array;
    try {
      plaintext = await decrypt(true);
    } catch {
      try {
        // A vault written before passphrases were normalised, opened with a
        // passphrase that normalisation changes.
        if (passphrase.normalize('NFKC') === passphrase) throw new Error('nothing to retry');
        plaintext = await decrypt(false);
      } catch {
        throw new Error('wrong passphrase (or the vault was modified)');
      }
    }
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as VaultPayload;
    // Vaults written before 1.2.2 carry no network, and every address in them
    // was derived with the mainnet prefix regardless of the network in use.
    if (!payload.addressHrp) payload.addressHrp = hrpOfAddress(payload.accounts[0]?.address ?? 'obs1');
    // `sign()` re-derives the key from the phrase. If that no longer produces
    // the key this vault's address belongs to (it stopped doing so at 1.3.0,
    // when derivation became real BIP-32), every transaction would be stamped
    // with the stored address but signed by a different key and refused with a
    // bare "bad signature". Say so here, once, instead.
    for (const account of payload.accounts) {
      if (deriveWallet(payload.phrase, account.account, account.index).publicKey !== account.publicKey) {
        throw new LegacyVaultError(account.address);
      }
    }
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

  /** Network prefix of the vault in this browser, without unlocking it. */
  static storedHrp(): string | undefined {
    const address = Wallet.storedAddress();
    return address ? hrpOfAddress(address) : undefined;
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

  /** The network prefix this vault's addresses were derived with. */
  get addressHrp(): string {
    return this.payload.addressHrp;
  }

  /** True when this vault's addresses belong to the network being talked to. */
  matchesNetwork(addressHrp: string): boolean {
    return this.payload.addressHrp === addressHrp;
  }

  /**
   * Re-derive every address in this vault for another network.
   *
   * The keys do not change — the same 24 words, the same derivation paths, the
   * same private keys — only the bech32 prefix of the address string. Nothing
   * is lost: a wallet re-derived back again produces the original addresses.
   */
  async switchNetwork(addressHrp: string, passphrase: string): Promise<void> {
    if (!/^[a-z]{2,8}$/.test(addressHrp)) throw new Error(`"${addressHrp}" is not a usable address prefix`);
    this.payload.addressHrp = addressHrp;
    this.payload.accounts = this.payload.accounts.map((account) => ({
      ...account,
      address: addressFromPublicKey(account.publicKey, addressHrp),
    }));
    await persist(this.payload, passphrase);
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
    return addressFromPublicKey(deriveWallet(this.payload.phrase, account, index).publicKey, this.payload.addressHrp);
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
    const address = addressFromPublicKey(derived.publicKey, this.payload.addressHrp);
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
    addressHrp: payload.addressHrp,
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
    `Network prefix: ${wallet.addressHrp} (obs=mainnet, tobs=testnet, sobs=staging, dobs=devnet)`,
    `Label:          ${account.label}`,
    `Derivation:     m/44'/7777'/${account.account}'/0/${account.index}`,
    '',
    `Private key:    ${wallet.revealPrivateKey(index)}`,
    '',
    'Recovery phrase (24 words):',
    wallet.revealPhrase(),
    '',
    'The 24 words are not network-specific: they restore this same key pair on',
    'any Obsidian network. Only the address prefix differs.',
    '',
    'Keep this file offline. Anyone with the private key or the phrase controls',
    'the wallet and no one — including Obsidian — can reverse a transfer.',
    'Obsidian will never ask you for this file.',
  ].join('\n');
}
