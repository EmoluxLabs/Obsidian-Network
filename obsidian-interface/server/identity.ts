/**
 * Account identity: canonical Gmail, passwords, recovery codes and MFA.
 *
 * This module replaces Google OAuth. The rules it enforces:
 *
 *   - **One mining account per human Gmail address.** Gmail treats
 *     `john.smith+shop@gmail.com` and `johnsmith@gmail.com` as the same inbox,
 *     so uniqueness is checked against a *canonical* form. The canonicalisation
 *     happens here, on the server, and the frontend is never asked whether an
 *     address is unique — a client that lies gets rejected by the store's
 *     canonical index, not trusted.
 *   - **Passwords are never stored.** Only a salted scrypt hash, in the same
 *     `scrypt$N$r$p$salt$hash` format the Genesis Invitation uses.
 *   - **There is no password reset and no email verification.** Recovery is by
 *     recovery code, which is why the codes are issued at registration and the
 *     user is told, loudly, to write them down. A reset channel through email
 *     would make the email provider an authority over mining accounts.
 *   - **MFA is TOTP** (RFC 6238, SHA-1, 6 digits, 30s), verified server-side
 *     with a ±1 step window and replay protection on the consumed step.
 *
 * Nothing here is authoritative over the chain. An account is permission to use
 * this interface; OBS moves only on signatures the nodes verify.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/** scrypt cost. Deliberately slow: these hashes guard mining accounts. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

/** Recovery codes issued at registration. */
export const RECOVERY_CODE_COUNT = 10;
/** Unambiguous alphabet: no I, O, 0 or 1. 32 symbols => 5 bits each, no bias. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ── Canonical Gmail ─────────────────────────────────────────────────────────

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

export interface CanonicalEmail {
  /** What the user typed, trimmed and lowercased. Shown back to them. */
  display: string;
  /** The uniqueness key. Dots removed, +tag removed, googlemail => gmail. */
  canonical: string;
}

/**
 * Canonicalise a Gmail address, or return null if it is not a usable one.
 *
 * Gmail ignores dots in the local part and everything after a `+`. Without
 * this, one person could register unlimited mining accounts from a single
 * inbox simply by sprinkling dots.
 */
export function canonicalGmail(input: string): CanonicalEmail | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 254) return null;

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return null;

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return null;

  // No consecutive dots, no leading/trailing dot, and a conservative charset.
  if (!/^[a-z0-9]+(?:[._+-][a-z0-9]+)*$/.test(local)) return null;

  const withoutTag = local.split('+', 1)[0] ?? '';
  const withoutDots = withoutTag.replace(/\./g, '');
  // Google requires 6-30 characters in the dotless local part.
  if (withoutDots.length < 6 || withoutDots.length > 30) return null;

  return { display: trimmed, canonical: `${withoutDots}@gmail.com` };
}

// ── Passwords ───────────────────────────────────────────────────────────────

export interface PasswordPolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Password policy. Length does more for entropy than symbol classes do, and
 * there is no reset channel, so the rules stay memorable rather than cryptic.
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (typeof password !== 'string') return { ok: false, reason: 'a password is required' };
  if (password.length < 12) return { ok: false, reason: 'use at least 12 characters' };
  if (password.length > 512) return { ok: false, reason: 'that password is unreasonably long' };
  if (!/[a-z]/i.test(password)) return { ok: false, reason: 'include at least one letter' };
  if (!/[0-9]/.test(password)) return { ok: false, reason: 'include at least one digit' };
  if (/^\s|\s$/.test(password)) return { ok: false, reason: 'remove the leading or trailing space' };
  return { ok: true };
}

/** `scrypt$N$r$p$<salt hex>$<hash hex>` — the same shape as genesis invites. */
export function hashSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(secret.normalize('NFKC'), salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Constant-time verification. Malformed or unknown records return false. */
export function verifySecret(secret: string, stored: string | undefined | null): boolean {
  if (typeof secret !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let derived: Buffer;
  try {
    derived = scryptSync(secret.normalize('NFKC'), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/** `OBS-RECOVERY-XXXX-XXXX-XXXX` — 12 symbols, 60 bits. */
export const RECOVERY_PREFIX = 'OBS-RECOVERY-';

function randomSymbols(count: number): string {
  // 256 % 32 === 0, so a byte maps onto the alphabet without modulo bias.
  const bytes = randomBytes(count);
  let out = '';
  for (let i = 0; i < count; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function newRecoveryCode(): string {
  const symbols = randomSymbols(12);
  return `${RECOVERY_PREFIX}${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8, 12)}`;
}

/** Normalise user input: case, spaces and stray punctuation are forgiven. */
export function normaliseRecoveryCode(input: string): string {
  if (typeof input !== 'string') return '';
  // Strip everything that is not a code symbol first, so the prefix is found
  // whether the user typed it with dashes, with spaces, or not at all.
  const bare = input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const prefix = RECOVERY_PREFIX.replace(/[^A-Z0-9]/g, '');
  const symbols = bare.startsWith(prefix) ? bare.slice(prefix.length) : bare;
  if (symbols.length !== 12) return '';
  return `${RECOVERY_PREFIX}${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8, 12)}`;
}

/** A fresh set of codes: the plaintext (shown once) and the stored hashes. */
export function newRecoveryCodeSet(count = RECOVERY_CODE_COUNT): {
  codes: string[];
  hashes: string[];
} {
  const codes: string[] = [];
  const seen = new Set<string>();
  while (codes.length < count) {
    const code = newRecoveryCode();
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push(code);
  }
  return { codes, hashes: codes.map((code) => hashSecret(code)) };
}

// ── TOTP (RFC 6238) ─────────────────────────────────────────────────────────

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the neighbouring steps so a slightly wrong clock still works. */
export const TOTP_WINDOW = 1;

export function newTotpSecret(bytes = 20): string {
  const raw = randomBytes(bytes);
  let bits = '';
  for (const byte of raw) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) continue;
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** The TOTP code for a given step, as a zero-padded string. */
export function totpAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

export function currentTotpStep(nowMs = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Verify a TOTP code.
 *
 * Returns the step the code belongs to so the caller can refuse to accept the
 * same step twice — without that, a code is replayable for its whole window.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { nowMs?: number; lastUsedStep?: number } = {},
): { ok: boolean; step?: number; reason?: string } {
  if (typeof secret !== 'string' || secret.length === 0) return { ok: false, reason: 'no MFA secret' };
  const digits = typeof code === 'string' ? code.trim().replace(/\s+/g, '') : '';
  if (!/^[0-9]{6}$/.test(digits)) return { ok: false, reason: 'a 6-digit code is required' };

  const current = currentTotpStep(options.nowMs ?? Date.now());
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = current + delta;
    const expected = totpAt(secret, step);
    const a = Buffer.from(expected);
    const b = Buffer.from(digits);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      if (options.lastUsedStep !== undefined && step <= options.lastUsedStep) {
        return { ok: false, reason: 'that code has already been used' };
      }
      return { ok: true, step };
    }
  }
  return { ok: false, reason: 'that code is not valid' };
}

/** otpauth:// URI for authenticator apps. Contains the secret, so never log it. */
export function totpUri(secret: string, accountEmail: string, issuer = 'Obsidian Network'): string {
  const label = encodeURIComponent(`${issuer}:${accountEmail}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
