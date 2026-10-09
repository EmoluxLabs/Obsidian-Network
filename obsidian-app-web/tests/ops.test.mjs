/**
 * The operations, against a fake node and a real vault.
 *
 * These tests exist because the mistakes this layer can make are invisible from the
 * outside. A claim signed with the wrong nonce is rejected by every node with
 * BAD_NONCE and the app reports "submitted"; a claim body carrying a locally invented
 * id is refused with MINING_BAD_PROOF after the user has already typed their
 * passphrase. Neither is reachable by looking at the screen, so they are pinned here.
 *
 * The vault is the real implementation, exercised with Node's WebCrypto. That is the
 * point: a fake vault would prove the sequencing and nothing about whether the
 * phrase can actually be sealed and opened on a device.
 */

import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// web/vault.mjs is browser code: it reaches for localStorage, which Node does not
// provide. A storage shim is the only thing stood up here, and it is stood up
// before the module is imported so the module-level code sees it.
globalThis.localStorage = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
})();

const { createVault, saveVault, loadVault } = await import('../web/vault.mjs');
const {
  submitClaim,
  submitPayment,
  submitNameRegistration,
  submitNameRenewal,
  submitNameUpdate,
} = await import('../web/ops.mjs');
const { decodeMiningBody } = await import(
  '../../obsidian-interface/web/core/transactions/executors/mining.js'
);
const { decodePaymentBody } = await import(
  '../../obsidian-interface/web/core/transactions/executors/payment.js'
);
const { decodeOnsBody } = await import(
  '../../obsidian-interface/web/core/transactions/executors/ons.js'
);
const { decodeSignedTxFromBytes } = await import(
  '../../obsidian-interface/web/core/transactions/encode.js'
);
const { TxType, OnsOp } = await import('../../obsidian-interface/web/core/protocol/types.js');
const { expectedGas, parseObs } = await import('../web/index.mjs');

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PASSPHRASE = 'correct horse battery staple';
const ADDRESS = 'obs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rxdgrkj';

const OBS = 10n ** 18n;

let sealedVault = null;

before(async () => {
  sealedVault = await createVault(PHRASE, PASSPHRASE, 'dobs');
  saveVault(sealedVault);
});

/** A fake node. Every value a real one would answer, and a record of what was sent. */
function fakeNode(overrides = {}) {
  const sent = [];
  return {
    sent,
    loadVault: () => loadVault(),
    loadAddress: () => ADDRESS,
    requestPassphrase: async () => PASSPHRASE,
    getContext: async () => ({
      chainId: 7777,
      protocolVersion: '1.7.0',
      protocolTime: 1_700_000_000,
    }),
    getNonce: async () => 7,
    getMiningStatus: async () => ({
      eligible: true,
      nextClaimId: 'ab'.repeat(32),
      nextClaimSequence: 3,
      rewardPerClaimObs: '0.000166666666666666',
      secondsRemaining: 0,
    }),
    getBalance: async () => ({ balanceSeals: (10n * OBS).toString(), nonce: 7 }),
    getName: async () => null,
    getGateCertificate: async () => GATE,
    submit: async (hex, txId) => {
      sent.push({ hex, txId });
      return { accepted: true, txId };
    },
    ...overrides,
  };
}

/** What the platform's mining gate would hand back for this wallet and claim. */
const GATE = { issuer: '02'.repeat(33), issuedAt: 1_700_000_000, signature: 'ab'.repeat(64) };

function decodeSent(hex) {
  const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
  return decodeSignedTxFromBytes(bytes);
}

// ── mining ───────────────────────────────────────────────────────────────────

test('a claim carries the platform\'s certificate for this wallet and this claim id', async () => {
  const asked = [];
  const node = fakeNode({
    getGateCertificate: async (address, claimId) => {
      asked.push([address, claimId]);
      return GATE;
    },
  });
  const result = await submitClaim(node);
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(asked, [[ADDRESS, 'ab'.repeat(32)]]);
  const { decodeMiningBody } = await import('../../obsidian-interface/web/core/transactions/executors/mining.js');
  assert.deepEqual(decodeMiningBody(decodeSent(node.sent[0].hex).body).gate, GATE);
});

