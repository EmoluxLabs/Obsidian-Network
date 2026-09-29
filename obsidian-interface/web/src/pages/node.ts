/**
 * Node runners.
 *
 * Two audiences, one page:
 *
 *   - anyone can read the economics: how much qualifying platform revenue the
 *     protocol has taken, the 40/60 split, what sits in the Node Runner Reward
 *     Pool, and every settled period with its per-node payouts;
 *   - an operator can look up their own node id and see the evidence the
 *     network actually recorded about it, and the score that evidence produces.
 *
 * Everything shown here is read from a node and recomputable from chain data.
 * Where a number does not exist yet — no settlements, no heartbeats, an
 * unregistered node — this page says so instead of rendering a zero that looks
 * like a measurement. There is deliberately no "efficiency: 100%" anywhere: the
 * protocol computes the score, and this page only displays it.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient, ChainError } from '../lib/client.js';
import type { NodeRewardsResponse, NodeStatusResponse } from '../lib/client.js';
import { el, obs, spinner, kv, badge, table, toast } from '../lib/ui.js';

const client = new ObsidianClient();

const economics = el('section', { class: 'card' }, spinner('reading protocol revenue…'));
const registry = el('section', { class: 'card' }, spinner('reading the node registry…'));
const settlements = el('section', { class: 'card' }, spinner('reading settled reward periods…'));
const lookupResult = el('div', {});

const lookupInput = el('input', {
  type: 'text',
  id: 'node-id',
  placeholder: '20 bytes of hex, printed by your node at startup',
  autocomplete: 'off',
  spellcheck: 'false',
  class: 'mono',
}) as HTMLInputElement;

const lookupForm = el(
  'form',
  { class: 'stack' },
  el('label', { for: 'node-id' }, 'Node ID'),
  lookupInput,
  el('button', { type: 'submit', class: 'primary' }, 'Look up this node'),
);

/** Basis points → a percentage string, without inventing precision. */
function pct(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

function scoreBar(label: string, bps: number, weightBps: number): HTMLElement {
  const width = Math.max(0, Math.min(100, bps / 100));
  return el(
    'div',
    { class: 'score-row' },
    el('span', { class: 'score-label' }, `${label} · ${pct(weightBps)} of the score`),
    el('span', { class: 'score-track' }, el('span', { class: 'score-fill', style: `width:${width}%` })),
    el('span', { class: 'mono score-value' }, pct(bps)),
  );
}

layout({
  current: 'node',
  title: 'Node runners',
  tagline: '40% of qualifying platform revenue, paid to the nodes that actually carry the network.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'Nothing on this page is self-reported. '),
      'A node cannot tell the protocol it was online: its uptime is counted from heartbeats that other registered nodes attested, ',
      'its participation from blocks the chain shows it produced, and its reliability from faults independent peers corroborated. ',
      'Every node recomputes the same score from the same evidence, which is why the payout can be verified without trusting this website.',
    ),
    economics,
    settlements,
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Look up a node'),
      el('p', { class: 'muted' }, 'Operators: paste your node id to see the evidence recorded about it in the current period.'),
      lookupForm,
      lookupResult,
    ),
    registry,
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'How to become a reward-eligible node'),
      el('ol', { class: 'steps' },
        el('li', {}, el('strong', {}, 'Run Obsidian Core. '), 'It generates a node identity key on first start and prints the node id.'),
        el('li', {}, el('strong', {}, 'Sync and peer. '), 'A node that is behind or unreachable scores nothing, whatever it claims.'),
        el('li', {}, el('strong', {}, 'Register a reward wallet. '),
          'Your node signs a registration statement; the reward wallet signs the transaction and posts the bond. ',
          'That pair of signatures is what proves the operator controls both — nobody can point your wallet at their node, or their wallet at yours.'),
        el('li', {}, el('strong', {}, 'Stay up. '), 'Heartbeat each period, attest the peers you can see, and keep in sync.'),
        el('li', {}, el('strong', {}, 'Get paid. '),
          'At the end of each period the protocol settles inside a block — no service, no operator and no administrator has to run anything.'),
      ),
      el('p', { class: 'muted' },
        'The bond is returned in full when you deregister. It exists so a Sybil fleet must fund every node it invents, ',
        'which is what lets the network stay open without an approval list.'),
    ),
  ],
});

function renderScore(status: NodeStatusResponse, scoring: NodeRewardsResponse['scoring']): HTMLElement {
  const score = status.score;
  return el(
    'div',
    { class: 'stack' },
    el(
      'div',
      { class: 'score-head' },
      el('span', { class: 'mono big' }, pct(score.scoreBps)),
      score.eligible ? badge('eligible this period', 'ok') : badge('not eligible this period', 'warn'),
    ),
    scoreBar('Uptime', score.uptimeBps, scoring.scoreWeights.uptimeBps),
    scoreBar('Participation', score.participationBps, scoring.scoreWeights.participationBps),
    scoreBar('Reliability', score.reliabilityBps, scoring.scoreWeights.reliabilityBps),
    scoreBar('Responsiveness', score.responsivenessBps, scoring.scoreWeights.responsivenessBps),
    score.reasons.length
      ? el('ul', { class: 'reasons' }, ...score.reasons.map((reason) => el('li', {}, reason)))
      : el('p', { class: 'muted' }, 'The protocol recorded no penalties or shortfalls for this node in this period.'),
  );
}

