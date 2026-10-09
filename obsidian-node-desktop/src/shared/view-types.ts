import type { FinalityInfo, HealthInfo, NetworkName, ParamsInfo, PeersInfo, PotInfo, StatusInfo } from './chain-types.js';

/** `loading` before the first answer, `unavailable` when the source cannot be reached, `error` when it answered wrongly. */
export type Remote<T> =
  | { state: 'loading' }
  | { state: 'unavailable'; message: string }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: T; at: number };

export type LinkState = 'stopped' | 'starting' | 'connecting' | 'connected' | 'lost';

export interface ChainSnapshot {
  network: NetworkName;
  link: LinkState;
  /** When the last successful poll finished (epoch ms), or null. */
  at: number | null;
  health: HealthInfo | null;
  status: StatusInfo | null;
  /** Seconds between the node's chain time and its head block's timestamp. */
  headAgeSeconds: number | null;
  syncTargetHeight: number | null;
  failures: number;
  lastError: string | null;
}

export interface NetworkDetail {
  peers: Remote<PeersInfo>;
  pot: Remote<PotInfo>;
  finality: Remote<FinalityInfo>;
  params: Remote<ParamsInfo>;
}

export interface AppInfo {
  appName: string;
  appVersion: string;
  electron: string;
  chromium: string;
  node: string;
  platform: string;
  arch: string;
  core: { version: string; sourceCommit: string; protocolVersion: string; paramsHash: string; buildId: string; dir: string } | null;
  coreError: string | null;
  userDataDir: string;
  repository: string;
  license: string;
  templateSha256: string;
}

export interface DiagnosticCheck {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
}

export type SearchResult =
  | { kind: 'block'; query: string }
  | { kind: 'tx'; query: string }
  | { kind: 'address'; query: string }
  | { kind: 'none'; query: string; message: string };
