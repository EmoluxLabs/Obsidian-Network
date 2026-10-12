/**
 * The node hosts its interface (protocol 1.8.0 operations).
 *
 * `start` runs the node and, unless told not to, a supervised interface next to it, so one command brings up a
 * network that people can open in a browser. The interface stays a SEPARATE PROCESS on purpose: the core never
 * imports it (the interface depends on the core, not the other way round), a crash in the web layer cannot take the
 * chain down, and the interface keeps its own data directory and its own secrets.
 *
 *   - found:     OBSIDIAN_INTERFACE_DIR, or `obsidian-interface/` beside the core (the layout of every archive
 *                that contains both). Needs dist/server/main.js. When it is absent the node runs alone and says so.
 *   - supervised: restarted after a crash with growing back-off (1 s up to 60 s); the back-off resets after a minute
 *                of uptime. After 8 failures in a row it STOPS retrying and says why: a node must not spin forever
 *                on an interface that cannot start. The node itself is never affected.
 *   - already running: if something already answers on the interface port, nothing is started, so a second `start`
 *                or a script-managed interface is never doubled.
 *   - opt out:   `--no-interface` or OBSIDIAN_NODE_ONLY=1.
 *   - role:      OBSIDIAN_INTERFACE_ROLE (primary | edge) is passed through; see docs/operations.md.
 *
 * It does not own the interface's secrets: the gate keystore, its passphrase and the genesis invitation hash are the
 * operator's OBSIDIAN_* environment, inherited by the child exactly as they would be by a hand-started interface.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { httpGetJson, INTERFACE_PORTS } from './ops.js';

export const INTERFACE_ENTRY = join('dist', 'server', 'main.js');
const MAX_CONSECUTIVE_FAILURES = 8;
const HEALTHY_AFTER_MS = 60_000;

export interface SupervisorOptions {
  network: string;
  /** The node's RPC base URL on this machine (what the interface is pointed at). */
  nodeUrl: string;
  /** Node data directory; the interface's own data goes beside it. */
  nodeDataDir: string;
  portOffset?: number;
  env?: NodeJS.ProcessEnv;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
  /** Test seams. */
  nodeBinary?: string;
  backoffMs?: (failures: number) => number;
  interfaceDir?: string;
  coreRoot?: string;
  probe?: (url: string) => Promise<boolean>;
}

export type InterfaceState = 'disabled' | 'not-found' | 'already-running' | 'running' | 'restarting' | 'gave-up' | 'stopped';

export interface InterfaceStatus {
  state: InterfaceState;
  detail?: string;
  pid?: number;
  port?: number;
  restarts: number;
}

/** Where the built interface is, or undefined. */
export function locateInterface(env: NodeJS.ProcessEnv = process.env, coreRoot = defaultCoreRoot()): string | undefined {
  const candidates = [env.OBSIDIAN_INTERFACE_DIR, join(coreRoot, '..', 'obsidian-interface'), join(coreRoot, 'obsidian-interface')];
  for (const candidate of candidates) {
    if (candidate && existsSync(join(candidate, INTERFACE_ENTRY))) return resolve(candidate);
  }
  return undefined;
}

function defaultCoreRoot(): string {
  // dist/cli/interface-supervisor.js → the core package root
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function interfaceDisabled(optOut: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  return optOut || /^(1|true|yes|on)$/i.test(env.OBSIDIAN_NODE_ONLY ?? '');
}

export function interfacePort(network: string, portOffset = 0, env: NodeJS.ProcessEnv = process.env): number {
  const explicit = env.OBSIDIAN_INTERFACE_PORT;
  if (explicit !== undefined && explicit !== '') {
    const port = Number(explicit);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`OBSIDIAN_INTERFACE_PORT must be a port number, received "${explicit}"`);
    return port;
  }
  const base = INTERFACE_PORTS[network];
  if (base === undefined) throw new Error(`no interface port for network ${network}`);
  return base + portOffset;
}

export class InterfaceSupervisor {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private stopping = false;
  private failures = 0;
  private restarts = 0;
  private startedAt = 0;
  private current: InterfaceStatus = { state: 'stopped', restarts: 0 };
  private dir?: string;
  private port = 0;
  private readonly env: NodeJS.ProcessEnv;

  constructor(private readonly options: SupervisorOptions) {
    this.env = options.env ?? process.env;
    // A node that dies without running its shutdown (a crash, a SIGKILL of the parent shell) must not leave a stray
    // interface behind answering for a chain nobody is running. `exit` handlers run synchronously, which kill() is.
    process.once('exit', () => {
      this.stopping = true;
      this.child?.kill('SIGTERM');
    });
  }

  status(): InterfaceStatus {
    return { ...this.current, restarts: this.restarts };
  }

