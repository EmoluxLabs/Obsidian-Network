/**
 * Application settings: validated on read and on write.
 *
 * Settings only cover OPERATION (which network the app points at, node name, ports offset,
 * seeds, log level, whether this node produces blocks). They never cover consensus: those
 * values are protocol constants inside obsidian-core and cannot be set here.
 *
 * A node setting is applied when the node starts, so changing one while the node runs is
 * reported as "restart required" instead of pretending to apply it.
 */
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { NETWORK_NAMES, type NetworkName } from '../shared/chain-types.js';
import { LOG_LEVELS, type AppSettings, type LogLevel, type NodeSettings } from '../shared/settings-types.js';
import { writeFileAtomic } from './atomic-file.js';
import { SchemaError, isRecord } from './schema.js';

export { LOG_LEVELS, type LogLevel, type NodeSettings, type AppSettings };

/** Settings whose change needs a node restart to take effect. */
export const RESTART_REQUIRED_FIELDS: ReadonlyArray<keyof NodeSettings> = ['nodeName', 'blockProduction', 'logLevel', 'portOffset', 'seeds'];

export function defaultNodeSettings(network: NetworkName): NodeSettings {
  return {
    nodeName: `obsidian-node-${network}`,
    blockProduction: true,
    logLevel: 'info',
    portOffset: 0,
    seeds: [],
  };
}

export function defaultSettings(): AppSettings {
  return {
    schemaVersion: 1,
    // Testnet: the template's default and the only network where a first-time user cannot lose real funds.
    network: 'testnet',
    nodes: Object.fromEntries(NETWORK_NAMES.map((n) => [n, defaultNodeSettings(n)])) as Record<NetworkName, NodeSettings>,
    ui: { sidebarCollapsed: false },
  };
}

const SEED = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9a-fA-F:]+\]):\d{1,5}$/;

export function validateNodeSettings(value: unknown, path = 'node'): NodeSettings {
  if (!isRecord(value)) throw new SchemaError(path, 'expected an object');
  const nodeName = value.nodeName;
  if (typeof nodeName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,47}$/.test(nodeName)) {
    throw new SchemaError(`${path}.nodeName`, 'use 1–48 letters, digits, spaces, dots, dashes or underscores');
  }
  if (typeof value.blockProduction !== 'boolean') throw new SchemaError(`${path}.blockProduction`, 'expected true or false');
  if (typeof value.logLevel !== 'string' || !(LOG_LEVELS as readonly string[]).includes(value.logLevel)) {
    throw new SchemaError(`${path}.logLevel`, `expected one of ${LOG_LEVELS.join(', ')}`);
  }
  const offset = value.portOffset;
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0 || offset > 100) {
    throw new SchemaError(`${path}.portOffset`, 'expected a whole number from 0 to 100');
  }
  if (!Array.isArray(value.seeds) || value.seeds.length > 32) throw new SchemaError(`${path}.seeds`, 'expected a list of at most 32 host:port entries');
  const seeds = value.seeds.map((entry, i) => {
    if (typeof entry !== 'string' || !SEED.test(entry.trim())) throw new SchemaError(`${path}.seeds[${i}]`, 'expected host:port');
    const port = Number(entry.trim().split(':').pop());
    if (port < 1 || port > 65535) throw new SchemaError(`${path}.seeds[${i}]`, 'port out of range');
    return entry.trim();
  });
  return { nodeName, blockProduction: value.blockProduction, logLevel: value.logLevel as LogLevel, portOffset: offset, seeds };
}

export function validateSettings(value: unknown): AppSettings {
  if (!isRecord(value)) throw new SchemaError('settings', 'expected an object');
  if (value.schemaVersion !== 1) throw new SchemaError('settings.schemaVersion', 'unsupported settings version');
  if (typeof value.network !== 'string' || !(NETWORK_NAMES as readonly string[]).includes(value.network)) {
    throw new SchemaError('settings.network', `expected one of ${NETWORK_NAMES.join(', ')}`);
  }
  if (!isRecord(value.nodes)) throw new SchemaError('settings.nodes', 'expected an object');
  const nodes = {} as Record<NetworkName, NodeSettings>;
  for (const name of NETWORK_NAMES) nodes[name] = validateNodeSettings(value.nodes[name], `settings.nodes.${name}`);
  const ui = value.ui;
  if (!isRecord(ui) || typeof ui.sidebarCollapsed !== 'boolean') throw new SchemaError('settings.ui', 'expected { sidebarCollapsed: boolean }');
  return { schemaVersion: 1, network: value.network as NetworkName, nodes, ui: { sidebarCollapsed: ui.sidebarCollapsed } };
}

export interface LoadedSettings {
  settings: AppSettings;
  /** Set when the file on disk was unreadable and defaults were used instead. */
  recovered?: { reason: string; backup: string };
}

export class SettingsStore {
  private current: AppSettings;
  readonly recovered?: { reason: string; backup: string };

  constructor(private readonly path: string) {
    const loaded = SettingsStore.load(path);
    this.current = loaded.settings;
    this.recovered = loaded.recovered;
  }

  static load(path: string): LoadedSettings {
    if (!existsSync(path)) return { settings: defaultSettings() };
    try {
      return { settings: validateSettings(JSON.parse(readFileSync(path, 'utf8'))) };
    } catch (error) {
      // Never silently discard what is on disk: keep it beside the defaults and say so.
      const backup = `${path}.invalid-${Date.now()}`;
      try {
        renameSync(path, backup);
      } catch {
        /* keep going with defaults */
      }
      return { settings: defaultSettings(), recovered: { reason: (error as Error).message, backup } };
    }
  }

  get(): AppSettings {
    return structuredClone(this.current);
  }

  /** Apply a validated change. Returns which node settings changed (so the caller can report restart-required). */
  update(patch: {
    network?: NetworkName;
    node?: { network: NetworkName; values: NodeSettings };
    ui?: Partial<AppSettings['ui']>;
  }): { settings: AppSettings; changedNodeFields: Array<keyof NodeSettings> } {
    const next = structuredClone(this.current);
    const changed: Array<keyof NodeSettings> = [];
    if (patch.network) next.network = patch.network;
    if (patch.node) {
      const values = validateNodeSettings(patch.node.values);
      const before = next.nodes[patch.node.network];
      for (const key of Object.keys(values) as Array<keyof NodeSettings>) {
        if (JSON.stringify(before[key]) !== JSON.stringify(values[key])) changed.push(key);
      }
      next.nodes[patch.node.network] = values;
    }
    if (patch.ui) next.ui = { ...next.ui, ...patch.ui };
    const validated = validateSettings(next);
    writeFileAtomic(this.path, `${JSON.stringify(validated, null, 2)}\n`, 0o600);
    this.current = validated;
    return { settings: structuredClone(validated), changedNodeFields: changed };
  }
}
