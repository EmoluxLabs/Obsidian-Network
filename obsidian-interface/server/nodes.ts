/**
 * Node discovery, health checks, scoring and failover.
 *
 * The interface is a *reader*. It never becomes a source of truth: every value
 * it shows comes from a node, and when a node disagrees or disappears the
 * interface moves to another one instead of inventing an answer. Cloudflare or
 * this server going down cannot affect consensus, because neither of them takes
 * part in it.
 */

export interface NodeState {
  url: string;
  healthy: boolean;
  height: number;
  genesisId?: string;
  chainId?: number;
  networkId?: string;
  version?: string;
  latencyMs: number;
  failures: number;
  successes: number;
  lastCheckedAt: number;
  lastError?: string;
  /** Reachable and healthy, but following a different network than this interface serves. */
  wrongNetwork?: boolean;
}

export interface NodePoolOptions {
  /** Seed node URLs (http/https). */
  nodes: string[];
  /** Health check interval in milliseconds. */
  checkIntervalMs?: number;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** How many consecutive failures before a node is considered down. */
  failureThreshold?: number;
  fetchImpl?: typeof fetch;
  /**
   * The network this interface serves. A node that reports another network or
   * chain id is excluded from every read, however healthy it is: an interface
   * must not show a mainnet balance on a devnet page because someone pointed
   * it at the wrong port.
   */
  expect?: { networkId: string; chainId: number };
  log?: (level: 'debug' | 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;
}

export interface NodeStatusSummary {
  genesisId: string;
  chainId: number;
  networkId: string;
  height: number;
  headHash: string;
  syncing: boolean;
  peers: number;
}

const HEALTH_PATH = '/status';

export class NodePool {
  private readonly states = new Map<string, NodeState>();
  private timer?: NodeJS.Timeout;

  constructor(private readonly options: NodePoolOptions) {
    for (const url of options.nodes) {
      const clean = normaliseNodeUrl(url);
      this.states.set(clean, {
        url: clean,
        healthy: false,
        height: 0,
        latencyMs: Number.POSITIVE_INFINITY,
        failures: 0,
        successes: 0,
        lastCheckedAt: 0,
      });
    }
  }

  get size(): number {
    return this.states.size;
  }

  all(): NodeState[] {
    return [...this.states.values()];
  }

  /** Add a node discovered from a peer list. Never removes operator seeds. */
  add(url: string): void {
    const clean = normaliseNodeUrl(url);
    if (this.states.has(clean)) return;
    this.states.set(clean, {
      url: clean,
      healthy: false,
      height: 0,
      latencyMs: Number.POSITIVE_INFINITY,
      failures: 0,
      successes: 0,
      lastCheckedAt: 0,
    });
  }

