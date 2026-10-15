#!/usr/bin/env node
/**
 * Independent multi-node agreement check (1.9.0).
 *
 *   node scripts/verify-agreement.mjs http://127.0.0.1:38630 http://127.0.0.1:38640 http://127.0.0.1:38650
 *
 * It asks every node over its public RPC only (read-only: no key, no transaction) and checks, for the LOWEST height
 * every node has reached, that all of them hold the SAME block at that height and the SAME state root; that every node
 * reports the same genesis id, params hash and protocol version; and that the finality they report is consistent:
 * every finalized checkpoint is on every node's chain. Exit status 0 only if everything agrees.
 *
 * A node that is a few blocks behind is not a disagreement: the comparison height is the lowest head, and the nodes are
 * re-asked until `--wait <seconds>` (default 0) has passed if they have not converged yet.
 *
 * What this does NOT prove: that the nodes are independent machines run by independent operators, or that more than
 * these nodes exist. It proves these nodes agree on what they hold.
 */

const args = process.argv.slice(2);
const urls = [];
let waitSeconds = 0;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--wait') waitSeconds = Number(args[(i += 1)]);
  else urls.push(args[i].replace(/\/+$/, ''));
}
if (urls.length < 2) {
  console.error('usage: verify-agreement.mjs <rpc-url> <rpc-url> [...] [--wait <seconds>]');
  process.exit(2);
}

async function get(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
  const body = await response.json();
  if (!response.ok) throw new Error(`${base}${path}: ${response.status} ${body.error ?? ''}`);
  return body;
}

async function snapshot() {
  const nodes = [];
  for (const url of urls) {
    const status = await get(url, '/status');
    const finality = await get(url, '/finality');
    nodes.push({ url, status, finality });
  }
  return nodes;
}

function problems(nodes) {
  const found = [];
  const same = (label, pick) => {
    const values = new Set(nodes.map(pick));
    if (values.size !== 1) found.push(`${label} differs: ${[...values].join(' | ')}`);
  };
  same('genesis id', (n) => n.status.genesisId);
  same('genesis hash', (n) => n.status.genesisHash);
  same('params hash', (n) => n.status.paramsHash);
  same('protocol version', (n) => n.status.protocolVersion);
  same('chain id', (n) => String(n.status.chainId));
  return found;
}

async function compareAtCommonHeight(nodes) {
  const found = [];
  const height = Math.min(...nodes.map((n) => n.status.height));
  const blocks = [];
  for (const n of nodes) blocks.push(await get(n.url, `/block/${height}`));
  const hashes = new Set(blocks.map((b) => b.summary.hash));
  const roots = new Set(blocks.map((b) => b.header.stateRoot));
  if (hashes.size !== 1) found.push(`block ${height} differs between nodes: ${[...hashes].join(' | ')}`);
  if (roots.size !== 1) found.push(`state root at ${height} differs between nodes: ${[...roots].join(' | ')}`);
  // Every finalized checkpoint any node reports must be on every node's chain.
  for (const n of nodes) {
    const f = n.finality;
    if (!f.available || !f.finalizedHeight) continue;
    for (const other of nodes) {
      if (f.finalizedHeight > other.status.height) continue; // the other node has not got there yet
      const block = await get(other.url, `/block/${f.finalizedHeight}`);
      if (block.summary.hash !== f.finalizedHash) {
        found.push(`${n.url} finalized ${f.finalizedHeight}:${f.finalizedHash.slice(0, 12)} but ${other.url} holds ${block.summary.hash.slice(0, 12)} there`);
      }
    }
  }
  return { height, hash: [...hashes][0], stateRoot: [...roots][0], found };
}

const deadline = Date.now() + waitSeconds * 1000;
let result;
for (;;) {
  const nodes = await snapshot();
  const found = problems(nodes);
  const common = await compareAtCommonHeight(nodes);
  found.push(...common.found);
  result = { nodes, found, common };
  if (found.length === 0 || Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}

for (const n of result.nodes) {
  const f = n.finality;
  console.log(
    `${n.url}  height ${n.status.height}  head ${n.status.headHash.slice(0, 12)}  nodes ${n.status.nodes}  tier ${n.status.scheduleTier}  ` +
      `finality ${f.available ? `final@${f.finalizedHeight} (lag ${f.lag})` : `unavailable (${f.eligibleProducers}/${f.minProducers} established producers)`}`,
  );
}
console.log(`compared at height ${result.common.height}: block ${result.common.hash.slice(0, 16)}…  state root ${result.common.stateRoot.slice(0, 16)}…`);
if (result.found.length) {
  for (const line of result.found) console.error(`DISAGREEMENT: ${line}`);
  process.exit(1);
}
console.log('AGREE: same genesis, same parameters, same block and state root at the common height, finality consistent.');
