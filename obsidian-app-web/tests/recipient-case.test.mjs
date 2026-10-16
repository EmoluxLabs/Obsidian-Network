/**
 * A recipient typed or scanned in capitals (a QR code usually carries one) must be signed as the lowercase address.
 * Consensus (2.0.1) refuses any other form with ERR_BAD_ADDRESS, so a client that signed the capitals would produce a
 * transaction the chain rejects, and before 2.0.1 one that credited an account nobody can sign for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletFromPhrase, buildPaymentBody, buildOnsBody, OnsOp } from '../web/signing.mjs';

const PHRASE = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('a payment to an all-uppercase address is encoded exactly like the lowercase one', () => {
  const wallet = walletFromPhrase(PHRASE, 'obs');
  const lower = wallet.address;
  assert.equal(lower, lower.toLowerCase());
  const a = buildPaymentBody({ to: lower, amount: 1000000000000000000n });
  const b = buildPaymentBody({ to: lower.toUpperCase(), amount: 1000000000000000000n });
  assert.deepEqual(Array.from(b), Array.from(a));
});

test('an UPDATE_ADDRESS pointer in capitals is encoded as the lowercase address', () => {
  const lower = walletFromPhrase(PHRASE, 'obs').address;
  const a = buildOnsBody({ op: OnsOp.UPDATE_ADDRESS, name: 'alice', address: lower });
  const b = buildOnsBody({ op: OnsOp.UPDATE_ADDRESS, name: 'alice', address: lower.toUpperCase() });
  assert.deepEqual(Array.from(b), Array.from(a));
});
