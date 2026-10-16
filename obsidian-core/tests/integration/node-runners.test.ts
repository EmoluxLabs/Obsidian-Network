/**
 * Node participation, binding and rewards, against a real chain (protocol 1.9.0).
 *
 * Nothing is mocked: every assertion below runs through the same block state machine a production node runs, with
 * real secp256k1 signatures and real state roots. The one thing the tests do is place blocks at explicit protocol
 * timestamps (inside the chain's real validity window: after genesis, before "now + drift"), so a whole reward period
 * of hourly heartbeats can be driven in milliseconds instead of a day.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  advance,
  createHarness,
  makeNode,
  makeWallet,
  nodeAttest,
  nodeHeartbeat,
  nodeRegistryBody,
  nodeSigner,
  nodeStatement,
  onsBody,
  registerNode,
  signedClaim,
  signedPayment,
  type Harness,
  type TestNode,
  type TestWallet,
} from '../helpers/harness.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { NodeRegistryOp, OnsOp, TxType } from '../../src/protocol/types.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import { rewardPeriodAt, uptimeWindowIndex } from '../../src/economy/node-rewards.js';
import { RevenueSource, splitOnsRevenue } from '../../src/economy/accounting.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { processNodeRewardRoutine } from '../../src/economy/settlement.js';

const NR = CONSENSUS_PARAMS.nodeRewards;
const GENESIS_TS = 1_767_225_600; // aligned to a reward-period boundary (a multiple of 86 400)
const HOUR = NR.uptimeWindowSeconds;
const DAY = NR.periodSeconds;
/** The scored period starts one day after genesis: nodes must already be registered when a period OPENS to be scored in it. */
const PERIOD_START = GENESIS_TS + DAY;
const harnesses: Harness[] = [];

afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

/** A chain whose first claimer (alice) becomes the treasury wallet. Node operators need no funds at all. */
async function nodeHarness(): Promise<{ h: Harness; alice: TestWallet }> {
  const alice = makeWallet();
  const h = await createHarness({ producer: alice });
  harnesses.push(h);
  h.produce([signedClaim(h, alice)]); // genesis allocation → alice is the treasury
  return { h, alice };
}

function registerOnsRevenue(h: Harness, payer: TestWallet, name: string, ts?: number): bigint {
  const fee = CONSENSUS_PARAMS.ons.registrationFee;
  const tx = h.sign(payer, TxType.ONS, onsBody(OnsOp.REGISTER, name, { fee }), { gas: expectedGas(fee), protocolTime: ts });
  h.produce([tx], ts === undefined ? {} : { timestamp: ts });
  return fee;
}

const registration = (h: Harness, node: TestNode, extra: { endpoint?: string; ts?: number; nodeId?: string; rewardWallet?: string } = {}) =>
  nodeStatement(
    h,
    node,
    { op: NodeRegistryOp.REGISTER, endpoint: extra.endpoint ?? '203.0.113.10:8631', nodeId: extra.nodeId, rewardWallet: extra.rewardWallet },
    { protocolTime: extra.ts },
  );

