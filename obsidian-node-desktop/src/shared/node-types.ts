import type { ErrorInfo } from './errors.js';
import type { NetworkName } from './chain-types.js';

export type NodePhase = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface NodeProcessState {
  phase: NodePhase;
  network: NetworkName;
  pid?: number;
  startedAt?: number;
  rpcUrl: string;
  rpcPort: number;
  p2pPort: number;
  dataDir: string;
  keystorePath: string;
  chainDataPresent: boolean;
  /** Something other than this app already answers on the node's RPC port. */
  externalNodeDetected: boolean;
  error?: ErrorInfo;
  lastExit?: { code: number | null; signal: string | null; at: number };
  /** Plain-language description of the startup step in progress. */
  step?: string;
}
