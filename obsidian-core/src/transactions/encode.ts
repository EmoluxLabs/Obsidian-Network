/**
 * Transaction canonical encoding, hashing, signing and verification.
 *
 * A transaction is the only object that can change protocol state, so its
 * encoding is the most security-relevant code in the node.
 *
 * Signing preimage:  H(TX_SIGNING | chainId | nonce | type | gas | validUntil |
 *                       sender | memo | body)
 * Transaction id:    H(TX | signed-preimage-bytes | publicKey | signature)
 *
 * Consequences:
 *   - The chain ID is inside the signed preimage, so a mainnet transaction can
 *     never be replayed on testnet or on a fork of a different network.
 *   - The nonce is inside the preimage, so a transaction cannot be re-signed
 *     onto another position in the account's sequence.
 *   - The transaction id commits to the signature, so two different signatures
 *     over the same body produce two different ids (no malleability collapse)
 *     while low-S enforcement removes the usual ECDSA malleability vector.
 */

import { encode, Reader, Writer } from '../protocol/encoding.js';
import { DOMAIN } from '../protocol/domains.js';
import { domainHash, fromHex, toHex } from '../crypto/hash.js';
import { signDigest, verifyAddressSignature } from '../crypto/keys.js';
import { ErrCode, reject } from '../protocol/errors.js';
import { TxType, type TxEnvelope, type TxSignature } from '../protocol/types.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';

export interface UnsignedTx {
  protocolVersion: string;
  chainId: number;
  sender: string;
  nonce: number;
  type: TxType;
  gas: bigint;
  body: Uint8Array;
  memo?: string;
  validUntil: number;
}

function encodeSigningPreimage(tx: UnsignedTx): Uint8Array {
  return encode((w) => {
    w.string(tx.protocolVersion);
    w.u32(tx.chainId);
    w.string(tx.sender);
    w.u32(tx.nonce);
    w.u16(tx.type);
    w.u128(tx.gas);
    w.u64(BigInt(Math.trunc(tx.validUntil)));
    w.string(tx.memo ?? '');
    w.bytes(tx.body);
  });
}

export function signingDigest(tx: UnsignedTx): Uint8Array {
  return domainHash(DOMAIN.TX_SIGNING, encodeSigningPreimage(tx));
}

export function encodeSignedTx(tx: TxEnvelope): Uint8Array {
  return encode((w) => {
    w.string(tx.protocolVersion);
    w.u32(tx.chainId);
    w.string(tx.sender);
    w.u32(tx.nonce);
    w.u16(tx.type);
    w.u128(tx.gas);
    w.u64(BigInt(Math.trunc(tx.validUntil)));
    w.string(tx.memo ?? '');
    w.bytes(tx.body);
    w.string(tx.signature.publicKey);
    w.string(tx.signature.signature);
  });
}

export function encodeTxForRoot(tx: TxEnvelope): Uint8Array {
  // The Merkle tree commits to the canonical signed bytes of each transaction.
  return encodeSignedTx(tx);
}

export function computeTxId(tx: UnsignedTx, signature: TxSignature): string {
  const preimage = encodeSigningPreimage(tx);
  return toHex(
    domainHash(
      DOMAIN.TX,
      preimage,
      fromHex(signature.publicKey),
      fromHex(signature.signature),
    ),
  );
}

/** Deterministic transaction id given a signed envelope. */
export function txIdOf(tx: TxEnvelope): string {
  if (tx.id) return tx.id;
  return computeTxId(tx, tx.signature);
}

export interface SignTxOptions {
  sender: string;
  privateKeyHex: string;
  publicKeyHex: string;
  chainId: number;
  protocolVersion: string;
  nonce: number;
  type: TxType;
  gas: bigint;
  body: Uint8Array;
  memo?: string;
  validUntil: number;
}

export function signTransaction(options: SignTxOptions): TxEnvelope {
  const unsigned: UnsignedTx = {
    protocolVersion: options.protocolVersion,
    chainId: options.chainId,
    sender: options.sender,
    nonce: options.nonce,
    type: options.type,
    gas: options.gas,
    body: options.body,
    memo: options.memo,
    validUntil: options.validUntil,
  };
  const digest = signingDigest(unsigned);
  const signatureBytes = signDigest(digest, options.privateKeyHex);
  const signature: TxSignature = {
    publicKey: options.publicKeyHex,
    signature: toHex(signatureBytes),
  };
  return {
    ...unsigned,
    id: computeTxId(unsigned, signature),
    signature,
  };
}

export interface TxValidationContext {
  chainId: number;
  supportedProtocolVersions: string[];
  /** Protocol time of the block that would include the transaction. */
  protocolTime: number;
  /** Account nonce expected next, if the sender account exists. */
  expectedNonce: number;
  /** Height of the block that would include the transaction. */
  height: number;
  /**
   * Address human-readable part of the network (obs on mainnet, dobs on devnet,
   * ...). Signatures are verified against the address of THIS network, so a
   * mainnet transaction can never be replayed on another Obsidian network.
   */
  addressHrp?: string;
}

