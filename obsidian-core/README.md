# Obsidian Core

The node: consensus, peer-to-peer networking, the state machine, the RPC/indexer
surface and every protocol rule that decides what the Obsidian Network is.

Obsidian Core is the **source of truth**. Cloudflare, an interface, a website, a
browser tab or a database are all caches; none of them can create, move, price or
decide anything. If a number cannot be derived from this node's validated chain,
it does not exist.

* Hard maximum supply **21,000,000 OBS**, enforced on every issuance path.
* **No admin mint, no WAC, no paid activation, no legacy signup allocation.**
  Verify it on a running node: `curl -s localhost:8630/audit/compliance`.
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
npm test               # 154 tests: unit, integration, security, peer policy
npm start              # node dist/index.js start --config config/mainnet.json
```

## Run a node

```bash
export OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/keystore.pass
node dist/index.js start \
  --network mainnet \
  --data-dir /var/lib/obsidian-node \
  --keystore /var/lib/obsidian-node/node-key.json \
  --seeds seed1.example:8631,seed2.example:8631 \
  --node-name node1
```

`--help` lists every flag. `deployment/node.env.example` is the same
configuration as environment variables, and `deployment/` contains systemd,
nginx and Docker recipes (see the note on Docker below).

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
/mining/schedule /mining/status /mining/claims /names /names/<name> /land/*
/capsules /social/* /network /audit/decentralization /audit/compliance`.

Writes (`POST`): `/tx/submit /tx/simulate /tx/encode /tx/gas /wallet/balance
/wallet/quote /wallet/<address>/next-nonce /rpc`.

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
node dist/index.js health            # RPC health, supply invariant, peers
node dist/index.js validate          # re-verify stored blocks and state roots
node dist/index.js audit             # decentralization + compliance report
node dist/index.js genesis init      # genesis document, id and hash
node dist/index.js keygen            # create/show the node identity keystore
node dist/index.js wallet new        # create a wallet locally (offline)
node dist/index.js version           # version and protocol metadata
```

## Docker

`deployment/docker/` holds a Dockerfile, compose file and `verify.sh`. Docker was
**not available in the environment this project was built in**, so those recipes
are structurally reviewed but unverified: run `deployment/docker/verify.sh` on a
machine with Docker before relying on them. Everything outside Docker (bare node,
systemd, nginx) is exercised by the test suites.

## Docs

* `../docs/protocol.md` — consensus, block rules, fork choice, finality bounds
* `../docs/mining.md` — the emission schedule and claim rules
* `../docs/api.md` — the RPC surface with examples
* `../docs/transaction-format.md` — canonical encoding, signing, gas
* `../docs/node-operator.md` — running, monitoring, backup, upgrades, troubleshooting
* `../docs/security-model.md` — what is trusted, what is not, and why

## Licence

Apache-2.0 — see `LICENSE`.
