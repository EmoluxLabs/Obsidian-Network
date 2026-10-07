import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getNetwork } from '../../src/protocol/networks.js';
import { isValidAddress } from '../../src/crypto/keys.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(here, '../../dist/index.js');

/**
 * `wallet new` used to ignore --network and always print a mainnet `obs1…`
 * address, the command-line twin of the 1.2.1 browser-wallet bug. An address
 * belongs to exactly one network, so the CLI must derive the one the operator
 * asked for.
 */
describe('CLI wallet new is bound to the requested network', () => {
  const run = (args: string[]) =>
    JSON.parse(execFileSync(process.execPath, [CLI, 'wallet', 'new', ...args], { encoding: 'utf8' })) as {
      network: string;
      chainId: number;
      addressHrp: string;
      address: string;
      recoveryPhrase: string;
    };

  it.runIf(existsSync(CLI))('prints an address with each network\'s own prefix', () => {
    const seen = new Set<string>();
    for (const name of ['mainnet', 'testnet', 'staging', 'devnet'] as const) {
      const net = getNetwork(name);
      const out = run(['--network', name]);
      expect(out.network).toBe(name);
      expect(out.chainId).toBe(net.chainId);
      expect(out.addressHrp).toBe(net.addressHrp);
      expect(out.address.startsWith(`${net.addressHrp}1`), `${name} gave ${out.address}`).toBe(true);
      expect(isValidAddress(out.address, net.addressHrp)).toBe(true);
      // and it is not valid anywhere else
      for (const other of ['mainnet', 'testnet', 'staging', 'devnet'] as const) {
        if (other === name) continue;
        expect(isValidAddress(out.address, getNetwork(other).addressHrp)).toBe(false);
      }
      expect(out.recoveryPhrase.split(/\s+/)).toHaveLength(24);
      seen.add(out.address);
    }
    expect(seen.size).toBe(4);
  });

  it.runIf(existsSync(CLI))('refuses to guess a network, rather than minting a mainnet address', () => {
    // It used to default to mainnet, so `wallet new` on a devnet machine printed an
    // `obs1…` address that no devnet node would ever accept. There is no default now.
    const failure = spawnSync(process.execPath, [CLI, 'wallet', 'new'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_NETWORK: '' } });
    expect(failure.status).toBe(1);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toMatch(/no network selected.*--network devnet\|testnet\|staging\|mainnet/);
  });

  it.runIf(existsSync(CLI))('takes the network from OBSIDIAN_NETWORK when the flag is absent', () => {
    const out = JSON.parse(
      execFileSync(process.execPath, [CLI, 'wallet', 'new'], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_NETWORK: 'devnet' } }),
    ) as { network: string; address: string };
    expect(out.network).toBe('devnet');
    expect(out.address.startsWith('dobs1')).toBe(true);
  });
});

/**
 * Every command whose answer depends on which chain it is about must be told. A
 * default of mainnet here would ask the mainnet RPC port, replay the mainnet
 * genesis, or validate a data directory against the wrong chain — quietly.
 */
describe('commands that depend on the network refuse to assume one', () => {
  const noNetwork = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, OBSIDIAN_NETWORK: '' } });

  for (const args of [['health'], ['validate', '--data-dir', '/tmp/obsidian-no-such-dir'], ['genesis', 'init']]) {
    it.runIf(existsSync(CLI))(`obsidian-core ${args[0]}${args[1] === 'init' ? ' init' : ''} without --network`, () => {
      const result = noNetwork(...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no network selected/);
    });
  }

  it.runIf(existsSync(CLI))('genesis init prints the chosen network\'s genesis, and only that one', () => {
    const out = JSON.parse(execFileSync(process.execPath, [CLI, 'genesis', 'init', '--network', 'devnet'], { encoding: 'utf8' })) as {
      network: string;
      document: { chainId: number };
    };
    expect(out.network).toBe('devnet');
    expect(out.document.chainId).toBe(getNetwork('devnet').chainId);
  });
});
