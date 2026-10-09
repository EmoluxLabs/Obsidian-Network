/**
 * Starts, watches and stops the node process.
 *
 * "Running" is never assumed. The supervisor reports `running` only after the node's own
 * /health answers and names the network (and chain id) the app asked for. A process that
 * is alive but not answering is `starting` until a deadline, then `failed` with the node's
 * last error output. Stopping uses the node's own shutdown path and escalates to a signal
 * only if the node does not exit, so there is no orphaned process and no second writer on
 * the data directory (the core also holds a data-directory lock).
 *
 * The app never initialises a genesis or resets a database: the first start of a network
 * creates that network's canonical genesis through the core exactly as `obsidian-core
 * start` does, and only after the user has confirmed that a new local chain is wanted.
 */
import { EventEmitter } from 'node:events';
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import type { NetworkName } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { NodeProcessState } from '../shared/node-types.js';
import type { LogBuffer } from './log-buffer.js';
import { RpcClient, RpcError } from './rpc-client.js';
import type { AppPaths } from './paths.js';
import type { SettingsStore } from './settings.js';
import { redactText } from './redact.js';
import type { CoreModules } from './core-loader.js';

export interface SupervisorOptions {
  paths: AppPaths;
  settings: SettingsStore;
  logs: LogBuffer;
  core: () => Promise<CoreModules>;
  hostScript: string;
  /** Executable used to run the host. In Electron this is the app binary (run as plain Node). */
  execPath?: string;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
  killTimeoutMs?: number;
  /** Extra environment for tests. */
  env?: NodeJS.ProcessEnv;
}

const STDERR_TAIL = 12;

export class NodeSupervisor extends EventEmitter {
  private child?: ChildProcess;
  private current: NodeProcessState;
  private stderrTail: string[] = [];
  private exitWaiters: Array<() => void> = [];
  private intentionalStop = false;
  private busy = false;

  constructor(private readonly options: SupervisorOptions) {
    super();
    const network = options.settings.get().network;
    this.current = this.baseState(network, 'stopped');
    // Unknown until the core is loaded; refreshed on the first call that needs ports.
    void this.refreshPorts().catch(() => undefined);
  }

  state(): NodeProcessState {
    return { ...this.current, chainDataPresent: this.chainDataPresent(this.current.network) };
  }

  /** The network this supervisor is configured for (the one the app is pointed at). */
  get network(): NetworkName {
    return this.current.network;
  }

  isActive(): boolean {
    return this.current.phase === 'starting' || this.current.phase === 'running' || this.current.phase === 'stopping';
  }

  private baseState(network: NetworkName, phase: NodeProcessState['phase']): NodeProcessState {
    const p = this.options.paths.forNetwork(network);
    return {
      phase,
      network,
      rpcUrl: '',
      rpcPort: 0,
      p2pPort: 0,
      dataDir: p.dataDir,
      keystorePath: p.keystore,
      chainDataPresent: false,
      externalNodeDetected: false,
    };
  }

  private async ports(network: NetworkName): Promise<{ rpcPort: number; p2pPort: number; rpcUrl: string }> {
    const core = await this.options.core();
    const def = core.networks.NETWORKS[network];
    const offset = this.options.settings.get().nodes[network].portOffset;
    const rpcPort = def.defaultRpcPort + offset;
    return { rpcPort, p2pPort: def.defaultP2pPort + offset, rpcUrl: `http://127.0.0.1:${rpcPort}` };
  }

  async refreshPorts(): Promise<void> {
    const ports = await this.ports(this.current.network);
    this.current = { ...this.current, ...ports };
    this.emit('state', this.state());
  }

  chainDataPresent(network: NetworkName): boolean {
    const dir = this.options.paths.forNetwork(network).dataDir;
    try {
      return existsSync(dir) && readdirSync(dir).some((name) => name !== 'LOCK');
    } catch {
      return false;
    }
  }

  /** Point the supervisor at another network. Refused while a node process exists. */
  async selectNetwork(network: NetworkName): Promise<void> {
    if (this.child) throw new AppError('NODE_ACTIVE', 'Stop the node before changing network.');
    this.current = this.baseState(network, 'stopped');
    await this.refreshPorts();
  }

  /** Is anything (not started by this app) already answering on the node's RPC port? */
  async probeExternalNode(): Promise<boolean> {
    const ports = await this.ports(this.current.network);
    try {
      await new RpcClient({ baseUrl: ports.rpcUrl, timeoutMs: 1500 }).health();
      return true;
    } catch (error) {
      // Any HTTP answer, even an error, means something holds the port.
      return error instanceof RpcError && (error.kind === 'http' || error.kind === 'malformed');
    }
  }

  private set(patch: Partial<NodeProcessState>): void {
    this.current = { ...this.current, ...patch };
    this.emit('state', this.state());
  }

