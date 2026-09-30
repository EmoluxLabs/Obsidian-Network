/**
 * The Genesis Invitation.
 *
 * Exactly one of these exists per deployment. It is the single credential that
 * lets the *first* account register on a fresh interface; every account after
 * it needs an ordinary invite issued by an existing member, which is a
 * completely separate mechanism (see `store.createInvite`).
 *
 * The rules this module exists to enforce:
 *
 *   - The plaintext code is generated with a cryptographically secure random
 *     generator and is shown to a human exactly once, by the generator script.
 *     It is never written to this repository, a config file in the repository,
 *     a frontend bundle, an API response, or a log line.
 *   - The server only ever stores a **salted scrypt hash** of the code. Losing
 *     the plaintext is therefore unrecoverable, by construction — there is no
 *     code path that can turn the stored hash back into the code.
 *   - Redemption is one-way and single-use. The redeemed flag is set in the
 *     same synchronous step that validates the code, so two simultaneous
 *     requests cannot both succeed (see `store.redeemGenesisInvite`).
 *   - It grants registration and nothing else: 0 OBS, no balance, no special
 *     authority, no administrative capability. It is not a backdoor and not a
 *     universal invite — once redeemed it is permanently dead.
 *
 * Why scrypt rather than a bare SHA-256: the code is short enough for a human
 * to write on paper, so its entropy (80 bits) is far below a random 256-bit
 * key. If the stored hash ever leaked, a fast hash would allow an offline
 * search. scrypt makes each guess expensive in both CPU and memory.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Unambiguous alphabet — no I, O, 0 or 1, because this code gets written down
 * on paper and read back by a human. 32 characters, and 256 is divisible by
 * 32, so indexing a random byte with `% 32` is unbiased.
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Four groups of four characters: 16 symbols x 5 bits = 80 bits of entropy. */
const GROUPS = 4;
const GROUP_LENGTH = 4;

export const GENESIS_PREFIX = 'OBS-GENESIS';

/** scrypt parameters. N=2^15 with r=8 costs roughly 32 MB and ~100ms per guess. */
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

export interface GenesisInviteRecord {
  /** `scrypt$N$r$p$<salt hex>$<hash hex>`. Never the plaintext code. */
  hash: string;
  createdAt: number;
  /** Account that redeemed it. Once set, the invitation is permanently dead. */
  redeemedBy?: string;
  redeemedAt?: number;
  /** Failed redemption attempts, so an operator can see a brute-force attempt. */
  failedAttempts?: number;
}

/**
 * Generate a new Genesis Invitation.
 *
 * Returns the plaintext (to be shown to a human once and then forgotten by the
 * process) and the hash (the only thing a server should ever hold).
 */
export function newGenesisInvitation(): { code: string; hash: string } {
  const code = newGenesisCode();
  return { code, hash: hashGenesisInvitation(code) };
}

/**
 * The random part on its own, without paying for a scrypt hash. Exported so
 * callers that only need a candidate code (tests, shape checks) do not spend
 * 100ms of deliberate key-stretching to get one.
 */
export function newGenesisCode(): string {
  const symbols = GROUPS * GROUP_LENGTH;
  const bytes = randomBytes(symbols);
  let body = '';
  for (let i = 0; i < symbols; i += 1) {
    body += ALPHABET[bytes[i]! % ALPHABET.length];
    if (i % GROUP_LENGTH === GROUP_LENGTH - 1 && i !== symbols - 1) body += '-';
  }
  return `${GENESIS_PREFIX}-${body}`;
}

/**
 * Normalise a code for comparison: case-insensitive, punctuation-insensitive.
 * A human retyping `obs genesis abcd efgh ...` must still match. This is
 * applied identically at generation and at verification, so the hash is taken
 * over a canonical form.
 */
export function normaliseGenesisCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Hash a code for storage. A fresh random salt is generated each call. */
export function hashGenesisInvitation(code: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(normaliseGenesisCode(code), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    // scrypt with N=32768 needs more than Node's default 32 MB limit.
    maxmem: 128 * 1024 * 1024,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/**
 * Verify a candidate code against a stored hash, in constant time.
 *
 * Returns false for anything malformed rather than throwing: a caller must not
 * be able to tell a corrupt stored hash from a wrong code by watching for an
 * exception.
 */
export function verifyGenesisInvitation(candidate: string, stored: string): boolean {
  if (typeof candidate !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, 'hex');
    expected = Buffer.from(parts[5]!, 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(normaliseGenesisCode(candidate), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: 256 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** Shape check only — never logs or returns any part of the secret. */
export function looksLikeGenesisCode(code: string): boolean {
  const normalised = normaliseGenesisCode(code);
  const prefix = normaliseGenesisCode(GENESIS_PREFIX);
  if (!normalised.startsWith(prefix)) return false;
  return normalised.length === prefix.length + GROUPS * GROUP_LENGTH;
}
