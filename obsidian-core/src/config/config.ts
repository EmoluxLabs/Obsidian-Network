/**
 * Node configuration.
 *
 * IMPORTANT: this file configures *operation*, never consensus.
 *
 * Anything that changes what a node accepts or rejects — supply, mining
 * rewards, gas, service fees, oracle rules, validator rules — lives
 * in `src/protocol/params.ts` as a frozen protocol constant. An operator may
 * choose which port to listen on, whether to mine, and which peers to dial.
 * They cannot choose what a mining claim is worth, and no configuration file
 * can make a node accept a block the rest of the network rejects.
 *
 * Precedence: defaults < config file < environment (`OBSIDIAN_*`) < overrides.
 */

import { parseOriginPattern } from './trusted-origins.js';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { NETWORKS, getNetwork, type NetworkDefinition, type NetworkName } from '../protocol/networks.js';
import { CORE_VERSION } from '../version.js';

export interface NodeConfig {
  // ── Identity of the chain this node follows (must be a protocol constant) ──
  network: NetworkName;

  /** Public secp256k1 keys committed into this network's fresh genesis. */
  bootstrapValidatorPublicKeys: string[];
  /** Mining gate issuer public keys (staging/devnet/private chains; mainnet/testnet commit theirs in the source). */
  miningGatePublicKeys: string[];

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
  /**
   * Origins, besides the official domain, whose pages may read this node from a browser. Exact origins
   * (`https://wallet.example.org`) or whole-subdomain patterns (`https://*.example.org`); "*" must be set
   * deliberately. Empty by default.
   */
  rpcCorsOrigins: string[];
  /**
   * Also let pages served from obsmainnet.us.ci and its subdomains read this node (see
   * config/trusted-origins.ts). On by default; set false for a node that should answer no browser at all
   * unless `rpcCorsOrigins` names it.
   */
  rpcTrustOfficialDomains: boolean;
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

  version: string;
}

export interface LoadedConfig {
  config: NodeConfig;
  net: NetworkDefinition;
  /** Where the configuration came from (for logs and `describeConfig`). */
  source: string;
  /** Things the operator should know about (deprecated settings). Logged at start-up. */
  warnings: string[];
}

export const DEFAULT_CONFIG: NodeConfig = {
  network: 'mainnet',
  bootstrapValidatorPublicKeys: [],
  miningGatePublicKeys: [],
  nodeName: 'obsidian-node',
  dataDir: './data',
  keystorePath: './data/node-key.json',
  logLevel: 'info',
  logJson: true,
  rpcEnabled: true,
  rpcHost: '127.0.0.1',
  rpcPort: 8630,
  rpcCorsOrigins: [],
  rpcTrustOfficialDomains: true,
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
  version: CORE_VERSION,
};

/**
 * Settings that earlier documentation told operators to set and that never did
 * anything. They are still ACCEPTED (an old config file must keep loading) but
 * each one produces a warning that says what is actually true, so nobody keeps
 * believing they configured something.
 */
