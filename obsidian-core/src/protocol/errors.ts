/**
 * Protocol error codes.
 *
 * Every rejection carries a stable machine code so that nodes, explorers and
 * the interface can reason about failures without parsing prose. Codes are part
 * of the protocol surface and must not be renumbered.
 */

export enum ErrCode {
  OK = 'OK',

  // Structural / encoding
  MALFORMED = 'ERR_MALFORMED',
  VERSION_MISMATCH = 'ERR_VERSION_MISMATCH',
  WRONG_NETWORK = 'ERR_WRONG_NETWORK',
  WRONG_CHAIN_ID = 'ERR_WRONG_CHAIN_ID',
  TRAILING_BYTES = 'ERR_TRAILING_BYTES',

  // Signature / authorisation
  BAD_SIGNATURE = 'ERR_BAD_SIGNATURE',
  BAD_SENDER = 'ERR_BAD_SENDER',
  BAD_ADDRESS = 'ERR_BAD_ADDRESS',
  UNAUTHORIZED = 'ERR_UNAUTHORIZED',

  // Replay / ordering
  BAD_NONCE = 'ERR_BAD_NONCE',
  DUPLICATE_TX = 'ERR_DUPLICATE_TX',
  REPLAY = 'ERR_REPLAY',
  EXPIRED = 'ERR_EXPIRED',
  NOT_YET_VALID = 'ERR_NOT_YET_VALID',

  // Value
  INSUFFICIENT_FUNDS = 'ERR_INSUFFICIENT_FUNDS',
  AMOUNT_ZERO = 'ERR_AMOUNT_ZERO',
  AMOUNT_NEGATIVE = 'ERR_AMOUNT_NEGATIVE',
  BAD_GAS = 'ERR_BAD_GAS',
  SUPPLY_EXCEEDED = 'ERR_SUPPLY_EXCEEDED',

  // Mining
  MINING_NOT_ELIGIBLE = 'ERR_MINING_NOT_ELIGIBLE',
  MINING_TOO_SOON = 'ERR_MINING_TOO_SOON',
  MINING_CYCLE_LIMIT = 'ERR_MINING_CYCLE_LIMIT',
  MINING_BAD_PROOF = 'ERR_MINING_BAD_PROOF',
  MINING_CLAIM_REPLAY = 'ERR_MINING_CLAIM_REPLAY',

  // Genesis
  GENESIS_ALREADY_CLAIMED = 'ERR_GENESIS_ALREADY_CLAIMED',
  GENESIS_NOT_ELIGIBLE = 'ERR_GENESIS_NOT_ELIGIBLE',

  // Transaction-type specific
  UNKNOWN_TX_TYPE = 'ERR_UNKNOWN_TX_TYPE',
  NAME_TAKEN = 'ERR_NAME_TAKEN',
  NAME_NOT_OWNED = 'ERR_NAME_NOT_OWNED',
  NAME_INVALID = 'ERR_NAME_INVALID',
  NAME_RESERVED = 'ERR_NAME_RESERVED',
  PRICE_MISMATCH = 'ERR_PRICE_MISMATCH',
  PARCEL_NOT_FOUND = 'ERR_PARCEL_NOT_FOUND',
  PARCEL_OWNED = 'ERR_PARCEL_OWNED',
  PARCEL_NOT_OWNED = 'ERR_PARCEL_NOT_OWNED',
  PARCEL_NOT_LISTED = 'ERR_PARCEL_NOT_LISTED',
  CAPSULE_NOT_FOUND = 'ERR_CAPSULE_NOT_FOUND',
  CAPSULE_LOCKED = 'ERR_CAPSULE_LOCKED',
  CAPSULE_UNLOCKED = 'ERR_CAPSULE_UNLOCKED',
  CAPSULE_ALREADY_PREVIEWED = 'ERR_CAPSULE_ALREADY_PREVIEWED',
  CAPSULE_COMMITMENT_TOO_LOW = 'ERR_CAPSULE_COMMITMENT_TOO_LOW',
  BID_TOO_LOW = 'ERR_BID_TOO_LOW',
  AUCTION_CLOSED = 'ERR_AUCTION_CLOSED',
  ACCOUNT_SUSPENDED = 'ERR_ACCOUNT_SUSPENDED',

