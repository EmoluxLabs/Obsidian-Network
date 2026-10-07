/**
 * Hash domain separation tags.
 *
 * Each protocol object hashes over exactly one of these ASCII tags, so a
 * transaction id can never equal a block id, an address can never be reused as
 * a transaction hash, and cross-object replay of signatures is impossible.
 */

export const DOMAIN = {
  BLOCK_HEADER: 'OBSIDIAN:BLOCK_HEADER:v1',
  BLOCK: 'OBSIDIAN:BLOCK:v1',
  TX: 'OBSIDIAN:TX:v1',
  TX_SIGNING: 'OBSIDIAN:TX_SIGNING:v1',
  MERKLE_LEAF: 'OBSIDIAN:MERKLE_LEAF:v1',
  MERKLE_NODE: 'OBSIDIAN:MERKLE_NODE:v1',
  STATE_ROOT: 'OBSIDIAN:STATE_ROOT:v1',
  GENESIS: 'OBSIDIAN:GENESIS:v1',
  GENESIS_ID: 'OBSIDIAN:GENESIS_ID:v1',
  PEER_HELLO: 'OBSIDIAN:PEER_HELLO:v1',
  PEER_ANNOUNCE: 'OBSIDIAN:PEER_ANNOUNCE:v1',
  NODE_METADATA: 'OBSIDIAN:NODE_METADATA:v1',
  ORACLE_PRICE: 'OBSIDIAN:ORACLE_PRICE:v1',
  ORACLE_ATTESTATION: 'OBSIDIAN:ORACLE_ATTEST:v1',
  AUCTION_BID: 'OBSIDIAN:AUCTION_BID:v1',
  RELEASE_SIGNATURE: 'OBSIDIAN:RELEASE:v1',
  API_TOKEN: 'OBSIDIAN:API_TOKEN:v1',
  /** Node runner registration: proves the operator controls the reward wallet. */
  NODE_REGISTRATION: 'OBSIDIAN:NODE_REGISTRATION:v1',
  /** Reward wallet change: signed by the incoming wallet, delayed by a period. */
  NODE_WALLET_CHANGE: 'OBSIDIAN:NODE_WALLET_CHANGE:v1',
  /** Deregistration: releases the bond back to the reward wallet. */
  NODE_DEREGISTRATION: 'OBSIDIAN:NODE_DEREGISTRATION:v1',
  /** Liveness heartbeat signed by the node identity key. */
  NODE_HEARTBEAT: 'OBSIDIAN:NODE_HEARTBEAT:v1',
  /** Attestation signed by an observing node about another node. */
  NODE_ATTESTATION: 'OBSIDIAN:NODE_ATTESTATION:v1',
  /** Fault report signed by an observing node about another node. */
  NODE_FAULT_REPORT: 'OBSIDIAN:NODE_FAULT_REPORT:v1',
  /** Equal-membership bonded-validator checkpoint vote. */
  FINALITY_VOTE: 'OBSIDIAN:POT_FINALITY_VOTE:v1',
  /** Canonical hash of the finality validator committee. */
  FINALITY_VALIDATOR_SET: 'OBSIDIAN:FINALITY_VALIDATOR_SET:v1',
  /** Canonical identity of equivocation evidence. */
  EQUIVOCATION_EVIDENCE: 'OBSIDIAN:EQUIVOCATION_EVIDENCE:v1',
} as const;

export type DomainTag = (typeof DOMAIN)[keyof typeof DOMAIN];
