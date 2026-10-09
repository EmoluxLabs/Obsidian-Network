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
import { addressFromPublicKey, verifyDigest } from '../../obsidian-interface/web/core/crypto/keys.js';
import {
  signTransaction,
  signingDigest,
  encodeSignedTx,
  decodeSignedTxFromBytes,
  computeTxId,
} from '../../obsidian-interface/web/core/transactions/encode.js';
import { TxType } from '../../obsidian-interface/web/core/protocol/types.js';
import { decodeMiningBody } from '../../obsidian-interface/web/core/transactions/executors/mining.js';
import { walletFromPhrase, sign, buildMiningBody } from '../web/signing.mjs';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const PINNED_ADDRESS = 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj';
const CHAIN_ID = 7777;

function wallet() {
  const w = deriveWallet(PHRASE, 0, 0);
  return { wallet: w, address: w.address ?? addressFromPublicKey(w.publicKey) };
}

function unsignedFor(address, chainId, extra = {}) {
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
    ...extra,
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

test('the derived address is the pinned one', () => {
  assert.equal(wallet().address, PINNED_ADDRESS);
});

test('a MINING_CLAIM signature verifies against the canonical digest', () => {
  const { wallet: w, address } = wallet();
  const envelope = signWith(w, address, CHAIN_ID);

  assert.equal(Buffer.from(envelope.signature.signature, 'hex').length, 64, 'a secp256k1 signature is 64 bytes');
  // Verified with the core's own verifier, not a second copy of the curve: the
  // app must not be able to disagree with the node about what a valid signature is.
  assert.equal(
    verifyDigest(signingDigest(unsignedFor(address, CHAIN_ID)), envelope.signature.signature, w.publicKey),
    true,
  );
});

test('a signature over a different chainId does NOT verify', () => {
  const { wallet: w, address } = wallet();
  // The negative case. Without it, a verification that passed for any input would
  // look identical to a real one.
  const wrong = signWith(w, address, CHAIN_ID + 1);
  assert.equal(
    verifyDigest(signingDigest(unsignedFor(address, CHAIN_ID)), wrong.signature.signature, w.publicKey),
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

test('the signing entry point names the properties the wallet actually has', () => {
  const recovered = walletFromPhrase(PHRASE);
  assert.equal(recovered.address, PINNED_ADDRESS);
  assert.equal(typeof recovered.privateKeyHex, 'string');
  assert.equal(recovered.privateKeyHex.length, 64);
});

test('the signed bytes round-trip through the node decoder', () => {
  const recovered = walletFromPhrase(PHRASE);
  const unsigned = unsignedFor(recovered.address, CHAIN_ID, {
    nonce: 9,
    body: new Uint8Array([1, 2, 3]),
    validUntil: 1234,
  });
  const { bytes, txId } = sign({ wallet: recovered, ...unsigned });

  const decoded = decodeSignedTxFromBytes(bytes);
  assert.equal(decoded.sender, recovered.address);
  assert.equal(decoded.nonce, 9);
  assert.equal(decoded.gas, 0n);
  assert.equal(decoded.validUntil, 1234);
  assert.deepEqual(decoded.body, new Uint8Array([1, 2, 3]));
  // The transaction id is a commitment to the signature, so it must survive a
  // decode that recomputes it from the bytes on the wire.
  assert.equal(decoded.id, txId);
  assert.equal(decoded.id, computeTxId(unsigned, decoded.signature));
});

test('the envelope carries an id, and there is no `unsigned` field to read one from', () => {
  const recovered = walletFromPhrase(PHRASE);
  const result = sign({ wallet: recovered, ...unsignedFor(recovered.address, CHAIN_ID) });
  assert.match(result.txId, /^[0-9a-f]{64}$/);
  assert.equal(result.envelope.id, result.txId);
  // The bug this pins: callers used to read `envelope.unsigned ?? envelope` and
  // feed it to computeTxId, which yielded nonsense from a field that never existed.
  assert.equal('unsigned' in result.envelope, false);
});

test('a mining body decodes back to the claim id and sequence it was built from', () => {
  const recovered = walletFromPhrase(PHRASE);
  const claimId = 'ab'.repeat(32);
  const { bytes } = sign({
    wallet: recovered,
    ...unsignedFor(recovered.address, CHAIN_ID, {
      type: TxType.MINING_CLAIM,
      body: buildMiningBody({ claimId, claimSequence: 4 }),
    }),
  });
  const decoded = decodeSignedTxFromBytes(bytes);
  assert.deepEqual(decodeMiningBody(decoded.body), { claimId, claimSequence: 4, viaNodeId: undefined });
});

test('gas must be a bigint: undefined would reach the u128 encoder as a crash', () => {
  const recovered = walletFromPhrase(PHRASE);
  assert.throws(
    () => sign({ wallet: recovered, ...unsignedFor(recovered.address, CHAIN_ID, { gas: undefined }) }),
    /gas must be a bigint/,
  );
  assert.throws(
    () => sign({ wallet: recovered, ...unsignedFor(recovered.address, CHAIN_ID, { gas: 0 }) }),
    /gas must be a bigint/,
  );
});

test('the signed encoding is what encodeSignedTx produces', () => {
  const recovered = walletFromPhrase(PHRASE);
  const result = sign({ wallet: recovered, ...unsignedFor(recovered.address, CHAIN_ID) });
  assert.deepEqual(result.bytes, encodeSignedTx(result.envelope));
});

// ── the address prefix belongs to the network ───────────────────────────────

import { retargetAddress } from '../web/signing.mjs';

// Produced by obsidian-core's deriveWallet with each network's addressHrp.
const BY_HRP = {
  obs: 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj',
  tobs: 'tobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rgcp8kr',
  sobs: 'sobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66ra0j5mt',
  dobs: 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0',
};

test('one phrase, one key, a different address on each network', () => {
  const keys = new Set();
  for (const [hrp, expected] of Object.entries(BY_HRP)) {
    const wallet = walletFromPhrase(PHRASE, hrp);
    assert.equal(wallet.address, expected, hrp);
    keys.add(wallet.privateKeyHex);
  }
  assert.equal(keys.size, 1, 'the prefix must never change the key');
});

test('no prefix means the canonical default, which is mainnet', () => {
  assert.equal(walletFromPhrase(PHRASE).address, BY_HRP.obs);
});

test('an unusable prefix is refused rather than encoded', () => {
  for (const bad of ['', 'OBS', 'o b', '1', 'x'.repeat(30), null]) {
    assert.throws(() => walletFromPhrase(PHRASE, bad), /address prefix/, JSON.stringify(bad));
  }
});

test('retargeting changes the checksum and keeps the payload', () => {
  for (const from of Object.keys(BY_HRP)) {
    for (const to of Object.keys(BY_HRP)) {
      assert.equal(retargetAddress(BY_HRP[from], to), BY_HRP[to], `${from} -> ${to}`);
    }
  }
});

test('retargeting refuses a string that is not an address', () => {
  assert.throws(() => retargetAddress('notanaddress', 'obs'));
  // A single flipped character breaks the checksum and must not be silently
  // "converted" into a different, valid address.
  const broken = BY_HRP.obs.slice(0, -1) + (BY_HRP.obs.endsWith('q') ? 'p' : 'q');
  assert.throws(() => retargetAddress(broken, 'dobs'));
});
