/**
 * Test harness.
 *
 * Builds a real ChainManager on a throwaway data directory and drives it with
 * real signed transactions. Nothing is mocked: every test exercises the same
 * code path a production node runs, which is the only way these tests can prove
 * anything about consensus behaviour.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import type { WorldState } from '../../src/blockchain/state.js';
import { buildBlock, blockHash, encodeBlock, decodeBlock } from '../../src/blockchain/block.js';
import { signTransaction, encodeSignedTx } from '../../src/transactions/encode.js';
import { generateRecoveryPhrase, deriveWallet } from '../../src/crypto/mnemonic.js';
import { addressFromPublicKey, generateKeyPair, nodeIdFromPublicKey, signDigest } from '../../src/crypto/keys.js';
import { sha256, toHex, utf8 } from '../../src/crypto/hash.js';
import { DOMAIN } from '../../src/protocol/domains.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import {
  attestationMessage,
  encodeNodeRegistryBody,
  heartbeatMessage,
} from '../../src/transactions/executors/node-registry.js';
import { nodeRegistrationMessage, rewardPeriodAt } from '../../src/economy/node-rewards.js';
import { TxType, type TxEnvelope, type Block } from '../../src/protocol/types.js';
import { ProtocolError } from '../../src/protocol/errors.js';
import { getNetwork, type NetworkDefinition } from '../../src/protocol/networks.js';
import { applyBlock } from '../../src/blockchain/state-machine.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { encodePaymentBody } from '../../src/transactions/executors/payment.js';
import { encodeMiningBody, computeClaimId } from '../../src/transactions/executors/mining.js';
import { encodeOracleBody } from '../../src/transactions/executors/oracle.js';
import { encodeOnsBody } from '../../src/transactions/executors/ons.js';
import { encodeCapsuleBody, computeCapsuleId } from '../../src/transactions/executors/capsule.js';
import { encodeLandBody, computeParcelId } from '../../src/transactions/executors/land.js';
import { encodeSocialBody } from '../../src/transactions/executors/social.js';
import { encodeValidatorBody } from '../../src/transactions/executors/validator.js';
import { encodeTreasuryBody } from '../../src/transactions/executors/treasury.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { alignedCycleStart, evaluateMining } from '../../src/mining/rules.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';

export const DEVNET = getNetwork('devnet');

export interface TestWallet {
  address: string;
  privateKey: string;
  publicKey: string;
  phrase: string;
}

export function makeWallet(net: NetworkDefinition = DEVNET): TestWallet {
  const phrase = generateRecoveryPhrase();
  const derived = deriveWallet(phrase, 0, 0);
  return {
    address: addressFromPublicKey(derived.publicKey, net.addressHrp),
    privateKey: derived.privateKey,
    publicKey: derived.publicKey,
    phrase,
  };
}

/** Per-block overrides used by rejection tests. */
export interface BlockOptions {
  timestamp?: number;
  producer?: TestWallet;
  /**
   * Simulate the block before signing it so the header commits to the real
   * post-state roots (default true). Tests that deliberately include a
   * transaction the protocol must reject set this to false: validation fails on
   * the transaction before the roots are ever compared.
   */
  simulate?: boolean;
}

/** A branch point: any block plus the state produced by applying it. */
export interface ForkParent {
  hash: string;
  height: number;
  cumulativePotWeight: bigint;
  state: WorldState;
}

export interface Harness {
  chain: ChainManager;
  net: NetworkDefinition;
  producer: TestWallet;
  dir: string;
  /**
   * Build and sign a block WITHOUT adding it (used to assert rejections).
   * Roots are computed by simulating, so the block is valid except for whatever
   * the test deliberately breaks.
   */
  makeBlock(txs?: TxEnvelope[], options?: BlockOptions): Block;
  /**
   * Build and sign a block on an arbitrary parent (used to mine competing
   * branches), returning the block and the state it produces.
   */
  makeBlockOn(
    parent: ForkParent,
    txs?: TxEnvelope[],
    options?: BlockOptions,
  ): { block: Block; state: WorldState };
  /** Build, sign and add a block, returning the verdict instead of throwing. */
  tryBlock(
    txs?: TxEnvelope[],
    options?: BlockOptions,
  ): { block: Block | undefined; accepted: boolean; code?: string; message?: string };
  /** Build, sign and add a block; throws when the block is rejected. */
  produce(txs?: TxEnvelope[], options?: BlockOptions): Block;
  sign(
    wallet: TestWallet,
    type: TxType,
    body: Uint8Array,
    options?: { gas?: bigint; nonce?: number; validUntil?: number; protocolTime?: number },
  ): TxEnvelope;
  close(): void;
}

