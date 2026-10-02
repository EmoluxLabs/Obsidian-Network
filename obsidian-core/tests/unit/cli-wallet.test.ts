import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
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

  it.runIf(existsSync(CLI))('defaults to mainnet when no network is given', () => {
    expect(run([]).address.startsWith('obs1')).toBe(true);
  });
});
