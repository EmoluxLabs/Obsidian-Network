/**
 * Mining.
 *
 * All authority is in the protocol: the node decides whether a claim is
 * eligible, how much it pays and which claim id is next. This page only asks,
 * signs and submits. It never uses the browser clock for eligibility, never
 * invents a claim id, and never retries in a way that could double-claim.
 *
 * Who may mine is decided by the server, which refuses a claim from anyone who
 * is not signed in, has no linked wallet, has not confirmed MFA, or signs with
 * a wallet other than the linked one. This page mirrors those rules so the
 * user is told what is missing instead of meeting a refusal after signing:
 *   signed out → no mining panels at all, only the way in;
 *   signed in, no wallet linked → link (or create) one;
 *   linked, MFA missing → finish MFA on the account page;
 *   everything in place → the claim panel, for the LINKED wallet only.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient, type MiningStatus } from '../lib/client.js';
import { Wallet, hrpOfAddress } from '../lib/wallet.js';
import { operations } from '../lib/operations.js';
import { session, type AccountView } from '../lib/session.js';
import { linkStoredWallet } from '../lib/link-wallet.js';
import { el, obs, duration, spinner, toast, kv, badge, table, short, when, rewardLine, rewardPerClaim } from '../lib/ui.js';

const client = new ObsidianClient();

const claimPanel = el('section', { class: 'card claim-card', id: 'claim' }, spinner('checking eligibility…'));
const schedulePanel = el('section', { class: 'card', id: 'schedule' }, spinner());
const historyPanel = el('section', { class: 'card', id: 'history' }, spinner());
const walletPanel = el('section', { class: 'card', id: 'wallet' });

layout({
  current: 'mine',
  title: 'Mining',
  tagline: 'Claim the protocol reward — four hours between claims, six claims a cycle, no device clocks involved.',
  children: [
    el(
      'section',
      { class: 'notice' },
      el('strong', {}, 'How the reward is decided. '),
      'The genesis allocation of 100,000 OBS goes to the first valid mining claim on the chain, once, atomically. ' +
        'After that every claim pays 0.001 OBS a day split into six claims — 0.000166666666666666 OBS — reduced 0.5% per 100,000 active miners down to a hard floor of 0.0002 OBS a day. ' +
        'The node enforces one claim per wallet per block, one per four hours, and rejects replays.',
    ),
    claimPanel,
    schedulePanel,
    historyPanel,
    walletPanel,
  ],
});

let status: MiningStatus | undefined;
let wallet: Wallet | undefined;

void boot();

/** Prefix the connected network expects. Mining to another one cannot work. */
let networkHrp: string | undefined;

async function boot(): Promise<void> {
  try {
    networkHrp = (await client.network()).network.addressHrp;
  } catch {
    networkHrp = undefined;
  }
  await refresh();
  window.setInterval(() => void tickTicker(), 1000);
}

function drawWalletPanel(): void {
  const address = Wallet.storedAddress();
  const wrongNetwork = address !== undefined && networkHrp !== undefined && hrpOfAddress(address) !== networkHrp;
  walletPanel.replaceChildren(
    el('h2', {}, 'Signing wallet'),
    ...(account?.walletAddress ? [el('p', { class: 'fineprint' }, 'This is your account\'s wallet, linked for good. Claims from any other wallet are refused, and this wallet can serve no other account.')] : []),
    ...(wrongNetwork
      ? [
          el(
            'div',
            { class: 'notice danger' },
            el('strong', {}, 'This wallet belongs to another network. '),
            `Its address starts "${hrpOfAddress(address!)}1" and this network expects "${networkHrp}1", so a claim signed with it is refused by every node here — nothing would be mined and nothing would be credited. ` +
              'Open the wallet page and re-derive it: same 24 words, same keys, correct prefix.',
          ),
          el('a', { class: 'primary as-link', href: '/wallet/' }, 'Fix this wallet'),
        ]
      : []),
    address
      ? kv([
          ['Wallet in this browser', el('span', { class: 'mono' }, address)],
          ['Network', wrongNetwork ? `mismatch — wallet "${hrpOfAddress(address)}1", network "${networkHrp}1"` : `matches this network ("${networkHrp ?? '…'}1")`],
          ['Keys', 'encrypted in this browser with your passphrase — never sent to the interface'],
        ])
      : el(
          'div',
          {},
          el('p', {}, 'No wallet exists in this browser yet, so there is nothing to sign a claim with.'),
          el('a', { class: 'primary as-link', href: '/wallet/' }, 'Create a wallet'),
        ),
  );
}

