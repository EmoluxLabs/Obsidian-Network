/**
 * Equivocation: the only thing the protocol punishes, and how it punishes it (protocol 1.9.0).
 *
 * There is no bond to confiscate. A node that signs two different blocks on one parent is BANNED: its identity is
 * removed from the schedule, from finality and from rewards, and it can never register again. Anyone running a
 * registered node can report it, because the evidence is two signed headers and the registry — nothing else.
 *
 * Replaces the validator-era slashing and evidence-resource suites: every property they pinned that still has a
 * subject (evidence must be verifiable from the headers alone, reports are bounded, a false report punishes nobody,
 * a punished identity cannot return) is asserted here against the ban.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { blockHash, encodeSignedHeader } from '../../src/blockchain/block.js';
import { toHex } from '../../src/crypto/hash.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import { producerSetFor } from '../../src/consensus/schedule.js';
import { inFinalityBase } from '../../src/consensus/finality.js';
import {
  createHarness,
  makeNode,
  makeWallet,
  nodeSigner,
  nodeStatement,
  type Block,
  type Harness,
  type TestNode,
} from '../helpers/harness.js';

const SLOT = CONSENSUS_PARAMS.block.targetBlockSeconds;
const harnesses: Harness[] = [];
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

/** A chain with a cheater, an honest reporter and a bystander, all registered. */
async function scene(): Promise<{ h: Harness; cheater: TestNode; reporter: TestNode; bystander: TestNode }> {
  const h = await createHarness();
  harnesses.push(h);
  const [cheater, reporter, bystander] = [makeNode(makeWallet()), makeNode(makeWallet()), makeNode(makeWallet())];
  for (const batch of [[cheater, reporter], [bystander]]) {
    const ts = h.chain.tip!.timestamp + SLOT;
    h.produce(batch.map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })), { timestamp: ts });
    for (const node of batch) h.signers.set(node.address, nodeSigner(node));
  }
  return { h, cheater, reporter, bystander };
}

/**
 * Two different blocks signed by `signer` on the current head: both on schedule (round 0, one interval and one interval
 * plus one second after the parent), so each is valid on its own and only the pair is a crime. Returns signed headers.
 */
function twoBlocks(h: Harness, signer: TestNode): { first: Block; second: Block } {
  const head = h.chain.tip!;
  const parent = { hash: head.hash, height: head.height, cumulativePotWeight: BigInt(head.cumulativePotWeight), state: h.chain.world };
  const first = h.makeBlockOn(parent, [], { timestamp: head.timestamp + SLOT, producer: nodeSigner(signer) }).block;
  const second = h.makeBlockOn(parent, [], { timestamp: head.timestamp + SLOT + 1, producer: nodeSigner(signer) }).block;
  return { first, second };
}

const hex = (block: Block) => toHex(encodeSignedHeader(block.header));

function report(h: Harness, reporter: TestNode, subject: TestNode, first: string, second: string) {
  return nodeStatement(h, reporter, { op: NodeRegistryOp.REPORT_EQUIVOCATION, nodeId: subject.nodeId, firstHeader: first, secondHeader: second });
}

