/**
 * Compliance audit.
 *
 * The claim "we removed the parts you told us to remove" is worth nothing as
 * prose. This page asks the node which mechanisms exist, and shows the raw
 * answer: whether a WAC toll, the old 3,000,000 OBS signup allocation, admin
 * minting, mining KYC, an in-house exchange or an explorer that leaks balances
 * are reachable in the running protocol.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { el, spinner, kv, badge, table, when, toast } from '../lib/ui.js';

const client = new ObsidianClient();
const panel = el('section', { class: 'card' }, spinner('asking every reachable node…'));
const decPanel = el('section', { class: 'card' }, spinner('reading the decentralisation report…'));

layout({
  current: 'audit',
  title: 'Compliance audit',
  tagline: 'What is absent from the protocol, read from the protocol itself.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'Absence is a property of code, not of a policy page. '),
      'Each row below comes from a route every node serves. A mechanism reported as `present: true` would mean the running binary still accepts it — regardless of what any document says.',
    ),
    panel,
    decPanel,
  ],
});

void (async () => {
  try {
    const [compliance, decentralisation, status, supply] = await Promise.all([
      client.requestSafe<Record<string, unknown>>('/audit/compliance'),
      client.requestSafe<Record<string, unknown>>('/audit/decentralization'),
      client.status(),
      client.supply(),
    ]);

    if (!compliance) throw new Error('this node does not expose /audit/compliance');
    const rows = Object.entries(compliance).map(([key, value]) => {
      const flag = value as { present?: boolean; detail?: string } | boolean;
      const present = typeof flag === 'boolean' ? flag : Boolean(flag?.present);
      const detail = typeof flag === 'boolean' ? '' : (flag?.detail ?? '');
      return [
        el('span', { class: 'mono' }, key),
        present ? badge('present — investigate', 'bad') : badge('absent', 'ok'),
        detail,
      ];
    });

    panel.replaceChildren(
      el('h2', {}, 'Removed mechanisms'),
      table(['Mechanism', 'State', 'Node detail'], rows),
      el('h3', {}, 'Supply and genesis'),
      kv([
        ['Total supply', `${String(supply.totalObs ?? status.supplyObs ?? '—')} OBS`],
        ['Hard cap', `${String(supply.maxObs ?? status.maxSupplyObs ?? '21,000,000')} OBS`],
        ['Invariant', String((supply as { invariantOk?: boolean }).invariantOk ?? 'reported by the node')],
        ['Genesis allocation', status.genesis ? `${status.genesis.allocationObs} OBS to ${status.genesis.allocationClaimed ? 'the first valid mining claim (claimed)' : 'the first valid mining claim (unclaimed)'}` : '—'],
        ['Treasury wallet', el('span', { class: 'mono' }, status.genesis?.treasuryWallet ?? '—')],
        ['Designation', 'the wallet that received the genesis allocation is the on-chain treasury: platform revenue is routed there, user funds never are'],
      ]),
      el('p', { class: 'fineprint' }, `Read at ${when(status.lastBlockTimestamp)} from ${status.networkId} at height ${status.height.toLocaleString()}.`),
    );

    if (decentralisation) {
      decPanel.replaceChildren(
        el('h2', {}, 'Decentralisation'),
        kv(Object.entries(decentralisation).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])),
        el('p', { class: 'fineprint' }, 'Mining distribution, node counts and validator participation are recomputed by each node from the chain it holds.'),
      );
    } else {
      decPanel.replaceChildren(el('h2', {}, 'Decentralisation'), el('p', { class: 'muted' }, 'This node does not expose the decentralisation report.'));
    }
  } catch (error) {
    panel.replaceChildren(el('h2', {}, 'Compliance audit'), el('p', { class: 'error' }, (error as Error).message));
    toast((error as Error).message, 'error');
  }
})();
