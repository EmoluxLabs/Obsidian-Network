# Consensus

This is the reference for **how Obsidian Network decides what happened**: block validity, who may produce a block, fork
choice, reorganisation and finality, as implemented by protocol 1.9.0. The full specification, with the assumptions and
limits, is [consensus-v1.9.0.md](consensus-v1.9.0.md); finality is [finality-v1.9.0.md](finality-v1.9.0.md). The temporal
mechanism itself, and why this is Proof of Time and not proof-of-work, is in [proof-of-time.md](proof-of-time.md). The
constants quoted here are defined in `obsidian-core/src/protocol/params.ts` and checked by `scripts/check-invariants.mjs`.

Everything in this document is a **protocol rule**, not an operator setting. Changing any of it requires a protocol version
bump and a coordinated upgrade: nodes that disagree about a rule compute a different params hash and refuse each other
during the handshake. **There are no validators, no bonds and no votes in this protocol.**

---
## 1. Blocks

| Rule | Value |
| --- | --- |
| Target spacing | 5 seconds |
| Maximum serialized block size | 2 MiB |
| Maximum transactions per block | 2,000 |
| Allowed future timestamp drift | 60 seconds |
| Median-time-past window | 11 blocks |
| Minimum timestamp gap | strict monotonicity: a full second (difficulty is measured, not enforced) |
| Confirmation depth (soft / hard) | 12 / 64 blocks |
| Maximum reorganisation depth | 256 blocks |
| Header nonce | **none — there is no nonce field** |

A block header commits to its height, parent hash, timestamp, cumulative PoT
Weight, transactions root, events root, **state root**, params hash and protocol
version. Two nodes that compute different state from the same block are
detecting a bug or a lie, not disagreeing about policy.

### Timestamp rules

A block is accepted only if all three hold, checked against the chain the node
already holds:

1. `timestamp > medianTimePast` — the median of up to the last 11 ancestors'
   timestamps. Median, not maximum, so a single absurd value (honest clock skew
   or a hostile producer) cannot move the clock: it takes a majority of the
   window to shift it.
2. `timestamp > parent.timestamp` — strict monotonicity, enforced with a
   one-second floor. (PoT Difficulty is reported, not enforced: see below.)
3. `timestamp <= localTime + 60s` — the only place a node's own clock is
   consulted, and it can only *reject* a block claiming the future. It can never
   make a past block acceptable.

A node whose clock is wrong therefore harms itself: its blocks are rejected by
honest peers, and it falls behind. There is no rule that lets a node with a
correct clock accept a block from the future.

### PoT Difficulty and Time-Rate

PoT Difficulty is a **measurement**, not a gate. From the last 720 blocks it
compares observed spacing with the 5-second target and publishes the result as a
minimum spacing in milliseconds (bounded to 25%–400% of the target). It is what
the interface and `/pot` show where a proof-of-work chain would show difficulty.
The protocol deliberately does not reject a block for being *faster* than the
target: a healthy devnet, a syncing node and a burst of activity are all
legitimately faster, and punishing them would slow the network without making it
safer.

Time-Rate is the participation metric — verified blocks and verified
transactions per minute of protocol time over a 24-hour window — and is what an
explorer shows where a PoW chain shows hashrate.

### Protocol time

`protocolTime = max(local wall clock, head.timestamp + 1)`. A node never
believes it is earlier than the chain it holds, so mining claims, ONS terms
and transaction expiry cannot be back-dated to bypass a cooldown. Cooldowns are
enforced by every node against block timestamps, never by an interface
countdown.

---

## 2. Who produces a block

Any **registered, mature, live, unsuspended node** may produce blocks; there is no validator set, no stake and no vote. The
producer for a block is a pure function of the parent state and two header timestamps:

```
set                      = TIER1 (mature, live, not suspended), else TIER2 (every non-banned node), else OPEN (any key)
set                      sorted by producer address
round(parent, block)     = max(0, floor((block.timestamp - parent.timestamp) / 5 s) - 1)
producer(height, round)  = set[(height + round) mod |set|]
```

A block signed by anyone else fails with `NOT_PRODUCER_TURN`. If the scheduled producer is silent, the turn passes to the
next node once its slot has elapsed (a skipped slot costs one slot, not the chain); three consecutive misses suspend a node for
10 minutes, doubling to 24 hours, and producing a block clears the counters. Registering is free (no gas, no bond) and
rate-limited; a new node is schedulable after 64 blocks. Details, Sybil limits and the tests:
[consensus-v1.9.0.md](consensus-v1.9.0.md) sections 3, 4 and 8.

## 3. Fork choice and finality

A candidate is considered only if it is protocol-valid and **contains the finalized prefix** the node derived from its own
state. Eligible tips are compared in this order:

