/**
 * Edge-side discovery of the current primary.
 *
 * An edge has no account store and no key. When several primary-capable hosts exist, only one holds the lease at a time;
 * the edge probes the configured hosts' /api/ready and remembers which one reports `leader.state === "leader"`, so its
 * refusal can name where to sign in. It decides nothing about safety: a standby refuses stateful routes by itself, so a
 * wrong or stale answer here costs a retry, never a wrong write. It only ever contacts the operator's configured URLs
 * (no redirects, bounded body, short timeout, no credentials), so it is not an SSRF primitive.
 */

export interface DiscoveredPrimary {
  url: string | null;
  checkedAt: number | null;
  candidates: Array<{ url: string; reachable: boolean; leader: boolean }>;
}

export class PrimaryDiscovery {
  private result: DiscoveredPrimary = { url: null, checkedAt: null, candidates: [] };
  private timer?: NodeJS.Timeout;
  private inFlight?: Promise<void>;

  constructor(
    private readonly urls: string[],
    private readonly options: { intervalMs?: number; timeoutMs?: number; fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {}

  current(): DiscoveredPrimary {
    return this.result;
  }

  start(): void {
    if (this.timer || this.urls.length === 0) return;
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.options.intervalMs ?? 5_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  probe(): Promise<void> {
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const now = this.options.now ?? Date.now;
    const candidates = await Promise.all(
      this.urls.map(async (url) => {
        try {
          const response = await doFetch(`${url}/api/ready`, {
            redirect: 'error',
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
            headers: { accept: 'application/json' },
          });
          const text = (await response.text()).slice(0, 8_192);
          const body = JSON.parse(text) as { leader?: { state?: string } };
          return { url, reachable: true, leader: body.leader?.state === 'leader' };
        } catch {
          return { url, reachable: false, leader: false };
        }
      }),
    );
    const leaders = candidates.filter((candidate) => candidate.leader);
    // Two hosts both claiming leadership is a fault, not a tie to break: name nobody.
    this.result = { url: leaders.length === 1 ? leaders[0]!.url : null, checkedAt: now(), candidates };
  }
}
