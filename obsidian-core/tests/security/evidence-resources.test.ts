/**
 * H-03 — equivocation evidence is a bounded resource, and reporting it stays free.
 *
 * A SLASH transaction costs the submitter nothing (gas 0) and costs the network
 * public-key work to verify, and it is the one transaction type an attacker can
 * produce in unlimited variety from unlimited fresh addresses. Everything here
 * is about the gap between those two facts:
 *
 *   1. a BLOCK may carry only so much evidence — a consensus limit, identical on
 *      every node, so a peer cannot make a block expensive to validate;
 *   2. a PRODUCER verifies only so much per slot, and what it skips stays pooled
 *      rather than dropped;
 *   3. the POOL holds only so many pending reports, per sender and in total, and
 *      a flood may never displace an honest transaction to make room;
 *   4. the flood itself: more than a thousand reports from more than a thousand
 *      addresses, which is the shape a real attack has, because a per-sender
 *      quota alone is trivially defeated by generating senders.
 *
 * None of this makes reporting harder for an honest node. The per-block budget
 * is about how much one block CARRIES, not about who may submit: the report that
 * does not fit waits for the next block, and it is still applied.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { SlashOp, TxType, ValidatorOp } from '../../src/protocol/types.js';
import { encodeSlashBody, slashEvidenceBytes } from '../../src/transactions/executors/slash.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { DEFAULT_MEMPOOL_OPTIONS, Mempool } from '../../src/blockchain/mempool.js';
import {
  createHarness,
  forkParent,
  makeWallet,
  signedClaim,
  signedPayment,
  validatorBody,
  type Harness,
  type TestWallet,
} from '../helpers/harness.js';
import { makeProposerEvidence } from '../../src/consensus/finality.js';
import { proposerRound } from '../../src/consensus/proposer.js';
import { blockHash, encodeSignedHeader } from '../../src/blockchain/block.js';
import { toHex } from '../../src/crypto/hash.js';

const BOND = CONSENSUS_PARAMS.consensus.validatorBond;
const LIMIT = CONSENSUS_PARAMS.consensus.slashing;
const open: Harness[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
});
afterEach(() => {
  while (open.length) open.pop()!.close();
  vi.useRealTimers();
});

async function evidenceHarness(): Promise<{
  h: Harness;
  validator: TestWallet;
  byAddress: Map<string, TestWallet>;
  produceScheduled: (txs?: Parameters<Harness['produce']>[0]) => void;
}> {
  const validator = makeWallet();
  const h = await createHarness({ producer: validator, bootstrapValidatorPublicKeys: [validator.publicKey] });
  open.push(h);
  h.produce();
  h.produce([signedClaim(h, validator)]);
  h.produce([
    h.sign(validator, TxType.VALIDATOR, validatorBody(ValidatorOp.REGISTER, BOND, validator.publicKey), {
      gas: expectedGas(BOND),
    }),
  ]);
  const byAddress = new Map<string, TestWallet>([[validator.address, validator]]);
  const produceScheduled = (txs: Parameters<Harness['produce']>[0] = []): void => {
    const head = h.chain.tip!;
    const timestamp = head.timestamp + CONSENSUS_PARAMS.block.targetBlockSeconds + 1;
    const clock = Math.floor(Date.now() / 1000);
    if (timestamp + 2 > clock) vi.advanceTimersByTime((timestamp + 2 - clock) * 1_000);
    const scheduled = h.chain.scheduledProposerNow();
    const producer = byAddress.get(scheduled ?? '');
    if (!producer) throw new Error('the chain is halted for want of validators');
    h.produce(txs, { producer, timestamp });
  };
  return { h, validator, byAddress, produceScheduled };
}

/** One genuine equivocation: two same-round proposals by the validator. */
function realEvidence(h: Harness, validator: TestWallet) {
  const parent = forkParent(h, h.chain.height);
  const parentBlock = h.chain.store.getBlockByHash(parent.hash);
  if (!parentBlock) throw new Error('fork parent is not stored');
  const parentTs = parentBlock.header.timestamp;
  const slot = Math.max(1, Math.ceil((h.chain.protocolTime - parentTs) / CONSENSUS_PARAMS.block.targetBlockSeconds));
  const ta = parentTs + CONSENSUS_PARAMS.block.targetBlockSeconds * slot + 1;
  const tb = parentTs + CONSENSUS_PARAMS.block.targetBlockSeconds * slot + 2;
  expect(proposerRound(parentTs, ta)).toBe(proposerRound(parentTs, tb));
  const first = h.makeBlockOn(parent, [], { timestamp: ta, producer: validator });
  const second = h.makeBlockOn(parent, [], { timestamp: tb, producer: validator });
  const evidence = makeProposerEvidence({
    validator: validator.address,
    height: first.block.header.height,
    round: proposerRound(parentTs, ta),
    firstId: blockHash(first.block.header),
    secondId: blockHash(second.block.header),
    firstHeader: toHex(encodeSignedHeader(first.block.header)),
    secondHeader: toHex(encodeSignedHeader(second.block.header)),
  });
  return {
    evidence,
    body: {
      op: SlashOp.EQUIVOCATION,
      evidence,
      firstParentHeader: toHex(encodeSignedHeader(parentBlock.header)),
      secondParentHeader: toHex(encodeSignedHeader(parentBlock.header)),
    },
  };
}

