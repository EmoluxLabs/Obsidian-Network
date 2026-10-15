/**
 * NODE_REGISTRY — the on-chain registry of nodes: the producer set, the uptime evidence behind node rewards and
 * the binding between a node and the wallet that is paid for it (protocol 1.9.0).
 *
 * DESIGN RULES
 *
 *   1. THE NODE KEY IS THE ONLY SIGNER OF NODE STATEMENTS.
 *      Registration, heartbeat, attestation, fault report, wallet change and deregistration are transactions
 *      SENT BY THE NODE'S OWN IDENTITY KEY: `tx.sender` is the address of `nodePublicKey`, and the ordinary
 *      transaction signature check already proves the key signed it. There is no second signature to carry, no
 *      wallet signature and no gas (these transactions cost nothing). The same address is the node's block
 *      PRODUCER address, so the key that signs blocks is the key that is registered.
 *
 *   2. THE REWARD WALLET IS A PASTED ADDRESS. THE BINDING IS NOT PROOF OF OWNERSHIP.
 *      The operator pastes an OBS address; the node key binds it. Nothing proves the operator controls that
 *      address, because proving it would need a signature from the wallet — which the operator must not need.
 *      Consequences, stated plainly:
 *        - a bound address is PAID, never debited, so binding somebody else's address only gives them money;
 *        - but one address backs ONE node, so a stranger can SQUAT an address and keep its real owner from
 *          binding it to their own node;
 *        - the answer is RECLAIM_WALLET: the owner of a bound address sends one transaction FROM that address
 *          (which does prove control) and, after a delay, the binding is released. Squatting costs the squatter a
 *          registration and buys them nothing but delay; it is rate limited and documented in
 *          docs/node-binding-v1.9.0.md.
 *      A wallet CHANGE is also made by the node key alone, after a delay, and the current wallet owner can cancel
 *      it. Rewards already paid stay with the wallet that earned them.
 *
 *   3. NO BOND, NO DEPOSIT. Nothing is locked or confiscated. Equivocation is punished by a BAN (the identity is
 *      removed for good), not by seizing funds that were never locked.
 *
 *   4. ADMISSION IS RATE LIMITED, NOT PRICED. At most `maxRegistrationsPerBlock` registrations per block and
 *      `max(minNewNodesPerPeriod, ceil(n / divisor))` per reward period; a registered node is not schedulable
 *      until `maturityBlocks` have passed. These are Sybil SPEED limits. They do not make Sybils expensive, and
 *      the documentation says so.
 *
 *   5. NO OPERATOR-SUPPLIED TIME OR UPTIME. A heartbeat names the uptime window it belongs to and the protocol
 *      rejects any mismatch with the including block's own timestamp. There is no field in which a node can say
 *      "I was online 99%": uptime is counted from heartbeats and produced blocks the chain actually contains.
 */

import { Reader, Writer } from '../../protocol/encoding.js';
import { ErrCode, reject } from '../../protocol/errors.js';
import {
  NodeRegistryOp,
  type BlockHeader,
  type NodeRegistryBody,
  type NodeRecord,
  type TxEnvelope,
} from '../../protocol/types.js';
import { assertCanonicalAddress, assertGas } from '../helpers.js';
import { addressFromPublicKey, nodeIdFromPublicKey } from '../../crypto/keys.js';
import { fromHex, sha256Hex, utf8 } from '../../crypto/hash.js';
import { CONSENSUS_PARAMS } from '../../protocol/params.js';
import { PROTOCOL_VERSION } from '../../version.js';
import { PARAMS_HASH } from '../../blockchain/state-root.js';
import { blockHash, decodeSignedHeader, verifyBlockSignature } from '../../blockchain/block.js';
import { rewardPeriodAt, uptimeWindowInPeriod, uptimeWindowIndex } from '../../economy/node-rewards.js';
import type { ExecutorContext } from '../types.js';