test('nothing is signed or submitted when the platform refuses the certificate', async () => {
  const node = fakeNode({
    getGateCertificate: async () => {
      throw Object.assign(new Error('mining is closed on this account until you confirm two-factor authentication'), { code: 'ERR_MINING_NOT_ENABLED' });
    },
  });
  const result = await submitClaim(node);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ERR_MINING_NOT_ENABLED');
  assert.match(result.message, /two-factor/);
  assert.equal(node.sent.length, 0);
});

test('an app that cannot ask for a certificate cannot claim, rather than sending a claim the chain refuses', async () => {
  const node = fakeNode({ getGateCertificate: undefined });
  const result = await submitClaim(node);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'GATE_UNAVAILABLE');
  assert.equal(node.sent.length, 0);
});

test('a claim carries the account nonce, not the claim sequence', async () => {
  const node = fakeNode();
  const result = await submitClaim(node);

  assert.equal(result.ok, true, result.message);
  assert.match(result.txId, /^[0-9a-f]{64}$/);
  assert.equal(result.state, 'submitted');
  assert.equal(result.address, ADDRESS);

  const tx = decodeSent(node.sent[0].hex);
  // The regression. The nonce is the account's next transaction number (7 here);
  // the claim sequence is a different counter (3) and belongs in the body.
  // Signing a claim with the sequence as the nonce is refused by every node.
  assert.equal(tx.nonce, 7);
  assert.equal(tx.type, TxType.MINING_CLAIM);
  // A mining claim is free: the executor rejects any other gas value, because new
  // wallets hold exactly 0 OBS by protocol rule.
  assert.equal(tx.gas, 0n);

  const body = decodeMiningBody(tx.body);
  assert.equal(body.claimSequence, 3);
  assert.equal(body.claimId, 'ab'.repeat(32));
});

test('validUntil is protocol time plus the window, never zero and never local time', async () => {
  const node = fakeNode();
  await submitClaim(node);
  const tx = decodeSent(node.sent[0].hex);
  // The first build passed validUntil: 0, which every node rejects as EXPIRED.
  assert.equal(tx.validUntil, 1_700_000_000 + 600);
});

test('the chain id and protocol version come from the node, not from a constant', async () => {
  const node = fakeNode({
    getContext: async () => ({ chainId: 9001, protocolVersion: '9.9.9', protocolTime: 500 }),
  });
  await submitClaim(node);
  const tx = decodeSent(node.sent[0].hex);
  assert.equal(tx.chainId, 9001);
  assert.equal(tx.protocolVersion, '9.9.9');
  assert.equal(tx.validUntil, 500 + 600);
});

test('an ineligible wallet is refused before the phrase is ever decrypted', async () => {
  let askedForPassphrase = false;
  const node = fakeNode({
    getMiningStatus: async () => ({
      eligible: false,
      reason: 'the next claim is not due yet',
      secondsRemaining: 9000,
    }),
    requestPassphrase: async () => {
      askedForPassphrase = true;
      return PASSPHRASE;
    },
  });

  const result = await submitClaim(node);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NOT_ELIGIBLE');
  assert.match(result.message, /not due yet/);
  assert.equal(askedForPassphrase, false);
  assert.equal(node.sent.length, 0);
});

test('a wrong passphrase is a wrong passphrase, not a signing failure', async () => {
  const node = fakeNode({ requestPassphrase: async () => 'not the passphrase' });
  const result = await submitClaim(node);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BAD_PASSPHRASE');
  assert.equal(node.sent.length, 0);
});

test('a cancelled prompt submits nothing', async () => {
  const node = fakeNode({ requestPassphrase: async () => '' });
  const result = await submitClaim(node);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'CANCELLED');
  assert.equal(node.sent.length, 0);
});

test('there is no vault until one is sealed', async () => {
  const node = fakeNode({ loadVault: () => null });
  const result = await submitClaim(node);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NO_VAULT');
});

// ── payments ─────────────────────────────────────────────────────────────────

