# Run an Obsidian node

A node reconstructs the chain from blocks, validates every transaction it sees and
serves reads over HTTP. It needs no account, no database server, and no permission
from anyone.

This is the reference for operating a node day to day. To get one running for the first
time, follow [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) (a phone or any machine; devnet, testnet,
staging and mainnet each have their own section) or
[ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md) (a server).

## 1. Requirements

| | |
| --- | --- |
| Node.js | 20.10 or newer (22 LTS recommended) |
| CPU | 1 core is enough to follow the chain; block production benefits from 2+ |
| RAM | 512 MB minimum, 1 GB comfortable, with swap on a 1 GB machine |
| Disk | A few hundred MB for the chain today; plan for growth and watch `df -h` |
| Network | Inbound TCP on the node's P2P port (its network's port, §5); outbound to seeds |

How memory and disk grow with chain length at mainnet scale has not been measured. Size a
mainnet node with headroom and alert on both.

## 2. Install

**From the release archives** (recommended; nothing is compiled on the machine): unpack
`obsidian-node-operator-<version>.tar.gz`, then `cd obsidian-core && npm ci --omit=dev`. The
steps, with checksum verification, are in [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) §1 and
[ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md) §6.

**From source** (development, or if you want to build it yourself):

```bash
git clone --depth 1 --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network/obsidian-core
npm ci
npm run build
```

The node identity keystore is created the first time the node starts. To create it ahead of
time, and print the node id you will need to register for rewards, run `keygen` with the
passphrase in a file only the service account can read (12 or more characters; the passphrase
protects a scrypt + AES-256-GCM container, and a weak one lets anyone who copies the file
brute-force the key):

```bash
export OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/testnet/keystore.pass
node dist/index.js keygen --network testnet --data-dir /var/lib/obsidian/testnet/node
```

## 3. Configuration

Ready-made configs ship in `config/` (`mainnet.json`, `testnet.json`, `staging.json`,
`devnet.json`), and `config/README.md` documents every key. Use one with `--config`, or set
the same values as `OBSIDIAN_*` environment variables, or as flags — later layers win, key by
key:

```bash
node dist/index.js start --config config/testnet.json
OBSIDIAN_SEED_NODES=203.0.113.10:18631 node dist/index.js start --config config/testnet.json
```

The shipped configs leave `seedNodes` empty on purpose: inventing seed hostnames would look
authoritative while reaching nothing. Point the node at peers you know, or at the network's
published seed list. Peers must be on the **same network**: a peer from another network is
refused with `ERR_WRONG_NETWORK`.

For a service, keep one settings file **per network**: copy `deployment/node.env.example` to
`/etc/obsidian/<network>/node.env` and edit. With the template unit
(`obsidian-node@<network>`, §4) the network and data directory come from the unit, so the file
holds only the rest:

```ini
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/testnet/keystore.pass
OBSIDIAN_NODE_NAME=testnet-1
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_PUBLIC_HOST=203.0.113.10
OBSIDIAN_LOG_LEVEL=info
```

Every setting can also be a flag (`--network`, `--data-dir`, `--seeds`, `--mine`,
`--no-mine`, `--offline`, `--port-offset`, …). Flags win over environment variables; both are
validated before the node touches its data directory. **If a config file, the environment and
a flag name different networks, the node refuses to start** rather than guess, and a data
directory written by another network is refused rather than mixed. An environment file has no
trailing comments: text after a value becomes part of the value.

## 4. Run

```bash
# foreground, for a first run: the network is always named
node dist/index.js start --network devnet

# on a phone or any machine, a node and its interface for one network, with the helper
bash obsidian-network.sh devnet start

# as a service: one instance per network, the text after the @ is the network
sudo install -m 0644 deployment/systemd/obsidian-node@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now obsidian-node@testnet
journalctl -u obsidian-node@testnet -f
```

The template unit passes `--network` and `--data-dir /var/lib/obsidian/<network>/node` itself,
reads `/etc/obsidian/<network>/node.env`, and will not start for a network nobody configured
(a typo in the instance name fails instead of creating a node). `obsidian-node.service`, without
the `@`, is the same unit for a machine that only ever runs one network: it passes neither flag,
so that file must set `OBSIDIAN_NETWORK` and `OBSIDIAN_DATA_DIR`. Do not install both for the
same network.

