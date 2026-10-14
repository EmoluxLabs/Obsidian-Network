/**
 * Explorer.
 *
 * Explorer privacy rule (spec §39): an explorer may show transaction amounts,
 * fees, block production and activity counts, but NEVER a wallet's balance and
 * never a partial wallet address next to a transaction. Transaction and block
 * identifiers use their own checksummed format, so a wallet address can never be
 * mistaken for a hash. The node enforces this: it refuses to serve balances on
 * the explorer surface, and this page never asks for one.
 */

import { layout } from '../lib/shell.js';
import { ObsidianClient, type BlockDetail, type BlockSummary } from '../lib/client.js';
import { el, obsUnit, amountEl, count, spinner, toast, kv, badge, table, relativeTime, when } from '../lib/ui.js';
import { identifier } from '../lib/identifier.js';
import { session } from '../lib/session.js';
import { describeMiningPool, UNAVAILABLE } from '../../core/protocol/display.js';

const client = new ObsidianClient();

const searchBox = el('input', { id: 'explorer-search', placeholder: 'Block height, block id, transaction id or .obs name', autocomplete: 'off' });
const resultPanel = el('section', { class: 'card', id: 'explorer-result' }, el('p', { class: 'muted' }, 'Search a block, a transaction or an ONS name. Balances are not available here by design.'));
const blocksPanel = el('section', { class: 'card', id: 'blocks' }, spinner());
const statsPanel = el('section', { class: 'card', id: 'chain-stats' }, spinner());

const searchButton = el('button', { class: 'primary', type: 'button', id: 'explorer-go' }, 'Search');
searchButton.addEventListener('click', () => void search(searchBox.value.trim()));
searchBox.addEventListener('keydown', (event) => {
  if ((event as KeyboardEvent).key === 'Enter') void search(searchBox.value.trim());
});

layout({
  current: 'explorer',
  title: 'Explorer',
  tagline: 'Blocks, transactions and ONS names straight from Obsidian Core nodes.',
  children: [
    el('section', { class: 'search-bar' }, searchBox, searchButton),
    resultPanel,
    statsPanel,
    blocksPanel,
  ],
});

void boot();

async function boot(): Promise<void> {
  await Promise.all([loadChainStats(), loadBlocks()]);
  window.setInterval(() => void loadBlocks(), 15_000);
}

async function loadChainStats(): Promise<void> {
  try {
    const [status, supply, network, audit, pot, config] = await Promise.all([
      client.status(),
      client.supply(),
      client.network(),
      client.requestSafe<Record<string, unknown>>('/audit/decentralization'),
      // Optional: an older node predates /pot, and the explorer must still work
      // against it rather than failing the whole panel. A partial answer counts
      // as "unsupported" — see client.proofOfTime().
      client.proofOfTime().catch(() => undefined),
      // The chain this interface is for. Without it the check below is skipped (the server already refuses nodes on
      // another chain; this is the second, visible line of defence).
      session.config().catch(() => undefined),
    ]);
    // The Mining Pool is the node's own state (`/supply` poolBalanceObs): never inferred from supply or mined, and
    // never drawn as 0 unless the node said 0. A node on another chain shows no figures.
    const pool = describeMiningPool({ expectedChainId: config?.chainId ?? undefined, status, supply });
    statsPanel.replaceChildren(
      el('h2', {}, 'Chain'),
      kv([
        ['Network', `${status.networkId} · chain ${status.chainId} · ${network.network?.addressHrp ?? 'obs'}1…`],
        ['Height', count(status.height)],
        ['Head block id', identifier(status.headHash, { kind: 'hash', label: 'Head block id' })],
        ['Genesis id', identifier(status.genesisId, { kind: 'id', label: 'Genesis id' })],
        ['Params hash', identifier(status.paramsHash, { kind: 'hash', label: 'Params hash' })],
        ['Protocol version', status.protocolVersion],
        ['Consensus', pot ? `${pot.consensus.replace(/_/g, ' ').toLowerCase()} (${pot.shortName})` : 'Proof of Time (PoT)'],
        [
          'PoT difficulty',
          pot
            ? pot.difficulty.warmingUp
              ? 'warming up — fewer blocks than the measurement window'
              : `${(pot.difficulty.difficultyBps / 100).toFixed(2)}% of target · observed ${(pot.difficulty.observedSpacingMs / 1000).toFixed(2)}s between blocks`
            : '—',
        ],
        [
          'Time-Rate',
          pot && pot.timeRate.windowSeconds > 0
            ? `${pot.timeRate.blocksPerMinute.toFixed(2)} blocks/min · ${pot.timeRate.transactionsPerMinute.toFixed(2)} tx/min`
            : 'not measurable yet — fewer than two blocks in the window',
        ],
        ['Accumulated PoT weight', pot ? el('span', { class: 'mono' }, pot.cumulativePotWeight) : '—'],
        ['Supply', pool.state === 'mismatch' ? UNAVAILABLE : el('span', {}, amountEl(status.supplyObs), ' of ', amountEl(status.maxSupplyObs))],
        ['Mining pool', pool.state === 'ok' ? el('span', { title: `Exact: ${pool.exact}`, id: 'mining-pool-value' }, pool.value) : el('span', { id: 'mining-pool-value', class: 'muted' }, `${pool.value} — ${pool.reason}`)],
        ['Peers', String(status.peers)],
        ['Last block', `${relativeTime(status.lastBlockTimestamp)} (${when(status.lastBlockTimestamp)})`],
        [
          'Time authority',
          pot ? `${pot.timeAuthority.authoritative.replace(/_/g, ' ').toLowerCase()} — never your browser clock` : '—',
        ],
        ['Genesis allocation', status.genesis ? `${status.genesis.allocationClaimed ? 'claimed' : 'unclaimed'} · ${obsUnit(status.genesis.allocationObs)}` : '—'],
      ]),
      ...(audit ? [decentralisationSummary(audit)] : []),
      miningPoolNote(pool),
      el('p', { class: 'fineprint' }, 'Every field above is recomputed by each node from the chain. Balances are deliberately absent: the explorer surface never exposes them.'),
    );
  } catch (error) {
    statsPanel.replaceChildren(el('h2', {}, 'Chain'), el('p', { class: 'error' }, (error as Error).message));
  }
}

