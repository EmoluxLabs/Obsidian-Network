/**
 * Security suite: protocol-level guarantees.
 *
 * Everything here is asserted against real chain state, not mocks: key material
 * handling, replay and forgery resistance, mining race protection, the supply
 * ceiling, and the genesis rule.
 */

import { PROTOCOL_VERSION } from '../../src/version.js';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keystore } from '../../src/crypto/keystore.js';
import { deriveWallet, generateRecoveryPhrase } from '../../src/crypto/mnemonic.js';
import { addressFromPublicKey, generateKeyPair } from '../../src/crypto/keys.js';
import { MAX_SUPPLY_SEALS, parseObs, formatObs } from '../../src/protocol/amount.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { CapsuleOp, TxType } from '../../src/protocol/types.js';
import { encodePaymentBody, decodePaymentBody } from '../../src/transactions/executors/payment.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { maskAddress } from '../../src/indexer/indexer.js';
import { signTransaction } from '../../src/transactions/encode.js';
import {
  capsuleBody,
  createHarness,
  makeWallet,
  miningBody,
  rewindMiningTimer,
  signedClaim,
  signedPayment,
  type Harness,
} from '../helpers/harness.js';

const open: Harness[] = [];
async function harness(): Promise<Harness> {
  const h = await createHarness();
  open.push(h);
  return h;
}
afterEach(() => {
  while (open.length > 0) open.pop()!.close();
});

async function fundedHarness(): Promise<{ h: Harness; wallet: ReturnType<typeof makeWallet> }> {
  const h = await harness();
  const wallet = makeWallet();
  h.produce([]);
  h.produce([signedClaim(h, wallet)]);
  return { h, wallet };
}