/**
 * Structural validation. Runs before any state is touched: encoding, version,
 * chain id, size, expiry, signature and nonce. State-dependent checks (balance,
 * type-specific rules) run in the executors.
 */
export function validateTxStructure(tx: TxEnvelope, ctx: TxValidationContext): void {
  if (!ctx.supportedProtocolVersions.includes(tx.protocolVersion)) {
    reject(ErrCode.VERSION_MISMATCH, `unsupported protocol version ${tx.protocolVersion}`);
  }
  if (tx.chainId !== ctx.chainId) {
    reject(ErrCode.WRONG_CHAIN_ID, `transaction chain id ${tx.chainId} != ${ctx.chainId}`);
  }
  if (!Object.values(TxType).includes(tx.type)) {
    reject(ErrCode.UNKNOWN_TX_TYPE, `unknown transaction type ${tx.type}`);
  }
  if (tx.gas < 0n) reject(ErrCode.BAD_GAS, 'gas must not be negative');
  if (tx.gas > CONSENSUS_PARAMS.gas.maxGas) {
    reject(ErrCode.BAD_GAS, `gas exceeds protocol maximum of ${CONSENSUS_PARAMS.gas.maxGas}`);
  }
  if (tx.nonce < 0 || !Number.isInteger(tx.nonce)) reject(ErrCode.BAD_NONCE, 'nonce must be a u32');
  if (!Number.isInteger(tx.validUntil)) reject(ErrCode.MALFORMED, 'validUntil must be an integer');
  if (tx.validUntil < ctx.protocolTime) {
    reject(ErrCode.EXPIRED, `transaction expired at ${tx.validUntil} (protocol time ${ctx.protocolTime})`);
  }
  if (tx.validUntil > ctx.protocolTime + CONSENSUS_PARAMS.tx.expiryBlocks * CONSENSUS_PARAMS.block.targetBlockSeconds) {
    reject(ErrCode.NOT_YET_VALID, 'validUntil is further ahead than the protocol permits');
  }
  if (tx.memo && Buffer.byteLength(tx.memo, 'utf8') > CONSENSUS_PARAMS.tx.maxMemoBytes) {
    reject(ErrCode.MALFORMED, `memo exceeds ${CONSENSUS_PARAMS.tx.maxMemoBytes} bytes`);
  }
  const size = encodeSignedTx(tx).length;
  if (size > CONSENSUS_PARAMS.tx.maxTxBytes) {
    reject(ErrCode.MALFORMED, `transaction size ${size} exceeds ${CONSENSUS_PARAMS.tx.maxTxBytes}`);
  }
  if (tx.nonce !== ctx.expectedNonce) {
    reject(ErrCode.BAD_NONCE, `expected nonce ${ctx.expectedNonce}, received ${tx.nonce}`);
  }
  const unsigned: UnsignedTx = {
    protocolVersion: tx.protocolVersion,
    chainId: tx.chainId,
    sender: tx.sender,
    nonce: tx.nonce,
    type: tx.type,
    gas: tx.gas,
    body: tx.body,
    memo: tx.memo,
    validUntil: tx.validUntil,
  };
  const digest = signingDigest(unsigned);
  if (
    !verifyAddressSignature(
      tx.sender,
      digest,
      tx.signature.signature,
      tx.signature.publicKey,
      ctx.addressHrp,
    )
  ) {
    reject(ErrCode.BAD_SIGNATURE, 'transaction signature invalid or does not match sender');
  }
  const expectedId = computeTxId(unsigned, tx.signature);
  if (tx.id && tx.id !== expectedId) {
    reject(ErrCode.MALFORMED, 'transaction id does not match its canonical encoding');
  }
}

/** Decode canonical signed bytes back into an envelope (p2p / block sync). */
export function decodeSignedTx(r: Reader): TxEnvelope {
  const protocolVersion = r.string();
  const chainId = r.u32();
  const sender = r.string();
  const nonce = r.u32();
  const type = r.u16() as TxType;
  const gas = r.u128();
  const validUntil = Number(r.u64());
  const memo = r.string();
  const body = r.bytes().slice();
  const publicKey = r.string();
  const signature = r.string();
  const tx: TxEnvelope = {
    protocolVersion,
    chainId,
    id: '',
    sender,
    nonce,
    type,
    gas,
    body,
    memo: memo.length ? memo : undefined,
    validUntil,
    signature: { publicKey, signature },
  };
  tx.id = computeTxId(
    {
      protocolVersion,
      chainId,
      sender,
      nonce,
      type,
      gas,
      body,
      memo: tx.memo,
      validUntil,
    },
    tx.signature,
  );
  return tx;
}

export function decodeSignedTxFromBytes(bytes: Uint8Array): TxEnvelope {
  const reader = new Reader(bytes);
  const tx = decodeSignedTx(reader);
  reader.ensureConsumed();
  return tx;
}

// ── Body encoders ────────────────────────────────────────────────────────────
// Each executor has a matching decoder in transactions/decoders.ts. Encoders and
// decoders live together so a field can never be written without a reader.

export function encodeBody(fn: (w: Writer) => void): Uint8Array {
  return encode(fn);
}
