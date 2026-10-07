/**
 * Network identification.
 *
 * Chain ID, network ID, address HRP, p2p magic and default ports are protocol
 * constants. A node refuses to peer with, or accept transactions from, any
 * object carrying a different chain ID: this is the primary defence against
 * accidentally mixing testnet/staging/devnet data with mainnet.
 *
 * Genesis identifiers are computed from the genesis document (see genesis/), so
 * two independently configured nodes that build the same genesis document
 * always derive the same genesis hash and will synchronise with each other.
 */

import { sha256Hex, utf8 } from '../crypto/hash.js';

export type NetworkName = 'mainnet' | 'testnet' | 'staging' | 'devnet';

export interface NetworkDefinition {
  name: NetworkName;
  networkId: string;
  chainId: number;
  /** bech32 human-readable part for addresses on this network. */
  addressHrp: string;
  /** 4-byte p2p handshake magic, ASCII. */
  p2pMagic: string;
  defaultRpcPort: number;
  defaultP2pPort: number;
  /** Human-facing label rendered by the interface. */
  displayName: string;
  /** Whether this network's OBS has monetary intent. */
  isProduction: boolean;
}

export const NETWORKS: Record<NetworkName, NetworkDefinition> = {
  mainnet: {
    name: 'mainnet',
    networkId: 'obsidian-mainnet-1',
    chainId: 7777,
    addressHrp: 'obs',
    p2pMagic: 'OBSM',
    defaultRpcPort: 8630,
    defaultP2pPort: 8631,
    displayName: 'OBS Mainnet',
    isProduction: true,
  },
  testnet: {
    name: 'testnet',
    networkId: 'obsidian-testnet-1',
    chainId: 7778,
    addressHrp: 'tobs',
    p2pMagic: 'OBST',
    defaultRpcPort: 18630,
    defaultP2pPort: 18631,
    displayName: 'OBS Testnet',
    isProduction: false,
  },
  staging: {
    name: 'staging',
    networkId: 'obsidian-staging-1',
    chainId: 7779,
    addressHrp: 'sobs',
    p2pMagic: 'OBSS',
    defaultRpcPort: 28630,
    defaultP2pPort: 28631,
    displayName: 'OBS Staging',
    isProduction: false,
  },
  devnet: {
    name: 'devnet',
    networkId: 'obsidian-devnet-1',
    chainId: 7780,
    addressHrp: 'dobs',
    p2pMagic: 'OBSD',
    defaultRpcPort: 38630,
    defaultP2pPort: 38631,
    displayName: 'OBS Devnet',
    isProduction: false,
  },
};

export function getNetwork(name: string): NetworkDefinition {
  const net = NETWORKS[name as NetworkName];
  if (!net) {
    throw new Error(
      `unknown network "${name}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`,
    );
  }
  return net;
}

/**
 * Hard guard: a development/test process must never silently attach to mainnet.
 * Call this at startup with the resolved network and the process environment.
 */
export function assertNetworkSafety(net: NetworkDefinition): void {
  const allowMainnet = process.env.OBSIDIAN_ALLOW_MAINNET === 'true';
  const nodeEnv = process.env.NODE_ENV ?? 'production';
  if (net.name === 'mainnet' && !net.isProduction) {
    throw new Error('network definition inconsistency: mainnet must be production');
  }
  if (net.name !== 'mainnet') return;
  if (nodeEnv === 'development' && !allowMainnet) {
    throw new Error(
      'refusing to start mainnet in NODE_ENV=development. ' +
        'Use config/testnet.json or set OBSIDIAN_ALLOW_MAINNET=true deliberately.',
    );
  }
}

/** Deterministic network fingerprint, printed by the health endpoint. */
export function networkFingerprint(net: NetworkDefinition, genesisId: string): string {
  return sha256Hex(utf8(`${net.networkId}|${net.chainId}|${genesisId}`)).slice(0, 32);
}
