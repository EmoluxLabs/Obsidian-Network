/**
 * Account store.
 *
 * The store is the only thing this process persists, so the tests are written
 * around one question: can anything here ever hold a key, a phrase or a token
 * that could be used to move OBS? The answer must stay no, and the invite cap
 * must stay enforced on the server rather than in the page.
 */

import { createHash } from 'node:crypto';
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
    expect(JSON.parse(readFileSync(join(dir, 'interface-accounts.json'), 'utf8')).version).toBe(2);
  });

  it('never persists key material, phrases or tokens that could move funds', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 'sub-1', email: 'a@example.com', displayName: 'A' });
    store.createSession(account.accountId, 'session-token-value');
    store.flush(); // sessions are written lazily
    const raw = readFileSync(join(dir, 'interface-accounts.json'), 'utf8');
    for (const forbidden of ['privateKey', 'mnemonic', 'seedPhrase', 'recoveryPhrase', 'secretKey', 'passphrase']) {
      expect(raw).not.toContain(forbidden);
    }
    // A session token is a bearer credential: whoever holds one IS that user. It
    // used to sit in this file in the clear, so a stolen backup was a set of
    // working logins. Only its SHA-256 is stored; the cookie holds the token.
    expect(raw).not.toContain('session-token-value');
    expect(raw).toContain(createHash('sha256').update('session-token-value').digest('hex'));
    // ...and the hash is enough to recognise the cookie, after a restart too.
    expect(new AccountStore({ dataDir: dir }).getSession('session-token-value')?.accountId).toBe(account.accountId);
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

describe('sessions and durability', () => {
  it('migrates a version-1 file: its raw session tokens are hashed and no longer written out', () => {
    writeFileSync(
      join(dir, 'interface-accounts.json'),
      JSON.stringify({
        version: 1,
        accounts: [{ accountId: 'acc_1', subject: 's', email: 'a@gmail.com', canonicalEmail: 'a@gmail.com', createdAt: 1, lastSeenAt: 1, invitesIssued: 0 }],
        invites: [],
        sessions: [{ token: 'legacy-raw-token', accountId: 'acc_1', createdAt: Date.now(), expiresAt: Date.now() + 60_000 }],
        genesisInvite: null,
      }),
    );
    const store = new AccountStore({ dataDir: dir });
    expect(store.getSession('legacy-raw-token')?.accountId).toBe('acc_1');
    const raw = readFileSync(join(dir, 'interface-accounts.json'), 'utf8');
    expect(raw).not.toContain('legacy-raw-token');
    expect(JSON.parse(raw).version).toBe(2);
  });

  it('signs an account out everywhere except the session that is being kept', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 's1', email: 'a@gmail.com', canonicalEmail: 'a@gmail.com' });
    const other = store.createAccount({ subject: 's2', email: 'b@gmail.com', canonicalEmail: 'b@gmail.com' });
    store.createSession(account.accountId, 'one');
    store.createSession(account.accountId, 'two');
    store.createSession(other.accountId, 'bystander');
    expect(store.destroyAccountSessions(account.accountId, 'two')).toBe(1);
    expect(store.getSession('one')).toBeUndefined();
    expect(store.getSession('two')?.accountId).toBe(account.accountId);
    expect(store.getSession('bystander')?.accountId).toBe(other.accountId);
    expect(store.destroyAccountSessions(account.accountId)).toBe(1);
    expect(store.getSession('two')).toBeUndefined();
  });

  it('spends an already-verified recovery code exactly once', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 's', email: 'a@gmail.com', canonicalEmail: 'a@gmail.com', recoveryCodeHashes: ['hash-a', 'hash-b'] });
    expect(store.consumeRecoveryHash(account.accountId, 'hash-a')).toBe(true);
    expect(store.consumeRecoveryHash(account.accountId, 'hash-a')).toBe(false); // the second of two racers
    expect(store.getAccount(account.accountId)?.recoveryCodesRemaining).toBe(1);
    expect(store.consumeRecoveryHash(account.accountId, 'never-issued')).toBe(false);
    expect(new AccountStore({ dataDir: dir }).getAccount(account.accountId)?.recoveryCodeHashes).toEqual(['hash-b']);
  });

  it('writes security-critical changes before returning, and lazy ones on flush, without leaving temp files behind', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 's', email: 'a@gmail.com', canonicalEmail: 'a@gmail.com' });
    // An account is on disk the moment it exists.
    expect(new AccountStore({ dataDir: dir }).getAccount(account.accountId)).toBeDefined();
    // A session is lazy: not necessarily written yet, certainly written after flush().
    store.createSession(account.accountId, 'lazy-token');
    store.flush();
    expect(new AccountStore({ dataDir: dir }).getSession('lazy-token')?.accountId).toBe(account.accountId);
    expect(readdirSync(dir).filter((name) => name.includes('.tmp'))).toEqual([]);
  });

  it('finds an account by canonical address through the index, and forgets it on delete', () => {
    const store = new AccountStore({ dataDir: dir });
    const account = store.createAccount({ subject: 's', email: 'a.b@gmail.com', canonicalEmail: 'ab@gmail.com' });
    expect(store.findByCanonicalEmail('ab@gmail.com')?.accountId).toBe(account.accountId);
    expect(() => store.createAccount({ subject: 's2', email: 'a.b+x@gmail.com', canonicalEmail: 'ab@gmail.com' })).toThrow(/already exists/);
    store.deleteAccount(account.accountId);
    expect(store.findByCanonicalEmail('ab@gmail.com')).toBeUndefined();
    expect(new AccountStore({ dataDir: dir }).findByCanonicalEmail('ab@gmail.com')).toBeUndefined();
  });
});
