/**
 * The wallet: one vault per network, using the node's own key derivation.
 *
 * Keys are derived by obsidian-core's `deriveWallet` (BIP-39 → BIP-32, the same path the
 * platform and the web app use), so the same recovery phrase gives the same account here as
 * anywhere else; only the address prefix differs per network. This service never returns a
 * phrase, private key or passphrase to the interface, with one deliberate exception: at
 * creation the new phrase is shown ONCE so it can be written down, and the vault is only
 * saved after the user proves they wrote it down by typing back three words.
 */
import { randomInt, randomUUID } from 'node:crypto';
import type { NetworkName } from '../shared/chain-types.js';
import type { WalletStatus } from '../shared/wallet-types.js';
import { AppError } from '../shared/errors.js';
import type { CoreModules } from './core-loader.js';
import type { AppPaths } from './paths.js';
import { MIN_PASSPHRASE_LENGTH, PassphraseError, openVaultPhrase, readVaultFile, removeVaultFile, sealVault, writeVaultFile } from './vault.js';

export type { WalletStatus };

export interface UnlockedWallet {
  address: string;
  publicKey: string;
  privateKeyHex: string;
}

interface PendingCreation {
  phrase: string;
  network: NetworkName;
  indexes: number[];
  expires: number;
}

const PENDING_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60_000;

export class WalletService {
  private pending = new Map<string, PendingCreation>();
  private attempts: number[] = [];

  constructor(
    private readonly paths: AppPaths,
    private readonly core: () => Promise<CoreModules>,
  ) {}

  async status(network: NetworkName): Promise<WalletStatus> {
    const core = await this.core();
    const hrp = core.networks.NETWORKS[network].addressHrp;
    let vault = null;
    try {
      vault = readVaultFile(this.paths.forNetwork(network).vault);
    } catch (error) {
      throw new AppError('WALLET_FILE_DAMAGED', (error as Error).message);
    }
    if (!vault) return { network, exists: false, address: null, addressHrp: hrp, createdAt: null };
    if (vault.addressHrp !== hrp) {
      throw new AppError('WALLET_NETWORK_MISMATCH', `The wallet file for ${network} was made for the "${vault.addressHrp}" prefix, not "${hrp}". It was not used.`);
    }
    return { network, exists: true, address: vault.address, addressHrp: hrp, createdAt: vault.createdAt };
  }

  /** Step 1 of creating a wallet: generate a phrase with the core's generator and hold it in memory. */
  async beginCreate(network: NetworkName): Promise<{ pendingId: string; phrase: string; confirmPositions: number[] }> {
    const core = await this.core();
    if ((await this.status(network)).exists) throw new AppError('WALLET_EXISTS', `A ${network} wallet already exists on this computer.`);
    this.sweep();
    const phrase = core.mnemonic.generateRecoveryPhrase();
    const words = phrase.split(' ').length;
    const indexes = new Set<number>();
    while (indexes.size < 3) indexes.add(randomInt(words));
    const positions = [...indexes].sort((a, b) => a - b);
    const pendingId = randomUUID();
    this.pending.set(pendingId, { phrase, network, indexes: positions, expires: Date.now() + PENDING_TTL_MS });
    return { pendingId, phrase, confirmPositions: positions.map((i) => i + 1) };
  }

  /** Step 2: the user proves they wrote the phrase down; only now is a vault written. */
  async finishCreate(input: { pendingId: string; passphrase: string; confirmWords: string[] }): Promise<WalletStatus> {
    this.sweep();
    const entry = this.pending.get(input.pendingId);
    if (!entry) throw new AppError('WALLET_CREATION_EXPIRED', 'This wallet creation expired. Start again to get a new recovery phrase.');
    const words = entry.phrase.split(' ');
    const typed = input.confirmWords.map((w) => String(w).trim().toLowerCase());
    if (typed.length !== entry.indexes.length || entry.indexes.some((wordIndex, i) => words[wordIndex] !== typed[i])) {
      throw new AppError('WALLET_PHRASE_CONFIRMATION_FAILED', 'Those words do not match your recovery phrase. Check what you wrote down and try again.');
    }
    this.checkPassphraseStrength(input.passphrase);
    await this.save(entry.network, entry.phrase, input.passphrase);
    this.pending.delete(input.pendingId);
    return this.status(entry.network);
  }

