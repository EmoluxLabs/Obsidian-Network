/**
 * The explorer.
 *
 * It follows the platform's own explorer rules (docs/explorer.md), because an
 * explorer that is more permissive than the product it sits beside is a different
 * product:
 *
 *   Rule 1 — never expose wallet balances. Nothing here asks for one.
 *   Rule 2 — transaction and block ids are not wallet addresses. There is no
 *            "search by address": an address that appears next to a transaction is
 *            masked by the node, and is masked again here before it is drawn. Your
 *            own activity lives on the WALLET screen, where it is yours to see.
 *
 * Every figure is a value a node returned. A node that has not answered renders as
 * an em dash or an explicit "unavailable"; nothing is estimated, extrapolated or
 * defaulted into looking plausible. In particular no age is computed from this
 * browser's clock — the chain's own timestamps are shown as chain time.
 *
 * Pure rendering: it takes state and the shared helpers and returns markup. Data
 * loading and handlers live in real.mjs.
 */

import { formatTime, arg, displayObsWithUnit, displayInteger, shortenIdentifier, describeMiningPool, EXACT_OBS } from './data.mjs';
import { identifierHtml, copyButtonHtml } from './identifier.mjs';

export const EXPLORER_TABS = [
  ['overview', 'OVERVIEW'],
  ['blocks', 'BLOCKS'],
  ['claims', 'CLAIMS'],
  ['names', 'NAMES'],
  ['network', 'NETWORK'],
];

/** The shape a fresh explorer starts in. */
export function emptyExplorer() {
  return { tab: 'overview', detail: null, loading: false, data: {}, errors: {} };
}

/** A chain timestamp as a plain date. Formatting only: nothing here reads a clock. */
function isoDate(seconds) {
  const ms = Number(seconds) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '—';
}

/**
 * An address as the explorer draws it: the platform-wide short form (`obs1ijdn...slvgsi`). A value the node has
 * already masked (`dobs13s4pg…rs0ff0`) is left exactly as it came. Display only.
 */
export function mask(value) {
  const text = String(value ?? '');
  return text ? shortenIdentifier(text, 'address', 'narrow') : '—';
}

/**
 * What the Mining Pool figure means, said once under the supply rows. The pool is a recycling pool: fees paid by
 * payments, names and node registrations flow in, and the next mining claim is paid from it first. So 0 is normal
 * once the fees have been paid out, and it is only drawn as 0 when the node said 0.
 */
function poolNote(pool, esc) {
  if (pool.state === 'unavailable') {
    return `<p class="mu" style="font-size:12.5px;margin:8px 0 0">MINING POOL is unavailable: ${esc(pool.reason)}</p>`;
  }
  if (pool.state !== 'ok') return '';
  const lifetime =
    pool.lifetimeInflow && pool.lifetimeDistributed
      ? ` Fees received so far: ${esc(pool.lifetimeInflow)}. Paid out to miners so far: ${esc(pool.lifetimeDistributed)}.`
      : '';
  return `<p class="mu" style="font-size:12.5px;margin:8px 0 0">MINING POOL holds fees waiting to be paid to the next mining claim${pool.zero ? '; it is 0 because everything received has been paid out' : ''}. It is separate from total supply, mined supply, the node-runner pool, the treasury and any wallet.${lifetime}</p>`;
}

export function explorerScreen(s, ui) {
  const { header, designField, designNav, errorLine } = ui;
  const ex = s.ex ?? emptyExplorer();

  const body = ex.detail ? detail(s, ex, ui) : tabs(s, ex, ui);
  return (
    header(s, 'EXPLORER') +
    designField('q', '', 'text', 'Block height, block id, tx id or name.obs') +
    `<button class="btn p" style="margin-top:10px" onclick="ObsidianSearch()">${
      s.busy === 'search' ? 'SEARCHING…' : 'SEARCH'
    }</button>` +
    errorLine(s) +
    body +
    (s.account ? designNav('explorer') : `<button class="btn" onclick="ObsidianGo('landing')">‹ BACK</button>`)
  );
}

// ── tabs ─────────────────────────────────────────────────────────────────────

