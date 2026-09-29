# Obsidian protocol

Obsidian is a Proof of Time (PoT) blockchain with a fixed maximum supply of
**21,000,000 OBS** and a state machine that carries application data — names,
parcels, capsules, social posts, oracle prices, validator bonds — as first-class
chain state rather than as rows in a company database.

* Chain id / network id: `7777` / `obsidian-mainnet-1` (plus testnet `7778`,
  staging `7779`, devnet `7780`)
* Address prefix: `obs` (testnet `tobs`, staging `sobs`, devnet `dobs`)
* Protocol version: `1.0.0`

## 1. Blocks

| Field | Value |
| --- | --- |
| Target interval | 5 seconds |
| Maximum block size | 2 MiB |
| Maximum transactions per block | 2,000 |
| Soft / hard confirmation depth | 12 / 64 blocks |
| Maximum reorganisation depth | 256 blocks |
| Median-time-past window | 11 blocks |
| Allowed clock drift | 60 seconds |
| Fork choice | most accumulated work → longest → lowest header hash |

A block header commits to height, parent hash, timestamp, difficulty,
transactions root, events root, state root, protocol version, producer and the
producer's signature. A block whose header does not validate is discarded; a
block whose **transactions** do not validate is rejected as a whole.

The producer is selected by the protocol (work plus per-height permit), so a node
cannot cheaply produce a competing chain by rewriting history. Reorgs deeper than
256 blocks are refused.

## 2. Transactions

A transaction is an envelope plus a type-specific canonical body:

```
protocolVersion | chainId | sender | nonce | type | gas | body | validUntil | memo | signature
```

* Bodies are encoded with a deterministic binary codec: a map of field names to
  values, integers as varints, big integers as 128-bit little-endian, strings as
  length-prefixed UTF-8. Two encoders — the node's and the browser wallet's — are
  the *same module*, so a signature produced in a browser verifies in a node.
* Maximum transaction size: 16 KiB. Maximum memo: 256 bytes. Maximum events per
  transaction: 64.
* `validUntil` is an absolute protocol time. The interface sets
  `protocolTime + 600`; the protocol's own window is 240 blocks (1,200 s).
* A signature is secp256k1 (ECDSA, low-S, DER-normalised). The sender address is
  `bech32m(hrp, ripemd160(sha256(compressed public key)))`.
* Replay protection is the pair `(sender, nonce)` plus a transaction id that is a
  hash of the canonical bytes. A mined transaction cannot be re-mined; the
  mempool rejects a duplicate id, a stale nonce and an already-seen signature.

### Transaction types

| Type | Purpose |
| --- | --- |
| `PAYMENT` | Transfer OBS; pays gas to the Mining Pool |
| `MINING_CLAIM` | Claim the protocol mining reward |
| `ONS` | Register, transfer, update or renew a `.obs` name |
| `CAPSULE` | Create, reveal or preview a Time Capsule |
| `LAND` | Protocol purchase, listing, marketplace sale, buyback, gift |
| `SOCIAL` | Profile, follow, post, delete, tip, business page, verification, views |
| `ORACLE` | Publish an OBS price observation from an independent source |
| `VALIDATOR` | Register, bond change, commission change, unbond |
| `TREASURY` | Treasury revenue payment and grants (treasury wallet only) |

`decode*Body` functions live beside each executor in
`obsidian-core/src/transactions/executors/<type>.ts`; they are what the indexer
uses to describe a transaction to the explorer.

## 3. State

State is a Merkleised map: accounts (balance, nonce, flags), the mining pool,
treasury, ONS records, land divisions and parcels, capsules, social profiles,
posts and follows, oracle submissions and prices, and validator records.

Every block commits to a **state root** and an **events root**. Nodes verify both
after applying a block, so a node that computes a different result from the same
block is detecting either a bug or a lie — not “disagreeing about policy”.

Applying a block is a pure function:

```
applyBlock(parentState, block) → { state, events, receipts }
```

which is why the node can simulate transactions (`POST /tx/simulate`) and serve
gas quotes without touching its committed state.

### Supply invariant

```
Σ(balances) + mining pool + locked capsule commitments + validator bonds = metrics.totalSupply
metrics.totalSupply ≤ 21,000,000 OBS
```

The only issuance paths are the single genesis allocation and mining rewards.
There is no administrative mint, no burn-from-anyone and no path that increases
supply past the cap: `verifySupplyInvariant()` is checked by the core suite and
exposed as `/supply`.

## 4. Genesis

* One allocation: **100,000 OBS**, awarded **atomically to the first valid mining
  claim** on a chain. It is not paid at registration, not per account and not to
  a founder address.
* Awarding it flips `genesisAllocationClaimed` from `false` to `true`, records
  `genesisRecipient`, and every node converges on the same recipient.
* The recipient's wallet becomes the on-chain **treasury wallet**: platform
  revenue (ONS fees, land protocol revenue, business pages, network share of
  monetisation) is routed there. User funds never are.
* The legacy 3,000,000 OBS “signup allocation” is gone. Query
  `/audit/compliance` and you get `legacyGenesisAllocation.present = false` and
  `signupAllocation.present = false` from a running node, not from a claim in a
  document.
* Registration on the interface creates an **account with 0 OBS**
  (`registry.newAccountBalanceObs = 0`).

## 5. Fees and the Mining Pool

* Gas is **0.02% (2 basis points) of the transferred amount, capped at 0.01 OBS**.
* It is deterministic: `gasQuote(amount)` in the node and `expectedGas(amount)` in
  the wallet library return the same number for the same input, and a transaction
  whose declared gas is below the requirement is rejected with `ERR_BAD_GAS`.
* Every seal of it returns to the **Mining Pool**, which pays mining rewards.
  No gas goes to a company, a CDN or a founder address.

## 6. The four networks

| Network | Chain id | HRP | RPC | P2P | Purpose |
| --- | --- | --- | --- | --- | --- |
| mainnet | 7777 | `obs` | 8630 | 8631 | real value |
| testnet | 7778 | `tobs` | 18630 | 18631 | public rehearsal |
| staging | 7779 | `sobs` | 28630 | 28631 | release candidates |
| devnet | 7780 | `dobs` | 38630 | 38631 | local development, disposable |

Networks are isolated by genesis document, id, hash and params hash. A node
rejects a block, transaction or peer from another network with
`ERR_WRONG_NETWORK` / `ERR_WRONG_CHAIN_ID`, and refuses to start with a data
directory written by a different network (`assertNetworkSafety`). Addresses from
different networks have different prefixes, so a mainnet address cannot be
mistyped into a devnet transaction and silently work.

## 7. Peer-to-peer

* Nodes dial `OBSIDIAN_SEEDS` (host:port), exchange signed node descriptors, and
  gossip peer lists. Every descriptor is signed by the node identity key, so a
  third party cannot insert itself as a peer.
* Health, latency, height and genesis id are tracked per peer. A peer that is
  behind, unresponsive repeatedly, or on a different genesis is demoted and
  eventually pruned; its entry is dropped from `<data-dir>/peers.json`.
* Block and transaction gossip is push-based; a node that detects a gap requests
  the missing range from the best peer it knows (`blocksForSync`,
  `requestSyncFromPeers`).
* The interface does not need any of this: it reads nodes over HTTP and fails
  over between them.
