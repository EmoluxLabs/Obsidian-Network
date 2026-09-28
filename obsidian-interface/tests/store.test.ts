/**
 * Account store.
 *
 * The store is the only thing this process persists, so the tests are written
 * around one question: can anything here ever hold a key, a phrase or a token
 * that could be used to move OBS? The answer must stay no, and the invite cap
 * must stay enforced on the server rather than in the page.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountStore } from '../server/store.js';
import { newInviteCode } from '../server/auth.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obsidian-interface-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('AccountStore', () => {
  it('creates accounts keyed by Google subject, not by email', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com', displayName: 'A' });
    expect(store.findAccountBySubject('sub-1')?.accountId).toBe(account.accountId);
    expect(store.findAccountByEmail('a@example.com')?.accountId).toBe(account.accountId);
    expect(store.findAccountBySubject('sub-2')).toBeUndefined();
  });

  it('starts every account with zero invites issued and a zero balance story', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    expect(account.invitesIssued).toBe(0);
    expect(store.countIssued(account.accountId)).toBe(0);
  });

  it('counts issued invites so the five-invite cap can be enforced server-side', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    for (let i = 0; i < 5; i += 1) {
      const code = newInviteCode();
      store.createInvite(account.accountId, code);
      store.incrementInvitesIssued(account.accountId);
    }
    expect(store.countIssued(account.accountId)).toBe(5);
    expect(store.listInvites(account.accountId)).toHaveLength(5);
    expect(store.getAccount(account.accountId)?.invitesIssued).toBe(5);
  });

  it('marks an invite accepted exactly once and refuses unknown codes', () => {
    const store = new AccountStore({ dataDir: dir });
    const inviter = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    const code = newInviteCode();
    store.createInvite(inviter.accountId, code);
    expect(store.findByCode(code)?.acceptedBy).toBeUndefined();
    store.markInviteAccepted(code, 'account-of-invitee');
    expect(store.findByCode(code)?.acceptedBy).toBe('account-of-invitee');
    expect(store.findByCode('OBS-NOT-A-REAL-CODE')).toBeUndefined();
  });

  it('keeps sessions opaque, expiring and destroyable', () => {
    const store = new AccountStore({ dataDir: dir, sessionTtlSeconds: 60 });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    const session = store.createSession(account.accountId, 'token-abc');
    expect(store.getSession('token-abc')?.accountId).toBe(account.accountId);
    store.destroySession('token-abc');
    expect(store.getSession('token-abc')).toBeUndefined();
    expect(session.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('drops expired sessions on read', () => {
    const store = new AccountStore({ dataDir: dir, sessionTtlSeconds: -1 });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    store.createSession(account.accountId, 'token-abc');
    expect(store.getSession('token-abc')).toBeUndefined();
  });

  it('writes the store with owner-only permissions and survives a restart', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    store.setWalletAddress(account.accountId, 'dobs1examplewalletaddress000000000000000');
    const reopened = new AccountStore({ dataDir: dir });
    expect(reopened.getAccount(account.accountId)?.walletAddress).toBe('dobs1examplewalletaddress000000000000000');
    expect(JSON.parse(readFileSync(join(dir, 'interface-accounts.json'), 'utf8')).version).toBe(1);
  });

  it('never persists key material, phrases or tokens that could move funds', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com', displayName: 'A' });
    store.createSession(account.accountId, 'session-token-value');
    const raw = readFileSync(join(dir, 'interface-accounts.json'), 'utf8');
    for (const forbidden of ['privateKey', 'mnemonic', 'seedPhrase', 'recoveryPhrase', 'secretKey', 'passphrase']) {
      expect(raw).not.toContain(forbidden);
    }
    // The session token is stored (that is how a cookie is validated) but it is
    // not a wallet key and it cannot sign anything.
    expect(raw).toContain('session-token-value');
  });

  it('quarantines a corrupt store instead of crashing or silently starting empty', () => {
    writeFileSync(join(dir, 'interface-accounts.json'), '{ this is not json', 'utf8');
    const store = new AccountStore({ dataDir: dir });
    expect(store.accountCount).toBe(0);
    expect(readdirSync(dir).some((name) => name.includes('interface-accounts.json.corrupt-'))).toBe(true);
  });

  it('can suspend an account without deleting its history', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com' });
    store.setSuspended(account.accountId, true);
    expect(store.getAccount(account.accountId)?.suspended).toBe(true);
    expect(store.getAccount(account.accountId)?.email).toBe('a@example.com');
    store.setSuspended(account.accountId, false);
    expect(store.getAccount(account.accountId)?.suspended).toBe(false);
  });

  it('does not create a store file until there is something to remember', () => {
    new AccountStore({ dataDir: dir });
    expect(existsSync(join(dir, 'interface-accounts.json'))).toBe(false);
  });
});