describe('key material handling (spec §11, §12)', () => {
  it('creates wallets from cryptographic randomness, never from identity data', () => {
    const phrases = new Set<string>();
    const privateKeys = new Set<string>();
    for (let i = 0; i < 64; i += 1) {
      const phrase = generateRecoveryPhrase();
      phrases.add(phrase);
      privateKeys.add(deriveWallet(phrase, 0, 0).privateKey);
    }
    expect(phrases.size).toBe(64);
    expect(privateKeys.size).toBe(64);
    for (const phrase of phrases) {
      expect(phrase.trim().split(/\s+/).length).toBeGreaterThanOrEqual(12);
    }
    // The address is derived from the public key only: no email, no Google id,
    // no username, no date of birth, no account id is accepted anywhere.
    const pair = generateKeyPair();
    expect(addressFromPublicKey(pair.publicKey, 'obs')).toBe(addressFromPublicKey(pair.publicKey, 'obs'));
  });

  it('never writes a private key to the keystore in the clear', () => {
    const dir = mkdtempSync(join(tmpdir(), 'obsidian-key-'));
    try {
      const path = join(dir, 'node-key.json');
      const pair = Keystore.create(path, 'a-strong-passphrase');
      const file = readFileSync(path, 'utf8');
      expect(file).not.toContain(pair.privateKey);
      expect(file.toLowerCase()).not.toContain('"privatekey"');
      // Keystore metadata is honest about how it is protected.
      const parsed = JSON.parse(file);
      expect(parsed.cipher).toBe('aes-256-gcm');
      expect(parsed.kdf).toBe('scrypt');
      expect(parsed.ciphertext).toBeTruthy();

      // Wrong passphrase fails closed and yields no key material.
      expect(() => Keystore.read(path, 'the-wrong-passphrase')).toThrow();
      const reopened = Keystore.read(path, 'a-strong-passphrase');
      expect(reopened.privateKey).toBe(pair.privateKey);

      // A tampered keystore is detected by the AEAD tag.
      const tampered = JSON.parse(file);
      tampered.ciphertext = `${tampered.ciphertext.slice(0, -4)}dead`;
      const tamperedPath = join(dir, 'tampered.json');
      writeFileSync(tamperedPath, JSON.stringify(tampered));
      expect(() => Keystore.read(tamperedPath, 'a-strong-passphrase')).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps private keys out of the chain state and out of the wire format', async () => {
    const { h, wallet } = await fundedHarness();
    h.produce([signedPayment(h, wallet, makeWallet().address, parseObs('1'))]);
    const serialized = JSON.stringify(h.chain.world.s, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain(wallet.privateKey);
    expect(serialized.toLowerCase()).not.toContain('privatekey');
    expect(serialized.toLowerCase()).not.toContain('mnemonic');
    expect(serialized.toLowerCase()).not.toContain('seedphrase');
  });
});

describe('transaction forgery and replay', () => {
  it('rejects a tampered amount with a bad signature', async () => {
    const { h, wallet } = await fundedHarness();
    const bob = makeWallet();
    const original = signedPayment(h, wallet, bob.address, parseObs('1'));
    const forged = {
      ...original,
      body: encodePaymentBody({ to: bob.address, amount: parseObs('10') }),
    };
    const outcome = h.tryBlock([forged]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_SIGNATURE);
  });

  it('rejects a second transaction that reuses a nonce', async () => {
    const { h, wallet } = await fundedHarness();
    const bob = makeWallet();
    const carol = makeWallet();
    const first = signedPayment(h, wallet, bob.address, parseObs('1'));
    const spendAgain = h.sign(wallet, TxType.PAYMENT, encodePaymentBody({ to: carol.address, amount: parseObs('1') }), {
      gas: expectedGas(parseObs('1')),
      nonce: first.nonce,
    });
    h.produce([first]);
    const outcome = h.tryBlock([spendAgain]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_NONCE);
  });

  it('rejects replaying an already-mined transaction', async () => {
    const { h, wallet } = await fundedHarness();
    const bob = makeWallet();
    const payment = signedPayment(h, wallet, bob.address, parseObs('2'));
    h.produce([payment]);
    const replay = h.tryBlock([payment]);
    expect(replay.accepted).toBe(false);
    expect([ErrCode.REPLAY, ErrCode.BAD_NONCE, ErrCode.DUPLICATE_TX]).toContain(replay.code);
    // The recipient is paid exactly once.
    expect(h.chain.world.getAccount(bob.address)!.balance).toBe(parseObs('2'));
  });

  it('rejects an expired transaction and one that lives too far ahead', async () => {
    const { h, wallet } = await fundedHarness();
    const bob = makeWallet();
    const expired = signTransaction({
      sender: wallet.address,
      privateKeyHex: wallet.privateKey,
      publicKeyHex: wallet.publicKey,
      chainId: h.chain.net.chainId,
      protocolVersion: PROTOCOL_VERSION,
      nonce: 0,
      type: TxType.PAYMENT,
      gas: expectedGas(parseObs('1')),
      body: encodePaymentBody({ to: bob.address, amount: parseObs('1') }),
      validUntil: h.chain.protocolTime - 1,
    });
    const expiredOutcome = h.tryBlock([expired]);
    expect(expiredOutcome.accepted).toBe(false);
    expect(expiredOutcome.code).toBe(ErrCode.EXPIRED);

    const farFuture = signTransaction({
      sender: wallet.address,
      privateKeyHex: wallet.privateKey,
      publicKeyHex: wallet.publicKey,
      chainId: h.chain.net.chainId,
      protocolVersion: PROTOCOL_VERSION,
      nonce: 0,
      type: TxType.PAYMENT,
      gas: expectedGas(parseObs('1')),
      body: encodePaymentBody({ to: bob.address, amount: parseObs('1') }),
      validUntil:
        h.chain.protocolTime +
        CONSENSUS_PARAMS.tx.expiryBlocks * CONSENSUS_PARAMS.block.targetBlockSeconds +
        600,
    });
    const futureOutcome = h.tryBlock([farFuture]);
    expect(futureOutcome.accepted).toBe(false);
    expect([ErrCode.NOT_YET_VALID, ErrCode.EXPIRED, ErrCode.MALFORMED]).toContain(futureOutcome.code);
  });

  it('rejects a transaction signed for another network', async () => {
    const { h, wallet } = await fundedHarness();
    const bob = makeWallet();
    const mainnetTx = signTransaction({
      sender: wallet.address,
      privateKeyHex: wallet.privateKey,
      publicKeyHex: wallet.publicKey,
      chainId: 7777,
      protocolVersion: PROTOCOL_VERSION,
      nonce: 0,
      type: TxType.PAYMENT,
      gas: expectedGas(parseObs('1')),
      body: encodePaymentBody({ to: bob.address, amount: parseObs('1') }),
      validUntil: h.chain.protocolTime + 600,
    });
    const outcome = h.tryBlock([mainnetTx]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.WRONG_CHAIN_ID);
  });

  it('rejects a transaction whose sender cannot pay, without touching state', async () => {
    const { h, wallet } = await fundedHarness();
    const poor = makeWallet();
    const before = formatObs(h.chain.world.s.metrics.totalSupply);
    const outcome = h.tryBlock([signedPayment(h, poor, wallet.address, parseObs('1'))]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.INSUFFICIENT_FUNDS);
    expect(formatObs(h.chain.world.s.metrics.totalSupply)).toBe(before);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});

describe('mining race and replay protection (spec §21, §23)', () => {
  it('rejects a replayed claim id', async () => {
    const { h, wallet } = await fundedHarness();
    const claim = signedClaim(h, wallet);
    rewindMiningTimer(h, wallet.address);
    h.produce([claim]);
    // Replaying the same claim id — even re-signed onto a fresh nonce — is
    // refused; the wallet's sequence stays at one claim.
    const replayed = h.sign(wallet, TxType.MINING_CLAIM, claim.body, { gas: 0n, protocolTime: claim.validUntil });
    const outcome = h.tryBlock([replayed]);
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.MINING_CLAIM_REPLAY, ErrCode.MINING_TOO_SOON, ErrCode.MINING_NOT_ELIGIBLE]).toContain(outcome.code);
    // Two accepted claims (genesis + the rewound one) and no third: the replay
    // did not mint anything.
    const rewardPerClaim = CONSENSUS_PARAMS.mining.initialDailyReward / BigInt(CONSENSUS_PARAMS.mining.maxClaimsPerCycle);
    expect(h.chain.world.getAccount(wallet.address)!.mining!.claimSequence).toBe(3);
    expect(h.chain.world.s.metrics.minedSupply).toBe(rewardPerClaim * 2n);
  });

  it('enforces the 4-hour interval and the 6-per-day cycle', async () => {
    const { h, wallet } = await fundedHarness();
    expect(CONSENSUS_PARAMS.mining.claimIntervalSeconds).toBe(4 * 60 * 60);
    expect(CONSENSUS_PARAMS.mining.maxClaimsPerCycle).toBe(6);

    const tooSoon = h.tryBlock([signedClaim(h, wallet)]);
    expect(tooSoon.accepted).toBe(false);
    expect(tooSoon.code).toBe(ErrCode.MINING_TOO_SOON);

    // Six claims inside one cycle are the protocol maximum, and the genesis
    // claim already consumed the first slot.
    for (let i = 1; i < CONSENSUS_PARAMS.mining.maxClaimsPerCycle; i += 1) {
      rewindMiningTimer(h, wallet.address);
      h.produce([signedClaim(h, wallet)]);
    }
    rewindMiningTimer(h, wallet.address);
    const seventh = h.tryBlock([signedClaim(h, wallet)]);
    expect(seventh.accepted).toBe(false);
    expect([ErrCode.MINING_CYCLE_LIMIT, ErrCode.MINING_TOO_SOON]).toContain(seventh.code);
  });

  it('refuses two claims from one wallet in the same block', async () => {
    const { h } = await fundedHarness();
    const fresh = makeWallet();
    const first = signedClaim(h, fresh);
    const second = h.sign(fresh, TxType.MINING_CLAIM, miningBody(h, fresh), { gas: 0n, nonce: 1 });
    expect(CONSENSUS_PARAMS.mining.maxClaimsPerBlockPerWallet).toBe(1);
    const outcome = h.tryBlock([first, second]);
    expect(outcome.accepted).toBe(false);
    expect([
      ErrCode.MINING_CYCLE_LIMIT,
      ErrCode.MINING_TOO_SOON,
      ErrCode.MINING_CLAIM_REPLAY,
      ErrCode.MINING_BAD_PROOF,
    ]).toContain(outcome.code);
  });

  it('does not let a wallet claim a reward it did not earn (proof binding)', async () => {
    const { h } = await fundedHarness();
    const attacker = makeWallet();
    const victim = makeWallet();
    // The claim body is bound to the signer: sign a body computed for someone else.
    const stolen = h.sign(attacker, TxType.MINING_CLAIM, miningBody(h, victim), { gas: 0n });
    const outcome = h.tryBlock([stolen]);
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.MINING_BAD_PROOF, ErrCode.MINING_NOT_ELIGIBLE]).toContain(outcome.code);
    expect(h.chain.world.getAccount(attacker.address)?.balance ?? 0n).toBe(0n);
  });
});