const NR = CONSENSUS_PARAMS.nodeRewards;
const P = CONSENSUS_PARAMS.consensus.producers;

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
  const firstHeader = r.string();
  const secondHeader = r.string();
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
    firstHeader: firstHeader || undefined,
    secondHeader: secondHeader || undefined,
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
  w.string(body.firstHeader ?? '');
  w.string(body.secondHeader ?? '');
  return w.finish();
}

/** How many registrations the registry accepts in one reward period. */
export function registrationsAllowedPerPeriod(registeredNodes: number): number {
  return Math.max(P.minNewNodesPerPeriod, Math.ceil(registeredNodes / P.newNodesPerPeriodDivisor));
}

export function executeNodeRegistry(
  ctx: ExecutorContext,
  tx: TxEnvelope,
): { gasBase: bigint; detail: Record<string, unknown> } {
  const { state, apply, net } = ctx;
  const body = decodeNodeRegistryBody(tx.body);
  // Gas is zero for every node statement: a node must not need funds to exist.
  assertGas(tx.gas, 0n);
  if (body.proof !== '') {
    reject(ErrCode.MALFORMED, 'node statements carry no separate proof: the transaction signature of the node key is the proof');
  }
  const period = rewardPeriodAt(apply.timestamp);

  switch (body.op) {
    // ── REGISTER ─────────────────────────────────────────────────────────────
    case NodeRegistryOp.REGISTER: {
      assertNodeKey(body);
      const producerAddress = assertSignedByNodeKey(tx, body, net.addressHrp);
      const nodeId = nodeIdFromPublicKey(body.nodePublicKey);
      if (nodeId !== body.nodeId) {
        reject(ErrCode.BAD_SIGNATURE, 'nodeId is not the hash of the supplied node public key');
      }
      assertCanonicalAddress(body.rewardWallet, net, 'reward wallet');
      const existing = state.node(nodeId);
      if (existing && existing.bannedAtHeight !== undefined) {
        reject(ErrCode.NODE_BANNED, `node ${nodeId} was banned at height ${existing.bannedAtHeight} and cannot register again`);
      }
      if (existing && existing.deregisteredAtHeight === undefined) {
        reject(ErrCode.NODE_ALREADY_REGISTERED, `node ${nodeId} is already registered`);
      }
      const walletOwner = state.nodeByRewardWallet(body.rewardWallet);
      if (walletOwner && walletOwner !== nodeId) {
        reject(
          ErrCode.NODE_WALLET_IN_USE,
          `reward wallet ${body.rewardWallet} already backs node ${walletOwner}: one wallet backs one node`,
        );
      }
      const endpoint = validateEndpoint(body.endpoint);

      // Admission rate limits. Both are read from state, so every node counts the same.
      if (ctx.counters.registrations >= P.maxRegistrationsPerBlock) {
        reject(ErrCode.NODE_REGISTRATION_LIMIT, `a block accepts at most ${P.maxRegistrationsPerBlock} node registrations`);
      }
      const active = state.registeredNodes();
      const thisPeriod = [...state.s.nodes.values()].filter(
        (node) => rewardPeriodAt(node.registeredAt) === period && node.registeredAtHeight > 0,
      ).length;
      if (thisPeriod >= registrationsAllowedPerPeriod(active.length)) {
        reject(
          ErrCode.NODE_REGISTRATION_LIMIT,
          `this reward period already accepted ${thisPeriod} registrations (limit ${registrationsAllowedPerPeriod(active.length)})`,
        );
      }

      const record: NodeRecord = {
        nodeId,
        rewardWallet: body.rewardWallet,
        nodePublicKey: body.nodePublicKey,
        endpoint,
        registeredAtHeight: apply.height,
        registeredAt: apply.timestamp,
        producerAddress,
        lastActiveAt: apply.timestamp,
        missedSlots: 0,
        suspensions: 0,
        blocksProduced: existing?.blocksProduced ?? 0,
        lifetimeReward: existing?.lifetimeReward ?? 0n,
        settledPeriods: [],
      };
      ctx.counters.registrations += 1;
      state.putNode(record);
      state.emit('NODE_REGISTERED', {
        nodeId,
        producer: producerAddress,
        rewardWallet: body.rewardWallet,
        endpoint,
        period,
      }, apply);
      return { gasBase: 0n, detail: { op: 'REGISTER', nodeId, producer: producerAddress, rewardWallet: body.rewardWallet } };
    }

    // ── HEARTBEAT ────────────────────────────────────────────────────────────
    case NodeRegistryOp.HEARTBEAT: {
      const node = requireNodeFromSender(ctx, tx, body);
      const window = uptimeWindowIndex(apply.timestamp);
      if ((body.slot ?? 0) !== window) {
        reject(
          ErrCode.NODE_PROOF_EXPIRED,
          `a heartbeat must name the uptime window it belongs to (expected ${window}, received ${body.slot ?? 0})`,
        );
      }
      const reportedHeight = body.reportedHeight ?? 0;
      if (reportedHeight > apply.height) {
        reject(ErrCode.MALFORMED, 'a node cannot report a height the network has not reached');
      }
      const evidence = state.nodeEvidenceFor(period, node.nodeId);
      const bit = 1 << uptimeWindowInPeriod(apply.timestamp);
      if ((evidence.liveWindows & bit) !== 0) {
        reject(ErrCode.NODE_HEARTBEAT_TOO_SOON, `node ${node.nodeId} already counted uptime window ${window}`);
      }
      const inSync = apply.height - reportedHeight <= NR.responsiveHeightLag;
      if (inSync) {
        // Counted only when the node says it is in sync: an up-but-stale node earns no uptime.
        evidence.liveWindows |= bit;
        evidence.heartbeats += 1;
        node.lastActiveAt = apply.timestamp;
        state.putNode(node);
      } else {
        if (evidence.staleHeartbeats >= NR.uptimeWindowsPerPeriod) {
          reject(ErrCode.NODE_HEARTBEAT_TOO_SOON, 'too many stale heartbeats in this period');
        }
        evidence.staleHeartbeats += 1;
      }
      evidence.lastReportedHeight = reportedHeight;
      state.emit('NODE_HEARTBEAT', {
        nodeId: node.nodeId,
        window,
        reportedHeight,
        lag: apply.height - reportedHeight,
        counted: inSync,
      }, apply);
      return { gasBase: 0n, detail: { op: 'HEARTBEAT', nodeId: node.nodeId, window, counted: inSync } };
    }

    // ── ATTEST ───────────────────────────────────────────────────────────────
    case NodeRegistryOp.ATTEST: {
      const observer = requireNodeFromSender(ctx, tx, body);
      if (!body.subject) reject(ErrCode.MALFORMED, 'an attestation needs a subject node');
      const subject = state.node(body.subject);
      if (!subject || subject.deregisteredAtHeight !== undefined || subject.bannedAtHeight !== undefined) {
        reject(ErrCode.NODE_BAD_SUBJECT, `subject ${body.subject} is not a registered node`);
      }
      if (subject.nodeId === observer.nodeId) {
        reject(ErrCode.NODE_BAD_SUBJECT, 'a node cannot attest itself: liveness must be observed by an independent node');
      }
      if ((body.slot ?? 0) !== period) {
        reject(ErrCode.NODE_PROOF_EXPIRED, `an attestation must name the reward period it belongs to (expected ${period}, received ${body.slot ?? 0})`);
      }
      const subjectEvidence = state.nodeEvidenceFor(period, subject.nodeId);
      // An attestation is about something the chain can check: the subject must have shown life in this period.
      if (subjectEvidence.liveWindows === 0) {
        reject(ErrCode.NODE_BAD_SUBJECT, `node ${subject.nodeId} has no recorded uptime in period ${period}: there is nothing to attest`);
      }
      const observerEvidence = state.nodeEvidenceFor(period, observer.nodeId);
      if (observerEvidence.attested.length >= NR.maxAttestationsPerAttester && !observerEvidence.attested.includes(subject.nodeId)) {
        reject(
          ErrCode.NODE_ATTEST_LIMIT,
          `node ${observer.nodeId} reached the per-period limit of ${NR.maxAttestationsPerAttester} attestations`,
        );
      }
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
      const reporter = requireNodeFromSender(ctx, tx, body);
      if (!body.subject) reject(ErrCode.MALFORMED, 'a fault report needs a subject node');
      const subject = state.node(body.subject);
      if (!subject || subject.deregisteredAtHeight !== undefined) {
        reject(ErrCode.NODE_BAD_SUBJECT, `subject ${body.subject} is not a registered node`);
      }
      if (subject.nodeId === reporter.nodeId) reject(ErrCode.NODE_BAD_SUBJECT, 'a node cannot report itself');
      if (apply.height - reporter.registeredAtHeight < NR.minRegistrationBlocks) {
        reject(ErrCode.NODE_NOT_REGISTERED, 'a node must be registered for at least one block before it can report faults');
      }
      const reason = body.reason ?? '';
      if (reason.length < 3 || reason.length > 80) {
        reject(ErrCode.MALFORMED, 'a fault reason of 3-80 characters is required and is stored on-chain for audit');
      }
      if ((body.slot ?? 0) !== period) {
        reject(ErrCode.NODE_PROOF_EXPIRED, `a fault report must name the reward period it belongs to (expected ${period}, received ${body.slot ?? 0})`);
      }
      const subjectEvidence = state.nodeEvidenceFor(period, subject.nodeId);
      const alreadyReported = subjectEvidence.faultReporters.includes(reporter.nodeId);
      if (!alreadyReported && subjectEvidence.faultReporters.length >= NR.maxFaultReportsPerReporterPerPeriod) {
        reject(
          ErrCode.NODE_FAULT_LIMIT,
          `node ${subject.nodeId} reached the per-period limit of ${NR.maxFaultReportsPerReporterPerPeriod} fault reports`,
        );
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
        reporters: subjectEvidence.faultReporters.length,
        note: 'a fault changes a payout only when independent reporters corroborate it',
      }, apply);
      return { gasBase: 0n, detail: { op: 'REPORT_FAULT', reporter: reporter.nodeId, subject: subject.nodeId, period } };
    }

    // ── CHANGE_WALLET ────────────────────────────────────────────────────────
    case NodeRegistryOp.CHANGE_WALLET: {
      const node = requireNodeFromSender(ctx, tx, body);
      assertCanonicalAddress(body.rewardWallet, net, 'new reward wallet');
      if (node.pendingWallet) {
        reject(
          ErrCode.NODE_WALLET_CHANGE_PENDING,
          `a change to ${node.pendingWallet} is already pending for period ${node.pendingWalletEffectivePeriod}`,
        );
      }
      if (body.rewardWallet === node.rewardWallet) {
        reject(ErrCode.MALFORMED, 'the new reward wallet is the wallet already in use');
      }
      const owner = state.nodeByRewardWallet(body.rewardWallet);
      if (owner && owner !== node.nodeId) {
        reject(ErrCode.NODE_WALLET_IN_USE, `reward wallet ${body.rewardWallet} already backs node ${owner}`);
      }
      node.pendingWallet = body.rewardWallet;
      node.pendingWalletEffectivePeriod = period + NR.walletChangeDelayPeriods;
      node.pendingWalletRequestedAtHeight = apply.height;
      // putNode reserves the incoming wallet atomically with the record: nobody else can bind it meanwhile.
      state.putNode(node);
      state.emit('NODE_WALLET_CHANGE_SCHEDULED', {
        nodeId: node.nodeId,
        from: node.rewardWallet,
        to: body.rewardWallet,
        effectivePeriod: node.pendingWalletEffectivePeriod,
        note: 'rewards already accrued stay with the wallet that earned them; the current wallet may cancel before then',
      }, apply);
      return {
        gasBase: 0n,
        detail: { op: 'CHANGE_WALLET', nodeId: node.nodeId, effectivePeriod: node.pendingWalletEffectivePeriod },
      };
    }

    // ── CANCEL_WALLET_CHANGE ─────────────────────────────────────────────────
    case NodeRegistryOp.CANCEL_WALLET_CHANGE: {
      const node = state.node(body.nodeId);
      if (!node || node.deregisteredAtHeight !== undefined) {
        reject(ErrCode.NODE_NOT_REGISTERED, `node ${body.nodeId} is not registered`);
      }
      // The node key may take back its own request; so may the wallet that is being paid today.
      if (tx.sender !== node.producerAddress && !(node.rewardWallet && tx.sender === node.rewardWallet)) {
        reject(ErrCode.UNAUTHORIZED, 'only the node key or the current reward wallet may cancel a wallet change');
      }
      if (!node.pendingWallet) reject(ErrCode.NODE_WALLET_CHANGE_PENDING, 'no wallet change is pending for this node');
      const cancelled = node.pendingWallet;
      state.removeNodeWallet(cancelled, node.nodeId);
      node.pendingWallet = undefined;
      node.pendingWalletEffectivePeriod = undefined;
      node.pendingWalletRequestedAtHeight = undefined;
      state.putNode(node);
      state.emit('NODE_WALLET_CHANGE_CANCELLED', { nodeId: node.nodeId, cancelled, by: tx.sender }, apply);
      return { gasBase: 0n, detail: { op: 'CANCEL_WALLET_CHANGE', nodeId: node.nodeId } };
    }

    // ── RECLAIM_WALLET ───────────────────────────────────────────────────────
    case NodeRegistryOp.RECLAIM_WALLET: {
      const node = state.node(body.nodeId);
      if (!node || node.deregisteredAtHeight !== undefined) {
        reject(ErrCode.NODE_NOT_REGISTERED, `node ${body.nodeId} is not registered`);
      }
      // Sent FROM the bound address: the one signature in the whole flow that proves control of the wallet.
      if (tx.sender !== node.rewardWallet && tx.sender !== node.pendingWallet) {
        reject(ErrCode.UNAUTHORIZED, 'only the wallet bound to this node (or reserved for it) may reclaim itself');
      }
      if (node.reclaimEffectivePeriod !== undefined) {
        reject(ErrCode.NODE_WALLET_CHANGE_PENDING, 'a reclaim is already pending for this node');
      }
      node.reclaimEffectivePeriod = period + NR.reclaimDelayPeriods;
      node.reclaimWallet = tx.sender;
      state.putNode(node);
      state.emit('NODE_WALLET_RECLAIM_SCHEDULED', {
        nodeId: node.nodeId,
        wallet: tx.sender,
        effectivePeriod: node.reclaimEffectivePeriod,
        note: 'rewards keep flowing to this wallet until the reclaim takes effect, then the binding is released',
      }, apply);
      return { gasBase: 0n, detail: { op: 'RECLAIM_WALLET', nodeId: node.nodeId, effectivePeriod: node.reclaimEffectivePeriod } };
    }

    // ── DEREGISTER ───────────────────────────────────────────────────────────
    case NodeRegistryOp.DEREGISTER: {
      const node = requireNodeFromSender(ctx, tx, body);
      node.deregisteredAtHeight = apply.height;
      releaseWallets(ctx, node);
      state.putNode(node);
      state.emit('NODE_DEREGISTERED', {
        nodeId: node.nodeId,
        note: 'nothing is locked and nothing is confiscated: settled rewards are untouched, the period in progress is forfeited, and the wallet is free to back another node',
      }, apply);
      return { gasBase: 0n, detail: { op: 'DEREGISTER', nodeId: node.nodeId } };
    }

    // ── REPORT_EQUIVOCATION ──────────────────────────────────────────────────
    case NodeRegistryOp.REPORT_EQUIVOCATION: {
      // The reporter must itself be a registered node: reports are signature work, so they are not free for anybody.
      const reporter = state.nodeByProducer(tx.sender);
      if (!reporter || reporter.deregisteredAtHeight !== undefined || reporter.bannedAtHeight !== undefined) {
        reject(ErrCode.NODE_NOT_REGISTERED, 'equivocation reports are accepted from registered nodes only');
      }
      if (ctx.counters.equivocationReports >= P.maxEquivocationReportsPerBlock) {
        reject(ErrCode.EVIDENCE_LIMIT, `a block carries at most ${P.maxEquivocationReportsPerBlock} equivocation reports`);
      }
      ctx.counters.equivocationReports += 1;
      const subject = state.node(body.nodeId);
      if (!subject) reject(ErrCode.NODE_NOT_REGISTERED, `node ${body.nodeId} is unknown`);
      if (subject.bannedAtHeight !== undefined) {
        reject(ErrCode.NODE_BANNED, `node ${subject.nodeId} is already banned`);
      }
      const evidenceId = verifyEquivocation(ctx, subject, body);
      subject.bannedAtHeight = apply.height;
      subject.banEvidenceId = evidenceId;
      subject.suspendedUntil = undefined;
      releaseWallets(ctx, subject);
      state.putNode(subject);
      state.emit('NODE_BANNED', {
        nodeId: subject.nodeId,
        producer: subject.producerAddress,
        evidenceId,
        reporter: reporter.nodeId,
        note: 'two different blocks signed by this node on the same parent; no funds are involved, the identity is removed',
      }, apply);
      return { gasBase: 0n, detail: { op: 'REPORT_EQUIVOCATION', nodeId: subject.nodeId, evidenceId } };
    }

    default:
      reject(ErrCode.UNKNOWN_TX_TYPE, `unsupported node registry operation ${body.op}`);
  }
}