async function lookup(nodeId: string): Promise<void> {
  lookupResult.replaceChildren(spinner('reading this node’s evidence…'));
  try {
    const [status, rewards] = await Promise.all([client.nodeStatus(nodeId), client.nodeRewards(10)]);
    const settled = status.settledRewards;
    lookupResult.replaceChildren(
      el('h3', {}, 'Identity'),
      kv([
        ['Node ID', el('span', { class: 'mono' }, status.nodeId)],
        ['Reward wallet', el('span', { class: 'mono' }, status.rewardWallet)],
        ['Registered', status.registered ? badge('yes', 'ok') : badge(`deregistered at height ${status.deregisteredAtHeight}`, 'warn')],
        ['Registered at height', String(status.registeredAtHeight)],
        ['Endpoint hint', status.endpoint ?? '— (an endpoint is a hint, never the identity)'],
        ['Bond held', obs(status.bondObs)],
        ['Lifetime rewards', obs(status.lifetimeRewardObs)],
        [
          'Pending wallet change',
          status.pendingWalletChange
            ? `${status.pendingWalletChange.wallet} — effective in period ${status.pendingWalletChange.effectivePeriod}`
            : 'none',
        ],
      ]),
      el('h3', {}, `Score — period ${status.currentPeriod}`),
      renderScore(status, rewards.scoring),
      el('h3', {}, 'Evidence the network recorded'),
      kv([
        ['Heartbeats', `${status.evidence.heartbeats} of ${status.evidence.expectedHeartbeats} expected`],
        [
          'Independent attesters',
          status.evidence.attesters.length
            ? el('span', { class: 'mono' }, status.evidence.attesters.join(', '))
            : 'none yet — uptime cannot be credited without another node observing this one',
        ],
        ['Blocks produced', String(status.evidence.blocksProduced)],
        ['Peers this node attested', String(status.evidence.attestationsMade)],
        ['Faults reported against it', `${status.evidence.faults} (reporters: ${status.evidence.faultReporters.length || 'none'})`],
        ['Heartbeats out of sync', String(status.evidence.staleHeartbeats)],
        ['Last reported height', String(status.evidence.lastReportedHeight)],
      ]),
      el('h3', {}, 'Settled rewards'),
      settled.length
        ? table(
            ['Period', 'Height', 'Score', 'Share', 'Paid', 'Wallet'],
            settled.map((entry) => [
              String(entry.period),
              String(entry.atHeight),
              pct(entry.scoreBps),
              pct(entry.shareBps),
              obs(entry.amountObs),
              el('span', { class: 'mono' }, entry.rewardWallet),
            ]),
          )
        : el('p', { class: 'muted' }, 'No period has settled for this node yet.'),
      el('p', { class: 'muted' }, status.note),
    );
  } catch (error) {
    const message = error instanceof ChainError ? error.message : String(error);
    lookupResult.replaceChildren(
      el('p', { class: 'error' }, `Could not read that node: ${message}`),
      el('p', { class: 'muted' }, 'A node id is 40 hex characters. Unregistered nodes have no record until they register a reward wallet.'),
    );
  }
}

lookupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = lookupInput.value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    toast('A node id is exactly 40 hexadecimal characters.', 'error');
    return;
  }
  void lookup(value);
});

