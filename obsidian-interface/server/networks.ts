/**
 * The four Obsidian networks, as far as the interface needs to know them.
 *
 * Kept separate from obsidian-core on purpose: the interface server reads
 * nodes over HTTP and must not import the node. `tests/networks.test.ts`
 * asserts that this table equals the core's own definition, so the two cannot
 * drift apart silently.
 *
 * An interface serves exactly one network. It is told which, refuses nodes that
 * follow another, and (unless told otherwise) listens on a port that belongs to
 * that network — so two interfaces on one host can never collide, and a devnet
 * page can never end up talking to a mainnet node by accident.
 */

export type NetworkName = 'mainnet' | 'testnet' | 'staging' | 'devnet';

export interface InterfaceNetwork {
  name: NetworkName;
  networkId: string;
  chainId: number;
  addressHrp: string;
  /** The node's own default RPC port for this network. */
  nodeRpcPort: number;
  /** This network's interface port: the node's RPC port scheme, applied to 8788. */
  interfacePort: number;
}

export const INTERFACE_NETWORKS: Readonly<Record<NetworkName, InterfaceNetwork>> = {
  mainnet: { name: 'mainnet', networkId: 'obsidian-mainnet-1', chainId: 7777, addressHrp: 'obs', nodeRpcPort: 8630, interfacePort: 8788 },
  testnet: { name: 'testnet', networkId: 'obsidian-testnet-1', chainId: 7778, addressHrp: 'tobs', nodeRpcPort: 18630, interfacePort: 18788 },
  staging: { name: 'staging', networkId: 'obsidian-staging-1', chainId: 7779, addressHrp: 'sobs', nodeRpcPort: 28630, interfacePort: 28788 },
  devnet: { name: 'devnet', networkId: 'obsidian-devnet-1', chainId: 7780, addressHrp: 'dobs', nodeRpcPort: 38630, interfacePort: 38788 },
};

export function interfaceNetwork(name: string): InterfaceNetwork {
  const found = INTERFACE_NETWORKS[name as NetworkName];
  if (!found) {
    throw new Error(`unknown network "${name}" (expected one of: ${Object.keys(INTERFACE_NETWORKS).join(', ')})`);
  }
  return found;
}
