import type { NetworkName } from './chain-types.js';

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface NodeSettings {
  nodeName: string;
  /** Block production by this node's identity (the core's `--mine` flag). */
  blockProduction: boolean;
  logLevel: LogLevel;
  /** Added to the network's default RPC and P2P ports (the core's `--port-offset`). */
  portOffset: number;
  /** `host:port` bootstrap peers. */
  seeds: string[];
}

export interface AppSettings {
  schemaVersion: 1;
  network: NetworkName;
  nodes: Record<NetworkName, NodeSettings>;
  ui: { sidebarCollapsed: boolean };
}
