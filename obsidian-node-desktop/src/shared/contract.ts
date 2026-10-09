/**
 * The IPC contract between the renderer and the main process.
 *
 * Every channel the renderer may call is listed here, with its request and response types.
 * The preload script exposes `invoke(channel, payload)` and refuses any channel that is not
 * in CHANNELS (the build generates the preload's allowlist from this file). The main process
 * validates every payload again; the renderer is never trusted. There is no channel that
 * reads or writes arbitrary files, runs a command, or returns a secret.
 */
import type { AddressHistory, BlockDetail, BlockSummary, MempoolInfo, NetworkName, TxRecord, ValidatorsInfo } from './chain-types.js';
import type { AppSettings, NodeSettings } from './settings-types.js';
import type { WalletStatus } from './wallet-types.js';
import type { LogEntry, LogSeverity } from './log-types.js';
import type { NodeProcessState } from './node-types.js';
import type { ExecuteResult, PreparedPlan, SubmissionRecord, TxStatus } from './tx-types.js';
import type { ValidatorView } from './validator-types.js';
import type { AppInfo, ChainSnapshot, DiagnosticCheck, NetworkDetail, Remote, SearchResult } from './view-types.js';

export const CHANNELS = {
  appInfo: 'app:info',
  appOpenExternal: 'app:open-external',
  settingsGet: 'settings:get',
  settingsNodeUpdate: 'settings:node-update',
  settingsUiUpdate: 'settings:ui-update',
  networkSwitch: 'network:switch',
  nodeState: 'node:state',
  nodeStart: 'node:start',
  nodeStop: 'node:stop',
  nodeRestart: 'node:restart',
  nodeLogs: 'node:logs',
  nodeLogsClear: 'node:logs-clear',
  chainSnapshot: 'chain:snapshot',
  chainDetail: 'chain:detail',
  explorerBlocks: 'explorer:blocks',
  explorerBlock: 'explorer:block',
  explorerTx: 'explorer:tx',
  explorerAddress: 'explorer:address',
  explorerMempool: 'explorer:mempool',
  explorerSearch: 'explorer:search',
  walletStatus: 'wallet:status',
  walletBeginCreate: 'wallet:begin-create',
  walletFinishCreate: 'wallet:finish-create',
  walletCancelCreate: 'wallet:cancel-create',
  walletImport: 'wallet:import',
  walletBalance: 'wallet:balance',
  walletHistory: 'wallet:history',
  walletRemove: 'wallet:remove',
  txPreparePayment: 'tx:prepare-payment',
  txExecute: 'tx:execute',
  txCancel: 'tx:cancel',
  txResubmit: 'tx:resubmit',
  txSubmissions: 'tx:submissions',
  txStatus: 'tx:status',
  validatorView: 'validator:view',
  validatorList: 'validator:list',
  validatorPrepare: 'validator:prepare',
  diagRun: 'diag:run',
  diagReport: 'diag:report',
  diagSave: 'diag:save',
} as const;

/** Events pushed from the main process. */
export const EVENTS = {
  nodeState: 'event:node-state',
  chain: 'event:chain',
  log: 'event:log',
} as const;

export interface SettingsView {
  settings: AppSettings;
  recovered: { reason: string; backup: string } | null;
}

export interface WalletBalanceView {
  address: string;
  balanceObs: string;
  nonce: number;
  txCount: number;
  atHeight: number;
}

export interface Api {
  'app:info': { req: void; res: AppInfo };
  'app:open-external': { req: { url: string }; res: void };
  'settings:get': { req: void; res: SettingsView };
  'settings:node-update': {
    req: { values: NodeSettings };
    res: { settings: AppSettings; changedFields: string[]; restartRequired: boolean };
  };
  'settings:ui-update': { req: { sidebarCollapsed: boolean }; res: AppSettings };
  'network:switch': { req: { network: NetworkName; restartNode: boolean; confirmNewChain?: boolean }; res: { state: NodeProcessState; startError?: { code: string; message: string } } };
  'node:state': { req: void; res: NodeProcessState };
  'node:start': { req: { confirmNewChain?: boolean }; res: NodeProcessState };
  'node:stop': { req: void; res: NodeProcessState };
  'node:restart': { req: { confirmNewChain?: boolean }; res: NodeProcessState };
  'node:logs': { req: { limit?: number; minSeverity?: LogSeverity; sinceId?: number }; res: LogEntry[] };
  'node:logs-clear': { req: void; res: void };
  'chain:snapshot': { req: void; res: ChainSnapshot };
  'chain:detail': { req: void; res: NetworkDetail };
  'explorer:blocks': { req: { beforeHeight?: number; limit?: number }; res: { blocks: BlockSummary[]; head: number } };
  'explorer:block': { req: { query: string }; res: BlockDetail };
  'explorer:tx': { req: { txId: string }; res: TxRecord };
  'explorer:address': { req: { address: string }; res: AddressHistory };
  'explorer:mempool': { req: void; res: MempoolInfo };
  'explorer:search': { req: { query: string }; res: SearchResult };
  'wallet:status': { req: void; res: WalletStatus };
  'wallet:begin-create': { req: void; res: { pendingId: string; phrase: string; confirmPositions: number[] } };
  'wallet:finish-create': { req: { pendingId: string; passphrase: string; confirmWords: string[] }; res: WalletStatus };
  'wallet:cancel-create': { req: { pendingId: string }; res: void };
  'wallet:import': { req: { phrase: string; passphrase: string }; res: WalletStatus };
  'wallet:balance': { req: void; res: Remote<WalletBalanceView> };
  'wallet:history': { req: void; res: Remote<AddressHistory> };
  'wallet:remove': { req: { passphrase: string }; res: void };
  'tx:prepare-payment': { req: { to: string; amountObs: string; memo?: string }; res: PreparedPlan };
  'tx:execute': { req: { prepareId: string; passphrase?: string }; res: ExecuteResult };
  'tx:cancel': { req: { prepareId: string }; res: void };
  'tx:resubmit': { req: { txId: string }; res: ExecuteResult };
  'tx:submissions': { req: void; res: SubmissionRecord[] };
  'tx:status': { req: { txId: string }; res: TxStatus };
  'validator:view': { req: void; res: ValidatorView };
  'validator:list': { req: void; res: Remote<ValidatorsInfo> };
  'validator:prepare': { req: { op: 'register' | 'unregister' | 'claim' }; res: PreparedPlan };
  'diag:run': { req: void; res: DiagnosticCheck[] };
  'diag:report': { req: void; res: { text: string } };
  'diag:save': { req: void; res: { saved: boolean; path?: string } };
}

export type ChannelName = keyof Api;
