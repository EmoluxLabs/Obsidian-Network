import { call } from '../api.js';
import { requestRender } from '../ui.js';
import type { Remote } from '../../shared/view-types.js';

export interface Screen {
  enter?(): void;
  leave?(): void;
  render(): import('../dom.js').Html;
}

/** Runs `fn` now and then every `ms` while started. Overlapping runs are skipped. */
export function poller(fn: () => Promise<void>, ms: number): { start(): void; stop(): void; now(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch {
      /* each screen records its own failures */
    } finally {
      busy = false;
      requestRender();
    }
  };
  return {
    start() {
      void tick();
      timer = setInterval(() => void tick(), ms);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
    now() {
      void tick();
    },
  };
}

export type Loadable<T> = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | Remote<T>;

export async function load<T>(fn: () => Promise<T>): Promise<Loadable<T>> {
  try {
    return { state: 'ready', data: await fn(), at: Date.now() };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'NODE_NOT_RUNNING') return { state: 'unavailable', message: (error as Error).message };
    return { state: 'error', message: (error as Error).message };
  }
}

export { call };
