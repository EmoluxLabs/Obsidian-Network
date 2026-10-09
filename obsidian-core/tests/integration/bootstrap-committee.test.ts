/**
 * The committed finality bootstrap committee.
 *
 * v1.6.0 replaces "any stable bonded set may finalize the first checkpoint" with
 * a committee fixed in the genesis document. Three properties matter, and each
 * is a way the mechanism could be quietly useless:
 *
 *   1. the committed lists are valid, unique, canonically ordered, and the ones
 *      the protocol actually ships;
 *   2. they are committed into the genesis id, and no caller can substitute a
 *      different list for a network that has one — a substituted set would
 *      silently be a different chain;
 *   3. a committee of the committed shape can really finalize the first
 *      checkpoint once its keys are bonded exactly as the documentation says.
 *
 * (3) is a rehearsal rather than a mainnet run, and deliberately so: the private
 * halves of the mainnet keys do not exist in this repository (see
 * bootstrap-keys/README.md), so no test can bond them. The rehearsal uses five
 * keys on a network without a committed set and the same 64-block stability
 * window, quorum `floor(2N/3)+1`, registration rules and voting path — the
 * mechanism is identical; only the keys differ.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ChainManager } from '../../src/blockchain/chain.js';
import { finalityQuorum } from '../../src/consensus/finality.js';
import {
  COMMITTED_BOOTSTRAP_VALIDATOR_KEYS,
  committedBootstrapValidatorKeys,
} from '../../src/genesis/bootstrap-keys.js';
import {
  genesisDocumentFor,
  genesisId,
  normalizeBootstrapValidatorPublicKeys,
  resolveBootstrapValidatorKeys,
} from '../../src/genesis/initialize.js';
import { getNetwork } from '../../src/protocol/networks.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { TxType, ValidatorOp } from '../../src/protocol/types.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import {
  createHarness, makeWallet, signedClaim, signedPayment, validatorBody,
  type Harness, type TestWallet,
} from '../helpers/harness.js';

const open: Harness[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-07T12:00:00Z')); });
afterEach(() => { while (open.length) open.pop()!.close(); vi.useRealTimers(); });

const mainnet = getNetwork('mainnet');
const STABILITY = CONSENSUS_PARAMS.consensus.finality.bootstrapSetStabilityBlocks;
const BOND = CONSENSUS_PARAMS.consensus.validatorBond;

/**
 * A block from the scheduled proposer.
 *
 * With no validators registered the protocol is in open-genesis mode and any
 * producer is accepted; once one is registered the rotation is enforced, so the
 * producer has to be the scheduled validator.
 */
function block(h: Harness, txs: Parameters<Harness['produce']>[0] = [], wallets: TestWallet[] = []): void {
  vi.advanceTimersByTime(1_000);
  const scheduled = h.chain.scheduledProposerNow();
  if (scheduled === null) { h.produce(txs); return; }
  const producer = wallets.find((wallet) => wallet.address === scheduled);
  if (!producer) throw new Error(`no test wallet for scheduled proposer ${scheduled}`);
  h.produce(txs, { producer });
}

function mine(h: Harness, count: number, wallets: TestWallet[] = []): void {
  for (let index = 0; index < count; index += 1) block(h, [], wallets);
}

