/** The renderer's only way to reach the main process: typed calls over the preload bridge. */
import type { Api, ChannelName } from '../shared/contract.js';
import type { ErrorInfo, Result } from '../shared/errors.js';

interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<Result<unknown>>;
  on(event: string, listener: (data: unknown) => void): () => void;
}

declare global {
  interface Window {
    obsidian?: Bridge;
  }
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function bridge(): Bridge {
  if (!window.obsidian) throw new ApiError('NO_BRIDGE', 'The application bridge is not available.');
  return window.obsidian;
}

export async function call<K extends ChannelName>(channel: K, payload?: Api[K]['req']): Promise<Api[K]['res']> {
  let result: Result<unknown>;
  try {
    result = await bridge().invoke(channel, payload);
  } catch (error) {
    throw new ApiError('IPC_FAILED', (error as Error).message);
  }
  if (!result || typeof result !== 'object' || typeof (result as { ok?: unknown }).ok !== 'boolean') throw new ApiError('IPC_MALFORMED', 'The application returned an unreadable answer.');
  if (result.ok) return result.data as Api[K]['res'];
  const err: ErrorInfo = result.error;
  throw new ApiError(err.code, err.message, err.details);
}

export function subscribe(event: string, listener: (data: unknown) => void): () => void {
  return window.obsidian ? window.obsidian.on(event, listener) : () => {};
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : (error as Error)?.message ?? 'Something went wrong.';
}
