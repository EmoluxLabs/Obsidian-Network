/**
 * Invite codes and session secrets.
 *
 * Google OAuth used to live here. It is gone: accounts are Gmail + password +
 * invite + TOTP, all verified by this process (see `identity.ts`). No third
 * party is an authority over who may hold an Obsidian mining account, and the
 * interface cannot be locked out by someone else's token service.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

export function secretEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Human-friendly invite code: unambiguous alphabet, grouped for readability. */
export function newInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i += 1) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i !== 15) out += '-';
  }
  return out;
}

export function normaliseInviteCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}
