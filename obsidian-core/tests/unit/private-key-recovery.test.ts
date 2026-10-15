/**
 * Private-key recovery: the key shown at creation recovers the same wallet, and every malformed input is refused with a
 * reason that does not echo the input.
 */
import { describe, expect, it } from 'vitest';
import { parsePrivateKeyInput, walletFromPrivateKeyInput } from '../../src/crypto/private-key.js';
import { generateRecoveryPhrase, deriveWallet } from '../../src/crypto/mnemonic.js';
import { generateKeyPair, isValidAddress } from '../../src/crypto/keys.js';
import { secp256k1 } from '@noble/curves/secp256k1';

const ORDER = secp256k1.CURVE.n;
const hex64 = (n: bigint): string => n.toString(16).padStart(64, '0');

describe('private-key recovery: compatibility with phrase creation', () => {
  it('the private key a phrase derives recovers exactly the same address, on every network prefix', () => {
    for (let i = 0; i < 5; i += 1) {
      const phrase = generateRecoveryPhrase();
      for (const hrp of ['obs', 'tobs', 'sobs', 'dobs']) {
        const created = deriveWallet(phrase, 0, 0, undefined, hrp);
        const recovered = walletFromPrivateKeyInput(created.privateKey, hrp);
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) return;
        expect(recovered.address).toBe(created.address);
        expect(recovered.publicKey).toBe(created.publicKey);
        expect(isValidAddress(recovered.address, hrp)).toBe(true);
      }
    }
  });

  it('the standard test phrase gives its known devnet address from its key', () => {
    const phrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const created = deriveWallet(phrase, 0, 0, undefined, 'dobs');
    expect(created.address).toBe('dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0');
    const result = walletFromPrivateKeyInput(created.privateKey, 'dobs');
    expect(result.ok && result.address).toBe('dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0');
  });
});

describe('private-key recovery: accepted encodings', () => {
  const key = generateKeyPair('obs').privateKey;
  it.each([
    ['lowercase', key],
    ['uppercase', key.toUpperCase()],
    ['0x prefix', `0x${key}`],
    ['0X prefix, uppercase', `0X${key.toUpperCase()}`],
    ['surrounding whitespace and newline', `  \n${key}\t\n`],
  ])('accepts %s and normalises to 64 lowercase hex digits', (_name, input) => {
    expect(parsePrivateKeyInput(input)).toEqual({ ok: true, privateKey: key });
  });

  it('accepts the smallest and the largest valid keys (1 and n-1)', () => {
    expect(parsePrivateKeyInput(hex64(1n)).ok).toBe(true);
    expect(parsePrivateKeyInput(hex64(ORDER - 1n)).ok).toBe(true);
  });
});

describe('private-key recovery: refusals', () => {
  const key = generateKeyPair('obs').privateKey;
  const cases: Array<[string, unknown, string]> = [
    ['empty', '', 'EMPTY'],
    ['whitespace only', '   \n ', 'EMPTY'],
    ['only 0x', '0x', 'EMPTY'],
    ['not a string', 12345, 'EMPTY'],
    ['null', null, 'EMPTY'],
    ['too short', key.slice(0, 62), 'WRONG_LENGTH'],
    ['too long', `${key}00`, 'WRONG_LENGTH'],
    ['63 digits', key.slice(1), 'WRONG_LENGTH'],
    ['non-hex letter', `${key.slice(0, 63)}g`, 'NOT_HEX'],
    ['base64', Buffer.from(key, 'hex').toString('base64'), 'NOT_HEX'],
    ['bech32 address', 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj', 'NOT_HEX'],
    ['zero key', hex64(0n), 'NOT_A_VALID_KEY'],
    ['the curve order', hex64(ORDER), 'NOT_A_VALID_KEY'],
    ['above the curve order', hex64(ORDER + 1n), 'NOT_A_VALID_KEY'],
    ['all ff', 'f'.repeat(64), 'NOT_A_VALID_KEY'],
    ['a recovery phrase', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'LOOKS_LIKE_PHRASE'],
    ['key with an inner space', `${key.slice(0, 32)} ${key.slice(32)}`, 'LOOKS_LIKE_PHRASE'],
    ['compressed public key', `02${key}`, 'LOOKS_LIKE_PUBLIC_KEY'],
    ['uncompressed public key', `04${key}${key}`, 'LOOKS_LIKE_PUBLIC_KEY'],
    ['zero-width space inside', `${key.slice(0, 10)}\u200b${key.slice(10)}`, 'NOT_HEX'],
  ];
  it.each(cases)('refuses %s', (_name, input, code) => {
    const result = parsePrivateKeyInput(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(code);
  });

  it('never echoes the input in the refusal', () => {
    for (const [, input] of cases) {
      const result = walletFromPrivateKeyInput(input, 'obs');
      if (result.ok) continue;
      if (typeof input === 'string' && input.trim().length > 8) expect(result.message).not.toContain(input.trim().slice(0, 8));
      expect(JSON.stringify(result)).not.toMatch(/[0-9a-f]{20,}/i);
    }
  });

  it('a refused key produces no wallet at all', () => {
    expect(walletFromPrivateKeyInput('nonsense', 'obs')).toMatchObject({ ok: false });
    expect(walletFromPrivateKeyInput(hex64(0n), 'obs')).not.toHaveProperty('address');
  });
});
