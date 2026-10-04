# RPC reference

All routes are JSON over HTTP on the node's RPC port (8630 mainnet, 18630 testnet,
28630 staging, 38630 devnet) and, in a browser, through the interface:
`/api/rpc?path=<route>`.

Error shape is stable:

```json
{ "error": "human readable message", "code": "ERR_CODE" }
```

## Reads

| Route | Returns |
| --- | --- |
| `GET /health` | status, core/protocol versions, network, chain id, genesis id, params hash, height, peers, syncing, supplyOk |
| `GET /status` | everything in `/health` plus total blocks, supply, treasury wallet, `genesisAllocationClaimed`, last block timestamp |
| `GET /params` | protocol parameters, including `paramsHash`, `proofOfTime` and `nodeRewards` |
| `GET /version` | version metadata and the minimum supported core version |
| `GET /genesis` | the genesis document, its id and hash |
| `GET /supply` | total, maximum, mining pool, treasury, per-metric breakdown, invariant result |
| `GET /nodes`, `GET /peers` | known peers with height, genesis id, latency, direction |
| `GET /network` | network name, chain id, address prefix, p2p magic |
| `GET /oracle` | current median price, sources, submission ages |
| `GET /validators` | validator records, bonds, commission, uptime |
| `GET /blocks?limit=` | recent blocks (headers plus counts) |
| `GET /block/<height\|hash>` | full block with its transactions |
| `GET /tx/<txid>` | transaction description, masked addresses, inclusion height |
| `GET /address/<address>?limit=` | activity for an address, masked; **never** a balance |
| `GET /mempool` | pending transactions |
| `GET /pot` | Proof of Time state: consensus identity, fork-choice rule, median time past, accumulated PoT Weight, PoT Difficulty (a measurement, with `role: MEASUREMENT`), Time-Rate, and which clock is authoritative |
| `GET /revenue` | qualifying platform revenue, the 40/60 split totals, a per-source breakdown, every protocol-held balance, and the flows that are explicitly not platform revenue |
| `GET /nodes/registry?limit=` | registered node runners with the current period's verified evidence (heartbeats, attesters, blocks produced, attestations made, faults) |
| `GET /nodes/rewards?limit=` | the Node Runner Reward Pool, the scoring parameters, and every settled period with its per-node payouts |
| `GET /nodes/status/<nodeId>` | one node: its score and four components, the reasons behind them, the recorded evidence, and its settled rewards |
| `GET /mining/schedule` | active miners, reward per day and per claim, floor state |
| `GET /mining/status?address=` | eligibility, seconds remaining, next claim id and sequence, reward |
| `GET /mining/claims?address=&limit=` | claims with sequence, reward, block, timestamp |
| `GET /names?prefix=` | registered names |
| `GET /names/<name>` | one ONS record |
| `GET /land/countries` | countries with division counts and GLVs |
| `GET /land/divisions?country=NG` | every first-level division of one country, with its current GLV |
| `GET /land/division/<divisionId>` | one division: initial and current GLV, protocol purchases, buybacks, last update height |
| `GET /land/search?q=` | with a name or code: divisions matching a country name/code, a division name or an ISO 3166-2 id (`kind: registry`). With `lat,lon` (and optional `radius=` in metres, default 5000, max 50000): parcels on this chain whose own LAND coordinates lie within that radius of the point, nearest first (`kind: coordinates`). City, district, street and landmark names are not protocol data and are not searched — the registry ships the division layer only |
| `GET /land/parcels?divisionId=&owner=&limit=` | parcels in a division or owned by an address |
| `GET /land/parcelid/` | the canonical parcel id for a division + level + sub-id + plot index |
| `GET /land/parcel/<parcelId>` | one parcel: area, GLV at purchase, ILV, official value, MSP |
| `GET /land/quote/<divisionId>` | current protocol price for 1 m² of that division |
| `GET /capsules?status=&limit=` | the capsule wall with commitments and unlock times |
| `GET /capsules/<capsuleId>` | one capsule |
| `GET /social/feed?limit=` | posts from chain state |
| `GET /social/profile/<accountId>` | profile, followers, following |
| `GET /social/following/<accountId>` | the accounts this one follows |
| `GET /social/post/<postId>` | one post |
| `GET /audit/decentralization` | mining distribution, node counts |
| `GET /audit/compliance` | absent mechanisms (`present: false`) read from the running protocol |
| `GET /metrics` | Prometheus text exposition (chain height, peers, supply, mempool, PoT). Carries no address, no balance and no identity, but it is still RPC surface: scrape it from a private interface, never publish it |

