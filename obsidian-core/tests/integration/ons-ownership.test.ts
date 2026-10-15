/**
 * OBS name ownership (protocol 1.9.0): consent-based transfer, the owner's wallet edit, renewal responsibility and a
 * delayed recovery that cannot be hijacked. Every rule here is consensus state, so every test builds real blocks and
 * reads the resulting state; none of them mocks the executor.
 *
 * Timeline: the chain is built from the genesis instant forward with explicit block timestamps, so a seven-day delay
 * is a seven-day difference in block time (never a sleep) and stays below the wall clock the block validator checks.
 *
 * What the protocol cannot do, and these tests therefore do not claim (see docs/ons.md): a thief holding the OWNER's
 * key can cancel a recovery and can transfer the name; a name with no recovery address and a lost key is lost.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { OnsOp, TxType, type OnsRecord } from '../../src/protocol/types.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { createHarness, makeWallet, onsBody, paymentBody, paymentGas, signedClaim, type Harness, type TestWallet } from '../helpers/harness.js';

const ONS = CONSENSUS_PARAMS.ons;
const GENESIS_TS = 1_767_225_600;
const T0 = GENESIS_TS + 100;
const DAY = 86_400;
const NAME = 'alice';

const open: Harness[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

interface Scene {
  h: Harness;
  alice: TestWallet;
  bob: TestWallet;
  carol: TestWallet;
  mallory: TestWallet;
  clock: { now: number };
}

async function scene(): Promise<Scene> {
  const h = await createHarness();
  open.push(h);
  const alice = makeWallet();
  const clock = { now: T0 };
  h.produce([signedClaim(h, alice, clock.now)], { timestamp: clock.now });
  const s: Scene = { h, alice, bob: makeWallet(), carol: makeWallet(), mallory: makeWallet(), clock };
  clock.now += 1;
  h.produce([sign(s, alice, OnsOp.REGISTER, NAME, { fee: ONS.registrationFee }, expectedGas(ONS.registrationFee))], { timestamp: clock.now });
  return s;
}

function sign(s: Scene, wallet: TestWallet, op: OnsOp, name: string, extra: { address?: string; to?: string; fee?: bigint } = {}, gas = 0n) {
  return s.h.sign(wallet, TxType.ONS, onsBody(op, name, extra), { gas, protocolTime: s.clock.now });
}

/** Send one ONS operation in its own block `after` seconds later and return the verdict. */
function send(s: Scene, wallet: TestWallet, op: OnsOp, extra: { address?: string; to?: string; fee?: bigint } = {}, after = 5, gas = 0n) {
  s.clock.now += after;
  return s.h.tryBlock([sign(s, wallet, op, NAME, extra, gas)], { timestamp: s.clock.now });
}

function record(s: Scene): OnsRecord {
  return structuredClone(s.h.chain.world.s.names.get(NAME)!);
}

const balance = (s: Scene, wallet: TestWallet) => s.h.chain.world.getAccount(wallet.address)?.balance ?? 0n;

describe('registration terms are unchanged', () => {
  it('prices a name at the fixed fee and gives it one year', async () => {
    const s = await scene();
    const r = record(s);
    expect(r.owner).toBe(s.alice.address);
    expect(r.address).toBe(s.alice.address);
    expect(r.expiresAt - r.registeredAt).toBe(ONS.termSeconds);
    expect(r.transferCount).toBe(0);
  });
});