1. **greatest accumulated fixed PoT Weight** — every valid block contributes one unit; transactions and fees add no authority;
2. **greatest height**;
3. **lowest header hash** — a total order over otherwise equal candidates, so the same two branches resolve the same way on
   every node, every time.

There is no arrival-order component and no support weighting. A node holds at most 8 candidates per height.

**Finality** is derived from the chain itself, with no votes and no timer: a block is final once, within a window of
`clamp(3n, 32, 1024)` blocks above it, at least `floor(2n/3)+1` distinct established producers have built on it (with `n ≥ 3`).
The checkpoint is in the state root, never moves backwards and survives a restart. It is **checkpoint (economic) finality, not
Byzantine finality**: it holds only while fewer than a third of the established producers are faulty
([finality-v1.9.0.md](finality-v1.9.0.md)). With fewer than three established producers `/finality` says `available: false`
and nothing is called final.

## 4. Equivocation

A producer that signs **two different blocks on one parent** is banned permanently. Any registered node submits the two signed
headers in a `REPORT_EQUIVOCATION` transaction; every node re-verifies both signatures and that the blocks are distinct
siblings. Nothing is confiscated: the ban removes the identity from the producer set and releases its reward wallet. Building
on two different branches is not equivocation and is not punished (see the limits in the finality document).

## 5. Reorganisation and recovery

* A reorganisation deeper than `maxReorgDepth` (256) is refused, and a branch that omits the finalized block is refused even if
  it is longer.
* A reorganisation rebuilds state from the common ancestor, and each block's committed state root is re-checked.
* **Restart:** state and the finalized checkpoint are read back from the database and re-verified; interrupted writes are
  covered by the safety record, and `obsidian validate` re-checks the stored chain.
* **Partition:** each side keeps producing; a side without two thirds of the established producers cannot finalize anything,
  and on healing the heavier branch wins by the rule above, provided it contains the finalized prefix.
* A node that is behind syncs from peers, verifying every block (signature, schedule, timestamp, state root) as it goes.

---

## 6. Transactions in consensus

The state machine dispatches exactly one executor per transaction type, and an unknown type is a hard rejection — never a
silent no-op:

| Id | Type | Id | Type |
| --- | --- | --- | --- |
| 1 | `PAYMENT` | 9 | `TREASURY` |
| 2 | `ONS` | 10 | `GOVERNANCE` |
| 6 | `ORACLE` | 11 | `NODE_REGISTRY` |
| 7 | `MINING_CLAIM` | | |

Ids 3, 4 and 5 belonged to the discontinued Circle, Social and Time Capsule transactions, and ids 8 (`VALIDATOR`) and 12
(`SLASH`) were removed in 1.9.0 with the validator model. All of them are retired and never reused: no executor exists, and
the state machine rejects them as unknown types.

Rules that apply to every type — canonical encoding, nonce ordering, replay rejection, size and memo limits, gas — are
enforced in the state machine before the executor runs (`obsidian-core/src/blockchain/state-machine.ts`). The transaction
envelope, signing digest and encoding are in [transaction-format.md](transaction-format.md); the economic parameters the
executors enforce are in [economics.md](economics.md).

---

## 7. Networks and genesis

Four networks ship in the repository, each with its own genesis document,
genesis id, ports, address prefix and chain id:

| Network | Chain id | RPC / P2P | Address prefix |
| --- | --- | --- | --- |
| mainnet | 7777 | 8630 / 8631 | `obs` |
| testnet | 7778 | 18630 / 18631 | `tobs` |
| staging | 7779 | 28630 / 28631 | `sobs` |
| devnet | 7780 | 38630 / 38631 | `dobs` |

A node refuses to start on a data directory written by another network rather
than risk mixing two histories. Genesis ids and hashes are derived
deterministically from the genesis document and the consensus parameters;
`node dist/index.js genesis init --network <name>` prints the same values on
every machine. A peer that reports a different network id, genesis id, protocol
version or params hash is refused during the handshake.

## 8. Verifying these rules on a running node

```bash
curl -s localhost:8630/params | jq .proofOfTime     # consensus identity, fork choice, difficulty
curl -s localhost:8630/pot                          # PoT Difficulty and Time-Rate
curl -s localhost:8630/producers                    # the producer set, tier, suspensions, bans
curl -s localhost:8630/finality                     # the derived checkpoint and why it is (un)available
curl -s localhost:8630/audit/compliance             # removed mechanisms, all present:false
node scripts/check-invariants.mjs                   # the invariants; exits non-zero on drift
```

`/audit/compliance` is the quickest way to confirm that the mechanisms this
document does **not** describe — proof-of-work, a header nonce, admin minting,
KYC-gated mining, a native exchange — remain absent at runtime.