/** Release every wallet a node holds (current and reserved) so each is free to back another node. */
export function releaseWallets(ctx: ExecutorContext, node: NodeRecord): void {
  if (node.rewardWallet) ctx.state.removeNodeWallet(node.rewardWallet, node.nodeId);
  if (node.pendingWallet) ctx.state.removeNodeWallet(node.pendingWallet, node.nodeId);
  node.pendingWallet = undefined;
  node.pendingWalletEffectivePeriod = undefined;
  node.pendingWalletRequestedAtHeight = undefined;
  node.reclaimEffectivePeriod = undefined;
  node.reclaimWallet = undefined;
}

// ── equivocation evidence ────────────────────────────────────────────────────

function decodeHeaderHex(hex: string | undefined): BlockHeader {
  if (!hex || !/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0 || hex.length > 16 * 1024) {
    reject(ErrCode.EQUIVOCATION_INVALID, 'an evidence header is missing or is not lowercase hex within the size limit');
  }
  try {
    return decodeSignedHeader(fromHex(hex));
  } catch {
    reject(ErrCode.EQUIVOCATION_INVALID, 'an evidence header cannot be decoded');
  }
}

/**
 * The whole decision, from the two headers and the registry alone: two DIFFERENT blocks, the same parent, the same
 * height, both signed by the key this node registered. Honest software signs one block per parent; there is no
 * legitimate way to produce this. Returns the canonical evidence id.
 */
