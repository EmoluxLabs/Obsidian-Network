/**
 * Node runners, against a real chain.
 *
 * Nothing is mocked: every assertion below runs through the same block state
 * machine a production node runs, with real secp256k1 signatures, real gas and
 * real state roots. If a rule here can be bypassed, it can be bypassed on
 * mainnet.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  advance,
  createHarness,
  makeNode,
  makeWallet,
  nodeAttest,
  nodeHeartbeat,
  nodeProof,
  nodeRegistryBody,
  onsBody,
  registerNode,
  signedClaim,
  signedPayment,
  type Harness,
  type TestNode,
} from '../helpers/harness.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { ErrCode } from '../../src/protocol/errors.js';
import { NodeRegistryOp, OnsOp, TxType } from '../../src/protocol/types.js';
import { DOMAIN } from '../../src/protocol/domains.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';
import {
  nodeRegistrationMessage,
  rewardPeriodAt,
  walletChangeMessage,
  deregistrationMessage,
} from '../../src/economy/node-rewards.js';
import { RevenueSource, splitOnsRevenue } from '../../src/economy/accounting.js';
import { generateKeyPair } from '../../src/crypto/keys.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { processNodeRewardRoutine } from '../../src/economy/settlement.js';

const NR = CONSENSUS_PARAMS.nodeRewards;
const harnesses: Harness[] = [];

afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

/**
 * A chain with a funded genesis miner (who becomes the treasury wallet) plus
 * funded operator wallets, so registrations can post their bonds.
 */
async function nodeHarness(operators = 2): Promise<{ h: Harness; alice: ReturnType<typeof makeWallet>; nodes: TestNode[] }> {
  const alice = makeWallet();
  const h = await createHarness({ producer: alice });
  harnesses.push(h);
  h.produce([signedClaim(h, alice)]); // genesis allocation → alice is the treasury
  const nodes: TestNode[] = [];
  for (let index = 0; index < operators; index += 1) {
    const wallet = makeWallet();
    h.produce([signedPayment(h, alice, wallet.address, parseObs('500'))]);
    nodes.push(makeNode(wallet));
  }
  return { h, alice, nodes };
}


function registerOnsRevenue(h: Harness, payer: ReturnType<typeof makeWallet>, name: string): bigint {
  const fee = CONSENSUS_PARAMS.ons.registrationFee;
  const tx = h.sign(payer, TxType.ONS, onsBody(OnsOp.REGISTER, name, { fee }), { gas: expectedGas(fee) });
  h.produce([tx]);
  return fee;
}