void (async () => {
  try {
    const [revenue, rewards] = await Promise.all([client.revenue(), client.nodeRewards(10)]);

    economics.replaceChildren(
      el('h2', {}, 'Where platform revenue goes'),
      el(
        'div',
        { class: 'split-flow' },
        el('div', { class: 'flow-node' }, el('span', { class: 'flow-label' }, 'Qualifying platform revenue'), el('span', { class: 'mono big' }, obs(revenue.qualifyingPlatformRevenueObs))),
        el(
          'div',
          { class: 'flow-branches' },
          el('div', { class: 'flow-branch' },
            el('span', { class: 'flow-share' }, pct(revenue.split.nodePoolBps)),
            el('span', { class: 'flow-label' }, 'Node Runner Reward Pool'),
            el('span', { class: 'mono' }, obs(revenue.split.nodeRunnerPoolObs))),
          el('div', { class: 'flow-branch' },
            el('span', { class: 'flow-share' }, pct(revenue.split.treasuryBps)),
            el('span', { class: 'flow-label' }, 'Treasury wallet'),
            el('span', { class: 'mono' }, obs(revenue.split.treasuryObs))),
        ),
      ),
      kv([
        ['Split adds back to the whole', revenue.split.sumsBack ? badge('verified', 'ok') : badge('MISMATCH — do not trust this node', 'bad')],
        ['Pool balance now', obs(revenue.accounts.nodeRunnerPoolObs)],
        ['Bonds held for operators', obs(revenue.accounts.nodeBondsObs)],
        ['Mining Pool (gas, capsules, Time Travel)', obs(revenue.accounts.miningPoolObs)],
        ['Treasury wallet', revenue.accounts.treasuryWallet ? el('span', { class: 'mono' }, revenue.accounts.treasuryWallet) : 'not designated yet — the first valid mining claim designates it'],
        ['Revenue awaiting a treasury wallet', obs(revenue.accounts.unclaimedTreasuryRevenueObs)],
      ]),
      el('h3', {}, 'By source'),
      revenue.bySource.length
        ? table(['Source', 'Lifetime'], revenue.bySource.map((entry) => [el('span', { class: 'mono' }, entry.source), obs(entry.totalObs)]))
        : el('p', { class: 'muted' }, 'No qualifying platform revenue has been recorded on this chain yet.'),
      el('h3', {}, 'What is deliberately NOT platform revenue'),
      table(
        ['Flow', 'Why it is excluded'],
        revenue.notPlatformRevenue.map((entry) => [entry.kind, entry.because]),
      ),
      el('p', { class: 'muted' }, `${revenue.gas.note} Lifetime gas to the Mining Pool: ${revenue.gas.lifetimeObs} OBS.`),
    );

    settlements.replaceChildren(
      el('h2', {}, 'Settled reward periods'),
      kv([
        ['Current period', String(rewards.pool.currentPeriod)],
        ['Last settled period', rewards.pool.lastSettledPeriod ? String(rewards.pool.lastSettledPeriod) : 'none yet'],
        ['Period length', `${rewards.pool.periodSeconds / 3600} hours of protocol time`],
        ['Paid out so far', obs(rewards.pool.lifetimeDistributedObs)],
        ['Maximum one node may take from a period', pct(rewards.scoring.maxNodeShareBps)],
        ['Minimum uptime to earn', pct(rewards.scoring.minUptimeBps)],
        ['Independent attesters required', String(rewards.scoring.minAttesters)],
        ['Reward wallet changes take effect after', `${rewards.scoring.walletChangeDelayPeriods} period(s)`],
      ]),
      rewards.settlements.length
        ? el(
            'div',
            {},
            ...rewards.settlements.map((settlement) =>
              el(
                'div',
                { class: 'settlement' },
                el('h3', {}, `Period ${settlement.period}`),
                kv([
                  ['Settled at height', String(settlement.atHeight)],
                  ['Pool at settlement', obs(settlement.poolObs)],
                  ['Distributed', obs(settlement.distributedObs)],
                  ['Carried to the next period', obs(settlement.carriedObs)],
                  ['Nodes paid', `${settlement.eligibleNodes} of ${settlement.scoredNodes} scored`],
                ]),
                settlement.payouts.length
                  ? table(
                      ['Node', 'Wallet', 'Score', 'Share', 'Paid'],
                      settlement.payouts.map((payout) => [
                        el('span', { class: 'mono' }, payout.nodeId),
                        el('span', { class: 'mono' }, payout.rewardWallet),
                        pct(payout.scoreBps),
                        pct(payout.shareBps),
                        obs(payout.amountObs),
                      ]),
                    )
                  : el('p', { class: 'muted' }, 'No node qualified in this period; the whole pool was carried forward.'),
              ),
            ),
          )
        : el('p', { class: 'muted' }, 'No reward period has closed on this chain yet. Settlement happens inside a block, with no operator involved.'),
    );
  } catch (error) {
    const message = error instanceof ChainError ? error.message : String(error);
    economics.replaceChildren(el('p', { class: 'error' }, `Could not read the reward economics: ${message}`));
    settlements.replaceChildren(el('p', { class: 'muted' }, 'Settlement history is unavailable while the node is unreachable.'));
  }

  try {
    const response = await client.nodeRegistry(100);
    registry.replaceChildren(
      el('h2', {}, `Registered nodes (${response.registeredNodes})`),
      response.nodes.length
        ? table(
            ['Node', 'Reward wallet', 'Heartbeats', 'Attesters', 'Blocks', 'Attested', 'Faults', 'Bond'],
            response.nodes.map((node) => [
              el('span', { class: 'mono' }, node.nodeId),
              el('span', { class: 'mono' }, node.rewardWallet),
              String(node.currentPeriod.heartbeats),
              String(node.currentPeriod.attesters),
              String(node.currentPeriod.blocksProduced),
              String(node.currentPeriod.attestationsMade),
              node.currentPeriod.faults > 0 ? badge(String(node.currentPeriod.faults), 'warn') : '0',
              obs(node.bondObs),
            ]),
          )
        : el('p', { class: 'muted' }, 'No node runner has registered a reward wallet on this chain yet.'),
      el('p', { class: 'muted' }, response.note),
    );
  } catch (error) {
    const message = error instanceof ChainError ? error.message : String(error);
    registry.replaceChildren(el('p', { class: 'error' }, `Could not read the node registry: ${message}`));
  }
})();
