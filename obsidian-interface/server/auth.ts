/**
 * Google OAuth verification and the invite system.
 *
 * Rules this file exists to enforce (spec §17, §18):
 *   - Membership is invite-only. An account cannot exist without a valid invite
 *     that the server itself issued. No client can create its own access.
 *   - A Google ID token is verified against Google's published JWKS: signature,
 *     issuer, audience, expiry and `email_verified`. A request body claiming
 *     `isGoogleUser: true` is worthless — the flag is never read.
 *   - Every account may issue at most `maxInvitesPerAccount` invites, checked
 *     and counted on the server.
 *   - No private key, seed phrase or password ever reaches this process.
 */

import { createPublicKey, createVerify, randomBytes, timingSafeEqual } from 'node:crypto';

export interface GoogleProfile {
  /** Stable Google subject id. Never used to derive anything cryptographic. */
  subject: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

export interface TokenVerifier {
  verify(idToken: string): Promise<GoogleProfile>;
}

export interface GoogleVerifierOptions {
  /** OAuth client id the token must be issued for. */
  clientId: string;
  /** Override for tests: a JWKS document instead of fetching Google's. */
  jwks?: JwksDocument;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface JwksDocument {
  keys: Array<{
    kid: string;
    kty: string;
    alg?: string;
    use?: string;
    n: string;
    e: string;
  }>;
}

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const CLOCK_SKEW_SECONDS = 60;

function base64UrlToBuffer(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeSegment<T>(segment: string): T {
  const text = base64UrlToBuffer(segment).toString('utf8');
  return JSON.parse(text) as T;
}

export class GoogleTokenVerifier implements TokenVerifier {
  private jwks?: JwksDocument;
  private jwksFetchedAt = 0;

  constructor(private readonly options: GoogleVerifierOptions) {}

  private async loadJwks(): Promise<JwksDocument> {
    if (this.jwks && Date.now() - this.jwksFetchedAt < 3_600_000) return this.jwks;
    if (this.options.jwks) {
      this.jwks = this.options.jwks;
      this.jwksFetchedAt = Date.now();
      return this.jwks;
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(GOOGLE_JWKS_URL);
    if (!response.ok) throw new Error(`could not load Google signing keys (${response.status})`);
    this.jwks = (await response.json()) as JwksDocument;
    this.jwksFetchedAt = Date.now();
    return this.jwks;
  }

  async verify(idToken: string): Promise<GoogleProfile> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('a Google ID token has three segments');
    const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
    const header = decodeSegment<{ alg: string; kid?: string; typ?: string }>(headerSegment);
    if (header.alg !== 'RS256') throw new Error(`unsupported token algorithm "${header.alg}"`);
    if (!header.kid) throw new Error('token has no key id');

    const jwks = await this.loadJwks();
    const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
    if (!key) throw new Error('token was signed with an unknown key');
    if (key.kty !== 'RSA') throw new Error('token key is not RSA');

    const publicKey = createPublicKey({
      key: { kty: key.kty, n: key.n, e: key.e },
      format: 'jwk',
    } as never);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${headerSegment}.${payloadSegment}`);
    verifier.end();
    if (!verifier.verify(publicKey, base64UrlToBuffer(signatureSegment))) {
      throw new Error('token signature is not valid');
    }

    const claims = decodeSegment<{
      iss?: string;
      aud?: string;
      exp?: number;
      iat?: number;
      sub?: string;
      email?: string;
      email_verified?: boolean | string;
      name?: string;
    }>(payloadSegment);

    const now = Math.floor((this.options.now ? this.options.now() : Date.now()) / 1000);
    if (!claims.iss || !GOOGLE_ISSUERS.has(claims.iss)) throw new Error('token was not issued by Google');
    if (claims.aud !== this.options.clientId) throw new Error('token was issued for a different client');
    if (!claims.exp || claims.exp < now - CLOCK_SKEW_SECONDS) throw new Error('token has expired');
    if (claims.iat && claims.iat > now + CLOCK_SKEW_SECONDS) throw new Error('token was issued in the future');
    if (!claims.sub || !claims.email) throw new Error('token has no subject or email');
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    if (!emailVerified) throw new Error('the Google account email is not verified');

    return {
      subject: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified,
      name: claims.name,
    };
  }
}

/** Constant-time string comparison for secrets (invite codes, session tokens). */
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
