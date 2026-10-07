/**
 * NODE_REGISTRY — the on-chain registry of node runners and the evidence they
 * submit for their Proof of Time rewards (spec: node runner reward pool).
 *
 * DESIGN RULES
 *
 *   1. THE PROTOCOL PAYS FOR VERIFIED FACTS, NEVER FOR CLAIMS.
 *      Nothing in this executor accepts an amount, an uptime percentage, a
 *      hashrate, a CPU benchmark or "I was online". What is recorded is: this
 *      node identity exists, it sent its heartbeat for this period, this other
 *      registered node attested it, this node produced these blocks. Every one
 *      of those facts is a signed statement from a key that had to exist and pay
 *      gas to make it, and every payout is computed later from the recorded
 *      facts (src/economy/node-rewards.ts).
 *
 *   2. TWO KEYS, TWO JOBS.
 *      - The NODE IDENTITY key (nodePublicKey → nodeId) is generated on the node
 *        runner and never leaves it. It signs heartbeats, attestations and fault
 *        reports, plus the consent on registration, wallet change and exit.
 *      - The REWARD WALLET key signs the transaction itself (so the protocol's
 *        ordinary transaction-signature verification already proves the operator
 *        controls the payout address) and holds the bond.
 *      An attacker with one key cannot do anything alone: the wallet holder
 *      cannot move someone else's node identity to their address, and the node
 *      key holder cannot spend a bond or redirect accrued rewards without the
 *      wallet's own signature.
 *
 *   3. NO OPERATOR-SUPPLIED TIME.
 *      Every statement carries an issued-at/expires-at window that is checked
 *      against protocol time in the block that includes it, and heartbeats are
 *      keyed to the reward period derived from that same block. A node cannot
 *      send fourteen heartbeats "for last week" or backdate an attestation: the
 *      block decides when the statement happened.
 *
 *   4. NO REGISTRATION DEPOSIT.
 *      Registering a node runner moves no funds: there was once a 100 OBS
 *      registration bond, and it was removed as a mechanism rather than set to
 *      zero. The protocol has exactly one bond — the validator bond — because
 *      two bonds with one name is exactly how an economic rule ends up applied
 *      in one place and not the other. What keeps the registry honest is the
 *      things a node cannot fake: one reward wallet behind one node identity,
 *      attestations that come from other nodes, and payouts computed only from
 *      recorded, verified evidence.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import {
  NodeRegistryOp,
  type NodeRegistryBody,
  type NodeRecord,
  type TxEnvelope,
} from '../../protocol/types.js';
import { assertAddress, assertGas } from '../helpers.js';
import { nodeIdFromPublicKey, verifyDigest } from '../../crypto/keys.js';
import { fromHex, sha256, utf8 } from '../../crypto/hash.js';
import { DOMAIN } from '../../protocol/domains.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import {
  deregistrationMessage,
  nodeRegistrationMessage,
  rewardPeriodAt,
  walletChangeMessage,
} from '../../economy/node-rewards.js';
import type { ExecutorContext } from '../types.js';

const NR = CONSENSUS_PARAMS.nodeRewards;

export function decodeNodeRegistryBody(body: Uint8Array): NodeRegistryBody {
  const r = new Reader(body);
  const op = r.u8() as NodeRegistryOp;
  const nodeId = r.string();
  const rewardWallet = r.string();
  const nodePublicKey = r.string();
  const proof = r.string();
  const endpoint = r.string();
  const slot = r.u32();
  const subject = r.string();
  const reportedHeight = r.u32();
  const reason = r.string();
  const issuedAt = Number(r.u64());
  const expiresAt = Number(r.u64());
  r.ensureConsumed();
  return {
    op,
    nodeId,
    rewardWallet,
    nodePublicKey,
    proof,
    endpoint: endpoint || undefined,
    slot: slot || undefined,
    subject: subject || undefined,
    reportedHeight: reportedHeight || undefined,
    reason: reason || undefined,
    issuedAt: issuedAt || undefined,
    expiresAt: expiresAt || undefined,
  };
}

export function encodeNodeRegistryBody(body: NodeRegistryBody): Uint8Array {
  const w = new Writer();
  w.u8(body.op);
  w.string(body.nodeId);
  w.string(body.rewardWallet);
  w.string(body.nodePublicKey);
  w.string(body.proof);
  w.string(body.endpoint ?? '');
  w.u32(body.slot ?? 0);
  w.string(body.subject ?? '');
  w.u32(body.reportedHeight ?? 0);
  w.string(body.reason ?? '');
  w.u64(BigInt(Math.trunc(body.issuedAt ?? 0)));
  w.u64(BigInt(Math.trunc(body.expiresAt ?? 0)));
  return w.finish();
}

export function executeNodeRegistry(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeNodeRegistryBody(tx.body);
  const gas = assertGas(tx.gas, 0n);
  if (gas > 0n) {
    state.poolInflow(gas, 'node registry gas to mining pool');
    state.s.metrics.totalGasBurnedToPool += gas;
  }

  // A statement must belong to this chain and this network. The message the node
  // signs includes both, so a testnet proof can never be mined into mainnet.
  const networkId = net.networkId;
  const chainId = ctx.chainId;

  /** Verify a statement signature under its own domain tag, with the node's key. */
  const signedProof = (domain: string, message: string, publicKeyHex: string): boolean =>
    verifyDigest(domainMessage(domain, message), body.proof, publicKeyHex);

  switch (body.op) {
    // ── REGISTER ─────────────────────────────────────────────────────────────
    case NodeRegistryOp.REGISTER: {
      assertNodeKey(body);
      assertAddress(body.rewardWallet, net, 'reward wallet');
      if (tx.sender !== body.rewardWallet) {
        reject(ErrCode.UNAUTHORIZED, 'register a node from the reward wallet itself: the transaction signature is the wallet\'s proof of control');
      }
      const nodeId = nodeIdFromPublicKey(body.nodePublicKey);
      if (nodeId !== body.nodeId) {
        reject(ErrCode.BAD_SIGNATURE, 'nodeId is not the hash of the supplied node public key');
      }
      const existing = state.node(nodeId);
      if (existing && existing.deregisteredAtHeight === undefined) {
        reject(ErrCode.NODE_ALREADY_REGISTERED, `node ${nodeId} is already registered`);
      }
      const walletOwner = state.nodeByRewardWallet(body.rewardWallet);
      if (walletOwner && walletOwner !== nodeId) {
        reject(
          ErrCode.NODE_WALLET_IN_USE,
          `reward wallet ${body.rewardWallet} already backs node ${walletOwner}: one wallet may fund one node, which is what makes Sybil farming cost capital`,
        );
      }
      const endpoint = validateEndpoint(body.endpoint);
      assertProofWindow(body, ctx, 'registration');
      const message = nodeRegistrationMessage({
        networkId,
        chainId,
        nodeId,
        rewardWallet: body.rewardWallet,
        endpoint,
        issuedAt: body.issuedAt ?? 0,
        expiresAt: body.expiresAt ?? 0,
      });
      if (!signedProof(DOMAIN.NODE_REGISTRATION, message, body.nodePublicKey)) {
        reject(ErrCode.BAD_SIGNATURE, 'the node identity did not consent to this registration (proof invalid)');
      }

      const record: NodeRecord = {
        nodeId,
        rewardWallet: body.rewardWallet,
        nodePublicKey: body.nodePublicKey,
        endpoint,
        registeredAtHeight: apply.height,
        registeredAt: apply.timestamp,
        lifetimeReward: existing?.lifetimeReward ?? 0n,
        settledPeriods: [],
      };
      state.putNode(record);
      state.emit('NODE_REGISTERED', {
        nodeId,
        rewardWallet: body.rewardWallet,
        endpoint,
        period: rewardPeriodAt(apply.timestamp),
      }, apply);
      return { gasBase: 0n, detail: { op: 'REGISTER', nodeId, rewardWallet: body.rewardWallet } };
    }

    // ── HEARTBEAT ────────────────────────────────────────────────────────────
    case NodeRegistryOp.HEARTBEAT: {
      assertNodeKey(body);
      const node = requireRegisteredNode(ctx, body);
      assertNodeStatementSender(ctx, node, tx.sender);
      const period = rewardPeriodAt(apply.timestamp);
      const evidence = state.nodeEvidenceFor(period, node.nodeId);
      assertPeriodProof(body, ctx, period, 'heartbeat');
      if (evidence.heartbeats >= NR.heartbeatsPerPeriod) {
        reject(ErrCode.NODE_HEARTBEAT_TOO_SOON, `node ${node.nodeId} already sent its heartbeat for period ${period}`);
      }
      const reportedHeight = body.reportedHeight ?? 0;
      if (reportedHeight > apply.height) {
        reject(ErrCode.MALFORMED, 'a node cannot report a height the network has not reached');
      }
      const message = heartbeatMessage({
        networkId,
        chainId,
        nodeId: node.nodeId,
        period,
        reportedHeight,
        endpoint: node.endpoint,
      });
      if (!signedProof(DOMAIN.NODE_HEARTBEAT, message, node.nodePublicKey)) {
        reject(ErrCode.BAD_SIGNATURE, 'heartbeat proof does not match the registered node identity');
      }
      evidence.heartbeats += 1;
      evidence.lastReportedHeight = reportedHeight;
      if (apply.height - reportedHeight <= NR.responsiveHeightLag) {
        // In sync: the node's verification is current with the network's.
      } else {
        evidence.staleHeartbeats += 1;
      }
      state.emit('NODE_HEARTBEAT', {
        nodeId: node.nodeId,
        period,
        reportedHeight,
        lag: apply.height - reportedHeight,
      }, apply);
      return { gasBase: 0n, detail: { op: 'HEARTBEAT', nodeId: node.nodeId, period } };
    }

    // ── ATTEST ───────────────────────────────────────────────────────────────
    case NodeRegistryOp.ATTEST: {
      assertNodeKey(body);
      const observer = requireRegisteredNode(ctx, body);
      assertNodeStatementSender(ctx, observer, tx.sender);
      if (!body.subject) reject(ErrCode.MALFORMED, 'an attestation needs a subject node');
      const subject = state.node(body.subject);
      if (!subject || subject.deregisteredAtHeight !== undefined) {
        reject(ErrCode.NODE_BAD_SUBJECT, `subject ${body.subject} is not a registered node`);
      }
      if (subject.nodeId === observer.nodeId) {
        reject(ErrCode.NODE_BAD_SUBJECT, 'a node cannot attest itself: liveness must be observed by an independent node');
      }
      const period = rewardPeriodAt(apply.timestamp);
      assertPeriodProof(body, ctx, period, 'attestation');
      const observerEvidence = state.nodeEvidenceFor(period, observer.nodeId);
      if (observerEvidence.attested.length >= NR.maxAttestationsPerAttester && !observerEvidence.attested.includes(subject.nodeId)) {
        reject(
          ErrCode.NODE_ATTEST_LIMIT,
          `node ${observer.nodeId} reached the per-period limit of ${NR.maxAttestationsPerAttester} attestations`,
        );
      }
      const message = attestationMessage({
        networkId,
        chainId,
        observer: observer.nodeId,
        subject: subject.nodeId,
        period,
        reportedHeight: body.reportedHeight ?? 0,
      });
      if (!signedProof(DOMAIN.NODE_ATTESTATION, message, observer.nodePublicKey)) {
        reject(ErrCode.BAD_SIGNATURE, 'attestation proof does not match the observer node identity');
      }
      const subjectEvidence = state.nodeEvidenceFor(period, subject.nodeId);
      if (!subjectEvidence.attesters.includes(observer.nodeId)) subjectEvidence.attesters.push(observer.nodeId);
      if (!observerEvidence.attested.includes(subject.nodeId)) observerEvidence.attested.push(subject.nodeId);
      state.emit('NODE_ATTESTATION', {
        observer: observer.nodeId,
        subject: subject.nodeId,
        period,
        observersOfSubject: subjectEvidence.attesters.length,
      }, apply);
      return { gasBase: 0n, detail: { op: 'ATTEST', observer: observer.nodeId, subject: subject.nodeId, period } };
    }

    // ── REPORT_FAULT ─────────────────────────────────────────────────────────
    case NodeRegistryOp.REPORT_FAULT: {
      assertNodeKey(body);
      const reporter = requireRegisteredNode(ctx, body);
      assertNodeStatementSender(ctx, reporter, tx.sender);
      if (!body.subject) reject(ErrCode.MALFORMED, 'a fault report needs a subject node');
      const subject = state.node(body.subject);
      if (!subject || subject.deregisteredAtHeight !== undefined) {
        reject(ErrCode.NODE_BAD_SUBJECT, `subject ${body.subject} is not a registered node`);
      }
      if (subject.nodeId === reporter.nodeId) {
        reject(ErrCode.NODE_BAD_SUBJECT, 'a node cannot report itself');
      }
      if (apply.height - reporter.registeredAtHeight < NR.minRegistrationBlocks) {
        reject(ErrCode.NODE_NOT_REGISTERED, 'a node must be registered for at least one block before it can report faults');
      }
      const reason = body.reason ?? '';
      if (reason.length < 3 || reason.length > 80) {
        reject(ErrCode.MALFORMED, 'a fault reason of 3-80 characters is required and is stored on-chain for audit');
      }
      const period = rewardPeriodAt(apply.timestamp);
      assertPeriodProof(body, ctx, period, 'fault report');
      const subjectEvidence = state.nodeEvidenceFor(period, subject.nodeId);
      const alreadyReported = subjectEvidence.faultReporters.includes(reporter.nodeId);
      if (!alreadyReported && subjectEvidence.faultReporters.length >= NR.maxFaultReportsPerReporterPerPeriod) {
        reject(
          ErrCode.NODE_FAULT_LIMIT,
          `node ${reporter.nodeId} reached the per-period limit of ${NR.maxFaultReportsPerReporterPerPeriod} fault reports`,
        );
      }
      const message = faultReportMessage({
        networkId,
        chainId,
        reporter: reporter.nodeId,
        subject: subject.nodeId,
        period,
        reason,
      });
      if (!signedProof(DOMAIN.NODE_FAULT_REPORT, message, reporter.nodePublicKey)) {
        reject(ErrCode.BAD_SIGNATURE, 'fault report proof does not match the reporter node identity');
      }
      if (!alreadyReported) {
        subjectEvidence.faultReporters.push(reporter.nodeId);
        subjectEvidence.faults += 1;
      }
      state.emit('NODE_FAULT_REPORTED', {
        reporter: reporter.nodeId,
        subject: subject.nodeId,
        period,
        reason,
        // A single node's accusation is recorded but never penalised on its own:
        // settlement only counts faults corroborated by independent reporters.
        independentReporters: subjectEvidence.faultReporters.length,
      }, apply);
      return { gasBase: 0n, detail: { op: 'REPORT_FAULT', reporter: reporter.nodeId, subject: subject.nodeId } };
    }

    // ── CHANGE_WALLET ────────────────────────────────────────────────────────
    case NodeRegistryOp.CHANGE_WALLET: {
      assertNodeKey(body);
      assertAddress(body.rewardWallet, net, 'new reward wallet');
      const node = requireRegisteredNode(ctx, body);
      // The incoming wallet signs the change: it is the only key that can prove
      // it is willing to receive, and it cannot be an address the operator does
      // not control. The outgoing wallet pays for and signs the transaction.
      if (tx.sender !== node.rewardWallet) {
        reject(ErrCode.UNAUTHORIZED, 'only the current reward wallet may authorise a reward wallet change');
      }
      if (node.pendingWallet) {
        reject(
          ErrCode.NODE_WALLET_CHANGE_PENDING,
          `a change to ${node.pendingWallet} is already pending for period ${node.pendingWalletEffectivePeriod}`,
        );
      }
      const newOwner = state.nodeByRewardWallet(body.rewardWallet);
      if (newOwner && newOwner !== node.nodeId) {
        reject(ErrCode.NODE_WALLET_IN_USE, `reward wallet ${body.rewardWallet} already backs node ${newOwner}`);
      }
      if (body.rewardWallet === node.rewardWallet) {
        reject(ErrCode.MALFORMED, 'the new reward wallet is the wallet already in use');
      }
      const requestedAt = apply.timestamp;
      const message = walletChangeMessage({
        networkId,
        chainId,
        nodeId: node.nodeId,
        currentWallet: node.rewardWallet,
        newWallet: body.rewardWallet,
        requestedAt,
      });
      if (!verifyDigest(domainMessage(DOMAIN.NODE_WALLET_CHANGE, message), body.proof, body.nodePublicKey)) {
        reject(ErrCode.BAD_SIGNATURE, 'the node identity did not authorise this wallet change');
      }
      const period = rewardPeriodAt(requestedAt);
      node.pendingWallet = body.rewardWallet;
      node.pendingWalletEffectivePeriod = period + NR.walletChangeDelayPeriods;
      node.pendingWalletRequestedAtHeight = apply.height;
      state.putNode(node);
      state.emit('NODE_WALLET_CHANGE_SCHEDULED', {
        nodeId: node.nodeId,
        from: tx.sender,
        to: body.rewardWallet,
        effectivePeriod: node.pendingWalletEffectivePeriod,
        note: 'rewards already accrued stay with the wallet that earned them',
      }, apply);
      return {
        gasBase: 0n,
        detail: { op: 'CHANGE_WALLET', nodeId: node.nodeId, effectivePeriod: node.pendingWalletEffectivePeriod },
      };
    }

    // ── DEREGISTER ───────────────────────────────────────────────────────────
    case NodeRegistryOp.DEREGISTER: {
      assertNodeKey(body);
      const node = requireRegisteredNode(ctx, body);
      if (tx.sender !== node.rewardWallet) {
        reject(ErrCode.UNAUTHORIZED, 'only the current reward wallet may deregister this node');
      }
      const message = deregistrationMessage({
        networkId,
        chainId,
        nodeId: node.nodeId,
        rewardWallet: node.rewardWallet,
        requestedAt: apply.timestamp,
      });
      if (!verifyDigest(domainMessage(DOMAIN.NODE_DEREGISTRATION, message), body.proof, node.nodePublicKey)) {
        reject(ErrCode.BAD_SIGNATURE, 'the node identity did not authorise this deregistration');
      }
      node.deregisteredAtHeight = apply.height;
      node.pendingWallet = undefined;
      node.pendingWalletEffectivePeriod = undefined;
      state.putNode(node);
      state.emit('NODE_DEREGISTERED', {
        nodeId: node.nodeId,
        rewardWallet: node.rewardWallet,
        note: 'nothing is locked and nothing is confiscated: already settled rewards are untouched, and the period in progress is forfeited because a node that leaves cannot be attested for it',
      }, apply);
      return { gasBase: 0n, detail: { op: 'DEREGISTER', nodeId: node.nodeId } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported node registry operation ${body.op}`);
  }
}

// ── shared validation helpers ────────────────────────────────────────────────

/**
 * Digest a statement under its own domain tag so it can never be replayed as a
 * different statement, a transaction or a block. verifyDigest expects the
 * 32-byte digest, so the hash happens here and nowhere else.
 */
function domainMessage(domain: string, message: string): Uint8Array {
  return sha256(utf8(`${domain}\n${message}`));
}

/**
 * A heartbeat/attestation/fault report is about the period the block belongs to.
 * The statement carries the period it claims, and the protocol rejects any
 * mismatch: a node cannot file evidence "for" a period it did not observe, which
 * is what stops reward farming by replaying a week of statements at once.
 */
function assertPeriodProof(body: NodeRegistryBody, ctx: ExecutorContext, period: number, label: string): void {
  if (body.issuedAt !== undefined && body.expiresAt !== undefined) {
    assertProofWindow(body, ctx, label);
    return;
  }
  const slot = body.slot ?? 0;
  if (slot !== period) {
    reject(
      ErrCode.NODE_PROOF_EXPIRED,
      `a ${label} must name the reward period it belongs to (expected ${period}, received ${slot})`,
    );
  }
}

function assertNodeKey(body: NodeRegistryBody): void {
  if (!/^[0-9a-f]{66}$/.test(body.nodePublicKey)) {
    reject(ErrCode.MALFORMED, 'nodePublicKey must be a 33-byte compressed public key in lowercase hex');
  }
  if (!/^[0-9a-f]{128}$/.test(body.proof)) {
    reject(ErrCode.MALFORMED, 'proof must be a 64-byte compact ECDSA signature in lowercase hex');
  }
  if (!/^[0-9a-f]{40}$/.test(body.nodeId)) {
    reject(ErrCode.MALFORMED, 'nodeId must be 20 bytes of lowercase hex');
  }
  // The public key must be a point on the curve; verification would fail anyway,
  // but failing here gives the operator an unambiguous error.
  try {
    fromHex(body.nodePublicKey);
  } catch {
    reject(ErrCode.MALFORMED, 'nodePublicKey is not valid hex');
  }
}

function requireRegisteredNode(ctx: ExecutorContext, body: NodeRegistryBody): NodeRecord {
  const node = ctx.state.node(body.nodeId);
  if (!node) reject(ErrCode.NODE_NOT_REGISTERED, `node ${body.nodeId} is not registered`);
  if (node.deregisteredAtHeight !== undefined) {
    reject(ErrCode.NODE_NOT_REGISTERED, `node ${body.nodeId} deregistered at height ${node.deregisteredAtHeight}`);
  }
  return node;
}

/**
 * Statements are paid for by the reward wallet. This makes spam cost gas,
 * gives every statement a nonce (so two identical heartbeats cannot both land)
 * and keeps the node's identity key from needing any funds to exist.
 */
function assertNodeStatementSender(_ctx: ExecutorContext, node: NodeRecord, sender: string): void {
  if (sender !== node.rewardWallet) {
    reject(
      ErrCode.UNAUTHORIZED,
      `node statements must be paid for by the node's reward wallet ${node.rewardWallet}; received ${sender}`,
    );
  }
}

