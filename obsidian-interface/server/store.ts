/**
 * Interface account store.
 *
 * This is an ACCESS LIST, not a ledger and not a wallet. It records who may use
 * this deployment of the interface and how many invites they have issued. It
 * holds no key material, no balances and no transaction authority — losing this
 * file costs access invites and nothing else.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { verifyGenesisInvitation, verifyGenesisInvitationAsync, type GenesisInviteRecord } from './genesis-invite.js';

export interface Account {
  accountId: string;
  subject: string;
  /** What the user typed, lowercased. Display only. */
  email: string;
  /**
   * Gmail uniqueness key: dots and +tags stripped. This — not `email` — is what
   * enforces one mining account per human. Computed server-side, always.
   */
  canonicalEmail: string;
  displayName?: string;
  createdAt: number;
  lastSeenAt: number;
  invitesIssued: number;
  /** Wallet address the account says it owns. Advisory only; never trusted. */
  walletAddress?: string;
  suspended?: boolean;

  /** scrypt hash of the password. The password itself is never stored. */
  passwordHash?: string;
  /** Hashes of the unused recovery codes. Plaintext exists only once, at issue. */
  recoveryCodeHashes?: string[];
  recoveryCodesIssuedAt?: number;
  recoveryCodesRemaining?: number;

  /** TOTP secret, set when MFA is being enrolled, confirmed once verified. */
  totpSecret?: string;
  mfaEnabled?: boolean;
  /** Last accepted TOTP step, so one code cannot be replayed inside its window. */
  totpLastStep?: number;

  /**
   * Mining is open only once enrolment is finished: password set, recovery
   * codes acknowledged and MFA confirmed.
   */
  miningEnabled?: boolean;
  failedLogins?: number;
  lockedUntil?: number;
}

export interface Invite {
  code: string;
  createdBy: string;
  createdAt: number;
  acceptedBy?: string;
  acceptedAt?: number;
}

/**
 * A signed-in browser. The cookie holds the token; the store holds only its
 * SHA-256. A stolen backup or a read of the file therefore yields hashes that
 * cannot be turned back into working cookies (the token is 256 random bits, so
 * a fast hash is enough here).
 */
export interface Session {
  tokenHash: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

const STORE_VERSION = 2;

function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Temp file, fsync, rename, fsync the directory: either the old file or the new one, never a hole. */
function writeFileDurable(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
  try {
    const directory = openSync(dirname(path), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    /* directory fsync is not supported everywhere; the rename is still atomic */
  }
}

interface StoreFile {
  version: typeof STORE_VERSION | 1;
  accounts: Account[];
  invites: Invite[];
  /** Version 1 files hold raw tokens in `token`; version 2 holds `tokenHash`. */
  sessions: Array<Partial<Session> & { token?: string }>;
  /** The single Genesis Invitation, stored as a hash. Never plaintext. */
  genesisInvite?: GenesisInviteRecord | null;
}

/** Outcome of attempting to redeem the Genesis Invitation. */
export type GenesisRedemption =
  | { ok: true }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'ALREADY_USED' | 'INVALID' };

export interface StoreOptions {
  dataDir: string;
  /** How long a session stays valid. Default 14 days. */
  sessionTtlSeconds?: number;
}

export class AccountStore {
  private readonly path: string;
  private accounts = new Map<string, Account>();
  /** canonical Gmail -> accountId: the single place one-account-per-human is decided. */
  private byCanonicalEmail = new Map<string, string>();
  private invites = new Map<string, Invite>();
  /** Keyed by the token's SHA-256, never the token. */
  private sessions = new Map<string, Session>();
  private genesisInvite: GenesisInviteRecord | null = null;
  private readonly sessionTtl: number;
  private flushTimer?: NodeJS.Timeout;
  private dirty = false;

