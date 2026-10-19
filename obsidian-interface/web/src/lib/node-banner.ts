/** Shared status strip: shows which network this is, whether the chain is reachable and how tall it is. */
import { ObsidianClient, type ChainStatus, type NodeConnection } from './client.js';
import { el, badge, count } from './ui.js';

/** `obsidian-mainnet-1` → `MAINNET`. Used only when the interface did not name the network itself. */
function networkName(connection: NodeConnection | undefined, status: ChainStatus | undefined): string | null {
  const named = connection?.network ?? status?.networkId?.match(/mainnet|testnet|staging|devnet/i)?.[0];
  return named ? named.toUpperCase() : null;
}

export async function renderNodeBanner(host: HTMLElement, client = new ObsidianClient()): Promise<void> {
  // The two answers are independent. If one of them fails the strip still says what the other knows: a page that has
  // just read the chain must not say "NODE UNREACHABLE" because the connection summary was slow or refused.
  const [connectionResult, statusResult] = await Promise.allSettled([client.nodes(), client.status()]);
  const connection = connectionResult.status === 'fulfilled' ? connectionResult.value : undefined;
  const status = statusResult.status === 'fulfilled' ? statusResult.value : undefined;

  if (!connection && !status) {
    const reason = statusResult.status === 'rejected' ? statusResult.reason : (connectionResult as PromiseRejectedResult).reason;
    host.replaceChildren(badge('NODE UNREACHABLE', 'bad'), el('span', {}, reason instanceof Error ? reason.message : 'the chain could not be reached'));
    return;
  }

  // An answer from the chain is proof that it is reachable, whatever the connection summary says.
  const live = connection ? connection.live : true;
  const network = networkName(connection, status);
  const consensusHeight = connection?.consensusHeight ?? null;
  // No peer count, no node address, no finality figure, no latency.
  host.replaceChildren(
    el('span', { class: 'node-pill' }, badge(live ? 'ACTIVE' : 'NO NODES', live ? 'ok' : 'bad')),
    ...(network ? [el('span', { class: 'node-pill' }, badge(network, network === 'MAINNET' ? 'ok' : 'warn'))] : []),
    ...(status ? [el('span', {}, `height ${count(status.height)}`)] : []),
    ...(live ? [] : [el('span', {}, 'the chain cannot be reached right now')]),
    ...(consensusHeight !== null ? [el('span', {}, `network height ${count(consensusHeight)}`)] : []),
    ...(connection?.genesisMismatch ? [badge('GENESIS MISMATCH', 'bad')] : []),
  );
}