describe('committed bootstrap committees', () => {
  it('ships a valid, unique, canonically ordered set for mainnet and testnet', () => {
    const expected: Record<string, number> = { mainnet: 4, testnet: 3 };
    for (const [name, size] of Object.entries(expected)) {
      const net = getNetwork(name as 'mainnet');
      const committed = committedBootstrapValidatorKeys(net);
      expect(committed, name).toHaveLength(size);
      // The protocol normalises by sorting, so a committed list that is already
      // sorted is one whose published order is the order the chain uses.
      expect(normalizeBootstrapValidatorPublicKeys(committed)).toEqual([...committed]);
      expect(new Set(committed).size, `${name} keys are unique`).toBe(committed.length);
      for (const key of committed) expect(key, `${name} key`).toMatch(/^0[23][0-9a-f]{64}$/);
      // A one-key "committee" would be a single point of failure; a quorum above
      // the set size would be unsatisfiable. Neither may ship.
      expect(committed.length).toBeGreaterThan(1);
      const quorum = finalityQuorum(committed.length);
      expect(quorum).toBeLessThanOrEqual(committed.length);
      expect(quorum).toBeGreaterThan(committed.length / 2);
      // Affordability: the whole committee must be bondable from the genesis
      // allocation, because that allocation is the only value in existence at
      // height 0. Each operator needs the exact bond plus the registration gas,
      // which the claimer pays for by transfer. A set that fails this check
      // cannot bootstrap on a real network however well the unit tests pass.
      const perValidator = BOND + expectedGas(BOND);
      expect(
        BigInt(committed.length) * perValidator,
        `${name}: ${committed.length} validators cost more than the genesis allocation`,
      ).toBeLessThanOrEqual(CONSENSUS_PARAMS.genesisAllocation);
    }
    for (const name of ['staging', 'devnet'] as const) {
      expect(committedBootstrapValidatorKeys(getNetwork(name))).toEqual([]);
    }
  });

  it('commits the set into the genesis id, so a different list is a different chain', () => {
    const shipped = genesisId(genesisDocumentFor(mainnet), mainnet);
    expect(genesisId(genesisDocumentFor(mainnet, []), mainnet)).toBe(shipped);
    // A mainnet node cannot choose a narrower set — that refusal has its own
    // test below. On a network without a committed set, the set is part of the
    // identity: two nodes that configured different keys derive different ids
    // and never peer, which is what "genesis-committed" means.
    const devnet = getNetwork('devnet');
    const alpha = makeWallet(devnet).publicKey;
    const beta = makeWallet(devnet).publicKey;
    const one = genesisId(genesisDocumentFor(devnet, [alpha]), devnet);
    const two = genesisId(genesisDocumentFor(devnet, [beta]), devnet);
    expect(one).not.toBe(two);
    expect(genesisId(genesisDocumentFor(devnet, []), devnet)).not.toBe(one);
    // Published identity: changing the committee is a new network, and so is
    // changing the protocol version the document is stamped with — the id is
    // derived from the document, never written down by hand. This assertion
    // makes either change a deliberate act instead of an edit that slips by.
    //   1.6.0: 3a7ced6f7e6a14f40fc310d9a5de6d834b5cbd4c
    //   1.7.0: the mining gate issuer set joined the id, so every network's id moved. The value below is the base
    //          identity (no issuer key committed yet); a live network's id also includes its issuer keys.
    //   1.6.1: the value below, moved by PROTOCOL_VERSION alone (the committee,
    //          the genesis instant and the note are untouched).
    expect(shipped).toBe('2dc198e4e57cb482df4e0f89e3a28daaf427ccff');
    expect(genesisId({ ...genesisDocumentFor(mainnet), protocolVersion: '1.6.0' }, mainnet))
      .toBe('9a104f428d447e4c916fccf2c8b5c0bef4827d4f');
  });

  it('refuses to start a committed network with a different committee', async () => {
    const stranger = makeWallet(mainnet);
    expect(() => genesisDocumentFor(mainnet, [stranger.publicKey])).toThrow(/refusing to start with a different one/i);
    expect(resolveBootstrapValidatorKeys(mainnet, committedBootstrapValidatorKeys(mainnet)))
      .toEqual([...committedBootstrapValidatorKeys(mainnet)]);

    // A hand-assembled genesis document is refused too, rather than silently
    // defining a private fork that calls itself mainnet. The refusal happens
    // when the chain is constructed, before a single byte is written.
    const construct = (note: string, keys: string[]) => new ChainManager({
      dataDir: mkdtempSync(`${tmpdir()}/obsidian-bootstrap-`),
      net: mainnet,
      genesisDocument: {
        networkId: mainnet.networkId,
        chainId: mainnet.chainId,
        protocolVersion: PROTOCOL_VERSION,
        timestamp: 1_767_225_600,
        note,
        bootstrapValidatorPublicKeys: keys,
      },
    });
    expect(() => construct('hand-built, one stranger key', [stranger.publicKey]))
      .toThrow(/commits a fixed finality bootstrap committee/i);
    // An empty list is not a way around it either.
    expect(() => construct('hand-built, empty', []))
      .toThrow(/an empty set/i);
    // The committed set itself is accepted.
    expect(() => construct('hand-built, correct', [...COMMITTED_BOOTSTRAP_VALIDATOR_KEYS.mainnet])).not.toThrow();
  });

  it('starts a committed network with the committed document and stays fail-closed until its keys bond', async () => {
    const h = await createHarness({
      network: 'mainnet',
      bootstrapValidatorPublicKeys: [...COMMITTED_BOOTSTRAP_VALIDATOR_KEYS.mainnet],
    });
    open.push(h);
    expect(h.chain.genesisId).toBe(genesisId(h.chain.genesisDocument, mainnet));
    expect(h.chain.genesisDocument.bootstrapValidatorPublicKeys)
      .toEqual([...COMMITTED_BOOTSTRAP_VALIDATOR_KEYS.mainnet]);

    // A configured committee with no bonded members must not invent one: it has
    // no validators, no quorum, and nothing to vote.
    expect(h.chain.finalityStatus()).toMatchObject({
      bootstrap: true, bootstrapConfigured: true, validatorCount: 0, quorum: 0,
    });
    expect(h.chain.status().finalityBootstrapConfigured).toBe(true);
  });
});