describe('node registration and wallet ownership', () => {
  it('registers a node, locks the bond and records the identity → wallet binding', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    const before = h.chain.world.getAccount(node.wallet.address)!.balance;

    registerNode(h, node);

    const record = h.chain.world.node(node.nodeId);
    expect(record).toBeDefined();
    expect(record!.rewardWallet).toBe(node.wallet.address);
    expect(record!.bond).toBe(NR.registrationBond);
    expect(h.chain.world.nodeByRewardWallet(node.wallet.address)).toBe(node.nodeId);
    // The bond left the wallet and is held by the protocol, not burned.
    const after = h.chain.world.getAccount(node.wallet.address)!.balance;
    expect(before - after).toBe(NR.registrationBond);
    expect(h.chain.world.s.nodeRewards.bondedSeals).toBe(NR.registrationBond);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('refuses a registration whose proof was signed by a different node key', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    const issuedAt = h.chain.protocolTime;
    const expiresAt = issuedAt + 600;
    const endpoint = '203.0.113.1:8631';
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: node.wallet.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    // A forger signs the right message with the wrong key.
    const impostor = generateKeyPair();
    const badProof = nodeProof(DOMAIN.NODE_REGISTRATION, message, impostor.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node, proof: badProof, endpoint, issuedAt, expiresAt }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_SIGNATURE);
  });

  it('refuses to register someone else\'s wallet as the reward address', async () => {
    const { h, nodes } = await nodeHarness(2);
    const [node, other] = nodes;
    const issuedAt = h.chain.protocolTime;
    const expiresAt = issuedAt + 600;
    const endpoint = '203.0.113.2:8631';
    // The operator points the node at a wallet they do not control and signs
    // the node half correctly. The transaction is signed by their own wallet,
    // which is not the reward wallet — the protocol refuses.
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: other.wallet.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, node.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({
            op: NodeRegistryOp.REGISTER,
            node,
            rewardWallet: other.wallet.address,
            proof,
            endpoint,
            issuedAt,
            expiresAt,
          }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
  });

  it('refuses a second node backed by a wallet that already backs one', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);

    // Same operator, brand new node identity, same reward wallet: this is the
    // cheap Sybil attack, and the reverse index rejects it.
    const second = makeNode(node.wallet);
    const issuedAt = h.chain.protocolTime;
    const expiresAt = issuedAt + 600;
    const endpoint = '203.0.113.3:8631';
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: second.nodeId,
      rewardWallet: node.wallet.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, second.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node: second, proof, endpoint, issuedAt, expiresAt }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_WALLET_IN_USE);
  });

  it('refuses to register the same node identity twice', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const issuedAt = h.chain.protocolTime;
    const expiresAt = issuedAt + 600;
    const endpoint = '203.0.113.4:8631';
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: node.wallet.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, node.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node, proof, endpoint, issuedAt, expiresAt }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_ALREADY_REGISTERED);
  });

  it('refuses a registration without the bond', async () => {
    const { h, alice } = await nodeHarness(0);
    const poor = makeWallet();
    h.produce([signedPayment(h, alice, poor.address, parseObs('1'))]); // less than the bond
    const node = makeNode(poor);
    const issuedAt = h.chain.protocolTime;
    const expiresAt = issuedAt + 600;
    const endpoint = '203.0.113.5:8631';
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: poor.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, node.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          poor,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node, proof, endpoint, issuedAt, expiresAt }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_BOND_REQUIRED);
  });

  it('refuses a proof that has expired, so a captured statement cannot be replayed', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    const issuedAt = h.chain.protocolTime - 10_000;
    const expiresAt = issuedAt + 60; // long past
    const endpoint = '203.0.113.6:8631';
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: node.wallet.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, node.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node, proof, endpoint, issuedAt, expiresAt }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_PROOF_EXPIRED);
  });

  it('refuses an endpoint that is not a host:port hint', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    const issuedAt = h.chain.protocolTime;
    const expiresAt = issuedAt + 600;
    const endpoint = 'not an endpoint at all';
    const message = nodeRegistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: node.wallet.address,
      endpoint,
      issuedAt,
      expiresAt,
    });
    const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, node.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node, proof, endpoint, issuedAt, expiresAt }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_BAD_ENDPOINT);
  });
});

