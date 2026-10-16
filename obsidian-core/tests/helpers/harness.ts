/**
 * Test harness.
 *
 * Builds a real ChainManager on a throwaway data directory and drives it with
 * real signed transactions. Nothing is mocked: every test exercises the same
 * code path a production node runs, which is the only way these tests can prove
 * anything about consensus behaviour.
 */

import { encodeMarketBody } from '../../src/transactions/executors/marketplace.js';
import { vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChainManager } from '../../src/blockchain/chain.js';
import type { WorldState } from '../../src/blockchain/state.js';
import { buildBlock, blockHash, encodeBlock, decodeBlock } from '../../src/blockchain/block.js';
import { signTransaction } from '../../src/transactions/encode.js';
import { generateRecoveryPhrase, deriveWallet } from '../../src/crypto/mnemonic.js';
import { addressFromPublicKey, generateKeyPair, keyPairFromPrivateKey, nodeIdFromPublicKey } from '../../src/crypto/keys.js';
import { NodeRegistryOp } from '../../src/protocol/types.js';
import { rewardPeriodAt, uptimeWindowIndex } from '../../src/economy/node-rewards.js';
import { encodeNodeRegistryBody } from '../../src/transactions/executors/node-registry.js';
import { TxType, type TxEnvelope, type Block } from '../../src/protocol/types.js';
import { ProtocolError } from '../../src/protocol/errors.js';
import { getNetwork, type NetworkDefinition } from '../../src/protocol/networks.js';
import { producerDecision, proposerRound } from '../../src/consensus/schedule.js';
import { applyBlock } from '../../src/blockchain/state-machine.js';
import { PARAMS_HASH } from '../../src/blockchain/state-root.js';
import { PROTOCOL_VERSION } from '../../src/version.js';
import { encodePaymentBody } from '../../src/transactions/executors/payment.js';
import { encodeMiningBody, computeClaimId } from '../../src/transactions/executors/mining.js';
import { issueMiningGateCertificate } from '../../src/mining/gate.js';
import { encodeOracleBody } from '../../src/transactions/executors/oracle.js';
import { encodeOnsBody } from '../../src/transactions/executors/ons.js';
import { encodeTreasuryBody } from '../../src/transactions/executors/treasury.js';
import { CONSENSUS_PARAMS } from '../../src/protocol/params.js';
import { alignedCycleStart, evaluateMining } from '../../src/mining/rules.js';
import { expectedGas } from '../../src/transactions/helpers.js';
import { formatObs, parseObs } from '../../src/protocol/amount.js';

export const DEVNET = getNetwork('devnet');

/**
 * The test mining gate issuer. A fixed key (so genesis ids in tests are reproducible) that exists only in tests; the
 * harness commits its public half in every genesis it builds, exactly as a real network commits the platform's key.
 */
export const GATE_ISSUER = keyPairFromPrivateKey('11'.repeat(32));
/** A second issuer that is NOT committed by any harness chain: its certificates must be refused. */
export const FOREIGN_GATE_ISSUER = keyPairFromPrivateKey('22'.repeat(32));

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
   * Every key the test can sign blocks with, by producer address. When a block option names no producer the harness
   * asks the schedule who is due and signs with that key if it is known (registerNode adds the node key here).
   */
  signers: Map<string, TestWallet>;
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

