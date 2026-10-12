/**
 * Operator diagnostics: `status`, `peers`, `sync status` and `doctor`.
 *
 * Two rules shape every line of output here:
 *   1. What is reported as CONNECTED is what a running node says it is connected to right now (the handshake-verified
 *      links), never the saved peer book. Saved peers are reported separately and labelled "known".
 *   2. A check that could not run says so. A node that cannot be reached is "unreachable", not "ok" and not "0 peers".
 *
 * Nothing here reads a private key or a passphrase value; the doctor only reports whether one is present.
 */

import { accessSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import type { LoadedConfig } from '../config/config.js';
import { NetworkIdentityError, hasChainData, manifestPath, readManifest, resolveIdentity } from '../config/network-manifest.js';
import { Keystore, keystorePassphraseFromEnv } from '../crypto/keystore.js';

/** Interface (web platform) port per network; this is the documented convention, mirrored from obsidian-interface. */
export const INTERFACE_PORTS: Record<string, number> = { mainnet: 8788, testnet: 18788, staging: 28788, devnet: 38788 };

export interface HttpReply {
  status: number;
  body: unknown;
}

/** A bounded, time-limited GET of a JSON document. Never follows redirects, never reads more than `maxBytes`. */
export async function httpGetJson(url: string, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<HttpReply> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxBytes = options.maxBytes ?? 1_000_000;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`unsupported protocol ${parsed.protocol}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(parsed, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`reply from ${parsed.host} is larger than ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error(`no answer from ${parsed.host} within ${timeoutMs} ms`);
    throw new Error(`${parsed.host}: ${(error as Error).cause ? String(((error as Error).cause as Error).message ?? error) : (error as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

export function localBaseUrl(loaded: LoadedConfig, override?: string): string {
  if (override) return override.replace(/\/+$/, '');
  const host = loaded.config.rpcHost === '0.0.0.0' || loaded.config.rpcHost === '::' ? '127.0.0.1' : loaded.config.rpcHost;
  return `http://${host.includes(':') ? `[${host}]` : host}:${loaded.config.rpcPort}`;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const asJson = (value: unknown): Json => (value && typeof value === 'object' ? (value as Json) : {});

export interface NodeSnapshot {
  base: string;
  reachable: boolean;
  error?: string;
  alive?: boolean;
  readiness?: 'ready' | 'ready-degraded' | 'not-ready';
  readyChecks?: Json;
  degraded?: string[];
  network?: string;
  networkId?: string;
  chainId?: number;
  genesisId?: string;
  coreVersion?: string;
  protocolVersion?: string;
  height?: number;
  headHash?: string;
  syncing?: boolean;
  behindBy?: number;
  finality?: { finalizedHeight: number; confirmationsAfterFinality: number; validators: number; quorum: number };
  p2p?: { listening: boolean; endpoint: string; lastError: Json | null };
  peers?: {
    connected: number;
    inbound: number;
    outbound: number;
    pendingHandshakes: number;
    known: number;
    bestPeerHeight: number;
    connectedList: Array<{ address: string; nodeId: string; height: number; inbound: boolean; version: string; behindUs: number }>;
  };
}

/** Ask a running node what it is doing. Every field comes from the node's own answers; nothing is inferred. */
export async function collectSnapshot(base: string, timeoutMs = 5000): Promise<NodeSnapshot> {
  const snapshot: NodeSnapshot = { base, reachable: false };
  let live: HttpReply;
  try {
    live = await httpGetJson(`${base}/livez`, { timeoutMs });
  } catch (error) {
    snapshot.error = (error as Error).message;
    return snapshot;
  }
  snapshot.reachable = true;
  snapshot.alive = live.status === 200;
  const [ready, health, finality, peers] = await Promise.all(
    ['/readyz', '/health', '/finality', '/peers'].map((path) => httpGetJson(`${base}${path}`, { timeoutMs }).catch(() => undefined)),
  );
  if (ready) {
    const body = asJson(ready.body);
    if (body.status === 'ready' || body.status === 'ready-degraded' || body.status === 'not-ready') snapshot.readiness = body.status;
    snapshot.readyChecks = asJson(body.checks);
    snapshot.degraded = Array.isArray(body.degraded) ? body.degraded.map(String) : [];
    snapshot.behindBy = Number(asJson(body.checks).sync?.behindBy ?? 0);
    snapshot.syncing = Boolean(asJson(body.checks).sync?.syncing);
  }
  if (health) {
    const body = asJson(health.body);
    snapshot.network = body.network;
    snapshot.networkId = body.networkId;
    snapshot.chainId = body.chainId;
    snapshot.genesisId = body.genesisId;
    snapshot.coreVersion = body.coreVersion;
    snapshot.protocolVersion = body.protocolVersion;
    snapshot.height = body.height;
    snapshot.headHash = body.headHash;
  }
  if (finality && finality.status === 200) {
    const body = asJson(finality.body);
    snapshot.finality = {
      finalizedHeight: Number(body.finalizedHeight ?? 0),
      confirmationsAfterFinality: Number(body.confirmationsAfterFinality ?? 0),
      validators: Number(body.validatorCount ?? 0),
      quorum: Number(body.quorum ?? 0),
    };
  }
  if (peers && peers.status === 200) {
    const body = asJson(peers.body);
    const p2p = asJson(body.p2p);
    const counts = asJson(p2p.peers);
    const connected = Array.isArray(body.connected) ? (body.connected as Json[]) : [];
    const myHeight = Number(snapshot.height ?? 0);
    snapshot.p2p = { listening: Boolean(p2p.listening), endpoint: String(p2p.endpoint ?? ''), lastError: p2p.lastError ?? null };
    snapshot.peers = {
      connected: connected.length,
      inbound: Number(counts.inbound ?? 0),
      outbound: Number(counts.outbound ?? 0),
      pendingHandshakes: Number(counts.pendingHandshakes ?? 0),
      known: Array.isArray(body.known) ? body.known.length : Number(counts.known ?? 0),
      bestPeerHeight: Number(counts.height ?? 0),
      connectedList: connected.map((peer) => ({
        address: String(peer.address),
        nodeId: String(peer.nodeId),
        height: Number(peer.height ?? 0),
        inbound: Boolean(peer.inbound),
        version: String(peer.version ?? ''),
        behindUs: Math.max(0, myHeight - Number(peer.height ?? 0)),
      })),
    };
  }
  return snapshot;
}

export function renderStatus(snapshot: NodeSnapshot): string {
  if (!snapshot.reachable) {
    return `node: UNREACHABLE at ${snapshot.base}\n  ${snapshot.error ?? 'no answer'}\n  (nothing is listening there, or it is not an Obsidian node; run \`doctor\` for the likely cause)\n`;
  }
  const lines = [
    `node:       ${snapshot.alive ? 'alive' : 'NOT ALIVE'} at ${snapshot.base}`,
    `readiness:  ${snapshot.readiness ?? 'unknown'}${snapshot.degraded?.length ? ` (${snapshot.degraded.join(', ')})` : ''}`,
    `network:    ${snapshot.network ?? '?'}  (${snapshot.networkId ?? '?'}, chain ${snapshot.chainId ?? '?'})`,
    `genesis id: ${snapshot.genesisId ?? '?'}`,
    `version:    core ${snapshot.coreVersion ?? '?'}, protocol ${snapshot.protocolVersion ?? '?'}`,
    `height:     ${snapshot.height ?? '?'}  ${snapshot.syncing ? `SYNCING (behind by ~${snapshot.behindBy ?? '?'})` : (snapshot.peers?.connected ?? 0) > 0 ? 'in sync with connected peers' : 'no connected peer to compare with'}`,
  ];
  if (snapshot.finality) lines.push(`finality:   height ${snapshot.finality.finalizedHeight}, ${snapshot.finality.confirmationsAfterFinality} blocks after it`);
  if (snapshot.p2p) {
    lines.push(`p2p:        ${snapshot.p2p.listening ? `listening (${snapshot.p2p.endpoint})` : 'NOT LISTENING: this node cannot accept peers'}`);
    if (snapshot.p2p.lastError) lines.push(`            last peer problem: ${String(snapshot.p2p.lastError.message ?? '')}`);
  }
  if (snapshot.peers) {
    const peers = snapshot.peers;
    lines.push(
      `peers:      ${peers.connected} connected (${peers.inbound} in, ${peers.outbound} out), ${peers.pendingHandshakes} mid-handshake; ${peers.known} known in the saved book`,
    );
    if (peers.connected === 0) lines.push('            no live peer: this node is isolated right now, whatever the saved book holds');
  }
  return `${lines.join('\n')}\n`;
}

export function renderPeers(snapshot: NodeSnapshot): string {
  if (!snapshot.reachable || !snapshot.peers) return renderStatus(snapshot);
  const peers = snapshot.peers;
  const lines = [`${peers.connected} connected peer(s) (handshake verified); ${peers.known} known in the saved book (NOT connected unless listed below)`];
  for (const peer of peers.connectedList) {
    lines.push(`  ${peer.inbound ? 'in ' : 'out'}  ${peer.address.padEnd(24)} height ${String(peer.height).padEnd(8)} ${peer.version.padEnd(8)} ${peer.nodeId.slice(0, 16)}…`);
  }
  if (peers.connected === 0) lines.push('  (none)');
  return `${lines.join('\n')}\n`;
}

export function renderSync(snapshot: NodeSnapshot): string {
  if (!snapshot.reachable || !snapshot.peers) return renderStatus(snapshot);
  const peers = snapshot.peers;
  const lines = [
    `local height:       ${snapshot.height}`,
    `best peer height:   ${peers.connected > 0 ? peers.bestPeerHeight : 'unknown (no connected peer)'}`,
    `state:              ${snapshot.syncing ? `SYNCING, behind by ~${snapshot.behindBy}` : peers.connected > 0 ? 'in sync with connected peers' : 'ALONE: nothing to sync with'}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** Exit code for a snapshot: 0 healthy, 3 warnings (works but degraded), 1 not working. */
export function snapshotExitCode(snapshot: NodeSnapshot): number {
  if (!snapshot.reachable || !snapshot.alive) return 1;
  if (snapshot.readiness === 'not-ready') return 1;
  if (snapshot.readiness === 'ready-degraded') return 3;
  return 0;
}

// ── doctor ─────────────────────────────────────────────────────────────────

export type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';
export interface Check {
  name: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
}

function portIsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

function lockOwner(dataDir: string): { pid: number; alive: boolean } | undefined {
  const file = join(dataDir, 'LOCK');
  if (!existsSync(file)) return undefined;
  const pid = Number.parseInt(readFileSync(file, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return { pid: 0, alive: false };
  try {
    process.kill(pid, 0);
    return { pid, alive: true };
  } catch (error) {
    return { pid, alive: (error as NodeJS.ErrnoException).code === 'EPERM' };
  }
}

/**
 * Every check that can run without starting anything. If a node is already running on the configured ports the port
 * checks are replaced by a question put to that node, so the doctor never reports "port in use" about itself.
 */
export async function runDoctor(
  loaded: LoadedConfig,
  options: { url?: string; env?: NodeJS.ProcessEnv; interfacePort?: number } = {},
): Promise<Check[]> {
  const env = options.env ?? process.env;
  const { config, net } = loaded;
  const checks: Check[] = [];
  const add = (name: string, level: CheckLevel, detail: string, fix?: string): void => {
    checks.push({ name, level, detail, ...(fix ? { fix } : {}) });
  };

  add('network', 'info', `${net.name} (${net.networkId}, chain ${net.chainId}); data ${config.dataDir}`);

  // Data directory.
  try {
    mkdirSync(config.dataDir, { recursive: true });
    accessSync(config.dataDir, constants.R_OK | constants.W_OK);
    add('data directory', 'ok', `${config.dataDir} is readable and writable`);
  } catch (error) {
    add('data directory', 'fail', `${config.dataDir}: ${(error as Error).message}`, 'fix the permissions, or choose another --data-dir');
  }

  // Lock.
  const owner = lockOwner(config.dataDir);
  if (!owner) add('data lock', 'ok', 'no node holds this directory');
  else if (owner.alive) add('data lock', 'info', `held by running process ${owner.pid}`);
  else add('data lock', 'warn', `a LOCK file names process ${owner.pid}, which is not running`, 'it is cleared automatically by the next start; nothing to do');

  // Identity.
  const manifest = (() => {
    try {
      return readManifest(config.dataDir);
    } catch (error) {
      add('network manifest', 'fail', (error as Error).message, `restore ${manifestPath(config.dataDir)} from backup, or remove it only if you are sure the chain data is disposable`);
      return undefined;
    }
  })();
  if (manifest) {
    try {
      const identity = resolveIdentity(loaded);
      add('network manifest', 'ok', `genesis id ${identity.derived.genesisId} matches ${manifestPath(config.dataDir)} (${manifest.origin.kind})`);
    } catch (error) {
      add('network manifest', 'fail', (error as Error).message, error instanceof NetworkIdentityError ? 'make the keys and network match the manifest, or use a different --data-dir' : undefined);
    }
  } else if (hasChainData(config.dataDir)) {
    add('network manifest', 'warn', 'chain data exists but no network.json is recorded', 'run `init` once to record this directory\'s identity (it changes no chain data)');
  } else if (!checks.some((check) => check.name === 'network manifest')) {
    add('network manifest', 'info', 'this directory is new: `init` or `start` will create the network here');
  }

  // Node identity key.
  if (!Keystore.exists(config.keystorePath)) {
    add('node key', 'info', `no keystore at ${config.keystorePath} yet; the node creates one on first start`);
  } else {
    let passphrase: string | undefined;
    try {
      passphrase = keystorePassphraseFromEnv();
    } catch {
      add('node key', 'warn', 'keystore exists but no usable passphrase (12+ characters) is set in this shell', 'set OBSIDIAN_KEYSTORE_PASSPHRASE or OBSIDIAN_KEYSTORE_PASSPHRASE_FILE (the node will refuse to start without it)');
    }
    if (passphrase) {
      try {
        Keystore.read(config.keystorePath, passphrase);
        add('node key', 'ok', 'keystore opens with the configured passphrase');
      } catch {
        add('node key', 'fail', 'the keystore did not open with the configured passphrase', 'check the passphrase; never recreate the file, that changes the node identity');
      }
    }
  }

  // Gate.
  const gateKeys = manifest?.miningGatePublicKeys ?? config.miningGatePublicKeys;
  if (gateKeys.length === 0) {
    add('mining gate', 'warn', 'no gate issuer key is part of this network: no mining claim can ever be accepted', 'only fixable by creating a NEW network with `init --generate-gate-key`');
  } else {
    add('mining gate', 'ok', `${gateKeys.length} gate issuer public key(s) are part of the genesis`);
    const keystore = env.OBSIDIAN_GATE_KEYSTORE;
    add('gate authority', 'info', keystore ? `this host is configured as an issuer (${existsSync(keystore) ? 'keystore present' : 'KEYSTORE FILE MISSING'})` : 'this host does not issue gate certificates (normal for every node but the platform host)');
  }

  // Ports / running node.
  const base = localBaseUrl(loaded, options.url);
  const snapshot = await collectSnapshot(base, 3000);
  if (snapshot.reachable) {
    add('running node', snapshot.alive ? 'ok' : 'fail', `answering at ${base}`);
    if (snapshot.network && snapshot.network !== net.name) add('running node network', 'fail', `it is on ${snapshot.network}, this command was given ${net.name}`);
    if (snapshot.readiness === 'not-ready') add('readiness', 'fail', `not ready: ${JSON.stringify(snapshot.readyChecks)}`, 'see `status` and the node log');
    else if (snapshot.readiness === 'ready-degraded') add('readiness', 'warn', `ready but degraded: ${snapshot.degraded?.join(', ')}`);
    else add('readiness', 'ok', 'ready');
    if (snapshot.p2p && !snapshot.p2p.listening) add('p2p listener', 'fail', 'the node is not listening for peers', 'another process probably owns the p2p port; see the node log, then restart');
    if (snapshot.peers) {
      if (snapshot.peers.connected === 0) add('peers', 'warn', `0 connected, ${snapshot.peers.known} saved`, 'check --seeds, outbound firewall rules and that the other node is up');
      else add('peers', 'ok', `${snapshot.peers.connected} connected`);
    }
    if (snapshot.p2p?.lastError) add('last peer problem', 'info', String(snapshot.p2p.lastError.message ?? ''));
  } else {
    add('running node', 'info', `no node is answering at ${base}`);
    if (!options.url) {
      for (const [label, port, host] of [
        ['rpc port', config.rpcPort, config.rpcHost],
        ['p2p port', config.p2pPort, config.p2pHost],
      ] as const) {
        if (label === 'p2p port' && !config.p2pEnabled) continue;
        const free = await portIsFree(host === 'localhost' ? '127.0.0.1' : host, port);
        if (free) add(label, 'ok', `${host}:${port} is free`);
        else add(label, 'fail', `${host}:${port} is already in use by another process`, `stop that process, or start with --port-offset / --${label.startsWith('rpc') ? 'rpc' : 'p2p'}-port`);
      }
    }
  }
  if (config.rpcHost !== '127.0.0.1' && config.rpcHost !== 'localhost' && config.rpcHost !== '::1') {
    add('rpc exposure', 'warn', `RPC is bound to ${config.rpcHost}, not loopback`, 'bind to 127.0.0.1 and put a reverse proxy in front for the public read-only routes');
  } else {
    add('rpc exposure', 'ok', 'RPC is bound to loopback');
  }

  // Interface.
  const interfacePort = options.interfacePort ?? Number(env.OBSIDIAN_INTERFACE_PORT ?? INTERFACE_PORTS[net.name]);
  if (Number.isInteger(interfacePort) && interfacePort > 0) {
    try {
      const reply = await httpGetJson(`http://127.0.0.1:${interfacePort}/api/ready`, { timeoutMs: 2000 });
      const body = asJson(reply.body);
      if (reply.status === 200) add('interface', 'ok', `answering on 127.0.0.1:${interfacePort}, ${body.healthyNodes} healthy node(s) behind it`);
      else if (reply.status === 503) add('interface', 'warn', `answering on 127.0.0.1:${interfacePort} but not ready: ${body.healthyNodes ?? 0} healthy node(s)${body.genesisMismatch ? ', GENESIS MISMATCH' : ''}`, 'check the interface node list (OBSIDIAN_NODE_URLS) points at this network\'s node');
      else add('interface', 'warn', `something answers on 127.0.0.1:${interfacePort} (HTTP ${reply.status}) but it is not an Obsidian interface of this version`);
    } catch {
      add('interface', env.OBSIDIAN_NODE_ONLY ? 'info' : 'warn', `nothing answers on 127.0.0.1:${interfacePort}`, env.OBSIDIAN_NODE_ONLY ? undefined : 'start the interface (the launcher does this by default), or set OBSIDIAN_NODE_ONLY=1 to run without it');
    }
  }
  return checks;
}

export function renderDoctor(checks: Check[]): string {
  const mark: Record<CheckLevel, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: 'info' };
  const lines: string[] = [];
  for (const check of checks) {
    lines.push(`[${mark[check.level]}] ${check.name}: ${check.detail}`);
    if (check.fix) lines.push(`        fix: ${check.fix}`);
  }
  const fails = checks.filter((check) => check.level === 'fail').length;
  const warns = checks.filter((check) => check.level === 'warn').length;
  lines.push('', fails > 0 ? `${fails} problem(s) need fixing.` : warns > 0 ? `No failures, ${warns} warning(s).` : 'All checks passed.');
  return `${lines.join('\n')}\n`;
}

export function doctorExitCode(checks: Check[]): number {
  if (checks.some((check) => check.level === 'fail')) return 1;
  if (checks.some((check) => check.level === 'warn')) return 3;
  return 0;
}