function validateEndpoint(endpoint: string | undefined): string {
  if (!endpoint) return '';
  if (endpoint.length > NR.maxEndpointLength) {
    reject(ErrCode.NODE_BAD_ENDPOINT, `endpoint hints are limited to ${NR.maxEndpointLength} characters`);
  }
  const match = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):([0-9]{2,5})$/.exec(endpoint);
  if (!match) {
    reject(ErrCode.NODE_BAD_ENDPOINT, 'endpoint must look like host:port (an IPv4 address, a hostname, or [ipv6]:port)');
  }
  const port = Number(match[1]);
  if (!(port >= 1 && port <= 65535)) reject(ErrCode.NODE_BAD_ENDPOINT, `port ${port} is out of range`);
  return endpoint;
}

/**
 * Proof validity window, checked against protocol time — not against the clock
 * of whichever machine happens to be submitting.
 */
function assertProofWindow(body: NodeRegistryBody, ctx: ExecutorContext, label: string): void {
  const issuedAt = body.issuedAt ?? 0;
  const expiresAt = body.expiresAt ?? 0;
  if (!issuedAt || !expiresAt) {
    reject(ErrCode.NODE_PROOF_EXPIRED, `a ${label} proof must carry issuedAt and expiresAt`);
  }
  if (expiresAt <= issuedAt) {
    reject(ErrCode.NODE_PROOF_EXPIRED, `a ${label} proof must expire after it was issued`);
  }
  const windowSeconds = expiresAt - issuedAt;
  const maxWindow = NR.proofMaxValiditySeconds;
  if (windowSeconds > maxWindow) {
    reject(ErrCode.NODE_PROOF_EXPIRED, `${label} proofs are valid for at most ${maxWindow}s of protocol time`);
  }
  if (ctx.apply.timestamp < issuedAt) {
    reject(
      ErrCode.NOT_YET_VALID,
      `${label} proof is not valid until protocol timestamp ${issuedAt}; the chain is at ${ctx.apply.timestamp}`,
    );
  }
  if (ctx.apply.timestamp > expiresAt) {
    reject(
      ErrCode.NODE_PROOF_EXPIRED,
      `${label} proof expired at protocol timestamp ${expiresAt}; it cannot be replayed later`,
    );
  }
}