export const DEPRECATED_SETTINGS: Readonly<Record<string, string>> = {
  indexerEnabled: 'the explorer index is always built; this setting was never read',
  strictDataDir: 'a data directory that belongs to another chain is ALWAYS refused; this setting was never read',
  miningRewardAddress:
    'Obsidian pays no block reward, so there is no address to configure: node operators are paid through the on-chain ' +
    'node registry (a NODE_REGISTRY transaction naming a reward wallet), not through this file',
};
const DEPRECATED_ENV: Readonly<Record<string, string>> = {
  OBSIDIAN_INDEXER_ENABLED: 'indexerEnabled',
  OBSIDIAN_STRICT_DATA_DIR: 'strictDataDir',
  OBSIDIAN_MINING_REWARD_ADDRESS: 'miningRewardAddress',
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

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/**
 * Check a parsed config file: refuse unknown keys, coerce typed values, and
 * collect warnings for deprecated ones.
 *
 * Unknown keys are an ERROR, not something to skip: a typo such as
 * `"rpcAlowSubmit": false` used to be accepted and ignored, leaving transaction
 * submission enabled on a node whose operator believed they had turned it off.
 * Values are checked against the type of the setting for the same reason: the
 * JSON string "false" is truthy, so `"miningEnabled": "false"` kept mining on.
 */
export function checkConfigObject(parsed: Record<string, unknown>, label: string): { patch: Partial<NodeConfig>; warnings: string[] } {
  const known = Object.keys(DEFAULT_CONFIG).filter((key) => key !== 'version');
  const patch: Record<string, unknown> = {};
  const warnings: string[] = [];
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (key in DEPRECATED_SETTINGS) {
      warnings.push(`${label}: "${key}" has no effect — ${DEPRECATED_SETTINGS[key]}`);
      continue;
    }
    if (!known.includes(key)) {
      const nearest = known.map((candidate) => ({ candidate, d: distance(key.toLowerCase(), candidate.toLowerCase()) })).sort((a, b) => a.d - b.d)[0];
      unknown.push(nearest && nearest.d <= 3 ? `"${key}" (did you mean "${nearest.candidate}"?)` : `"${key}"`);
      continue;
    }
    const fallback = (DEFAULT_CONFIG as unknown as Record<string, unknown>)[key];
    const where = `${label}: "${key}"`;
    if (typeof fallback === 'boolean') {
      if (typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
        throw new Error(`${where} must be true or false, received ${JSON.stringify(value)}`);
      }
      patch[key] = asBoolean(value, fallback);
    } else if (typeof fallback === 'number') {
      if (typeof value === 'boolean' || value === null || value === '' || !Number.isFinite(Number(value))) {
        throw new Error(`${where} must be a number, received ${JSON.stringify(value)}`);
      }
      patch[key] = Number(value);
    } else if (Array.isArray(fallback)) {
      if (!Array.isArray(value) && typeof value !== 'string') {
        throw new Error(`${where} must be a list of strings, received ${JSON.stringify(value)}`);
      }
      patch[key] = asList(value, []);
    } else {
      if (typeof value !== 'string') throw new Error(`${where} must be a string, received ${JSON.stringify(value)}`);
      patch[key] = value;
    }
  }
  if (unknown.length > 0) {
    throw new Error(`${label} has settings this node does not recognise: ${unknown.join(', ')}. A misspelt setting is refused rather than silently ignored.`);
  }
  return { patch: patch as Partial<NodeConfig>, warnings };
}

/** Read a JSON config file. */
export function readConfigFile(path: string): Partial<NodeConfig> {
  return readConfigFileChecked(path).patch;
}

export function readConfigFileChecked(path: string): { patch: Partial<NodeConfig>; warnings: string[] } {
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
  return checkConfigObject(parsed as Record<string, unknown>, `config file ${absolute}`);
}

function merge(base: NodeConfig, patch: Partial<NodeConfig>): NodeConfig {
  return { ...base, ...patch, version: CORE_VERSION };
}

/**
 * Short names the shipped examples, compose file and docs have always used.
 * The node did not read them, so `OBSIDIAN_MINE=false` still mined and
 * `OBSIDIAN_SEEDS=…` left a node with no seeds. They are accepted as aliases;
 * the canonical name wins when both are set.
 */
export const ENV_ALIASES: Readonly<Record<string, string>> = {
  OBSIDIAN_SEED_NODES: 'OBSIDIAN_SEEDS',
  OBSIDIAN_KEYSTORE_PATH: 'OBSIDIAN_KEYSTORE',
  OBSIDIAN_MINING_ENABLED: 'OBSIDIAN_MINE',
};

