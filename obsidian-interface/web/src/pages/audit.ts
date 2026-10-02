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
import { el, obs, spinner, kv, badge, table, when, toast } from '../lib/ui.js';

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
        // The node names these `totalSupplyObs` / `maxSupplyObs`: reading a
        // field that does not exist prints "undefined OBS" beside a healthy chain.
        ['Total supply', `${obs(supply.totalSupplyObs || status.supplyObs)} OBS`],
        ['Hard cap', `${obs(supply.maxSupplyObs || status.maxSupplyObs)} OBS`],
        ['Invariant', supply.invariantOk ? 'supply invariant holds (recomputed by this node)' : 'FAILED — investigate'],
        ['Issuance sources', supply.issuanceSources.length > 0 ? supply.issuanceSources.join(', ') : 'none yet'],
        ['Genesis allocation', status.genesis ? `${status.genesis.allocationObs} OBS to ${status.genesis.allocationClaimed ? 'the first valid mining claim (claimed)' : 'the first valid mining claim (unclaimed)'}` : '—'],
        ['Treasury wallet', el('span', { class: 'mono' }, status.genesis?.treasuryWallet ?? '—')],
        ['Designation', 'the wallet that received the genesis allocation is the on-chain treasury: platform revenue is routed there, user funds never are'],
      ]),
      el('p', { class: 'fineprint' }, `Read at ${when(status.lastBlockTimestamp)} from ${status.networkId} at height ${status.height.toLocaleString()}.`),
    );

    if (decentralisation) {
      // Raw JSON.stringify dumps were unreadable here and `String(value)`
      // produced "[object Object]" on the explorer. Both reports are rendered
      // as the question/answer and dependency tables they actually are.
      decPanel.replaceChildren(
        el('h2', {}, 'Decentralisation'),
        ...decentralisationRows(decentralisation),
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

interface AuditQuestion {
  question?: unknown;
  answer?: unknown;
  evidence?: unknown;
}

interface AuditDependency {
  component?: unknown;
  scope?: unknown;
  consensusImpact?: unknown;
}

/** Turn /audit/decentralization into readable rows rather than a JSON dump. */
function decentralisationRows(audit: Record<string, unknown>): HTMLElement[] {
  const rows: HTMLElement[] = [];

  const questions = Array.isArray(audit.questions) ? (audit.questions as AuditQuestion[]) : [];
  if (questions.length > 0) {
    const allNo = questions.every((entry) => String(entry.answer).toUpperCase() === 'NO');
    rows.push(
      el(
        'p',
        { class: 'muted' },
        `${questions.length} single-point-of-failure questions${allNo ? ', every one answered NO by this node' : ''}.`,
      ),
      kv(
        questions.map((entry) => [
          String(entry.question ?? '—'),
          el('span', {}, el('strong', {}, String(entry.answer ?? '—')), ` — ${String(entry.evidence ?? '')}`),
        ]),
      ),
    );
  }

  const dependencies = Array.isArray(audit.centralisedDependencies)
    ? (audit.centralisedDependencies as AuditDependency[])
    : [];
  if (dependencies.length > 0) {
    rows.push(
      el('h3', {}, 'Centralised dependencies'),
      el(
        'p',
        { class: 'muted' },
        'Named on purpose. Each is scoped so that losing it cannot stop or corrupt consensus.',
      ),
      kv(
        dependencies.map((entry) => [
          String(entry.component ?? '—'),
          `${String(entry.scope ?? '—')} · consensus impact: ${String(entry.consensusImpact ?? '—')}`,
        ]),
      ),
    );
  }

  const known = new Set(['questions', 'centralisedDependencies']);
  const rest = Object.entries(audit).filter(([key]) => !known.has(key));
  if (rest.length > 0) {
    rows.push(
      kv(
        rest.map(([key, value]) => [
          key,
          Array.isArray(value)
            ? `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`
            : typeof value === 'object' && value !== null
              ? Object.entries(value as Record<string, unknown>)
                  .map(([k, v]) => `${k}: ${String(v)}`)
                  .join(' · ')
              : String(value),
        ]),
      ),
    );
  }

  return rows;
}
