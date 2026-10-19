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
| `GET /status` | everything in `/health` plus total blocks, supply, treasury wallet, `genesisAllocationClaimed`, last block timestamp, the producer tier (`scheduleTier`) and eligible-producer count; its `p2p` block carries counts only unless the caller is local (same rule as `/peers`). **For a local caller only**, it also carries the finality fields (`finalizedHeight`, `finalizedHash`, `finalityLag`, `finalityAvailable`, `finalityEligibleProducers`, `finalityQuorum`): a public caller is not told how far finality has got |
| `GET /finality` | **local caller only** (or `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true`); `404` for everyone else, and the interface does not proxy it. The finality derived from chain state: `model`, `available` (and `reason` when not), `finalizedHeight`, `finalizedHash`, `headHeight`, `lag`, `eligibleProducers`, `producersSeen`, `candidateHeight`, `window`, `quorum`, `minProducers`, `derivedFrom`, `assumptions`. Checkpoint (economic) finality, not BFT; see [finality-v1.9.0.md](finality-v1.9.0.md) |
| `GET /producers` | the producer schedule: `tier` (`TIER1`, `TIER2` or `OPEN`), `eligible`, `registered`, `banned`, the `rule`, per-node records (masked producer address, `tier1`, `registeredAtHeight`, `lastActiveAt`, `blocksProduced`, `missedSlots`, `suspensions`, `suspendedUntil`, `bannedAtHeight`), the `finality` block (local caller only) and recent `penalties`. There is no `/validators`: validators do not exist in 1.9.0 |
| `GET /params` | protocol parameters, including `paramsHash`, `proofOfTime`, finality bounds and `nodeRewards` |
| `GET /version` | version metadata and the minimum supported core version |
| `GET /genesis` | the genesis document, its id and hash |
| `GET /supply` | total, maximum, mining pool, treasury, per-metric breakdown, invariant result |
| `GET /nodes` | this node's signed announcement and the peers it knows, **only for a local caller** (or when `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL` is set); everyone else gets `{ self: null, peers: [], detail: "counts-only" }` |
| `GET /peers` | peer **counts** for the public (no addresses, no node id, no error text, no advertised endpoint); full detail (addresses, direction, latency) only for a local caller, or when `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL` is set. JSON-RPC `getpeers` and `getnodes` follow the same rule and answer empty to everyone else |
| `GET /gate` | the live mining gate set: `issuerKeys` (active), `revokedKeys`, `epoch`, `quorum`, network and chain ids; public keys only |
| `GET /network` | network name, chain id, address prefix, p2p magic, genesis id, params hash and versions. `domains` lists the official hostnames **of this network only** (mainnet: `obsmainnet.us.ci`, `api.obsmainnet.us.ci` and its sites; devnet: `devnet.obsmainnet.us.ci`; testnet and staging likewise), so a practice chain cannot vouch for the names people use to check a mainnet address. `trust` says whether this node answers pages on the official domain and by which patterns; see [trusted-domains.md](trusted-domains.md) |
| `GET /oracle` | current median price, sources, submission ages |
| `GET /blocks?limit=` | recent blocks (headers plus counts) |
| `GET /block/<height\|hash>` | full block with its transactions |
| `GET /tx/<txid>` | transaction description, masked addresses, inclusion height |
| `GET /address/<address>?limit=` | activity for an address, masked; **never** a balance. `transactions` are the transactions that name the address; `miningClaims` its claims; `credits` the OBS the protocol itself paid into it inside a block with no transaction naming it (`ONS_TREASURY_SHARE`, `ONS_TREASURY_RELEASE`, `NODE_REWARD`, each with `amount`, `amountObs`, `height`, `timestamp`, and `txId`/`reference` when a sale caused it). Indexer history: rebuildable, never authoritative; the balance is |
| `GET /mempool` | pending transactions |
| `GET /pot` | Proof of Time state: consensus identity, fork-choice rule, median time past, accumulated PoT Weight, PoT Difficulty (a measurement, with `role: MEASUREMENT`), Time-Rate, and which clock is authoritative |
| `GET /revenue` | ONS revenue (the protocol's only source), the exact 90/10 split totals, a per-source breakdown, every protocol-held balance, and the flows that are explicitly not ONS revenue. `split.treasuryObs` is the whole 10% obligation, `treasuryCreditedObs` what has reached the treasury wallet, `treasuryUnclaimedObs` what is still owed before one is designated, and `sumsBack` re-adds the split. `treasury` gives the treasury wallet **in full** (a balance never appears on this route; ask `/wallet/balance` for the address); `timing` says when each share is paid: the treasury share in the same block as the ONS fee once a treasury is designated, the node-runner share once per protocol period, with `nextSettlementAt` and `secondsUntilNextSettlement` |
| `GET /nodes/registry?limit=` | registered node runners with the current period's verified evidence (heartbeats, attesters, blocks produced, attestations made, faults) |
| `GET /nodes/rewards?limit=` | the Node Runner Reward Pool, the scoring parameters, and every settled period with its per-node payouts |
| `GET /nodes/status/<nodeId>` | one node: its bound reward wallet (and any pending change or reclaim), its score and four components, the reasons behind them, the recorded evidence, producer-schedule status and its settled rewards |
| `GET /mining/schedule` | active miners, reward per day and per claim, floor state |
| `GET /mining/status?address=` | eligibility, seconds remaining, next claim id and sequence, reward |
| `GET /mining/claims?address=&limit=` | claims with sequence, reward, block, timestamp |
| `GET /names?prefix=&limit=&offset=` | registered names, paged: `limit` 1–500 (default 200), `offset`; reply has `matched`, `offset`, `limit`, `hasMore`, and `count` = registry size. JSON-RPC `getnames` takes the same fields |
| `GET /names/<name>` | one ONS record: `owner`, `address`, `registeredAt`, `expiresAt`, `transferCount`, and when present `pendingTransfer` (offered recipient and expiry), `recoveryAddress` and `pendingRecovery` ([ons.md](ons.md)). It does not check expiry; compare `expiresAt` with the head time. Since 2.0.0 it adds `marketStatus`, `listing`, `locked`, `pendingOffers` and `resolved` (false while the name is listed: it does not resolve) |
| `GET /market` | Marketplace summary: active listings, pending offers, escrow held, sales and volume ([marketplace-v2.0.0.md](marketplace-v2.0.0.md)) |
| `GET /market/listings?sort=&seller=&prefix=&limit=&offset=` | active listings, paged. `sort` is `newest`, `oldest`, `price_asc`, `price_desc` or `name`. Each has `name`, `seller`, `priceSeals`, `priceObs`, `listedAt`, `expiresAt`, `pendingOffers` |
| `GET /market/listing/<name>` | one active listing, or 404 |
| `GET /market/name/<name>` | the one answer a search needs: `status` (`AVAILABLE`, `EXPIRED`, `OWNED`, `LISTED`), `owner`, `listing`, `pendingOffers`, `locked`, `canRegister`, `canBuy`, `canOffer`, `atHeight`. Derived from state at the head |
| `GET /market/offers/name/<name>?status=&limit=&offset=` | offers on a name |
| `GET /market/offers/incoming/<address>?status=&limit=&offset=` | offers addressed to the address as owner |
| `GET /market/offers/outgoing/<address>?status=&limit=&offset=` | offers the address made as maker |
| `GET /market/offer/<id>` | one offer: name, owner at offer time, maker, amount, `status`, creation and resolution time and height, who resolved it, and `escrow` (`held`, `amountSeals`); `currentOwner` is the owner now |
| `GET /market/events?name=&address=&limit=` | Marketplace history from the indexer (a convenience rebuilt from blocks, never authoritative) |
| `GET /wallet/<address>/next-nonce` | the next nonce to sign with for that address, and the height it was read at. It reads no balance; use `POST /wallet/balance` for that |
| `GET /audit/decentralization` | ten yes/no questions (can one server, one interface or one administrator do X?) each answered with its evidence, plus the list of external dependencies and what each can and cannot affect |
| `GET /audit/compliance` | absent mechanisms (`present: false`) read from the running protocol |
| `GET /metrics` | Prometheus text exposition (chain height, peers, supply, mempool, PoT). Carries no address, no balance and no identity, but it is still RPC surface: scrape it from a private interface, never publish it |

## Writes

| Route | Body | Notes |
| --- | --- | --- |
| `POST /tx/submit` | `{ "tx": "<signed hex>" }` | validates and admits to the mempool; returns `txId`, `type`, `sender` |
| `POST /tx/simulate` | `{ "tx": "<signed hex>" }` | runs the transaction against current state without committing |
| `POST /tx/*` with `type: "ONS_MARKET"` | `{ "op": "LIST\|UPDATE_PRICE\|DELIST\|BUY\|OFFER\|ACCEPT_OFFER\|DECLINE_OFFER\|CANCEL_OFFER", "name", "amount?", "counterparty?", "offerId?" }` | the `payload` of `/tx/encode`; the same body the wallets sign |
| `POST /tx/encode` | `{ "type": "PAYMENT", "payload": { … } }` to encode; `{ "type": "PAYMENT", "body": "<hex>" }` to decode | canonical body encoding (what a wallet signs) and the inverse |
| `POST /tx/gas` | `{ "amountObs": "12.5" }`, optionally `{ "usd": "5" }` | deterministic gas quote: `gas = min(floor(amount × 2 / 10000), 0.01 OBS)` to the Mining Pool. The `usd` field is only a quote conversion through the protocol oracle price; the fee itself is charged in OBS and the protocol charges no dollar amount |
| `POST /wallet/balance` | `{ "address": "obs1…" }` | balance of an address you already know. `balance` is the **spendable** amount; since 2.0.0 the reply also has `lockedObs`/`lockedSeals` (OBS held in offer escrow) and `totalObs`/`totalSeals` (their sum) |
| `POST /wallet/quote` | `{ "address": "obs1…" }` | balance, next nonce and gas estimate for planning |
| `POST /rpc` | JSON-RPC envelope | for clients that prefer JSON-RPC |

Node runners submit their registry statements as ordinary signed transactions of
type `NODE_REGISTRY` (11) through `POST /tx/submit` — there is no privileged
endpoint, no admin route and nothing that accepts a private key. The body is
encoded with `POST /tx/encode` using `"type": "NODE_REGISTRY"`, and the
operations are `REGISTER`, `CHANGE_WALLET`, `CANCEL_WALLET_CHANGE`, `RECLAIM_WALLET`, `DEREGISTER`, `HEARTBEAT`, `ATTEST`,
`REPORT_FAULT` and `REPORT_EQUIVOCATION`. Registration and node statements are signed by the node identity key over a
domain-separated message that names the network, the chain and the reward period or uptime window, carry **no gas and no
amount**, and `REGISTER` only *names* the reward wallet (no wallet signature); `RECLAIM_WALLET` is the one statement signed
by the wallet. Equivocation evidence is the two conflicting signed block headers in `REPORT_EQUIVOCATION`; every node
re-verifies both signatures and that the blocks are distinct siblings (`ERR_BAD_SIGNATURE`, `ERR_UNAUTHORIZED`,
`NODE_NOT_REGISTERED`). See [node-binding-v1.9.0.md](node-binding-v1.9.0.md), [node-rewards-v1.9.0.md](node-rewards-v1.9.0.md)
and [node-runner-rewards.md](node-runner-rewards.md).

Name ownership operations (`TRANSFER`, `ACCEPT_TRANSFER`, `CANCEL_TRANSFER`, `SET_RECOVERY`, `START_RECOVERY`,
`CANCEL_RECOVERY`, `FINALIZE_RECOVERY`, plus `UPDATE_ADDRESS` and `RENEW`) are ordinary signed `ONS` (2) transactions; see
[ons.md](ons.md).

Changes to the mining gate keys are submitted as a signed transaction of type `GATE_AUTHORITY` (13), encoded with
`POST /tx/encode` using `"type": "GATE_AUTHORITY"` (and decoded with the same route and a `body`). It carries no value and
pays no gas; it is valid only with approvals from a majority of the current gate keys for the next epoch. Use
`obsidian gate propose|sign|submit` rather than building it by hand. See [gate-authority.md](gate-authority.md).

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
