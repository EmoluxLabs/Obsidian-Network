# Node configuration files

Ready-to-run configs, one per network. `npm start` uses `mainnet.json`; pass
another with `--config`:

```bash
node dist/index.js start --config config/testnet.json
node dist/index.js start --config config/devnet.json
```

## What the files say, and what they deliberately do not

| Network | chainId | address prefix | RPC | p2p | data directory |
| --- | --- | --- | --- | --- | --- |
| `mainnet.json` | 7777 | `obs` | 8630 | 8631 | `./data/mainnet` |
| `testnet.json` | 7778 | `tobs` | 18630 | 18631 | `./data/testnet` |
| `staging.json` | 7779 | `sobs` | 28630 | 28631 | `./data/staging` |
| `devnet.json` | 7780 | `dobs` | 38630 | 38631 | `./data/devnet` |

* RPC binds to **127.0.0.1**: publish an interface (or a proxy you control)
  instead of the raw node API. Nothing should ever sit in front of p2p.
* `seedNodes` is **empty on purpose**. There is no public seed list shipped with
  the software: inventing host names would look authoritative while reaching
  nothing. Add real peers, or start `OBSIDIAN_SEEDS=host:port`. A node with no
  peers still validates and serves reads; it just cannot learn about new blocks.
* `devnet.json` disables rate limiting and turns on debug logging because it is a
  local development chain. Never copy those two settings into a public node.
* Data directories are separate per network, and the node refuses a directory
  written by another network — a chain is never "adopted" by accident.

## The three layers, and which one wins

Later layers override earlier ones, key by key:

1. built-in defaults (`DEFAULT_CONFIG` in `src/config/config.ts`)
2. the config file (`--config`)
3. environment variables (`OBSIDIAN_*`, see `deployment/node.env.example`)
4. command-line flags (`--rpc-port`, `--seeds`, `--no-mine`, …)

Anything nobody sets is derived from the network, which is why a config can be
two lines long: ports and the data directory follow the network unless stated.

```bash
# config file + environment + flag, in that order
OBSIDIAN_LOG_LEVEL=debug node dist/index.js start \
  --config config/testnet.json --rpc-port 18632
```

## Keys

| Key | Meaning |
| --- | --- |
| `network` | `mainnet`, `testnet`, `staging` or `devnet`. Fixed chain identity — never a free choice. |
| `nodeName` | operator-visible label; appears in `/status` and in peers' `/peers`. |
| `dataDir` | where the chain, the indexer files and the peer table live. |
| `keystorePath` | node identity keystore. Defaults to `<dataDir>/node-key.json`. |
| `logLevel`, `logJson` | `trace`–`error`; JSON logs for collectors, plain for humans. |
| `rpcEnabled`, `rpcHost`, `rpcPort` | the read/submit API. Loopback by default. |
| `rpcCorsOrigins` | exact origins allowed to call RPC from a browser. Empty = none. `"*"` must be deliberate. |
| `rpcRateLimitPerMinute` | per-IP limit; `0` disables it (private/development only). |
| `rpcAllowSubmit` | `false` makes the node read-only: it will not accept transactions. |
| `rpcPublicUrl` | the URL peers and interfaces should use to reach this node. |
| `rpcTrustProxy` | honour `X-Forwarded-For`. Only behind a proxy you control. |
| `p2pEnabled`, `p2pHost`, `p2pPort` | the peer-to-peer listener. Public port; no CDN, no proxy. |
| `publicHost` | address peers should dial when this node sits behind NAT. Empty = auto. |
| `seedNodes` | bootstrap peers (`host:port`). Any node already on the network will do. |
| `maxPeers`, `maxInboundPeers` | connection budgets. |
| `miningEnabled` | produce blocks when this node's slot comes up. Off = validating follower. |
| `blockProductionIntervalSeconds` | how often the producer checks its slot (the protocol decides the slot itself). |
| `miningRewardAddress` | optional address to attribute rewards to; empty = the node identity. |
| `indexerEnabled` | build the explorer index as blocks connect. |
| `strictDataDir` | refuse a data directory whose genesis does not match this network. |

## Passphrase

The node identity keystore is encrypted (`scrypt` + AES-256-GCM). Its passphrase
comes from `OBSIDIAN_KEYSTORE_PASSPHRASE` or, better,
`OBSIDIAN_KEYSTORE_PASSPHRASE_FILE` pointing at a root-owned `0600` file. If
neither is set the node generates one, writes it beside the keystore with a
warning, and expects you to move it — that path is for development only.

## Verifying a running node

```bash
node dist/index.js health    # height, peers, supply invariant
node dist/index.js audit     # decentralization + compliance report
curl -s localhost:8630/status | jq
```