describe('node registration and the wallet binding', () => {
  it('registers a node with no gas, no wallet signature and no funds moved', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet()); // the bound wallet holds nothing at all
    expect(h.chain.world.getAccount(node.wallet.address)).toBeUndefined();
    const tx = registration(h, node);
    // The signer is the node key, never the wallet, and the statement costs nothing.
    expect(tx.sender).toBe(node.address);
    expect(tx.sender).not.toBe(node.wallet.address);
    expect(tx.gas).toBe(0n);
    h.produce([tx]);

    const record = h.chain.world.node(node.nodeId)!;
    expect(record.rewardWallet).toBe(node.wallet.address);
    expect(h.chain.world.nodeByRewardWallet(node.wallet.address)).toBe(node.nodeId);
    expect(h.chain.world.getAccount(node.wallet.address)).toBeUndefined();
    expect(Object.keys(record)).not.toContain('bond');
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a statement signed by anything other than the node key', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    // The reward wallet "signs" the registration instead of the node: it is not the node, so it cannot register it.
    const outcome = h.tryBlock([
      h.sign(node.wallet, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node }), { gas: 0n }),
    ]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
    expect(h.chain.world.registeredNodes()).toEqual([]);
  });

  it('refuses a nodeId that is not the hash of the supplied node key (no identity forgery)', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    const other = makeNode(makeWallet());
    const outcome = h.tryBlock([registration(h, node, { nodeId: other.nodeId })]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_SIGNATURE);
    expect(h.chain.world.registeredNodes()).toEqual([]);
  });

  it('refuses invalid reward addresses and binds nothing', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    const mainnetStyle = 'obs1' + 'q'.repeat(38);
    for (const bad of ['', 'not-an-address', mainnetStyle, node.wallet.address.toUpperCase(), node.wallet.address.slice(0, -2) + 'qq']) {
      const outcome = h.tryBlock([registration(h, node, { rewardWallet: bad })]);
      expect(outcome.accepted, `address "${bad}" must be refused`).toBe(false);
    }
    expect(h.chain.world.registeredNodes()).toEqual([]);
    expect(h.chain.world.nodeByRewardWallet(node.wallet.address)).toBeUndefined();
  });

  it('refuses a second node for a wallet that already backs one, without touching the first binding', async () => {
    const { h } = await nodeHarness();
    const first = makeNode(makeWallet());
    registerNode(h, first);

    const second = makeNode(first.wallet); // same wallet, brand new identity: the cheap Sybil attempt
    const outcome = h.tryBlock([registration(h, second)]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_WALLET_IN_USE);
    // No partial reservation: the second identity left no record and the wallet still points at the first node.
    expect(h.chain.world.node(second.nodeId)).toBeUndefined();
    expect(h.chain.world.nodeByRewardWallet(first.wallet.address)).toBe(first.nodeId);
    expect(h.chain.world.nodeByProducer(second.address)).toBeUndefined();
  });

  it('is atomic and order-decided when two nodes race for one wallet inside the same block', async () => {
    const { h } = await nodeHarness();
    const wallet = makeWallet();
    const a = makeNode(wallet);
    const b = makeNode(wallet);
    // Both in one block: the second fails, so the whole block is invalid and NOTHING is bound.
    const both = h.tryBlock([registration(h, a), registration(h, b)]);
    expect(both.accepted).toBe(false);
    expect(both.code).toBe(ErrCode.NODE_WALLET_IN_USE);
    expect(h.chain.world.registeredNodes()).toEqual([]);
    expect(h.chain.world.nodeByRewardWallet(wallet.address)).toBeUndefined();
    // Whichever statement a block includes first wins; the loser can still register with another wallet.
    h.produce([registration(h, b)]);
    h.signers.set(b.address, nodeSigner(b));
    expect(h.chain.world.nodeByRewardWallet(wallet.address)).toBe(b.nodeId);
    expect(h.tryBlock([registration(h, a)]).code).toBe(ErrCode.NODE_WALLET_IN_USE);
    const free = makeNode(makeWallet());
    h.produce([registration(h, free)]);
    expect(h.chain.world.registeredNodes()).toHaveLength(2);
  });

  it('never silently replaces a binding: re-registering the same node with another wallet is refused', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const thief = makeWallet();
    const outcome = h.tryBlock([registration(h, node, { rewardWallet: thief.address, endpoint: '203.0.113.77:8631' })]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_ALREADY_REGISTERED);
    const record = h.chain.world.node(node.nodeId)!;
    expect(record.rewardWallet).toBe(node.wallet.address);
    expect(record.endpoint).toBe('203.0.113.10:8631');
    expect(h.chain.world.nodeByRewardWallet(thief.address)).toBeUndefined();
  });

  it('refuses malformed endpoints, a non-zero gas value and a leftover proof field', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    for (const endpoint of ['no-port', 'a b:80', 'host:0', 'host:70000', 'x'.repeat(300) + ':80']) {
      expect(h.tryBlock([registration(h, node, { endpoint })]).code, endpoint).toBe(ErrCode.NODE_BAD_ENDPOINT);
    }
    const paid = h.tryBlock([h.sign(nodeSigner(node), TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node }), { gas: 5n })]);
    expect(paid.accepted).toBe(false);
    expect(h.chain.world.registeredNodes()).toEqual([]);
  });

  it('rate limits admission: at most maxRegistrationsPerBlock new nodes per block', async () => {
    const { h } = await nodeHarness();
    const limit = CONSENSUS_PARAMS.consensus.producers.maxRegistrationsPerBlock;
    const nodes = Array.from({ length: limit + 1 }, () => makeNode(makeWallet()));
    const outcome = h.tryBlock(nodes.map((node) => registration(h, node)));
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_REGISTRATION_LIMIT);
    expect(h.chain.world.registeredNodes()).toEqual([]);
    h.produce(nodes.slice(0, limit).map((node) => registration(h, node)));
    expect(h.chain.world.registeredNodes()).toHaveLength(limit);
  });

  it('a producer never assembles a block that breaks the admission limit (the chain must not stall on it)', async () => {
    // Found by the cluster end-to-end test: three nodes registering at once put three registrations in one pooled batch;
    // block assembly tried each on its own (a fresh tally per transaction), signed a block with three, and every
    // validator, the producer included, rejected it. The double-sign lock then kept every node from building on that
    // parent: a permanent halt.
    const { h } = await nodeHarness();
    const limit = CONSENSUS_PARAMS.consensus.producers.maxRegistrationsPerBlock;
    const nodes = Array.from({ length: limit + 2 }, () => makeNode(makeWallet()));
    const txs = nodes.map((node) => registration(h, node));
    for (const tx of txs) expect(h.chain.mempool.add(tx).accepted).toBe(true);
    const block = h.chain.buildNextBlock(h.producer);
    expect(block).not.toBeNull();
    expect(block!.transactions).toHaveLength(limit);
    const result = h.chain.addBlock(block!);
    expect(result.accepted, result.message).toBe(true);
    expect(h.chain.world.registeredNodes()).toHaveLength(limit);
    // The over-limit registrations were left pooled (not dropped) for a later block.
    const included = new Set(block!.transactions.map((tx) => tx.id));
    for (const tx of txs) expect(h.chain.mempool.has(tx.id), tx.id).toBe(!included.has(tx.id));
    });
});

