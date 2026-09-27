/**
 * Node configuration.
 *
 * IMPORTANT: this file configures *operation*, never consensus.
 *
 * Anything that changes what a node accepts or rejects — supply, mining
 * rewards, gas, USD fees, oracle rules, validator rules, land pricing — lives
 * in `src/protocol/params.ts` as a frozen protocol constant. An operator may
 * choose which port to listen on, whether to mine, and which peers to dial.
 * They cannot choose what a mining claim is worth, and no configuration file
 * can make a node accept a block the rest of the network rejects.
 *
 * Precedence: defaults < config file < environment (`OBSIDIAN_*`) < overrides.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NETWORKS, getNetwork, type NetworkDefinition, type NetworkName } from '../protocol/networks.js';
import { CORE_VERSION } from '../version.js';

export interface NodeConfig {
  // ── Identity of the chain this node follows (must be a protocol constant) ──
  network: NetworkName;

  // ── Local operation ───────────────────────────────────────────────────────
  nodeName: string;
  dataDir: string;
  keystorePath: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  logJson: boolean;

  // ── RPC / API ─────────────────────────────────────────────────────────────
  rpcEnabled: boolean;
  rpcHost: string;
  rpcPort: number;
  /** Explicit CORS allowlist. Empty by default; "*" must be set deliberately. */
  rpcCorsOrigins: string[];
  /** 0 disables rate limiting (only sensible on a private interface). */
  rpcRateLimitPerMinute: number;
  /** Allow POST /tx/submit on this node. Read-only nodes set this to false. */
  rpcAllowSubmit: boolean;
  /** Public URL of this node's RPC, announced to peers and the interface. */
  rpcPublicUrl: string;
  /** Trust X-Forwarded-For for rate limiting (only behind a reverse proxy). */
  rpcTrustProxy: boolean;
  /**
   * Added to the network's default ports. Lets an operator run several nodes on
   * one host (`--port-offset 1` → 8632/8633 on mainnet) without hand-writing
   * every port, and keeps the two ports of a node adjacent.
   */
  portOffset: number;

  // ── Peer-to-peer ──────────────────────────────────────────────────────────
  p2pEnabled: boolean;
  p2pHost: string;
  p2pPort: number;
  /** Public address peers should dial (empty = auto). */
  publicHost: string;
  /** Bootstrap peers (`host:port`). */
  seedNodes: string[];
  maxPeers: number;
  maxInboundPeers: number;

  // ── Mining / block production ─────────────────────────────────────────────
  miningEnabled: boolean;
  /** How often this node checks whether it is scheduled to propose a block. */
  blockProductionIntervalSeconds: number;
  /** Address that receives this node's mining rewards (empty = node identity). */
  miningRewardAddress: string;

  // ── Derived data ──────────────────────────────────────────────────────────
  indexerEnabled: boolean;
  /** Refuse to start when the data directory belongs to another chain. */
  strictDataDir: boolean;

  version: string;
}

export interface LoadedConfig {
  config: NodeConfig;
  net: NetworkDefinition;
  /** Where the configuration came from (for logs and `describeConfig`). */
  source: string;
}

export const DEFAULT_CONFIG: NodeConfig = {
  network: 'mainnet',
  nodeName: 'obsidian-node',
  dataDir: './data',
  keystorePath: './data/node-key.json',
  logLevel: 'info',
  logJson: true,
  rpcEnabled: true,
  rpcHost: '127.0.0.1',
  rpcPort: 8630,
  rpcCorsOrigins: [],
  rpcRateLimitPerMinute: 240,
  rpcAllowSubmit: true,
  rpcPublicUrl: '',
  rpcTrustProxy: false,
  portOffset: 0,
  p2pEnabled: true,
  p2pHost: '0.0.0.0',
  p2pPort: 8631,
  publicHost: '',
  seedNodes: [],
  maxPeers: 16,
  maxInboundPeers: 64,
  miningEnabled: true,
  blockProductionIntervalSeconds: 5,
  miningRewardAddress: '',
  indexerEnabled: true,
  strictDataDir: true,
  version: CORE_VERSION,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new Error(`invalid boolean value "${value}"`);
}

function asNumber(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a number, received "${value}"`);
  return parsed;
}

function asList(value: unknown, fallback: string[]): string[] {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Read a JSON config file. */
export function readConfigFile(path: string): Partial<NodeConfig> {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`config file not found: ${absolute}`);
  const raw = readFileSync(absolute, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`config file ${absolute} is not valid JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`config file ${absolute} must contain a JSON object`);
  }
  return parsed as Partial<NodeConfig>;
}