  // Oracle
  ORACLE_STALE = 'ERR_ORACLE_STALE',
  ORACLE_UNAVAILABLE = 'ERR_ORACLE_UNAVAILABLE',
  ORACLE_OUT_OF_BOUNDS = 'ERR_ORACLE_OUT_OF_BOUNDS',
  ORACLE_INSUFFICIENT_SOURCES = 'ERR_ORACLE_INSUFFICIENT_SOURCES',

  // Block level
  BAD_PREV_HASH = 'ERR_BAD_PREV_HASH',
  BAD_HEIGHT = 'ERR_BAD_HEIGHT',
  BAD_MERKLE_ROOT = 'ERR_BAD_MERKLE_ROOT',
  BAD_STATE_ROOT = 'ERR_BAD_STATE_ROOT',
  BAD_TIMESTAMP = 'ERR_BAD_TIMESTAMP',
  BAD_DIFFICULTY = 'ERR_BAD_DIFFICULTY',
  BLOCK_TOO_LARGE = 'ERR_BLOCK_TOO_LARGE',
  DUPLICATE_BLOCK = 'ERR_DUPLICATE_BLOCK',
  ORPHAN_BLOCK = 'ERR_ORPHAN_BLOCK',
  BAD_PRODUCER = 'ERR_BAD_PRODUCER',
  NOT_PRODUCER_TURN = 'ERR_NOT_PRODUCER_TURN',

  // Fees
  GAS_REQUIRED = 'ERR_GAS_REQUIRED',