function tabs(s, ex, ui) {
  const { esc } = ui;
  const bar =
    `<div style="display:flex;gap:6px;margin:18px 0 4px">` +
    EXPLORER_TABS.map(
      ([key, label]) =>
        `<button class="btn ${ex.tab === key ? 'p' : ''}" style="flex:1 1 0;min-width:0;width:auto;height:40px;margin:0;padding:0;font-size:9.5px;letter-spacing:.04em" onclick="ObsidianExTab('${arg(
          key,
        )}')">${esc(label)}</button>`,
    ).join('') +
    `</div>`;
  const view = { overview, blocks, claims, names, network }[ex.tab] ?? overview;
  const failed = ex.errors[ex.tab];
  return (
    bar +
    (failed
      ? `<div class="card" style="margin-top:10px"><div class="row" style="color:var(--er)">${esc(failed)}</div></div>`
      : '') +
    view(s, ex, ui)
  );
}

function loading(ex, ui, what) {
  return ui.unavailable(ex.loading ? `Asking the node for ${what}…` : `The node has not returned ${what}.`);
}

function overview(s, ex, ui) {
  const { esc, rows, orDash } = ui;
  const d = ex.data.overview;
  const status = d?.status ?? s.status;
  if (!status) return loading(ex, ui, 'the chain status');
  const supply = d?.supply;
  const pot = d?.pot;
  const net = s.network?.network;
  const obs = (v) => esc(orDash(v, displayObsWithUnit));
  // The Mining Pool comes from the node's own state (`/supply` poolBalanceObs), checked against the chain this app
  // is for. A missing answer or the wrong chain is shown as such, never as 0 OBS.
  const pool = describeMiningPool({ expectedChainId: s.appConfig?.chainId, status, supply });
  const exact = (v) => esc(displayObsWithUnit(v, EXACT_OBS));
  const withTip = (v, text) => (typeof v === 'string' ? `<span title="Exact: ${exact(v)}">${text}</span>` : text);

  return (
    `<div class="lb">CHAIN</div>` +
    rows([
      ['NETWORK', esc(orDash(net?.displayName ?? net?.name)), ''],
      ['CHAIN ID', esc(orDash(status.chainId)), 'm'],
      ['ADDRESS PREFIX', esc(orDash(net?.addressHrp, (v) => `${v}1…`)), 'm'],
      ['HEIGHT', orDash(status.height, (h) => `#${displayInteger(h)}`), 'm'],
      ['FINALIZED', orDash(status.finalizedHeight, (h) => `#${displayInteger(h)}`), 'm'],
      ['LAST BLOCK', esc(orDash(status.lastBlockTimestamp, formatTime)), ''],
      ['PROTOCOL', esc(orDash(status.protocolVersion)), 'm'],
      ['MEMPOOL', esc(orDash(status.mempool?.transactions ?? d?.mempool?.size)), 'm'],
    ]) +
    `<div class="lb">IDENTITY</div>` +
    `<div class="card">${[
      ['HEAD BLOCK', status.headHash],
      ['GENESIS ID', status.genesisId],
      ['PARAMS HASH', status.paramsHash],
    ]
      .map(
        ([label, value]) =>
          `<div class="row" style="display:block"><span>${esc(label)}</span><div class="m" style="font-size:12px;margin-top:6px">${identifierHtml(
            value,
            'hash',
            { label },
          )}</div></div>`,
      )
      .join('')}</div>` +
    `<div class="lb">SUPPLY</div>` +
    (pool.state === 'mismatch'
      ? ui.unavailable(pool.reason)
      : supply
      ? rows([
          ['TOTAL SUPPLY', withTip(supply.totalSupplyObs, obs(supply.totalSupplyObs)), 'm'],
          ['MAXIMUM', obs(supply.maxSupplyObs), 'm'],
          ['GENESIS ISSUED', obs(supply.genesisIssuedObs), 'm'],
          ['MINED', withTip(supply.minedSupplyObs, obs(supply.minedSupplyObs)), 'm'],
          ['MINING POOL', pool.state === 'ok' ? `<span title="Exact: ${esc(pool.exact)}">${esc(pool.value)}</span>` : esc(pool.value), 'm'],
          [
            'SUPPLY INVARIANT',
            supply.invariantOk === true && supply.maximumRespected === true ? 'HOLDS' : 'NOT CONFIRMED',
            supply.invariantOk === true && supply.maximumRespected === true ? 'ok' : '',
          ],
        ])
      : loading(ex, ui, 'the supply')) +
    poolNote(pool, esc) +
    `<div class="lb">GENESIS ALLOCATION</div>` +
    (status.genesis
      ? rows([
          ['STATE', status.genesis.allocationClaimed ? 'CLAIMED' : 'UNCLAIMED', status.genesis.allocationClaimed ? '' : 'ok'],
          ['AMOUNT', obs(status.genesis.allocationObs), 'm'],
          ['CLAIMED AT HEIGHT', esc(orDash(status.genesis.claimedAtHeight)), 'm'],
        ])
      : loading(ex, ui, 'the genesis state')) +
    `<div class="lb">PROOF OF TIME</div>` +
    (pot
      ? rows([
          ['CONSENSUS', esc(`${String(pot.consensus ?? '').replace(/_/g, ' ')}`), ''],
          ['CHAIN TIME', esc(orDash(pot.protocolTime, formatTime)), ''],
          ['MEDIAN TIME PAST', esc(orDash(pot.medianTimePast, formatTime)), ''],
          [
            'BLOCK SPACING',
            pot.difficulty?.warmingUp
              ? 'WARMING UP'
              : esc(orDash(pot.difficulty?.observedSpacingMs, (ms) => `${(Number(ms) / 1000).toFixed(2)}s`)),
            'm',
          ],
          [
            'BLOCKS / MIN',
            esc(orDash(pot.timeRate?.blocksPerMinute, (v) => Number(v).toFixed(2))),
            'm',
          ],
          ['TX / MIN', esc(orDash(pot.timeRate?.transactionsPerMinute, (v) => Number(v).toFixed(2))), 'm'],
        ]) +
        `<p class="mu" style="font-size:12px;line-height:1.5">${esc(pot.explanation ?? '')}</p>`
      : loading(ex, ui, 'Proof of Time state')) +
    privacyNote()
  );
}