function merge(base: NodeConfig, patch: Partial<NodeConfig>): NodeConfig {
  return { ...base, ...patch, version: CORE_VERSION };
}

/** Environment overrides: `OBSIDIAN_<SETTING>` in SCREAMING_SNAKE_CASE. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<NodeConfig> {
  const patch: Partial<NodeConfig> = {};
  const set = <K extends keyof NodeConfig>(key: K, raw: string | undefined, parse: (value: string) => NodeConfig[K]): void => {
    if (raw === undefined) return;
    patch[key] = parse(raw);
  };
  set('network', env.OBSIDIAN_NETWORK, (v) => v as NetworkName);
  set('nodeName', env.OBSIDIAN_NODE_NAME, (v) => v);
  set('dataDir', env.OBSIDIAN_DATA_DIR, (v) => v);
  set('keystorePath', env.OBSIDIAN_KEYSTORE_PATH, (v) => v);
  set('logLevel', env.OBSIDIAN_LOG_LEVEL, (v) => v as NodeConfig['logLevel']);
  set('logJson', env.OBSIDIAN_LOG_JSON, (v) => asBoolean(v, true));
  set('rpcEnabled', env.OBSIDIAN_RPC_ENABLED, (v) => asBoolean(v, true));
  set('rpcHost', env.OBSIDIAN_RPC_HOST, (v) => v);
  set('rpcPort', env.OBSIDIAN_RPC_PORT, (v) => asNumber(v, DEFAULT_CONFIG.rpcPort, 'OBSIDIAN_RPC_PORT'));
  set('rpcCorsOrigins', env.OBSIDIAN_RPC_CORS_ORIGINS, (v) => asList(v, []));
  set('rpcRateLimitPerMinute', env.OBSIDIAN_RPC_RATE_LIMIT_PER_MINUTE, (v) =>
    asNumber(v, DEFAULT_CONFIG.rpcRateLimitPerMinute, 'OBSIDIAN_RPC_RATE_LIMIT_PER_MINUTE'),
  );
  set('rpcAllowSubmit', env.OBSIDIAN_RPC_ALLOW_SUBMIT, (v) => asBoolean(v, true));
  set('rpcPublicUrl', env.OBSIDIAN_RPC_PUBLIC_URL, (v) => v);
  set('rpcTrustProxy', env.OBSIDIAN_RPC_TRUST_PROXY, (v) => asBoolean(v, false));
  set('portOffset', env.OBSIDIAN_PORT_OFFSET, (v) => asNumber(v, 0, 'OBSIDIAN_PORT_OFFSET'));
  set('p2pEnabled', env.OBSIDIAN_P2P_ENABLED, (v) => asBoolean(v, true));
  set('p2pHost', env.OBSIDIAN_P2P_HOST, (v) => v);
  set('p2pPort', env.OBSIDIAN_P2P_PORT, (v) => asNumber(v, DEFAULT_CONFIG.p2pPort, 'OBSIDIAN_P2P_PORT'));
  set('publicHost', env.OBSIDIAN_PUBLIC_HOST, (v) => v);
  set('seedNodes', env.OBSIDIAN_SEED_NODES, (v) => asList(v, []));
  set('maxPeers', env.OBSIDIAN_MAX_PEERS, (v) => asNumber(v, DEFAULT_CONFIG.maxPeers, 'OBSIDIAN_MAX_PEERS'));
  set('maxInboundPeers', env.OBSIDIAN_MAX_INBOUND_PEERS, (v) => asNumber(v, DEFAULT_CONFIG.maxInboundPeers, 'OBSIDIAN_MAX_INBOUND_PEERS'));
  set('miningEnabled', env.OBSIDIAN_MINING_ENABLED, (v) => asBoolean(v, true));
  set('blockProductionIntervalSeconds', env.OBSIDIAN_BLOCK_INTERVAL_SECONDS, (v) =>
    asNumber(v, DEFAULT_CONFIG.blockProductionIntervalSeconds, 'OBSIDIAN_BLOCK_INTERVAL_SECONDS'),
  );
  set('miningRewardAddress', env.OBSIDIAN_MINING_REWARD_ADDRESS, (v) => v);
  set('indexerEnabled', env.OBSIDIAN_INDEXER_ENABLED, (v) => asBoolean(v, true));
  set('strictDataDir', env.OBSIDIAN_STRICT_DATA_DIR, (v) => asBoolean(v, true));
  return patch;
}

export interface LoadConfigOptions {
  configPath?: string;
  overrides?: Partial<NodeConfig>;
  env?: NodeJS.ProcessEnv;
}

/** Precedence: defaults < config file < environment < explicit overrides. */
export function loadConfig(pathOrOptions: string | LoadConfigOptions = {}): LoadedConfig {
  const options: LoadConfigOptions = typeof pathOrOptions === 'string' ? { configPath: pathOrOptions } : pathOrOptions;
  let config = DEFAULT_CONFIG;
  let source = 'defaults';
  const provided = new Set<keyof NodeConfig>();
  const note = (patch: Partial<NodeConfig>): void => {
    for (const key of Object.keys(patch)) provided.add(key as keyof NodeConfig);
  };
  if (options.configPath) {
    const patch = readConfigFile(options.configPath);
    note(patch);
    config = merge(config, patch);
    source = resolve(options.configPath);
  }
  const fromEnv = configFromEnv(options.env ?? process.env);
  if (Object.keys(fromEnv).length > 0) {
    note(fromEnv);
    config = merge(config, fromEnv);
    source = `${source} + environment`;
  }
  if (options.overrides) {
    note(options.overrides);
    config = merge(config, options.overrides);
    source = `${source} + flags`;
  }
  // Derived defaults: applied only where the operator said nothing at all, so a
  // network switch is enough to get the right ports and a data directory that
  // can never be shared between chains.
  const net = getNetwork(config.network);
  if (!provided.has('rpcPort')) config.rpcPort = net.defaultRpcPort + config.portOffset;
  if (!provided.has('p2pPort')) config.p2pPort = net.defaultP2pPort + config.portOffset;
  if (!provided.has('dataDir')) config.dataDir = join('./data', net.name);
  if (!provided.has('keystorePath')) config.keystorePath = join(resolve(config.dataDir), 'node-key.json');
  config = validateConfig(config);
  return { config, net, source };
}

