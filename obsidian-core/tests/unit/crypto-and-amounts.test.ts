/**
 * Unit tests: monetary arithmetic, addresses, signatures and mnemonics.
 */

import { describe, expect, it } from 'vitest';
import { formatObs, parseObs, divRoundHalfUp, applyBasisPoints, MAX_SUPPLY_SEALS } from '../../src/protocol/amount.js';
import {
  generateKeyPair,
  addressFromPublicKey,
  isValidAddress,
  signDigest,
  verifyDigest,
  verifyAddressSignature,
} from '../../src/crypto/keys.js';
import { generateRecoveryPhrase, deriveWallet, isValidRecoveryPhrase } from '../../src/crypto/mnemonic.js';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { sha256, utf8, toHex, fromHex, domainHash } from '../../src/crypto/hash.js';
import { bech32Decode } from '../../src/crypto/bech32.js';
import { encodeSignedTx, signTransaction, validateTxStructure } from '../../src/transactions/encode.js';
import { TxType } from '../../src/protocol/types.js';
import { ERR_MESSAGES, ErrCode, reject } from '../../src/protocol/errors.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { DEVNET, makeWallet } from '../helpers/harness.js';

describe('monetary arithmetic', () => {
  it('represents OBS with 18 decimals exactly', () => {
    expect(parseObs('1')).toBe(10n ** 18n);
    expect(parseObs('0.000166666666666666')).toBe(166_666_666_666_666n);
    expect(formatObs(166_666_666_666_666n)).toBe('0.000166666666666666');
    expect(formatObs(0n)).toBe('0.000000000000000000');
    expect(formatObs(parseObs('100000'))).toBe('100000.000000000000000000');
    expect(formatObs(parseObs('1'), 8)).toBe('1.00000000');
  });

  it('never silently rounds a value with too many decimals', () => {
    expect(() => parseObs('0.0000000000000000001')).toThrow(/decimal places/);
  });

  it('caps the maximum supply at 21,000,000 OBS', () => {
    expect(MAX_SUPPLY_SEALS).toBe(21_000_000n * 10n ** 18n);
  });

  it('uses deterministic integer rounding', () => {
    expect(divRoundHalfUp(1n, 2n)).toBe(1n);
    expect(divRoundHalfUp(1n, 3n)).toBe(0n);
    expect(divRoundHalfUp(5n, 2n)).toBe(3n);
    expect(applyBasisPoints(10_000n, 2)).toBe(2n); // 0.02%
  });
});

describe('gas formula', () => {
  it('charges 0.02% of the transferred amount below the cap', () => {
    expect(expectedGas(parseObs('1'))).toBe(parseObs('0.0002'));
    expect(expectedGas(parseObs('10'))).toBe(parseObs('0.002'));
    expect(expectedGas(parseObs('50'))).toBe(parseObs('0.01'));
  });

  it('caps gas at 0.01 OBS', () => {
    expect(expectedGas(parseObs('1000'))).toBe(parseObs('0.01'));
    expect(expectedGas(parseObs('100000'))).toBe(parseObs('0.01'));
  });

  it('is zero for a zero-value base', () => {
    expect(expectedGas(0n)).toBe(0n);
  });
});

describe('keys and addresses', () => {
  it('derives a valid obs1 bech32 address', () => {
    const pair = generateKeyPair();
    expect(isValidAddress(pair.address)).toBe(true);
    expect(() => bech32Decode(pair.address)).not.toThrow();
  });

  it('rejects a tampered address checksum', () => {
    const pair = generateKeyPair();
    const tampered = `${pair.address.slice(0, -3)}abc`;
    expect(isValidAddress(tampered)).toBe(false);
  });

  it('never derives the same wallet twice', () => {
    const addresses = new Set<string>();
    for (let i = 0; i < 64; i += 1) addresses.add(generateKeyPair().address);
    expect(addresses.size).toBe(64);
  });

  it('binds a signature to the address that controls the key', () => {
    const pair = generateKeyPair();
    const digest = sha256(utf8('obsidian'));
    const signature = toHex(signDigest(digest, pair.privateKey));
    expect(verifyDigest(digest, signature, pair.publicKey)).toBe(true);
    expect(verifyAddressSignature(pair.address, digest, signature, pair.publicKey)).toBe(true);
    const other = generateKeyPair();
    expect(verifyAddressSignature(other.address, digest, signature, pair.publicKey)).toBe(false);
  });

  it('rejects a signature over a different message', () => {
    const pair = generateKeyPair();
    const signature = toHex(signDigest(sha256(utf8('one')), pair.privateKey));
    expect(verifyDigest(sha256(utf8('two')), signature, pair.publicKey)).toBe(false);
  });
});

