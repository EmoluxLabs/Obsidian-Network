/**
 * Obsidian Core version metadata.
 *
 * Every official release publishes: Version, Protocol Version, Build ID,
 * SHA256, Release Signature, Supported Network, Minimum Core Version.
 * See /docs/release-process.md.
 */

import { sha256Hex, utf8 } from './crypto/hash.js';

/** Software version of this Obsidian Core build. */
export const CORE_VERSION = '2.0.4';

/**
 * Consensus protocol version implemented by this build. It is part of the genesis id and of every block header, so it
 * changes only with a consensus change. A software release that changes no consensus rule leaves it alone: two
 * builds with the same protocol version are the same network and peer with each other.
 */
export const PROTOCOL_VERSION = '2.0.2';

/**
 * Current lossless consensus-state snapshot format.
 *
 * 7 (2.0.0) adds the ONS Marketplace: a listing on each name record, the offer table and the escrow/market counters.
 *   A 1.9.0 snapshot has none of them, and reading it as "no listings, no escrow" would invent a state, so it is refused.
 *
 * 6 (1.9.0) removes validator state and adds the producer-schedule fields of node records and the ONS transfer and
 * recovery fields; a 1.8.x snapshot is from a different protocol and is refused.
 *
 * 5 adds the live mining-gate authority (`gateKeysActive`, `gateKeysRevoked`, `gateEpoch`) that GATE_AUTHORITY updates change;
 * a 1.7.0 snapshot has none, and reading it as "no updates yet" would invent a state, so it is refused.
 *
 * 4 adds the committed mining-gate issuer keys (`miningGateKeys`); a 1.6.1 snapshot has none, and reading it as
 * "no keys" would be harmless but reading a 1.7 chain from it would not be meaningful, so it is refused.
 *
 * 3 adds the committed validator-mode indicator (`validatorModeEstablished`) and
 * the time-based jail term (`jailedUntilTime`). A snapshot written by 1.6.0 has
 * neither, so it is refused rather than silently read as "not established" —
 * reading an old snapshot as a new one would hand a bootstrapped chain back to
 * permissionless production.
 */
export const STATE_SNAPSHOT_VERSION = 7;

/** Wire/peer protocol version. */
export const WIRE_PROTOCOL_VERSION = 1;

/**
 * Minimum Obsidian Core version permitted to peer with this build.
 * Peers below this version are rejected during handshake (hard fork guard).
 *
 * 2.0.0 adds the ONS_MARKET transaction and puts listings, offers and escrow into every state root, so a 1.9.x peer (which
 * has none of it) cannot agree on a single block that touches the Marketplace: the two cannot share a chain.
 *
 * 1.9.0 replaces validator consensus with a deterministic producer schedule and voting-free finality, so every 1.8.x
 * node (which expects validator registration, finality votes and a committed committee) is rejected: the two
 * cannot share a chain, and a 1.9.0 genesis id differs anyway.
 *
 * 1.8.0 adds the GATE_AUTHORITY transaction and puts the live issuer set into every state root, so a 1.7.0 peer (which
 * has neither) cannot agree on a single block that touches the gate: the two cannot share a chain.
 *
 * 1.7.0 gates MINING_CLAIM behind a certificate signed by a genesis-committed issuer key, so a 1.6.1 peer (which
 * accepts claims from any key) is rejected: the two cannot agree on a chain.
 *
 * 1.6.1 changes consensus rules (validator admission mode, time-based jailing,
 * slash liability window, evidence budgets), so a 1.6.0 peer is rejected: two
 * nodes that share a protocol id but not a rule set cannot agree on a chain.
 */
export const MIN_CORE_VERSION = '2.0.2';

/**
 * Build identifier — deterministic hash of the release identity triple.
 * Uses the protocol's own SHA-256 implementation so this module is identical in
 * Node and in a browser bundle.
 */
export const BUILD_ID = sha256Hex(
  utf8(`obsidian-core:${CORE_VERSION}:${PROTOCOL_VERSION}:${WIRE_PROTOCOL_VERSION}`),
).slice(0, 16);

export interface VersionInfo {
  coreVersion: string;
  protocolVersion: string;
  wireProtocolVersion: number;
  minCoreVersion: string;
  buildId: string;
}

export function versionInfo(): VersionInfo {
  return {
    coreVersion: CORE_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    wireProtocolVersion: WIRE_PROTOCOL_VERSION,
    minCoreVersion: MIN_CORE_VERSION,
    buildId: BUILD_ID,
  };
}

/** Numeric comparison of dotted semantic versions. Returns -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