describe('a committee of the committed shape finalizes the first checkpoint', () => {
  it('bootstraps with four keys, a quorum of three, and one key left offline', async () => {
    // A network without a committed set is where an operator-supplied committee
    // is exercised: devnet here, exactly as staging/devnet would be in the field.
    // The shape is mainnet's: four operators, one exact bond each, funded from
    // the genesis allocation by ordinary transfers.
    const operators: TestWallet[] = [];
    for (let index = 0; index < 4; index += 1) operators.push(makeWallet());
    const keys = operators.map((wallet) => wallet.publicKey).sort();
    const h = await createHarness({
      producer: operators[0]!,
      bootstrapValidatorPublicKeys: keys,
    });
    open.push(h);

    // The genesis allocation (100,000 OBS, exactly five bonds) funds the first
    // claimer; the other four operators are funded by ordinary transfers. One
    // transaction per block keeps every nonce honest.
    block(h);
    block(h, [signedClaim(h, operators[0]!)]);
    const funder = operators[0]!;
    for (const payee of operators.slice(1)) {
      // Exactly the bond plus the registration gas: the rehearsal is also the
      // proof that the arithmetic in bootstrap-keys.ts funds a full committee.
      block(h, [signedPayment(h, funder, payee.address, BOND + expectedGas(BOND))]);
    }

    // Each operator registers its own committed key with exactly one bond.
    for (const wallet of operators) {
      block(h, [h.sign(wallet, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, wallet.publicKey), { gas: expectedGas(BOND) })], operators);
    }
    // Until the committee has held still for the stability window there is no
    // eligible committee and no quorum to reach — the status says so rather
    // than advertising a set that may not vote yet.
    expect(h.chain.finalityStatus()).toMatchObject({
      bootstrapConfigured: true, validatorCount: 0, quorum: 0,
    });
    mine(h, STABILITY, operators);
    expect(h.chain.finalityStatus()).toMatchObject({
      bootstrapConfigured: true, validatorCount: 4, quorum: 3,
    });
    expect(h.chain.finalityStatus().finalizedHeight).toBe(0);
    block(h, [], operators);

    const identities = operators.map((wallet) => ({
      address: wallet.address, publicKey: wallet.publicKey, privateKey: wallet.privateKey,
    }));
    // Three of four sign — the fourth is offline on purpose, which is the whole
    // reason a quorum below the set size matters. `requested` is omitted: the
    // node itself selects the first bootstrap-eligible target.
    let finalized = false;
    for (const identity of identities.slice(0, 3)) {
      const vote = h.chain.createFinalityVote(identity);
      expect(vote, `${identity.address} should be eligible to vote`).not.toBeNull();
      const result = h.chain.addFinalityVote(vote!);
      expect(result.accepted, result.message).toBe(true);
      finalized = finalized || result.finalized === true;
    }
    expect(finalized).toBe(true);
    const first = h.chain.finalityStatus();
    // The node itself selected the earliest checkpoint the whole committee
    // could vouch for: no earlier than the stability window, never ahead of the
    // chain, and not the tip that was there before the committee bonded.
    expect(first.finalizedHeight).toBeGreaterThanOrEqual(STABILITY + 1);
    expect(first.finalizedHeight).toBeLessThanOrEqual(h.chain.height);
    expect(first).toMatchObject({ bootstrap: false, validatorCount: 4, quorum: 3 });

    // After the first certificate the ordinary rule takes over: the same five
    // ACTIVE, exactly-bonded validators finalize the next checkpoint, one block
    // at a time, through the same eligibility path.
    block(h, [], operators);
    let advanced = false;
    for (const identity of identities.slice(0, 3)) {
      const vote = h.chain.createFinalityVote(identity);
      expect(vote, `${identity.address} should still be eligible`).not.toBeNull();
      const result = h.chain.addFinalityVote(vote!);
      expect(result.accepted, result.message).toBe(true);
      advanced = advanced || result.finalized === true;
    }
    expect(advanced).toBe(true);
    expect(h.chain.finalityStatus().finalizedHeight).toBe(first.finalizedHeight + 1);
  });

  it('will not finalize with fewer committed keys than the quorum', async () => {
    // Three of four registered, but the fourth is what makes the committee
    // whole: two active keys are below the quorum of three, so no eligible
    // committee exists and no vote can be cast.
    const operators = [makeWallet(), makeWallet(), makeWallet(), makeWallet()];
    const keys = operators.map((wallet) => wallet.publicKey).sort();
    const h = await createHarness({ producer: operators[0]!, bootstrapValidatorPublicKeys: keys });
    open.push(h);
    block(h);
    block(h, [signedClaim(h, operators[0]!)]);
    for (const payee of operators.slice(1, 3)) {
      block(h, [signedPayment(h, operators[0]!, payee.address, BOND + expectedGas(BOND))]);
    }
    for (const wallet of operators.slice(0, 3)) {
      block(h, [h.sign(wallet, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, wallet.publicKey), { gas: expectedGas(BOND) })], operators);
    }
    expect(h.chain.finalityStatus()).toMatchObject({ bootstrapConfigured: true, validatorCount: 0, quorum: 0 });
    mine(h, STABILITY + 2, operators);
    expect(h.chain.finalityStatus().finalizedHeight).toBe(0);
    expect(h.chain.finalityVoteTemplate(operators[0]!.address)).toBeNull();
  });

  it('will not finalize anything on a committed network whose keys never bond', async () => {
    const h = await createHarness({
      network: 'mainnet',
      bootstrapValidatorPublicKeys: [...COMMITTED_BOOTSTRAP_VALIDATOR_KEYS.mainnet],
    });
    open.push(h);
    // Somebody mines the allocation — an ordinary miner, not a committed
    // operator — and the chain runs well past the stability window.
    h.produce();
    h.produce([signedClaim(h, makeWallet(mainnet))]);
    mine(h, STABILITY + 2);
    const status = h.chain.finalityStatus();
    expect(status.bootstrapConfigured).toBe(true);
    expect(status.validatorCount).toBe(0);
    expect(status.quorum).toBe(0);
    expect(status.finalizedHeight).toBe(0);
    expect(h.chain.finalityVoteTemplate(makeWallet(mainnet).address)).toBeNull();
  });
});
