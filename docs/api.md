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
| `GET /status` | everything in `/health` plus total blocks, supply, treasury wallet, `genesisAllocationClaimed`, last block timestamp, finalized height/hash, lag, committee size and quorum |
| `GET /finality` | locally verified checkpoint, committee/quorum and pending counts, latest certificate, and bounded validated equivocation evidence |
| `GET /params` | protocol parameters, including `paramsHash`, `proofOfTime`, finality bounds and `nodeRewards` |
| `GET /version` | version metadata and the minimum supported core version |
| `GET /genesis` | the genesis document, its id and hash |
| `GET /supply` | total, maximum, mining pool, treasury, per-metric breakdown, invariant result |
| `GET /nodes`, `GET /peers` | known peers with height, genesis id, latency, direction |
| `GET /network` | network name, chain id, address prefix, p2p magic, genesis id, params hash and versions. `domains` lists the official hostnames **of this network only** (mainnet: `obsmainnet.us.ci`, `api.obsmainnet.us.ci` and its sites; devnet: `devnet.obsmainnet.us.ci`; testnet and staging likewise), so a practice chain cannot vouch for the names people use to check a mainnet address. `trust` says whether this node answers pages on the official domain and by which patterns; see [trusted-domains.md](trusted-domains.md) |
| `GET /oracle` | current median price, sources, submission ages |
| `GET /validators` | validator records, bonds, commission, missed slots, and the slashing rule: `slashing` (the parameter, the derived amount, the Mining Pool destination, a `treasuryShareObs` of zero, who may submit) plus `appliedSlashes` — the most recent page of slashes this chain applied, with canonical evidence ids, alongside `slashing.count` (the exact total) and `slashing.shown` (the page size). The ledger itself is unbounded consensus state; the HTTP answer is not |
| `GET /blocks?limit=` | recent blocks (headers plus counts) |
| `GET /block/<height\|hash>` | full block with its transactions |
| `GET /tx/<txid>` | transaction description, masked addresses, inclusion height |
| `GET /address/<address>?limit=` | activity for an address, masked; **never** a balance |
| `GET /mempool` | pending transactions |
| `GET /pot` | Proof of Time state: consensus identity, fork-choice rule, median time past, accumulated PoT Weight, PoT Difficulty (a measurement, with `role: MEASUREMENT`), Time-Rate, and which clock is authoritative |
| `GET /revenue` | ONS revenue (the protocol's only source), the exact 90/10 split totals, a per-source breakdown, every protocol-held balance, and the flows that are explicitly not ONS revenue. `split.treasuryObs` is the whole 10% obligation, `treasuryCreditedObs` what has reached the treasury wallet, `treasuryUnclaimedObs` what is still owed before one is designated, and `sumsBack` re-adds the split. `treasury` gives the treasury wallet **in full** (a balance never appears on this route; ask `/wallet/balance` for the address); `timing` says when each share is paid: the treasury share in the same block as the ONS fee once a treasury is designated, the node-runner share once per protocol period, with `nextSettlementAt` and `secondsUntilNextSettlement` |
| `GET /nodes/registry?limit=` | registered node runners with the current period's verified evidence (heartbeats, attesters, blocks produced, attestations made, faults) |
| `GET /nodes/rewards?limit=` | the Node Runner Reward Pool, the scoring parameters, and every settled period with its per-node payouts |
| `GET /nodes/status/<nodeId>` | one node: its score and four components, the reasons behind them, the recorded evidence, and its settled rewards |
| `GET /mining/schedule` | active miners, reward per day and per claim, floor state |
| `GET /mining/status?address=` | eligibility, seconds remaining, next claim id and sequence, reward |
| `GET /mining/claims?address=&limit=` | claims with sequence, reward, block, timestamp |
| `GET /names?prefix=` | registered names |
| `GET /names/<name>` | one ONS record |
| `GET /wallet/<address>/next-nonce` | the next nonce to sign with for that address, and the height it was read at. It reads no balance; use `POST /wallet/balance` for that |
| `GET /audit/decentralization` | ten yes/no questions (can one server, one interface or one administrator do X?) each answered with its evidence, plus the list of external dependencies and what each can and cannot affect |
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

Equivocation evidence is submitted the same way, as a signed transaction of type
`SLASH` (12) through `POST /tx/submit`, encoded with `POST /tx/encode` using
`"type": "SLASH"`. Any account may submit one, it carries no value and pays no
gas, and it is refused unless the evidence verifies against the chain's own
identity on every node (`ERR_BAD_SIGNATURE`, `ERR_UNAUTHORIZED`,
`ERR_WRONG_NETWORK`, `ERR_WRONG_CHAIN_ID`, `ERR_NOT_YET_VALID` for evidence about
a height the chain has not reached, `ERR_REPLAY` for evidence already applied).
See [consensus.md](consensus.md) §4.3.

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
`ERR_NOT_FOUND`, `ERR_RATE_LIMITED` (429, with `Retry-After`), `ERR_FORBIDDEN`
(submission disabled), `ERR_NONCE_PENDING` (409: the sender already has a
transaction with that nonce waiting for a block; re-sending the *same* transaction
is a harmless 200 with `duplicate: true`) and `ERR_BODY_TOO_LARGE` (413). What the
caller got wrong is always a 4xx — malformed percent-encoding in a path, an
undecodable transaction, a non-numeric amount — never a 500. **5xx means the node itself failed** — an `ERR_INTERNAL`
from a malformed request is a bug in the node, not in the caller, and is treated
as one: a security test sweeps every `POST` route with unparseable bodies and
fails if any of them answers anything but 400.

## Pagination and limits

`limit` is honoured per route with a hard ceiling (address history: 100 by
default, transaction lists: 200). Requests above the ceiling are clamped rather
than rejected, and every response for a bounded list includes the count it
returned, so a client never has to guess whether it saw everything.