  constructor(options: StoreOptions) {
    this.path = join(options.dataDir, 'interface-accounts.json');
    this.sessionTtl = options.sessionTtlSeconds ?? 14 * 24 * 3600;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile;
      for (const account of parsed.accounts ?? []) {
        this.accounts.set(account.accountId, account);
        if (account.canonicalEmail) this.byCanonicalEmail.set(account.canonicalEmail, account.accountId);
      }
      for (const invite of parsed.invites ?? []) this.invites.set(normalise(invite.code), invite);
      for (const stored of parsed.sessions ?? []) {
        // A version-1 file kept the raw token; it is hashed here and the file is
        // rewritten (hashed) on the next save.
        const tokenHash = stored.tokenHash ?? (stored.token ? tokenDigest(stored.token) : undefined);
        if (!tokenHash || !stored.accountId) continue;
        this.sessions.set(tokenHash, {
          tokenHash,
          accountId: stored.accountId,
          createdAt: stored.createdAt ?? 0,
          expiresAt: stored.expiresAt ?? 0,
        });
      }
      this.genesisInvite = parsed.genesisInvite ?? null;
      if (parsed.version === 1 && this.accounts.size > 0) this.persist();
    } catch {
      // A corrupt access list must not brick the interface: start empty and
      // keep the damaged file for the operator to inspect.
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
    }
  }

  /**
   * Write everything now, durably. Used for every change that must not be lost
   * if the machine loses power a moment later: an account, a password, MFA, a
   * spent recovery code, an invite, and above all the Genesis Invitation's
   * "redeemed" flag — a store that came back without it would let the spent
   * code bootstrap a second first account.
   */
  private persist(): void {
    const file: StoreFile = {
      version: STORE_VERSION,
      accounts: [...this.accounts.values()],
      invites: [...this.invites.values()],
      sessions: [...this.sessions.values()].filter((session) => session.expiresAt > Date.now()),
      genesisInvite: this.genesisInvite,
    };
    writeFileDurable(this.path, JSON.stringify(file, null, 2));
    this.dirty = false;
  }