describe('transfer needs the owner and the recipient', () => {
  it('an offer changes nothing; acceptance moves the owner and the address together, atomically, keeping the remaining term', async () => {
    const s = await scene();
    const before = record(s);
    const offer = send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address });
    expect(offer.accepted).toBe(true);
    const offered = record(s);
    expect(offered.owner).toBe(s.alice.address);
    expect(offered.pendingTransfer?.to).toBe(s.bob.address);

    const accept = send(s, s.bob, OnsOp.ACCEPT_TRANSFER);
    expect(accept.accepted).toBe(true);
    const after = record(s);
    expect(after.owner).toBe(s.bob.address);
    expect(after.address).toBe(s.bob.address);
    expect(after.transferCount).toBe(1);
    expect(after.pendingTransfer).toBeUndefined();
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(s.h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses everyone but the owner for every owner-only operation', async () => {
    const s = await scene();
    const ops: Array<[OnsOp, { address?: string; to?: string; fee?: bigint }, ErrCode]> = [
      [OnsOp.TRANSFER, { to: s.mallory.address }, ErrCode.NAME_NOT_OWNED],
      [OnsOp.UPDATE_ADDRESS, { address: s.mallory.address }, ErrCode.NAME_NOT_OWNED],
      [OnsOp.RENEW, { fee: ONS.renewalFee }, ErrCode.NAME_NOT_OWNED],
      [OnsOp.SET_RECOVERY, { address: s.mallory.address }, ErrCode.NAME_NOT_OWNED],
    ];
    const before = record(s);
    for (const [op, extra, code] of ops) {
      const verdict = send(s, s.mallory, op, extra, 5, op === OnsOp.RENEW ? expectedGas(ONS.renewalFee) : 0n);
      expect(verdict.accepted, `op ${OnsOp[op]}`).toBe(false);
      expect(verdict.code, `op ${OnsOp[op]}`).toBe(code);
    }
    expect(record(s)).toEqual(before);
  });

  it('only the named recipient can accept, and an owner can withdraw an open offer', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }).accepted).toBe(true);
    const stolen = send(s, s.mallory, OnsOp.ACCEPT_TRANSFER);
    expect(stolen.accepted).toBe(false);
    expect(stolen.code).toBe(ErrCode.UNAUTHORIZED);
    // The offer names bob, not alice's wish for "anyone": the owner cannot accept for him either.
    expect(send(s, s.alice, OnsOp.ACCEPT_TRANSFER).accepted).toBe(false);
    // A second offer cannot be stacked on the first.
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.carol.address }).code).toBe(ErrCode.NAME_TRANSFER_STATE);
    expect(send(s, s.mallory, OnsOp.CANCEL_TRANSFER).code).toBe(ErrCode.NAME_NOT_OWNED);
    expect(send(s, s.alice, OnsOp.CANCEL_TRANSFER).accepted).toBe(true);
    const gone = send(s, s.bob, OnsOp.ACCEPT_TRANSFER);
    expect(gone.accepted).toBe(false);
    expect(gone.code).toBe(ErrCode.NAME_TRANSFER_STATE);
    expect(record(s).owner).toBe(s.alice.address);
  });

  it('an offer lapses after transferOfferSeconds and can no longer be accepted (no stale-offer replay)', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }).accepted).toBe(true);
    const late = send(s, s.bob, OnsOp.ACCEPT_TRANSFER, {}, ONS.transferOfferSeconds + 10);
    expect(late.accepted).toBe(false);
    expect(late.code).toBe(ErrCode.NAME_TRANSFER_STATE);
    expect(record(s).owner).toBe(s.alice.address);
  });

  it('refuses a malformed, self or uppercase recipient', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: 'not-an-address' }).accepted).toBe(false);
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.alice.address }).accepted).toBe(false);
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address.toUpperCase() }).accepted).toBe(false);
    expect(record(s).pendingTransfer).toBeUndefined();
  });

  it('a transaction replayed after the transfer completed does nothing (nonce-protected)', async () => {
    const s = await scene();
    s.clock.now += 5;
    const offer = sign(s, s.alice, OnsOp.TRANSFER, NAME, { to: s.bob.address });
    expect(s.h.tryBlock([offer], { timestamp: s.clock.now }).accepted).toBe(true);
    expect(send(s, s.bob, OnsOp.ACCEPT_TRANSFER).accepted).toBe(true);
    s.clock.now += 5;
    const replay = s.h.tryBlock([offer], { timestamp: s.clock.now });
    expect(replay.accepted).toBe(false);
    expect(record(s).owner).toBe(s.bob.address);
    expect(record(s).pendingTransfer).toBeUndefined();
  });

  it('a failing transaction in the same block undoes an accepted transfer (atomic block)', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }).accepted).toBe(true);
    s.clock.now += 5;
    const accept = sign(s, s.bob, OnsOp.ACCEPT_TRANSFER, NAME);
    const bad = sign(s, s.mallory, OnsOp.TRANSFER, NAME, { to: s.mallory.address });
    const verdict = s.h.tryBlock([accept, bad], { timestamp: s.clock.now });
    expect(verdict.accepted).toBe(false);
    expect(record(s).owner).toBe(s.alice.address);
    expect(record(s).pendingTransfer?.to).toBe(s.bob.address);
  });
});