describe('the consensus per-block evidence budget', () => {
  it('is published in the parameters, so it is the same number on every node', () => {
    // Committed through the parameter hash: a producer and a validator that
    // disagreed about the budget would disagree about which blocks are valid.
    expect(LIMIT.maxEvidencePerBlock).toBe(8);
    expect(LIMIT.maxEvidenceBytesPerBlock).toBe(65_536);
    expect(Number.isInteger(LIMIT.maxEvidencePerBlock)).toBe(true);
    expect(Number.isInteger(LIMIT.maxEvidenceBytesPerBlock)).toBe(true);
  });

  it('refuses the block above the limit before it refuses anything inside it', async () => {
    const { h, validator, produceScheduled } = await evidenceHarness();
    const { body } = realEvidence(h, validator);

    // Distinct senders, so the reports are distinct transactions; a SLASH costs
    // nothing to submit, so none of them needs a balance.
    const submitters = Array.from({ length: LIMIT.maxEvidencePerBlock + 1 }, () => makeWallet());
    const reports = submitters.map((submitter) =>
      h.sign(submitter, TxType.SLASH, encodeSlashBody(body), { gas: 0n }),
    );

    const trial = (batch: typeof reports) =>
      h.tryBlock(batch, { producer: validator, timestamp: h.chain.protocolTime, simulate: false });

    // At the limit the budget does NOT fire: the block is refused for the
    // ordinary reason — one offence, so seven of the eight reports are replays.
    const atLimit = trial(reports.slice(0, LIMIT.maxEvidencePerBlock));
    expect(atLimit.accepted).toBe(false);
    expect(atLimit.code).toBe(ErrCode.REPLAY);

    // One report past the limit and the budget fires FIRST, before any evidence
    // is verified: that ordering is the whole point, because verification is the
    // expensive part and a peer should not be able to buy it with volume.
    const overLimit = trial(reports);
    expect(overLimit.accepted).toBe(false);
    expect(overLimit.code).toBe(ErrCode.EVIDENCE_LIMIT);

    // Neither refusal applied anything.
    expect(h.chain.world.s.slashes.size).toBe(0);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(0);

    // And the report itself is still free to be included: one block, one offence,
    // exactly one slash, with the supply intact.
    produceScheduled([reports[0]!]);
    expect(h.chain.world.s.slashes.size).toBe(1);
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('measures evidence with one ruler, everywhere', () => {
    const evidence = makeProposerEvidence({
      validator: 'dobs1' + '0'.repeat(58),
      height: 10,
      round: 0,
      firstId: '11'.repeat(32),
      secondId: '22'.repeat(32),
      firstHeader: 'ab'.repeat(64),
      secondHeader: 'cd'.repeat(64),
    });
    const body = { op: SlashOp.EQUIVOCATION, evidence };
    const measured = slashEvidenceBytes(encodeSlashBody(body));
    expect(measured).toBe(Buffer.byteLength(JSON.stringify(evidence), 'utf8'));
    // A body that is not an equivocation report measures as nothing at all, and
    // is left to the decoder's own refusal rather than being silently budgeted.
    expect(slashEvidenceBytes(new Uint8Array([9, 1, 2, 3]))).toBeNull();
  });
});

describe('the flood: a thousand reports from a thousand addresses', () => {
  it('bounds what the pool holds, and never lets evidence displace an honest transaction', async () => {
    const { h, validator } = await evidenceHarness();
    const { body } = realEvidence(h, validator);
    const encoded = encodeSlashBody(body);

    // The shape a real attack has: one report per fresh address, so a per-sender
    // quota on its own would stop nothing at all.
    const attackers = Array.from({ length: 1_000 }, () => makeWallet());
    let admitted = 0;
    for (const attacker of attackers) {
      const tx = h.sign(attacker, TxType.SLASH, encoded, { gas: 0n });
      if (h.chain.mempool.add(tx).accepted) admitted += 1;
    }

    // The class ceiling holds, and it holds no matter how many senders there are.
    expect(admitted).toBe(DEFAULT_MEMPOOL_OPTIONS.maxPendingEvidence);
    expect(h.chain.mempool.size).toBe(DEFAULT_MEMPOOL_OPTIONS.maxPendingEvidence);

    // An honest, funded payment still gets in — evidence may not evict it.
    const recipient = makeWallet();
    const honest = signedPayment(h, validator, recipient.address, 1_000n);
    expect(h.chain.mempool.add(honest).accepted).toBe(true);
    expect(h.chain.mempool.has(honest.id)).toBe(true);

    // And producing a block does not become unbounded work: the block carries at
    // most the consensus allowance, the honest payment is in it, and the reports
    // that did not fit are still pooled for a later slot rather than dropped.
    // Produce through the real producer — the one that pulls from the pool — so
    // this measures what a node would actually do with a pool full of reports.
    const pooledBefore = h.chain.mempool.size;
    const block = h.chain.buildNextBlock(validator);
    expect(block).not.toBeNull();
    expect(h.chain.addBlock(block!).accepted).toBe(true);
    const produced = h.chain.store.getBlockByHash(h.chain.tip!.hash)!;
    const included = produced.transactions.filter((tx) => tx.type === TxType.SLASH).length;
    expect(included).toBeLessThanOrEqual(LIMIT.maxEvidencePerBlock);
    expect(produced.transactions.some((tx) => tx.id === honest.id)).toBe(true);
    // Exactly one offence was ever proven, however many reports named it.
    expect(h.chain.world.s.metrics.totalSlashes).toBe(1);
    expect(h.chain.mempool.size).toBeLessThan(pooledBefore);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('releases the reservation when a report leaves the pool', () => {
    const pool = new Mempool(DEFAULT_MEMPOOL_OPTIONS);
    const evidence = makeProposerEvidence({
      validator: 'dobs1' + '0'.repeat(58),
      height: 10,
      round: 0,
      firstId: '11'.repeat(32),
      secondId: '22'.repeat(32),
      firstHeader: 'ab'.repeat(64),
      secondHeader: 'cd'.repeat(64),
    });
    const body = encodeSlashBody({ op: SlashOp.EQUIVOCATION, evidence });
    const ids: string[] = [];
    for (let index = 0; index < DEFAULT_MEMPOOL_OPTIONS.maxPendingEvidence; index += 1) {
      const sender = makeWallet();
      const tx = {
        id: `tx-${index}`,
        version: 1,
        chainId: 7777,
        protocolVersion: PROTOCOL_VERSION,
        type: TxType.SLASH,
        sender: sender.address,
        nonce: 0,
        gas: 0n,
        validUntil: 4_000_000_000,
        body,
        signature: { publicKey: sender.publicKey, signature: '00'.repeat(64) },
      };
      const outcome = pool.add(tx as never);
      expect(outcome.accepted, `report ${index}: ${outcome.reason}`).toBe(true);
      ids.push(tx.id);
    }
    expect(pool.add({ ...pool.get(ids[0]!)!.tx, id: 'one-more' } as never).accepted).toBe(false);
    // Removing one frees exactly one slot — the accounting cannot leak, or the
    // class would slowly fill with reports that are no longer pending.
    pool.remove(ids[0]!);
    expect(pool.size).toBe(DEFAULT_MEMPOOL_OPTIONS.maxPendingEvidence - 1);
  });
});