async function tickTicker(): Promise<void> {
  if (!status) return;
  const node = document.getElementById('claim-timer');
  if (node) node.textContent = status.secondsRemaining > 0 ? duration(status.secondsRemaining) : 'ready now';
  if (status.secondsRemaining > 0) status.secondsRemaining -= 1;
  else void refresh();
}

/** The account the page is acting for; undefined when nobody is signed in. */
let account: AccountView | undefined;

/** Show only the gate: every other mining panel is emptied, not merely hidden. */
function showGate(...children: Array<HTMLElement | string>): void {
  status = undefined;
  wallet = undefined;
  claimPanel.replaceChildren(el('h2', {}, 'Mining'), ...children);
  for (const panel of [schedulePanel, historyPanel, walletPanel]) panel.replaceChildren();
  for (const panel of [schedulePanel, historyPanel, walletPanel]) panel.hidden = true;
}

function asLink(href: string, label: string): HTMLElement {
  return el('a', { class: 'primary as-link', href }, label);
}

function stepList(done: { signedIn: boolean; wallet: boolean; mfa: boolean }): HTMLElement {
  const row = (ok: boolean, text: string) => el('li', { class: ok ? 'step-done' : 'step-todo', 'aria-label': `${text}: ${ok ? 'done' : 'still to do'}` }, text);
  return el(
    'ul',
    { class: 'gate-steps' },
    row(done.signedIn, 'Sign in to your account'),
    row(done.wallet, 'Link a wallet to your account'),
    row(done.mfa, 'Confirm two-factor authentication'),
  );
}

function linkButton(address: string, label: string): HTMLElement {
  const button = el('button', { class: 'primary', type: 'button', id: 'link-wallet' }, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      await linkStoredWallet(address);
      toast('Wallet linked to your account for good.', 'success');
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      await refresh();
    }
  });
  return button;
}

async function refresh(): Promise<void> {
  account = await session.current();
  const address = Wallet.storedAddress();

  // 1. Signed out: nothing about mining is offered, and nothing is requested
  //    from the chain on this person's behalf.
  if (!account) {
    showGate(
      el('p', {}, 'Mining is for signed-in accounts. Sign in, link a wallet and confirm two-factor authentication to claim.'),
      stepList({ signedIn: false, wallet: false, mfa: false }),
      asLink('/app/', 'Sign in'),
      el('p', { class: 'fineprint' }, 'Registration is invite-only. You can create a wallet without an account, but it cannot claim until it is linked to one.'),
    );
    return;
  }

  const linked = account.walletAddress;
  const done = { signedIn: true, wallet: Boolean(linked), mfa: account.miningEnabled };

  // 2. Signed in, no wallet linked yet.
  if (!linked) {
    const wrongNetwork = address !== undefined && networkHrp !== undefined && hrpOfAddress(address) !== networkHrp;
    showGate(
      el('p', {}, 'Connect a wallet to this account before mining. Claims are accepted only from the wallet linked to your account.'),
      stepList(done),
      ...(address && !wrongNetwork
        ? [
            kv([['Wallet in this browser', el('span', { class: 'mono' }, address)]]),
            linkButton(address, 'Link this wallet to my account'),
            el('p', { class: 'fineprint' }, 'One wallet per account, and the link cannot be changed. You sign a short challenge with your passphrase to prove the key is yours; only the address, public key and signature are sent. The wallet is its own key, never made from your account details.'),
          ]
        : address
          ? [
              el('p', { class: 'error' }, `The wallet in this browser is a "${hrpOfAddress(address)}1" address; this network needs "${networkHrp}1". Re-derive it on the wallet page first.`),
              asLink('/wallet/', 'Open the wallet'),
            ]
          : [el('p', {}, 'There is no wallet in this browser yet.'), asLink('/wallet/', 'Create a wallet')]),
    );
    return;
  }

  // 3. Wallet linked, MFA not confirmed: the server keeps mining closed.
  if (!account.miningEnabled) {
    showGate(
      el('p', {}, 'Mining stays closed on this account until two-factor authentication is confirmed.'),
      stepList(done),
      kv([['Linked wallet', el('span', { class: 'mono' }, linked)]]),
      asLink('/app/', 'Finish two-factor setup'),
    );
    return;
  }

  // 4. This browser holds a different wallet than the one linked: the claim
  //    it would sign is refused by the server, so do not offer to sign it.
  if (!address || address !== linked) {
    showGate(
      el('p', {}, 'Your account mines with its linked wallet only.'),
      stepList(done),
      kv([
        ['Linked wallet', el('span', { class: 'mono' }, linked)],
        ['Wallet in this browser', address ? el('span', { class: 'mono' }, address) : 'none'],
      ]),
      el(
        'p',
        {},
        address
          ? 'This browser holds a different wallet. An account keeps one wallet for good, so restore the linked wallet here with its recovery phrase to claim.'
          : 'The linked wallet is not in this browser. Restore it here with its recovery phrase to claim.',
      ),
      asLink('/wallet/', 'Restore the linked wallet'),
    );
    return;
  }

  // 5. Ready.
  for (const panel of [schedulePanel, historyPanel, walletPanel]) panel.hidden = false;
  drawWalletPanel();
  void loadSchedule();
  void loadHistory();
  if (networkHrp && hrpOfAddress(address) !== networkHrp) {
    // Fail here, legibly, rather than letting the node refuse the claim with
    // "not a valid address for this network" after the user has signed it.
    claimPanel.replaceChildren(
      el('h2', {}, 'Claim'),
      el('p', { class: 'error' }, `The wallet in this browser is a "${hrpOfAddress(address)}1" address and this network only accepts "${networkHrp}1" addresses.`),
      el('p', {}, 'Re-derive the wallet for this network first. Your recovery phrase and keys do not change — only the address prefix does.'),
      el('a', { class: 'primary as-link', href: '/wallet/' }, 'Open the wallet'),
    );
    return;
  }
  try {
    status = await client.miningStatus(address);
    drawClaim();
  } catch (error) {
    claimPanel.replaceChildren(el('h2', {}, 'Claim'), el('p', { class: 'error' }, (error as Error).message), retry(() => void refresh()));
  }
}

