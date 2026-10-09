/**
 * The explorer, section by section.
 *
 * The platform's own explorer states two rules (docs/explorer.md) and this one has to
 * keep both, or it is a different and less careful product:
 *   1. it never shows a wallet balance;
 *   2. ids are not addresses — there is no search by address, and an address that
 *      appears beside a transaction is masked.
 *
 * Fixtures below are the shapes a live devnet node returned, including its
 * inconsistencies: /block returns the producer UNMASKED, /names returns the owner
 * address UNMASKED. The screen has to mask them itself and not trust the node to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCREENS } from '../public/screens.mjs';
import { emptyExplorer, mask, EXPLORER_TABS } from '../public/explorer.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FULL = 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0';
const PRODUCER = 'dobs148qsr3gydeljr65y4yx38ffswfv2ny4ledmnpw';
const TX = '05b2d7dd96066209deb5cd7497a915668cb90985b96e8494070cd2b2a03eb47d';
const BLOCK = '37df46cdc9122699d208a14c08281a7592bd89f701aa4b901a5929148b656f44';

const STATUS = {
  height: 216, headHash: 'ba'.repeat(32), genesisId: '1e7ca102f6720a7682e9a396958f2a17330dc001', chainId: 7780,
  protocolVersion: '1.6.1', paramsHash: '2dd76ca2b2305d725f3a975bfca04eb5', peers: 0, lastBlockTimestamp: 1791542032,
  finalizedHeight: 0, mempool: { transactions: 0, bytes: 0 },
  genesis: { allocationClaimed: true, allocationObs: '100000.000000000000000000', claimedAtHeight: 82 },
};
const NETWORK = { network: { name: 'devnet', displayName: 'OBS Devnet', chainId: 7780, addressHrp: 'dobs' } };
const APP = { network: 'devnet', chainId: 7780, addressHrp: 'dobs', production: false };

const DATA = {
  overview: {
    status: STATUS,
    supply: { totalSupplyObs: '100000.000166666666666666', maxSupplyObs: '21000000.000000000000000000', genesisIssuedObs: '100000.000000000000000000', minedSupplyObs: '0.000166666666666666', poolBalanceObs: '0.00101', invariantOk: true, maximumRespected: true },
    pot: { consensus: 'PROOF_OF_TIME', protocolTime: 1791542034, medianTimePast: 1791542007, difficulty: { warmingUp: true }, timeRate: { blocksPerMinute: 7.04, transactionsPerMinute: 0.13 }, explanation: 'Obsidian is a Proof of Time chain.' },
    mempool: { size: 0, bytes: 0 },
  },
  blocks: { blocks: [{ hash: BLOCK, height: 82, timestamp: 1791540604, txCount: 1, size: 606, producer: 'dobs148qsr…edmnpw', prevHash: 'f2'.repeat(32) }] },
  claims: { activeMiners: 1, claims: [{ txId: TX, height: 82, miner: 'dobs13s4pg…rs0ff0', rewardObs: '0.000166666666666666', timestamp: 1791540604, genesisAwarded: true }] },
  names: { count: 1, names: [{ name: 'e2e-test.obs', owner: 'dobs13s4pg…rs0ff0', address: FULL, expiresAt: 1823076674, registeredAtHeight: 96 }] },
  network: {
    nodes: { nodes: [{ url: 'http://127.0.0.1:38630', healthy: true, height: 216, latencyMs: 2, wrongNetwork: false }], genesisMismatch: false },
    validators: { count: 0, rotation: 'proposer(height, round) = activeValidators[(height + round) mod count]' },
    mempool: { size: 0, bytes: 0 },
    rewards: { split: { nodePoolBps: 9000, treasuryBps: 1000 }, pool: { balanceObs: '0.045', lifetimeDistributedObs: '0', nextSettlementAt: 1791590400 } },
    audit: { questions: [{ question: 'Can one server shut down the blockchain?', answer: 'NO', evidence: 'Any number of independent nodes store the chain.' }] },
  },
};

const render = (ex, extra = {}) =>
  SCREENS.explorer({ status: STATUS, network: NETWORK, appConfig: APP, ex: { ...emptyExplorer(), data: DATA, ...ex }, ...extra });

const LEAKS = [/\bundefined\b/, /\bNaN\b/, /\[object Object\]/, /\bnull\b(?![-\w])/];
function clean(html, label) {
  for (const leak of LEAKS) assert.doesNotMatch(html, leak, `${label} leaked ${leak}`);
}

test('there is a section for each thing worth looking at, and each renders real data', () => {
  assert.deepEqual(EXPLORER_TABS.map(([k]) => k), ['overview', 'blocks', 'claims', 'names', 'network']);
  const expected = {
    overview: [/OBS Devnet/, /#216/, /100000\.000166666666666666 OBS/, /SUPPLY INVARIANT/, /HOLDS/, /PROOF OF TIME/, /CLAIMED AT HEIGHT/],
    blocks: [/#82/, /1 TX/],
    claims: [/ACTIVE MINERS/, /dobs13s4pg…rs0ff0/, /GENESIS ALLOCATION/, /\+0\.000166666666666666/],
    names: [/e2e-test\.obs/, /REGISTER A NAME/, /UNTIL 2027-/],
    network: [/NODES THIS APP READS/, /HEALTHY/, /VALIDATORS/, /NODE RUNNER REWARDS/, /90% nodes/, /Can one server shut down/],
  };
  for (const [tab, patterns] of Object.entries(expected)) {
    const html = render({ tab });
    clean(html, tab);
    for (const pattern of patterns) assert.match(html, pattern, `${tab} should show ${pattern}`);
  }
});

test('rule 2: there is no search by address, in the form or the code', () => {
  const html = render({});
  assert.match(html, /Block height, block id, tx id or name\.obs/);
  assert.doesNotMatch(html, /placeholder="[^"]*address/i, 'the search box must not invite an address');
  for (const file of ['explorer.mjs', 'screens.mjs']) {
    const source = readFileSync(resolve(here, '../public', file), 'utf8');
    const explorerBlock = file === 'explorer.mjs' ? source : source.slice(source.indexOf('explorer: (s)'), source.indexOf('ons: (s)'));
    assert.doesNotMatch(explorerBlock, /getAddressHistory|\/address\//, `${file} explorer code must not look an address up`);
  }
});

test('rule 1: no balance appears anywhere in the explorer', () => {
  // The privacy note says "balances are never shown"; the singular word is what a
  // balance ROW would use, so it must appear nowhere in any section.
  for (const [tab] of EXPLORER_TABS) {
    assert.doesNotMatch(render({ tab }), /\bbalance\b/i, `${tab} shows a balance`);
  }
  const source = readFileSync(resolve(here, '../public/explorer.mjs'), 'utf8');
  assert.doesNotMatch(source, /getBalance|wallet\/balance/);
});

test('addresses are masked even when the node sends them whole', () => {
  assert.equal(mask(FULL), 'dobs13s4pg…rs0ff0');
  assert.equal(mask('dobs13s4pg…rs0ff0'), 'dobs13s4pg…rs0ff0', 'already masked is left alone');
  assert.equal(mask(''), '—');

  const block = render({
    detail: { kind: 'block', block: { summary: { hash: BLOCK, height: 82, timestamp: 1791540604, size: 606, producer: PRODUCER }, header: { producer: PRODUCER, prevHash: 'f2'.repeat(32), txRoot: 'aa', stateRoot: 'bb' }, transactions: [{ id: TX, kind: 'MINING_CLAIM', sender: FULL, gas: '0' }], confirmations: 5 } },
  });
  const name = render({ detail: { kind: 'name', record: { name: 'e2e-test.obs', owner: FULL, address: FULL, registeredAtHeight: 96, expiresAt: 1823076674, transferCount: 0 } } });
  const tx = render({ detail: { kind: 'transaction', transaction: { txId: TX, height: 82, blockHash: BLOCK, sender: FULL, recipient: PRODUCER, status: 'INCLUDED', kind: 'PAYMENT', gas: '1' } } });
  for (const [label, html] of [['block', block], ['name', name], ['tx', tx]]) {
    assert.ok(!html.includes(FULL), `${label} view contains a whole address`);
    assert.ok(!html.includes(PRODUCER), `${label} view contains a whole producer address`);
    clean(html, label);
  }
});

test('a detail page shows whole ids, wrapped, and links to its neighbours', () => {
  const html = render({
    detail: { kind: 'block', block: { summary: { hash: BLOCK, height: 82, timestamp: 1791540604, size: 606 }, header: { prevHash: 'f2'.repeat(32), txRoot: 'aa'.repeat(32), stateRoot: 'bb'.repeat(32) }, transactions: [{ id: TX, kind: 'MINING_CLAIM', sender: FULL, gas: '0' }], confirmations: 5 } },
  });
  assert.ok(html.includes(BLOCK), 'the whole block id');
  assert.match(html, /word-break:break-all/);
  assert.match(html, /ObsidianExOpen\('block','81'\)/, 'the parent is a link');
  assert.match(html, /ObsidianExOpen\('block','83'\)/, 'and so is the next block');
  assert.match(html, new RegExp(`ObsidianExOpen\\('tx','${TX}'\\)`), 'each transaction in the block is a link');
  assert.match(html, /BACK TO OVERVIEW/);
});

test('NEXT is disabled at the head, and PREVIOUS at the genesis block', () => {
  const at = (height) =>
    render({ detail: { kind: 'block', block: { summary: { hash: BLOCK, height, timestamp: 1, size: 1 }, header: {}, transactions: [] } } });
  assert.match(at(216), /<button class="btn" disabled onclick="ObsidianExOpen\('block','217'\)">NEXT/);
  assert.match(at(0), /<button class="btn" disabled onclick="ObsidianExOpen\('block','-1'\)">‹ PREVIOUS/);
  assert.doesNotMatch(at(100), /disabled/);
});

test('a claim transaction does not show a recipient or an amount it does not have', () => {
  const html = render({ detail: { kind: 'transaction', transaction: { txId: TX, height: 82, blockHash: BLOCK, sender: FULL, status: 'INCLUDED', kind: 'MINING_CLAIM', gas: '0', confirmations: 9 } } });
  assert.doesNotMatch(html, /RECIPIENT|AMOUNT/);
  assert.match(html, /MINING_CLAIM/);
});

test('a block the node reports with no size does not show "0 B"', () => {
  const html = render({ detail: { kind: 'block', block: { summary: { hash: BLOCK, height: 82, timestamp: 1, size: 0 }, header: {}, transactions: [] } } });
  assert.doesNotMatch(html, /\b0 B\b/);
});

test('no data means saying so — never a made-up figure', () => {
  const empty = SCREENS.explorer({ status: null, network: null, appConfig: APP, ex: { ...emptyExplorer(), errors: { overview: 'The node did not answer. Nothing here is guessed in its place.' } } });
  assert.match(empty, /did not answer/);
  assert.match(empty, /has not returned the chain status/);
  assert.doesNotMatch(empty, /#\d/, 'no height');
  assert.match(SCREENS.explorer({ status: STATUS, network: NETWORK, appConfig: APP, ex: { ...emptyExplorer(), loading: true } }), /Asking the node for/);
  clean(empty, 'empty');

  assert.match(render({ tab: 'claims', data: { claims: { claims: [], activeMiners: 0 } } }), /No mining claim has been made on this chain yet/);
  assert.match(render({ tab: 'names', data: { names: { names: [], count: 0 } } }), /No \.obs name has been registered/);
});

test('the audit answers are shown with their evidence, and a YES is shown as a warning', () => {
  const html = render({ tab: 'network', data: { network: { ...DATA.network, audit: { questions: [{ question: 'Can anyone mint?', answer: 'YES', evidence: 'because' }] } } } });
  assert.match(html, /Can anyone mint\?/);
  assert.match(html, /because/);
  assert.match(html, /background:#FDECEA[^"]*">YES/);
});

// ── hostile data in inline handlers ──────────────────────────────────────────────────────────
//
// The screens are HTML strings with inline handlers: onclick="ObsidianExOpen('tx','<id from the node>')". The browser
// decodes entities in an attribute BEFORE it parses the handler as script, so escaping the id with an HTML escape
// (quote -> &#39;) does not stop a quote from ending the JS string. This test does what the browser does: it decodes
// each onclick attribute and RUNS it, and a handler that was hijacked sets a flag.

const decodeEntities = (text) => text
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function runHandlers(html) {
  const calls = [];
  const flag = { hijacked: false };
  const handlers = [...html.matchAll(/onclick="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
  for (const code of handlers) {
    const stub = (...args) => { calls.push(args); };
    // Every Obsidian* handler is a stub; `pwn` stands for anything an attacker could want to run.
    const names = [...new Set([...code.matchAll(/\b(Obsidian[A-Za-z]+)\(/g)].map((m) => m[1]))];
    try { new Function(...names, 'pwn', code)(...names.map(() => stub), () => { flag.hijacked = true; }); } catch { /* a syntax error is also not an exploit */ }
  }
  return { calls, flag, handlers };
}

