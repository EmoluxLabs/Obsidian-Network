/**
 * Account identity: canonical Gmail, passwords, recovery codes, TOTP.
 *
 * These are the rules that decide who may hold a mining account, so they are
 * tested as rules rather than as implementation details: a dotted address and
 * a +tagged address must be one identity, a password must never be readable
 * from what is stored, a recovery code must survive being typed by a human,
 * and a TOTP code must be checkable against an independent implementation.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_STEP_SECONDS,
  canonicalGmail,
  checkPasswordPolicy,
  currentTotpStep,
  hashSecret,
  newRecoveryCodeSet,
  newTotpSecret,
  normaliseRecoveryCode,
  totpAt,
  totpUri,
  verifySecret,
  verifyTotp,
} from '../server/identity.js';

describe('canonical Gmail', () => {
  it('treats dots, +tags and googlemail.com as one inbox', () => {
    const forms = [
      'john.smith@gmail.com',
      'johnsmith@gmail.com',
      'j.o.h.n.s.m.i.t.h@gmail.com',
      'johnsmith+mining@gmail.com',
      'john.smith+anything.at.all@googlemail.com',
      '  JohnSmith@Gmail.com  ',
    ];
    const canonical = forms.map((form) => canonicalGmail(form)?.canonical);
    expect(new Set(canonical)).toEqual(new Set(['johnsmith@gmail.com']));
  });

  it('keeps the address the user typed for display, separate from the key', () => {
    const result = canonicalGmail('John.Smith+Shop@googlemail.com');
    expect(result).toEqual({ display: 'john.smith+shop@googlemail.com', canonical: 'johnsmith@gmail.com' });
  });

  it('does not conflate different people', () => {
    expect(canonicalGmail('johnsmith@gmail.com')?.canonical).not.toBe(canonicalGmail('johnsmyth@gmail.com')?.canonical);
  });

  it('accepts only Gmail, and only plausible local parts', () => {
    for (const bad of [
      'someone@example.com',
      'someone@gmail.com.evil.test',
      'short@gmail.com', // under Google's six-character minimum
      '@gmail.com',
      'johnsmith@',
      'john..smith@gmail.com',
      '.johnsmith@gmail.com',
      'johnsmith.@gmail.com',
      'john smith@gmail.com',
      `${'a'.repeat(31)}@gmail.com`,
      '',
      '   ',
    ]) {
      expect(canonicalGmail(bad), bad).toBeNull();
    }
  });

  it('is not fooled by a second @ or by case in the domain', () => {
    expect(canonicalGmail('johnsmith@gmail.com@evil.test')).toBeNull();
    expect(canonicalGmail('johnsmith@GMAIL.COM')?.canonical).toBe('johnsmith@gmail.com');
  });
});

describe('password policy', () => {
  it('requires length and a mix, because there is no reset channel', () => {
    expect(checkPasswordPolicy('correct-horse-7-battery').ok).toBe(true);
    expect(checkPasswordPolicy('short1').ok).toBe(false);
    expect(checkPasswordPolicy('alllettersnodigits').ok).toBe(false);
    expect(checkPasswordPolicy('1234567890123456').ok).toBe(false);
  });

  it('explains itself rather than failing silently', () => {
    const result = checkPasswordPolicy('nope');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/\w/);
  });
});

describe('secret hashing', () => {
  it('never stores the secret and salts every hash', () => {
    const first = hashSecret('correct-horse-7-battery');
    const second = hashSecret('correct-horse-7-battery');
    expect(first).not.toBe(second);
    expect(first).not.toContain('correct-horse');
    expect(first.startsWith('scrypt$')).toBe(true);
  });

  it('verifies the right secret and rejects everything else', () => {
    const stored = hashSecret('correct-horse-7-battery');
    expect(verifySecret('correct-horse-7-battery', stored)).toBe(true);
    expect(verifySecret('correct-horse-7-batterx', stored)).toBe(false);
    expect(verifySecret('', stored)).toBe(false);
    expect(verifySecret('anything', undefined)).toBe(false);
    expect(verifySecret('anything', 'not-a-hash')).toBe(false);
  });
});

describe('recovery codes', () => {
  it('issues a full set of distinct, human-transcribable codes', () => {
    const set = newRecoveryCodeSet();
    expect(set.codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(set.hashes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(set.codes).size).toBe(RECOVERY_CODE_COUNT);
    for (const code of set.codes) {
      // No I, O, 0 or 1 anywhere: these get written on paper and read back.
      expect(code).toMatch(/^OBS-RECOVERY-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    }
  });

  it('stores only hashes, each of which matches exactly one code', () => {
    const set = newRecoveryCodeSet();
    expect(set.hashes.join('|')).not.toContain(set.codes[0]!.slice(-4));
    expect(set.hashes.some((hash) => verifySecret(set.codes[0]!, hash))).toBe(true);
    expect(set.hashes.filter((hash) => verifySecret(set.codes[0]!, hash))).toHaveLength(1);
  });

  it('forgives how a human types a code back in', () => {
    const [code] = newRecoveryCodeSet(1).codes;
    const mangled = ` ${code!.toLowerCase().replace(/-/g, ' ')} `;
    expect(normaliseRecoveryCode(mangled)).toBe(code);
  });
});

describe('TOTP', () => {
  /** An independent RFC 6238, so the test does not merely agree with itself. */
  function reference(secret: string, step: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';
    for (const char of secret.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
    const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
    const message = Buffer.alloc(8);
    message.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
    message.writeUInt32BE(step >>> 0, 4);
    const digest = createHmac('sha1', key).update(message).digest();
    const offset = digest[digest.length - 1]! & 0x0f;
    return String((digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
  }

  it('agrees with an independent implementation', () => {
    const secret = newTotpSecret();
    const step = currentTotpStep();
    expect(totpAt(secret, step)).toBe(reference(secret, step));
    expect(totpAt(secret, step + 5)).toBe(reference(secret, step + 5));
  });

  it('accepts the neighbouring step but not a distant one', () => {
    const secret = newTotpSecret();
    const step = currentTotpStep();
    expect(verifyTotp(secret, totpAt(secret, step)).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, step - 1)).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, step + 1)).ok).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, step + 4)).ok).toBe(false);
  });

  it('reports the step it consumed, so a code cannot be replayed', () => {
    const secret = newTotpSecret();
    const step = currentTotpStep();
    const accepted = verifyTotp(secret, totpAt(secret, step));
    expect(accepted.ok).toBe(true);
    expect(accepted.step).toBe(step);
    // Replay protection is the caller's job, but it needs this to do it.
    expect(verifyTotp(secret, totpAt(secret, step), { lastUsedStep: step }).ok).toBe(false);
  });

  it('rejects malformed input instead of throwing', () => {
    const secret = newTotpSecret();
    for (const bad of ['', '12345', '1234567', 'abcdef', '  ']) {
      expect(verifyTotp(secret, bad).ok, bad).toBe(false);
    }
  });

  it('produces a standard otpauth URI an authenticator app understands', () => {
    const secret = newTotpSecret();
    const uri = totpUri(secret, 'johnsmith@gmail.com');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain(`digits=${TOTP_DIGITS}`);
    expect(uri).toContain(`period=${TOTP_STEP_SECONDS}`);
    expect(uri).toContain('issuer=Obsidian+Network');
    expect(new URL(uri).searchParams.get('issuer')).toBe('Obsidian Network');
  });
});
