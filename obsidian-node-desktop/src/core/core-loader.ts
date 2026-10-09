/**
 * Locate and load the staged Obsidian Core.
 *
 * The app reuses the node's own implementations (keys, mnemonic, amounts, transaction
 * encoding, validator body encoding, keystore, network table). They are loaded from the
 * staged core directory at run time rather than copied, so there is exactly one
 * implementation of each. If the core directory is missing the app says so; it never
 * falls back to a local reimplementation.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import type * as Keys from '../../vendor/obsidian-core/dist/crypto/keys.js';
import type * as Mnemonic from '../../vendor/obsidian-core/dist/crypto/mnemonic.js';
import type * as Amount from '../../vendor/obsidian-core/dist/protocol/amount.js';
import type * as Types from '../../vendor/obsidian-core/dist/protocol/types.js';
import type * as Networks from '../../vendor/obsidian-core/dist/protocol/networks.js';
import type * as Encode from '../../vendor/obsidian-core/dist/transactions/encode.js';
import type * as Helpers from '../../vendor/obsidian-core/dist/transactions/helpers.js';
import type * as Payment from '../../vendor/obsidian-core/dist/transactions/executors/payment.js';
import type * as Validator from '../../vendor/obsidian-core/dist/transactions/executors/validator.js';
import type * as KeystoreMod from '../../vendor/obsidian-core/dist/crypto/keystore.js';
import type * as ParamsMod from '../../vendor/obsidian-core/dist/protocol/params.js';
import type * as IndexerMod from '../../vendor/obsidian-core/dist/indexer/indexer.js';
import type * as StateRootMod from '../../vendor/obsidian-core/dist/blockchain/state-root.js';
import type * as Version from '../../vendor/obsidian-core/dist/version.js';

export interface CoreModules {
  dir: string;
  keys: typeof Keys;
  mnemonic: typeof Mnemonic;
  amount: typeof Amount;
  types: typeof Types;
  networks: typeof Networks;
  encode: typeof Encode;
  helpers: typeof Helpers;
  payment: typeof Payment;
  validator: typeof Validator;
  keystore: typeof KeystoreMod;
  version: typeof Version;
  params: typeof ParamsMod;
  indexer: typeof IndexerMod;
  stateRoot: typeof StateRootMod;
}

export interface CoreManifest {
  dir: string;
  version: string;
  sourceCommit: string;
}

/** Where the staged core lives. Packaged: <resources>/obsidian-core. Development: vendor/obsidian-core. */
export function resolveCoreDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OBSIDIAN_CORE_DIR) return resolve(env.OBSIDIAN_CORE_DIR);
  const resources = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resources && existsSync(join(resources, 'obsidian-core', 'dist', 'node.js'))) {
    return join(resources, 'obsidian-core');
  }
  // dist/core/core-loader.js → repository root is two levels up
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', 'vendor', 'obsidian-core');
}

export function readCoreManifest(dir: string): CoreManifest | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
    let sourceCommit = 'unknown';
    try {
      const staged = JSON.parse(readFileSync(join(dir, 'STAGED.json'), 'utf8')) as { sourceCommit?: string };
      sourceCommit = staged.sourceCommit ?? 'unknown';
    } catch {
      /* not staged by the script */
    }
    return { dir, version: String(pkg.version ?? 'unknown'), sourceCommit };
  } catch {
    return null;
  }
}

let cached: Promise<CoreModules> | undefined;

export function loadCore(dir: string = resolveCoreDir()): Promise<CoreModules> {
  if (cached) return cached;
  cached = (async () => {
    if (!existsSync(join(dir, 'dist', 'node.js'))) {
      throw new Error(
        `Obsidian Core was not found at ${dir}. Run "npm run stage:core" (development) or reinstall the application.`,
      );
    }
    const load = <T>(rel: string): Promise<T> => import(pathToFileURL(join(dir, 'dist', rel)).href) as Promise<T>;
    const [keys, mnemonic, amount, types, networks, encode, helpers, payment, validator, keystore, version, params, indexer, stateRoot] =
      await Promise.all([
        load<typeof Keys>('crypto/keys.js'),
        load<typeof Mnemonic>('crypto/mnemonic.js'),
        load<typeof Amount>('protocol/amount.js'),
        load<typeof Types>('protocol/types.js'),
        load<typeof Networks>('protocol/networks.js'),
        load<typeof Encode>('transactions/encode.js'),
        load<typeof Helpers>('transactions/helpers.js'),
        load<typeof Payment>('transactions/executors/payment.js'),
        load<typeof Validator>('transactions/executors/validator.js'),
        load<typeof KeystoreMod>('crypto/keystore.js'),
        load<typeof Version>('version.js'),
        load<typeof ParamsMod>('protocol/params.js'),
        load<typeof IndexerMod>('indexer/indexer.js'),
        load<typeof StateRootMod>('blockchain/state-root.js'),
      ]);
    return { dir, keys, mnemonic, amount, types, networks, encode, helpers, payment, validator, keystore, version, params, indexer, stateRoot };
  })();
  cached.catch(() => {
    cached = undefined;
  });
  return cached;
}

/** Test hook: forget the cached core. */
export function resetCoreCache(): void {
  cached = undefined;
}