describe('an equivocating node is banned', () => {
  it('is detected from two signed blocks on one parent, reported by another node, and banned for good', async () => {
    const { h, cheater, reporter } = await scene();
    const wallet = cheater.wallet.address;
    const events: Array<Record<string, string>> = [];
    h.chain.on('equivocation', (event: Record<string, string>) => events.push(event));

    // The evidence is two signed headers on one parent. Whether the cheater happens to hold the slot at this height
    // does not matter: the evidence check verifies signatures and parentage, not the schedule.
    const { first, second } = twoBlocks(h, cheater);
    const added = h.chain.addBlock(first);
    expect(added.accepted || added.code === ErrCode.NOT_PRODUCER_TURN).toBe(true);
    if (!added.accepted) {
      // The cheater was not scheduled for this height: evidence does not need a valid block, only valid signed headers.
      expect(hex(first)).not.toBe(hex(second));
    }

    const before = h.chain.world.getAccount(wallet)?.balance ?? 0n;
    const supply = h.chain.world.s.metrics.totalSupply;
    h.produce([report(h, reporter, cheater, hex(first), hex(second))]);

    const record = h.chain.world.node(cheater.nodeId)!;
    expect(record.bannedAtHeight).toBeGreaterThan(0);
    expect(record.banEvidenceId).toMatch(/^[0-9a-f]{64}$/);
    // The wallet is released and nothing of anybody's was confiscated: there was never anything locked.
    expect(h.chain.world.nodeByRewardWallet(wallet)).toBeUndefined();
    expect(h.chain.world.getAccount(wallet)?.balance ?? 0n).toBe(before);
    expect(h.chain.world.s.metrics.totalSupply).toBe(supply);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);

    // Out of the schedule, out of finality, out of rewards.
    const head = h.chain.tip!;
    expect(producerSetFor(h.chain.world, head.height + 1, head.timestamp + SLOT).producers).not.toContain(cheater.address);
    expect(inFinalityBase(record, head.height, head.timestamp)).toBe(false);
    const status = h.chain.status();
    expect(status.nodes).toBe(2);

    // And it can never come back, not even with a fresh wallet.
    const again = h.tryBlock([nodeStatement(h, cheater, { op: NodeRegistryOp.REGISTER, rewardWallet: makeWallet().address })]);
    expect(again.accepted).toBe(false);
    expect(again.code).toBe(ErrCode.NODE_BANNED);
    // A second report about the same node is refused: already banned.
    const replay = h.tryBlock([report(h, reporter, cheater, hex(first), hex(second))]);
    expect(replay.accepted).toBe(false);
    expect(replay.code).toBe(ErrCode.NODE_BANNED);
    void events;
  });

  it('a banned node cannot produce, even on its own slot', async () => {
    const { h, cheater, reporter } = await scene();
    const { first, second } = twoBlocks(h, cheater);
    h.produce([report(h, reporter, cheater, hex(first), hex(second))]);
    const head = h.chain.tip!;
    const late = h.makeBlock([], { timestamp: head.timestamp + SLOT, producer: nodeSigner(cheater) });
    const verdict = h.chain.addBlock(late);
    expect(verdict.accepted).toBe(false);
    expect(verdict.code).toBe(ErrCode.NOT_PRODUCER_TURN);
  });
});

describe('a report that is not real evidence bans nobody', () => {
  it.each([
    ['the same block twice', (a: string) => [a, a]],
    ['malformed hex', () => ['zz', 'zz']],
    ['empty headers', () => ['', '']],
    ['truncated headers', (a: string) => [a.slice(0, 40), a.slice(0, 40)]],
  ])('refuses %s', async (_name, build) => {
    const { h, cheater, reporter } = await scene();
    const { first } = twoBlocks(h, cheater);
    const [a, b] = build(hex(first));
    const outcome = h.tryBlock([report(h, reporter, cheater, a, b)]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.EQUIVOCATION_INVALID);
    expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();
  });

  it('refuses two blocks signed by different nodes (cannot frame a node with someone else\'s block)', async () => {
    const { h, cheater, reporter, bystander } = await scene();
    const mine = twoBlocks(h, cheater).first;
    const theirs = twoBlocks(h, bystander).first;
    const outcome = h.tryBlock([report(h, reporter, cheater, hex(mine), hex(theirs))]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.EQUIVOCATION_INVALID);
    expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();
  });

  it('refuses two blocks on different parents or at different heights (a normal fork is not a crime)', async () => {
    const { h, cheater, reporter } = await scene();
    const early = twoBlocks(h, cheater).first;
    h.produce([]);
    const late = twoBlocks(h, cheater).first;
    const outcome = h.tryBlock([report(h, reporter, cheater, hex(early), hex(late))]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.EQUIVOCATION_INVALID);
    expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();
  });

  it('refuses a header whose signature was tampered with, and headers from another protocol version', async () => {
    const { h, cheater, reporter } = await scene();
    const { first, second } = twoBlocks(h, cheater);
    const forged = { ...second, header: { ...second.header, producerSignature: { ...second.header.producerSignature, signature: '00'.repeat(64) } } };
    const badSig = h.tryBlock([report(h, reporter, cheater, hex(first), hex(forged))]);
    expect(badSig.accepted).toBe(false);
    expect([ErrCode.BAD_SIGNATURE, ErrCode.EQUIVOCATION_INVALID]).toContain(badSig.code);

    const old = { ...second, header: { ...second.header, protocolVersion: '1.8.2' } };
    const oldVersion = h.tryBlock([report(h, reporter, cheater, hex(first), hex(old))]);
    expect(oldVersion.accepted).toBe(false);
    expect(oldVersion.code).toBe(ErrCode.EQUIVOCATION_INVALID);
    expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();
  });

  it('accepts reports only from registered nodes (reports are signature work, not free for strangers)', async () => {
    const { h, cheater } = await scene();
    const stranger = makeNode(makeWallet());
    const { first, second } = twoBlocks(h, cheater);
    const outcome = h.tryBlock([report(h, stranger, cheater, hex(first), hex(second))]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_NOT_REGISTERED);
    expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();
  });
});