  cancelCreate(pendingId: string): void {
    this.pending.delete(pendingId);
  }

  async importPhrase(network: NetworkName, phrase: string, passphrase: string): Promise<WalletStatus> {
    const core = await this.core();
    if ((await this.status(network)).exists) throw new AppError('WALLET_EXISTS', `A ${network} wallet already exists on this computer. Remove it first if you want to replace it.`);
    const normalized = core.mnemonic.normalizePhrase(String(phrase ?? '').trim());
    if (!core.mnemonic.isValidRecoveryPhrase(normalized)) throw new AppError('INVALID_PHRASE', 'That recovery phrase is not valid. Check the words and their order.');
    this.checkPassphraseStrength(passphrase);
    await this.save(network, normalized, passphrase);
    return this.status(network);
  }

  private checkPassphraseStrength(passphrase: string): void {
    if (typeof passphrase !== 'string' || passphrase.length < MIN_PASSPHRASE_LENGTH) {
      throw new AppError('WEAK_PASSPHRASE', `Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`);
    }
  }

  private async save(network: NetworkName, phrase: string, passphrase: string): Promise<void> {
    const core = await this.core();
    const hrp = core.networks.NETWORKS[network].addressHrp;
    const vault = await sealVault(core, phrase, passphrase, hrp);
    // Prove the file opens before it is the only copy: read it back with the passphrase.
    const reopened = await openVaultPhrase(vault, passphrase);
    if (reopened !== core.mnemonic.normalizePhrase(phrase)) throw new AppError('VAULT_SELF_CHECK_FAILED', 'The wallet file did not read back correctly, so it was not saved.');
    writeVaultFile(this.paths.forNetwork(network).vault, vault);
  }

  /**
   * Open the vault, derive the key, hand it to `fn`, and let it go. The phrase and key exist
   * only for the duration of `fn`. Wrong passphrases are rate limited.
   */
  async withWallet<T>(network: NetworkName, passphrase: string, fn: (wallet: UnlockedWallet) => Promise<T>): Promise<T> {
    const core = await this.core();
    const hrp = core.networks.NETWORKS[network].addressHrp;
    const vault = readVaultFile(this.paths.forNetwork(network).vault);
    if (!vault) throw new AppError('NO_WALLET', `There is no ${network} wallet on this computer yet.`);
    this.throttle();
    let phrase: string;
    try {
      phrase = await openVaultPhrase(vault, passphrase);
    } catch (error) {
      if (error instanceof PassphraseError) {
        this.attempts.push(Date.now());
        throw new AppError('WRONG_PASSPHRASE', 'That passphrase is not correct.');
      }
      throw new AppError('VAULT_UNREADABLE', (error as Error).message);
    }
    this.attempts = [];
    const derived = core.mnemonic.deriveWallet(phrase, 0, 0, undefined, hrp);
    const address = derived.address ?? core.keys.addressFromPublicKey(derived.publicKey, hrp);
    phrase = '';
    if (address !== vault.address) {
      throw new AppError('WALLET_ADDRESS_MISMATCH', 'The wallet file describes a different address than its key produces. Nothing was signed.');
    }
    return fn({ address, publicKey: derived.publicKey, privateKeyHex: derived.privateKey });
  }

  /** Delete the local vault. The wallet itself survives wherever the phrase was written down. */
  async remove(network: NetworkName, passphrase: string): Promise<void> {
    // Proving the passphrase first stops a stray click from destroying the only copy.
    await this.withWallet(network, passphrase, async () => undefined);
    removeVaultFile(this.paths.forNetwork(network).vault);
  }

  private throttle(): void {
    const now = Date.now();
    this.attempts = this.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
    if (this.attempts.length >= MAX_ATTEMPTS) {
      throw new AppError('TOO_MANY_ATTEMPTS', 'Too many wrong passphrases. Wait a minute and try again.');
    }
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.pending) if (entry.expires < now) this.pending.delete(id);
  }
}
