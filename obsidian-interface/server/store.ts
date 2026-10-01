/**
 * Interface account store.
 *
 * This is an ACCESS LIST, not a ledger and not a wallet. It records who may use
 * this deployment of the interface and how many invites they have issued. It
 * holds no key material, no balances and no transaction authority — losing this
 * file costs access invites and nothing else.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { verifyGenesisInvitation, type GenesisInviteRecord } from './genesis-invite.js';

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

export interface Session {
  token: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
}

interface StoreFile {
  version: 1;
  accounts: Account[];
  invites: Invite[];
  sessions: Session[];
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
  private invites = new Map<string, Invite>();
  private sessions = new Map<string, Session>();
  private genesisInvite: GenesisInviteRecord | null = null;
  private readonly sessionTtl: number;

  constructor(private readonly options: StoreOptions) {
    this.path = join(options.dataDir, 'interface-accounts.json');
    this.sessionTtl = options.sessionTtlSeconds ?? 14 * 24 * 3600;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoreFile;
      for (const account of parsed.accounts ?? []) this.accounts.set(account.accountId, account);
      for (const invite of parsed.invites ?? []) this.invites.set(normalise(invite.code), invite);
      for (const session of parsed.sessions ?? []) this.sessions.set(session.token, session);
      this.genesisInvite = parsed.genesisInvite ?? null;
    } catch {
      // A corrupt access list must not brick the interface: start empty and
      // keep the damaged file for the operator to inspect.
      if (existsSync(this.path)) renameSync(this.path, `${this.path}.corrupt-${Date.now()}`);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const file: StoreFile = {
      version: 1,
      accounts: [...this.accounts.values()],
      invites: [...this.invites.values()],
      sessions: [...this.sessions.values()].filter((session) => session.expiresAt > Date.now()),
      genesisInvite: this.genesisInvite,
    };
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, JSON.stringify(file, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
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
    for (const account of this.accounts.values()) {
      if (account.canonicalEmail === canonicalEmail) return account;
    }
    return undefined;
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
    this.persist();
    return account;
  }

  /** Persist mutations made to an account object held by a caller. */
  saveAccount(account: Account): void {
    this.accounts.set(account.accountId, account);
    this.persist();
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
   * Remove an account. Used to roll back a registration whose credential check
   * failed after the account row was created; there is no user-facing route to
   * this, and it deliberately takes no invite or session with it.
   */
  deleteAccount(accountId: string): void {
    if (!this.accounts.delete(accountId)) return;
    for (const [token, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(token);
    }
    this.persist();
  }

  touch(accountId: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.lastSeenAt = Date.now();
    this.persist();
  }

  setWalletAddress(accountId: string, walletAddress: string): void {
    const account = this.accounts.get(accountId);
    if (!account) return;
    account.walletAddress = walletAddress;
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
    const session: Session = {
      token,
      accountId,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.sessionTtl * 1000,
    };
    this.sessions.set(token, session);
    this.pruneSessions();
    this.persist();
    return session;
  }

  getSession(token: string): Session | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this.persist();
      return undefined;
    }
    return session;
  }

  destroySession(token: string): void {
    if (!this.sessions.delete(token)) return;
    this.persist();
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(token);
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