Or in a container:

```bash
cd deployment/docker
OBSIDIAN_NETWORK=devnet OBSIDIAN_KEYSTORE_PASSPHRASE='a-long-passphrase' docker compose up -d
./verify.sh          # builds, starts, waits for /health, checks the chain
```

## 5. Ports

| Network | RPC (loopback or firewalled) | P2P (public) | Interface (behind a proxy) |
| --- | --- | --- | --- |
| mainnet | 8630 | 8631 | 8788 |
| testnet | 18630 | 18631 | 18788 |
| staging | 28630 | 28631 | 28788 |
| devnet | 38630 | 38631 | 38788 |

* **P2P is public and never goes behind a CDN or proxy**: peers must reach the node itself.
* **RPC is an operator control surface**: keep it on loopback, or firewalled. Publish an
  interface, which proxies an allowlist of read routes, instead of the raw RPC.
* The offsets between networks are deliberate, so several networks (or a second copy of one,
  with `--port-offset`) can run on one machine without colliding.

## 6. Monitoring

Use the network's own RPC port (the examples are testnet's):

```bash
node dist/index.js health --network testnet           # local /health summary
curl -s http://127.0.0.1:18630/status | jq            # height, head, peers, supply, genesis state
curl -s http://127.0.0.1:18630/peers  | jq            # who you are connected to
node dist/index.js validate --network testnet --data-dir /var/lib/obsidian/testnet/node   # chain integrity (stop the node first)
node dist/index.js audit                              # the design audit
curl -s http://127.0.0.1:18630/audit/compliance | jq  # the removed mechanisms, read from the running protocol
```

Signals worth alerting on: `height` not increasing for more than ~60 seconds;
`peers == 0` for more than a few minutes; a genesis id that differs from your
other nodes; `/audit/compliance` reporting anything `present: true` other than
`revenueSplitEnforced`; disk or memory trending to full. `obsidian-core/deployment/monitoring/`
ships a Prometheus config, alert rules (including `ObsidianNodeDown`), an Alertmanager routing
file and a Grafana dashboard; nothing is watched until you install them.

## 7. Backup and restore

