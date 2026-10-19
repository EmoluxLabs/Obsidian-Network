/** Shared status strip: shows which node the interface is reading from. */
import { ObsidianClient } from './client.js';
import { el, badge, count } from './ui.js';

export async function renderNodeBanner(host: HTMLElement, client = new ObsidianClient()): Promise<void> {
  try {
    const [{ live, consensusHeight, genesisMismatch }, status] = await Promise.all([client.nodes(), client.status()]);
    // No peer count, no node address, no latency: the strip says whether the chain is reachable and how tall it is.
    host.replaceChildren(
      el('span', { class: 'node-pill' }, badge(live ? 'LIVE' : 'NO NODES', live ? 'ok' : 'bad')),
      el('span', {}, `height ${count(status.height)}`),
      ...(live ? [] : [el('span', {}, 'the chain cannot be reached right now')]),
      ...(consensusHeight !== null ? [el('span', {}, `network height ${count(consensusHeight)}`)] : []),
      ...(genesisMismatch ? [badge('GENESIS MISMATCH', 'bad')] : []),
    );
  } catch (error) {
    host.replaceChildren(badge('NODE UNREACHABLE', 'bad'), el('span', {}, (error as Error).message));
  }
}
