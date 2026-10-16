/**
 * Audit finding (2.0.1): Bech32 accepts an ALL-UPPERCASE address, and a PAYMENT to that spelling used to be credited to
 * an account keyed by the uppercase string — one no key can ever sign for, so the funds were gone for good. QR codes
 * routinely produce uppercase text. Consensus now refuses any non-canonical spelling that would become a ledger key,
 * and the shared encoders lower-case an all-uppercase address before it is signed, so a pasted QR payload still works.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ErrCode } from '../../src/protocol/errors.js';
import { Writer } from '../../src/protocol/encoding.js';
import { OnsOp, TxType } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { canonicalAddressText } from '../../src/crypto/keys.js';
import { decodePaymentBody, encodePaymentBody } from '../../src/transactions/executors/payment.js';
import { decodeOnsBody, encodeOnsBody } from '../../src/transactions/executors/ons.js';
import { createHarness, makeWallet, parseObs, signedClaim, type Harness } from '../helpers/harness.js';

const T0 = 1_767_225_600 + 100;
const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

function rawPayment(to: string, amount: bigint): Uint8Array {
  const w = new Writer();
  w.string(to);
  w.u128(amount);
  w.string('');
  return w.finish();
}

describe('canonical addresses', () => {
  it('canonicalAddressText lower-cases an all-uppercase address and nothing else', () => {
    const a = makeWallet().address;
    expect(canonicalAddressText(a.toUpperCase())).toBe(a);
    expect(canonicalAddressText(` ${a.toUpperCase()} `)).toBe(a);
    expect(canonicalAddressText(a)).toBe(a);
    const mixed = a.slice(0, 5).toUpperCase() + a.slice(5);
    expect(canonicalAddressText(mixed)).toBe(mixed); // mixed case is not Bech32: left alone, so it stays invalid
    expect(canonicalAddressText('')).toBe('');
  });

  it('the shared encoders write the canonical spelling', () => {
    const to = makeWallet().address;
    expect(decodePaymentBody(encodePaymentBody({ to: to.toUpperCase(), amount: 5n })).to).toBe(to);
    expect(decodeOnsBody(encodeOnsBody({ op: OnsOp.UPDATE_ADDRESS, name: 'abc', fee: 0n, address: to.toUpperCase() })).address).toBe(to);
  });

  it('a payment whose recipient is spelled in uppercase is refused, not credited to an unspendable phantom account', async () => {
    const h = await createHarness();
    open.push(h);
    const alice = makeWallet();
    const bob = makeWallet();
    h.produce([signedClaim(h, alice, T0)], { timestamp: T0 });
    const amount = parseObs('10');
    const gas = expectedGas(amount);
    const before = h.chain.world.getAccount(alice.address)!.balance;
    const upper = bob.address.toUpperCase();
    const bad = h.sign(alice, TxType.PAYMENT, rawPayment(upper, amount), { gas, protocolTime: T0 + 5 });
    const verdict = h.tryBlock([bad], { timestamp: T0 + 5 });
    expect(verdict.accepted).toBe(false);
    expect(verdict.code).toBe(ErrCode.BAD_ADDRESS);
    expect(h.chain.world.s.accounts.has(upper)).toBe(false);
    expect(h.chain.world.getAccount(alice.address)!.balance).toBe(before);
    // the same payment through the encoder (what every client uses) lands on the real account
    const good = h.sign(alice, TxType.PAYMENT, encodePaymentBody({ to: upper, amount }), { gas, protocolTime: T0 + 6 });
    h.produce([good], { timestamp: T0 + 6 });
    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(amount);
    expect(h.chain.world.s.accounts.has(upper)).toBe(false);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});