export async function createHarness(options: { network?: string; producer?: TestWallet; miningGatePublicKeys?: string[] } = {}): Promise<Harness> {
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
      miningGatePublicKeys: options.miningGatePublicKeys ?? [GATE_ISSUER.publicKey],
    },
    enforceProposerRotation: true,
  });
  await chain.init();

  const signers = new Map<string, TestWallet>([[producer.address, producer]]);
  /** The scheduled producer's key when the harness holds it, else the default producer. */
  const dueProducer = (state: WorldState, height: number, parentTimestamp: number, timestamp: number): TestWallet => {
    const decision = producerDecision(state, height, proposerRound(parentTimestamp, timestamp), timestamp);
    if (decision.kind === 'SCHEDULED') return signers.get(decision.producer) ?? producer;
    return producer;
  };

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

  /**
   * A block may not be dated more than two slots ahead of the node's clock. Tests build blocks far faster than a
   * node would, so a test that has switched on a fake clock (`vi.useFakeTimers({ toFake: ['Date'] })`) gets one that
   * keeps up with the chain, as real time would; a test on the real clock is untouched.
   */
  const keepClockWithChain = (timestampSeconds: number): void => {
    if (vi.isFakeTimers() && Date.now() < timestampSeconds * 1000) vi.setSystemTime(timestampSeconds * 1000);
  };

  const makeBlock: Harness['makeBlock'] = (txs = [], options = {}) => {
    const head = chain.tip!;
    if (options.timestamp === undefined) keepClockWithChain(head.timestamp);
    const height = head.height + 1;
    const timestamp = options.timestamp ?? Math.max(chain.protocolTime, head.timestamp + 1);
    const blockProducer = options.producer ?? dueProducer(chain.world, height, head.timestamp, timestamp);
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
    if (options.timestamp === undefined) keepClockWithChain(parent.state.s.timestamp);
    const timestamp = options.timestamp ?? Math.max(chain.protocolTime, parent.height + 1);
    const blockProducer = options.producer ?? dueProducer(parent.state, height, parent.state.s.timestamp, timestamp);
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
    signers,
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
  return harness.sign(wallet, TxType.MINING_CLAIM, miningBody(harness, wallet, { protocolTime }), { gas: 0n, protocolTime });
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

export function miningBody(
  harness: Harness,
  wallet: TestWallet,
  options: { protocolTime?: number; gate?: 'none' | 'foreign' | { issuedAt: number } } = {},
): Uint8Array {
  const account = harness.chain.world.getAccount(wallet.address);
  const sequence = account?.mining?.claimSequence ?? 1;
  const lastHeight = account?.mining?.lastClaimHeight ?? 0;
  const claimId = computeClaimId(harness.net.chainId, wallet.address, sequence, lastHeight);
  const subject = { networkId: harness.net.networkId, chainId: harness.net.chainId, address: wallet.address, claimId };
  const issuedAt = typeof options.gate === 'object' ? options.gate.issuedAt : (options.protocolTime ?? harness.chain.protocolTime);
  const issuer = options.gate === 'foreign' ? FOREIGN_GATE_ISSUER : GATE_ISSUER;
  return encodeMiningBody({
    claimId,
    claimSequence: sequence,
    gate: options.gate === 'none' ? undefined : issueMiningGateCertificate(issuer.privateKey, issuer.publicKey, subject, issuedAt),
  });
}

/** A gate certificate from the committed test issuer for an arbitrary (wallet, claim id): for tests that forge the rest. */
export function gateFor(harness: Harness, address: string, claimId: string, issuedAt?: number) {
  return issueMiningGateCertificate(
    GATE_ISSUER.privateKey,
    GATE_ISSUER.publicKey,
    { networkId: harness.net.networkId, chainId: harness.net.chainId, address, claimId },
    issuedAt ?? harness.chain.protocolTime,
  );
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

export function marketBody(
  op: number,
  name: string,
  extra: { amount?: bigint; counterparty?: string; offerId?: string } = {},
): Uint8Array {
  return encodeMarketBody({
    op: op as never,
    name,
    amount: extra.amount ?? 0n,
    counterparty: extra.counterparty ?? '',
    offerId: extra.offerId ?? '',
  });
}

export function treasuryBody(op: number, amount: bigint, purpose: string, to?: string): Uint8Array {
  return encodeTreasuryBody({ op: op as never, amount, purpose, to });
}

/**
 * Node test identity: a real secp256k1 keypair, used exactly as a running node uses its own. The NODE KEY signs every
 * node statement (it is the transaction sender); the reward wallet is only an address that gets paid.
 */
export interface TestNode {
  nodeId: string;
  publicKey: string;
  privateKey: string;
  /** The producer address: the address of the node key. */
  address: string;
  /** The reward wallet bound to this node. Never signs anything node-related except RECLAIM_WALLET. */
  wallet: TestWallet;
}

export function makeNode(wallet: TestWallet, net: NetworkDefinition = DEVNET): TestNode {
  const keys = generateKeyPair(net.addressHrp);
  return {
    nodeId: nodeIdFromPublicKey(keys.publicKey),
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
    address: addressFromPublicKey(keys.publicKey, net.addressHrp),
    wallet,
  };
}

/** A node viewed as a signing wallet (sender = producer address). */
export function nodeSigner(node: TestNode): TestWallet {
  return { ...node.wallet, address: node.address, privateKey: node.privateKey, publicKey: node.publicKey };
}

export function nodeRegistryBody(params: {
  op: number;
  node: TestNode;
  rewardWallet?: string;
  endpoint?: string;
  slot?: number;
  subject?: string;
  reportedHeight?: number;
  reason?: string;
  firstHeader?: string;
  secondHeader?: string;
  nodeId?: string;
}): Uint8Array {
  return encodeNodeRegistryBody({
    op: params.op as never,
    nodeId: params.nodeId ?? params.node.nodeId,
    rewardWallet: params.rewardWallet ?? params.node.wallet.address,
    nodePublicKey: params.node.publicKey,
    proof: '',
    endpoint: params.endpoint,
    slot: params.slot,
    subject: params.subject,
    reportedHeight: params.reportedHeight,
    reason: params.reason,
    issuedAt: undefined,
    expiresAt: undefined,
    firstHeader: params.firstHeader,
    secondHeader: params.secondHeader,
  });
}

/** Sign one node statement with the node key. No gas, no wallet signature. */
export function nodeStatement(
  harness: Harness,
  node: TestNode,
  fields: Omit<Parameters<typeof nodeRegistryBody>[0], 'node'>,
  options: { nonce?: number; protocolTime?: number } = {},
): TxEnvelope {
  return harness.sign(nodeSigner(node), TxType.NODE_REGISTRY, nodeRegistryBody({ ...fields, node }), {
    gas: 0n,
    ...options,
  });
}

/** Register a node the way a running node does: signed by its own key, bound to a pasted wallet address. */
export function registerNode(harness: Harness, node: TestNode, options: { endpoint?: string } = {}): void {
  harness.signers.set(node.address, nodeSigner(node));
  harness.produce([
    nodeStatement(harness, node, { op: NodeRegistryOp.REGISTER, endpoint: options.endpoint ?? '203.0.113.10:8631' }),
  ]);
}

/** Send a heartbeat for the current uptime window. */
export function nodeHeartbeat(harness: Harness, node: TestNode, options: { reportedHeight?: number; slot?: number } = {}): TxEnvelope {
  const reportedHeight = options.reportedHeight ?? harness.chain.store.head?.height ?? 0;
  const slot = options.slot ?? uptimeWindowIndex(harness.chain.protocolTime);
  return nodeStatement(harness, node, { op: NodeRegistryOp.HEARTBEAT, slot, reportedHeight });
}

/** One node attests another node's liveness for the current period. */
export function nodeAttest(harness: Harness, observer: TestNode, subject: TestNode): TxEnvelope {
  const period = rewardPeriodAt(harness.chain.protocolTime);
  return nodeStatement(harness, observer, { op: NodeRegistryOp.ATTEST, slot: period, subject: subject.nodeId });
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