function blocks(s, ex, ui) {
  const { esc } = ui;
  const list = ex.data.blocks?.blocks;
  if (!list?.length) return loading(ex, ui, 'blocks');
  return (
    `<div class="lb">LATEST BLOCKS</div>` +
    `<div class="card">${list
      .map(
        (b) =>
          `<div class="row" onclick="ObsidianExOpen('block','${arg(b.height)}')" style="cursor:pointer"><div><b class="m">#${displayInteger(b.height)}</b><div class="m mu" style="font-size:12px;margin-top:3px">${identifierHtml(b.hash, 'hash', { interactive: false, label: 'Block id' })}</div><div class="mu" style="font-size:11px;margin-top:3px">${esc(formatTime(b.timestamp))} · ${esc(
            b.size,
          )} B</div></div><span class="pill">${esc(b.txCount ?? 0)} TX</span></div>`,
      )
      .join('')}</div>`
  );
}

function claims(s, ex, ui) {
  const { esc } = ui;
  const d = ex.data.claims;
  if (!d?.claims) return loading(ex, ui, 'mining claims');
  return (
    `<div class="lb">ACTIVE MINERS</div>` +
    ui.rows([['LAST 30 DAYS', esc(ui.orDash(d.activeMiners)), 'm']]) +
    `<div class="lb">LATEST MINING CLAIMS</div>` +
    (d.claims.length
      ? `<div class="card">${d.claims
          .map(
            (c) =>
              `<div class="row" onclick="ObsidianExOpen('tx','${arg(c.txId)}')" style="cursor:pointer"><div><b class="m">${esc(
                mask(c.miner),
              )}</b><div class="mu" style="font-size:12px;margin-top:3px">block ${esc(displayInteger(c.height))} · ${esc(
                formatTime(c.timestamp),
              )}</div>${
                c.genesisAwarded
                  ? `<div class="pill" style="display:inline-block;margin-top:6px;background:#FBF6E8;color:var(--gd)">GENESIS ALLOCATION</div>`
                  : ''
              }</div><b class="m ok">+${esc(displayObsWithUnit(c.rewardObs))}</b></div>`,
          )
          .join('')}</div>`
      : ui.unavailable('No mining claim has been made on this chain yet.'))
  );
}