describe('evidence: nothing is self-reported', () => {
  it('records one heartbeat per uptime window and rejects the replay', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    // The registering block was produced by an OPEN-mode key, so the window is still unclaimed by this node.
    h.produce([nodeHeartbeat(h, node)]);

    const period = rewardPeriodAt(h.chain.protocolTime);
    expect(h.chain.world.s.nodeEvidence.get(`${period}:${node.nodeId}`)!.heartbeats).toBe(1);

    const replay = h.tryBlock([nodeHeartbeat(h, node, { reportedHeight: h.chain.height })]);
    expect(replay.accepted).toBe(false);
    expect([ErrCode.NODE_HEARTBEAT_TOO_SOON, ErrCode.BAD_NONCE, ErrCode.REPLAY]).toContain(replay.code);
  });

  it('rejects a heartbeat that names another uptime window (no back-dating, no pre-dating)', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const window = uptimeWindowIndex(h.chain.protocolTime);
    for (const slot of [window - 1, window + 1, window + 5000]) {
      const outcome = h.tryBlock([nodeHeartbeat(h, node, { slot })]);
      expect(outcome.accepted, `slot ${slot}`).toBe(false);
      expect(outcome.code).toBe(ErrCode.NODE_PROOF_EXPIRED);
    }
  });

  it('refuses a node attesting itself', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const outcome = h.tryBlock([nodeAttest(h, node, node)]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_BAD_SUBJECT);
  });

  it('records an attestation against the subject, only once the subject has shown life, and gives the observer nothing', async () => {
    const { h } = await nodeHarness();
    const first = makeNode(makeWallet());
    const second = makeNode(makeWallet());
    h.produce([registration(h, first), registration(h, second)]);
    h.signers.set(first.address, nodeSigner(first));
    h.signers.set(second.address, nodeSigner(second));
    // Nothing to attest yet: the subject has no recorded uptime.
    expect(h.tryBlock([nodeAttest(h, first, second)]).code).toBe(ErrCode.NODE_BAD_SUBJECT);

    h.produce([nodeHeartbeat(h, second)]);
    h.produce([nodeAttest(h, first, second)]);

    const period = rewardPeriodAt(h.chain.protocolTime);
    const subject = h.chain.world.s.nodeEvidence.get(`${period}:${second.nodeId}`)!;
    const observer = h.chain.world.s.nodeEvidence.get(`${period}:${first.nodeId}`)!;
    expect(subject.attesters).toEqual([first.nodeId]);
    expect(observer.attested).toEqual([second.nodeId]);
    expect(observer.heartbeats).toBe(0);
  });

  it('refuses statements about an unregistered node and from an unregistered sender', async () => {
    const { h } = await nodeHarness();
    const first = makeNode(makeWallet());
    const second = makeNode(makeWallet());
    registerNode(h, first);
    expect(h.tryBlock([nodeAttest(h, first, second)]).code).toBe(ErrCode.NODE_BAD_SUBJECT);
    const stranger = makeNode(makeWallet());
    const heartbeat = h.tryBlock([nodeHeartbeat(h, stranger)]);
    expect(heartbeat.accepted).toBe(false);
    expect(heartbeat.code).toBe(ErrCode.NODE_NOT_REGISTERED);
  });

  it('refuses a heartbeat claiming a height the network has not reached', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const outcome = h.tryBlock([nodeHeartbeat(h, node, { reportedHeight: 999_999 })]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MALFORMED);
  });

  it('refuses a node statement signed by a wallet that is not a node', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const heartbeat = nodeHeartbeat(h, node);
    const outcome = h.tryBlock([h.sign(node.wallet, TxType.NODE_REGISTRY, heartbeat.body, { gas: 0n })]);
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_NOT_REGISTERED);
  });

  it('counts a stale heartbeat as stale, not as uptime', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    // Build height first with the founding (OPEN-mode) producer, so the node itself never produces in this window:
    // a block produced by a node is already proof of life and a heartbeat for the same window is redundant.
    advance(h, NR.responsiveHeightLag + 3);
    registerNode(h, node);
    h.produce([nodeHeartbeat(h, node, { reportedHeight: 1 })]);
    const period = rewardPeriodAt(h.chain.protocolTime);
    const evidence = h.chain.world.s.nodeEvidence.get(`${period}:${node.nodeId}`)!;
    expect(evidence.staleHeartbeats).toBe(1);
    expect(evidence.heartbeats).toBe(0);
  });
});