/** The first of `names` that is set to something non-empty. */
function firstSet(env: NodeJS.ProcessEnv, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

/** Environment overrides: `OBSIDIAN_<SETTING>` in SCREAMING_SNAKE_CASE. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<NodeConfig> {
  const patch: Partial<NodeConfig> = {};
  const set = <K extends keyof NodeConfig>(key: K, raw: string | undefined, parse: (value: string) => NodeConfig[K]): void => {
    // An empty variable (`OBSIDIAN_NETWORK=` in a compose file) is "not set",
    // not a choice of the empty string.
    if (raw === undefined || raw === '') return;
    patch[key] = parse(raw);
  };
  set('network', env.OBSIDIAN_NETWORK, (v) => v as NetworkName);
  set('bootstrapValidatorPublicKeys', env.OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS, (v) => asList(v, []));
  set('miningGatePublicKeys', env.OBSIDIAN_MINING_GATE_PUBLIC_KEYS, (v) => asList(v, []));
  set('nodeName', env.OBSIDIAN_NODE_NAME, (v) => v);
  set('dataDir', env.OBSIDIAN_DATA_DIR, (v) => v);
  set('keystorePath', firstSet(env, 'OBSIDIAN_KEYSTORE_PATH', ENV_ALIASES.OBSIDIAN_KEYSTORE_PATH!), (v) => v);
  set('logLevel', env.OBSIDIAN_LOG_LEVEL, (v) => v as NodeConfig['logLevel']);
  set('logJson', env.OBSIDIAN_LOG_JSON, (v) => asBoolean(v, true));
  set('rpcEnabled', env.OBSIDIAN_RPC_ENABLED, (v) => asBoolean(v, true));
  set('rpcHost', env.OBSIDIAN_RPC_HOST, (v) => v);
  set('rpcPort', env.OBSIDIAN_RPC_PORT, (v) => asNumber(v, DEFAULT_CONFIG.rpcPort, 'OBSIDIAN_RPC_PORT'));
  set('rpcCorsOrigins', env.OBSIDIAN_RPC_CORS_ORIGINS, (v) => asList(v, []));
  set('rpcTrustOfficialDomains', env.OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS, (v) => asBoolean(v, true));
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
  set('seedNodes', firstSet(env, 'OBSIDIAN_SEED_NODES', ENV_ALIASES.OBSIDIAN_SEED_NODES!), (v) => asList(v, []));
  set('maxPeers', env.OBSIDIAN_MAX_PEERS, (v) => asNumber(v, DEFAULT_CONFIG.maxPeers, 'OBSIDIAN_MAX_PEERS'));
  set('maxInboundPeers', env.OBSIDIAN_MAX_INBOUND_PEERS, (v) => asNumber(v, DEFAULT_CONFIG.maxInboundPeers, 'OBSIDIAN_MAX_INBOUND_PEERS'));
  set('miningEnabled', firstSet(env, 'OBSIDIAN_MINING_ENABLED', ENV_ALIASES.OBSIDIAN_MINING_ENABLED!), (v) => asBoolean(v, true));
  set('blockProductionIntervalSeconds', env.OBSIDIAN_BLOCK_INTERVAL_SECONDS, (v) =>
    asNumber(v, DEFAULT_CONFIG.blockProductionIntervalSeconds, 'OBSIDIAN_BLOCK_INTERVAL_SECONDS'),
  );
  return patch;
}

export interface LoadConfigOptions {
  configPath?: string;
  overrides?: Partial<NodeConfig>;
  env?: NodeJS.ProcessEnv;
  /**
   * Refuse to continue unless the network was chosen explicitly (a flag, the
   * environment, or a `network` key in the config file). `start` sets this:
   * with no choice the loader used to fall back to MAINNET, so forgetting
   * `--network devnet` — or ending a command with a bare `--network` — started
   * a real-value node.
   */
  requireExplicitNetwork?: boolean;
}

