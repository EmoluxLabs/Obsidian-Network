# Soak testing a node

Unit tests prove a function is correct in a millisecond. They say nothing about
what happens after a week: memory that only ever grows, a chain that quietly
stops advancing at 3am, an invariant that flips once and is never noticed.
Those failures are only visible in time.

## Running one

```bash
# terminal 1 — the node under test
cd ~/obsidian/run/node/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='soak' \
  node dist/index.js start --network devnet --data-dir ./data/soak --mine

# terminal 2 — the sampler
node scripts/soak.mjs \
  --rpc http://127.0.0.1:38630 \
  --minutes 2880 \
  --interval 60 \
  --match "dist/index.js start" \
  --out soak.csv
```

`--match` finds the node process by command line and refuses to start if the
match looks like a wrapper shell rather than a node. That guard exists because
the first run here reported a perfectly flat 2.8 MB — it was measuring a shell,
and "no memory growth" about the wrong process is worse than no measurement.

## What it records

A CSV row per sample: height, peers, mempool depth, supply, the supply
invariant, syncing flag, process uptime and RSS. No averaging and no smoothing:
a soak exists to catch slow drift and rare spikes, and both disappear under a
moving average.

## What makes it fail

The script exits non-zero if any of these is true:

| Condition | Why it matters |
| --- | --- |
| the chain did not advance | a node that stops producing is down, whatever its process state says |
| `obsidian_supply_invariant_ok` was 0 in any sample | supply exceeded the 21,000,000 cap — stop the node |
| RSS grew more than `--max-growth-pct` (default 25%) across the second half | the first half includes warm-up and cache fill; sustained growth after that is a leak |

Comparing the second half against itself rather than against the start is
deliberate. A node's RSS climbs quickly while caches fill and then flattens;
measuring from process start reports that normal warm-up as a leak.

## Honest limits

* A soak proves the absence of failures **you waited long enough to see**. A
  24-hour run says nothing about a 30-day memory pattern or about settlement
  over many reward periods.
* One node mining alone exercises block production, state transitions and the
  RPC surface. It does **not** exercise p2p churn, reorgs under contention, or
  a mempool under real load. Those need a multi-node soak with generated
  traffic.
* Results are machine-specific. A 2-core container is not a VPS.

## What has actually been run

One run, recorded 2026-10-02 on a 2-core sandbox, single devnet node, mining,
no transaction load, 90 samples at 30s:

```
samples              90 over 44.5 min (0 scrape failures)
height               0 → 535  (+535, 12.01 blocks/min)
supply invariant     held on every sample
mempool max          0
RSS                  81,008 kB → 79,632 kB over the second half (-1.7%)
PASS
```

Two things worth reading from that. Block production came out at **12.01/min**
against a 5-second target — the schedule is holding, not drifting. And RSS
**fell** slightly across the second half, so there is no leak on this path over
this duration.

What it does **not** show, and should not be quoted as showing: 45 minutes is
not multi-day, one node is not a network, and an empty mempool is not load.
Node reward settlement, which runs on much longer periods, was never exercised.

**Nothing in this repository has been soaked for days.** The gap stays open
until someone runs `--minutes 2880` against a real deployment and publishes the
CSV.
