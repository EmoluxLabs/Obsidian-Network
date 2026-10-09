/**
 * Where the app keeps things. One directory per network, so chain data, the node identity
 * key and the wallet of one network can never be mixed up with another's.
 *
 *   <base>/settings.json
 *   <base>/networks/<network>/data/            chain database (owned by Obsidian Core)
 *   <base>/networks/<network>/node-key.json    node identity keystore (owned by Obsidian Core)
 *   <base>/networks/<network>/node-key.pass    keystore passphrase, mode 0600
 *   <base>/networks/<network>/wallet/          wallet vault (obsidian.vault.v1) and public metadata
 *   <base>/logs/node-<network>.log             redacted node log
 */
import { join } from 'node:path';
import type { NetworkName } from '../shared/chain-types.js';

export interface NetworkPaths {
  root: string;
  dataDir: string;
  keystore: string;
  keystorePassphrase: string;
  walletDir: string;
  vault: string;
  walletMeta: string;
  log: string;
}

export interface AppPaths {
  base: string;
  settings: string;
  logsDir: string;
  forNetwork(network: NetworkName): NetworkPaths;
}

export function createPaths(base: string): AppPaths {
  return {
    base,
    settings: join(base, 'settings.json'),
    logsDir: join(base, 'logs'),
    forNetwork(network) {
      const root = join(base, 'networks', network);
      const walletDir = join(root, 'wallet');
      return {
        root,
        dataDir: join(root, 'data'),
        keystore: join(root, 'node-key.json'),
        keystorePassphrase: join(root, 'node-key.pass'),
        walletDir,
        vault: join(walletDir, 'vault.json'),
        walletMeta: join(walletDir, 'wallet.meta.json'),
        log: join(base, 'logs', `node-${network}.log`),
      };
    },
  };
}