function names(s, ex, ui) {
  const { esc } = ui;
  const d = ex.data.names;
  if (!d?.names) return loading(ex, ui, 'the name registry');
  return (
    `<div class="lb">REGISTERED NAMES</div>` +
    (d.names.length
      ? `<div class="card">${d.names
          .map(
            (n) =>
              `<div class="row" onclick="ObsidianExOpen('name','${arg(n.name)}')" style="cursor:pointer"><div><b class="m">${esc(
                n.name,
              )}</b><div class="m mu" style="font-size:12px;margin-top:3px">${esc(mask(n.owner))}</div></div><span class="pill">UNTIL ${esc(
                isoDate(n.expiresAt),
              )}</span></div>`,
          )
          .join('')}</div>`
      : ui.unavailable('No .obs name has been registered on this chain yet.')) +
    `<button class="btn" onclick="ObsidianGo('ons')">REGISTER A NAME</button>`
  );
}

function network(s, ex, ui) {
  const { esc, rows, orDash } = ui;
  const d = ex.data.network;
  if (!d) return loading(ex, ui, 'the network state');
  const connection = d.nodes;
  const producers = d.producers;
  const finality = d.finality;
  const rewards = d.rewards;
  const audit = d.audit?.questions ?? [];
  return (
    // A connection summary, never a node list: which nodes this app reads from, and their addresses, are not published.
    `<div class="lb">CONNECTION</div>` +
    (typeof connection?.live === 'boolean'
      ? rows([
          ['CHAIN', connection.live ? 'REACHABLE' : 'UNREACHABLE', connection.live ? 'm' : ''],
          ['NETWORK HEIGHT', esc(orDash(connection.consensusHeight)), 'm'],
        ]) +
        (connection.genesisMismatch
          ? `<div class="err">The nodes disagree about the genesis block. Do not sign anything until that is resolved.</div>`
          : '')
      : ui.unavailable('The connection to the chain could not be checked.')) +
    `<div class="lb">BLOCK PRODUCERS</div>` +
    (producers
      ? rows([
          ['SCHEDULE', esc(orDash(producers.tier)), 'm'],
          ['ELIGIBLE NOW', esc(orDash(producers.eligible)), 'm'],
          ['REGISTERED NODES', esc(orDash(producers.registered)), 'm'],
          ['BANNED', esc(orDash(producers.banned)), 'm'],
          ['RULE', esc(orDash(producers.rule)), 'm'],
        ])
      : loading(ex, ui, 'the producer schedule')) +
    `<div class="lb">FINALITY</div>` +
    (finality
      ? rows([
          ['FINALIZED HEIGHT', esc(orDash(finality.finalizedHeight)), 'm'],
          ['BLOCKS BEHIND HEAD', esc(orDash(finality.lag)), 'm'],
          ['STATUS', esc(orDash(finality.reason)), ''],
        ])
      : loading(ex, ui, 'finality')) +
    `<div class="lb">MEMPOOL</div>` +
    (d.mempool
      ? rows([
          ['TRANSACTIONS WAITING', esc(orDash(d.mempool.size)), 'm'],
          ['BYTES', esc(orDash(d.mempool.bytes)), 'm'],
        ])
      : loading(ex, ui, 'the mempool')) +
    `<div class="lb">NODE RUNNER REWARDS</div>` +
    (rewards
      ? rows([
          ['SPLIT', esc(`${Number(rewards.split?.nodePoolBps) / 100}% nodes · ${Number(rewards.split?.treasuryBps) / 100}% treasury`), ''],
          ['REWARD POOL', esc(orDash(rewards.pool?.balanceObs, displayObsWithUnit)), 'm'],
          ['DISTRIBUTED', esc(orDash(rewards.pool?.lifetimeDistributedObs, displayObsWithUnit)), 'm'],
          ['NEXT SETTLEMENT', esc(orDash(rewards.pool?.nextSettlementAt, formatTime)), ''],
        ])
      : loading(ex, ui, 'the reward pool')) +
    `<div class="lb">CAN ANYONE SHUT IT DOWN?</div>` +
    (audit.length
      ? `<div class="card">${audit
          .map(
            (q) =>
              `<div class="row" style="display:block"><div style="display:flex;justify-content:space-between;gap:10px"><b style="font-size:13px">${esc(
                q.question,
              )}</b><span class="pill" style="${q.answer === 'NO' ? '' : 'background:#FDECEA;color:#A12626'}">${esc(
                q.answer,
              )}</span></div><div class="mu" style="font-size:12px;line-height:1.5;margin-top:6px;font-weight:400;letter-spacing:0">${esc(
                q.evidence,
              )}</div></div>`,
          )
          .join('')}</div>`
      : loading(ex, ui, 'the decentralization audit'))
  );
}