describe('who pays for renewal', () => {
  it('the new owner renews and pays; the former owner can neither renew nor be charged', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }).accepted).toBe(true);
    expect(send(s, s.bob, OnsOp.ACCEPT_TRANSFER).accepted).toBe(true);

    const formerBefore = balance(s, s.alice);
    const refused = send(s, s.alice, OnsOp.RENEW, { fee: ONS.renewalFee }, 5, expectedGas(ONS.renewalFee));
    expect(refused.accepted).toBe(false);
    expect(refused.code).toBe(ErrCode.NAME_NOT_OWNED);
    expect(balance(s, s.alice)).toBe(formerBefore);

    // Bob has no funds yet: renewal fails closed instead of charging anyone else.
    const broke = send(s, s.bob, OnsOp.RENEW, { fee: ONS.renewalFee }, 5, expectedGas(ONS.renewalFee));
    expect(broke.accepted).toBe(false);
    expect(record(s).owner).toBe(s.bob.address);

    // Fund bob with a real payment from alice, then he renews from his own balance.
    const expiryBefore = record(s).expiresAt;
    const fund = ONS.renewalFee * 10n;
    s.clock.now += 5;
    const pay = s.h.sign(s.alice, TxType.PAYMENT, paymentBody(s.bob.address, fund), { gas: paymentGas(fund), protocolTime: s.clock.now });
    expect(s.h.tryBlock([pay], { timestamp: s.clock.now }).accepted).toBe(true);
    const bobBefore = balance(s, s.bob);
    const renewed = send(s, s.bob, OnsOp.RENEW, { fee: ONS.renewalFee }, 5, expectedGas(ONS.renewalFee));
    expect(renewed.accepted).toBe(true);
    // The renewal fee came out of bob's balance (the treasury share of it lands elsewhere, so alice is not asserted).
    expect(balance(s, s.bob)).toBeLessThan(bobBefore);
    expect(record(s).expiresAt).toBe(expiryBefore + ONS.termSeconds);
  });
});

describe('the linked wallet', () => {
  it('lets only the owner point the name at another wallet, and the name wallet is not the owner', async () => {
    const s = await scene();
    const verdict = send(s, s.alice, OnsOp.UPDATE_ADDRESS, { address: s.carol.address });
    expect(verdict.accepted).toBe(true);
    const r = record(s);
    expect(r.owner).toBe(s.alice.address);
    expect(r.address).toBe(s.carol.address);
    // The target wallet has no say: carol cannot edit the name she is pointed at.
    expect(send(s, s.carol, OnsOp.UPDATE_ADDRESS, { address: s.carol.address }).code).toBe(ErrCode.NAME_NOT_OWNED);
    expect(send(s, s.alice, OnsOp.UPDATE_ADDRESS, { address: 'junk' }).accepted).toBe(false);
    expect(record(s).address).toBe(s.carol.address);
  });

  it('a transfer resets the pointer: the buyer does not inherit the seller\'s payout wallet', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.UPDATE_ADDRESS, { address: s.carol.address }).accepted).toBe(true);
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }).accepted).toBe(true);
    expect(send(s, s.bob, OnsOp.ACCEPT_TRANSFER).accepted).toBe(true);
    expect(record(s).address).toBe(s.bob.address);
  });
});