/**
 * What the Mining Pool figure means. The pool is a recycling pool: fees from payments, names and node registrations
 * flow in, and the next mining claim is paid from it first, so 0 is the normal reading once those fees have been
 * paid out. It is separate from total supply, mined supply, the node-runner pool, the treasury and any wallet.
 */
function miningPoolNote(pool: ReturnType<typeof describeMiningPool>): HTMLElement {
  if (pool.state !== 'ok') return el('p', { class: 'fineprint', id: 'mining-pool-note' }, `Mining pool unavailable: ${pool.reason}`);
  const lifetime = pool.lifetimeInflow && pool.lifetimeDistributed ? ` Fees received so far: ${pool.lifetimeInflow}. Paid out to miners so far: ${pool.lifetimeDistributed}.` : '';
  return el(
    'p',
    { class: 'fineprint', id: 'mining-pool-note' },
    `The Mining Pool holds fees waiting to be paid to the next mining claim${pool.zero ? '; it reads 0 because everything received has been paid out' : ''}. It is separate from total supply, mined supply, the node-runner pool, the treasury and any wallet.${lifetime}`,
  );
}

async function loadBlocks(): Promise<void> {
  try {
    const { blocks } = await client.blocks(15);
    blocksPanel.replaceChildren(
      el('h2', {}, 'Latest blocks'),
      table(
        ['Height', 'Block id', 'Transactions', 'Size', 'Age'],
        blocks.map((block: BlockSummary) => [
          el('a', { class: 'mono link', href: `#/block/${block.height}` }, count(block.height)),
          identifier(block.hash, { kind: 'hash', href: `#/block/${block.hash}`, copy: false, label: 'Block id' }),
          String(block.txCount),
          `${block.size} B`,
          relativeTime(block.timestamp),
        ]),
      ),
    );
  } catch (error) {
    blocksPanel.replaceChildren(el('h2', {}, 'Latest blocks'), el('p', { class: 'error' }, (error as Error).message));
  }
}

async function search(term: string): Promise<void> {
  if (!term) return;
  resultPanel.replaceChildren(spinner('asking the nodes…'));
  try {
    if (/^\d+$/.test(term)) return void renderBlock(await client.block(term));
    if (/\.obs$/i.test(term)) {
      const record = await client.name(term.toLowerCase());
      resultPanel.replaceChildren(
        el('h2', {}, `ONS · ${term.toLowerCase()}`),
        kv([
          ['Resolves to (wallet address)', identifier(record.address, { kind: 'address' })],
          ['Registered at height', String(record.registeredAtHeight ?? '—')],
          ['Expires at height', String(record.expiresAt ?? '—')],
          ['Transfers', record.transferCount === 0 ? badge('never transferred', 'neutral') : badge(`${record.transferCount} transfers`, 'ok')],
        ]),
        el('p', { class: 'fineprint' }, 'A name maps to exactly one wallet. Transfers are blockchain state transitions, not rows in a company database.'),
      );
      return;
    }
    const tx = await client.transaction(term);
    resultPanel.replaceChildren(
      el('h2', {}, 'Transaction ', identifier(term, { kind: 'hash', label: 'Transaction id' })),
      kv([
        ['Included in block', tx.height === undefined || tx.height === null ? 'mempool' : count(tx.height as number)],
        ['Type', String(tx.kind ?? tx.type ?? '—')],
        ['Amount', tx.amount !== undefined && tx.amount !== null ? obsUnit(tx.amount) : '—'],
        ['Gas paid', tx.gas !== undefined ? obsUnit(tx.gas) : '—'],
        ['Timestamp', tx.timestamp ? `${when(Number(tx.timestamp))}` : 'pending'],
        ['Sender (masked by the node)', identifier(tx.sender === undefined ? undefined : String(tx.sender), { kind: 'address', label: 'Sender' })],
        ['Recipient (masked by the node)', identifier(tx.recipient === undefined ? undefined : String(tx.recipient), { kind: 'address', label: 'Recipient' })],
        ['Confirmations', String(tx.confirmations ?? '—')],
      ]),
      el('p', { class: 'fineprint' }, 'Addresses shown here are masked by the node before they leave it: an explorer page cannot be used to look up a wallet\'s holdings.'),
    );
  } catch (error) {
    toast((error as Error).message, 'error');
    resultPanel.replaceChildren(el('p', { class: 'error' }, (error as Error).message));
  }
}