// ── details ──────────────────────────────────────────────────────────────────

function detail(s, ex, ui) {
  const { esc } = ui;
  const d = ex.detail;
  const back = `<button class="btn" style="margin-top:14px" onclick="ObsidianExClose()">‹ BACK TO ${esc(
    (EXPLORER_TABS.find(([k]) => k === ex.tab)?.[1] ?? 'LIST'),
  )}</button>`;
  if (d.kind === 'block') return back + blockDetail(d.block, s, ui);
  if (d.kind === 'transaction') return back + txDetail(d.transaction, ui);
  if (d.kind === 'name') return back + nameDetail(d.record, ui);
  return back;
}

/** A full-width id, wrapped, never truncated: a detail page is where you copy it. */
function longValue(label, value, ui, link) {
  const { esc, orDash } = ui;
  const text = orDash(value);
  const inner = link && value ? `<a style="cursor:pointer;text-decoration:underline" onclick="${link}">${esc(text)}</a>` : esc(text);
  const copy = value ? `<div style="margin-top:6px">${copyButtonHtml(String(value), label)}</div>` : '';
  return `<div class="row" style="display:block"><span>${esc(label)}</span><div class="m" style="word-break:break-all;font-size:12px;margin-top:6px">${inner}</div>${copy}</div>`;
}

function blockDetail(b, s, ui) {
  const { esc, rows, orDash } = ui;
  const summary = b.summary ?? {};
  const header = b.header ?? {};
  const height = Number(summary.height ?? header.height);
  const head = Number(s.status?.height ?? NaN);
  const txs = b.transactions ?? [];
  return (
    `<div class="lb">BLOCK #${esc(Number.isFinite(height) ? displayInteger(height) : '—')}</div>` +
    rows(
      [
        ['TIME', esc(orDash(summary.timestamp ?? header.timestamp, formatTime)), ''],
        ['TRANSACTIONS', esc(orDash(txs.length ?? summary.txCount, displayInteger)), 'm'],
        // A reported size of 0 is the node not knowing, not an empty block.
        Number(summary.size) > 0 ? ['SIZE', esc(`${summary.size} B`), 'm'] : null,
        ['PRODUCER', esc(mask(header.producer ?? summary.producer)), 'm'],
        ['CONFIRMATIONS', esc(orDash(b.confirmations)), 'm'],
      ].filter(Boolean),
    ) +
    `<div class="card" style="margin-top:10px">` +
    longValue('BLOCK ID', summary.hash ?? b.hash, ui) +
    longValue(
      'PARENT',
      header.prevHash ?? summary.prevHash,
      ui,
      Number.isFinite(height) && height > 0 ? `ObsidianExOpen('block','${arg(height - 1)}')` : '',
    ) +
    longValue('TRANSACTION ROOT', header.txRoot, ui) +
    longValue('STATE ROOT', header.stateRoot, ui) +
    `</div>` +
    `<div style="display:flex;gap:12px">` +
    `<button class="btn" ${Number.isFinite(height) && height > 0 ? '' : 'disabled'} onclick="ObsidianExOpen('block','${arg(
      height - 1,
    )}')">‹ PREVIOUS</button>` +
    `<button class="btn" ${Number.isFinite(height) && Number.isFinite(head) && height < head ? '' : 'disabled'} onclick="ObsidianExOpen('block','${arg(
      height + 1,
    )}')">NEXT ›</button></div>` +
    `<div class="lb">TRANSACTIONS IN THIS BLOCK</div>` +
    (txs.length
      ? `<div class="card">${txs
          .map((t) => {
            const id = t.id ?? t.txId;
            return `<div class="row" onclick="ObsidianExOpen('tx','${arg(id)}')" style="cursor:pointer"><div><b class="m" style="font-size:12px">${identifierHtml(id, 'hash', { interactive: false, label: 'Transaction id' })}</b><div class="mu" style="font-size:12px;margin-top:3px">${esc(
              t.kind ?? t.typeName ?? `type ${t.type}`,
            )} · ${esc(mask(t.sender))}</div></div><span class="pill">${esc(orDash(t.gas, displayObsWithUnit))}</span></div>`;
          })
          .join('')}</div>`
      : ui.unavailable('This block contains no transactions.')) +
    privacyNote()
  );
}