What matters is the **keystore** (the node's identity) and, if you want to avoid
re-syncing, the data directory. The chain itself is recoverable from peers; the
identity is not.

```bash
sudo systemctl stop obsidian-interface@testnet obsidian-node@testnet
sudo tar -C /var/lib/obsidian -czf obsidian-testnet-$(date +%F).tgz testnet
sudo systemctl start obsidian-node@testnet obsidian-interface@testnet
```

Never leave `node-key.json` or its passphrase in a repository, a chat message or a
container image. Keep the passphrase and the key backup in different places, and at least one
copy of each off the machine.

## 8. Upgrades

From archives (preferred): verify the new archives, stop the services, unpack the new release
beside the old one, `npm ci --omit=dev`, start again. Data and settings live outside the code,
so they are untouched; [ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md) §10 and
[LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) §8 have the commands.

From source:

```bash
git fetch origin && git checkout <the branch or tag you are upgrading to>
npm ci && npm run build
npm test                     # the suite must pass before you restart a live node
sudo systemctl restart obsidian-node@testnet
node dist/index.js version   # protocol version, min supported version, build id
```

Peers compare core version, protocol version, network id and genesis id during the
handshake, so a mismatched binary is rejected by the network instead of silently
forking your view. If `minCoreVersion` in `/health` is newer than your binary, you
are the one who must upgrade.

## 9. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Unsupported state or unable to authenticate data` | wrong keystore passphrase, or a keystore from another node. Point `--keystore` at this node's file; do not reuse one between nodes. |
| `peers: 0`, height frozen | seeds unreachable (firewall on 8631?) or the network changed. Check `OBSIDIAN_SEED_NODES`, then `--offline` to confirm the node itself is healthy. |
| A warning `the node at … is on another network or version than this one` (`code` `ERR_WRONG_NETWORK`, `ERR_WRONG_CHAIN_ID` or `ERR_VERSION_MISMATCH`) | a seed or peer you configured follows a different network, or an incompatible version. Fix `--seeds` / `OBSIDIAN_SEED_NODES` so every entry is the **P2P** port of a node on this network. It is logged once per address per ten minutes, however often the node retries; peers that dial *in* from another network are refused silently. |
| A refusal at startup saying the data directory belongs to another network | you pointed `--data-dir` at a directory another network wrote. Use a separate directory per network. |
| Node exits on start with a `fatal:` line | configuration validation. The message names the setting. |
| `fatal: no network selected` | there is no default network: add `--network` (or set `OBSIDIAN_NETWORK`) |
| `fatal: conflicting networks: … says devnet, but … says mainnet` | the flag, the environment and a config file disagree; remove the one that is wrong (`env \| grep OBSIDIAN_`) |
| `data directory … is in use by another Obsidian process (pid N)` | a node is already running on that directory. Stop it; never share a data directory |
| `fatal: listen EADDRINUSE: address already in use` | another process holds the RPC or P2P port; check `systemctl list-units 'obsidian-*'` and `ss -ltnp` |
| RPC works locally, not remotely | that is the default on purpose: `OBSIDIAN_RPC_HOST=127.0.0.1`. Publish an interface instead of the raw RPC. |
| A seed was down when you started and the node never retried it | it does retry: a refused connection backs off 15s, 30s, 1m, 2m… up to an hour, and configured seeds are always dialled first once the window expires. Restart only if `/peers` and `/status` disagree after several minutes. |
| Peers keep appearing and disappearing in `/peers` | duplicate connections are closed on purpose. A node keeps **one** connection per peer identity (`nodeId`), and both ends drop the newer socket, so a two-way dial settles instead of showing the same peer twice. |
| `peers` counts only one address per node behind NAT | that is expected: a peer listening on `0.0.0.0` is recorded at the IP the connection was actually observed on, plus its advertised port. Two nodes on the same host therefore see each other at `127.0.0.1`, not at the wildcard address. |

### How a node maintains its peer set

* Every 15 seconds it prunes peers that have been silent for a week, retries the
  ones whose back-off has expired, and dials configured seeds first.
* Every 20 seconds it pings each connected peer and drops a link that has been
  silent for four intervals (80 seconds), so a half-open connection to a crashed
  peer cannot sit in `/peers` forever.
* Reachability failures and protocol misbehaviour are scored differently: a
  refused socket only delays the next attempt, while an invalid block or a
  malformed message can earn the full one-hour ban. Only the second kind is
  evidence about a peer's honesty. See `docs/security-model.md` for the scoring
  table.

## Earning node runner rewards

90% of ONS revenue is paid to independent node runners. Running
a node does not earn anything by itself — the protocol pays for measured
participation, and it needs to know which wallet is yours.

```
Run Obsidian Core           → it prints your node id (20 bytes of hex)
Sync and peer               → a node that is behind or unreachable scores nothing
Register a reward wallet    → NODE_REGISTRY / REGISTER, signed by BOTH the node
                              identity key and the reward wallet. It moves no
                              funds: there is no registration deposit
Heartbeat and attest        → once per period, plus attestations for the peers
                              you can actually see
Get paid                    → settlement happens inside a block at the end of
                              each period; nothing needs to be running on your
                              side for the payout to occur
```

Two things are worth being explicit about:

* **Your private keys are never requested.** The node identity key stays on the
  node; the reward wallet key stays wherever you keep it and only ever signs a
  transaction. No configuration setting, RPC route or web form accepts a private
  key.
* **You cannot report your own performance.** There is no uptime field, no
  efficiency field and no hash-rate field anywhere in the protocol. Your uptime
  comes from other nodes attesting yours, your participation from blocks the
  chain shows you produced, and your reliability from faults independent peers
  corroborated.

Check your own node at any time:

```bash
curl -s localhost:8630/nodes/status/<your-node-id> | jq
curl -s localhost:8630/nodes/rewards | jq '.pool, .settlements[0]'
curl -s localhost:8630/revenue | jq '.split'
```

The same view, rendered: `/node/` in the interface. Full rules, the exact
scoring formula and the Sybil-resistance argument:
[node-runner-rewards.md](node-runner-rewards.md).