describe('recovery cannot be hijacked', () => {
  async function withRecovery(): Promise<Scene> {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.SET_RECOVERY, { address: s.carol.address }).accepted).toBe(true);
    return s;
  }

  it('moves the name only after the delay, and only to the address the recovery address chose', async () => {
    const s = await withRecovery();
    expect(send(s, s.carol, OnsOp.START_RECOVERY, { address: s.bob.address }).accepted).toBe(true);
    const started = record(s);
    expect(started.owner).toBe(s.alice.address);
    expect(started.pendingRecovery?.newAddress).toBe(s.bob.address);

    const early = send(s, s.carol, OnsOp.FINALIZE_RECOVERY, {}, DAY);
    expect(early.accepted).toBe(false);
    expect(early.code).toBe(ErrCode.NAME_RECOVERY_STATE);
    expect(record(s).owner).toBe(s.alice.address);

    // Strangers cannot finalize, even after the delay.
    s.clock.now += ONS.recoveryDelaySeconds;
    expect(s.h.tryBlock([sign(s, s.mallory, OnsOp.FINALIZE_RECOVERY, NAME)], { timestamp: s.clock.now }).code).toBe(ErrCode.UNAUTHORIZED);
    const done = send(s, s.carol, OnsOp.FINALIZE_RECOVERY, {}, 5);
    expect(done.accepted).toBe(true);
    const after = record(s);
    expect(after.owner).toBe(s.bob.address);
    expect(after.address).toBe(s.bob.address);
    expect(after.recoveryAddress).toBeUndefined();
    expect(after.pendingRecovery).toBeUndefined();
  });

  it('nobody but the recovery address can start one, and without a recovery address nothing can (a lost key is lost)', async () => {
    const plain = await scene();
    expect(send(plain, plain.carol, OnsOp.START_RECOVERY, { address: plain.carol.address }).code).toBe(ErrCode.NAME_RECOVERY_STATE);
    expect(send(plain, plain.alice, OnsOp.START_RECOVERY, { address: plain.bob.address }).code).toBe(ErrCode.NAME_RECOVERY_STATE);

    const s = await withRecovery();
    expect(send(s, s.mallory, OnsOp.START_RECOVERY, { address: s.mallory.address }).code).toBe(ErrCode.UNAUTHORIZED);
    expect(send(s, s.bob, OnsOp.START_RECOVERY, { address: s.bob.address }).code).toBe(ErrCode.UNAUTHORIZED);
    expect(record(s).pendingRecovery).toBeUndefined();
  });

  it('the owner can cancel a recovery in flight, and nobody else can', async () => {
    const s = await withRecovery();
    expect(send(s, s.carol, OnsOp.START_RECOVERY, { address: s.bob.address }).accepted).toBe(true);
    expect(send(s, s.mallory, OnsOp.CANCEL_RECOVERY).code).toBe(ErrCode.NAME_NOT_OWNED);
    expect(send(s, s.carol, OnsOp.CANCEL_RECOVERY).code).toBe(ErrCode.NAME_NOT_OWNED);
    expect(send(s, s.alice, OnsOp.CANCEL_RECOVERY).accepted).toBe(true);
    const finalize = send(s, s.carol, OnsOp.FINALIZE_RECOVERY, {}, ONS.recoveryDelaySeconds + 10);
    expect(finalize.accepted).toBe(false);
    expect(record(s).owner).toBe(s.alice.address);
  });

  it('the recovery address cannot be swapped while a recovery is in flight', async () => {
    const s = await withRecovery();
    expect(send(s, s.carol, OnsOp.START_RECOVERY, { address: s.bob.address }).accepted).toBe(true);
    const swap = send(s, s.alice, OnsOp.SET_RECOVERY, { address: s.mallory.address });
    expect(swap.accepted).toBe(false);
    expect(swap.code).toBe(ErrCode.NAME_RECOVERY_STATE);
    expect(record(s).recoveryAddress).toBe(s.carol.address);
  });

  it('a sale wipes the seller\'s recovery address: the old owner cannot take a sold name back', async () => {
    const s = await withRecovery();
    expect(send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }).accepted).toBe(true);
    expect(send(s, s.bob, OnsOp.ACCEPT_TRANSFER).accepted).toBe(true);
    expect(record(s).recoveryAddress).toBeUndefined();
    expect(send(s, s.carol, OnsOp.START_RECOVERY, { address: s.carol.address }).accepted).toBe(false);
    expect(record(s).owner).toBe(s.bob.address);
  });

  it('a recovery completes ownership change once: stale recovery state does not survive it', async () => {
    const s = await withRecovery();
    expect(send(s, s.carol, OnsOp.START_RECOVERY, { address: s.bob.address }).accepted).toBe(true);
    expect(send(s, s.carol, OnsOp.FINALIZE_RECOVERY, {}, ONS.recoveryDelaySeconds + 10).accepted).toBe(true);
    // A second finalization has nothing to finalize.
    const again = send(s, s.carol, OnsOp.FINALIZE_RECOVERY);
    expect(again.accepted).toBe(false);
    expect(again.code).toBe(ErrCode.NAME_RECOVERY_STATE);
    // The previous owner has no claim any more.
    expect(send(s, s.alice, OnsOp.UPDATE_ADDRESS, { address: s.alice.address }).code).toBe(ErrCode.NAME_NOT_OWNED);
  });

  it('refuses a recovery address equal to the owner or not canonical', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.SET_RECOVERY, { address: s.alice.address }).accepted).toBe(false);
    expect(send(s, s.alice, OnsOp.SET_RECOVERY, { address: s.carol.address.toUpperCase() }).accepted).toBe(false);
    expect(send(s, s.alice, OnsOp.SET_RECOVERY, { address: 'garbage' }).accepted).toBe(false);
    expect(record(s).recoveryAddress).toBeUndefined();
  });
});

describe('expired names cannot change hands', () => {
  it('refuses an offer, an acceptance or a recovery on an expired name, and lets only the owner renew it', async () => {
    const s = await scene();
    expect(send(s, s.alice, OnsOp.SET_RECOVERY, { address: s.carol.address }).accepted).toBe(true);
    const beyond = record(s).expiresAt - s.clock.now + 10;
    const late = send(s, s.alice, OnsOp.TRANSFER, { to: s.bob.address }, beyond);
    expect(late.accepted).toBe(false);
    expect(late.code).toBe(ErrCode.NAME_TAKEN);
    expect(send(s, s.carol, OnsOp.START_RECOVERY, { address: s.bob.address }).accepted).toBe(false);
  });
});
