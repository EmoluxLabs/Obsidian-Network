/**
 * Configuration loading: strict where strictness prevents a silent mistake.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, DEPRECATED_SETTINGS, checkConfigObject, loadConfig } from '../../src/config/config.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '../../dist/index.js');
const CONFIG_DIR = resolve(here, '../../config');

function configFile(contents: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'obs-config-'));
  const path = join(dir, 'node.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

describe('settings are checked, not guessed', () => {
  it('refuses a misspelt setting and says what it probably meant', () => {
    expect(() => checkConfigObject({ rpcAlowSubmit: false }, 'test')).toThrow(/did you mean "rpcAllowSubmit"/);
    expect(() => checkConfigObject({ completelyUnknown: 1 }, 'test')).toThrow(/does not recognise: "completelyUnknown"/);
  });

  it('rejects a value of the wrong type — the JSON string "false" is truthy', () => {
    expect(() => checkConfigObject({ miningEnabled: 'nope' }, 'test')).toThrow(/must be true or false/);
    expect(() => checkConfigObject({ rpcPort: 'eighty' }, 'test')).toThrow(/must be a number/);
    expect(() => checkConfigObject({ seedNodes: 7 }, 'test')).toThrow(/list of strings/);
    expect(() => checkConfigObject({ nodeName: 7 }, 'test')).toThrow(/must be a string/);
    // ...while the spellings an operator actually writes still work.
    expect(checkConfigObject({ miningEnabled: 'false', rpcPort: '9000', seedNodes: 'a:1, b:2' }, 'test').patch).toEqual({
      miningEnabled: false,
      rpcPort: 9000,
      seedNodes: ['a:1', 'b:2'],
    });
  });

  it('still loads the three settings that never did anything, but says so', () => {
    const { patch, warnings } = checkConfigObject({ miningRewardAddress: 'dobs1x', indexerEnabled: true, strictDataDir: true }, 'file');
    expect(patch).toEqual({});
    expect(warnings).toHaveLength(3);
    for (const key of Object.keys(DEPRECATED_SETTINGS)) expect(warnings.join('\n')).toContain(key);
    expect(warnings.join('\n')).toMatch(/no block reward/i);
  });

  it('surfaces deprecated settings from the environment as warnings too', () => {
    const loaded = loadConfig({ env: { OBSIDIAN_MINING_REWARD_ADDRESS: 'dobs1x', OBSIDIAN_NETWORK: 'devnet' } });
    expect(loaded.warnings.join('\n')).toContain('OBSIDIAN_MINING_REWARD_ADDRESS');
  });

  it('validates ranges that used to be accepted blindly', () => {
    expect(() => loadConfig({ env: {}, overrides: { network: 'devnet', logLevel: 'shouting' as never } })).toThrow(/invalid logLevel/);
    expect(() => loadConfig({ env: {}, overrides: { network: 'devnet', rpcRateLimitPerMinute: -1 } })).toThrow(/rpcRateLimitPerMinute/);
    expect(() => loadConfig({ env: {}, overrides: { network: 'devnet', portOffset: 1.5 } })).toThrow(/portOffset/);
    expect(() => loadConfig({ env: {}, overrides: { network: 'devnet', rpcHost: '' } })).toThrow(/rpcHost must not be empty/);
  });
});

describe('choosing a network', () => {
  it('has no default when asked to be explicit', () => {
    expect(() => loadConfig({ env: {}, requireExplicitNetwork: true })).toThrow(/no network selected/);
    expect(() => loadConfig({ env: {}, requireExplicitNetwork: true, overrides: { rpcPort: 9000 } })).toThrow(/no network selected/);
  });

  it('accepts a flag, the environment, or a network named in the file', () => {
    expect(loadConfig({ env: {}, requireExplicitNetwork: true, overrides: { network: 'devnet' } }).net.name).toBe('devnet');
    expect(loadConfig({ env: { OBSIDIAN_NETWORK: 'staging' }, requireExplicitNetwork: true }).net.name).toBe('staging');
    expect(loadConfig({ env: {}, requireExplicitNetwork: true, configPath: configFile({ network: 'testnet' }) }).net.name).toBe('testnet');
    // A config file that does not name one is not a choice.
    expect(() => loadConfig({ env: {}, requireExplicitNetwork: true, configPath: configFile({ rpcPort: 9000 }) })).toThrow(/no network selected/);
  });

  it('does not let one load leak into the next through the shared defaults', () => {
    loadConfig({ env: {}, overrides: { network: 'devnet', nodeName: 'leaky' } });
    expect(DEFAULT_CONFIG.network).toBe('mainnet');
    expect(DEFAULT_CONFIG.nodeName).toBe('obsidian-node');
    expect(DEFAULT_CONFIG.rpcPort).toBe(8630);
  });
});

describe('the shipped configuration files', () => {
  for (const network of ['devnet', 'testnet', 'staging', 'mainnet'] as const) {
    it(`${network}.json loads cleanly: no unknown keys, no warnings, the right ports`, () => {
      const loaded = loadConfig({ env: {}, configPath: join(CONFIG_DIR, `${network}.json`), requireExplicitNetwork: true });
      expect(loaded.net.name).toBe(network);
      expect(loaded.warnings).toEqual([]);
      expect(loaded.config.rpcPort).toBe(loaded.net.defaultRpcPort);
      expect(loaded.config.p2pPort).toBe(loaded.net.defaultP2pPort);
      expect(loaded.config.rpcHost).toBe('127.0.0.1'); // never public by default
    });
  }
});

describe('the command line', () => {
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_NETWORK: '' } });

  it.runIf(existsSync(CLI))('refuses `start` with no network instead of assuming mainnet', () => {
    const result = run(['start']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no network selected/);
  });

  it.runIf(existsSync(CLI))('refuses a flag that is missing its value (a bare trailing --network used to mean mainnet)', () => {
    const result = run(['start', '--network']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--network needs a value/);
    const swallowed = run(['start', '--network', '--offline']);
    expect(swallowed.status).toBe(1);
    expect(swallowed.stderr).toMatch(/--network needs a value/);
  });

  it.runIf(existsSync(CLI))('refuses a port that is not a number instead of ignoring it', () => {
    const result = run(['start', '--network', 'devnet', '--rpc-port', 'abc']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--rpc-port must be a whole number/);
  });

  it.runIf(existsSync(CLI))('still refuses unknown flags', () => {
    const result = run(['start', '--network', 'devnet', '--mine-ing']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown option "--mine-ing"/);
  });
});

describe('environment names', () => {
  it('honours the short names the shipped examples use, and the canonical name wins', () => {
    const viaAlias = loadConfig({ env: { OBSIDIAN_NETWORK: 'devnet', OBSIDIAN_SEEDS: 'a.example:1,b.example:2', OBSIDIAN_MINE: 'false', OBSIDIAN_KEYSTORE: '/tmp/k.json' } });
    expect(viaAlias.config.seedNodes).toEqual(['a.example:1', 'b.example:2']);
    expect(viaAlias.config.miningEnabled).toBe(false);
    expect(viaAlias.config.keystorePath).toBe('/tmp/k.json');
    const both = loadConfig({ env: { OBSIDIAN_NETWORK: 'devnet', OBSIDIAN_SEED_NODES: 'real.example:1', OBSIDIAN_SEEDS: 'alias.example:1', OBSIDIAN_MINING_ENABLED: 'true', OBSIDIAN_MINE: 'false' } });
    expect(both.config.seedNodes).toEqual(['real.example:1']);
    expect(both.config.miningEnabled).toBe(true);
  });

  it('treats an empty canonical variable as unset, so the alias still applies', () => {
    const loaded = loadConfig({ env: { OBSIDIAN_NETWORK: 'devnet', OBSIDIAN_SEED_NODES: '', OBSIDIAN_SEEDS: 'alias.example:1' } });
    expect(loaded.config.seedNodes).toEqual(['alias.example:1']);
  });
});

describe('one network, named once', () => {
  it('refuses to guess when the file, the environment and the flag disagree', () => {
    const file = configFile({ network: 'devnet' });
    // The trap this closes: `--config devnet.json` with OBSIDIAN_NETWORK=mainnet left over in the
    // shell used to START A MAINNET NODE (the environment beats the file).
    expect(() => loadConfig({ env: { OBSIDIAN_NETWORK: 'mainnet' }, configPath: file })).toThrow(
      /conflicting networks: the config file .* says devnet, but the OBSIDIAN_NETWORK environment variable says mainnet/,
    );
    expect(() => loadConfig({ env: { OBSIDIAN_NETWORK: 'testnet' }, overrides: { network: 'devnet' } })).toThrow(/conflicting networks/);
    expect(() => loadConfig({ env: {}, configPath: file, overrides: { network: 'staging' } })).toThrow(/the --network flag says staging/);
  });

  it('is fine with the same network named in more than one place', () => {
    const file = configFile({ network: 'devnet' });
    expect(loadConfig({ env: { OBSIDIAN_NETWORK: 'devnet' }, configPath: file, overrides: { network: 'devnet' } }).net.name).toBe('devnet');
    expect(loadConfig({ env: { OBSIDIAN_NETWORK: '' }, configPath: file }).net.name).toBe('devnet'); // an empty variable is not a vote
  });

  it('through the real CLI: an inherited OBSIDIAN_NETWORK cannot override --network', () => {
    if (!existsSync(CLI)) return;
    const result = spawnSync(process.execPath, [CLI, 'start', '--network', 'devnet', '--offline'], {
      encoding: 'utf8',
      env: { ...process.env, OBSIDIAN_NETWORK: 'mainnet' },
      timeout: 20_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/conflicting networks: the OBSIDIAN_NETWORK environment variable says mainnet, but the --network flag says devnet/);
  });
});
