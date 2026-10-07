/** Shared status strip: shows which node the interface is reading from. */
import { ObsidianClient } from './client.js';
import { el, badge, short } from './ui.js';

export async function renderNodeBanner(host: HTMLElement, client = new ObsidianClient()): Promise<void> {
  try {
    const [{ nodes, consensusHeight, genesisMismatch }, status] = await Promise.all([client.nodes(), client.status()]);
    const healthy = nodes.filter((node) => node.healthy).length;
    const best = nodes.find((node) => node.healthy);
    host.replaceChildren(
      el('span', { class: 'node-pill' }, badge(healthy > 0 ? 'LIVE' : 'NO NODES', healthy > 0 ? 'ok' : 'bad')),
      el('span', {}, `height ${status.height.toLocaleString()}`),
      el(
        'span',
        {},
        'peers ',
        el('strong', {}, String(status.peers)),
      ),
      el('span', {}, healthy > 0 ? `reading from ${short(best?.url ?? '', 22)} (${best?.latencyMs ?? 0} ms)` : 'no healthy node'),
      ...(consensusHeight !== null ? [el('span', {}, `network height ${consensusHeight.toLocaleString()}`)] : []),
      ...(genesisMismatch ? [badge('GENESIS MISMATCH', 'bad')] : []),
    );
  } catch (error) {
    host.replaceChildren(badge('NODE UNREACHABLE', 'bad'), el('span', {}, (error as Error).message));
  }
}
