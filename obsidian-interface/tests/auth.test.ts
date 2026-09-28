/**
 * Google sign-in verification.
 *
 * The rule being tested is blunt: the server must never believe a client that
 * claims to be a Google user. Every test here hands the verifier a token and an
 * expectation about whether that token *proves* anything. Tokens are signed with
 * a throwaway RSA key generated in the test, and the JWKS is injected, so the
 * suite never touches the network.
 */

import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { GoogleTokenVerifier, newInviteCode, newSecret, normaliseInviteCode, secretEquals, type JwksDocument } from '../server/auth.js';

const CLIENT_ID = 'obsidian-test-client.apps.googleusercontent.com';
const NOW = 1_800_000_000; // seconds

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('Google id-token verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const jwks: JwksDocument = { keys: [{ kid: 'test-key-1', kty: 'RSA', alg: 'RS256', use: 'sig', n: jwk.n, e: jwk.e }] };

  let verifier: GoogleTokenVerifier;

  beforeEach(() => {
    verifier = new GoogleTokenVerifier({ clientId: CLIENT_ID, jwks, now: () => NOW * 1000 });
  });

  function token(claims: Record<string, unknown>, options: { kid?: string; signed?: boolean } = {}): string {
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: options.kid ?? 'test-key-1' }));
    const payload = base64url(JSON.stringify(claims));
    const body = `${header}.${payload}`;
    if (options.signed === false) return `${body}.${base64url('not-a-signature')}`;
    const signer = createSign('RSA-SHA256');
    signer.update(body);
    return `${body}.${base64url(signer.sign(privateKey))}`;
  }

  function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '112233445566778899',
      email: 'miner@example.com',
      email_verified: true,
      name: 'Miner One',
      iat: NOW - 30,
      exp: NOW + 3600,
      ...overrides,
    };
  }

  it('accepts a well-formed token and returns the profile it proves', async () => {
    const profile = await verifier.verify(token(validClaims()));
    expect(profile).toMatchObject({ subject: '112233445566778899', email: 'miner@example.com', emailVerified: true });
  });

  it('accepts the bare hostname issuer as well as the https form', async () => {
    const profile = await verifier.verify(token(validClaims({ iss: 'accounts.google.com' })));
    expect(profile.emailVerified).toBe(true);
  });

  it('rejects a token minted for a different client id', async () => {
    await expect(verifier.verify(token(validClaims({ aud: 'someone-elses-client.apps.googleusercontent.com' })))).rejects.toThrow(/different client/i);
  });

  it('rejects a token from a different issuer', async () => {
    await expect(verifier.verify(token(validClaims({ iss: 'https://evil.example' })))).rejects.toThrow(/not issued by Google/i);
  });

  it('rejects an expired token and one that is not valid yet', async () => {
    await expect(verifier.verify(token(validClaims({ exp: NOW - 120 })))).rejects.toThrow(/expired/i);
    await expect(verifier.verify(token(validClaims({ iat: NOW + 600 })))).rejects.toThrow(/not valid yet|issued in the future/i);
  });

  it('tolerates small clock skew in both directions', async () => {
    await expect(verifier.verify(token(validClaims({ exp: NOW - 30 })))).resolves.toBeTruthy();
    await expect(verifier.verify(token(validClaims({ iat: NOW + 30 })))).resolves.toBeTruthy();
  });

  it('refuses an unverified email address', async () => {
    await expect(verifier.verify(token(validClaims({ email_verified: false })))).rejects.toThrow(/verified/i);
  });

  it('refuses a token whose signature does not match the key', async () => {
    await expect(verifier.verify(token(validClaims(), { signed: false }))).rejects.toThrow(/signature/i);
  });

  it('refuses a token signed by an unknown key id', async () => {
    await expect(verifier.verify(token(validClaims(), { kid: 'some-other-key' }))).rejects.toThrow(/key/i);
  });

  it('never returns a flag a caller could trust blindly instead of verifying', async () => {
    // There is no `isGoogleUser` short-circuit anywhere in the verifier: the only
    // way to obtain a profile is a signature check that has actually passed.
    const missingSignature = 'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJhdHRhY2tlciJ9.';
    await expect(verifier.verify(missingSignature)).rejects.toThrow();
  });
});

describe('invite codes and shared secrets', () => {
  it('generates invite codes that are long, unique and normalisable', () => {
    const codes = new Set(Array.from({ length: 64 }, () => newInviteCode()));
    expect(codes.size).toBe(64);
    for (const code of codes) {
      expect(code.length).toBeGreaterThanOrEqual(12);
      expect(normaliseInviteCode(code.toLowerCase())).toBe(normaliseInviteCode(code));
      expect(normaliseInviteCode(` ${code} `)).toBe(normaliseInviteCode(code));
    }
  });

  it('compares secrets without leaking their length through an early exit', () => {
    const secret = newSecret();
    expect(secretEquals(secret, secret)).toBe(true);
    expect(secretEquals(secret, newSecret())).toBe(false);
    expect(secretEquals(secret, secret.slice(0, -1))).toBe(false);
    expect(secretEquals('', '')).toBe(true);
  });
});