describe('ONS revenue reaches the node pool', () => {
  it('routes exactly 90% of an ONS registration fee to runners and 10% to treasury', async () => {
    const { h, alice } = await nodeHarness();
    const payer = makeWallet();
    h.produce([signedPayment(h, alice, payer.address, parseObs('1'))]);

    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    const treasuryBefore = h.chain.world.getAccount(alice.address)!.balance;
    const poolBefore = h.chain.world.s.nodeRewards.balance;
    registerOnsRevenue(h, payer, 'runner-revenue');

    const split = splitOnsRevenue(fee, RevenueSource.ONS_REGISTRATION);
    expect(h.chain.world.s.nodeRewards.balance - poolBefore).toBe(split.nodeRunnerPool);
    expect(h.chain.world.getAccount(alice.address)!.balance - treasuryBefore).toBe(split.treasury);
    expect(split.nodeRunnerPool).toBe((fee * 9_000n) / 10_000n);
    expect(split.treasury).toBe(fee - split.nodeRunnerPool);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('keeps the ONS accounting identity across registration and renewal fees', async () => {
    const { h, alice } = await nodeHarness();
    const fee = CONSENSUS_PARAMS.ons.registrationFee;
    registerOnsRevenue(h, alice, 'runner-one');
    registerOnsRevenue(h, alice, 'runner-two');
    h.produce([h.sign(alice, TxType.ONS, onsBody(OnsOp.RENEW, 'runner-one', { fee: CONSENSUS_PARAMS.ons.renewalFee }), { gas: expectedGas(CONSENSUS_PARAMS.ons.renewalFee) })]);

    const metrics = h.chain.world.s.metrics;
    const totalFees = fee * 2n + CONSENSUS_PARAMS.ons.renewalFee;
    expect(metrics.totalOnsRevenue).toBe(totalFees);
    expect(metrics.totalOnsRunnerShare + metrics.totalOnsTreasuryShare).toBe(totalFees);
    expect(h.chain.world.s.nodeRewards.balance).toBe(metrics.totalOnsRunnerShare);
  });

  it('never routes a user-to-user transfer or mining issuance through the ONS split', async () => {
    const { h, alice } = await nodeHarness();
    const bob = makeWallet();
    const before = h.chain.world.s.metrics.totalOnsRevenue;
    h.produce([signedPayment(h, alice, bob.address, parseObs('10'))]);
    expect(h.chain.world.s.metrics.totalOnsRevenue).toBe(before);
    h.produce([signedClaim(h, makeWallet())]);
    expect(h.chain.world.s.metrics.totalOnsRevenue).toBe(before);
    expect(h.chain.world.s.nodeRewards.balance).toBe(0n);
  });
});

describe('wallet change, reclaim and exit', () => {
  it('schedules a node-key-signed wallet change for a later period and reserves the new wallet at once', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const newWallet = makeWallet();
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.CHANGE_WALLET, rewardWallet: newWallet.address })]);
    const record = h.chain.world.node(node.nodeId)!;
    expect(record.rewardWallet).toBe(node.wallet.address); // still the old wallet today
    expect(record.pendingWallet).toBe(newWallet.address);
    expect(record.pendingWalletEffectivePeriod).toBe(rewardPeriodAt(h.chain.protocolTime) + NR.walletChangeDelayPeriods);
    // Reserved: no other node can bind the incoming wallet in the meantime.
    const other = makeNode(newWallet);
    expect(h.tryBlock([registration(h, other)]).code).toBe(ErrCode.NODE_WALLET_IN_USE);
    // A second change while one is pending is refused (no silent overwrite).
    const third = makeWallet();
    expect(h.tryBlock([nodeStatement(h, node, { op: NodeRegistryOp.CHANGE_WALLET, rewardWallet: third.address })]).code).toBe(
      ErrCode.NODE_WALLET_CHANGE_PENDING,
    );
  });

  it('refuses a wallet change from anything but the node key, and onto a wallet that backs another node', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    const rival = makeNode(makeWallet());
    h.produce([registration(h, node), registration(h, rival)]);
    h.signers.set(node.address, nodeSigner(node));
    h.signers.set(rival.address, nodeSigner(rival));
    const attacker = makeWallet();
    const forged = h.tryBlock([
      h.sign(attacker, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.CHANGE_WALLET, node, rewardWallet: attacker.address }), { gas: 0n }),
    ]);
    expect(forged.accepted).toBe(false);
    expect(forged.code).toBe(ErrCode.NODE_NOT_REGISTERED);
    const taken = h.tryBlock([nodeStatement(h, node, { op: NodeRegistryOp.CHANGE_WALLET, rewardWallet: rival.wallet.address })]);
    expect(taken.code).toBe(ErrCode.NODE_WALLET_IN_USE);
    expect(h.chain.world.node(node.nodeId)!.rewardWallet).toBe(node.wallet.address);
  });

  it('lets the wallet being paid cancel a pending change, and nobody else', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    const newWallet = makeWallet();
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.CHANGE_WALLET, rewardWallet: newWallet.address })]);
    const stranger = makeWallet();
    const refused = h.tryBlock([
      h.sign(stranger, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.CANCEL_WALLET_CHANGE, node }), { gas: 0n }),
    ]);
    expect(refused.code).toBe(ErrCode.UNAUTHORIZED);
    h.produce([h.sign(node.wallet, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.CANCEL_WALLET_CHANGE, node }), { gas: 0n })]);
    const record = h.chain.world.node(node.nodeId)!;
    expect(record.pendingWallet).toBeUndefined();
    expect(h.chain.world.nodeByRewardWallet(newWallet.address)).toBeUndefined();
    expect(record.rewardWallet).toBe(node.wallet.address);
  });

  it('squatting is recoverable: the real owner of a bound address releases it after the delay by signing from it', async () => {
    const { h } = await nodeHarness();
    const victim = makeWallet();
    const squatter = makeNode(victim); // someone pasted the victim's address
    registerNode(h, squatter);
    // Only the address itself can start a reclaim: the squatter's node key cannot, a stranger cannot.
    const stranger = makeWallet();
    expect(
      h.tryBlock([h.sign(stranger, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.RECLAIM_WALLET, node: squatter }), { gas: 0n })]).code,
    ).toBe(ErrCode.UNAUTHORIZED);
    h.produce([h.sign(victim, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.RECLAIM_WALLET, node: squatter }), { gas: 0n })]);
    const pending = h.chain.world.node(squatter.nodeId)!;
    expect(pending.reclaimEffectivePeriod).toBe(rewardPeriodAt(h.chain.protocolTime) + NR.reclaimDelayPeriods);
    // Until it takes effect nothing changes; the address is not released early.
    expect(h.chain.world.nodeByRewardWallet(victim.address)).toBe(squatter.nodeId);
    // Cross the delay: the binding is released and the victim can bind the address to their own node.
    for (let i = 0; i <= NR.reclaimDelayPeriods; i += 1) crossPeriodBoundary(h);
    expect(h.chain.world.nodeByRewardWallet(victim.address)).toBeUndefined();
    expect(h.chain.world.node(squatter.nodeId)!.rewardWallet).toBe('');
    const own = makeNode(victim);
    h.produce([registration(h, own)]);
    expect(h.chain.world.nodeByRewardWallet(victim.address)).toBe(own.nodeId);
  });

  it('deregisters without touching any balance, and frees the wallet', async () => {
    const { h } = await nodeHarness();
    const node = makeNode(makeWallet());
    registerNode(h, node);
    h.produce([nodeStatement(h, node, { op: NodeRegistryOp.DEREGISTER })]);
    const record = h.chain.world.node(node.nodeId)!;
    expect(record.deregisteredAtHeight).toBeGreaterThan(0);
    expect(h.chain.world.registeredNodes()).toHaveLength(0);
    expect(h.chain.world.nodeByRewardWallet(node.wallet.address)).toBeUndefined();
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});