describe('addresses are bound to one network', () => {
  /**
   * The same key pair produces a different address string per network, and a
   * node must refuse an address that is not its own. This is what stops a
   * wallet made on one network from being used — or mined into — on another.
   */
  const NETWORK_HRPS = [
    ['mainnet', 'obs'],
    ['testnet', 'tobs'],
    ['staging', 'sobs'],
    ['devnet', 'dobs'],
  ] as const;

  it('gives one key pair a different address on every network', () => {
    const pair = generateKeyPair();
    const addresses = NETWORK_HRPS.map(([, hrp]) => addressFromPublicKey(pair.publicKey, hrp));
    expect(new Set(addresses).size).toBe(NETWORK_HRPS.length);
    for (const [index, [name, hrp]] of NETWORK_HRPS.entries()) {
      expect(addresses[index]!.startsWith(`${hrp}1`), `${name} address`).toBe(true);
    }
  });

  it('refuses an address belonging to another network', () => {
    const pair = generateKeyPair();
    for (const [, hrp] of NETWORK_HRPS) {
      const address = addressFromPublicKey(pair.publicKey, hrp);
      expect(isValidAddress(address, hrp)).toBe(true);
      for (const [, other] of NETWORK_HRPS) {
        if (other === hrp) continue;
        expect(isValidAddress(address, other), `${address} must not be valid under ${other}`).toBe(false);
      }
    }
  });

  it('will not accept a signature from the same key under a foreign address', () => {
    // The exploit worth ruling out: take a mainnet-looking address, sign with
    // the key that genuinely controls it, and submit it to devnet. The
    // signature is real; the address is not this network's, so it is refused.
    const pair = generateKeyPair();
    const mainnet = addressFromPublicKey(pair.publicKey, 'obs');
    const digest = sha256(utf8('claim'));
    const signature = toHex(signDigest(digest, pair.privateKey));
    expect(verifyAddressSignature(mainnet, digest, signature, pair.publicKey, 'obs')).toBe(true);
    expect(verifyAddressSignature(mainnet, digest, signature, pair.publicKey, 'dobs')).toBe(false);
  });

  it('re-derives back to the original address, so switching network loses nothing', () => {
    const pair = generateKeyPair();
    const devnet = addressFromPublicKey(pair.publicKey, 'dobs');
    const backToMainnet = addressFromPublicKey(pair.publicKey, 'obs');
    expect(devnet).not.toBe(backToMainnet);
    expect(backToMainnet).toBe(pair.address);
  });
});

describe('recovery phrases', () => {
  it('generates 24-word BIP-39 phrases that validate', () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase.split(' ')).toHaveLength(24);
    expect(isValidRecoveryPhrase(phrase)).toBe(true);
  });

  it('derives deterministically and differently per index', () => {
    const phrase = generateRecoveryPhrase();
    const first = deriveWallet(phrase, 0, 0);
    const again = deriveWallet(phrase, 0, 0);
    const second = deriveWallet(phrase, 0, 1);
    expect(first.address).toBe(again.address);
    expect(first.address).not.toBe(second.address);
  });

  it('never derives a wallet from application identifiers', async () => {
    // The derivation input is the BIP-39 phrase only: two identical phrases give
    // the same wallet, and any change in the phrase changes the wallet.
    const a = generateRecoveryPhrase();
    const b = generateRecoveryPhrase();
    const wa = deriveWallet(a, 0, 0);
    const wb = deriveWallet(b, 0, 0);
    expect(wa.address).not.toBe(wb.address);
    expect(wa.derivationPath).toContain("m/44'/7777'");
    void addressFromPublicKey;
  });
});