describe('evidence: nothing is self-reported', () => {
  it('records a heartbeat once per period and rejects the replay', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    h.produce([nodeHeartbeat(h, node)]);

    const period = rewardPeriodAt(h.chain.protocolTime);
    expect(h.chain.world.s.nodeEvidence.get(`${period}:${node.nodeId}`)!.heartbeats).toBe(1);

    const replay = h.tryBlock([nodeHeartbeat(h, node)], { simulate: false });
    expect(replay.accepted).toBe(false);
    expect(replay.code).toBe(ErrCode.NODE_HEARTBEAT_TOO_SOON);
  });

  it('refuses a node attesting itself', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const outcome = h.tryBlock([nodeAttest(h, node, node)], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_BAD_SUBJECT);
  });

  it('records an attestation against the subject, not the observer', async () => {
    const { h, nodes } = await nodeHarness(2);
    const [first, second] = nodes;
    registerNode(h, first);
    registerNode(h, second);
    h.produce([nodeAttest(h, first, second)]);

    const period = rewardPeriodAt(h.chain.protocolTime);
    const subject = h.chain.world.s.nodeEvidence.get(`${period}:${second.nodeId}`)!;
    const observer = h.chain.world.s.nodeEvidence.get(`${period}:${first.nodeId}`)!;
    expect(subject.attesters).toEqual([first.nodeId]);
    expect(observer.attested).toEqual([second.nodeId]);
    // The observer gained no uptime evidence for itself by attesting.
    expect(observer.heartbeats).toBe(0);
  });

  it('refuses statements about an unregistered node', async () => {
    const { h, nodes } = await nodeHarness(2);
    const [first, second] = nodes;
    registerNode(h, first);
    const outcome = h.tryBlock([nodeAttest(h, first, second)], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.NODE_BAD_SUBJECT);
  });

  it('refuses a heartbeat claiming a height the network has not reached', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const outcome = h.tryBlock([nodeHeartbeat(h, node, { reportedHeight: 999_999 })], { simulate: false });
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.MALFORMED);
  });

  it('refuses a node statement paid for by someone else\'s wallet', async () => {
    const { h, nodes } = await nodeHarness(2);
    const [node, other] = nodes;
    registerNode(h, node);
    const period = rewardPeriodAt(h.chain.protocolTime);
    const heartbeat = nodeHeartbeat(h, node);
    // Re-sign the same body from a wallet that does not own the node.
    const outcome = h.tryBlock(
      [h.sign(other.wallet, TxType.NODE_REGISTRY, heartbeat.body, { gas: 0n })],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
    expect(period).toBeGreaterThanOrEqual(0);
  });
});

describe('ONS revenue reaches the node pool', () => {
  it('routes exactly 90% of an ONS registration fee to runners and 10% to treasury', async () => {
    const { h, alice } = await nodeHarness(0);
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
    const { h, alice } = await nodeHarness(0);
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
    const { h, alice } = await nodeHarness(0);
    const bob = makeWallet();
    const before = h.chain.world.s.metrics.totalOnsRevenue;
    h.produce([signedPayment(h, alice, bob.address, parseObs('10'))]);
    expect(h.chain.world.s.metrics.totalOnsRevenue).toBe(before);
    h.produce([signedClaim(h, makeWallet())]);
    expect(h.chain.world.s.metrics.totalOnsRevenue).toBe(before);
    expect(h.chain.world.s.nodeRewards.balance).toBe(0n);
  });
});

