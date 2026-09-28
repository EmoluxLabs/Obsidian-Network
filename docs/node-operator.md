# Run an Obsidian node

A node reconstructs the chain from blocks, validates every transaction it sees and
serves reads over HTTP. It needs no account, no database server, and no permission
from anyone.

## 1. Requirements

| | |
| --- | --- |
| Node.js | 20.10 or newer (22 LTS recommended) |
| CPU | 1 core is enough to follow the chain; mining benefits from 2+ |
| RAM | 512 MB minimum, 1 GB comfortable |
| Disk | A few hundred MB for the chain today; plan for growth |
| Network | Inbound TCP on the p2p port (8631 on mainnet); outbound to seeds |

## 2. Install

```bash
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network/obsidian-core
npm ci
npm run build
```

Create the node identity keystore. The passphrase protects a scrypt +
AES-256-GCM container; without it the node cannot start, and with a weak one the
key can be brute-forced by anyone who copies the file:

```bash
sudo mkdir -p /var/lib/obsidian-node
sudo install -m 0600 /dev/null /etc/obsidian/keystore.pass
sudo sh -c 'printf %s "your-long-passphrase" > /etc/obsidian/keystore.pass'
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/keystore.pass \
  node dist/index.js keygen --keystore /var/lib/obsidian-node/node-key.json
```

## 3. Configuration

Ready-made configs ship in `config/` (`mainnet.json`, `testnet.json`,
`staging.json`, `devnet.json`), and `config/README.md` documents every key. Use
one with `--config`, or set the same values as `OBSIDIAN_*` environment
variables, or as flags — later layers win, key by key:

```bash
node dist/index.js start --config config/mainnet.json
OBSIDIAN_SEEDS=seed1.example:8631 node dist/index.js start --config config/mainnet.json
```

The shipped configs leave `seedNodes` empty on purpose: inventing seed hostnames
would look authoritative while reaching nothing. Point the node at peers you
know, or at the network's published seed list.


Copy `deployment/node.env.example` to `/etc/obsidian/node.env` and edit:

```ini
OBSIDIAN_NETWORK=mainnet
OBSIDIAN_NODE_NAME=node1
OBSIDIAN_DATA_DIR=/var/lib/obsidian-node
OBSIDIAN_KEYSTORE=/var/lib/obsidian-node/node-key.json
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/keystore.pass
OBSIDIAN_SEEDS=seed1.obsidian.example:8631,seed2.obsidian.example:8631
OBSIDIAN_MINE=true
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
OBSIDIAN_LOG_LEVEL=info
```

Every setting can also be a flag (`--network`, `--data-dir`, `--seeds`, `--mine`,
`--no-mine`, `--offline`, `--port-offset`, …). Flags win over environment
variables; both are validated before the node touches its data directory, and a
data directory written by another network is refused rather than mixed.

## 4. Run

```bash
# foreground, for a first run
node dist/index.js start

# as a service
sudo install -m 0644 deployment/systemd/obsidian-node.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now obsidian-node
journalctl -u obsidian-node -f
```

Or in a container:

```bash
cd deployment/docker
OBSIDIAN_KEYSTORE_PASSPHRASE='a-long-passphrase' docker compose up -d
./verify.sh          # builds, starts, waits for /health, checks the chain
```

## 5. Ports

| Port | Purpose | Exposure |
| --- | --- | --- |
| 8631 (p2p) | peer connections | public; never put a CDN or proxy in front of it |
| 8630 (rpc) | HTTP reads, transaction submission | loopback, or firewalled: it is an operator control surface |
| 18630/18631, 28630/28631, 38630/38631 | testnet, staging, devnet equivalents | as above |

Offsets on other networks are deliberate so you can run mainnet and devnet side by
side on one machine (`--port-offset 1000`).

## 6. Monitoring

```bash
node dist/index.js health                 # local /health summary
curl -s http://127.0.0.1:8630/status | jq # height, head, peers, supply, genesis state
curl -s http://127.0.0.1:8630/peers  | jq # who you are connected to
node dist/index.js validate --data-dir /var/lib/obsidian-node   # chain integrity
node dist/index.js audit                                        # decentralisation + compliance
```

Signals worth alerting on: `height` not increasing for more than ~60 seconds;
`peers == 0` for more than a few minutes; a genesis id that differs from your
other nodes; `/audit/compliance` reporting anything `present: true`.

## 7. Backup and restore

What matters is the **keystore** (the node's identity) and, if you want to avoid
re-syncing, the data directory. The chain itself is recoverable from peers; the
identity is not.

```bash
sudo systemctl stop obsidian-node
sudo tar -C /var/lib -czf obsidian-node-$(date +%F).tgz obsidian-node
sudo systemctl start obsidian-node
```

Never leave `node-key.json` or its passphrase in a repository, a chat message or a
container image.

## 8. Upgrades

```bash
git fetch --tags && git checkout v1.0.1
npm ci && npm run build
npm test                     # the suite must pass before you restart a live node
sudo systemctl restart obsidian-node
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
| `peers: 0`, height frozen | seeds unreachable (firewall on 8631?) or the network changed. Check `OBSIDIAN_SEEDS`, then `--offline` to confirm the node itself is healthy. |
| `ERR_WRONG_NETWORK` in logs | the data directory belongs to another network. Use a separate directory per network. |
| Node exits on start with a `fatal:` line | configuration validation. The message names the setting. |
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