describe('hashing hygiene', () => {
  it('domain-separates digests', () => {
    const a = domainHash('DOMAIN_A', utf8('same'));
    const b = domainHash('DOMAIN_B', utf8('same'));
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('round-trips hex', () => {
    const bytes = sha256(utf8('obsidian network'));
    expect(toHex(fromHex(toHex(bytes)))).toBe(toHex(bytes));
    expect(() => fromHex('xyz')).toThrow();
  });
});

describe('transaction structure validation', () => {
  const wallet = makeWallet(DEVNET);

  function signed(overrides: Partial<Parameters<typeof signTransaction>[0]> = {}) {
    return signTransaction({
      sender: wallet.address,
      privateKeyHex: wallet.privateKey,
      publicKeyHex: wallet.publicKey,
      chainId: DEVNET.chainId,
      protocolVersion: '1.0.0',
      nonce: 0,
      type: TxType.PAYMENT,
      gas: 0n,
      body: new Uint8Array(),
      validUntil: 1_000_600,
      ...overrides,
    });
  }

  const context = {
    chainId: DEVNET.chainId,
    supportedProtocolVersions: ['1.0.0'],
    protocolTime: 1_000_000,
    expectedNonce: 0,
    height: 1,
    addressHrp: DEVNET.addressHrp,
  };

  it('accepts a well-formed transaction', () => {
    expect(() => validateTxStructure(signed(), context)).not.toThrow();
  });

  it('rejects a transaction signed for another chain', () => {
    const tx = signed({ chainId: 7777 });
    expect(() => validateTxStructure(tx, context)).toThrow(/chain id/i);
  });

  it('rejects a nonce that is not the account next nonce', () => {
    const tx = signed({ nonce: 7 });
    expect(() => validateTxStructure(tx, { ...context, expectedNonce: 3 })).toThrow(/nonce/i);
  });

  it('rejects expired transactions', () => {
    const tx = signed({ validUntil: 999 });
    expect(() => validateTxStructure(tx, context)).toThrow(/expired/i);
  });

  it('rejects a tampered transaction id', () => {
    const tx = signed();
    const tampered = { ...tx, id: 'ff'.repeat(32) };
    expect(() => validateTxStructure(tampered, context)).toThrow(/id/i);
  });

  it('rejects a tampered amount (signature no longer matches)', () => {
    const tx = signed();
    const tampered = { ...tx, body: Uint8Array.of(1, 2, 3) };
    expect(() => validateTxStructure(tampered, context)).toThrow(/signature/i);
  });

  it('produces a stable signed encoding', () => {
    const tx = signed();
    expect(toHex(encodeSignedTx(tx))).toBe(toHex(encodeSignedTx(tx)));
    expect(encodeSignedTx(tx).length).toBeGreaterThan(100);
  });
});

describe('error catalogue', () => {
  it('documents every error code', () => {
    for (const code of Object.values(ErrCode)) {
      expect(ERR_MESSAGES[code]).toBeTruthy();
    }
  });

  it('carries a machine code when rejecting', () => {
    try {
      reject(ErrCode.BAD_GAS, 'nope');
      expect.unreachable();
    } catch (error) {
      expect((error as { code: string }).code).toBe('ERR_BAD_GAS');
    }
  });
});

/**
 * BIP-32 conformance.
 *
 * These are the official test vectors from the BIP-32 specification. They are
 * here because derivation was once hand-rolled in src/crypto/mnemonic.ts in a
 * way that was not BIP-32 at all — it HMAC'd with the constant "Bitcoin seed"
 * instead of the parent chain code, and used SHA-256 where the spec says
 * SHA-512, so the chain code was an empty slice. Keys derived that way restore
 * in no other wallet, while the exported recovery sheet promised users a
 * standard BIP-44 path. A spec we claim to implement gets its own vectors.
 */
describe('BIP-32 conformance (official test vectors)', () => {
  const vector1 = fromHex('000102030405060708090a0b0c0d0e0f');
  const vector2 = fromHex(
    'fffcf9f6f3f0edeae7e4e1dedbd8d5d2cfccc9c6c3c0bdbab7b4b1aeaba8a5a29f9c999693908d8a8784817e7b7875726f6c696663605d5a5754514e4b484542',
  );

  it('matches vector 1 at m, m/0H and m/0H/1', () => {
    const master = HDKey.fromMasterSeed(vector1);
    expect(master.publicExtendedKey).toBe(
      'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
    );
    expect(master.privateExtendedKey).toBe(
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi',
    );
    expect(master.derive("m/0'").publicExtendedKey).toBe(
      'xpub68Gmy5EdvgibQVfPdqkBBCHxA5htiqg55crXYuXoQRKfDBFA1WEjWgP6LHhwBZeNK1VTsfTFUHCdrfp1bgwQ9xv5ski8PX9rL2dZXvgGDnw',
    );
    expect(master.derive("m/0'/1").publicExtendedKey).toBe(
      'xpub6ASuArnXKPbfEwhqN6e3mwBcDTgzisQN1wXN9BJcM47sSikHjJf3UFHKkNAWbWMiGj7Wf5uMash7SyYq527Hqck2AxYysAA7xmALppuCkwQ',
    );
  });

  it('matches vector 2 at m, m/0 and m/0/2147483647H', () => {
    const master = HDKey.fromMasterSeed(vector2);
    expect(master.publicExtendedKey).toBe(
      'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB',
    );
    expect(master.derive('m/0').publicExtendedKey).toBe(
      'xpub69H7F5d8KSRgmmdJg2KhpAK8SR3DjMwAdkxj3ZuxV27CprR9LgpeyGmXUbC6wb7ERfvrnKZjXoUmmDznezpbZb7ap6r1D3tgFxHmwMkQTPH',
    );
    expect(master.derive("m/0/2147483647'").publicExtendedKey).toBe(
      'xpub6ASAVgeehLbnwdqV6UKMHVzgqAG8Gr6riv3Fxxpj8ksbH9ebxaEyBLZ85ySDhKiLDBrQSARLq1uNRts8RuJiHjaDMBU4Zn9h8LZNnBC5y4a',
    );
  });

  it('matches vector 3, which pins retention of leading zeros', () => {
    const vector3 = fromHex(
      '4b381541583be4423346c643850da4b320e46a87ae3d2a4e6da11eba819cd4acba45d239319ac14f863b8d5ab5a0d0c64d2e8a1e7d1457df2e5a3c51c73235be',
    );
    const master = HDKey.fromMasterSeed(vector3);
    expect(master.publicExtendedKey).toBe(
      'xpub661MyMwAqRbcEZVB4dScxMAdx6d4nFc9nvyvH3v4gJL378CSRZiYmhRoP7mBy6gSPSCYk6SzXPTf3ND1cZAceL7SfJ1Z3GC8vBgp2epUt13',
    );
    expect(master.derive("m/0'").publicExtendedKey).toBe(
      'xpub68NZiKmJWnxxS6aaHmn81bvJeTESw724CRDs6HbuccFQN9Ku14VQrADWgqbhhTHBaohPX4CjNLf9fq9MYo6oDaPPLPxSb7gwQN3ih19Zm4Y',
    );
  });

  it('derives the documented BIP-44 path and keeps indices independent', () => {
    const phrase = generateRecoveryPhrase();
    const first = deriveWallet(phrase, 0, 0, undefined, DEVNET.addressHrp);
    const second = deriveWallet(phrase, 0, 1, undefined, DEVNET.addressHrp);
    expect(first.derivationPath).toBe("m/44'/7777'/0'/0/0");
    expect(second.derivationPath).toBe("m/44'/7777'/0'/0/1");
    expect(first.privateKey).not.toBe(second.privateKey);
    expect(first.address).not.toBe(second.address);
  });

  it('agrees with a plain @scure/bip32 derivation of the same path', () => {
    const phrase = generateRecoveryPhrase();
    const derived = deriveWallet(phrase, 3, 7, undefined, DEVNET.addressHrp);
    const reference = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase)).derive("m/44'/7777'/3'/0/7");
    expect(derived.privateKey).toBe(toHex(reference.privateKey!));
  });

  it('is deterministic: the same phrase always restores the same wallet', () => {
    const phrase = generateRecoveryPhrase();
    expect(deriveWallet(phrase, 0, 0).address).toBe(deriveWallet(phrase, 0, 0).address);
  });
});
