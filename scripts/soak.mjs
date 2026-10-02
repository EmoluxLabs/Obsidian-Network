#!/usr/bin/env node
/**
 * Soak a running node and record what it actually does over time.
 *
 *   node scripts/soak.mjs --rpc http://127.0.0.1:38630 --minutes 60 --out soak.csv
 *
 * Samples /metrics and the process RSS every interval and writes a CSV, then
 * prints a verdict. It is deliberately dumb: no averaging away of spikes, no
 * smoothing. The point of a soak is to catch the slow things — memory that
 * only grows, a chain that quietly stops, an invariant that flips — and those
 * are visible in raw samples or not at all.
 *
 * Exit code is 1 if the chain stalled, the invariant broke, or RSS grew by
 * more than --max-growth-pct over the second half of the run.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, appendFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);

const RPC = args.get('rpc') ?? 'http://127.0.0.1:38630';
const MINUTES = Number(args.get('minutes') ?? 60);
const EVERY = Number(args.get('interval') ?? 30) * 1000;
const OUT = args.get('out') ?? 'soak.csv';
const MAX_GROWTH = Number(args.get('max-growth-pct') ?? 25);
let PID = args.get('pid');
const MATCH = args.get('match');

/**
 * Resolve the node's own pid.
 *
 * Passing the pid of a wrapper shell silently measures the wrapper: the first
 * run of this script reported a flat 2.8 MB, which is a shell, not a node.
 * Matching on the command line avoids measuring the wrong process and then
 * reporting "no memory growth" about something that was never running.
 */
async function resolvePid(needle) {
  const { readdir, readFile: read } = await import('node:fs/promises');
  const entries = await readdir('/proc');
  const candidates = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = (await read(`/proc/${entry}/cmdline`, 'utf8')).replace(/\0/g, ' ');
      if (cmdline.includes(needle) && !cmdline.includes('soak.mjs')) {
        const status = await read(`/proc/${entry}/status`, 'utf8');
        candidates.push({ pid: Number(entry), rss: Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? 0) });
      }
    } catch {
      /* the process exited while we looked at it */
    }
  }
  // The real node is the heaviest match; a shell wrapper is a few megabytes.
  candidates.sort((a, b) => b.rss - a.rss);
  return candidates[0]?.pid;
}

if (!PID && MATCH) {
  PID = await resolvePid(MATCH);
  if (!PID) {
    console.error(`no process matching ${JSON.stringify(MATCH)} — refusing to report memory for a process that is not there`);
    process.exit(2);
  }
  console.log(`resolved pid ${PID} from --match ${JSON.stringify(MATCH)}`);
}

if (PID) {
  const { readFileSync: readSync } = await import('node:fs');
  try {
    const rss = Number(/VmRSS:\s+(\d+) kB/.exec(readSync(`/proc/${PID}/status`, 'utf8'))?.[1] ?? 0);
    if (rss < 20_000) {
      console.error(`pid ${PID} is using ${rss} kB — that is a wrapper, not a node. Use --match "dist/index.js start".`);
      process.exit(2);
    }
  } catch {
    console.error(`pid ${PID} does not exist`);
    process.exit(2);
  }
}

const metric = (body, name) => {
  const match = new RegExp(`^${name}\\{[^}]*\\} (-?[0-9.e+]+)$`, 'm').exec(body);
  return match ? Number(match[1]) : NaN;
};

async function rssKb(pid) {
  if (!pid) return NaN;
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    return Number(/VmRSS:\s+(\d+) kB/.exec(status)?.[1] ?? NaN);
  } catch {
    return NaN;
  }
}

const columns = ['iso', 'elapsed_s', 'height', 'peers', 'mempool', 'supply_obs', 'invariant_ok', 'syncing', 'uptime_s', 'rss_kb'];
writeFileSync(OUT, `${columns.join(',')}\n`);

const started = Date.now();
const deadline = started + MINUTES * 60_000;
const rows = [];
let failures = 0;

console.log(`soaking ${RPC} for ${MINUTES} minutes, sampling every ${EVERY / 1000}s → ${OUT}`);

while (Date.now() < deadline) {
  let row;
  try {
    const body = await (await fetch(`${RPC}/metrics`)).text();
    row = {
      iso: new Date().toISOString(),
      elapsed_s: Math.round((Date.now() - started) / 1000),
      height: metric(body, 'obsidian_chain_height'),
      peers: metric(body, 'obsidian_peers'),
      mempool: metric(body, 'obsidian_mempool_transactions'),
      supply_obs: metric(body, 'obsidian_supply_obs'),
      invariant_ok: metric(body, 'obsidian_supply_invariant_ok'),
      syncing: metric(body, 'obsidian_syncing'),
      uptime_s: metric(body, 'obsidian_uptime_seconds'),
      rss_kb: await rssKb(PID),
    };
    rows.push(row);
    appendFileSync(OUT, `${columns.map((c) => row[c]).join(',')}\n`);
  } catch (error) {
    failures += 1;
    appendFileSync(OUT, `${new Date().toISOString()},${Math.round((Date.now() - started) / 1000)},,,,,,,,ERROR ${String(error).replace(/,/g, ';')}\n`);
  }
  await sleep(EVERY);
}

if (rows.length < 2) {
  console.error('not enough samples to judge anything');
  process.exit(1);
}

const first = rows[0];
const last = rows[rows.length - 1];
const half = rows.slice(Math.floor(rows.length / 2));
const rssStart = half[0].rss_kb;
const rssEnd = last.rss_kb;
const growth = Number.isFinite(rssStart) && rssStart > 0 ? ((rssEnd - rssStart) / rssStart) * 100 : 0;
const blocks = last.height - first.height;
const minutes = (last.elapsed_s - first.elapsed_s) / 60;
const invariantHeld = rows.every((r) => r.invariant_ok === 1);
const stalled = blocks <= 0;

console.log('\n── soak result ─────────────────────────────────────────');
console.log(`samples              ${rows.length} over ${minutes.toFixed(1)} min (${failures} scrape failures)`);
console.log(`height               ${first.height} → ${last.height}  (+${blocks}, ${(blocks / minutes).toFixed(2)}/min)`);
console.log(`supply (OBS)         ${first.supply_obs} → ${last.supply_obs}`);
console.log(`supply invariant     ${invariantHeld ? 'held on every sample' : 'BROKE'}`);
console.log(`mempool max          ${Math.max(...rows.map((r) => r.mempool))}`);
console.log(`RSS                  ${rssStart} kB → ${rssEnd} kB over the second half (${growth.toFixed(1)}%)`);
console.log('────────────────────────────────────────────────────────');

const problems = [];
if (stalled) problems.push('the chain did not advance');
if (!invariantHeld) problems.push('the supply invariant was false in at least one sample');
if (growth > MAX_GROWTH) problems.push(`RSS grew ${growth.toFixed(1)}% in the second half (limit ${MAX_GROWTH}%)`);
if (problems.length) {
  console.error(`\nFAIL: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS');