function verifyEquivocation(ctx: ExecutorContext, subject: NodeRecord, body: NodeRegistryBody): string {
  const first = decodeHeaderHex(body.firstHeader);
  const second = decodeHeaderHex(body.secondHeader);
  for (const header of [first, second]) {
    if (header.protocolVersion !== PROTOCOL_VERSION || header.chainId !== ctx.chainId || header.paramsHash !== PARAMS_HASH) {
      reject(ErrCode.EQUIVOCATION_INVALID, 'an evidence header belongs to another chain, protocol version or parameter set');
    }
    if (header.producer !== subject.producerAddress || header.producerSignature.publicKey !== subject.nodePublicKey) {
      reject(ErrCode.EQUIVOCATION_INVALID, 'an evidence header was not signed by this node');
    }
    if (header.height < 1 || header.height > ctx.apply.height) {
      reject(ErrCode.EQUIVOCATION_INVALID, 'an evidence header names a height this chain has not reached');
    }
    if (!verifyBlockSignature({ header, transactions: [] }, ctx.net.addressHrp)) {
      reject(ErrCode.BAD_SIGNATURE, 'an evidence header signature is invalid');
    }
  }
  if (first.height !== second.height || first.prevHash !== second.prevHash) {
    reject(ErrCode.EQUIVOCATION_INVALID, 'the two headers do not share a height and a parent, so they do not conflict');
  }
  const a = blockHash(first);
  const b = blockHash(second);
  if (a === b) reject(ErrCode.EQUIVOCATION_INVALID, 'the two headers are the same block');
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return sha256Hex(utf8(`OBSIDIAN:EQUIVOCATION:v1\n${subject.nodeId}\n${lo}\n${hi}`));
}