  /**
   * The genesis id a majority of healthy nodes report. The interface must never
   * blend two chains together: once a majority exists, nodes on a different
   * genesis are excluded from reads and only flagged in the UI.
   */
  private majorityGenesis(): string | undefined {
    const counts = new Map<string, number>();
    for (const state of this.all()) {
      if (state.healthy && state.genesisId) counts.set(state.genesisId, (counts.get(state.genesisId) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best?.[0];
  }

  private usable(state: NodeState): boolean {
    if (!state.healthy) return false;
    const majority = this.majorityGenesis();
    return !majority || !state.genesisId || state.genesisId === majority;
  }

  /**
   * Score a node: reachable nodes win, then highest height, then lowest
   * latency. A stale node that is behind the network is always beaten by a
   * node that is at the tip.
   */
  private score(state: NodeState): number {
    if (!state.healthy) return Number.NEGATIVE_INFINITY;
    const latencyBonus = Number.isFinite(state.latencyMs) ? 1000 - Math.min(state.latencyMs, 1000) : 0;
    return state.height * 10_000 + latencyBonus;
  }

  /** Best node to read from. Never returns a node that is known to be down. */
  pick(options: { prefer?: string; exclude?: string[] } = {}): NodeState | undefined {
    const excluded = new Set((options.exclude ?? []).map(normaliseNodeUrl));
    if (options.prefer) {
      const preferred = this.states.get(normaliseNodeUrl(options.prefer));
      if (preferred && this.usable(preferred) && !excluded.has(preferred.url)) return preferred;
    }
    const ranked = this.all()
      .filter((state) => !excluded.has(state.url) && this.usable(state))
      .sort((a, b) => this.score(b) - this.score(a));
    return ranked[0];
  }

  /**
   * Failover order. Healthy nodes on the consensus chain come first, best node
   * first; nodes known to be down are dropped entirely — they are retried by the
   * health sweep, not by a user's request. If *nothing* is healthy the list
   * still contains the configured nodes so the operator gets a real error from
   * a real attempt instead of an invented one.
   */
  ordered(options: { prefer?: string } = {}): NodeState[] {
    const first = this.pick(options);
    const rest = this.all()
      .filter((state) => state.url !== first?.url && this.usable(state))
      .sort((a, b) => this.score(b) - this.score(a));
    if (first) return [first, ...rest];
    if (rest.length > 0) return rest;
    // Nothing is healthy: still try the configured nodes, so the operator gets a
    // real error from a real attempt. Never one that is on the wrong network —
    // reaching it would show another chain's data on this interface.
    return this.all().filter((state) => !state.wrongNetwork);
  }

  async checkAll(): Promise<NodeState[]> {
    await Promise.all(this.all().map((state) => this.check(state.url)));
    return this.all();
  }

  async check(url: string): Promise<NodeState> {
    const key = normaliseNodeUrl(url);
    const state = this.states.get(key);
    if (!state) return this.states.set(key, {
      url: key,
      healthy: false,
      height: 0,
      latencyMs: Number.POSITIVE_INFINITY,
      failures: 1,
      successes: 0,
      lastCheckedAt: Date.now(),
      lastError: 'unknown node',
    }).get(key)!;

    const started = Date.now();
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 4000);
      const response = await fetchImpl(`${key}${HEALTH_PATH}`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as Partial<NodeStatusSummary>;
      if (typeof body.height !== 'number' || typeof body.genesisId !== 'string') {
        throw new Error('node did not return a valid status document');
      }
      const expected = this.options.expect;
      if (expected && (body.networkId !== expected.networkId || (body.chainId !== undefined && body.chainId !== expected.chainId))) {
        // Not "down": reachable and healthy, and on the wrong chain. Excluded
        // at once (no two-strike grace) and said so, because the operator's fix
        // is to point at the right node, not to wait.
        state.networkId = body.networkId;
        state.chainId = body.chainId;
        state.genesisId = body.genesisId;
        state.height = body.height;
        state.healthy = false;
        state.wrongNetwork = true;
        state.failures += 1;
        state.latencyMs = Number.POSITIVE_INFINITY;
        state.lastError = `wrong network: this node follows ${body.networkId ?? 'an unknown network'} (chain ${body.chainId ?? '?'}), this interface serves ${expected.networkId}`;
        state.lastCheckedAt = Date.now();
        this.options.log?.('warn', 'node excluded: wrong network', { url: key, node: body.networkId, expected: expected.networkId });
        return state;
      }
      state.healthy = true;
      state.wrongNetwork = false;
      state.height = body.height;
      state.genesisId = body.genesisId;
      state.chainId = body.chainId;
      state.networkId = body.networkId;
      state.latencyMs = Date.now() - started;
      state.successes += 1;
      state.failures = 0;
      state.lastError = undefined;
      state.lastCheckedAt = Date.now();
    } catch (error) {
      state.failures += 1;
      state.lastError = (error as Error).message;
      state.lastCheckedAt = Date.now();
      const threshold = this.options.failureThreshold ?? 2;
      if (state.failures >= threshold) {
        state.healthy = false;
        state.latencyMs = Number.POSITIVE_INFINITY;
      }
    }
    return state;
  }

  /**
   * Check every node once, right now. Used by the background sweep and by the
   * operator-facing "re-check now" action, so both paths share one code path.
   */
  async checkNow(): Promise<NodeState[]> {
    return this.checkAll();
  }

  start(intervalMs = this.options.checkIntervalMs ?? 15_000): void {
    if (this.timer) return;
    const run = async (): Promise<void> => {
      try {
        await this.checkAll();
      } catch (error) {
        this.options.log?.('warn', 'node health sweep failed', { error: (error as Error).message });
      }
    };
    void run();
    this.timer = setInterval(() => void run(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Public view, safe to serve to the browser. */
  summary(): Array<Omit<NodeState, 'successes' | 'failures'>> {
    return this.all()
      .sort((a, b) => this.score(b) - this.score(a))
      .map((state) => ({
        url: state.url,
        healthy: state.healthy,
        height: state.height,
        genesisId: state.genesisId,
        chainId: state.chainId,
        networkId: state.networkId,
        version: state.version,
        latencyMs: Number.isFinite(state.latencyMs) ? state.latencyMs : -1,
        lastCheckedAt: state.lastCheckedAt,
        lastError: state.lastError,
        wrongNetwork: state.wrongNetwork === true,
      }));
  }

  /** The height a majority of healthy nodes agree on (never a single node's). */
  consensusHeight(): number | undefined {
    const healthy = this.all().filter((state) => this.usable(state));
    if (healthy.length === 0) return undefined;
    const counts = new Map<number, number>();
    for (const state of healthy) counts.set(state.height, (counts.get(state.height) ?? 0) + 1);
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    return best?.[0];
  }

  /** Nodes whose tip disagrees with the network consensus height. */
  lagging(): NodeState[] {
    const consensus = this.consensusHeight();
    if (consensus === undefined) return [];
    return this.all().filter((state) => this.usable(state) && state.height < consensus);
  }

  get genesisMismatch(): boolean {
    const ids = new Set(this.all().filter((state) => state.healthy && state.genesisId).map((state) => state.genesisId));
    return ids.size > 1;
  }

  /** Healthy nodes that report a genesis id other than the majority one. */
  onDifferentChain(): NodeState[] {
    const majority = this.majorityGenesis();
    if (!majority) return [];
    return this.all().filter((state) => state.healthy && state.genesisId && state.genesisId !== majority);
  }
}

/**
 * Canonical node URL.
 *
 * Only http(s) is accepted: a node URL arrives from configuration or from a peer
 * list, and a scheme like `file:` or `data:` would turn the interface into a
 * local file reader. The host is lower-cased and the path is dropped, so the
 * same node can never be dialled twice under two spellings.
 */
export function normaliseNodeUrl(url: string): string {
  const trimmed = url.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`not a valid node url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported node url scheme: ${parsed.protocol}`);
  }
  if (!parsed.hostname) throw new Error(`node url has no host: ${url}`);
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${port}`;
}