  async start(optOut: boolean): Promise<InterfaceStatus> {
    const { log } = this.options;
    if (interfaceDisabled(optOut, this.env)) {
      this.current = { state: 'disabled', detail: 'node only (--no-interface or OBSIDIAN_NODE_ONLY)', restarts: 0 };
      log('info', 'interface not started: node only', {});
      return this.status();
    }
    this.dir = this.options.interfaceDir ?? locateInterface(this.env, this.options.coreRoot);
    if (!this.dir) {
      this.current = {
        state: 'not-found',
        detail: `no built interface (${INTERFACE_ENTRY}) next to the node; set OBSIDIAN_INTERFACE_DIR, or pass --no-interface to silence this`,
        restarts: 0,
      };
      log('info', 'no built interface found: running the node alone', { hint: 'set OBSIDIAN_INTERFACE_DIR, or --no-interface' });
      return this.status();
    }
    this.port = interfacePort(this.options.network, this.options.portOffset ?? 0, this.env);
    const probe = this.options.probe ?? (async (url) => (await httpGetJson(url, { timeoutMs: 1500, maxBytes: 64 * 1024 }).catch(() => undefined))?.status === 200);
    if (await probe(`http://127.0.0.1:${this.port}/api/health`)) {
      this.current = { state: 'already-running', detail: `an interface already answers on port ${this.port}; not starting another`, port: this.port, restarts: 0 };
      log('info', 'an interface is already running on this port: not starting another', { port: this.port });
      return this.status();
    }
    this.spawnChild();
    return this.status();
  }

  private spawnChild(): void {
    if (this.stopping || !this.dir) return;
    const { network, nodeUrl, nodeDataDir, log } = this.options;
    const dataDir = this.env.OBSIDIAN_INTERFACE_DATA_DIR || join(nodeDataDir, '..', 'interface');
    const env: NodeJS.ProcessEnv = { ...this.env, OBSIDIAN_INTERFACE_NETWORK: network };
    // The node was told its network by flag; a leftover OBSIDIAN_NETWORK from the shell must not argue with the interface.
    if (env.OBSIDIAN_NETWORK && env.OBSIDIAN_NETWORK !== network) delete env.OBSIDIAN_NETWORK;
    const args = [INTERFACE_ENTRY, '--network', network, '--port', String(this.port), '--nodes', nodeUrl, '--data-dir', resolve(dataDir)];
    this.startedAt = Date.now();
    const child = spawn(this.options.nodeBinary ?? process.execPath, args, { cwd: this.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.current = { state: 'running', pid: child.pid, port: this.port, restarts: this.restarts };
    log('info', 'interface started', { pid: child.pid, port: this.port, url: `http://127.0.0.1:${this.port}`, dataDir: resolve(dataDir) });
    const forward = (chunk: Buffer, level: 'info' | 'warn'): void => {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) log(level, `[interface] ${line.trim().slice(0, 500)}`, {});
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => forward(chunk, 'info'));
    child.stderr?.on('data', (chunk: Buffer) => forward(chunk, 'warn'));
    child.on('error', (error) => log('error', 'interface could not be started', { error: error.message }));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.stopping) return;
      const lived = Date.now() - this.startedAt;
      this.failures = lived >= HEALTHY_AFTER_MS ? 1 : this.failures + 1;
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.current = {
          state: 'gave-up',
          detail: `the interface exited ${this.failures} times in a row (last: ${signal ?? `code ${code}`}); not retrying. The node is unaffected. Fix the cause (see the [interface] lines above) and restart the node, or run the interface yourself.`,
          port: this.port,
          restarts: this.restarts,
        };
        log('error', 'interface keeps failing: giving up', { exits: this.failures, code, signal });
        return;
      }
      const delay = (this.options.backoffMs ?? ((n) => Math.min(60_000, 1000 * 2 ** (n - 1))))(this.failures);
      this.restarts += 1;
      this.current = { state: 'restarting', detail: `exited (${signal ?? `code ${code}`}); restarting in ${delay} ms`, port: this.port, restarts: this.restarts };
      log('warn', 'interface exited: restarting', { code, signal, inMs: delay, attempt: this.failures });
      this.timer = setTimeout(() => this.spawnChild(), delay);
      this.timer.unref?.();
    });
  }

  /** Stop the child and cancel any pending restart. Resolves when the process is gone (SIGKILL after `graceMs`). */
  async stop(graceMs = 5000): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    const child = this.child;
    if (this.current.state !== 'disabled' && this.current.state !== 'not-found' && this.current.state !== 'already-running') {
      this.current = { ...this.current, state: 'stopped' };
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((done) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), graceMs);
      child.once('exit', () => {
        clearTimeout(kill);
        done();
      });
      child.kill('SIGTERM');
    });
  }
}