export async function createHarness(options: { network?: string; producer?: TestWallet } = {}): Promise<Harness> {
  const net = options.network ? getNetwork(options.network) : DEVNET;
  const dir = mkdtempSync(join(tmpdir(), 'obsidian-test-'));
  const producer = options.producer ?? makeWallet(net);
  const chain = new ChainManager({
    dataDir: dir,
    net,
    genesisDocument: {
      networkId: net.networkId,
      chainId: net.chainId,
      protocolVersion: PROTOCOL_VERSION,
      timestamp: 1_767_225_600,
      note: 'test genesis',
    },
    enforceProposerRotation: true,
  });
  await chain.init();

  const sign: Harness['sign'] = (wallet, type, body, opts = {}) => {
    const account = chain.world.getAccount(wallet.address);
    // Tests that mine blocks with explicit timestamps must sign against the
    // same protocol time, exactly like a real wallet uses chain time.
    const protocolTime = opts.protocolTime ?? chain.protocolTime;
    return signTransaction({
      sender: wallet.address,
      privateKeyHex: wallet.privateKey,
      publicKeyHex: wallet.publicKey,
      chainId: net.chainId,
      protocolVersion: PROTOCOL_VERSION,
      nonce: opts.nonce ?? account?.nonce ?? 0,
      type,
      gas: opts.gas ?? 0n,
      body,
      validUntil: opts.validUntil ?? protocolTime + 600,
    });
  };

  const makeBlock: Harness['makeBlock'] = (txs = [], options = {}) => {
    const head = chain.tip!;
    const height = head.height + 1;
    const timestamp = options.timestamp ?? Math.max(chain.protocolTime, head.timestamp + 1);
    const blockProducer = options.producer ?? producer;
    // Simulate so the header commits to the real post-state roots. Tests that
    // intentionally include an invalid transaction set `simulate: false`,
    // because the transaction is rejected before the roots are ever compared.
    const trial =
      options.simulate === false
        ? { stateRoot: '0'.repeat(64), eventsRoot: '0'.repeat(64) }
        : applyBlock(
            chain.world,
            {
              header: {
                protocolVersion: PROTOCOL_VERSION,
                chainId: net.chainId,
                height,
                prevHash: head.hash,
                txRoot: '',
                stateRoot: '',
                paramsHash: PARAMS_HASH,
                timestamp,
                producer: blockProducer.address,
                cumulativePotWeight: 0n,
                txCount: txs.length,
                eventsRoot: '',
                producerSignature: { publicKey: '', signature: '' },
              },
              transactions: txs,
            },
            { net, skipRootCheck: true },
          );
    const block = buildBlock({
      protocolVersion: PROTOCOL_VERSION,
      chainId: net.chainId,
      height,
      prevHash: head.hash,
      stateRoot: trial.stateRoot,
      eventsRoot: trial.eventsRoot,
      timestamp,
      producer: blockProducer.address,
      producerPrivateKey: blockProducer.privateKey,
      producerPublicKey: blockProducer.publicKey,
      parentCumulativePotWeight: BigInt(head.cumulativePotWeight),
      transactions: txs,
    });
    return block;
  };

  const makeBlockOn: Harness['makeBlockOn'] = (parent, txs = [], options = {}) => {
    const height = parent.height + 1;
    const timestamp = options.timestamp ?? Math.max(chain.protocolTime, parent.height + 1);
    const blockProducer = options.producer ?? producer;
    const trial = applyBlock(
      parent.state,
      {
        header: {
          protocolVersion: PROTOCOL_VERSION,
          chainId: net.chainId,
          height,
          prevHash: parent.hash,
          txRoot: '',
          stateRoot: '',
          paramsHash: PARAMS_HASH,
          timestamp,
          producer: blockProducer.address,
          cumulativePotWeight: 0n,
          txCount: txs.length,
          eventsRoot: '',
          producerSignature: { publicKey: '', signature: '' },
        },
        transactions: txs,
      },
      { net, skipRootCheck: true },
    );
    const block = buildBlock({
      protocolVersion: PROTOCOL_VERSION,
      chainId: net.chainId,
      height,
      prevHash: parent.hash,
      stateRoot: trial.stateRoot,
      eventsRoot: trial.eventsRoot,
      timestamp,
      producer: blockProducer.address,
      producerPrivateKey: blockProducer.privateKey,
      producerPublicKey: blockProducer.publicKey,
      parentCumulativePotWeight: parent.cumulativePotWeight,
      transactions: txs,
    });
    return { block, state: trial.state };
  };

  const tryBlock: Harness['tryBlock'] = (txs = [], options = {}) => {
    // An invalid transaction is rejected while the block is being built (the
    // harness simulates the state transition to compute the roots). Surface that
    // as `{accepted: false, code}` instead of throwing, so tests can assert on
    // the protocol error exactly as a node would report it.
    let block: Block;
    try {
      block = makeBlock(txs, options);
    } catch (error) {
      if (error instanceof ProtocolError) {
        return {
          block: undefined as unknown as Block,
          accepted: false,
          code: error.code,
          message: error.message,
        };
      }
      throw error;
    }
    const result = chain.addBlock(block);
    return { block, accepted: result.accepted, code: result.code, message: result.message };
  };

  const produce: Harness['produce'] = (txs = [], options = {}) => {
    const outcome = tryBlock(txs, options);
    if (!outcome.accepted || !outcome.block) {
      throw new Error(`block rejected: ${outcome.code} ${outcome.message}`);
    }
    return outcome.block;
  };

  return {
    chain,
    net,
    producer,
    dir,
    makeBlock,
    makeBlockOn,
    tryBlock,
    produce,
    sign,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Sign a payment with the exact gas the protocol will require, the way a real
 * wallet does (it fetches the gas requirement before signing).
 */
export function signedPayment(
  harness: Harness,
  wallet: TestWallet,
  to: string,
  amount: bigint,
  options: { memo?: string; nonce?: number; protocolTime?: number } = {},
): TxEnvelope {
  return harness.sign(wallet, TxType.PAYMENT, encodePaymentBody({ to, amount, memo: options.memo }), {
    gas: expectedGas(amount),
    nonce: options.nonce,
    protocolTime: options.protocolTime,
  });
}

/** Sign a mining claim (always zero gas: mining is free by protocol rule). */
export function signedClaim(harness: Harness, wallet: TestWallet, protocolTime?: number): TxEnvelope {
  return harness.sign(wallet, TxType.MINING_CLAIM, miningBody(harness, wallet), { gas: 0n, protocolTime });
}

/** Branch point for `makeBlockOn`, taken from the canonical chain. */
export function forkParent(harness: Harness, height: number): ForkParent {
  const hash = harness.chain.store.getCanonicalHashAtHeight(height);
  if (!hash) throw new Error(`no canonical block at height ${height}`);
  const entry = harness.chain.store.getIndexEntry(hash);
  if (!entry) throw new Error(`no index entry for ${hash}`);
  return {
    hash,
    height,
    cumulativePotWeight: BigInt(entry.cumulativePotWeight),
    state: harness.chain.stateAtHeight(height, hash),
  };
}

/**
 * Test-only helper: move a wallet's mining timer back so the 4-hour interval
 * has elapsed. Production code never does this — it exists so the acceptance
 * path of a repeat claim can be tested without waiting four hours.
 */
export function rewindMiningTimer(
  harness: Harness,
  address: string,
  seconds = CONSENSUS_PARAMS.mining.claimIntervalSeconds + 1,
): void {
  const account = harness.chain.world.s.accounts.get(address);
  if (!account?.mining) throw new Error(`account ${address} has no mining state`);
  account.mining.lastClaimAt -= seconds;
  if (account.mining.cycleStartAt > harness.chain.protocolTime) {
    account.mining.cycleStartAt = alignedCycleStart(harness.chain.protocolTime);
  }
}

/** Produce empty blocks until `count` blocks have been added. */
export function advance(harness: Harness, count: number): void {
  for (let i = 0; i < count; i += 1) harness.produce();
}

// ── Transaction builders used across tests ───────────────────────────────────

export function paymentBody(to: string, amount: bigint | string, memo?: string): Uint8Array {
  return encodePaymentBody({ to, amount: typeof amount === 'string' ? parseObs(amount) : amount, memo });
}

export function paymentGas(amount: bigint | string): bigint {
  return expectedGas(typeof amount === 'string' ? parseObs(amount) : amount);
}

export function miningBody(harness: Harness, wallet: TestWallet): Uint8Array {
  const account = harness.chain.world.getAccount(wallet.address);
  const sequence = account?.mining?.claimSequence ?? 1;
  const lastHeight = account?.mining?.lastClaimHeight ?? 0;
  return encodeMiningBody({
    claimId: computeClaimId(harness.net.chainId, wallet.address, sequence, lastHeight),
    claimSequence: sequence,
  });
}

export function oracleBody(source: string, priceUsdMicro: bigint, observedAt: number, idSeed: string): Uint8Array {
  return encodeOracleBody({
    observations: [{ source, priceUsdMicro, observedAt }],
    submissionId: idSeed.repeat(8).slice(0, 32),
  });
}

export function onsBody(op: number, name: string, extra: { address?: string; to?: string; fee?: bigint } = {}): Uint8Array {
  return encodeOnsBody({ op: op as never, name, fee: extra.fee ?? 0n, address: extra.address, to: extra.to });
}

export function capsuleBody(
  op: number,
  params: {
    owner: string;
    contentCommitment: string;
    unlockAt: number;
    contentNonce: string;
    commitment?: bigint;
    contentBytes?: number;
    previewChunk?: string;
    payment?: bigint;
    capsuleId?: string;
  },
): Uint8Array {
  const capsuleId =
    params.capsuleId ?? computeCapsuleId(params.owner, params.contentCommitment, params.unlockAt, params.contentNonce);
  return encodeCapsuleBody({
    op: op as never,
    capsuleId,
    contentCommitment: params.contentCommitment,
    contentNonce: params.contentNonce,
    unlockAt: params.unlockAt,
    commitment: params.commitment,
    contentBytes: params.contentBytes ?? 1024,
    previewChunk: params.previewChunk,
    payment: params.payment,
  });
}

export function landBody(
  op: number,
  params: {
    divisionId: string;
    countryCode: string;
    level?: number;
    subId?: string;
    plotIndex?: bigint;
    price?: bigint;
    to?: string;
  },
): Uint8Array {
  return encodeLandBody({
    op: op as never,
    divisionId: params.divisionId,
    countryCode: params.countryCode,
    level: params.level ?? 1,
    subId: params.subId ?? '',
    plotIndex: params.plotIndex ?? 0n,
    price: params.price,
    to: params.to,
  });
}

export function parcelIdFor(divisionId: string, plotIndex = 0n, subId = '', level = 1): string {
  return computeParcelId({ divisionId, level, subId, plotIndex });
}

export function socialBody(op: number, params: Record<string, unknown>): Uint8Array {
  return encodeSocialBody({ op: op as never, ...params } as never);
}

export function validatorBody(op: number, bond: bigint, validatorKey: string, commissionBps = 0): Uint8Array {
  return encodeValidatorBody({ op: op as never, bond, validatorKey, commissionBps });
}

export function treasuryBody(op: number, amount: bigint, purpose: string, to?: string): Uint8Array {
  return encodeTreasuryBody({ op: op as never, amount, purpose, to });
}

/**
 * Node runner test identity: a real secp256k1 keypair, used exactly as an
 * operator would use one — the node key signs the statement, the reward wallet
 * signs (and pays for) the transaction.
 */
export interface TestNode {
  nodeId: string;
  publicKey: string;
  privateKey: string;
  wallet: TestWallet;
}

export function makeNode(wallet: TestWallet): TestNode {
  const keys = generateKeyPair();
  return {
    nodeId: nodeIdFromPublicKey(keys.publicKey),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    wallet,
  };
}

/** Sign a node statement exactly the way the executor verifies it. */
export function nodeProof(domain: string, message: string, privateKey: string): string {
  return toHex(signDigest(sha256(utf8(`${domain}\n${message}`)), privateKey));
}

export function nodeRegistryBody(params: {
  op: number;
  node: TestNode;
  rewardWallet?: string;
  proof: string;
  endpoint?: string;
  slot?: number;
  subject?: string;
  reportedHeight?: number;
  reason?: string;
  issuedAt?: number;
  expiresAt?: number;
}): Uint8Array {
  return encodeNodeRegistryBody({
    op: params.op as never,
    nodeId: params.node.nodeId,
    rewardWallet: params.rewardWallet ?? params.node.wallet.address,
    nodePublicKey: params.node.publicKey,
    proof: params.proof,
    endpoint: params.endpoint,
    slot: params.slot,
    subject: params.subject,
    reportedHeight: params.reportedHeight,
    reason: params.reason,
    issuedAt: params.issuedAt,
    expiresAt: params.expiresAt,
  });
}

/** Register a node runner the way an operator would, and assert it landed. */
export function registerNode(harness: Harness, node: TestNode, options: { endpoint?: string } = {}): void {
  const issuedAt = harness.chain.protocolTime;
  const expiresAt = issuedAt + 600;
  const endpoint = options.endpoint ?? '203.0.113.10:8631';
  const message = nodeRegistrationMessage({
    networkId: harness.net.networkId,
    chainId: harness.net.chainId,
    nodeId: node.nodeId,
    rewardWallet: node.wallet.address,
    endpoint,
    issuedAt,
    expiresAt,
  });
  const proof = nodeProof(DOMAIN.NODE_REGISTRATION, message, node.privateKey);
  harness.produce([
    harness.sign(
      node.wallet,
      TxType.NODE_REGISTRY,
      nodeRegistryBody({ op: NodeRegistryOp.REGISTER, node, proof, endpoint, issuedAt, expiresAt }),
      { gas: 0n },
    ),
  ]);
}

/** Send a heartbeat for the current reward period. */
export function nodeHeartbeat(harness: Harness, node: TestNode, options: { reportedHeight?: number } = {}): TxEnvelope {
  const period = rewardPeriodAt(harness.chain.protocolTime);
  const reportedHeight = options.reportedHeight ?? harness.chain.store.head?.height ?? 0;
  const record = harness.chain.world.node(node.nodeId);
  const message = heartbeatMessage({
    networkId: harness.net.networkId,
    chainId: harness.net.chainId,
    nodeId: node.nodeId,
    period,
    reportedHeight,
    endpoint: record?.endpoint ?? '',
  });
  const proof = nodeProof(DOMAIN.NODE_HEARTBEAT, message, node.privateKey);
  return harness.sign(
    node.wallet,
    TxType.NODE_REGISTRY,
    nodeRegistryBody({ op: NodeRegistryOp.HEARTBEAT, node, proof, slot: period, reportedHeight }),
    { gas: 0n },
  );
}

/** One node attests another node's liveness for the current period. */
export function nodeAttest(harness: Harness, observer: TestNode, subject: TestNode): TxEnvelope {
  const period = rewardPeriodAt(harness.chain.protocolTime);
  const reportedHeight = harness.chain.store.head?.height ?? 0;
  const message = attestationMessage({
    networkId: harness.net.networkId,
    chainId: harness.net.chainId,
    observer: observer.nodeId,
    subject: subject.nodeId,
    period,
    reportedHeight,
  });
  const proof = nodeProof(DOMAIN.NODE_ATTESTATION, message, observer.privateKey);
  return harness.sign(
    observer.wallet,
    TxType.NODE_REGISTRY,
    nodeRegistryBody({
      op: NodeRegistryOp.ATTEST,
      node: observer,
      proof,
      slot: period,
      subject: subject.nodeId,
      reportedHeight,
    }),
    { gas: 0n },
  );
}

// ── Assertion helpers ────────────────────────────────────────────────────────

export function miningEligibility(harness: Harness, wallet: TestWallet) {
  return evaluateMining(
    harness.chain.world.getAccount(wallet.address),
    harness.chain.protocolTime,
    harness.chain.world.s.metrics.activeMiners,
    harness.chain.world.s.genesis.allocationClaimed,
  );
}

export function balanceObs(harness: Harness, address: string): string {
  return formatObs(harness.chain.world.getAccount(address)?.balance ?? 0n);
}

export function supplyObs(harness: Harness): string {
  return formatObs(harness.chain.world.s.metrics.totalSupply);
}

export function params(): typeof CONSENSUS_PARAMS {
  return CONSENSUS_PARAMS;
}

export { blockHash, encodeBlock, decodeBlock, formatObs, parseObs, TxType };
export type { Block };
