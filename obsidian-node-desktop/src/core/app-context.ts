/**
 * Composition root: builds every service once. Framework independent — the Electron main
 * process and the development test bridge both call this, so the UI is driven by exactly the
 * same code in both.
 */
import { createPaths, type AppPaths } from './paths.js';
import { SettingsStore } from './settings.js';
import { LogBuffer } from './log-buffer.js';
import { loadCore, readCoreManifest, resolveCoreDir, type CoreModules } from './core-loader.js';
import { NodeSupervisor } from './node-supervisor.js';
import { ChainService } from './chain-service.js';
import { WalletService } from './wallet-service.js';
import { TxService } from './tx-service.js';
import { PaymentService } from './payment-service.js';
import { ValidatorService } from './validator-service.js';
import { ExplorerService } from './explorer-service.js';
import { DiagnosticsService } from './diagnostics-service.js';

export interface PlatformInfo {
  appName: string;
  appVersion: string;
  userDataDir: string;
  hostScript: string;
  execPath?: string;
  templateSha256: string;
  repository: string;
  versions: { electron: string; chromium: string; node: string; platform: string; arch: string };
}

export interface AppContext {
  platform: PlatformInfo;
  paths: AppPaths;
  settings: SettingsStore;
  logs: LogBuffer;
  core: () => Promise<CoreModules>;
  supervisor: NodeSupervisor;
  chain: ChainService;
  wallets: WalletService;
  tx: TxService;
  payments: PaymentService;
  validators: ValidatorService;
  explorer: ExplorerService;
  diagnostics: DiagnosticsService;
  dispose(): Promise<void>;
}

export function createContext(platform: PlatformInfo, overrides: { coreDir?: string; readyTimeoutMs?: number } = {}): AppContext {
  const paths = createPaths(platform.userDataDir);
  const settings = new SettingsStore(paths.settings);
  const logs = new LogBuffer(2000, paths.forNetwork(settings.get().network).log);
  const coreDir = overrides.coreDir ?? resolveCoreDir();
  const core = (): Promise<CoreModules> => loadCore(coreDir);
  const supervisor = new NodeSupervisor({
    paths,
    settings,
    logs,
    core,
    hostScript: platform.hostScript,
    execPath: platform.execPath,
    readyTimeoutMs: overrides.readyTimeoutMs,
  });
  const chain = new ChainService({ supervisor });
  const wallets = new WalletService(paths, core);
  let validators!: ValidatorService;
  const tx = new TxService({
    core,
    wallets,
    rpc: (network) => chain.rpc(network),
    nodeIdentity: (network) => validators.identityKey(network),
    logs,
  });
  const payments = new PaymentService({ core, wallets, tx, rpc: (network) => chain.rpc(network) });
  validators = new ValidatorService({ core, paths, supervisor, tx, rpcIfRunning: (network) => chain.rpcIfRunning(network) });
  const explorer = new ExplorerService(chain, core, () => supervisor.network);
  const diagnostics = new DiagnosticsService({
    core,
    paths,
    supervisor,
    chain,
    logs,
    settings,
    appVersion: platform.appVersion,
    versions: () => ({ ...platform.versions, core: readCoreManifest(coreDir)?.version ?? 'not found' }),
  });
  if (settings.recovered) logs.app('WARN', `settings file was unreadable (${settings.recovered.reason}); defaults were used and the old file was kept at ${settings.recovered.backup}`, 'settings');
  chain.start();
  return {
    platform,
    paths,
    settings,
    logs,
    core,
    supervisor,
    chain,
    wallets,
    tx,
    payments,
    validators,
    explorer,
    diagnostics,
    async dispose() {
      chain.stop();
      await supervisor.dispose();
    },
  };
}
