/** Diagnostics: real checks against the real node and machine, and a redacted report. */
import { existsSync, statfsSync, accessSync, constants } from 'node:fs';
import type { NetworkName } from '../shared/chain-types.js';
import type { DiagnosticCheck } from '../shared/view-types.js';
import type { ChainService } from './chain-service.js';
import type { CoreModules } from './core-loader.js';
import type { LogBuffer } from './log-buffer.js';
import type { NodeSupervisor } from './node-supervisor.js';
import type { AppPaths } from './paths.js';
import type { SettingsStore } from './settings.js';
import { RpcClient } from './rpc-client.js';
import { redactText } from './redact.js';

const MIN_FREE_BYTES = 2 * 1024 ** 3;

export class DiagnosticsService {
  constructor(
    private readonly deps: {
      core: () => Promise<CoreModules>;
      paths: AppPaths;
      supervisor: NodeSupervisor;
      chain: ChainService;
      logs: LogBuffer;
      settings: SettingsStore;
      appVersion: string;
      versions: () => Record<string, string>;
    },
  ) {}

  async run(): Promise<DiagnosticCheck[]> {
    const state = this.deps.supervisor.state();
    const network: NetworkName = state.network;
    const p = this.deps.paths.forNetwork(network);
    const checks: DiagnosticCheck[] = [];
    const add = (id: string, label: string, status: DiagnosticCheck['status'], detail: string): void => {
      checks.push({ id, label, status, detail });
    };

    let core: CoreModules | null = null;
    try {
      core = await this.deps.core();
      add('core', 'Obsidian Core present', 'pass', `Version ${core.version.CORE_VERSION}, protocol ${core.version.PROTOCOL_VERSION}`);
    } catch (error) {
      add('core', 'Obsidian Core present', 'fail', (error as Error).message);
    }

    add('process', 'Node process', state.phase === 'running' ? 'pass' : state.phase === 'failed' ? 'fail' : 'info', `${state.phase}${state.pid ? ` (pid ${state.pid})` : ''}${state.error ? ` — ${state.error.message.split('\n')[0]}` : ''}`);

    // Data directory: writable and with room to grow.
    try {
      const target = existsSync(p.dataDir) ? p.dataDir : p.root;
      if (existsSync(target)) {
        accessSync(target, constants.W_OK);
        const fs = statfsSync(target);
        const free = Number(fs.bavail) * Number(fs.bsize);
        add('disk', 'Data directory writable, disk space', free >= MIN_FREE_BYTES ? 'pass' : 'warn', `${formatBytes(free)} free${free < MIN_FREE_BYTES ? ' (less than 2 GB)' : ''}`);
      } else {
        add('disk', 'Data directory', 'info', 'Not created yet. It is created when the node first starts.');
      }
    } catch (error) {
      add('disk', 'Data directory writable, disk space', 'fail', redactText((error as Error).message));
    }

    add('keystore', 'Node identity key', existsSync(p.keystore) ? (existsSync(p.keystorePassphrase) ? 'pass' : 'fail') : 'info', existsSync(p.keystore) ? (existsSync(p.keystorePassphrase) ? 'Present, with its passphrase file.' : 'Present, but the passphrase file is missing.') : 'Not created yet. It is created when the node first starts.');

    if (state.externalNodeDetected) add('external', 'Other node on the RPC port', 'warn', 'Something not started by this app answers on the RPC port.');

    if (state.phase === 'running' && core) {
      const client = new RpcClient({ baseUrl: state.rpcUrl, timeoutMs: 4000 });
      const started = Date.now();
      try {
        const health = await client.health();
        const latency = Date.now() - started;
        add('rpc', 'Node RPC answers', 'pass', `${latency} ms at ${state.rpcUrl}`);
        const def = core.networks.NETWORKS[network];
        add('identity', 'Node is on the selected network', health.network === network && health.chainId === def.chainId ? 'pass' : 'fail', `${health.network} (chain ${health.chainId}); expected ${network} (${def.chainId})`);
        const local = core.stateRoot.PARAMS_HASH;
        if (local) add('params', 'Protocol parameters match this app', health.paramsHash === local ? 'pass' : 'fail', health.paramsHash === local ? `paramsHash ${health.paramsHash}` : `node ${health.paramsHash} ≠ app ${local}`);
        add('sync', 'Synchronization', health.syncing ? 'warn' : 'pass', health.syncing ? 'Still catching up with the network.' : `Caught up at height ${health.height}`);
        add('peers', 'Peers', health.peers > 0 ? 'pass' : 'warn', health.peers > 0 ? `${health.peers} connected` : 'No peers connected. A node with no peers builds only its own chain.');
        add('supply', 'Supply invariant', health.supplyOk ? 'pass' : 'fail', health.supplyOk ? 'The node reports the supply invariant holds.' : 'The node reports the supply invariant is violated.');
        const finality = await client.finality();
        add('finality', 'Finality', 'info', `Finalized height ${finality.finalizedHeight} of ${finality.headHeight}; ${finality.validatorCount} validator(s) in the committee.`);
      } catch (error) {
        add('rpc', 'Node RPC answers', 'fail', redactText((error as Error).message));
      }
    } else if (state.phase !== 'running') {
      add('rpc', 'Node RPC answers', 'info', 'The node is not running, so nothing was checked.');
    }
    return checks;
  }

  /** A text report with nothing secret in it. */
  async report(): Promise<string> {
    const checks = await this.run();
    const state = this.deps.supervisor.state();
    const settings = this.deps.settings.get();
    const snapshot = this.deps.chain.snapshot();
    const lines: string[] = [];
    lines.push('OBSIDIAN NODE — DIAGNOSTIC REPORT', `Generated: ${new Date().toISOString()}`, `App version: ${this.deps.appVersion}`);
    for (const [k, v] of Object.entries(this.deps.versions())) lines.push(`${k}: ${v}`);
    lines.push('', `Network: ${state.network}`, `Node phase: ${state.phase}`, `RPC: ${state.rpcUrl}`, `Link: ${snapshot.link}`);
    if (snapshot.status) lines.push(`Height: ${snapshot.status.height}`, `Peers: ${snapshot.status.peers}`, `Finalized: ${snapshot.status.finalizedHeight}`);
    lines.push('', 'Settings (this network):', JSON.stringify(settings.nodes[state.network], null, 2), '', 'Checks:');
    for (const c of checks) lines.push(`  [${c.status.toUpperCase()}] ${c.label}: ${c.detail}`);
    lines.push('', 'Recent log (last 200 entries, redacted):');
    for (const e of this.deps.logs.recent({ limit: 200 })) lines.push(`${new Date(e.ts).toISOString()} ${e.severity} [${e.component}] ${e.message}`);
    return redactText(lines.join('\n'));
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}
