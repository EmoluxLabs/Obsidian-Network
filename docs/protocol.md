# Obsidian protocol

Obsidian is a Proof of Time (PoT) blockchain with a fixed maximum supply of
**21,000,000 OBS** and a state machine that carries application data — names,
balances, mining claims, oracle prices, validator bonds and the node-runner
registry — as first-class chain state rather than as rows in a company database.

* Chain id / network id: `7777` / `obsidian-mainnet-1` (plus testnet `7778`,
  staging `7779`, devnet `7780`)
* Address prefix: `obs` (testnet `tobs`, staging `sobs`, devnet `dobs`)
* Protocol version: `1.6.0`
* Consensus: **Proof of Time (PoT)** — see [proof-of-time.md](proof-of-time.md)

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
| Fork choice | finalized anchor → fixed **PoT Weight** → height → lowest block hash |
| PoT Difficulty target / window | 5 seconds / 720 blocks (a measurement, not a gate) |
| Time-Rate window | 24 hours |

A block header commits to height, parent hash, timestamp, cumulative PoT
Weight, transactions root, events root, state root, params hash, protocol
version, producer and the producer's signature. There is no nonce field and no
difficulty target in the header: the right to produce a block comes from the
validator schedule and from protocol time having advanced, never from a
computational race (see [proof-of-time.md](proof-of-time.md)). A block whose header does not validate is discarded; a
block whose **transactions** do not validate is rejected as a whole.

The producer is selected by the deterministic PoT validator schedule. Ordinary
reorgs are capped at 256 blocks and may never cross the locally verified
finalized checkpoint. A valid greater-than-two-thirds equal-membership
certificate can resolve a deeper partition after the target branch is fully
validated. Finality votes use the active validator registry from the target's
parent state; bond size does not add vote weight.

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
* A signature is secp256k1 (ECDSA, 64-byte compact `r || s`, low-S normalised). The sender address is
  `bech32m(hrp, ripemd160(sha256(compressed public key)))`.
* Replay protection is the pair `(sender, nonce)` plus a transaction id that is a
  hash of the canonical bytes. A mined transaction cannot be re-mined; the
  mempool rejects a duplicate id, a stale nonce and an already-seen signature.

### Transaction types

| Type | Purpose |
| --- | --- |
| `PAYMENT` | Transfer OBS; pays gas to the Mining Pool |
| `MINING_CLAIM` | Claim the protocol mining reward |
| `ONS` | Register, transfer, update or renew a `.obs` name (the protocol's only revenue source) |
| `ORACLE` | Publish an OBS price observation from an independent source |
| `VALIDATOR` | Register with exactly the 20,000 OBS bond, unbond, claim |
| `TREASURY` | Spend from the treasury (treasury wallet only) |
| `NODE_REGISTRY` | Node runner registration, heartbeats, attestations and fault reports |

`decode*Body` functions live beside each executor in
`obsidian-core/src/transactions/executors/<type>.ts`; they are what the indexer
uses to describe a transaction to the explorer.

## 3. State

State is a Merkleised map: accounts (balance, nonce, flags), the mining pool,
treasury, ONS records, the Node Runner Reward Pool and registry, oracle
submissions and prices, and validator records.

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
Σ(balances) + mining pool + locked validator and node bonds = metrics.totalSupply
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
* The recipient's wallet becomes the on-chain **treasury wallet**: the 10% ONS
  treasury share is routed there. User funds never are.
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

* Nodes dial `OBSIDIAN_SEED_NODES` (host:port), exchange signed node descriptors, and
  gossip peer lists. Every descriptor is signed by the node identity key, so a
  third party cannot insert itself as a peer.
* **Handshake.** WebSocket, JSON envelopes. The acceptor speaks first with a fresh
  `challenge`; the dialer's `hello` carries the node id, network id, chain id,
  genesis id, params hash, versions, chain tip and finalized checkpoint, and is signed by the node
  identity key **over that challenge**; the acceptor's `hello_ack` is signed over
  the dialer's nonce. A recorded handshake is therefore useless on any other
  connection. Peers that differ in genesis id, network, chain id, params hash,
  protocol version or are below `MIN_CORE_VERSION` are refused before a block is
  exchanged. Before the handshake completes only `hello`, `hello_ack`, `challenge`
  and `reject` are processed, and nothing larger than 64 KiB is read.
* **Limits.** Each link has token-bucket budgets for control messages, block
  messages and transactions; a block batch is accepted only as the answer to a
  request this node made; one remote address may hold eight inbound connections
  (loopback is exempt: a test network lives on one host); a link that runs out of
  credit is dropped and its address refused for ten minutes. A peer is known by
  the address it connects from, never by the host it claims.
* **Gossip.** Block, transaction, finality-vote, certificate and validated
  equivocation-evidence gossip is push-based. Dedup sets, pending queues,
  candidate counts, message bytes and signature work are bounded. Transactions
  and finality objects are validated before relay.
* **Staying level.** `ping`/`pong`/`status` carry the sender's chain tip (height,
  PoT weight, head hash). A node that sees a better tip — better under the fork
  choice rule, which ranks **weight** before height — or an announced block whose
  parent it lacks, syncs from that peer: `getblocks {from,limit}` with an overlap
  behind its own head that doubles until it reaches the common ancestor or the
  `maxReorgDepth` limit, so a node that spent minutes on its own fork rejoins.
  A peer that claims a better chain and cannot deliver it stops being believed.
* Health, latency, height and genesis id are tracked per peer. A peer that is
  behind, unresponsive repeatedly, or on a different genesis is demoted and
  eventually pruned; its entry is dropped from `<data-dir>/peers.json`. Peer
  addresses learned from other peers are validated (syntax, port range, and no
  loopback/link-local/unspecified outside test networks).
* The interface does not need any of this: it reads nodes over HTTP and fails
  over between them.
