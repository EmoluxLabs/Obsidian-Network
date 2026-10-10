import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bundle, newWallet } from './helpers.mjs';
import {
  esc, parseRecipient, parseAmount, exactObs, maskAddress, classifyHistory, confirmationsAt, nextTxState, isFinalState,
  describeSubmitFailure, readBackup, BACKUP_LIMITS, checkNewPassword, normalisePhrase, createIdleLock, unlockDelaySeconds,
  readRecords, writeRecords, sanitiseRecord, SUBMITTED_KEY,
} from '../public/lib/pure.mjs';

const read = bundle.readScanned;
const OBS = 10n ** 18n;

// ── text ─────────────────────────────────────────────────────────────────────

test('esc neutralises every character that can open markup or end an attribute', () => {
  const hostile = `<img src=x onerror=alert(1)>"'\`&`;
  const out = esc(hostile);
  assert.ok(!/[<>"'`]/.test(out));
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(0), '0');
});

// ── recipients ───────────────────────────────────────────────────────────────

test('a recipient is a real, checksummed address of THIS network, and nothing else', () => {
  const me = newWallet('dobs');
  const you = newWallet('dobs');
  const ok = parseRecipient(you.address, { hrp: 'dobs', own: me.address, readScanned: read });
  assert.deepEqual(ok, { ok: true, value: you.address });
  assert.ok(parseRecipient(` ${you.address}\n`, { hrp: 'dobs', own: me.address, readScanned: read }).ok, 'surrounding whitespace is trimmed');
  assert.ok(parseRecipient(you.address.toUpperCase(), { hrp: 'dobs', own: me.address, readScanned: read }).ok, 'bech32 may be all upper case');

  const bad = (text, why) => {
    const v = parseRecipient(text, { hrp: 'dobs', own: me.address, readScanned: read });
    assert.equal(v.ok, false, why);
    assert.ok(v.message.length > 5, why);
    return v;
  };
  bad('', 'empty');
  bad(me.address, 'own address');
  bad(`obsidian:${you.address}`, 'a payment-link scheme');
  bad(`${you.address}?amount=5`, 'a query');
  bad(`${you.address}#x`, 'a fragment');
  bad(`${you.address} extra`, 'text after');
  bad(`${you.address}\u200b`, 'a hidden character');
  bad('alice.obs', 'a name');
  bad(you.address.slice(0, -1) + (you.address.endsWith('q') ? 'p' : 'q'), 'a broken checksum');
  bad(you.address.slice(0, 20) + you.address.slice(20).toUpperCase(), 'mixed case');
  bad(`${'a'.repeat(200)}`, 'very long');
  bad('javascript:alert(1)', 'a script URL');
  bad('https://evil.example/' + you.address, 'a link');
  for (const other of ['obs', 'tobs', 'sobs']) {
    const foreign = newWallet(other);
    const v = bad(foreign.address, `${other} address on a devnet wallet`);
    assert.match(v.message, /address|network|app/i);
  }
});

// ── amounts ──────────────────────────────────────────────────────────────────

test('amounts are exact: no float, no rounding, no sign, no exponent', () => {
  assert.equal(parseAmount('1').seals, OBS);
  assert.equal(parseAmount('0.000000000000000001').seals, 1n);
  assert.equal(parseAmount('12.5').seals, 12n * OBS + OBS / 2n);
  assert.equal(parseAmount('0.1').seals, OBS / 10n);
  for (const bad of ['', '0', '0.0', '-1', '+1', '1e3', '1,5', '1.5.5', '.5', '5.', 'abc', '0x10', '1 2', '0.0000000000000000001', '١٢']) {
    assert.equal(parseAmount(bad).ok, false, `"${bad}" must be refused`);
  }
  assert.equal(parseAmount('9007199254740993').seals, 9007199254740993n * OBS, 'above 2^53 stays exact');
});

test('exactObs shows every digit and agrees with the protocol formatter', () => {
  for (const seals of [0n, 1n, 166666666666666n, OBS, 12n * OBS + 1n, 21_000_000n * OBS]) {
    assert.equal(exactObs(seals), bundle.formatObs(seals).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  }
  assert.equal(exactObs(0n), '0');
  assert.equal(exactObs(OBS), '1');
  assert.equal(exactObs(166666666666666n), '0.000166666666666666');
  assert.equal(exactObs(null), '—');
});

test('the fee shown is the protocol fee for that amount', () => {
  for (const text of ['0.001', '1', '50', '123456.789']) {
    const { seals } = parseAmount(text);
    assert.equal(bundle.expectedGas(seals) > 0n, true);
  }
});

// ── history ──────────────────────────────────────────────────────────────────

test('history rows are classified from the node masked values, and mining is not a transfer', () => {
  const me = newWallet().address;
  const m = maskAddress(me);
  const other = maskAddress(newWallet().address);
  const sent = classifyHistory({ txId: 'a', sender: m, recipient: other, amount: '5', gas: '1' }, me);
  assert.equal(sent.dir, 'sent');
  assert.equal(sent.amount, 5n);
  assert.equal(sent.gas, 1n);
  const got = classifyHistory({ txId: 'b', sender: other, recipient: m, amount: '7', gas: '1' }, me);
  assert.equal(got.dir, 'received');
  assert.equal(got.gas, 0n, 'the receiver does not pay the fee');
  const mined = classifyHistory({ txId: 'c', sender: m, kind: 'MINING_CLAIM', gas: '0' }, me);
  assert.equal(mined.dir, 'mining');
  assert.equal(mined.label, 'Mining reward');
  const ons = classifyHistory({ txId: 'd', sender: m, kind: 'ONS_REGISTER', gas: '0' }, me);
  assert.equal(ons.dir, 'other');
  assert.equal(ons.label, 'Name Register');
  assert.equal(classifyHistory({ txId: 'e', sender: other, recipient: other, amount: '1', gas: '1' }, me).dir, 'other');
  assert.equal(classifyHistory({ txId: 'f', sender: m, recipient: m, amount: '1', gas: '1' }, me).dir, 'self');
  assert.equal(classifyHistory({}, me).dir, 'other', 'a malformed row is not a crash');
  assert.equal(confirmationsAt(10, 10), 1);
  assert.equal(confirmationsAt(10, 14), 5);
  assert.equal(confirmationsAt(10, 9), null);
  assert.equal(confirmationsAt(undefined, 9), null);
});

// ── the life of a transaction ────────────────────────────────────────────────

test('a transaction is only called what was observed', () => {
  const clock = { validUntil: 1000, chainTime: 900 };
  assert.equal(nextTxState('submitted', { kind: 'pending' }, clock).state, 'pending');
  assert.equal(nextTxState('submitted', { kind: 'confirmed', confirmations: 3 }, clock).state, 'confirmed');
  assert.equal(nextTxState('pending', { kind: 'confirmed', confirmations: 3 }, clock).confirmations, 3);
  // not seen is not the same as gone
  const unseen = nextTxState('submitted', { kind: 'missing' }, clock);
  assert.equal(unseen.state, 'submitted');
  assert.equal(unseen.unseen, true);
  assert.equal(nextTxState('pending', { kind: 'missing' }, clock).state, 'pending');
  // expired only by the chain's clock, never by this device's
  assert.equal(nextTxState('submitted', { kind: 'missing' }, { validUntil: 1000, chainTime: 1000 }).state, 'submitted');
  assert.equal(nextTxState('submitted', { kind: 'missing' }, { validUntil: 1000, chainTime: 1001 }).state, 'expired');
  assert.equal(nextTxState('submitted', { kind: 'missing' }, { validUntil: 1000, chainTime: null }).state, 'submitted');
  // an unreachable node changes nothing
  const dark = nextTxState('pending', { kind: 'error' }, clock);
  assert.equal(dark.state, 'pending');
  assert.equal(dark.unreachable, true);
  // confirmed does not un-confirm; rejected stays rejected
  assert.equal(nextTxState('confirmed', { kind: 'missing' }, { validUntil: 1, chainTime: 99 }).state, 'confirmed');
  assert.equal(nextTxState('rejected', { kind: 'confirmed', confirmations: 1 }, clock).state, 'rejected');
  // a late sighting of an "expired" transaction is still believed
  assert.equal(nextTxState('expired', { kind: 'confirmed', confirmations: 1 }, clock).state, 'confirmed');
  assert.deepEqual(['confirmed', 'rejected', 'expired'].map(isFinalState), [true, true, true]);
  assert.deepEqual(['submitted', 'pending', 'failed', 'signed'].map(isFinalState), [false, false, false, false]);
});

test('a failed submit is "rejected" only when the node said no', () => {
  assert.equal(describeSubmitFailure({ refusedByNode: true, message: 'BAD_NONCE' }).state, 'rejected');
  const unknown = describeSubmitFailure({ refusedByNode: false, message: 'fetch failed' });
  assert.equal(unknown.state, 'failed');
  assert.match(unknown.title, /may not have reached/);
  assert.equal(describeSubmitFailure({ refusedByNode: false }).detail.length > 0, true);
});

// ── backups ──────────────────────────────────────────────────────────────────

test('an encrypted backup is checked before any key is derived from it', async () => {
  const w = newWallet();
  const vault = await bundle.createVault(w.phrase, 'a password of sufficient length', 'dobs');
  const good = readBackup(JSON.stringify(vault));
  assert.equal(good.ok, true);
  assert.equal(await bundle.openVault(good.envelope, 'a password of sufficient length'), w.phrase);
  await assert.rejects(bundle.openVault(good.envelope, 'the wrong password entirely'), bundle.PassphraseError);

  const bad = (obj, why) => assert.equal(readBackup(typeof obj === 'string' ? obj : JSON.stringify(obj)).ok, false, why);
  bad('', 'empty');
  bad('not json', 'garbage');
  bad('[]', 'an array');
  bad('null', 'null');
  bad({ ...vault, version: 2 }, 'unknown version');
  bad({ ...vault, kdf: 'scrypt' }, 'unknown kdf');
  bad({ ...vault, iterations: 4_000_000_000 }, 'a key-stretching bomb');
  bad({ ...vault, iterations: 1 }, 'a trivially weak setting');
  bad({ ...vault, iterations: '600000' }, 'iterations as a string');
  bad({ ...vault, salt: '<script>' }, 'salt is not base64');
  bad({ ...vault, ciphertext: '' }, 'empty ciphertext');
  bad({ ...vault, iv: 'A'.repeat(500) }, 'oversized iv');
  bad('x'.repeat(BACKUP_LIMITS.maxBytes + 1), 'oversized file');
  const noisy = readBackup(JSON.stringify({ ...vault, __proto__: { x: 1 }, extra: '<img onerror=1>', address: 'a'.repeat(5000) }));
  assert.equal(noisy.ok, true);
  assert.equal(Object.keys(noisy.envelope).includes('extra'), false, 'unknown fields are dropped');
  assert.ok(noisy.envelope.address.length <= 120);
});

test('passwords: the length is the vault rule, and the two must match', () => {
  assert.equal(checkNewPassword('short', 'short', 12).ok, false);
  assert.equal(checkNewPassword('twelve chars', 'twelve chars!', 12).ok, false);
  assert.equal(checkNewPassword('twelve chars', 'twelve chars', 12).ok, true);
  assert.equal(checkNewPassword(undefined, undefined, 12).ok, false);
  assert.equal(normalisePhrase('  Abandon   ABOUT\nabout '), 'abandon about about');
});

// ── lock ─────────────────────────────────────────────────────────────────────

test('the idle lock fires once after the idle time, and activity postpones it', () => {
  const timers = [];
  let locked = 0;
  const lock = createIdleLock({
    ms: 300_000,
    onLock: () => { locked += 1; },
    setTimer: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length - 1; },
    clearTimer: (h) => { timers[h].live = false; },
  });
  assert.equal(lock.armed, false);
  lock.touch();
  lock.touch(); // activity: the first timer is cancelled and a new one starts
  assert.equal(timers.filter((t) => t.live).length, 1);
  assert.equal(timers[0].live, false);
  assert.equal(timers[1].ms, 300_000);
  timers[1].fn();
  assert.equal(locked, 1);
  assert.equal(lock.armed, false);
  lock.touch();
  lock.stop();
  assert.equal(lock.armed, false);
  assert.equal(timers[2].live, false);
});

test('repeated wrong passwords slow the unlock down', () => {
  assert.deepEqual([0, 1, 2].map(unlockDelaySeconds), [0, 0, 0]);
  assert.deepEqual([3, 4, 5].map(unlockDelaySeconds), [2, 4, 8]);
  assert.equal(unlockDelaySeconds(40), 60);
});

// ── what this device remembers ───────────────────────────────────────────────

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
};