  // Internal
  INTERNAL = 'ERR_INTERNAL',
  RATE_LIMITED = 'ERR_RATE_LIMITED',
  NOT_FOUND = 'ERR_NOT_FOUND',
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrCode,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export function reject(code: ErrCode, message: string, context?: Record<string, unknown>): never {
  throw new ProtocolError(code, message, context);
}

/** Human-readable explanation shown in the interface for each rejection. */
export const ERR_MESSAGES: Record<ErrCode, string> = {
  [ErrCode.OK]: 'Accepted.',
  [ErrCode.MALFORMED]: 'The object could not be decoded under the canonical encoding rules.',
  [ErrCode.VERSION_MISMATCH]: 'Protocol version not supported by this node.',
  [ErrCode.WRONG_NETWORK]: 'Object belongs to a different Obsidian network.',
  [ErrCode.WRONG_CHAIN_ID]: 'Object was signed for a different chain ID.',
  [ErrCode.TRAILING_BYTES]: 'Object contains trailing bytes.',
  [ErrCode.BAD_SIGNATURE]: 'Cryptographic signature verification failed.',
  [ErrCode.BAD_SENDER]: 'The public key does not control the stated sender address.',
  [ErrCode.BAD_ADDRESS]: 'Address is not a valid obs1 address.',
  [ErrCode.UNAUTHORIZED]: 'The signer is not authorised for this operation.',
  [ErrCode.BAD_NONCE]: 'Transaction nonce is not the expected next nonce for this account.',
  [ErrCode.DUPLICATE_TX]: 'This transaction is already known.',
  [ErrCode.REPLAY]: 'This object has already been applied.',
  [ErrCode.EXPIRED]: 'Object expired before it was included.',
  [ErrCode.NOT_YET_VALID]: 'Object is not valid yet.',
  [ErrCode.INSUFFICIENT_FUNDS]: 'Insufficient OBS balance to cover amount plus gas.',
  [ErrCode.AMOUNT_ZERO]: 'Amount must be greater than zero.',
  [ErrCode.AMOUNT_NEGATIVE]: 'Amount must not be negative.',
  [ErrCode.BAD_GAS]: 'Gas calculation does not match the protocol formula.',
  [ErrCode.SUPPLY_EXCEEDED]: 'Issuance would exceed the 21,000,000 OBS maximum supply.',
  [ErrCode.MINING_NOT_ELIGIBLE]: 'Wallet is not an eligible miner.',
  [ErrCode.MINING_TOO_SOON]: 'The protocol mining interval has not elapsed yet.',
  [ErrCode.MINING_CYCLE_LIMIT]: 'The maximum number of claims for this 24-hour cycle is reached.',
  [ErrCode.MINING_BAD_PROOF]: 'Mining claim proof failed verification.',
  [ErrCode.MINING_CLAIM_REPLAY]: 'This mining claim has already been accepted.',
  [ErrCode.GENESIS_ALREADY_CLAIMED]: 'The Genesis Allocation has already been claimed by another wallet.',
  [ErrCode.GENESIS_NOT_ELIGIBLE]: 'This wallet is not eligible for the Genesis Allocation.',
  [ErrCode.UNKNOWN_TX_TYPE]: 'Unknown transaction type for this protocol version.',
  [ErrCode.NAME_TAKEN]: 'That .obs name is already registered.',
  [ErrCode.NAME_NOT_OWNED]: 'The signer does not own that .obs name.',
  [ErrCode.NAME_INVALID]: 'Name format is invalid.',
  [ErrCode.NAME_RESERVED]: 'That name is reserved by the protocol.',
  [ErrCode.PRICE_MISMATCH]: 'The accepted price does not match the price recorded in protocol state.',
  [ErrCode.PARCEL_NOT_FOUND]: 'No such land parcel exists.',
  [ErrCode.PARCEL_OWNED]: 'That parcel is already owned.',
  [ErrCode.PARCEL_NOT_OWNED]: 'That parcel is not owned by the signer.',
  [ErrCode.PARCEL_NOT_LISTED]: 'That parcel is not listed for sale.',
  [ErrCode.CAPSULE_NOT_FOUND]: 'No such Time Capsule exists.',
  [ErrCode.CAPSULE_LOCKED]: 'This Time Capsule has not unlocked yet.',
  [ErrCode.CAPSULE_UNLOCKED]: 'This Time Capsule has already unlocked; it is immutable.',
  [ErrCode.CAPSULE_ALREADY_PREVIEWED]: 'Each account may Time Travel a given capsule only once.',
  [ErrCode.CAPSULE_COMMITMENT_TOO_LOW]: 'Time Capsule commitment is below the protocol minimum (0.0001 OBS).',
  [ErrCode.BID_TOO_LOW]: 'Bid does not meet the reserve.',
  [ErrCode.AUCTION_CLOSED]: 'That auction is closed.',
  [ErrCode.ACCOUNT_SUSPENDED]: 'Account is suspended by protocol governance.',
  [ErrCode.ORACLE_STALE]: 'The price oracle has no fresh observation and cannot price this transaction.',
  [ErrCode.ORACLE_UNAVAILABLE]: 'Insufficient independent price sources are available to form a valid price.',
  [ErrCode.ORACLE_OUT_OF_BOUNDS]: 'A reported price fell outside protocol sanity bounds and was rejected.',
  [ErrCode.ORACLE_INSUFFICIENT_SOURCES]: 'Fewer oracle sources than the protocol quorum.',
  [ErrCode.BAD_PREV_HASH]: 'Block does not extend the parent seen by this node.',
  [ErrCode.BAD_HEIGHT]: 'Block height does not follow from its parent.',
  [ErrCode.BAD_MERKLE_ROOT]: 'Merkle root does not commit to the block transactions.',
  [ErrCode.BAD_STATE_ROOT]: 'State root does not match the state produced by this block.',
  [ErrCode.BAD_TIMESTAMP]: 'Block timestamp violates the median-time-past / drift rules.',
  [ErrCode.BAD_DIFFICULTY]: 'Difficulty does not match the value derived from the latest headers.',
  [ErrCode.BLOCK_TOO_LARGE]: 'Block exceeds the maximum serialized size.',
  [ErrCode.DUPLICATE_BLOCK]: 'Block is already part of this chain.',
  [ErrCode.ORPHAN_BLOCK]: 'Parent block is unknown; queued as an orphan.',
  [ErrCode.BAD_PRODUCER]: 'Producer address is not registered as a validator.',
  [ErrCode.NOT_PRODUCER_TURN]: 'Producer is not the scheduled proposer for this height.',
  [ErrCode.GAS_REQUIRED]: 'Transaction does not carry the protocol-required gas.',
  [ErrCode.INTERNAL]: 'Internal node error.',
  [ErrCode.RATE_LIMITED]: 'Rate limit exceeded.',
  [ErrCode.NOT_FOUND]: 'Object not found.',
};