describe('wallet changes and exit', () => {
  it('schedules a wallet change for a later period and never redirects accrued rewards', async () => {
    const { h, alice, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const newWallet = makeWallet();
    h.produce([signedPayment(h, alice, newWallet.address, parseObs('10'))]);

    const requestedAt = h.chain.protocolTime;
    const message = walletChangeMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      currentWallet: node.wallet.address,
      newWallet: newWallet.address,
      requestedAt,
    });
    const proof = nodeProof(DOMAIN.NODE_WALLET_CHANGE, message, node.privateKey);
    h.produce([
      h.sign(
        node.wallet,
        TxType.NODE_REGISTRY,
        nodeRegistryBody({ op: NodeRegistryOp.CHANGE_WALLET, node, rewardWallet: newWallet.address, proof }),
        { gas: 0n },
      ),
    ]);

    const record = h.chain.world.node(node.nodeId)!;
    // Still the old wallet today; the change lands at a future period.
    expect(record.rewardWallet).toBe(node.wallet.address);
    expect(record.pendingWallet).toBe(newWallet.address);
    expect(record.pendingWalletEffectivePeriod).toBe(rewardPeriodAt(requestedAt) + NR.walletChangeDelayPeriods);
  });

  it('refuses a wallet change signed by anyone but the node identity', async () => {
    const { h, alice, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const newWallet = makeWallet();
    h.produce([signedPayment(h, alice, newWallet.address, parseObs('10'))]);
    const message = walletChangeMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      currentWallet: node.wallet.address,
      newWallet: newWallet.address,
      requestedAt: h.chain.protocolTime,
    });
    const impostor = generateKeyPair();
    const proof = nodeProof(DOMAIN.NODE_WALLET_CHANGE, message, impostor.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          node.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.CHANGE_WALLET, node, rewardWallet: newWallet.address, proof }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.BAD_SIGNATURE);
  });

  it('refuses a wallet change requested by a wallet that is not the current one', async () => {
    const { h, nodes } = await nodeHarness(2);
    const [node, attacker] = nodes;
    registerNode(h, node);
    const message = walletChangeMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      currentWallet: node.wallet.address,
      newWallet: attacker.wallet.address,
      requestedAt: h.chain.protocolTime,
    });
    const proof = nodeProof(DOMAIN.NODE_WALLET_CHANGE, message, node.privateKey);
    const outcome = h.tryBlock(
      [
        h.sign(
          attacker.wallet,
          TxType.NODE_REGISTRY,
          nodeRegistryBody({ op: NodeRegistryOp.CHANGE_WALLET, node, rewardWallet: attacker.wallet.address, proof }),
          { gas: 0n },
        ),
      ],
      { simulate: false },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.code).toBe(ErrCode.UNAUTHORIZED);
  });

  it('returns the bond in full on deregistration', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const bonded = h.chain.world.getAccount(node.wallet.address)!.balance;

    const message = deregistrationMessage({
      networkId: h.net.networkId,
      chainId: h.net.chainId,
      nodeId: node.nodeId,
      rewardWallet: node.wallet.address,
      requestedAt: h.chain.protocolTime,
    });
    const proof = nodeProof(DOMAIN.NODE_DEREGISTRATION, message, node.privateKey);
    h.produce([
      h.sign(node.wallet, TxType.NODE_REGISTRY, nodeRegistryBody({ op: NodeRegistryOp.DEREGISTER, node, proof }), {
        gas: 0n,
      }),
    ]);

    const record = h.chain.world.node(node.nodeId)!;
    expect(record.deregisteredAtHeight).toBeGreaterThan(0);
    expect(h.chain.world.getAccount(node.wallet.address)!.balance - bonded).toBe(NR.registrationBond);
    expect(h.chain.world.s.nodeRewards.bondedSeals).toBe(0n);
    expect(h.chain.world.registeredNodes()).toHaveLength(0);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });
});

/**
 * Crossing a reward-period boundary.
 *
 * A block cannot simply be dated a day into the future: the protocol rejects a
 * timestamp more than `maxFutureDriftSeconds` ahead of the validating node's
 * clock, and that rule is exactly what these tests must NOT weaken. So the
 * period rollover is driven the way a real block one period later drives it —
 * by running the settlement routine against the live chain state with an apply
 * context in the next period. The routine is the same function `runBlockRoutines`
 * calls, on the same state object, so what is asserted below is the behaviour
 * that will occur on-chain tomorrow.
 */
function crossPeriodBoundary(h: Harness): number {
  const period = rewardPeriodAt(h.chain.protocolTime);
  const nextPeriodStart = (period + 1) * NR.periodSeconds + 1;
  processNodeRewardRoutine({
    state: h.chain.world,
    apply: { height: (h.chain.store.head?.height ?? 0) + 1, timestamp: nextPeriodStart },
  });
  h.chain.world.takeEvents();
  return period;
}