export function validateConfig(config: NodeConfig): NodeConfig {
  if (!(config.network in NETWORKS)) {
    throw new Error(`unknown network "${config.network}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`);
  }
  for (const [label, port] of [
    ['rpc', config.rpcPort],
    ['p2p', config.p2pPort],
  ] as const) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid ${label} port ${port}`);
  }
  if (config.rpcPort === config.p2pPort && config.rpcHost === config.p2pHost) {
    throw new Error('rpc and p2p cannot share the same host and port');
  }
  if (!Number.isInteger(config.maxPeers) || config.maxPeers < 1 || config.maxPeers > 1_000) {
    throw new Error(`invalid maxPeers ${config.maxPeers}`);
  }
  if (!Number.isInteger(config.maxInboundPeers) || config.maxInboundPeers < 0 || config.maxInboundPeers > 10_000) {
    throw new Error(`invalid maxInboundPeers ${config.maxInboundPeers}`);
  }
  if (!Number.isInteger(config.blockProductionIntervalSeconds) || config.blockProductionIntervalSeconds < 1) {
    throw new Error(`invalid blockProductionIntervalSeconds ${config.blockProductionIntervalSeconds}`);
  }
  for (const origin of config.rpcCorsOrigins) {
    if (origin === '*') continue;
    if (!/^https?:\/\/[a-z0-9.:\-[\]]+$/i.test(origin)) throw new Error(`invalid CORS origin "${origin}"`);
  }
  for (const seed of config.seedNodes) {
    if (!/^\[?[a-z0-9.:\-[\]]+\]?:\d{1,5}$/i.test(seed)) throw new Error(`invalid seed node "${seed}" (expected host:port)`);
  }
  if (config.miningRewardAddress && !/^(obs|tobs|sobs|dobs)1[0-9a-z]{20,}$/.test(config.miningRewardAddress)) {
    throw new Error(`invalid mining reward address "${config.miningRewardAddress}"`);
  }
  return config;
}

export function networkFor(config: NodeConfig): NetworkDefinition {
  return getNetwork(config.network);
}

export function describeConfig(config: NodeConfig): Record<string, unknown> {
  const net = networkFor(config);
  return {
    network: net.name,
    networkId: net.networkId,
    chainId: net.chainId,
    nodeName: config.nodeName,
    dataDir: config.dataDir,
    keystorePath: config.keystorePath,
    logLevel: config.logLevel,
    logJson: config.logJson,
    rpc: config.rpcEnabled ? `${config.rpcHost}:${config.rpcPort}` : 'disabled',
    rpcAllowSubmit: config.rpcAllowSubmit,
    p2p: config.p2pEnabled ? `${config.p2pHost}:${config.p2pPort}` : 'disabled',
    seeds: config.seedNodes.length,
    mining: config.miningEnabled,
    blockProductionIntervalSeconds: config.blockProductionIntervalSeconds,
    indexer: config.indexerEnabled,
    version: config.version,
  };
}
