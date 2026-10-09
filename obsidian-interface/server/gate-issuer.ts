/**
 * The mining gate issuer (protocol 1.7.0).
 *
 * The chain accepts a MINING_CLAIM only with a certificate signed by an issuer key committed in genesis. This
 * platform holds that key and signs a certificate for a wallet and a claim id ONLY for a signed-in account whose
 * second factor is confirmed and whose one linked wallet is that wallet (see InterfaceServer.mintGateCertificate).
 *
 * THE KEY
 *   Stored encrypted (AES-256-GCM, scrypt) in the same format as the node keystore, produced by
 *   `scripts/generate-mining-gate-key.mjs`; the passphrase comes from the environment or a 0600 file. It is read once
 *   at startup, kept in memory only, and never logged, returned or written. If a keystore is configured and cannot be
 *   opened the interface refuses to start: a half-working issuer must not look like a working one.
 *
 * NO KEY, NO CERTIFICATES
 *   Without a configured issuer the platform answers ERR_GATE_UNAVAILABLE and mining stays closed. It never signs
 *   with a default, a generated or a borrowed key.
 *
 * Signing and verification are the core's own code, loaded from the synced core directory: there is no second
 * implementation of the certificate format here.
 */

import { createDecipheriv, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface GateCertificate {
  issuer: string;
  issuedAt: number;
  signature: string;
}

export interface GateSubject {
  networkId: string;
  chainId: number;
  address: string;
  claimId: string;
}

export interface GateIssuer {
  /** The public key a node must list in OBSIDIAN_MINING_GATE_PUBLIC_KEYS for these certificates to count. */
  readonly publicKey: string;
  issue(subject: GateSubject, issuedAt: number): GateCertificate;
}

interface KeystoreFile {
  version?: number;
  kdf?: string;
  kdfParams?: { N?: number; r?: number; p?: number; salt?: string };
  cipher?: string;
  iv?: string;
  ciphertext?: string;
  tag?: string;
  publicKeyHash?: string;
  publicKey?: string;
}

/** scrypt cost floor: a keystore written with weaker parameters is refused rather than trusted. */
const MIN_SCRYPT_N = 1 << 15;

export function gatePassphraseFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE;
  const value = env.OBSIDIAN_GATE_KEYSTORE_PASSPHRASE ?? (file && existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined);
  return value && value.length >= 12 ? value : undefined;
}

export async function loadGateIssuer(options: { keystorePath: string; passphrase: string; coreDir: string }): Promise<GateIssuer> {
  const load = (relative: string) => import(pathToFileURL(join(options.coreDir, relative)).href);
  const [keys, gate] = await Promise.all([load('crypto/keys.js'), load('mining/gate.js')]);

  if (!existsSync(options.keystorePath)) throw new Error(`mining gate keystore not found: ${options.keystorePath}`);
  const file = JSON.parse(readFileSync(options.keystorePath, 'utf8')) as KeystoreFile;
  const params = file.kdfParams;
  if (file.version !== 1 || file.kdf !== 'scrypt' || file.cipher !== 'aes-256-gcm' || !params?.salt || !file.iv || !file.ciphertext || !file.tag || !file.publicKeyHash) {
    throw new Error('mining gate keystore: unsupported or incomplete format');
  }
  const { N, r, p } = params;
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p) || (N as number) < MIN_SCRYPT_N || (N as number) > 1 << 20 || (r as number) < 1 || (r as number) > 16 || (p as number) < 1 || (p as number) > 4) {
    throw new Error('mining gate keystore: key derivation parameters are outside the accepted range');
  }
  const derived = scryptSync(options.passphrase, Buffer.from(params.salt, 'hex'), 32, { N, r, p, maxmem: 512 * 1024 * 1024 });
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', derived, Buffer.from(file.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
    plain = Buffer.concat([decipher.update(Buffer.from(file.ciphertext, 'hex')), decipher.final()]);
  } catch {
    throw new Error('mining gate keystore: could not decrypt (wrong passphrase, or the file is damaged)');
  } finally {
    derived.fill(0);
  }
  const pair = keys.keyPairFromPrivateKey(new Uint8Array(plain)) as { privateKey: string; publicKey: string };
  plain.fill(0);
  const expected = Buffer.from(file.publicKeyHash, 'hex');
  const actual = createHash('sha256').update(pair.publicKey).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual) || (file.publicKey && file.publicKey !== pair.publicKey)) {
    throw new Error('mining gate keystore: integrity check failed (public key mismatch)');
  }

  const privateKey = pair.privateKey;
  const publicKey = pair.publicKey;
  return {
    publicKey,
    issue(subject, issuedAt) {
      const certificate = gate.issueMiningGateCertificate(privateKey, publicKey, subject, issuedAt) as GateCertificate;
      // Self-check with the chain's own verifier, so a signing fault can never leave this process as a certificate.
      gate.assertMiningGate([publicKey], certificate, subject, issuedAt);
      return certificate;
    },
  };
}