function txDetail(t, ui) {
  const { esc, rows, orDash } = ui;
  const confirmed = t.confirmed === true || String(t.status).toUpperCase() === 'INCLUDED';
  return (
    `<div class="lb">TRANSACTION</div>` +
    rows(
      [
        ['TYPE', esc(orDash(t.kind ?? t.typeName ?? t.type)), 'm'],
        ['STATUS', esc(orDash(t.status)), confirmed ? 'ok' : ''],
        ['CONFIRMATIONS', esc(orDash(t.confirmations)), 'm'],
        ['TIME', esc(orDash(t.timestamp, formatTime)), ''],
        ['SENDER', esc(mask(t.sender)), 'm'],
        // Only the fields this transaction actually has: a claim has no recipient
        // or amount, and a row of dashes for them is noise that reads as missing data.
        t.recipient ? ['RECIPIENT', esc(mask(t.recipient)), 'm'] : null,
        t.amount ? ['AMOUNT', esc(displayObsWithUnit(t.amount)), 'm'] : null,
        ['GAS', esc(orDash(t.gas, displayObsWithUnit)), 'm'],
        ['BLOCK', orDash(t.height, (h) => `#${displayInteger(h)}`), 'm'],
      ].filter(Boolean),
    ) +
    `<div class="card" style="margin-top:10px">` +
    longValue('TRANSACTION ID', t.txId, ui) +
    longValue('BLOCK ID', t.blockHash, ui, t.height !== undefined ? `ObsidianExOpen('block','${arg(t.height)}')` : '') +
    (t.reference ? longValue('REFERENCE', t.reference, ui) : '') +
    `</div>` +
    (t.note ? `<p class="mu" style="font-size:12.5px">${esc(t.note)}</p>` : '') +
    privacyNote()
  );
}

function nameDetail(r, ui) {
  const { esc, rows, orDash } = ui;
  return (
    `<div class="lb">${esc(r.name)}</div>` +
    rows([
      ['RESOLVES TO', esc(mask(r.address)), 'm'],
      ['OWNER', esc(mask(r.owner)), 'm'],
      ['REGISTERED AT BLOCK', orDash(r.registeredAtHeight, (h) => `#${displayInteger(h)}`), 'm'],
      ['EXPIRES', esc(orDash(r.expiresAt, formatTime)), ''],
      ['TRANSFERS', esc(orDash(r.transferCount)), 'm'],
    ]) +
    `<p class="mu" style="font-size:12.5px;line-height:1.5">A name maps to exactly one wallet. Registration, renewal and transfer are blockchain state changes, not rows in a company database.</p>` +
    privacyNote()
  );
}

function privacyNote() {
  return `<p class="mu" style="font-size:12px;line-height:1.5;margin-top:14px">Addresses are masked here, and balances are never shown: an explorer cannot be used to look up what a wallet holds. Your own activity is on the WALLET screen.</p>`;
}
