/**
 * Genesis construction.
 *
 * Obsidian's genesis block contains NO allocation to any person, company or
 * founder wallet. The only issuance that ever becomes possible is the 100,000
 * OBS Genesis Allocation reserved for the first protocol-valid mining claim
 * (see genesis/rules.ts). The legacy 3,000,000 OBS allocation does not exist in
 * this codebase.
 *
 * The genesis document is a protocol constant: two nodes that build the same
 * document derive the same genesis id, the same genesis hash and therefore the
 * same network. A mismatch at startup is a hard refusal to start.
 */

import { sha256Hex, utf8, domainHash, toHex } from '../crypto/hash.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { DOMAIN } from '../protocol/domains.js';
import type { NetworkDefinition } from '../protocol/networks.js';
import type { Block } from '../protocol/types.js';
import { blockHash } from '../blockchain/block.js';
import { PARAMS_HASH, computeStateRoot } from '../blockchain/state-root.js';
import { emptyGenesisState } from '../blockchain/state.js';
import { WorldState } from '../blockchain/state.js';
import { merkleRootHex } from '../blockchain/merkle.js';
import { encodeEventForRoot } from '../blockchain/events.js';
import { PROTOCOL_VERSION } from '../version.js';
import { CONSENSUS_PARAMS } from '../protocol/params.js';
import type { GenesisDocument } from '../blockchain/chain.js';
import { committedBootstrapValidatorKeys } from './bootstrap-keys.js';

/**
 * Canonical mainnet genesis document. The timestamp is the Obsidian mainnet
 * genesis instant: 2026-01-01T00:00:00Z. It is a protocol constant, not a
 * deployment-time setting, because changing it changes every block hash.
 */
export const MAINNET_GENESIS_DOCUMENT: GenesisDocument = {
  networkId: 'obsidian-mainnet-1',
  chainId: 7777,
  protocolVersion: PROTOCOL_VERSION,
  timestamp: 1_767_225_600, // 2026-01-01T00:00:00Z
  note: 'Obsidian Network v1.6.0 genesis. No premine. 100,000 OBS reserved for the first valid miner.',
  // The committee itself is a protocol constant in genesis/bootstrap-keys.ts;
  // `genesisDocumentFor` fills it in and refuses to substitute another one.
  bootstrapValidatorPublicKeys: [],
};

export const TESTNET_GENESIS_DOCUMENT: GenesisDocument = {
  networkId: 'obsidian-testnet-1',
  chainId: 7778,
  protocolVersion: PROTOCOL_VERSION,
  timestamp: 1_767_225_600,
  note: 'Obsidian testnet genesis. No monetary value.',
  bootstrapValidatorPublicKeys: [],
};

export function normalizeBootstrapValidatorPublicKeys(keys: readonly string[]): string[] {
  if (!Array.isArray(keys)) throw new Error('bootstrapValidatorPublicKeys must be an array of compressed public keys');
  if (keys.length > CONSENSUS_PARAMS.consensus.finality.maxValidators) {
    throw new Error(`bootstrap validator set exceeds ${CONSENSUS_PARAMS.consensus.finality.maxValidators} keys`);
  }
  const normalized = keys.map((raw) => {
    if (typeof raw !== 'string') throw new Error('bootstrap validator public keys must be strings');
    const key = raw.trim().toLowerCase();
    if (!/^0[23][0-9a-f]{64}$/.test(key)) throw new Error('bootstrap validator keys must be lowercase compressed secp256k1 public keys');
    try { secp256k1.ProjectivePoint.fromHex(key).assertValidity(); }
    catch { throw new Error(`bootstrap validator key is not a valid secp256k1 point: ${key}`); }
    return key;
  });
  if (new Set(normalized).size !== normalized.length) throw new Error('bootstrap validator public keys must be unique');
  return normalized.sort();
}

/**
 * Resolve the bootstrap committee for a network.
 *
 *   - A network with a committed set (mainnet, testnet) always uses it. An
 *     operator may pass the same list explicitly; passing a *different* list is
 *     a hard error rather than a silent fork, because it would produce a
 *     different genesis id while looking like the real network.
 *   - A network without a committed set (staging, devnet, a private chain) uses
 *     whatever the operator supplies. An empty list is allowed and means no
 *     finality bootstrap at all.
 */
