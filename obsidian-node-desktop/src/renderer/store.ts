/** Application state shared by all screens. Everything here comes from the main process; nothing is invented. */
import type { AppSettings } from '../shared/settings-types.js';
import type { LogEntry } from '../shared/log-types.js';
import type { NodeProcessState } from '../shared/node-types.js';
import type { AppInfo, ChainSnapshot } from '../shared/view-types.js';

export const ROUTES = ['overview', 'node', 'network', 'validator', 'wallet', 'tx', 'explorer', 'logs', 'settings', 'help'] as const;
export type Route = (typeof ROUTES)[number];

export const NAV: ReadonlyArray<{ id: Route; label: string; icon: string }> = [
  { id: 'overview', label: 'Overview', icon: 'M3 11l9-8 9 8v9H3z' },
  { id: 'node', label: 'Node', icon: 'M4 5h16v5H4zM4 14h16v5H4z' },
  { id: 'network', label: 'Network', icon: 'M12 4v8M12 12l-6 7M12 12l6 7' },
  { id: 'validator', label: 'Validator Centre', icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z' },
  { id: 'wallet', label: 'Wallet', icon: 'M3 7h18v12H3zM3 7l3-3h12M16 13h2' },
  { id: 'tx', label: 'Transactions', icon: 'M4 8h14l-3-3M20 16H6l3 3' },
  { id: 'explorer', label: 'Blockchain Explorer', icon: 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-5-5' },
  { id: 'logs', label: 'Logs & Diagnostics', icon: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5' },
  { id: 'settings', label: 'Settings', icon: 'M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v3M12 19v3M2 12h3M19 12h3' },
  { id: 'help', label: 'Help & Support', icon: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4M12 17h.01' },
];

export const NETWORK_INFO: Record<string, { label: string; tone: Tone; blurb: string }> = {
  mainnet: { label: 'Mainnet', tone: 'wn', blurb: 'Production network. Real funds.' },
  testnet: { label: 'Testnet', tone: 'in', blurb: 'Public test network. No real value.' },
  staging: { label: 'Staging', tone: 'vi', blurb: 'Pre-release verification.' },
  devnet: { label: 'Devnet', tone: 'ok', blurb: 'Local development and experiments.' },
};

export type Tone = 'ok' | 'wn' | 'er' | 'in' | 'vi' | 'mu';

export interface Store {
  route: Route;
  ready: boolean;
  bootError: string | null;
  settings: AppSettings | null;
  settingsRecovered: { reason: string; backup: string } | null;
  node: NodeProcessState | null;
  snap: ChainSnapshot | null;
  appInfo: AppInfo | null;
  logs: LogEntry[];
  menuOpen: boolean;
  /** Epoch ms the node was last seen in the running phase; for uptime display. */
  now: number;
}

export const store: Store = {
  route: 'overview',
  ready: false,
  bootError: null,
  settings: null,
  settingsRecovered: null,
  node: null,
  snap: null,
  appInfo: null,
  logs: [],
  menuOpen: false,
  now: Date.now(),
};

export const LOG_CAP = 1500;

export type DisplayState = 'stopped' | 'starting' | 'connecting' | 'syncing' | 'synced' | 'lost' | 'stopping' | 'failed';

/** The state shown to the user. "Running" is never shown unless the node itself answered. */
export function displayState(): DisplayState {
  const node = store.node;
  if (!node) return 'stopped';
  switch (node.phase) {
    case 'stopped':
      return 'stopped';
    case 'failed':
      return 'failed';
    case 'starting':
      return 'starting';
    case 'stopping':
      return 'stopping';
    case 'running': {
      const snap = store.snap;
      if (!snap || snap.link === 'connecting' || snap.link === 'starting' || snap.link === 'stopped') return 'connecting';
      if (snap.link === 'lost') return 'lost';
      return snap.health?.syncing ? 'syncing' : 'synced';
    }
  }
}

export const DISPLAY: Record<DisplayState, { title: string; tone: Tone; text: string; badge: string }> = {
  stopped: { title: 'Node stopped', tone: 'mu', text: 'The node is not running. Start it to join the network.', badge: 'STOPPED' },
  starting: { title: 'Starting node…', tone: 'wn', text: 'Preparing the node process and opening its database.', badge: 'STARTING' },
  connecting: { title: 'Node started · waiting for it to answer', tone: 'wn', text: 'The process is up; the app is waiting for its first verified answer.', badge: 'CONNECTING' },
  syncing: { title: 'Synchronizing', tone: 'in', text: 'Downloading and verifying blocks. Not ready for ordinary use yet.', badge: 'SYNCING' },
  synced: { title: 'Node running · synchronized', tone: 'ok', text: 'Verified up to the latest block this node has accepted.', badge: 'SYNCHRONIZED' },
  lost: { title: 'Connection to the node lost', tone: 'er', text: 'The node process is running but has stopped answering. Numbers shown are the last known values.', badge: 'NOT RESPONDING' },
  stopping: { title: 'Stopping node…', tone: 'wn', text: 'Shutting the node down safely.', badge: 'STOPPING' },
  failed: { title: 'Node failed', tone: 'er', text: 'The node stopped unexpectedly or could not start.', badge: 'FAILED' },
};

export function networkLabel(name: string | undefined): string {
  return NETWORK_INFO[name ?? '']?.label ?? '—';
}

export function currentNetwork(): string {
  return store.settings?.network ?? store.node?.network ?? 'testnet';
}