function retry(onClick: () => void): HTMLElement {
  const node = el('button', { class: 'ghost', type: 'button' }, 'Retry');
  node.addEventListener('click', onClick);
  return node;
}

function drawClaim(): void {
  const state = status!;
  const eligible = state.eligible && state.secondsRemaining <= 0;
  const timer = el('span', { id: 'claim-timer', class: 'mono' }, state.secondsRemaining > 0 ? duration(state.secondsRemaining) : 'ready now');

  const button = el(
    'button',
    { class: 'primary big', type: 'button', id: 'claim-button', disabled: eligible ? undefined : 'disabled' },
    eligible ? `Claim ${obs(state.rewardPerClaimObs)} OBS` : 'Not eligible yet',
  );
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = 'Signing locally…';
    try {
      const walletInstance = await unlockWallet();
      if (!walletInstance) return;
      button.textContent = 'Submitting…';
      const result = await operations.claim(client, walletInstance);
      toast(`Claim accepted into the mempool: ${result.txId.slice(0, 16)}…`, 'success');
      await waitForInclusion(state.nextClaimId);
      await refresh();
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      button.disabled = false;
      await refresh();
    }
  });

  claimPanel.replaceChildren(
    el('div', { class: 'claim-head' }, el('h2', {}, 'Claim'), badge(eligible ? 'ELIGIBLE' : 'WAITING', eligible ? 'ok' : 'warn')),
    kv([
      ['Wallet', el('span', { class: 'mono' }, short(state.address, 14))],
      ['Reward per claim', `${obs(state.rewardPerClaimObs)} OBS`],
      ['Next claim id', el('span', { class: 'mono' }, `${state.nextClaimId.slice(0, 20)}…`)],
      ['Claims this cycle', `${state.claimsThisCycle} / 6 (${state.claimsRemainingInCycle} left)`],
      ['Eligible in', timer],
      ['Protocol time', `${when(state.protocolTime)} (from the chain head, not your device)`],
    ]),
    button,
    ...(state.reason ? [el('p', { class: 'fineprint' }, `Node says: ${state.reason}`)] : []),
    el(
      'p',
      { class: 'fineprint' },
      'A claim is a signed transaction: it costs no gas, cannot be replayed (each claim id is claimed once, ever) and cannot be claimed twice in the same block, ' +
        'even from two tabs or two devices, because the node validates both the claim id and the wallet\'s claim sequence.',
    ),
  );
}

