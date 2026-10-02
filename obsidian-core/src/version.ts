/**
 * Obsidian Core version metadata.
 *
 * Every official release publishes: Version, Protocol Version, Build ID,
 * SHA256, Release Signature, Supported Network, Minimum Core Version.
 * See /docs/release-process.md.
 */

import { sha256Hex, utf8 } from './crypto/hash.js';

/** Software version of this Obsidian Core build. */
export const CORE_VERSION = '1.2.13';

/** Consensus protocol version implemented by this build. */
export const PROTOCOL_VERSION = '1.2.0';

/** Wire/peer protocol version. */
export const WIRE_PROTOCOL_VERSION = 1;

/**
 * Minimum Obsidian Core version permitted to peer with this build.
 * Peers below this version are rejected during handshake (hard fork guard).
 */
export const MIN_CORE_VERSION = '1.2.0';

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