## Writes

| Route | Body | Notes |
| --- | --- | --- |
| `POST /tx/submit` | `{ "tx": "<signed hex>" }` | validates and admits to the mempool; returns `txId`, `type`, `sender` |
| `POST /tx/simulate` | `{ "tx": "<signed hex>" }` | runs the transaction against current state without committing |
| `POST /tx/encode` | `{ "type": "PAYMENT", "payload": { … } }` to encode; `{ "type": "PAYMENT", "body": "<hex>" }` to decode | canonical body encoding (what a wallet signs) and the inverse |
| `POST /tx/gas` | `{ "amountObs": "12.5" }`, optionally `{ "usd": "5" }` | deterministic gas quote: `gas = min(floor(amount × 2 / 10000), 0.01 OBS)` to the Mining Pool. The `usd` field is only a quote conversion through the protocol oracle price; the fee itself is charged in OBS and the protocol charges no dollar amount |
| `POST /wallet/balance` | `{ "address": "obs1…" }` | balance of an address you already know |
| `POST /wallet/quote` | `{ "address": "obs1…" }` | balance, next nonce and gas estimate for planning |
| `POST /rpc` | JSON-RPC envelope | for clients that prefer JSON-RPC |

Node runners submit their registry statements as ordinary signed transactions of
type `NODE_REGISTRY` (11) through `POST /tx/submit` — there is no privileged
endpoint, no admin route and nothing that accepts a private key. The body is
encoded with `POST /tx/encode` using `"type": "NODE_REGISTRY"`, and the
operations are `REGISTER`, `CHANGE_WALLET`, `DEREGISTER`, `HEARTBEAT`, `ATTEST`
and `REPORT_FAULT`. Each carries a signature made by the node identity key over
a domain-separated message that names the network, the chain and the reward
period; see [node-runner-rewards.md](node-runner-rewards.md).

A node never accepts a transaction it cannot verify: signature, nonce, gas,
balance, replay status, network id and protocol version are all checked before the
mempool sees it. `POST /tx/submit` returning `{ "accepted": true }` means exactly
that — admitted and validated — not "confirmed". Confirmation is a block, and you
read it back from `/tx/<txid>`.

## Explorer masking

Routes that describe activity (`/tx/…`, `/address/…`, block listings) mask
addresses to `first10…last6` before leaving the node. Balance routes are not
reachable from the explorer surface of the interface. This is a deliberate
product decision, not a limitation: see [explorer.md](explorer.md).

## Error contract

Every endpoint answers a client mistake with 4xx and a machine-readable `code`:
`ERR_MALFORMED` (unparseable or wrong-shaped body, missing field),
`ERR_BAD_ADDRESS`, `ERR_PRICEMISMATCH`-class protocol refusals from
`/tx/submit`, `ERR_REJECTED` (route not exposed by an interface proxy),
`ERR_NOT_FOUND`, `ERR_RATE_LIMITED`, `ERR_FORBIDDEN` (submission disabled) and
`ERR_BODY_TOO_LARGE` (413). **5xx means the node itself failed** — an `ERR_INTERNAL`
from a malformed request is a bug in the node, not in the caller, and is treated
as one: a security test sweeps every `POST` route with unparseable bodies and
fails if any of them answers anything but 400.

## Pagination and limits

`limit` is honoured per route with a hard ceiling (address history: 100 by
default, transaction lists: 200). Requests above the ceiling are clamped rather
than rejected, and every response for a bounded list includes the count it
returned, so a client never has to guess whether it saw everything.
