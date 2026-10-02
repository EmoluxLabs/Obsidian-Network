/**
 * Landing page.
 *
 * Scope rule the product owner set: this page describes the project and the
 * product. It is not a directory of buttons. There are exactly three calls to
 * action — Start Mining, Create Wallet, Explorer — because those are the three
 * things a visitor can actually do with a decentralised network.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient } from '../lib/client.js';
import { el, obs, badge, spinner, rewardLine, rewardPerClaim } from '../lib/ui.js';

const client = new ObsidianClient();

function cta(href: string, label: string, kind: 'primary' | 'secondary' | 'quiet'): HTMLElement {
  return el('a', { class: `cta cta-${kind}`, href }, label);
}

const hero = el(
  'section',
  { class: 'hero' },
  el('p', { class: 'eyebrow' }, 'Proof of Time · 21,000,000 OBS hard cap · no company in the middle'),
  el('h2', {}, 'A public ledger you can verify yourself,', el('br'), 'and the products built on it.'),
  el(
    'p',
    { class: 'lede' },
    'Obsidian Network is an independent blockchain. Mining, payments, .obs names, the land registry, time capsules and OBS Social all live inside the chain — ' +
      'not in a database owned by a company. Any node can be deleted; the chain survives, because consensus does not live in a server.',
  ),
  el(
    'div',
    { class: 'cta-row' },
    cta('/mine/', 'Start Mining', 'primary'),
    cta('/wallet/', 'Create Wallet', 'secondary'),
    cta('/explorer/', 'Explorer', 'quiet'),
  ),
  el(
    'p',
    { class: 'fineprint' },
    'Wallets are generated in your browser and never leave it. Mining pays 0.001 OBS a day at launch, never more than 21,000,000 OBS in total, and withdrawals need no KYC and no third-party token.',
  ),
);

const stats = el('section', { class: 'stat-grid', id: 'stats' }, spinner('reading the chain…'));

const pillars = el(
  'section',
  { class: 'pillars' },
  el(
    'article',
    { class: 'pillar' },
    el('h3', {}, 'Proof of Time, not Proof of Work'),
    el(
      'p',
      {},
      'Obsidian secures itself with verifiable time, not with a computational race. Blocks are produced on a validator schedule and accepted only when ' +
        'protocol time has genuinely advanced, so nobody buys authority with electricity. Mining is a claim every four hours, six a day, on a fixed ' +
        'schedule that falls with adoption and never below 0.0002 OBS a day — and eligibility comes from block timestamps, never from your device clock.',
    ),
  ),
  el(
    'article',
    { class: 'pillar' },
    el('h3', {}, 'Money that stays in the chain'),
    el(
      'p',
      {},
      'Every payment carries a 0.02% gas fee capped at 0.01 OBS, and every seal of it returns to the Mining Pool. ' +
        'Nothing is minted by an admin: the only issuance paths are the one-time genesis allocation and mining rewards.',
    ),
  ),
  el(
    'article',
    { class: 'pillar' },
    el('h3', {}, 'Products on real state'),
    el(
      'p',
      {},
      'Names, parcels, capsules, posts, tips and validator bonds are chain state with a Merkle root every node recomputes. ' +
        'Their prices are consensus parameters denominated in OBS, so the protocol needs no exchange rate and no price source to function. ' +
        'The interface here is a window; it can be replaced by any node operator.',
    ),
  ),
  el(
    'article',
    { class: 'pillar' },
    el('h3', {}, 'The nodes get paid'),
    el(
      'p',
      {},
      '40% of qualifying platform revenue goes to independent node runners and 60% to the protocol treasury — split inside the state transition, ' +
        'not by an invoice. A node earns from uptime, participation and reliability that other nodes attested; it cannot report its own numbers.',
    ),
  ),
  el(
    'article',
    { class: 'pillar' },
    el('h3', {}, 'No custody, no gatekeeping'),
    el(
      'p',
      {},
      'Nobody — including the people who wrote this page — can move your OBS. Keys are created in your browser, signed in your browser, and never transmitted. ' +
        'There is no admin mint, no $5 activation and no inside exchange.',
    ),
  ),
);

const how = el(
  'section',
  { class: 'how' },
  el('h3', {}, 'What happens when you press a button'),
  el(
    'ol',
    {},
    el('li', {}, el('strong', {}, 'Your browser signs.'), ' The private key is used locally to sign canonical bytes — the same encoder the node runs, shipped as the same module.'),
    el('li', {}, el('strong', {}, 'A node checks.'), ' The signed transaction is handed to an Obsidian Core node, which validates signatures, nonce, gas, balances and protocol rules.'),
    el('li', {}, el('strong', {}, 'The network decides.'), ' If the rules pass, miners include it in a block. If they do not, no amount of website design can override it.'),
  ),
);

const chains = el('section', { class: 'chains', id: 'network' }, spinner());

layout({
  current: 'landing',
  title: 'Obsidian Network',
  tagline: 'A decentralised ledger and the apps that run on it — verified, not promised.',
  children: [hero, stats, pillars, how, chains],
});

void (async () => {
  try {
    const [status, schedule, params] = await Promise.all([
      client.status(),
      client.miningSchedule().catch(() => undefined),
      client.params().catch(() => undefined),
    ]);
    stats.replaceChildren(
      stat('Blocks', status.height.toLocaleString()),
      stat('Supply', `${obs(status.supplyObs)} OBS`, `of 21,000,000`),
      stat('Peers', String(status.peers)),
      stat('Reward / day', schedule ? rewardLine(schedule) : '—', schedule ? `${rewardPerClaim(schedule)} per claim` : ''),
      stat('Active miners', String(schedule?.activeMiners ?? 0)),
      // Every protocol fee is denominated in OBS, so there is nothing on this
      // page that depends on a price feed. What a market pays for OBS is a
      // market's business, not the chain's.
      stat('Name registration', `${params?.ons.registrationFeeObs ?? '—'} OBS`, 'a consensus parameter, not a conversion'),
    );

    chains.replaceChildren(
      el('h3', {}, 'Networks'),
      el(
        'p',
        { class: 'muted' },
        'Four independent chains ship with the node software. This deployment reads ' +
          `${status.networkId} (chain id ${status.chainId}), genesis ${status.genesisId.slice(0, 16)}…`,
      ),
      el(
        'div',
        { class: 'chain-list' },
        ...[
          ['Mainnet', 7777, 'obs', '8630/8631'],
          ['Testnet', 7778, 'tobs', '18630/18631'],
          ['Staging', 7779, 'sobs', '28630/28631'],
          ['Devnet', 7780, 'dobs', '38630/38631'],
        ].map(([name, id, hrp, ports]) =>
          el(
            'div',
            { class: 'chain-card' },
            el('strong', {}, String(name)),
            el('span', {}, `chain ${id}`),
            el('span', { class: 'mono' }, `${hrp}1…`),
            el('span', { class: 'muted' }, `rpc/p2p ${ports}`),
          ),
        ),
      ),
      el(
        'p',
        { class: 'fineprint' },
        badge('NO PRICE ORACLE', 'ok'),
        ' Every protocol fee — names, business pages, land, validator bonds — is denominated in OBS and fixed by consensus. ' +
          'Nothing on this chain consults an external price source, so no feed can fail, stall or be manipulated into changing what anything costs. ' +
          'What OBS trades for elsewhere is a matter for those markets.',
      ),
    );
  } catch (error) {
    stats.replaceChildren(el('p', { class: 'error' }, `Could not read the chain: ${(error as Error).message}`));
    chains.replaceChildren();
  }
})();

function stat(label: string, value: string, sub?: string): HTMLElement {
  return el('div', { class: 'stat' }, el('span', { class: 'stat-label' }, label), el('strong', {}, value), sub ? el('span', { class: 'stat-sub' }, sub) : null);
}
