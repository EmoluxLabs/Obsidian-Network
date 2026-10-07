# Monitoring an Obsidian node

Four files. The node exposes `GET /metrics` in Prometheus text format; nothing
here is required for the node to run, and nothing here can affect consensus.

| File | Role |
| --- | --- |
| `prometheus.yml` | what to scrape, every 15s |
| `obsidian-alerts.yml` | what counts as wrong |
| `alertmanager.yml` | who finds out |
| `grafana-dashboard.json` | what it looks like |

```bash
cp prometheus.yml obsidian-alerts.yml /etc/prometheus/
cp alertmanager.yml /etc/alertmanager/
# Grafana → Dashboards → New → Import → upload grafana-dashboard.json
```

## Before this works

`alertmanager.yml` ships with `CHANGE-ME-` placeholders for every destination.
Alertmanager will not start while they are there, and that is on purpose: a
routing file that quietly delivers to `example.invalid` looks healthy and tells
nobody anything. Replace them with a real webhook, or uncomment and fill the
`email_configs` block, before you rely on any of it.

Check your edit before trusting it:

```bash
amtool check-config /etc/alertmanager/alertmanager.yml
promtool check rules /etc/prometheus/obsidian-alerts.yml
promtool check config /etc/prometheus/prometheus.yml
```

Then prove delivery end to end — do not assume it:

```bash
amtool alert add ObsidianSupplyInvariantBroken \
  network=mainnet instance=test severity=critical \
  --alertmanager.url=http://127.0.0.1:9093
```

If that does not reach a human, the monitoring is decorative.

## What the routing does

* **`ObsidianSupplyInvariantBroken` bypasses batching entirely** (`group_wait:
  0s`, repeat every 15m). It means a node is serving a chain that violates the
  21,000,000 OBS cap; everything else can wait, that cannot.
* Critical alerts on mainnet or testnet page hourly.
* Anything on devnet is low-noise and repeats at most daily — a throwaway
  network should never be able to train you to ignore alerts.
* `ObsidianFinalityStalled` warns only when a non-empty eligible committee
  exists and the checkpoint is more than 64 blocks behind. Inspect `/finality`;
  the alert alone is not proof of a safety violation.
* Two inhibit rules suppress symptoms of a known cause: a mempool backlog
  behind a stalled chain, and a syncing node behind a restart.

## Security

`/metrics` carries no address, no balance and no identity, and there is a test
that asserts it. It is still part of the RPC surface: keep the RPC port on a
private interface and scrape it from inside your network rather than exposing
it. Nothing in this directory is read by the node.