async function waitForInclusion(claimId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500));
    const address = Wallet.storedAddress();
    if (!address) return;
    const claims = await client.miningClaims(address, 5).catch(() => undefined);
    if (!claims) continue;
    // Claims are identified on chain by claim id (the replay guard), not by a
    // per-address sequence number, so that is what the list is matched on.
    const found = claims.claims.some((claim) => claim.claimId === claimId);
    if (found) {
      toast('Claim mined into a block.', 'success');
      return;
    }
  }
  toast('Still in the mempool — the next block will pick it up.', 'info');
}

async function unlockWallet(): Promise<Wallet | undefined> {
  if (wallet) return wallet;
  const passphrase = window.prompt('Unlock your wallet passphrase (kept only in this tab, never transmitted)');
  if (!passphrase) return undefined;
  wallet = await Wallet.unlock(passphrase);
  return wallet;
}

async function loadSchedule(): Promise<void> {
  try {
    const [schedule, pot] = await Promise.all([
      client.miningSchedule(),
      // Optional: older nodes have no /pot, and the schedule must still render.
      client.proofOfTime().catch(() => undefined),
    ]);
    const tiers = [0, 100_000, 200_000, 400_000, 800_000, 1_600_000, 3_200_000].map((miners) => {
      const perDay = 0.001 * Math.pow(0.995, Math.floor(miners / 100_000));
      const floored = Math.max(perDay, 0.0002);
      return [`${miners.toLocaleString()} miners`, `${floored.toFixed(12).replace(/0+$/, '').replace(/\.$/, '')} OBS`];
    });
    schedulePanel.replaceChildren(
      el('h2', {}, 'Mining schedule'),
      kv([
        ['Active miners (30-day window)', String(schedule.activeMiners)],
        ['Reward per day now', rewardLine(schedule)],
        ['Reward per claim now', rewardPerClaim(schedule)],
        ['Reduction step', `−${schedule.reductionPercentPerStep}% per ${schedule.reductionStepMiners.toLocaleString()} active miners`],
        ['Hard floor', `${obs(schedule.floorDailyObs || schedule.floorDailySeals)} OBS/day`],
      ]),
      el('h3', {}, 'Schedule'),
      table(['Active miners', 'Reward per day'], tiers),
      el('h3', {}, 'Proof of Time'),
      kv([
        ['Consensus', pot ? `${pot.consensus.replace(/_/g, ' ').toLowerCase()} (${pot.shortName})` : 'Proof of Time (PoT)'],
        [
          'Authoritative clock',
          pot
            ? `${pot.timeAuthority.authoritative.replace(/_/g, ' ').toLowerCase()} · chain time ${pot.protocolTime}, median time past ${pot.medianTimePast}`
            : 'protocol time from the chain',
        ],
        [
          'Time-Rate',
          pot && pot.timeRate.windowSeconds > 0
            ? `${pot.timeRate.blocksPerMinute.toFixed(2)} blocks/min · ${pot.timeRate.transactionsPerMinute.toFixed(2)} tx/min`
            : 'not measurable yet',
        ],
      ]),
      el(
        'p',
        { class: 'fineprint' },
        'Active miner = at least one valid claim in the last 30 days. The schedule is recomputed from chain state by every node; the website merely formats it. ' +
          'Your claim window is measured in protocol time: changing your device clock changes the countdown you see and nothing the protocol accepts.',
      ),
    );
  } catch (error) {
    schedulePanel.replaceChildren(el('h2', {}, 'Mining schedule'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function loadHistory(): Promise<void> {
  const address = Wallet.storedAddress();
  if (!address) {
    historyPanel.replaceChildren();
    return;
  }
  try {
    const claims = await client.miningClaims(address, 25);
    historyPanel.replaceChildren(
      el('h2', {}, 'Your claims'),
      claims.claims.length === 0
        ? el('p', {}, 'No claims found for this address yet.')
        : table(
            ['Claim id', 'Reward', 'Block', 'When', 'Genesis'],
            claims.claims.map((claim) => [
              el('span', { class: 'mono' }, short(String(claim.claimId ?? claim.txId ?? ''), 14)),
              `${obs(claim.rewardObs ?? claim.reward ?? '0')} OBS`,
              String(claim.height ?? '—'),
              when(Number(claim.timestamp ?? 0)),
              claim.genesisAwarded ? badge('genesis allocation', 'ok') : el('span', { class: 'muted' }, '—'),
            ]),
          ),
    );
  } catch (error) {
    historyPanel.replaceChildren(el('h2', {}, 'Your claims'), el('p', { class: 'error' }, (error as Error).message));
  }
}
