/**
 * Proves a MINING_CLAIM signature from this app is cryptographically valid.
 *
 * This is the gate that had to pass before any UI accepts a recovery phrase.
 * Encoding bytes successfully proves nothing on its own; this checks the signature
 * actually verifies against the canonical signing digest, and - just as important -
 * that a signature made over different protocol parameters does NOT verify. That
 * negative case is what proves the digest really binds chainId, rather than the
 * verification happening to pass for any input.
 *
 * What this still does not prove: no node has accepted these bytes. Cryptographic
 * validity and protocol acceptance are different claims, and only a running node can
 * make the second one. Acceptance into a mempool would still not be a confirmation.
 *
 * The phrase is BIP-39's public all-"abandon" test phrase, not a secret.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveWallet } from '../../obsidian-interface/web/core/crypto/mnemonic.js';
import { addressFromPublicKey } from '../../obsidian-interface/web/core/crypto/keys.js';
import { signTransaction, signingDigest } from '../../obsidian-interface/web/core/transactions/encode.js';
import { TxType } from '../../obsidian-interface/web/core/protocol/types.js';
import { secp256k1 } from '@noble/curves/secp256k1';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const PINNED_ADDRESS = 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj';

function wallet() {
  const w = deriveWallet(PHRASE, 0, 0);
  return { wallet: w, address: w.address ?? addressFromPublicKey(w.publicKey) };
}

function unsignedFor(address, chainId) {
  return {
    protocolVersion: '1.6.1',
    chainId,
    sender: address,
    nonce: 0,
    type: TxType.MINING_CLAIM,
    gas: 0n,
    body: new Uint8Array(0),
    memo: undefined,
    validUntil: 0,
  };
}

function signWith(w, address, chainId) {
  return signTransaction({
    sender: address,
    privateKeyHex: w.privateKey,
    publicKeyHex: w.publicKey,
    ...unsignedFor(address, chainId),
  });
}

function signatureBytes(envelope) {
  return new Uint8Array(Buffer.from(envelope.signature.signature, 'hex'));
}

test('the derived address is the pinned one', () => {
  assert.equal(wallet().address, PINNED_ADDRESS);
});

test('a MINING_CLAIM signature verifies against the canonical digest', () => {
  const { wallet: w, address } = wallet();
  const envelope = signWith(w, address, 7777);
  const signature = signatureBytes(envelope);

  assert.equal(signature.length, 64, 'a secp256k1 signature is 64 bytes');
  assert.equal(
    secp256k1.verify(signature, signingDigest(unsignedFor(address, 7777)), w.publicKey),
    true,
  );
});

test('a signature over a different chainId does NOT verify', () => {
  const { wallet: w, address } = wallet();
  // The negative case. Without it, a verification that passed for any input would
  // look identical to a real one.
  const wrong = signatureBytes(signWith(w, address, 7778));
  assert.equal(
    secp256k1.verify(wrong, signingDigest(unsignedFor(address, 7777)), w.publicKey),
    false,
  );
});

test('the wallet exposes privateKey, not privateKeyHex', () => {
  // Pinned because signing.mjs originally read the wrong name and passed undefined,
  // which surfaced as an opaque "Cannot read properties of undefined" deep inside
  // the signer rather than as a clear failure here.
  const { wallet: w } = wallet();
  assert.equal(typeof w.privateKey, 'string');
  assert.equal(w.privateKeyHex, undefined);
});
