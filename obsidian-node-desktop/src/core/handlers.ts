/**
 * The handler registry: one function per IPC channel. Each validates its payload (the
 * renderer is not trusted), calls the real service, and returns data or throws an AppError.
 * Wallet and signing handlers always act on the network the app is currently pointed at; no
 * handler accepts a network for signing from the renderer.
 */
import { CHANNELS, EVENTS, type Api, type ChannelName, type WalletBalanceView } from '../shared/contract.js';
import { AppError, type ErrorInfo, type Result } from '../shared/errors.js';
import { NETWORK_NAMES, type NetworkName } from '../shared/chain-types.js';
import type { AppInfo, Remote } from '../shared/view-types.js';
import type { LogSeverity } from '../shared/log-types.js';
import { RESTART_REQUIRED_FIELDS } from './settings.js';
import { readCoreManifest, resolveCoreDir } from './core-loader.js';
import type { AppContext } from './app-context.js';
import { failure } from './chain-service.js';
import { RpcError } from './rpc-client.js';
import { SchemaError, isRecord } from './schema.js';
import { redactText } from './redact.js';

export interface PlatformActions {
  openExternal(url: string): Promise<void>;
  /** Show a save dialog and write the text. Return saved:false if the user cancelled. */
  saveText(suggestedName: string, text: string): Promise<{ saved: boolean; path?: string }>;
}

type Handler<K extends ChannelName> = (payload: Api[K]['req']) => Promise<Api[K]['res']>;
export type Handlers = { [K in ChannelName]: Handler<K> };

const EXTERNAL_ALLOWLIST = [/^https:\/\/github\.com\/EmoluxLabs\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._\-/#?=&]*)?$/];

/**
 * May the app hand this URL to the operating system's browser? Only this organisation's repositories on GitHub.
 * A dot segment is refused outright: `https://github.com/EmoluxLabs/x/../../someone-else/repo` matches the shape
 * and is resolved by GitHub to another organisation's page.
 */
export function isAllowedExternalLink(url: string): boolean {
  return !url.includes('..') && !/%2e|%2f|%5c|\\/i.test(url) && EXTERNAL_ALLOWLIST.some((re) => re.test(url));
}

function payloadObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new AppError('BAD_REQUEST', 'The request was malformed.');
  return value;
}
function reqString(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new AppError('BAD_REQUEST', `${name} is missing or too long.`);
  return value;
}
function optBool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}
function optInt(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new AppError('BAD_REQUEST', `${name} is out of range.`);
  return value;
}
function networkName(value: unknown): NetworkName {
  if (typeof value !== 'string' || !(NETWORK_NAMES as readonly string[]).includes(value)) throw new AppError('BAD_REQUEST', 'Unknown network.');
  return value as NetworkName;
}

