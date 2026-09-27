/**
 * Block construction, canonical encoding, hashing and verification.
 *
 * headerHash / blockHash = H(BLOCK_HEADER | canonical header without signature)
 * transactionRoot         = Merkle root over the canonical signed bytes of the
 *                           block's transactions (domain-separated leaves)
 *
 * The producer signature covers the header hash, so any change to height,
 * parent, timestamps, roots or the transaction set invalidates it.
 */

import { Reader, Writer } from '../protocol/encoding.js';
import { DOMAIN } from '../protocol/domains.js';
import { domainHash, fromHex, toHex } from '../crypto/hash.js';
import { signDigest, verifyAddressSignature } from '../crypto/keys.js';
import { ErrCode, reject } from '../protocol/errors.js';
import type { Block, BlockHeader, BlockSummary, TxEnvelope, TxSignature } from '../protocol/types.js';
import { encodeSignedTx, decodeSignedTx } from '../transactions/encode.js';
import { merkleRootHex } from './merkle.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import { PARAMS_HASH } from './state-root.js';

export function encodeHeaderForHash(header: BlockHeader): Uint8Array {
  const w = new Writer();
  w.string(header.protocolVersion);
  w.u32(header.chainId);
  w.u32(header.height);
  w.string(header.prevHash);
  w.string(header.txRoot);
  w.string(header.stateRoot);
  w.string(header.paramsHash);
  w.u64(BigInt(Math.trunc(header.timestamp)));
  w.string(header.producer);
  w.u128(header.cumulativeWork);
  w.u32(header.txCount);
  w.string(header.eventsRoot);
  return w.finish();
}

/** Block hash: the identifier used by peers, the explorer and storage. */
export function blockHash(header: BlockHeader): string {
  return toHex(domainHash(DOMAIN.BLOCK_HEADER, encodeHeaderForHash(header)));
}

/** Work contributed by one block: 1 + accepted transaction count. */
export function blockWork(txCount: number): bigint {
  return 1n + BigInt(txCount);
}

export function transactionRootOf(transactions: TxEnvelope[]): string {
  return merkleRootHex(transactions.map(encodeSignedTx));
}

export function encodeBlock(block: Block): Uint8Array {
  const w = new Writer();
  w.string(block.header.protocolVersion);
  w.u32(block.header.chainId);
  w.u32(block.header.height);
  w.string(block.header.prevHash);
  w.string(block.header.txRoot);
  w.string(block.header.stateRoot);
  w.string(block.header.paramsHash);
  w.u64(BigInt(Math.trunc(block.header.timestamp)));
  w.string(block.header.producer);
  w.u128(block.header.cumulativeWork);
  w.u32(block.header.txCount);
  w.string(block.header.eventsRoot);
  w.string(block.header.producerSignature.publicKey);
  w.string(block.header.producerSignature.signature);
  // Transaction list: u32 count followed by the raw canonical signed bytes of
  // each transaction (no per-item length prefix). `Reader.list` mirrors this.
  w.u32(block.transactions.length);
  for (const tx of block.transactions) w.raw(encodeSignedTx(tx));
  return w.finish();
}

export function decodeBlock(bytes: Uint8Array): Block {
  const r = new Reader(bytes);
  const protocolVersion = r.string();
  const chainId = r.u32();
  const height = r.u32();
  const prevHash = r.string();
  const txRoot = r.string();
  const stateRoot = r.string();
  const paramsHash = r.string();
  const timestamp = Number(r.u64());
  const producer = r.string();
  const cumulativeWork = r.u128();
  const txCount = r.u32();
  const eventsRoot = r.string();
  const publicKey = r.string();
  const signature = r.string();
  const transactions = r.list((reader) => decodeSignedTx(reader)).map((tx) => tx as TxEnvelope);
  r.ensureConsumed();
  const header: BlockHeader = {
    protocolVersion,
    chainId,
    height,
    prevHash,
    txRoot,
    stateRoot,
    paramsHash,
    timestamp,
    producer,
    cumulativeWork,
    txCount,
    eventsRoot,
    producerSignature: { publicKey, signature },
  };
  return { header, transactions };
}