test('a payment carries the protocol gas for its amount', async () => {
  const node = fakeNode();
  const amount = parseObs('2');
  const result = await submitPayment(node, { to: ADDRESS, amountObs: '2', memo: 'rent' });

  assert.equal(result.ok, true, result.message);
  const tx = decodeSent(node.sent[0].hex);
  assert.equal(tx.type, TxType.PAYMENT);
  assert.equal(tx.gas, expectedGas(amount));
  assert.equal(tx.nonce, 7);

  const body = decodePaymentBody(tx.body);
  assert.equal(body.amount, amount);
  assert.equal(body.to, ADDRESS);
  assert.equal(body.memo, 'rent');
});

test('a payment the balance cannot cover is refused before signing', async () => {
  const node = fakeNode({ getBalance: async () => ({ balanceSeals: (1n * OBS).toString() }) });
  const result = await submitPayment(node, { to: ADDRESS, amountObs: '500' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'INSUFFICIENT_FUNDS');
  assert.equal(node.sent.length, 0);
});

test('an amount the protocol cannot represent is refused, not rounded', async () => {
  const node = fakeNode();
  const result = await submitPayment(node, { to: ADDRESS, amountObs: '1.0000000000000000001' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'BAD_AMOUNT');
  assert.match(result.message, /18 decimal places/);
  assert.equal(node.sent.length, 0);
});

// ── ONS ──────────────────────────────────────────────────────────────────────

test('registering a name offers the consensus fee and gas on that fee', async () => {
  const node = fakeNode();
  const fee = parseObs('0.05');
  const result = await submitNameRegistration(node, { name: 'obsidian.obs', feeObs: '0.05' });

  assert.equal(result.ok, true, result.message);
  const tx = decodeSent(node.sent[0].hex);
  assert.equal(tx.type, TxType.ONS);
  assert.equal(tx.gas, expectedGas(fee));

  const body = decodeOnsBody(tx.body);
  assert.equal(body.op, OnsOp.REGISTER);
  // The executor normalises the name itself; sending "obsidian.obs" would be
  // stored as a name containing a dot.
  assert.equal(body.name, 'obsidian');
  assert.equal(body.fee, fee);
});

test('an already-registered name is refused before signing', async () => {
  const node = fakeNode({
    getName: async () => ({ name: 'taken', owner: 'obs1someoneelse', expiresAt: 9_999_999_999 }),
  });
  const result = await submitNameRegistration(node, { name: 'taken.obs', feeObs: '0.05' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'NAME_TAKEN');
  assert.equal(node.sent.length, 0);
});

test('only the owner may renew or repoint a name', async () => {
  const foreign = fakeNode({
    getName: async () => ({ name: 'mine', owner: 'obs1someoneelse', expiresAt: 9_999_999_999 }),
  });
  assert.equal((await submitNameRenewal(foreign, { name: 'mine.obs', feeObs: '0.05' })).reason, 'NAME_NOT_OWNED');
  assert.equal((await submitNameUpdate(foreign, { name: 'mine.obs', address: ADDRESS })).reason, 'NAME_NOT_OWNED');
  assert.equal(foreign.sent.length, 0);

  const mine = fakeNode({
    getName: async () => ({ name: 'mine', owner: ADDRESS, expiresAt: 9_999_999_999 }),
  });
  const updated = await submitNameUpdate(mine, { name: 'mine.obs', address: ADDRESS });
  assert.equal(updated.ok, true, updated.message);
  // UPDATE_ADDRESS moves no value, so it pays no gas.
  assert.equal(decodeSent(mine.sent[0].hex).gas, 0n);
});

test('no operation leaks the phrase into its return value', async () => {
  const node = fakeNode();
  const result = await submitClaim(node);
  assert.equal(JSON.stringify(result).includes(PHRASE), false);
  assert.equal(JSON.stringify(result).includes(PASSPHRASE), false);
});

test('the sender address is derived under the node’s prefix, not the mainnet default', async () => {
  // The same words are the same key on every network and a different bech32 string
  // on each. A claim signed on devnet for an `obs1…` sender is a claim for an
  // address devnet calls invalid.
  const node = fakeNode({
    getContext: async () => ({
      chainId: 7780,
      addressHrp: 'dobs',
      protocolVersion: '1.7.0',
      protocolTime: 1_700_000_000,
    }),
  });
  const result = await submitClaim(node);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.address, 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0');
  assert.notEqual(result.address, ADDRESS);
});
