/**
 * Interface configuration.
 *
 * Deployment reality for a self-hosted window onto the chain: the operator must
 * be able to say *which* nodes to read and *where* to listen without editing
 * code. Environment variables win over defaults, command-line flags win over
 * environment variables, and an invalid value is a hard startup failure — a
 * half-configured interface that silently reads the wrong chain is worse than
 * one that refuses to boot.
 */

import { parseOriginPattern } from './trusted-origins.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_INTERFACE_CONFIG, type InterfaceConfig } from './index.js';
import { interfaceNetwork, type NetworkName } from './networks.js';

export interface LoadedInterfaceConfig {
  config: InterfaceConfig;
  source: string;
}

const FLAGS_WITH_VALUES = new Set([
  '--network',
  '--host',
  '--port',
  '--nodes',
  '--data-dir',
  '--site-root',
  '--public-dir',
  '--core-dir',
  '--allow-origin',
  '--max-invites',
  '--genesis-invite-hash',
  '--log-level',
]);

export function parseInterfaceArgs(argv: string[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--trust-proxy') {
      out.trustProxy = 'true';
      continue;
    }
    if (arg === '--no-trust-official-domains') {
      out.noTrustOfficialDomains = 'true';
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      out.help = 'true';
      continue;
    }
    if (!arg.startsWith('--')) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    if (!FLAGS_WITH_VALUES.has(arg)) {
      throw new Error(`unknown flag: ${arg}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`flag ${arg} needs a value`);
    }
    i += 1;
    const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    if (key === 'nodes' || key === 'allowOrigin') {
      const list = Array.isArray(out[key]) ? (out[key] as string[]) : [];
      out[key] = [...list, ...value.split(',').map((item) => item.trim()).filter(Boolean)];
      continue;
    }
    out[key] = value;
  }
  return out;
}

export const INTERFACE_USAGE = `Obsidian Interface — serve the wallet, miner, explorer and apps on top of Obsidian Core.

Usage:
  obsidian-interface [options]

Options:
  --network <name>            REQUIRED. mainnet | testnet | staging | devnet.
                              The network this interface serves: it refuses nodes
                              that follow another, and chooses its default port
                              and node address (mainnet 8788, testnet 18788,
                              staging 28788, devnet 38788).
  --host <address>            listen address (default 127.0.0.1)
  --port <port>               listen port (default: the network's port above)
  --nodes <url[,url...]>      Obsidian Core RPC endpoints to read from
                              (default: the network's local node)
  --data-dir <dir>            where interface accounts and invites are stored
  --site-root <dir>           repo root that holds the site directories
  --public-dir <dir>          built web assets (css/js/assets)
  --core-dir <dir>            compiled browser-safe core modules
  --allow-origin <origin>     extra origin allowed to call the API with cookies (repeatable): an exact
                              origin, or a whole-subdomain pattern like https://*.example.org
  --no-trust-official-domains do not let pages on obsmainnet.us.ci read this interface
  --max-invites <n>           invites per account (protocol default 5)
  --genesis-invite-hash <h>   scrypt hash of the single Genesis Invitation that
                              bootstraps the first account. Never the plaintext
                              code. Generate with:
                                node scripts/new-genesis-invite.mjs
  --trust-proxy               honour X-Forwarded-For/X-Forwarded-Proto
  --log-level <level>         debug | info | warn | error
  -h, --help                  show this help

Environment:
  OBSIDIAN_INTERFACE_NETWORK (or OBSIDIAN_NETWORK),
  OBSIDIAN_INTERFACE_HOST, OBSIDIAN_INTERFACE_PORT, OBSIDIAN_NODE_URLS,
  OBSIDIAN_INTERFACE_DATA_DIR, OBSIDIAN_INTERFACE_SITE_ROOT,
  OBSIDIAN_INTERFACE_PUBLIC_DIR, OBSIDIAN_INTERFACE_CORE_DIR,
  OBSIDIAN_INTERFACE_ALLOWED_ORIGINS, OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS,
  OBSIDIAN_INTERFACE_MAX_INVITES, OBSIDIAN_INTERFACE_TRUST_PROXY,
  OBSIDIAN_INTERFACE_LOG_LEVEL
`;

/**
 * Where the site directories live, when the operator does not say.
 *
 * Running from a checkout, the interface sits in `obsidian-interface/` and the
 * shells are in the repository root (`..`). Running from the self-contained
 * self-host release, the shells are copied *into* the package next to the
 * server (`cwd`). Guessing wrong here means the interface refuses to start, so
 * look for the shells in both places, in that order, instead of assuming.
 */
export function defaultSiteRoot(cwd: string): string {
  const parent = resolve(cwd, '..');
  if (existsSync(resolve(parent, 'landing', 'index.html'))) return parent;
  if (existsSync(resolve(cwd, 'landing', 'index.html'))) return cwd;
  return parent;
}

export function loadInterfaceConfig(argv: string[] = process.argv.slice(2), env = process.env): LoadedInterfaceConfig {
  const flags = parseInterfaceArgs(argv);
  const cwd = process.cwd();

  // The network is chosen, never assumed. With it set the port, the default
  // node address and the node filter all follow; without it an interface would
  // serve whatever chain its nodes happen to report.
  //
  // If the flag, OBSIDIAN_INTERFACE_NETWORK and OBSIDIAN_NETWORK name different
  // networks, refuse rather than let one quietly win: a settings file that says
  // mainnet under a unit that says testnet is a mistake someone should see, and
  // the node does the same.
  const namedBy = (
    [
      ['--network', flags.network],
      ['OBSIDIAN_INTERFACE_NETWORK', env.OBSIDIAN_INTERFACE_NETWORK],
      ['OBSIDIAN_NETWORK', env.OBSIDIAN_NETWORK],
    ] as Array<[string, unknown]>
  )
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([where, value]) => ({ where, network: String(value).trim() }));
  if (new Set(namedBy.map((entry) => entry.network)).size > 1) {
    throw new Error(
      `conflicting networks: ${namedBy.map((entry) => `${entry.where} says ${entry.network}`).join(', but ')}. ` +
        'Refusing to guess which chain this interface should serve — remove the one that is wrong ' +
        '(`env | grep OBSIDIAN_` shows what a shell has exported).',
    );
  }
  const networkName = namedBy[0]?.network;
  const network = networkName ? interfaceNetwork(networkName) : undefined;

  const envNodes = (env.OBSIDIAN_NODE_URLS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const flagNodes = (flags.nodes as string[] | undefined) ?? [];
  const defaultNodes = network ? [`http://127.0.0.1:${network.nodeRpcPort}`] : DEFAULT_INTERFACE_CONFIG.nodeUrls;
  const nodeUrls = flagNodes.length > 0 ? flagNodes : envNodes.length > 0 ? envNodes : defaultNodes;

  const allowedOrigins = [
    ...(env.OBSIDIAN_INTERFACE_ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).filter(Boolean),
    ...((flags.allowOrigin as string[] | undefined) ?? []),
  ];
  // A list that decides who may call the API with cookies must not quietly ignore a typo.
  for (const origin of allowedOrigins) {
    try {
      parseOriginPattern(origin);
    } catch (error) {
      throw new Error(`OBSIDIAN_INTERFACE_ALLOWED_ORIGINS / --allow-origin: ${(error as Error).message}`);
    }
  }
  const trustOfficialDomains =
    flags.noTrustOfficialDomains === 'true'
      ? false
      : !['false', '0', 'no', 'off'].includes((env.OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS ?? 'true').trim().toLowerCase());

  const defaultPort = network?.interfacePort ?? DEFAULT_INTERFACE_CONFIG.port;
  const port = Number(flags.port ?? env.OBSIDIAN_INTERFACE_PORT ?? defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`invalid port: ${flags.port ?? env.OBSIDIAN_INTERFACE_PORT}`);
  }

  const maxInvites = Number(flags.maxInvites ?? env.OBSIDIAN_INTERFACE_MAX_INVITES ?? DEFAULT_INTERFACE_CONFIG.maxInvitesPerAccount);
  if (!Number.isInteger(maxInvites) || maxInvites < 0) {
    throw new Error(`invalid --max-invites: ${flags.maxInvites ?? env.OBSIDIAN_INTERFACE_MAX_INVITES}`);
  }

  const logLevel = String(flags.logLevel ?? env.OBSIDIAN_INTERFACE_LOG_LEVEL ?? DEFAULT_INTERFACE_CONFIG.logLevel);
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`invalid --log-level: ${logLevel}`);
  }

  const siteRoot = resolve(String(flags.siteRoot ?? env.OBSIDIAN_INTERFACE_SITE_ROOT ?? defaultSiteRoot(cwd)));
  const config: InterfaceConfig = {
    ...DEFAULT_INTERFACE_CONFIG,
    network: network?.name as NetworkName | undefined,
    host: String(flags.host ?? env.OBSIDIAN_INTERFACE_HOST ?? DEFAULT_INTERFACE_CONFIG.host),
    port,
    siteRoot,
    publicDir: resolve(String(flags.publicDir ?? env.OBSIDIAN_INTERFACE_PUBLIC_DIR ?? resolve(cwd, 'public'))),
    coreDir: resolve(String(flags.coreDir ?? env.OBSIDIAN_INTERFACE_CORE_DIR ?? resolve(cwd, 'web', 'core'))),
    dataDir: resolve(String(flags.dataDir ?? env.OBSIDIAN_INTERFACE_DATA_DIR ?? resolve(cwd, '.data'))),
    nodeUrls: nodeUrls.map((url) => url.replace(/\/+$/, '')),
    allowedOrigins,
    trustOfficialDomains,
    maxInvitesPerAccount: maxInvites,
    // The HASH only. The plaintext Genesis Invitation never enters the process.
    genesisInviteHash: (flags.genesisInviteHash ?? env.OBSIDIAN_GENESIS_INVITE_HASH) as string | undefined,
    trustProxy: flags.trustProxy === 'true' || env.OBSIDIAN_INTERFACE_TRUST_PROXY === 'true',
    logLevel: logLevel as InterfaceConfig['logLevel'],
  };

  const source = flagNodes.length > 0 || Object.keys(flags).length > 0 ? 'flags' : envNodes.length > 0 ? 'environment' : 'defaults';
  return { config, source };
}

/** Fail fast if the deployment points at directories that do not exist. */
export function validateInterfaceConfig(loaded: LoadedInterfaceConfig): string[] {
  const problems: string[] = [];
  const { config } = loaded;
  if (!existsSync(config.publicDir)) problems.push(`public directory missing: ${config.publicDir} (run npm run build)`);
  if (!existsSync(config.coreDir)) problems.push(`browser core directory missing: ${config.coreDir} (run npm run build)`);
  if (!existsSync(resolve(config.siteRoot, 'landing', 'index.html'))) {
    problems.push(`site shells missing under ${config.siteRoot} (run npm run build)`);
  }
  if (config.nodeUrls.length === 0) problems.push('no Obsidian Core nodes configured (--nodes or OBSIDIAN_NODE_URLS)');
  if (!config.network) {
    problems.push(
      'no network selected. Say which chain this interface serves: --network devnet|testnet|staging|mainnet ' +
        '(or set OBSIDIAN_INTERFACE_NETWORK). There is no default: an interface that is not told which network it ' +
        'serves will show whatever chain its nodes report.',
    );
  }
  return problems;
}

/** Tiny .env reader so operators can keep configuration next to the deployment. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function describeInterfaceConfig(loaded: LoadedInterfaceConfig): Record<string, unknown> {
  const { config, source } = loaded;
  return {
    source,
    network: config.network ?? null,
    host: config.host,
    port: config.port,
    nodes: config.nodeUrls,
    dataDir: config.dataDir,
    siteRoot: config.siteRoot,
    publicDir: config.publicDir,
    coreDir: config.coreDir,
    authMethod: 'gmail+password+invite+mfa',
    allowedOrigins: config.allowedOrigins,
    trustOfficialDomains: config.trustOfficialDomains,
    maxInvitesPerAccount: config.maxInvitesPerAccount,
    // Presence only: never log the hash, and certainly never the code.
    genesisInvite: config.genesisInviteHash ? 'configured' : 'not configured',
    trustProxy: config.trustProxy,
    logLevel: config.logLevel,
  };
}