// ── shared validation helpers ────────────────────────────────────────────────

function assertNodeKey(body: NodeRegistryBody): void {
  if (!/^[0-9a-f]{66}$/.test(body.nodePublicKey)) {
    reject(ErrCode.MALFORMED, 'nodePublicKey must be a 33-byte compressed public key in lowercase hex');
  }
  if (!/^[0-9a-f]{40}$/.test(body.nodeId)) {
    reject(ErrCode.MALFORMED, 'nodeId must be 20 bytes of lowercase hex');
  }
}

/** The transaction must be signed by the node key named in the body; returns the producer address it hashes to. */
function assertSignedByNodeKey(tx: TxEnvelope, body: NodeRegistryBody, hrp: string): string {
  if (tx.signature.publicKey !== body.nodePublicKey) {
    reject(ErrCode.UNAUTHORIZED, 'a node statement must be signed by the node identity key itself');
  }
  let producer: string;
  try {
    producer = addressFromPublicKey(body.nodePublicKey, hrp);
  } catch {
    reject(ErrCode.MALFORMED, 'nodePublicKey is not a valid public key');
  }
  if (tx.sender !== producer) {
    reject(ErrCode.UNAUTHORIZED, 'the sender of a node statement is the address of the node key');
  }
  return producer;
}

/** A registered, unbanned node whose key signed this transaction. */
function requireNodeFromSender(ctx: ExecutorContext, tx: TxEnvelope, body: NodeRegistryBody): NodeRecord {
  const node = ctx.state.nodeByProducer(tx.sender);
  if (!node || node.deregisteredAtHeight !== undefined) {
    reject(ErrCode.NODE_NOT_REGISTERED, `no registered node is signing as ${tx.sender}`);
  }
  if (node.bannedAtHeight !== undefined) {
    reject(ErrCode.NODE_BANNED, `node ${node.nodeId} was banned at height ${node.bannedAtHeight}`);
  }
  // The body may name the node (clients do); if it does, it must be this one.
  if (body.nodeId && body.nodeId !== node.nodeId) {
    reject(ErrCode.UNAUTHORIZED, 'the statement names a different node than the one that signed it');
  }
  if (body.nodePublicKey && body.nodePublicKey !== node.nodePublicKey) {
    reject(ErrCode.UNAUTHORIZED, 'the statement names a different node key than the one registered');
  }
  return node;
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

/** Registered node count, for the interface. */
export function registeredNodeCount(ctx: ExecutorContext): number {
  return ctx.state.registeredNodes().length;
}
