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

export interface Account {
  accountId: string;
  subject: string;
  email: string;
  displayName?: string;
  createdAt: number;
  lastSeenAt: number;
  invitesIssued: number;
  /** Wallet address the account says it owns. Advisory only; never trusted. */
  walletAddress?: string;
  suspended?: boolean;
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
}

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

  createAccount(profile: { subject: string; email: string; displayName?: string }): Account {
    const account: Account = {
      accountId: randomAccountId(),
      subject: profile.subject,
      email: profile.email,
      displayName: profile.displayName,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      invitesIssued: 0,
    };
    this.accounts.set(account.accountId, account);
    this.persist();
    return account;
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