test('submitted transactions are stored without any secret, and only for their own wallet', () => {
  const store = memory();
  const a = newWallet().address;
  const b = newWallet().address;
  const rec = { txId: 'f'.repeat(64), from: a, to: b, amount: '5', gas: '1', validUntil: 99, submittedAt: 1, state: 'pending', signedHex: 'deadbeef', privateKey: 'x', phrase: 'y' };
  writeRecords(store, a, [rec]);
  const text = store.getItem(SUBMITTED_KEY);
  assert.ok(!/deadbeef|privateKey|phrase|signature/.test(text), 'nothing but the plain facts is written');
  assert.equal(readRecords(store, a).length, 1);
  assert.equal(readRecords(store, b).length, 0, 'another wallet does not see it');
  writeRecords(store, b, []);
  assert.equal(readRecords(store, a).length, 1, 'writing one wallet leaves another wallet record alone');
  store.setItem(SUBMITTED_KEY, '{broken');
  assert.deepEqual(readRecords(store, a), []);
  store.setItem(SUBMITTED_KEY, JSON.stringify([{ txId: 'zz', from: a }, rec, null, 7]));
  assert.equal(readRecords(store, a).length, 1, 'malformed entries are dropped, good ones kept');
  assert.equal(sanitiseRecord({ ...rec, txId: 'nothex' }), null);
  assert.equal(sanitiseRecord({ ...rec, amount: '1e5' }), null);
  assert.equal(sanitiseRecord({ ...rec, state: 'weird' }).state, 'submitted');
});
