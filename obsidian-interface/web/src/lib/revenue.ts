/**
 * Where ONS revenue goes, and when each share is paid.
 *
 * A user registering a name asks two questions the pages used to leave unanswered: did the treasury
 * get its 10%, and how long until the runner pool pays out the other 90%. The node answers both from
 * chain state alone (`GET /revenue`); this turns that answer into rows two pages share, so the audit
 * page and the node-runner page can never describe the money flow differently.
 *
 * A node older than the `treasury` and `timing` fields still answers `/revenue`. The rows then say
 * only what that node reported, instead of inventing a schedule.
 */

import type { RevenueResponse } from './client.js';
import { badge, copyButton, duration, el, obs, pct, when, type Child } from './ui.js';

export function revenueTimingRows(revenue: RevenueResponse): Array<[string, Child]> {
  const rows: Array<[string, Child]> = [];
  const wallet = revenue.treasury?.wallet ?? revenue.accounts.treasuryWallet;

  rows.push([
    'Treasury wallet',
    wallet
      ? el('span', {}, el('span', { class: 'mono', id: 'treasury-wallet' }, wallet), ' ', copyButton(wallet, 'Copy address'))
      : 'not designated yet — the first valid mining claim designates it',
  ]);
  if (revenue.treasury) {
    rows.push(['Treasury share credited so far', `${obs(revenue.split.treasuryCreditedObs)} OBS — credited in the same block as each ONS fee once a treasury is designated`]);
    rows.push(['Treasury share still owed', `${obs(revenue.split.treasuryUnclaimedObs)} OBS — held as an explicit protocol obligation until a treasury wallet exists`]);
  }

  const timing = revenue.timing;
  if (!timing) {
    rows.push(['When it is paid', 'this node does not report a payment schedule']);
    return rows;
  }
  rows.push([
    `Treasury share (${pct(timing.treasuryShare.bps / 100, 0)})`,
    `${timing.treasuryShare.paid}.`,
  ]);
  const nodes = timing.nodeRunnerShare;
  rows.push([
    `Node-runner share (${pct(nodes.bps / 100, 0)})`,
    `Held in the Node Runner Reward Pool and paid ${nodes.paid} — every ${duration(nodes.periodSeconds)} — to registered nodes in proportion to the score their recorded evidence earned.`,
  ]);
  rows.push(['Next node-runner payout', `${when(nodes.nextSettlementAt)} — in ${duration(nodes.secondsUntilNextSettlement)}`]);
  rows.push(['Waiting in the pool', `${obs(nodes.poolBalanceObs)} OBS`]);
  rows.push([
    'Registered node runners',
    nodes.carriedWhenNoNodes ? el('span', {}, '0 ', badge('pool is carried forward', 'warn'), ' ', nodes.note) : `${nodes.registeredNodes} — ${nodes.note}`,
  ]);
  return rows;
}
