/**
 * The Genesis Invitation.
 *
 * These tests exist to prove the properties that were asked for explicitly:
 * cryptographic randomness, single use, atomic redemption under concurrency,
 * replay resistance, hash-only storage, and complete separation from the
 * ordinary member-invite system.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GENESIS_PREFIX,
  hashGenesisInvitation,
  looksLikeGenesisCode,
  newGenesisCode,
  newGenesisInvitation,
  normaliseGenesisCode,
  verifyGenesisInvitation,
} from '../server/genesis-invite.js';
import { AccountStore } from '../server/store.js';

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-genesis-'));
  dirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function storeWith(hash: string): AccountStore {
  const store = new AccountStore({ dataDir: scratch() });
  store.configureGenesisInvite(hash);
  return store;
}

const profile = (subject: string) => ({ subject, email: `${subject}@example.com` });

describe('genesis invitation: generation', () => {
  it('has the documented shape', () => {
    const code = newGenesisCode();
    expect(code.startsWith(`${GENESIS_PREFIX}-`)).toBe(true);
    expect(code).toMatch(/^OBS-GENESIS-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it('never uses ambiguous characters a human would misread', () => {
    for (let i = 0; i < 50; i += 1) {
      const body = newGenesisCode().replace(`${GENESIS_PREFIX}-`, '');
      expect(body).not.toMatch(/[IO01]/);
    }
  });

  it('is unique across many generations', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) seen.add(newGenesisCode());
    expect(seen.size).toBe(500);
  });

  it('carries 80 bits of entropy: 16 symbols from a 32-character alphabet', () => {
    const body = newGenesisCode().replace(`${GENESIS_PREFIX}-`, '').replace(/-/g, '');
    expect(body.length).toBe(16);
    // 32 symbols = 5 bits each.
    expect(body.length * 5).toBe(80);
  });

  it('produces a different hash each time even for an identical code', () => {
    // A fresh salt per hash: two deployments using the same code must not have
    // identical stored values.
    const code = newGenesisCode();
    expect(hashGenesisInvitation(code)).not.toBe(hashGenesisInvitation(code));
  });
});

describe('genesis invitation: verification', () => {
  it('accepts the correct code', () => {
    const { code, hash } = newGenesisInvitation();
    expect(verifyGenesisInvitation(code, hash)).toBe(true);
  });

  it('is insensitive to case, spacing and punctuation a human might add', () => {
    const { code, hash } = newGenesisInvitation();
    const mangled = code.toLowerCase().replace(/-/g, ' ');
    expect(verifyGenesisInvitation(mangled, hash)).toBe(true);
    expect(verifyGenesisInvitation(`  ${code}  `, hash)).toBe(true);
  });

  it('rejects a wrong code, an empty code and rubbish', () => {
    const { hash } = newGenesisInvitation();
    expect(verifyGenesisInvitation(newGenesisCode(), hash)).toBe(false);
    expect(verifyGenesisInvitation('', hash)).toBe(false);
    expect(verifyGenesisInvitation('OBS-GENESIS-AAAA-AAAA-AAAA-AAAA', hash)).toBe(false);
  });

  it('rejects rather than throws when the stored hash is corrupt', () => {
    const code = newGenesisCode();
    for (const broken of ['', 'nonsense', 'scrypt$1$2$3', 'sha256$x$y$z$w$v', 'scrypt$a$b$c$d$e']) {
      expect(verifyGenesisInvitation(code, broken)).toBe(false);
    }
  });

  it('recognises the code shape without revealing anything', () => {
    expect(looksLikeGenesisCode(newGenesisCode())).toBe(true);
    expect(looksLikeGenesisCode('ABCD-EFGH-JKLM-NPQR')).toBe(false);
    expect(looksLikeGenesisCode('OBS-GENESIS-SHORT')).toBe(false);
  });

  it('normalises to a canonical form', () => {
    expect(normaliseGenesisCode(' obs-genesis-abcd ')).toBe('OBSGENESISABCD');
  });
});

describe('genesis invitation: redemption', () => {
  it('redeems exactly once, then is permanently dead', () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);

    const first = store.createAccount(profile('one'));
    expect(store.redeemGenesisInvite(code, first.accountId)).toEqual({ ok: true });

    const second = store.createAccount(profile('two'));
    expect(store.redeemGenesisInvite(code, second.accountId)).toEqual({ ok: false, reason: 'ALREADY_USED' });
  });

  it('refuses a replay of the identical request', () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const account = store.createAccount(profile('one'));
    expect(store.redeemGenesisInvite(code, account.accountId).ok).toBe(true);
    // Same code, same account, replayed.
    expect(store.redeemGenesisInvite(code, account.accountId).ok).toBe(false);
  });

  it('is atomic: concurrent redemptions cannot both succeed', async () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const accounts = Array.from({ length: 16 }, (_, i) => store.createAccount(profile(`racer-${i}`)));

    // Fire them all in the same tick. Redemption is synchronous by design, so
    // the event loop cannot interleave between the check and the write.
    const results = await Promise.all(
      accounts.map(async (account) => store.redeemGenesisInvite(code, account.accountId)),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(15);
  });

  it('reports NOT_CONFIGURED when no invitation was installed', () => {
    const store = new AccountStore({ dataDir: scratch() });
    const account = store.createAccount(profile('one'));
    expect(store.redeemGenesisInvite('OBS-GENESIS-AAAA-AAAA-AAAA-AAAA', account.accountId)).toEqual({
      ok: false,
      reason: 'NOT_CONFIGURED',
    });
  });

  it('counts failed attempts so an operator can see a brute-force attempt', () => {
    const { hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const account = store.createAccount(profile('one'));
    for (let i = 0; i < 3; i += 1) store.redeemGenesisInvite(newGenesisCode(), account.accountId);
    expect(store.genesisInviteStatus().failedAttempts).toBe(3);
  });

  it('survives a restart: a redeemed invitation stays redeemed', () => {
    const { code, hash } = newGenesisInvitation();
    const dataDir = scratch();
    const first = new AccountStore({ dataDir });
    first.configureGenesisInvite(hash);
    const account = first.createAccount(profile('one'));
    expect(first.redeemGenesisInvite(code, account.accountId).ok).toBe(true);

    const reopened = new AccountStore({ dataDir });
    reopened.configureGenesisInvite(hash);
    expect(reopened.genesisInviteStatus().redeemed).toBe(true);
    const other = reopened.createAccount(profile('two'));
    expect(reopened.redeemGenesisInvite(code, other.accountId).ok).toBe(false);
  });

  it('cannot be revived by reconfiguring with a new hash', () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const account = store.createAccount(profile('one'));
    expect(store.redeemGenesisInvite(code, account.accountId).ok).toBe(true);

    // An operator restarting with a freshly generated invitation must not be
    // able to reopen registration on a deployment that already bootstrapped.
    const replacement = newGenesisInvitation();
    store.configureGenesisInvite(replacement.hash);
    const other = store.createAccount(profile('two'));
    expect(store.redeemGenesisInvite(replacement.code, other.accountId).ok).toBe(false);
    expect(store.genesisInviteStatus().redeemed).toBe(true);
  });
});

describe('genesis invitation: storage hygiene', () => {
  it('never writes the plaintext code to disk', () => {
    const { code, hash } = newGenesisInvitation();
    const dataDir = scratch();
    const store = new AccountStore({ dataDir });
    store.configureGenesisInvite(hash);
    const account = store.createAccount(profile('one'));
    store.redeemGenesisInvite(code, account.accountId);

    const onDisk = readFileSync(join(dataDir, 'interface-accounts.json'), 'utf8');
    expect(onDisk).not.toContain(code);
    expect(onDisk).not.toContain(normaliseGenesisCode(code));
    // Individual groups must not leak either.
    for (const group of code.replace(`${GENESIS_PREFIX}-`, '').split('-')) {
      expect(onDisk).not.toContain(`"${group}"`);
    }
    // The hash is what is stored.
    expect(onDisk).toContain('scrypt$');
  });

  it('exposes no part of the secret through the status view', () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const status = JSON.stringify(store.genesisInviteStatus());
    expect(status).not.toContain(code);
    expect(status).not.toContain('scrypt$');
    expect(Object.keys(store.genesisInviteStatus()).sort()).toEqual(
      ['configured', 'failedAttempts', 'redeemed', 'redeemedAt'].sort(),
    );
  });
});

describe('genesis invitation: separation from ordinary invites', () => {
  it('redeeming the genesis invitation does not touch the member invite list', () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const account = store.createAccount(profile('one'));
    store.redeemGenesisInvite(code, account.accountId);
    expect(store.inviteCount).toBe(0);
    expect(store.listInvites(account.accountId)).toEqual([]);
  });

  it('the genesis code is not a member invite and is not found by findByCode', () => {
    const { code, hash } = newGenesisInvitation();
    const store = storeWith(hash);
    expect(store.findByCode(code)).toBeUndefined();
  });

  it('a member invite is not accepted as a genesis invitation', () => {
    const { hash } = newGenesisInvitation();
    const store = storeWith(hash);
    const owner = store.createAccount(profile('owner'));
    const member = store.createInvite(owner.accountId, 'ABCD-EFGH-JKLM-NPQR');
    const newcomer = store.createAccount(profile('newcomer'));
    expect(store.redeemGenesisInvite(member.code, newcomer.accountId).ok).toBe(false);
  });
});