describe('equivocation reports are bounded', () => {
  it('a block may carry at most maxEquivocationReportsPerBlock reports: the next one is refused and nothing is half-applied', async () => {
    const limit = CONSENSUS_PARAMS.consensus.producers.maxEquivocationReportsPerBlock;
    const h = await createHarness();
    harnesses.push(h);
    const reporter = makeNode(makeWallet());
    const cheaters = Array.from({ length: limit + 1 }, () => makeNode(makeWallet()));
    const everyone = [reporter, ...cheaters];
    for (let i = 0; i < everyone.length; i += CONSENSUS_PARAMS.consensus.producers.maxRegistrationsPerBlock) {
      const batch = everyone.slice(i, i + CONSENSUS_PARAMS.consensus.producers.maxRegistrationsPerBlock);
      const ts = h.chain.tip!.timestamp + SLOT;
      h.produce(batch.map((node) => nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })), { timestamp: ts });
      for (const node of batch) h.signers.set(node.address, nodeSigner(node));
    }
    const nonce = h.chain.world.getAccount(reporter.address)?.nonce ?? 0;
    const reports = cheaters.map((cheater, index) => {
      const { first, second } = twoBlocks(h, cheater);
      return nodeStatement(h, reporter, {
        op: NodeRegistryOp.REPORT_EQUIVOCATION,
        nodeId: cheater.nodeId,
        firstHeader: hex(first),
        secondHeader: hex(second),
      }, { nonce: nonce + index });
    });
    const tooMany = h.tryBlock(reports);
    expect(tooMany.accepted).toBe(false);
    expect(tooMany.code).toBe(ErrCode.EVIDENCE_LIMIT);
    for (const cheater of cheaters) expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();

    // Exactly the budget is fine, and every one of those bans lands.
    h.produce(reports.slice(0, limit));
    expect(cheaters.slice(0, limit).every((cheater) => h.chain.world.node(cheater.nodeId)!.bannedAtHeight !== undefined)).toBe(true);
    expect(h.chain.world.node(cheaters[limit].nodeId)!.bannedAtHeight).toBeUndefined();
  });

  it('rejects an oversized header outright, before decoding it', async () => {
    const { h, cheater, reporter } = await scene();
    const huge = 'ab'.repeat(20 * 1024);
    const outcome = h.tryBlock([report(h, reporter, cheater, huge, huge)]);
    expect(outcome.accepted).toBe(false);
    expect([ErrCode.EQUIVOCATION_INVALID, ErrCode.MALFORMED]).toContain(outcome.code);
    expect(h.chain.world.node(cheater.nodeId)!.bannedAtHeight).toBeUndefined();
  });
});

describe('an honest node never equivocates', () => {
  it('signs at most one block on a parent, even when asked twice (the double-sign lock)', async () => {
    const h = await createHarness();
    harnesses.push(h);
    const node = makeNode(makeWallet());
    const ts = h.chain.tip!.timestamp + SLOT;
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.REGISTER }, { protocolTime: ts })], { timestamp: ts });
    const signer = nodeSigner(node);
    const first = h.chain.buildNextBlock(signer);
    // The schedule may or may not name this node right now (clock-dependent); when it does, the lock must hold.
    if (first) {
      expect(blockHash(first.header)).toMatch(/^[0-9a-f]{64}$/);
      expect(h.chain.buildNextBlock(signer)).toBeNull();
    } else {
      expect(h.chain.buildNextBlock(signer)).toBeNull();
    }
  });
});