export interface BuildBlockOptions {
  protocolVersion: string;
  chainId: number;
  height: number;
  prevHash: string;
  stateRoot: string;
  eventsRoot: string;
  timestamp: number;
  producer: string;
  producerPrivateKey: string;
  producerPublicKey: string;
  parentCumulativeWork: bigint;
  transactions: TxEnvelope[];
}

export function buildBlock(options: BuildBlockOptions): Block {
  const txRoot = transactionRootOf(options.transactions);
  const header: BlockHeader = {
    protocolVersion: options.protocolVersion,
    chainId: options.chainId,
    height: options.height,
    prevHash: options.prevHash,
    txRoot,
    stateRoot: options.stateRoot,
    paramsHash: PARAMS_HASH,
    timestamp: options.timestamp,
    producer: options.producer,
    cumulativeWork: options.parentCumulativeWork + blockWork(options.transactions.length),
    txCount: options.transactions.length,
    eventsRoot: options.eventsRoot,
    producerSignature: { publicKey: options.producerPublicKey, signature: '' },
  };
  const hash = blockHash(header);
  const signature = signDigest(fromHex(hash), options.producerPrivateKey);
  header.producerSignature = {
    publicKey: options.producerPublicKey,
    signature: toHex(signature),
  };
  return { header, transactions: options.transactions };
}

/**
 * Re-sign a header after it has been modified (used by tests and tooling).
 * Consensus code never mutates a header after signing.
 */
export function signBlock(block: Block, privateKeyHex: string, publicKeyHex: string): Block {
  const header: BlockHeader = { ...block.header, producerSignature: { publicKey: publicKeyHex, signature: '' } };
  const signature = toHex(signDigest(fromHex(blockHash(header)), privateKeyHex));
  header.producerSignature = { publicKey: publicKeyHex, signature };
  return { header, transactions: block.transactions };
}

/** Verify the producer signature over the header. */
export function verifyBlockSignature(block: Block, addressHrp?: string): boolean {
  const hash = blockHash(block.header);
  const signature: TxSignature = block.header.producerSignature;
  if (!signature?.publicKey || !signature?.signature) return false;
  return verifyAddressSignature(
    block.header.producer,
    fromHex(hash),
    signature.signature,
    signature.publicKey,
    addressHrp,
  );
}

export function assertBlockSignature(block: Block, addressHrp?: string): void {
  if (!verifyBlockSignature(block, addressHrp)) {
    reject(ErrCode.BAD_PRODUCER, 'block producer signature is invalid');
  }
}

export function summarizeBlock(block: Block, size: number): BlockSummary {
  return {
    hash: blockHash(block.header),
    height: block.header.height,
    timestamp: block.header.timestamp,
    txCount: block.transactions.length,
    producer: block.header.producer,
    size,
    prevHash: block.header.prevHash,
  };
}

export function assertBlockSize(block: Block): void {
  const size = encodeBlock(block).length;
  if (size > CONSENSUS_PARAMS.block.maxBlockBytes) {
    reject(ErrCode.BLOCK_TOO_LARGE, `block is ${size} bytes, limit is ${CONSENSUS_PARAMS.block.maxBlockBytes}`);
  }
  if (block.transactions.length > CONSENSUS_PARAMS.block.maxBlockTransactions) {
    reject(ErrCode.BLOCK_TOO_LARGE, 'block contains too many transactions');
  }
  if (block.transactions.length !== block.header.txCount) {
    reject(ErrCode.MALFORMED, 'header txCount does not match the transaction list');
  }
  if (transactionRootOf(block.transactions) !== block.header.txRoot) {
    reject(ErrCode.BAD_MERKLE_ROOT, 'transaction root does not match the block body');
  }
}