export function resolveBootstrapValidatorKeys(
  net: NetworkDefinition,
  requested: readonly string[] = [],
): string[] {
  const committed = normalizeBootstrapValidatorPublicKeys(committedBootstrapValidatorKeys(net));
  const provided = normalizeBootstrapValidatorPublicKeys(requested);
  if (committed.length === 0) return provided;
  if (provided.length === 0) return committed;
  if (provided.join(',') !== committed.join(',')) {
    throw new Error(
      `${net.name} commits a fixed finality bootstrap committee (${committed.length} keys); ` +
        'refusing to start with a different one. Remove the override, or run a network ' +
        'without a committed set (staging/devnet) and supply its keys there.',
    );
  }
  return committed;
}

export function genesisDocumentFor(net: NetworkDefinition, bootstrapKeys: readonly string[] = []): GenesisDocument {
  const bootstrapValidatorPublicKeys = resolveBootstrapValidatorKeys(net, bootstrapKeys);
  if (net.name === 'mainnet') {
    return { ...MAINNET_GENESIS_DOCUMENT, bootstrapValidatorPublicKeys };
  }
  return {
    networkId: net.networkId,
    chainId: net.chainId,
    protocolVersion: PROTOCOL_VERSION,
    timestamp: MAINNET_GENESIS_DOCUMENT.timestamp,
    note: `Obsidian ${net.name} genesis. No monetary value.`,
    bootstrapValidatorPublicKeys,
  };
}

/** Deterministic genesis identifier: identifies the network, not a block. */
export function genesisId(document: GenesisDocument, net: NetworkDefinition): string {
  return toHex(
    domainHash(
      DOMAIN.GENESIS_ID,
      utf8(`${document.networkId}|${document.chainId}|${document.protocolVersion}|${document.timestamp}|${net.addressHrp}|${normalizeBootstrapValidatorPublicKeys(document.bootstrapValidatorPublicKeys ?? []).join(',')}`),
    ),
  ).slice(0, 40);
}

/**
 * Build the genesis block. It has no transactions: there is no premine and no
 * registration reward. The state root of the empty initial state is committed.
 */
export function buildGenesisBlock(document: GenesisDocument, net: NetworkDefinition): Block {
  const state = createGenesisStateForDocument(document, net);
  const eventsRoot = merkleRootHex([]);
  // The genesis block is signed by the protocol itself: its "producer" is the
  // genesis marker and no key can exist for it, so verification of genesis is
  // performed by hash equality against the network constant instead.
  const header = {
    protocolVersion: document.protocolVersion,
    chainId: document.chainId,
    height: 0,
    prevHash: '0'.repeat(64),
    txRoot: merkleRootHex([]),
    stateRoot: computeStateRoot(state.s),
    paramsHash: PARAMS_HASH,
    timestamp: document.timestamp,
    producer: 'GENESIS',
    cumulativePotWeight: 1n,
    txCount: 0,
    eventsRoot,
    producerSignature: { publicKey: '', signature: '' },
  };
  return { header, transactions: [] };
}

/** The initial world state: zero accounts, zero supply, nothing minted. */
export function createGenesisState(block: Block, net: NetworkDefinition, bootstrapKeys: readonly string[] = []): WorldState {
  void net;
  const state = new WorldState();
  state.s.chainId = block.header.chainId;
  state.s.protocolVersion = block.header.protocolVersion;
  state.s.height = block.header.height;
  state.s.timestamp = block.header.timestamp;
  state.s.genesis = { ...emptyGenesisState(), bootstrapValidatorKeys: normalizeBootstrapValidatorPublicKeys(bootstrapKeys) };
  state.s.metrics.totalSupply = 0n;
  return state;
}

function createGenesisStateForDocument(document: GenesisDocument, net: NetworkDefinition): WorldState {
  return createGenesisState(
    {
      header: {
        protocolVersion: document.protocolVersion,
        chainId: document.chainId,
        height: 0,
        prevHash: '',
        txRoot: '',
        stateRoot: '',
        paramsHash: PARAMS_HASH,
        timestamp: document.timestamp,
        producer: 'GENESIS',
        cumulativePotWeight: 1n,
        txCount: 0,
        eventsRoot: '',
        producerSignature: { publicKey: '', signature: '' },
      },
      transactions: [],
    },
    net,
    document.bootstrapValidatorPublicKeys ?? [],
  );
}

/** Release checksum helper: SHA-256 of the genesis document + parameters. */
export function genesisFingerprint(document: GenesisDocument, net: NetworkDefinition): string {
  return sha256Hex(
    utf8(
      `${genesisId(document, net)}|${PARAMS_HASH}|${CONSENSUS_PARAMS.protocolVersion}|${blockHash(buildGenesisBlock(document, net).header)}`,
    ),
  );
}

export { encodeEventForRoot };