const HOSTILE = [
  "x');pwn();//", "x'),pwn(),('", "\\');pwn();//", "x&#39;);pwn();//", "x\"onmouseover=\"pwn()", "x</script><script>pwn()</script>",
  "x\u2028pwn()//", "x\n');pwn();//", "x');pwn();ObsidianExOpen('",
];

test('inline handler arguments built from node data cannot break out of their string', () => {
  for (const evil of HOSTILE) {
    const html =
      render({ tab: 'blocks', data: { blocks: { blocks: [{ ...DATA.blocks.blocks[0], height: evil }] } } }) +
      render({ tab: 'claims', data: { claims: { activeMiners: 1, claims: [{ ...DATA.claims.claims[0], txId: evil }] } } }) +
      render({ tab: 'names', data: { names: { count: 1, names: [{ ...DATA.names.names[0], name: evil }] } } });
    const { flag, handlers } = runHandlers(html);
    assert.ok(handlers.length >= 3, 'the rows are clickable');
    assert.equal(flag.hijacked, false, `a handler ran attacker code for ${JSON.stringify(evil)}`);
    assert.doesNotMatch(html, /onclick="[^"]*\bpwn\b/, 'the payload is not even present as code');
  }
});

test('the id a handler receives is exactly the id that was shown, for every legitimate shape', () => {
  const ids = [TX, BLOCK, '82', 'e2e-test.obs', 'dobs13s4pgc4qczhgdjdmxhm8g9wf7e2ya66rrs0ff0'];
  for (const id of ids) {
    const { calls } = runHandlers(render({ tab: 'claims', data: { claims: { activeMiners: 1, claims: [{ ...DATA.claims.claims[0], txId: id }] } } }));
    assert.ok(calls.some((args) => args.includes(id)), `the handler got ${id} unchanged`);
  }
  // text with spaces or quotes arrives intact too (escaped as \uXXXX inside the string), just never as code
  const odd = "it's a name";
  const { calls } = runHandlers(render({ tab: 'names', data: { names: { count: 1, names: [{ ...DATA.names.names[0], name: odd }] } } }));
  assert.ok(calls.some((args) => args.includes(odd)));
});