/** Precedence: defaults < config file < environment < explicit overrides. */
export function loadConfig(pathOrOptions: string | LoadConfigOptions = {}): LoadedConfig {
  const options: LoadConfigOptions = typeof pathOrOptions === 'string' ? { configPath: pathOrOptions } : pathOrOptions;
  let config: NodeConfig = { ...DEFAULT_CONFIG };
  let source = 'defaults';
  const warnings: string[] = [];
  const provided = new Set<keyof NodeConfig>();
  // Where the network was named. If two places name DIFFERENT networks the
  // precedence rules would quietly pick one (the environment beats the file, a
  // flag beats the environment) — so a stale OBSIDIAN_NETWORK=mainnet in a shell
  // or an env file could turn `--config devnet.json` into a MAINNET node. Chain
  // identity is not a tunable: a disagreement is an error, not a precedence rule.
  const networkNamedBy: Array<{ where: string; network: string }> = [];
  const note = (patch: Partial<NodeConfig>, where = ''): void => {
    for (const key of Object.keys(patch)) provided.add(key as keyof NodeConfig);
    if (patch.network && where) networkNamedBy.push({ where, network: String(patch.network) });
  };
  if (options.configPath) {
    const checked = readConfigFileChecked(options.configPath);
    const patch = checked.patch;
    warnings.push(...checked.warnings);
    note(patch, `the config file ${resolve(options.configPath)}`);
    config = merge(config, patch);
    source = resolve(options.configPath);
  }
  const environment = options.env ?? process.env;
  for (const [variable, setting] of Object.entries(DEPRECATED_ENV)) {
    if (environment[variable] !== undefined) warnings.push(`${variable} has no effect — ${DEPRECATED_SETTINGS[setting]}`);
  }
  const fromEnv = configFromEnv(environment);
  if (Object.keys(fromEnv).length > 0) {
    note(fromEnv, 'the OBSIDIAN_NETWORK environment variable');
    config = merge(config, fromEnv);
    source = `${source} + environment`;
  }
  if (options.overrides) {
    note(options.overrides, 'the --network flag');
    config = merge(config, options.overrides);
    source = `${source} + flags`;
  }
  if (new Set(networkNamedBy.map((entry) => entry.network)).size > 1) {
    throw new Error(
      `conflicting networks: ${networkNamedBy.map((entry) => `${entry.where} says ${entry.network}`).join(', but ')}. ` +
        'Refusing to guess which chain this node should follow — remove the one that is wrong ' +
        '(`env | grep OBSIDIAN_NETWORK` shows what a shell has exported).',
    );
  }
  if (options.requireExplicitNetwork && !provided.has('network')) {
    throw new Error(
      'no network selected. Say which chain this node follows: --network devnet|testnet|staging|mainnet ' +
        '(or set OBSIDIAN_NETWORK, or use a config file that names one). ' +
        'There is no default on purpose: the default used to be mainnet.',
    );
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
  return { config, net, source, warnings };
}

export function validateConfig(config: NodeConfig): NodeConfig {
  if (!(config.network in NETWORKS)) {
    throw new Error(`unknown network "${config.network}" (expected one of: ${Object.keys(NETWORKS).join(', ')})`);
  }
  if (!Number.isInteger(config.portOffset) || config.portOffset < 0 || config.portOffset > 60_000) {
    throw new Error(`invalid portOffset ${config.portOffset}`);
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
    try {
      parseOriginPattern(origin);
    } catch (error) {
      throw new Error(`invalid CORS origin "${origin}": ${(error as Error).message.replace(/^invalid origin "[^"]*": /, '')}`);
    }
  }
  for (const seed of config.seedNodes) {
    if (!/^\[?[a-z0-9.:\-[\]]+\]?:\d{1,5}$/i.test(seed)) throw new Error(`invalid seed node "${seed}" (expected host:port)`);
  }
  if (!['trace', 'debug', 'info', 'warn', 'error'].includes(config.logLevel)) {
    throw new Error(`invalid logLevel "${config.logLevel}" (expected trace, debug, info, warn or error)`);
  }
  if (!Number.isFinite(config.rpcRateLimitPerMinute) || config.rpcRateLimitPerMinute < 0) {
    throw new Error(`invalid rpcRateLimitPerMinute ${config.rpcRateLimitPerMinute} (0 disables the limit)`);
  }
  for (const [label, host] of [['rpcHost', config.rpcHost], ['p2pHost', config.p2pHost]] as const) {
    if (typeof host !== 'string' || host.trim() === '') throw new Error(`${label} must not be empty`);
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
    version: config.version,
  };
}