  /**
   * Write soon, not now. Sessions, last-seen times and failed-login counters
   * change on every request; rewriting the whole file and syncing it for each
   * one blocked the process and scaled with the number of accounts. Losing a
   * few seconds of them in a crash costs a re-login, not an account.
   */
  private persistSoon(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.dirty) this.persist();
    }, 2_000);
    this.flushTimer.unref?.();
  }

  /** Write any deferred changes. Called on shutdown. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.dirty) this.persist();
  }

  get accountCount(): number {
    return this.accounts.size;
  }

  get inviteCount(): number {
    return this.invites.size;
  }

  findAccountBySubject(subject: string): Account | undefined {
    for (const account of this.accounts.values()) if (account.subject === subject) return account;
    return undefined;
  }

  findAccountByEmail(email: string): Account | undefined {
    for (const account of this.accounts.values()) if (account.email === email) return account;
    return undefined;
  }

  getAccount(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  /**
   * Look an account up by its canonical Gmail key.
   *
   * Callers must pass an already-canonicalised address: canonicalisation is a
   * server concern (see identity.ts) and this index is the single place
   * uniqueness is decided.
   */
  findByCanonicalEmail(canonicalEmail: string): Account | undefined {
    const accountId = this.byCanonicalEmail.get(canonicalEmail);
    return accountId ? this.accounts.get(accountId) : undefined;
  }

  createAccount(profile: {
    subject: string;
    email: string;
    canonicalEmail: string;
    displayName?: string;
    passwordHash?: string;
    recoveryCodeHashes?: string[];
  }): Account {
    // Last line of defence against a duplicate mining identity. The HTTP layer
    // checks too, but this one is what makes a race impossible: the check and
    // the insert happen with no await between them.
    const clash = this.findByCanonicalEmail(profile.canonicalEmail);
    if (clash) {
      const error = new Error('an account already exists for that Gmail address');
      (error as Error & { code?: string }).code = 'ERR_EMAIL_IN_USE';
      throw error;
    }
    const account: Account = {
      accountId: randomAccountId(),
      subject: profile.subject,
      email: profile.email,
      canonicalEmail: profile.canonicalEmail,
      displayName: profile.displayName,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      invitesIssued: 0,
      passwordHash: profile.passwordHash,
      recoveryCodeHashes: profile.recoveryCodeHashes ?? [],
      recoveryCodesIssuedAt: profile.recoveryCodeHashes ? Date.now() : undefined,
      recoveryCodesRemaining: profile.recoveryCodeHashes?.length ?? 0,
      mfaEnabled: false,
      miningEnabled: false,
    };
    this.accounts.set(account.accountId, account);
    this.byCanonicalEmail.set(account.canonicalEmail, account.accountId);
    this.persist();
    return account;
  }

  /**
   * Persist mutations made to an account object held by a caller. `critical`
   * (the default) writes durably before returning; a failed-login counter, for
   * one, need not.
   */
  saveAccount(account: Account, options: { critical?: boolean } = {}): void {
    this.accounts.set(account.accountId, account);
    if (options.critical === false) this.persistSoon();
    else this.persist();
  }

  /**
   * Spend a recovery code.
   *
   * Synchronous by design: the match and the removal happen with no await
   * between them, so two simultaneous attempts cannot both consume the same
   * code. Returns false for an unknown or already-spent code without saying
   * which.
   */
  consumeRecoveryCode(accountId: string, verify: (hash: string) => boolean): boolean {
    const account = this.accounts.get(accountId);
    if (!account || !account.recoveryCodeHashes || account.recoveryCodeHashes.length === 0) return false;
    const index = account.recoveryCodeHashes.findIndex((hash) => verify(hash));
    if (index < 0) return false;
    account.recoveryCodeHashes.splice(index, 1);
    account.recoveryCodesRemaining = account.recoveryCodeHashes.length;
    this.persist();
    return true;
  }

  /**
   * Spend a recovery code the caller has ALREADY verified (off the event loop,
   * because verifying one costs ~70 ms of scrypt). The removal is synchronous
   * and checks the hash is still there, so two simultaneous requests that both
   * verified the same code cannot both spend it: the second finds it gone.
   */
  consumeRecoveryHash(accountId: string, hash: string): boolean {
    const account = this.accounts.get(accountId);
    const index = account?.recoveryCodeHashes?.indexOf(hash) ?? -1;
    if (!account || !account.recoveryCodeHashes || index < 0) return false;
    account.recoveryCodeHashes.splice(index, 1);
    account.recoveryCodesRemaining = account.recoveryCodeHashes.length;
    this.persist();
    return true;
  }

  /**
   * Remove an account. Used to roll back a registration whose credential check
   * failed after the account row was created; there is no user-facing route to
   * this, and it deliberately takes no invite or session with it.
   */
  deleteAccount(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.accounts.delete(accountId);
    if (this.byCanonicalEmail.get(account.canonicalEmail) === accountId) this.byCanonicalEmail.delete(account.canonicalEmail);
    for (const [key, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(key);
    }
    this.persist();
  }

  touch(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.lastSeenAt = Date.now();
    this.persistSoon();
  }

  setWalletAddress(accountId: string, walletAddress: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.walletAddress = walletAddress;
    // Rare and visible to the user ("linked: true"): written before we answer.
    this.persist();
  }

  setSuspended(accountId: string, suspended: boolean): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.suspended = suspended;
    this.persist();
  }

  // ── Invites ───────────────────────────────────────────────────────────────

  createInvite(createdBy: string, code: string): Invite {
    const invite: Invite = { code: normalise(code), createdBy, createdAt: Date.now() };
    this.invites.set(invite.code, invite);
    this.persist();
    return invite;
  }

  findByCode(code: string): Invite | undefined {
    return this.invites.get(normalise(code));
  }

  markInviteAccepted(code: string, accountId: string): void {
    const invite = this.invites.get(normalise(code));
    if (!invite) return;
    invite.acceptedBy = accountId;
    invite.acceptedAt = Date.now();
    this.persist();
  }

  countIssued(accountId: string): number {
    let count = 0;
    for (const invite of this.invites.values()) if (invite.createdBy === accountId) count += 1;
    return count;
  }

  listInvites(createdBy: string): Invite[] {
    return [...this.invites.values()]
      .filter((invite) => invite.createdBy === createdBy)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  incrementInvitesIssued(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.invitesIssued += 1;
    this.persist();
  }

  // ── The Genesis Invitation ────────────────────────────────────────────────
  //
  // Separate from the ordinary invite system above in every respect: a
  // different store field, a different code format, a different verification
  // path, and a hash instead of a plaintext code. Redeeming one has no effect
  // on the other.

  /**
   * Install the Genesis Invitation hash. Called once at startup from the
   * configured hash. If an invitation is already recorded, this is a no-op
   * unless the hash actually differs — and a *redeemed* invitation is never
   * replaced, because that would resurrect a spent single-use credential.
   */
  configureGenesisInvite(hash: string): void {
    if (!hash) return;
    if (this.genesisInvite?.redeemedBy) return;
    if (this.genesisInvite?.hash === hash) return;
    this.genesisInvite = { hash, createdAt: Date.now() };
    this.persist();
  }

  /** Status for operators. Deliberately exposes no part of the secret. */
  genesisInviteStatus(): { configured: boolean; redeemed: boolean; redeemedAt?: number; failedAttempts: number } {
    return {
      configured: this.genesisInvite !== null,
      redeemed: Boolean(this.genesisInvite?.redeemedBy),
      redeemedAt: this.genesisInvite?.redeemedAt,
      failedAttempts: this.genesisInvite?.failedAttempts ?? 0,
    };
  }

  /**
   * Check a candidate against the Genesis Invitation WITHOUT spending it, on the
   * thread pool. Registration calls this before hashing a password so that a
   * wrong code costs the visitor's request one hash instead of twelve. It
   * changes nothing but the failed-attempt counter; the actual redemption stays
   * the synchronous, atomic step below.
   */
  async precheckGenesisInvite(candidate: string): Promise<'OK' | 'NOT_CONFIGURED' | 'ALREADY_USED' | 'INVALID'> {
    const record = this.genesisInvite;
    if (!record) return 'NOT_CONFIGURED';
    if (record.redeemedBy) return 'ALREADY_USED';
    if (!(await verifyGenesisInvitationAsync(candidate, record.hash))) {
      record.failedAttempts = (record.failedAttempts ?? 0) + 1;
      this.persistSoon();
      return 'INVALID';
    }
    return 'OK';
  }

  /**
   * Redeem the Genesis Invitation, atomically.
   *
   * ATOMICITY: everything between reading `redeemedBy` and writing it happens
   * in this one synchronous function. There is no `await` inside it, so the
   * Node event loop cannot interleave a second request between the check and
   * the write. Two simultaneous registrations therefore serialise, and the
   * second one observes `redeemedBy` already set and is rejected. The scrypt
   * verification is deliberately the *synchronous* variant for this reason —
   * an async hash would open exactly the race this must not have.
   */
  redeemGenesisInvite(candidate: string, accountId: string): GenesisRedemption {
    const record = this.genesisInvite;
    if (!record) return { ok: false, reason: 'NOT_CONFIGURED' };
    // Check the spent flag BEFORE doing any work, so a replay of a valid code
    // is refused on the same path as a wrong code.
    if (record.redeemedBy) return { ok: false, reason: 'ALREADY_USED' };

    if (!verifyGenesisInvitation(candidate, record.hash)) {
      record.failedAttempts = (record.failedAttempts ?? 0) + 1;
      this.persist();
      return { ok: false, reason: 'INVALID' };
    }

    // One-way transition. Written to disk before the caller can act on it.
    record.redeemedBy = accountId;
    record.redeemedAt = Date.now();
    this.persist();
    return { ok: true };
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  createSession(accountId: string, token: string): Session {
    const tokenHash = tokenDigest(token);
    const session: Session = {
      tokenHash,
      accountId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtl * 1000,
    };
    this.sessions.set(tokenHash, session);
    this.pruneSessions();
    this.persistSoon();
    return session;
  }

  getSession(token: string): Session | undefined {
    const key = tokenDigest(token);
    const session = this.sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      this.persistSoon();
      return undefined;
    }
    return session;
  }

  destroySession(token: string): void {
    if (!this.sessions.delete(tokenDigest(token))) return;
    this.persistSoon();
  }

  /**
   * Sign an account out everywhere. A password reset that leaves the old
   * sessions alive protects nothing: whoever stole the old session stays in.
   * `keep` is the session that should survive (the one just issued).
   */
  destroyAccountSessions(accountId: string, keep?: string): number {
    const keepHash = keep ? tokenDigest(keep) : undefined;
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (session.accountId === accountId && key !== keepHash) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.persist();
    return removed;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(key);
  }
}

function normalise(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function randomAccountId(): string {
  return `acc_${randomHex(12)}`;
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}