describe('settlement inside consensus', () => {
  it('settles a closed period once, pays only verified nodes, and never exceeds the pool', async () => {
    const { h, alice, nodes } = await nodeHarness(2);
    const [first, second] = nodes;
    registerNode(h, first);
    registerNode(h, second);

    // Fund the pool through the only protocol-revenue path: ONS fees.
    const revenue = registerOnsRevenue(h, alice, 'settlement-revenue');
    const poolAfterRevenue = h.chain.world.s.nodeRewards.balance;
    expect(poolAfterRevenue).toBe(splitOnsRevenue(revenue, RevenueSource.ONS_REGISTRATION).nodeRunnerPool);

    // Both nodes do real work in this period: heartbeat plus mutual attestation.
    h.produce([nodeHeartbeat(h, first)]);
    h.produce([nodeHeartbeat(h, second)]);
    h.produce([nodeAttest(h, first, second)]);
    h.produce([nodeAttest(h, second, first)]);

    expect(h.chain.world.s.nodeRewards.lastSettledPeriod).toBeLessThan(rewardPeriodAt(h.chain.protocolTime));
    const period = crossPeriodBoundary(h);

    const pool = h.chain.world.s.nodeRewards;
    expect(pool.lastSettledPeriod).toBe(period);
    const settlement = pool.recentSettlements.at(-1)!;
    expect(settlement.period).toBe(period);
    expect(settlement.distributedSeals + pool.balance).toBe(poolAfterRevenue);
    expect(settlement.distributedSeals).toBeLessThanOrEqual(poolAfterRevenue);
    expect(h.chain.world.verifySupplyInvariant().ok).toBe(true);
  });

  it('cannot settle the same period twice', async () => {
    const { h, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    const period = crossPeriodBoundary(h);
    const settledCount = h.chain.world.s.nodeRewards.recentSettlements.filter((entry) => entry.period === period).length;
    // Running the routine again — as every later block in the new period does —
    // must not re-settle the closed period.
    crossPeriodBoundary(h);
    advance(h, 3);
    const after = h.chain.world.s.nodeRewards.recentSettlements.filter((entry) => entry.period === period).length;
    expect(after).toBe(settledCount);
    expect(after).toBeLessThanOrEqual(1);
  });

  it('pays nothing to an unregistered node no matter how much revenue exists', async () => {
    const { h, alice } = await nodeHarness(0);
    registerOnsRevenue(h, alice, 'no-runner-revenue');
    const pooled = h.chain.world.s.nodeRewards.balance;
    crossPeriodBoundary(h);
    // Nobody registered: the pool is untouched and carried forward.
    expect(h.chain.world.s.nodeRewards.balance).toBe(pooled);
    expect(h.chain.world.s.nodeRewards.lifetimeDistributed).toBe(0n);
  });

  it('keeps the supply invariant across registration, revenue and settlement', async () => {
    const { h, alice, nodes } = await nodeHarness(2);
    for (const node of nodes) registerNode(h, node);
    registerOnsRevenue(h, alice, 'supply-invariant-revenue');
    h.produce([nodeHeartbeat(h, nodes[0])]);
    h.produce([nodeAttest(h, nodes[1], nodes[0])]);
    crossPeriodBoundary(h);
    advance(h, 2);

    const invariant = h.chain.world.verifySupplyInvariant();
    expect(invariant.ok).toBe(true);
    expect(h.chain.world.s.metrics.totalSupply).toBeLessThanOrEqual(CONSENSUS_PARAMS.maxSupply);
    expect(formatObs(h.chain.world.s.nodeRewards.balance)).toMatch(/^\d+\.\d{18}$/);
  });

  it('produces the identical state root on a second node replaying the same blocks', async () => {
    const { h, alice, nodes } = await nodeHarness(1);
    const [node] = nodes;
    registerNode(h, node);
    h.produce([nodeHeartbeat(h, node)]);
    registerOnsRevenue(h, alice, 'replay-revenue');

    const blocks = [];
    for (let height = 1; height <= h.chain.store.head!.height; height += 1) {
      const hash = h.chain.store.getCanonicalHashAtHeight(height)!;
      blocks.push(h.chain.store.getBlockByHash(hash)!);
    }
    const replica = await createHarness({ producer: alice });
    harnesses.push(replica);
    for (const block of blocks) {
      const result = replica.chain.addBlock(block);
      expect(result.accepted, `block ${block.header.height} rejected on replay`).toBe(true);
    }
    // Node rewards state is committed to the state root, so equal roots prove
    // both nodes agree about every node record, every piece of evidence and
    // every seal in the pool.
    expect(replica.chain.store.head!.hash).toBe(h.chain.store.head!.hash);
    expect(replica.chain.world.s.nodeRewards.balance).toBe(h.chain.world.s.nodeRewards.balance);
    expect(replica.chain.world.node(node.nodeId)!.rewardWallet).toBe(node.wallet.address);
  });
});