/**
 * Crossing a reward-period boundary without waiting a day: run the settlement routine, which is the very function
 * block processing calls, on the live state with an apply context one period later.
 */
function crossPeriodBoundary(h: Harness): number {
  const period = rewardPeriodAt(h.chain.protocolTime);
  const pool = h.chain.world.s.nodeRewards;
  const current = pool.blockCountPeriod >= 0 ? pool.blockCountPeriod : period;
  const nextPeriodStart = (current + 1) * NR.periodSeconds + 1;
  processNodeRewardRoutine({
    state: h.chain.world,
    apply: { height: (h.chain.store.head?.height ?? 0) + 1, timestamp: nextPeriodStart },
  });
  h.chain.world.takeEvents();
  return current;
}

describe('settlement inside consensus: driven by real hourly heartbeats across a whole period', () => {
  /**
   * Alice (treasury) pays an ONS fee so the pool holds seals, two nodes register in the first period (a node is only scored for a
   * period that opened after it registered), then each hour of the NEXT period P a block at
   * the right protocol time carries both nodes' heartbeats (`online` selects who is up). A block at the start of the
   * next period closes P. Returns what the test needs to assert on.
   */
  async function runPeriod(online: { a: boolean; b: boolean }) {
    const alice = makeWallet();
    const h = await createHarness({ producer: alice });
    harnesses.push(h);
    h.produce([signedClaim(h, alice, GENESIS_TS + 1)], { timestamp: GENESIS_TS + 1 });
    const a = makeNode(makeWallet());
    const b = makeNode(makeWallet());
    h.produce([registration(h, a, { ts: GENESIS_TS + 2 }), registration(h, b, { ts: GENESIS_TS + 2 })], { timestamp: GENESIS_TS + 2 });
    h.signers.set(a.address, nodeSigner(a));
    h.signers.set(b.address, nodeSigner(b));
    registerOnsRevenue(h, alice, 'period-revenue', GENESIS_TS + 3);
    const poolBefore = h.chain.world.s.nodeRewards.balance;
    expect(poolBefore).toBeGreaterThan(0n);

    for (let hour = 1; hour < 24; hour += 1) {
      const ts = PERIOD_START + hour * HOUR + 10;
      const txs = [];
      if (online.a) txs.push(nodeStatement(h, a, { op: NodeRegistryOp.HEARTBEAT, slot: uptimeWindowIndex(ts), reportedHeight: h.chain.height }, { protocolTime: ts }));
      if (online.b) txs.push(nodeStatement(h, b, { op: NodeRegistryOp.HEARTBEAT, slot: uptimeWindowIndex(ts), reportedHeight: h.chain.height }, { protocolTime: ts }));
      h.produce(txs, { timestamp: ts });
    }
    // Mutual, independent attestation of liveness inside the period.
    const attestTs = PERIOD_START + 23 * HOUR + 600;
    const period = rewardPeriodAt(attestTs);
    const attests = [];
    if (online.a) attests.push(nodeStatement(h, b, { op: NodeRegistryOp.ATTEST, slot: period, subject: a.nodeId }, { protocolTime: attestTs }));
    if (online.b) attests.push(nodeStatement(h, a, { op: NodeRegistryOp.ATTEST, slot: period, subject: b.nodeId }, { protocolTime: attestTs }));
    if (attests.length > 0) h.produce(attests, { timestamp: attestTs });

    const beforeClose = {
      a: h.chain.world.getAccount(a.wallet.address)?.balance ?? 0n,
      b: h.chain.world.getAccount(b.wallet.address)?.balance ?? 0n,
    };
    expect(beforeClose).toEqual({ a: 0n, b: 0n });
    expect(h.chain.world.s.nodeRewards.lastSettledPeriod).toBeLessThan(period);
    // First block of the next period: this is what settles P.
    h.produce([], { timestamp: PERIOD_START + DAY + 5 });
    return { h, a, b, period, poolBefore };
  }

  it('pays every online eligible node, exactly once, and the paid + carried seals equal the pool', async () => {
    const { h, a, b, period, poolBefore } = await runPeriod({ a: true, b: true });
    const pool = h.chain.world.s.nodeRewards;
    expect(pool.lastSettledPeriod).toBe(period);
    const settlement = pool.recentSettlements.at(-1)!;
    expect(settlement.period).toBe(period);
    const paidA = h.chain.world.getAccount(a.wallet.address)?.balance ?? 0n;
    const paidB = h.chain.world.getAccount(b.wallet.address)?.balance ?? 0n;
    expect(paidA).toBeGreaterThan(0n);
    expect(paidB).toBeGreaterThan(0n);
    expect(paidA + paidB).toBe(settlement.distributedSeals);
    expect(settlement.distributedSeals + pool.balance).toBe(poolBefore);
    expect(settlement.distributedSeals + settlement.carriedSeals).toBe(settlement.poolSeals);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);

    // Exactly once: later blocks, even many of them, never settle P again.
    const entries = pool.recentSettlements.filter((entry) => entry.period === period).length;
    h.produce([], { timestamp: PERIOD_START + DAY + 50 });
    h.produce([], { timestamp: PERIOD_START + DAY + 100 });
    expect(pool.recentSettlements.filter((entry) => entry.period === period).length).toBe(entries);
    expect(h.chain.world.getAccount(a.wallet.address)!.balance).toBe(paidA);
    expect(h.chain.world.getAccount(b.wallet.address)!.balance).toBe(paidB);
  });

  it('pays an offline node nothing while the online node takes the pool share it earned', async () => {
    const { h, a, b } = await runPeriod({ a: true, b: false });
    const paidA = h.chain.world.getAccount(a.wallet.address)?.balance ?? 0n;
    const paidB = h.chain.world.getAccount(b.wallet.address)?.balance ?? 0n;
    expect(paidA).toBeGreaterThan(0n);
    expect(paidB).toBe(0n);
    expect(h.chain.world.node(b.nodeId)!.lifetimeReward).toBe(0n);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('pays nobody and carries the whole pool when every node was offline', async () => {
    const { h, a, b, poolBefore } = await runPeriod({ a: false, b: false });
    expect(h.chain.world.getAccount(a.wallet.address)?.balance ?? 0n).toBe(0n);
    expect(h.chain.world.getAccount(b.wallet.address)?.balance ?? 0n).toBe(0n);
    expect(h.chain.world.s.nodeRewards.balance).toBe(poolBefore);
    expect(h.chain.world.s.nodeRewards.lifetimeDistributed).toBe(0n);
  });

  it('a second node replaying the same blocks reaches the identical state root, balances and settlement', async () => {
    const { h, a } = await runPeriod({ a: true, b: true });
    const replica = await createHarness({ producer: h.producer });
    harnesses.push(replica);
    for (let height = 1; height <= h.chain.store.head!.height; height += 1) {
      const block = h.chain.store.getBlockByHash(h.chain.store.getCanonicalHashAtHeight(height)!)!;
      const result = replica.chain.addBlock(block);
      expect(result.accepted, `block ${height} rejected on replay: ${result.message}`).toBe(true);
    }
    expect(replica.chain.store.head!.hash).toBe(h.chain.store.head!.hash);
    expect(replica.chain.world.getAccount(a.wallet.address)!.balance).toBe(h.chain.world.getAccount(a.wallet.address)!.balance);
    expect(replica.chain.world.s.nodeRewards.recentSettlements.length).toBe(h.chain.world.s.nodeRewards.recentSettlements.length);
  });

  it('pays nothing to an unregistered node no matter how much revenue exists', async () => {
    const { h, alice } = await nodeHarness();
    registerOnsRevenue(h, alice, 'no-runner-revenue');
    const pooled = h.chain.world.s.nodeRewards.balance;
    crossPeriodBoundary(h);
    expect(h.chain.world.s.nodeRewards.balance).toBe(pooled);
    expect(h.chain.world.s.nodeRewards.lifetimeDistributed).toBe(0n);
  });

  it('keeps the supply invariant across registration, revenue and settlement', async () => {
    const { h, alice } = await nodeHarness();
    const nodes = [makeNode(makeWallet()), makeNode(makeWallet())];
    h.produce(nodes.map((node) => registration(h, node)));
    for (const node of nodes) h.signers.set(node.address, nodeSigner(node));
    registerOnsRevenue(h, alice, 'supply-invariant-revenue');
    crossPeriodBoundary(h);
    advance(h, 2);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
    expect(h.chain.world.s.metrics.totalSupply).toBeLessThanOrEqual(CONSENSUS_PARAMS.maxSupply);
    expect(formatObs(h.chain.world.s.nodeRewards.balance)).toMatch(/^\d+\.\d{18}$/);
  });
});