  async start(options: { confirmNewChain?: boolean } = {}): Promise<NodeProcessState> {
    if (this.busy || this.isActive()) throw new AppError('NODE_ACTIVE', 'The node is already running or changing state.');
    this.busy = true;
    try {
      const network = this.current.network;
      const core = await this.options.core();
      const ports = await this.ports(network);
      const settings = this.options.settings.get();
      const node = settings.nodes[network];
      const p = this.options.paths.forNetwork(network);
      this.stderrTail = [];
      this.intentionalStop = false;
      this.current = { ...this.baseState(network, 'starting'), ...ports, step: 'Checking the network ports' };
      this.emit('state', this.state());

      if (await this.probeExternalNode()) {
        throw new AppError(
          'RPC_PORT_IN_USE',
          `Another program is already answering on ${ports.rpcUrl}. If it is an Obsidian node started elsewhere, stop it first: two nodes must never share one data directory.`,
        );
      }
      for (const [label, port] of [['peer-to-peer', ports.p2pPort], ['RPC', ports.rpcPort]] as const) {
        if (!(await portIsFree(port, label === 'RPC' ? '127.0.0.1' : '0.0.0.0'))) {
          throw new AppError('PORT_IN_USE', `The ${label} port ${port} is already in use by another program. Change the port offset in Settings or close the other program.`);
        }
      }
      if (!this.chainDataPresent(network) && !options.confirmNewChain) {
        throw new AppError(
          'NEW_CHAIN_CONFIRMATION_REQUIRED',
          `No ${network} chain data exists in ${p.dataDir}. Starting will create a new local ${network} chain from the network's genesis. Confirm to continue.`,
          { network, dataDir: p.dataDir },
        );
      }
      if (network === 'mainnet' && !core.networks.NETWORKS.mainnet.isProduction) {
        throw new AppError('NETWORK_TABLE_MISMATCH', 'The staged core does not describe mainnet as a production network.');
      }
      this.ensurePassphrase(p.keystore, p.keystorePassphrase);
      mkdirSync(p.dataDir, { recursive: true });

      this.set({ step: 'Starting the node process' });
      const spec = {
        coreDir: core.dir,
        network,
        dataDir: p.dataDir,
        keystorePath: p.keystore,
        nodeName: node.nodeName,
        logLevel: node.logLevel,
        rpcPort: ports.rpcPort,
        p2pPort: ports.p2pPort,
        seeds: node.seeds,
        blockProduction: node.blockProduction,
      };
      const child = fork(this.options.hostScript, [], {
        execPath: this.options.execPath,
        env: {
          ...minimalEnv(),
          ...this.options.env,
          ELECTRON_RUN_AS_NODE: '1',
          OBSIDIAN_NODE_SPEC: JSON.stringify(spec),
          OBSIDIAN_KEYSTORE_PASSPHRASE_FILE: p.keystorePassphrase,
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      } as ForkOptions & { windowsHide?: boolean });
      this.child = child;
      this.set({ pid: child.pid, startedAt: Date.now(), step: 'Opening the data directory and waiting for the node' });
      this.options.logs.app('INFO', `node process ${child.pid} started for ${network}`, 'supervisor');
      pipeLines(child.stdout, (line) => this.options.logs.line(line, 'stdout'));
      pipeLines(child.stderr, (line) => {
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_TAIL) this.stderrTail.shift();
        this.options.logs.line(line, 'stderr');
      });
      child.on('error', (error) => this.options.logs.app('ERROR', `node process error: ${error.message}`, 'supervisor'));
      child.on('exit', (code, signal) => this.onExit(code, signal));

      await this.waitUntilReady(child, ports.rpcUrl, network, core);
      this.set({ phase: 'running', step: undefined, error: undefined });
      this.options.logs.app('INFO', `node is answering on ${ports.rpcUrl}`, 'supervisor');
      return this.state();
    } catch (error) {
      const info = toInfo(error);
      if (this.child) await this.terminate();
      this.set({ phase: 'failed', error: info, step: undefined });
      this.options.logs.app('ERROR', `start failed: ${info.message}`, 'supervisor');
      throw error;
    } finally {
      this.busy = false;
    }
  }

