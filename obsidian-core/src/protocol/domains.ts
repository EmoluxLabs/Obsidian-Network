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
  CAPSULE_SECRET: 'OBSIDIAN:CAPSULE_SECRET:v1',
  CAPSULE_ID: 'OBSIDIAN:CAPSULE_ID:v1',
  AUCTION_BID: 'OBSIDIAN:AUCTION_BID:v1',
  RELEASE_SIGNATURE: 'OBSIDIAN:RELEASE:v1',
  API_TOKEN: 'OBSIDIAN:API_TOKEN:v1',
} as const;

export type DomainTag = (typeof DOMAIN)[keyof typeof DOMAIN];
