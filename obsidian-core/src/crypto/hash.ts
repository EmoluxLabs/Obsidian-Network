/**
 * Hashing primitives. SHA-256 is the Obsidian Network hash function.
 * Hashes are always computed over canonical, domain-separated byte strings
 * (see protocol/encoding.ts) so that a transaction hash can never be confused
 * with a block hash, an address, or any other digest.
 */

import { sha256 as nobleSha256 } from '@noble/hashes/sha256';
import { ripemd160 as nobleRipemd160 } from '@noble/hashes/ripemd160';
import { hmac } from '@noble/hashes/hmac';
import { createHash } from 'node:crypto';

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex: odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('hex: invalid character');
    out[i] = byte;
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha256Hex(data: Uint8Array | string): string {
  return toHex(sha256(typeof data === 'string' ? utf8(data) : data));
}

export function doubleSha256(data: Uint8Array): Uint8Array {
  return sha256(sha256(data));
}

export function ripemd160(data: Uint8Array): Uint8Array {
  return nobleRipemd160(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, data);
}

/**
 * Domain-separated hash. The `domain` string is length-prefixed into the
 * preimage so that different object types can never collide.
 */
export function domainHash(domain: string, ...chunks: Uint8Array[]): Uint8Array {
  const d = utf8(domain);
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, d.length, false);
  return sha256(concatBytes(len, d, ...chunks));
}

/** Streaming SHA-256 for large artifacts (release checksums, backups). */
export function sha256FileStream(): import('node:crypto').Hash {
  return createHash('sha256');
}

/** Constant-time comparison to avoid timing oracles on digests. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function utf8Compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