export function heartbeatMessage(input: {
  networkId: string;
  chainId: number;
  nodeId: string;
  period: number;
  reportedHeight: number;
  endpoint: string;
}): string {
  return [
    'OBSIDIAN:NODE_HEARTBEAT:v1',
    `networkId:${input.networkId}`,
    `chainId:${input.chainId}`,
    `nodeId:${input.nodeId}`,
    `period:${input.period}`,
    `reportedHeight:${input.reportedHeight}`,
    `endpoint:${input.endpoint}`,
  ].join('\n');
}

export function attestationMessage(input: {
  networkId: string;
  chainId: number;
  observer: string;
  subject: string;
  period: number;
  reportedHeight: number;
}): string {
  return [
    'OBSIDIAN:NODE_ATTESTATION:v1',
    `networkId:${input.networkId}`,
    `chainId:${input.chainId}`,
    `observer:${input.observer}`,
    `subject:${input.subject}`,
    `period:${input.period}`,
    `observedHeight:${input.reportedHeight}`,
  ].join('\n');
}

export function faultReportMessage(input: {
  networkId: string;
  chainId: number;
  reporter: string;
  subject: string;
  period: number;
  reason: string;
}): string {
  return [
    'OBSIDIAN:NODE_FAULT_REPORT:v1',
    `networkId:${input.networkId}`,
    `chainId:${input.chainId}`,
    `reporter:${input.reporter}`,
    `subject:${input.subject}`,
    `period:${input.period}`,
    `reason:${input.reason}`,
  ].join('\n');
}

/** Registered node runner count, for the interface. */
export function registeredNodeCount(ctx: ExecutorContext): number {
  return ctx.state.registeredNodes().length;
}