  private async waitUntilReady(child: ChildProcess, rpcUrl: string, network: NetworkName, core: CoreModules): Promise<void> {
    const timeout = this.options.readyTimeoutMs ?? 120_000;
    const deadline = Date.now() + timeout;
    const client = new RpcClient({ baseUrl: rpcUrl, timeoutMs: 2000 });
    const expected = core.networks.NETWORKS[network];
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    let fatal: string | undefined;
    child.on('message', (m: unknown) => {
      if (m && typeof m === 'object' && (m as { type?: string }).type === 'fatal') fatal = String((m as { message?: unknown }).message);
    });
    while (Date.now() < deadline) {
      if (exited || child.exitCode !== null) {
        const tail = redactText(this.stderrTail.join('\n'));
        throw new AppError('NODE_EXITED', `The node stopped while starting.${fatal ? ` ${redactText(fatal)}` : ''}${tail ? `\n${tail}` : ''}`.trim());
      }
      try {
        const health = await client.health();
        if (health.network !== network || health.chainId !== expected.chainId) {
          throw new AppError('WRONG_NETWORK', `The node on ${rpcUrl} reports ${health.network} (chain ${health.chainId}), not ${network}. It was not trusted.`);
        }
        return;
      } catch (error) {
        if (error instanceof AppError) throw error;
        // not answering yet: keep waiting
      }
      await sleep(400);
    }
    throw new AppError('NODE_NOT_RESPONDING', `The node process is running but did not answer on ${rpcUrl} within ${Math.round(timeout / 1000)} s.`);
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const unexpected = !this.intentionalStop;
    this.child = undefined;
    const tail = redactText(this.stderrTail.join('\n'));
    this.options.logs.app(unexpected ? 'ERROR' : 'INFO', `node process exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`, 'supervisor');
    const wasStarting = this.current.phase === 'starting';
    this.current = {
      ...this.current,
      phase: unexpected && !wasStarting ? 'failed' : unexpected ? this.current.phase : 'stopped',
      pid: undefined,
      lastExit: { code, signal, at: Date.now() },
      error:
        unexpected && !wasStarting
          ? { code: 'NODE_CRASHED', message: `The node process exited unexpectedly (code ${code ?? 'none'}, signal ${signal ?? 'none'}).${tail ? `\n${tail}` : ''}` }
          : this.current.error,
      step: undefined,
    };
    this.emit('state', this.state());
    for (const wake of this.exitWaiters.splice(0)) wake();
  }

  /** Graceful stop through the node's own shutdown path. */
  async stop(): Promise<NodeProcessState> {
    if (!this.child) {
      if (this.current.phase === 'failed') this.set({ phase: 'stopped', error: undefined });
      return this.state();
    }
    if (this.current.phase === 'stopping') throw new AppError('NODE_ACTIVE', 'The node is already stopping.');
    this.set({ phase: 'stopping', step: 'Shutting the node down safely' });
    this.options.logs.app('INFO', 'stopping node', 'supervisor');
    this.intentionalStop = true;
    await this.terminate();
    this.set({ phase: 'stopped', step: undefined, error: undefined });
    return this.state();
  }

  async restart(options: { confirmNewChain?: boolean } = {}): Promise<NodeProcessState> {
    await this.stop();
    return this.start(options);
  }

  private async terminate(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.intentionalStop = true;
    const exited = new Promise<void>((resolve) => this.exitWaiters.push(resolve));
    try {
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    if (await raceTimeout(exited, this.options.stopTimeoutMs ?? 30_000)) return;
    this.options.logs.app('WARN', 'node did not stop on request; sending SIGTERM', 'supervisor');
    child.kill('SIGTERM');
    if (await raceTimeout(exited, this.options.killTimeoutMs ?? 10_000)) return;
    this.options.logs.app('ERROR', 'node did not stop; killing it', 'supervisor');
    child.kill('SIGKILL');
    await raceTimeout(exited, 5_000);
  }

  /** App is quitting: stop the node and wait for it. */
  async dispose(): Promise<void> {
    if (this.child) await this.stop().catch(() => undefined);
  }

  /** The keystore passphrase never leaves this machine and never goes on a command line. */
  private ensurePassphrase(keystore: string, passFile: string): void {
    if (existsSync(passFile)) return;
    if (existsSync(keystore)) {
      throw new AppError(
        'KEYSTORE_PASSPHRASE_MISSING',
        `A node identity key exists at ${keystore} but its passphrase file is missing, so it cannot be opened. Restore ${passFile}; the app will not create a new identity over an existing key.`,
      );
    }
    mkdirSync(dirname(passFile), { recursive: true });
    writeFileSync(passFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    try {
      chmodSync(passFile, 0o600);
    } catch {
      /* platforms without POSIX modes */
    }
  }

  /** Read the passphrase for in-process signing with the node identity key (validator operations). */
  readKeystorePassphrase(network: NetworkName): string | null {
    const file = this.options.paths.forNetwork(network).keystorePassphrase;
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return null;
    }
  }
}

function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let index: number;
    while ((index = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, index));
      pending = pending.slice(index + 1);
    }
    if (pending.length > 64 * 1024) pending = pending.slice(-1024);
  });
  stream.on('end', () => {
    if (pending) onLine(pending);
  });
}

/** Can we bind this port on the address the node will use? (RPC is loopback-only; peer-to-peer listens on all interfaces.) */
async function portIsFree(port: number, host = '0.0.0.0'): Promise<boolean> {
  const attempt = (): Promise<boolean> =>
    new Promise((resolve) => {
      const server = createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
  // One retry: sockets of a node that was just stopped can take a moment to be released.
  if (await attempt()) return true;
  await sleep(400);
  return attempt();
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function raceTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => {
    timer = setTimeout(() => r(false), ms);
  });
  try {
    return await Promise.race([promise.then(() => true as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function toInfo(error: unknown): { code: string; message: string } {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: 'NODE_START_FAILED', message: redactText((error as Error).message) };
}