async function renderBlock(block: BlockDetail): Promise<void> {
  const txs = block.transactions;
  resultPanel.replaceChildren(
    el('h2', {}, `Block ${count(block.header.height)}`),
    kv([
      ['Block id', identifier(block.hash, { kind: 'hash', detail: true, label: 'Block id' })],
      ['Parent', identifier(block.header.prevHash, { kind: 'hash', label: 'Parent block id' })],
      ['Producer', identifier(block.header.producer, { kind: 'address', label: 'Producer' })],
      ['Timestamp', `${when(block.header.timestamp)} (${relativeTime(block.header.timestamp)})`],
      ['Transactions', String(txs.length)],
      ['Size', `${block.summary.size} B`],
      ['State root', identifier(block.header.stateRoot, { kind: 'hash', label: 'State root' })],
      ['Confirmations', String(block.confirmations)],
    ]),
    txs.length > 0
      ? table(
          ['Transaction id', 'Type', 'Gas', 'Sender (masked)'],
          txs.map((tx) => [
            identifier(tx.id, { kind: 'hash', label: 'Transaction id' }),
            String(tx.type),
            obsUnit(tx.gas),
            identifier(tx.sender, { kind: 'address', label: 'Sender' }),
          ]),
        )
      : el('p', { class: 'muted' }, 'This block contains no transactions.'),
    el('p', { class: 'fineprint' }, 'Block producers and transaction senders are masked by the node before they leave it.'),
  );
}

void (async () => {
  const hash = window.location.hash.replace(/^#\/?/, '');
  if (!hash) return;
  const [kind, ...rest] = hash.split('/');
  const value = rest.join('/');
  if (kind === 'block' && value) {
    searchBox.value = value;
    void search(value);
  } else if (kind === 'tx' && value) {
    searchBox.value = value;
    void search(value);
  }
})();

/**
 * Render a value that may be a scalar, an array or a nested object.
 *
 * `String(value)` on an array of objects produces the useless
 * "[object Object],[object Object]" — a real defect once seen on the explorer.
 * Anything structured is summarised instead of stringified.
 */
function readable(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'none';
    return value.every((entry) => typeof entry !== 'object' || entry === null)
      ? value.map((entry) => String(entry)).join(', ')
      : `${value.length} ${value.length === 1 ? 'entry' : 'entries'}`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return 'none';
    return entries.map(([key, inner]) => `${key}: ${String(inner)}`).join(' · ');
  }
  return String(value);
}

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

/**
 * The node's /audit/decentralization report, rendered as what it actually is:
 * a list of attack questions with their answers, and the centralised
 * dependencies with their (bounded) consensus impact.
 */
function decentralisationSummary(audit: Record<string, unknown>): HTMLElement {
  const children: (HTMLElement | string)[] = [el('h3', {}, 'Decentralisation')];

  const questions = Array.isArray(audit.questions) ? (audit.questions as AuditQuestion[]) : [];
  if (questions.length > 0) {
    const allNo = questions.every((entry) => String(entry.answer).toUpperCase() === 'NO');
    children.push(
      el(
        'p',
        { class: 'muted' },
        `${questions.length} single-point-of-failure questions${allNo ? ', every one answered NO by this node' : ''}.`,
      ),
    );
    children.push(
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
    children.push(el('h3', {}, 'Centralised dependencies'));
    children.push(
      el(
        'p',
        { class: 'muted' },
        'Named on purpose. Each one is scoped so that losing it cannot stop or corrupt consensus.',
      ),
    );
    children.push(
      kv(
        dependencies.map((entry) => [
          String(entry.component ?? '—'),
          `${String(entry.scope ?? '—')} · consensus impact: ${String(entry.consensusImpact ?? '—')}`,
        ]),
      ),
    );
  }

  // Anything the node adds later still renders, just without bespoke styling.
  const known = new Set(['questions', 'centralisedDependencies']);
  const rest = Object.entries(audit).filter(([key]) => !known.has(key));
  if (rest.length > 0) children.push(kv(rest.map(([key, value]) => [key, readable(value)])));

  return el('div', {}, ...children);
}