export function createHandlers(ctx: AppContext, platform: PlatformActions): Handlers {
  const network = (): NetworkName => ctx.supervisor.network;

  async function remote<T>(load: () => Promise<T>): Promise<Remote<T>> {
    try {
      return { state: 'ready', data: await load(), at: Date.now() };
    } catch (error) {
      if (error instanceof AppError && error.code === 'NODE_NOT_RUNNING') return { state: 'unavailable', message: error.message };
      return failure(error);
    }
  }

  const handlers: Handlers = {
    'app:info': async () => {
      const dir = resolveCoreDir();
      const manifest = readCoreManifest(dir);
      let core: AppInfo['core'] = null;
      let coreError: string | null = null;
      try {
        const modules = await ctx.core();
        core = {
          version: modules.version.CORE_VERSION,
          sourceCommit: manifest?.sourceCommit ?? 'unknown',
          protocolVersion: modules.version.PROTOCOL_VERSION,
          paramsHash: modules.stateRoot.PARAMS_HASH,
          buildId: modules.version.BUILD_ID,
          dir: redactText(modules.dir),
        };
      } catch (error) {
        coreError = (error as Error).message;
      }
      return {
        appName: ctx.platform.appName,
        appVersion: ctx.platform.appVersion,
        electron: ctx.platform.versions.electron,
        chromium: ctx.platform.versions.chromium,
        node: ctx.platform.versions.node,
        platform: ctx.platform.versions.platform,
        arch: ctx.platform.versions.arch,
        core,
        coreError,
        userDataDir: redactText(ctx.platform.userDataDir),
        repository: ctx.platform.repository,
        license: 'Apache-2.0',
        templateSha256: ctx.platform.templateSha256,
      };
    },

    'app:open-external': async (raw) => {
      const url = reqString(payloadObject(raw).url, 'url', 300);
      if (!isAllowedExternalLink(url)) throw new AppError('LINK_NOT_ALLOWED', 'That link is not one the app opens.');
      await platform.openExternal(url);
    },

    'settings:get': async () => ({ settings: ctx.settings.get(), recovered: ctx.settings.recovered ?? null }),

    'settings:node-update': async (raw) => {
      const body = payloadObject(raw);
      const current = network();
      let result;
      try {
        result = ctx.settings.update({ node: { network: current, values: body.values as never } });
      } catch (error) {
        if (error instanceof SchemaError) throw new AppError('INVALID_SETTING', error.message.replace(/^node\./, ''));
        throw error;
      }
      const restartRequired = ctx.supervisor.isActive() && result.changedNodeFields.some((f) => RESTART_REQUIRED_FIELDS.includes(f));
      if (!ctx.supervisor.isActive()) await ctx.supervisor.refreshPorts();
      ctx.logs.app('INFO', `settings changed for ${current}: ${result.changedNodeFields.join(', ') || 'nothing'}`, 'settings');
      return { settings: result.settings, changedFields: result.changedNodeFields, restartRequired };
    },

    'settings:ui-update': async (raw) => {
      const flag = optBool(payloadObject(raw).sidebarCollapsed);
      if (flag === undefined) throw new AppError('BAD_REQUEST', 'sidebarCollapsed must be true or false.');
      return ctx.settings.update({ ui: { sidebarCollapsed: flag } }).settings;
    },

    'network:switch': async (raw) => {
      const body = payloadObject(raw);
      const target = networkName(body.network);
      const wasActive = ctx.supervisor.isActive();
      if (target === network() && !wasActive) return { state: ctx.supervisor.state() };
      if (wasActive) await ctx.supervisor.stop();
      ctx.settings.update({ network: target });
      await ctx.supervisor.selectNetwork(target);
      ctx.logs.setFile(ctx.paths.forNetwork(target).log);
      ctx.logs.app('INFO', `network changed to ${target}`, 'settings');
      if (wasActive && body.restartNode === true) {
        try {
          return { state: await ctx.supervisor.start({ confirmNewChain: optBool(body.confirmNewChain) }) };
        } catch (error) {
          return { state: ctx.supervisor.state(), startError: toErrorInfo(error) };
        }
      }
      return { state: ctx.supervisor.state() };
    },

    'node:state': async () => ctx.supervisor.state(),
    'node:start': async (raw) => ctx.supervisor.start({ confirmNewChain: optBool(payloadObject(raw).confirmNewChain) }),
    'node:stop': async () => ctx.supervisor.stop(),
    'node:restart': async (raw) => ctx.supervisor.restart({ confirmNewChain: optBool(payloadObject(raw).confirmNewChain) }),

    'node:logs': async (raw) => {
      const body = payloadObject(raw);
      const sev = body.minSeverity;
      if (sev !== undefined && !['DEBUG', 'INFO', 'WARN', 'ERROR'].includes(String(sev))) throw new AppError('BAD_REQUEST', 'Unknown severity.');
      return ctx.logs.recent({
        limit: optInt(body.limit, 'limit', 1, 2000) ?? 500,
        minSeverity: sev as LogSeverity | undefined,
        sinceId: optInt(body.sinceId, 'sinceId', 0, Number.MAX_SAFE_INTEGER),
      });
    },
    'node:logs-clear': async () => ctx.logs.clear(),

    'chain:snapshot': async () => ctx.chain.snapshot(),
    'chain:detail': async () => ctx.chain.detail(),

    'explorer:blocks': async (raw) => {
      const body = payloadObject(raw);
      return ctx.explorer.blocks({ beforeHeight: optInt(body.beforeHeight, 'beforeHeight', 0, Number.MAX_SAFE_INTEGER), limit: optInt(body.limit, 'limit', 1, 100) });
    },
    'explorer:block': async (raw) => ctx.explorer.block(reqString(payloadObject(raw).query, 'query', 80)),
    'explorer:tx': async (raw) => ctx.explorer.tx(reqString(payloadObject(raw).txId, 'txId', 80)),
    'explorer:address': async (raw) => ctx.explorer.address(reqString(payloadObject(raw).address, 'address', 120)),
    'explorer:mempool': async () => ctx.explorer.mempool(),
    'explorer:search': async (raw) => ctx.explorer.search(reqString(payloadObject(raw).query, 'query', 200, 0)),

    'wallet:status': async () => ctx.wallets.status(network()),
    'wallet:begin-create': async () => ctx.wallets.beginCreate(network()),
    'wallet:finish-create': async (raw) => {
      const body = payloadObject(raw);
      const words = body.confirmWords;
      if (!Array.isArray(words) || words.length !== 3 || words.some((w) => typeof w !== 'string' || w.length > 32)) throw new AppError('BAD_REQUEST', 'Enter the three requested words.');
      return ctx.wallets.finishCreate({ pendingId: reqString(body.pendingId, 'pendingId', 80), passphrase: reqString(body.passphrase, 'passphrase', 256), confirmWords: words as string[] });
    },
    'wallet:cancel-create': async (raw) => ctx.wallets.cancelCreate(reqString(payloadObject(raw).pendingId, 'pendingId', 80)),
    'wallet:import': async (raw) => {
      const body = payloadObject(raw);
      return ctx.wallets.importPhrase(network(), reqString(body.phrase, 'phrase', 1000), reqString(body.passphrase, 'passphrase', 256));
    },
    'wallet:balance': async () => {
      const status = await ctx.wallets.status(network());
      if (!status.exists || !status.address) throw new AppError('NO_WALLET', 'There is no wallet on this network yet.');
      const address = status.address;
      return remote<WalletBalanceView>(async () => {
        const b = await ctx.chain.rpc(network()).walletBalance(address);
        return { address: b.address, balanceObs: b.balanceObs, nonce: b.nonce, txCount: b.txCount, atHeight: b.atHeight };
      });
    },
    'wallet:history': async () => {
      const status = await ctx.wallets.status(network());
      if (!status.exists || !status.address) throw new AppError('NO_WALLET', 'There is no wallet on this network yet.');
      const address = status.address;
      return remote(() => ctx.chain.rpc(network()).addressHistory(address, 50));
    },
    'wallet:remove': async (raw) => ctx.wallets.remove(network(), reqString(payloadObject(raw).passphrase, 'passphrase', 256)),

    'tx:prepare-payment': async (raw) => {
      const body = payloadObject(raw);
      return ctx.payments.prepare(network(), {
        to: reqString(body.to, 'to', 120),
        amountObs: reqString(body.amountObs, 'amountObs', 64),
        memo: body.memo === undefined ? undefined : reqString(body.memo, 'memo', 400, 0),
      });
    },
    'tx:execute': async (raw) => {
      const body = payloadObject(raw);
      return ctx.tx.execute(reqString(body.prepareId, 'prepareId', 80), { passphrase: body.passphrase === undefined ? undefined : reqString(body.passphrase, 'passphrase', 256) });
    },
    'tx:cancel': async (raw) => ctx.tx.cancel(reqString(payloadObject(raw).prepareId, 'prepareId', 80)),
    'tx:resubmit': async (raw) => ctx.tx.resubmit(reqString(payloadObject(raw).txId, 'txId', 80)),
    'tx:submissions': async () => ctx.tx.list(network()),
    'tx:status': async (raw) => ctx.tx.status(network(), reqString(payloadObject(raw).txId, 'txId', 80)),

    'validator:view': async () => ctx.validators.view(network()),
    'validator:list': async () => remote(() => ctx.chain.read('validators', (c) => c.validators())),
    'validator:prepare': async (raw) => {
      const op = payloadObject(raw).op;
      if (op !== 'register' && op !== 'unregister' && op !== 'claim') throw new AppError('BAD_REQUEST', 'Unknown validator operation.');
      return ctx.validators.prepare(network(), op);
    },

    'diag:run': async () => ctx.diagnostics.run(),
    'diag:report': async () => ({ text: await ctx.diagnostics.report() }),
    'diag:save': async () => {
      const text = await ctx.diagnostics.report();
      return platform.saveText(`obsidian-node-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`, text);
    },
  };

  // Compile-time guarantee that the registry covers exactly the contract.
  const unused: ReadonlyArray<string> = Object.values(CHANNELS).filter((c) => !(c in handlers));
  if (unused.length > 0) throw new Error(`channels without a handler: ${unused.join(', ')}`);
  return handlers;
}