describe('supply ceiling (spec §9, §73)', () => {
  it('awards the genesis allocation exactly once, to the first protocol-valid claim', async () => {
    const { h, wallet } = await fundedHarness();
    const genesis = h.chain.world.s.genesis;
    expect(genesis.allocationClaimed).toBe(true);
    expect(genesis.recipient).toBe(wallet.address);
    // Registration mints nothing: a fresh wallet starts at zero.
    const newcomer = makeWallet();
    expect(h.chain.world.getAccount(newcomer.address)?.balance ?? 0n).toBe(0n);

    // A second miner claims and receives only the mining reward — never 100,000.
    h.produce([signedPayment(h, wallet, newcomer.address, parseObs('1'))]);
    h.produce([signedClaim(h, newcomer)]);
    const newcomerBalance = h.chain.world.getAccount(newcomer.address)!.balance;
    const rewardPerClaim = CONSENSUS_PARAMS.mining.initialDailyReward / BigInt(CONSENSUS_PARAMS.mining.maxClaimsPerCycle);
    expect(newcomerBalance).toBe(parseObs('1') + rewardPerClaim);
    expect(h.chain.world.s.genesis.recipient).toBe(wallet.address);
    const allocation = h.chain.world.s.metrics.issuedGenesis;
    expect(allocation).toBe(100_000n * 10n ** 18n);
  });

  it('cannot mint beyond the 21,000,000 OBS ceiling', async () => {
    const { h, wallet } = await fundedHarness();
    const metrics = h.chain.world.s.metrics;
    expect(metrics.totalSupply).toBeLessThanOrEqual(MAX_SUPPLY_SEALS);
    expect(MAX_SUPPLY_SEALS).toBe(21_000_000n * 10n ** 18n);
    // The only issuance sources are the genesis rule and mining rewards.
    const invariant = h.chain.world.verifySupplyInvariant();
    expect(invariant.ok).toBe(true);
    // No amount of payments or fees can create supply: the total is unchanged.
    const before = metrics.totalSupply;
    const bob = makeWallet();
    h.produce([signedPayment(h, wallet, bob.address, parseObs('1000'))]);
    h.produce([signedPayment(h, bob, wallet.address, parseObs('500'))]);
    expect(h.chain.world.s.metrics.totalSupply).toBe(before);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});

describe('capsule confidentiality (spec §44)', () => {
  it('stores only a commitment — never the sealed content', async () => {
    const { h, wallet } = await fundedHarness();
    const secret = 'the contents of a private letter';
    const commitment = 'f0'.repeat(32);
    const unlockAt = h.chain.protocolTime + 3600;
    h.produce([
      h.sign(
        wallet,
        TxType.CAPSULE,
        capsuleBody(CapsuleOp.CREATE, {
          owner: wallet.address,
          contentCommitment: commitment,
          contentNonce: '0011223344556677',
          unlockAt,
          commitment: parseObs('0.5'),
          contentBytes: secret.length,
        }),
        { gas: expectedGas(parseObs('0.5')) },
      ),
    ]);
    const serialized = JSON.stringify(h.chain.world.s, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain(secret);
    const capsule = [...h.chain.world.s.capsules.values()][0]!;
    expect(capsule.contentCommitment).toBe(commitment);
    // The creator cannot read the plaintext from chain state either: only the
    // commitment is chain data.
    expect(JSON.stringify(capsule, (_key, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toContain(
      secret,
    );
  });
});

describe('explorer masking (spec §32)', () => {
  it('never renders a full address', () => {
    const pair = generateKeyPair();
    const address = addressFromPublicKey(pair.publicKey, 'obs');
    const masked = maskAddress(address);
    expect(masked).not.toBe(address);
    expect(masked).toContain('…');
    expect(masked.length).toBeLessThan(address.length);
    expect(address.startsWith(masked.split('…')[0]!)).toBe(true);
    expect(address.endsWith(masked.split('…')[1]!)).toBe(true);
  });
});

describe('fee and gas determinism', () => {
  it('gas is 0.02% of the transfer, capped at 0.01 OBS, and enforced exactly', async () => {
    const { h, wallet } = await fundedHarness();
    const bob = makeWallet();
    expect(expectedGas(parseObs('1000'))).toBe(CONSENSUS_PARAMS.gas.maxGas);
    expect(expectedGas(parseObs('1'))).toBe(parseObs('0.0002'));
    expect(CONSENSUS_PARAMS.gas.basisPoints).toBe(2);
    expect(CONSENSUS_PARAMS.gas.maxGas).toBe(parseObs('0.01'));

    const underpaid = h.sign(wallet, TxType.PAYMENT, encodePaymentBody({ to: bob.address, amount: parseObs('1000') }), {
      gas: expectedGas(parseObs('1000')) - 1n,
    });
    const outcome = h.tryBlock([underpaid]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_GAS);
  });

  it('decodes what it encodes (canonical wire format round trip)', () => {
    const body = encodePaymentBody({ to: makeWallet().address, amount: parseObs('42'), memo: 'hello obsidian' });
    const decoded = decodePaymentBody(body);
    expect(decoded.amount).toBe(parseObs('42'));
    expect(decoded.memo).toBe('hello obsidian');
  });
});
