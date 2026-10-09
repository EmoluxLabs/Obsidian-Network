/**
 * Live view of the running node, with bounded polling.
 *
 * One poll = two requests (/health and /status). Everything else (peers, PoT, finality,
 * params) is fetched on demand with a short cache and request de-duplication, so screens
 * that are not open cost nothing. The node rate-limits RPC clients to 240 requests a
 * minute; this service stays at roughly 25 per minute while idle.
 *
 * "Connected" is only ever the result of a successful, validated answer from the node of
 * the network the app is pointed at. After repeated failures the link is `lost` — the last
 * known numbers are kept for display but marked, never presented as current.
 */
import { EventEmitter } from 'node:events';
import type { NetworkName } from '../shared/chain-types.js';
import { AppError } from '../shared/errors.js';
import type { ChainSnapshot, NetworkDetail, Remote } from '../shared/view-types.js';
import { RpcClient } from './rpc-client.js';
import type { NodeSupervisor } from './node-supervisor.js';

export interface ChainServiceOptions {
  supervisor: NodeSupervisor;
  pollMs?: number;
  detailTtlMs?: number;
  clientFactory?: (baseUrl: string) => RpcClient;
}

const LOST_AFTER = 3;

export class ChainService extends EventEmitter {
  private snap: ChainSnapshot;
  private timer?: NodeJS.Timeout;
  private polling = false;
  private cache = new Map<string, { at: number; value: Promise<unknown> }>();
  private stopped = false;

  constructor(private readonly options: ChainServiceOptions) {
    super();
    this.snap = this.emptySnapshot();
    options.supervisor.on('state', () => this.onSupervisorState());
  }

  private emptySnapshot(): ChainSnapshot {
    const state = this.options.supervisor.state();
    return {
      network: state.network,
      link: linkFor(state.phase),
      at: null,
      health: null,
      status: null,
      headAgeSeconds: null,
      syncTargetHeight: null,
      failures: 0,
      lastError: null,
    };
  }

  snapshot(): ChainSnapshot {
    return this.snap;
  }

  private client(): RpcClient | null {
    const state = this.options.supervisor.state();
    if (state.phase !== 'running' || !state.rpcUrl) return null;
    return (this.options.clientFactory ?? ((url) => new RpcClient({ baseUrl: url })))(state.rpcUrl);
  }

  /** A client for that network's node, or null when the node is not running. */
  rpcIfRunning(network: NetworkName): RpcClient | null {
    return this.options.supervisor.network === network ? this.client() : null;
  }

  rpc(network: NetworkName): RpcClient {
    const client = this.rpcIfRunning(network);
    if (!client) throw new AppError('NODE_NOT_RUNNING', `The ${network} node is not running. Start it from the Node screen.`);
    return client;
  }

  private onSupervisorState(): void {
    const state = this.options.supervisor.state();
    if (state.network !== this.snap.network || state.phase !== 'running') {
      this.cache.clear();
      this.snap = { ...this.emptySnapshot(), link: linkFor(state.phase) };
      this.emit('snapshot', this.snap);
    }
    if (state.phase === 'running') {
      this.snap = { ...this.snap, link: this.snap.at ? this.snap.link : 'connecting' };
      this.schedule(0);
    }
  }

  start(): void {
    this.stopped = false;
    if (this.options.supervisor.state().phase === 'running') this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), delay);
  }

  /** One poll. Exposed for tests and for an immediate refresh after an action. */
  async poll(): Promise<ChainSnapshot> {
    if (this.polling) return this.snap;
    const client = this.client();
    if (!client) return this.snap;
    this.polling = true;
    const network = this.options.supervisor.network;
    try {
      const [health, status] = await Promise.all([client.health(), client.status()]);
      if (health.network !== network) throw new Error(`the node reports ${health.network}, not ${network}`);
      const best = await this.bestPeerHeight(client, health.syncing);
      this.snap = {
        network,
        link: 'connected',
        at: Date.now(),
        health,
        status,
        headAgeSeconds: Math.max(0, health.timestamp - status.lastBlockTimestamp),
        syncTargetHeight: health.syncing && best !== null && best > status.height ? best : null,
        failures: 0,
        lastError: null,
      };
    } catch (error) {
      const failures = this.snap.failures + 1;
      this.snap = { ...this.snap, link: failures >= LOST_AFTER ? 'lost' : this.snap.link === 'connected' ? 'connected' : 'connecting', failures, lastError: (error as Error).message };
    } finally {
      this.polling = false;
    }
    this.emit('snapshot', this.snap);
    if (this.options.supervisor.state().phase === 'running') {
      // 5 s when healthy; back off to 15 s when the node is not answering.
      this.schedule(this.snap.failures === 0 ? (this.options.pollMs ?? 5000) : Math.min(15_000, (this.options.pollMs ?? 5000) * (1 + this.snap.failures)));
    }
    return this.snap;
  }

  private async bestPeerHeight(client: RpcClient, syncing: boolean): Promise<number | null> {
    if (!syncing) return null;
    try {
      return (await this.cached('peers', client, (c) => c.peers())).bestPeerHeight;
    } catch {
      return null;
    }
  }

  private cached<T>(key: string, client: RpcClient, load: (c: RpcClient) => Promise<T>): Promise<T> {
    const ttl = this.options.detailTtlMs ?? 3000;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value as Promise<T>;
    const value = load(client);
    this.cache.set(key, { at: Date.now(), value });
    value.catch(() => this.cache.delete(key));
    return value;
  }

  /** Cached, de-duplicated, validated read of the detail endpoints. */
  async detail(): Promise<NetworkDetail> {
    const client = this.client();
    const unavailable = (): Remote<never> => ({ state: 'unavailable', message: 'The node is not running.' });
    if (!client) return { peers: unavailable(), pot: unavailable(), finality: unavailable(), params: unavailable() };
    const settle = async <T>(key: string, load: (c: RpcClient) => Promise<T>, ttlKey = key): Promise<Remote<T>> => {
      try {
        return { state: 'ready', data: await this.cached(ttlKey, client, load), at: Date.now() };
      } catch (error) {
        return failure(error);
      }
    };
    const [peers, pot, finality, params] = await Promise.all([
      settle('peers', (c) => c.peers()),
      settle('pot', (c) => c.pot()),
      settle('finality', (c) => c.finality()),
      settle('params', (c) => c.params()),
    ]);
    return { peers, pot, finality, params };
  }

  /** Any other cached read the screens need (validators, mempool, ...). */
  read<T>(key: string, load: (c: RpcClient) => Promise<T>): Promise<T> {
    const client = this.client();
    if (!client) return Promise.reject(new AppError('NODE_NOT_RUNNING', 'The node is not running. Start it from the Node screen.'));
    return this.cached(key, client, load);
  }
}

export function failure(error: unknown): Remote<never> {
  const kind = (error as { kind?: string }).kind;
  const message = (error as Error).message;
  return kind === 'unavailable' || kind === 'timeout' ? { state: 'unavailable', message } : { state: 'error', message };
}

function linkFor(phase: string): ChainSnapshot['link'] {
  if (phase === 'starting') return 'starting';
  if (phase === 'running') return 'connecting';
  return 'stopped';
}