export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof AppError) return { code: error.code, message: error.message, details: error.details };
  if (error instanceof RpcError) {
    const map: Record<string, string> = { unavailable: 'NODE_UNREACHABLE', timeout: 'NODE_TIMEOUT', malformed: 'NODE_MALFORMED', 'too-large': 'NODE_MALFORMED', refused: 'RPC_REFUSED', http: error.code ?? 'NODE_ERROR' };
    return { code: map[error.kind] ?? 'NODE_ERROR', message: redactText(error.message) };
  }
  if (error instanceof SchemaError) return { code: 'NODE_MALFORMED', message: redactText(error.message) };
  return { code: 'INTERNAL', message: redactText((error as Error)?.message ?? 'Something went wrong.') };
}

/** Invoke a handler by channel name and wrap the outcome in a Result. The only entry point for IPC. */
export async function dispatch(handlers: Handlers, channel: string, payload: unknown): Promise<Result<unknown>> {
  if (!(channel in handlers)) return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: 'That action is not available.' } };
  try {
    const handler = handlers[channel as ChannelName] as (p: unknown) => Promise<unknown>;
    return { ok: true, data: (await handler(payload)) ?? null };
  } catch (error) {
    return { ok: false, error: toErrorInfo(error) };
  }
}

/** Subscribe the pushed events to a sender. Returns an unsubscribe function. */
export function wireEvents(ctx: AppContext, send: (event: string, data: unknown) => void): () => void {
  const onState = (state: unknown): void => send(EVENTS.nodeState, state);
  const onSnapshot = (snap: unknown): void => send(EVENTS.chain, snap);
  ctx.supervisor.on('state', onState);
  ctx.chain.on('snapshot', onSnapshot);
  const offLog = ctx.logs.onEntry((entry) => send(EVENTS.log, entry));
  return () => {
    ctx.supervisor.off('state', onState);
    ctx.chain.off('snapshot', onSnapshot);
    offLog();
  };
}
