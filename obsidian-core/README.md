# Obsidian Core

The node: consensus, peer-to-peer networking, the state machine, the RPC/indexer
surface and every protocol rule that decides what the Obsidian Network is.

Obsidian Core is the **source of truth**. Cloudflare, an interface, a website, a
browser tab or a database are all caches; none of them can create, move, price or
decide anything. If a number cannot be derived from this node's validated chain,
it does not exist.

* Hard maximum supply **21,000,000 OBS**, enforced on every issuance path.
* **No admin mint, no WAC, no paid activation, no legacy signup allocation.**
  Verify it on a running node: `curl -s localhost:<rpc-port>/audit/compliance`
  (`8630` on mainnet; every network's port is in the table below).
* Non-custodial: this software never asks for, holds or transmits a wallet's
  private key or recovery phrase.

## Requirements

* Node.js **>= 20.10**, npm
* A directory for the chain and the node identity keystore
* Optional: a passphrase source for the keystore (`OBSIDIAN_KEYSTORE_PASSPHRASE`
  or `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE`)

## Install and build

```bash
npm ci
npm run build          # tsc → dist/
npm test               # unit, integration, security, Proof of Time, node rewards, peer policy
npm run start:devnet   # node dist/index.js start --config config/devnet.json
```

There is **no default network**: `npm start` on its own refuses to run, and there is one
explicitly named script per network (`start:devnet`, `start:testnet`, `start:staging`,
`start:mainnet`). `start:mainnet` runs a node on the real chain; read
`../docs/mainnet-launch.md` first.

## Run a node

```bash
export OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/testnet/keystore.pass
node dist/index.js start \
  --network testnet \
  --data-dir /var/lib/obsidian/testnet/node \
  --seeds 203.0.113.10:18631 \
  --node-name testnet-1
```

`--help` lists every flag. `deployment/node.env.example` is the same
configuration as environment variables, and `deployment/` contains systemd
(one template unit per network), nginx and Docker recipes (see the note on Docker
below). Peers must be on the same network, and the seed address above is a
documentation example: use a real peer's **P2P** port.

| Network | chainId | address prefix | RPC | p2p |
| --- | --- | --- | --- | --- |
| mainnet | 7777 | `obs` | 8630 | 8631 |
| testnet | 7778 | `tobs` | 18630 | 18631 |
| staging | 7779 | `sobs` | 28630 | 28631 |
| devnet | 7780 | `dobs` | 38630 | 38631 |

A data directory written by one network is refused by another: the genesis
document, genesis id and parameter hash must all match.

## What a running node exposes

Reads (`GET`): `/health /status /params /version /genesis /supply /nodes /peers
/oracle /validators /blocks /block/<hash> /tx/<id> /address/<address> /mempool
/mining/schedule /mining/status /mining/claims /names /names/<name> /pot
/revenue /nodes/registry /nodes/rewards /nodes/status/<nodeId> /finality
/network /wallet/<address>/next-nonce /metrics /audit/decentralization /audit/compliance`.

Writes (`POST`): `/tx/submit /tx/simulate /tx/encode /tx/gas /wallet/balance
/wallet/quote /rpc`. Any other verb is refused with `405` and an `Allow` header.

Three rules hold across all of them:

1. **Balances are only served by `/wallet/balance`**, and public explorer output
   masks addresses. `/audit/compliance` reports `explorerExposesBalances.present
   === false` on a correctly built node.
2. **Protocol time, never the caller's clock.** Mining eligibility, expiry and
   the oracle all move on block timestamps.
3. **Signing happens outside the node.** The node verifies signatures; it never
   holds a user key.

## Mining

Claims are protocol transactions, not HTTP clicks: a wallet becomes an active
miner with one valid claim in the last 30 days, may claim once every 4 hours
(maximum 6 claims per 24 hours), and the first protocol-valid claim on a new chain
receives the one-time 100,000 OBS genesis allocation atomically and exactly once.
That recipient wallet becomes the on-chain treasury wallet. The browser clock,
the device clock and the API caller are never authoritative.

```bash
curl -s "localhost:8630/mining/schedule"                 | jq   # emission, active miners, next drop
curl -s "localhost:8630/mining/status?address=<address>" | jq   # eligibility, next claim, reward
curl -s "localhost:8630/mining/claims?miner=<address>"   | jq   # indexed claim history
```

## Operator commands

```bash
node dist/index.js health --network devnet            # RPC health, supply invariant, peers
node dist/index.js validate --network devnet          # re-verify stored blocks and state roots
node dist/index.js audit                              # the design audit (no network needed)
node dist/index.js genesis init --network devnet      # genesis document, id and hash
node dist/index.js keygen                             # create/show the node identity keystore
node dist/index.js wallet new --network devnet        # create a wallet locally (offline)
node dist/index.js version                            # version and protocol metadata
```

`health`, `validate`, `genesis init` and `wallet new` have to be told the network: each depends on
which chain it is about (its RPC port, its genesis, its address prefix) and none assumes one.

## Docker

`deployment/docker/` holds a Dockerfile, compose file and `verify.sh`. Docker was
**not available in the environment this release was assembled in**, so those recipes
have not been run there: CI's `docker` job builds both images, boots them and checks them
on every push, and `deployment/docker/verify.sh` does the same on any machine with Docker
(run it before relying on them). The bare node and the interface are exercised by the test
suites; CI checks the nginx files against nginx's directive grammar, and the systemd units
were checked with `systemd-analyze verify`.

## Docs

* `../docs/protocol.md` — consensus, block rules, fork choice, finality bounds
* `../docs/mining.md` — the emission schedule and claim rules
* `../docs/api.md` — the RPC surface with examples
* `../docs/transaction-format.md` — canonical encoding, signing, gas
* `../docs/node-operator.md` — running, monitoring, backup, upgrades, troubleshooting
* `../docs/security-model.md` — what is trusted, what is not, and why

## Licence

Apache-2.0 — see `LICENSE`.
