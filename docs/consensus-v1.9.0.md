# Consensus specification — protocol 1.9.0

This is the written specification of how blocks are produced, ordered and agreed on in protocol 1.9.0, and what is
**not** claimed. Every rule below is implemented in `obsidian-core` and named with the file that holds it. Where a goal
cannot be met without trading away another requirement, the limit is stated in plain words in §10.

Protocol 1.9.0 is a **fresh start**: it removes validators, bonds, validator voting and the finality committee, and it
shares no state, genesis allocation, checkpoint or node registry with any earlier release
(see [upgrading-1.9.0.md](upgrading-1.9.0.md)). There is no compatibility switch: a node of another protocol version is
refused at the handshake and a data directory from another genesis is refused at start-up.

Related: [finality-v1.9.0.md](finality-v1.9.0.md) (what "final" means), [node-binding-v1.9.0.md](node-binding-v1.9.0.md)
(reward wallets), [node-rewards-v1.9.0.md](node-rewards-v1.9.0.md) (the 90% pool), [ons.md](ons.md) (names).

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **Node** | A full node: it downloads, verifies and relays every block and transaction and keeps the whole state. A *light client* only reads from a node's RPC and verifies nothing; it is not a node, has no identity on chain and earns nothing. |
| **Node identity key** | One secp256k1 key held by the operator (the node keystore). Its hash is the `nodeId`; its address is the node's producer address. It never leaves the operator's machine. |
| **Registered node** | A node whose `REGISTER` statement, signed by its own identity key, is in the chain's `NODE_REGISTRY` state. |
| **Slot** | One protocol-time interval of `targetBlockSeconds` (5 s). |
| **Round** | How many whole slots elapsed beyond the first between a block and its parent. Round 0 is the normal case. |
| **Eligible producer** | A node in the producer set (§3). |
| **Mature** | Registered at least `maturityBlocks` (64) blocks ago. |
| **Protocol time** | The timestamps committed in block headers; never a browser or device clock (§5). |

## 2. What was removed, and what replaced it

| 1.8.x mechanism | 1.9.0 |
| --- | --- |
| Validator registration transaction, 20,000 OBS bond, unbonding, slashing of funds | **Gone.** Nothing is bonded, nothing is confiscated. |
| Round-robin proposer chosen from validators; open bootstrap and the "No Validator" halt | Producer set = registered nodes (§3). A chain never halts for want of a producer (§3, tiers). |
| Finality votes, a committee of four committed bootstrap keys, a two-thirds vote quorum | Derived finality, no votes ([finality-v1.9.0.md](finality-v1.9.0.md)). |
| Validator-mode lock and bootstrap-committee environment variables | Removed. A node needs no mode. |
| Staking and validator screens | Removed from every interface. |

Generic block, transaction and signature verification is unchanged: header format, transaction format, address format,
fees, chain ids and the mining gate are as they were (the gate keys and `mining/gate.ts` are untouched).

## 3. The producer set

Evaluated from the **parent** state, at the candidate block's timestamp (`consensus/schedule.ts`):

1. **TIER 1** — registered, not banned, **mature**, **live** (a sign of life inside `activityWindowSeconds`, 2 days) and
   not **suspended**. This is the normal set.
2. **TIER 2** — only when TIER 1 is empty: every registered, non-banned node regardless of maturity, liveness or
   suspension. A chain whose only mature producers vanished must be able to continue.
3. **OPEN** — only when no registered, non-banned node exists at all: any key may produce. This is the founding state of
   a fresh chain (nobody can register before the first block exists). It ends with the first accepted registration.

The set is **sorted by producer address**. Registration order, time and who arrived first have no influence on the
order.

## 4. The schedule and skipped slots

```
round(parent, block)    = max(0, floor((block.timestamp − parent.timestamp) / targetBlockSeconds) − 1)
producer(height, round) = set[(height + round) mod |set|]
```

* Nobody votes, no administrator assigns turns and there is no central scheduler: the schedule is a function of the
  parent state and two header timestamps, so any node recomputes it from a block alone.
* **Skipped slots (deterministic).** If the round-0 producer does not produce, the turn passes to the next node in the set
  once its slot has elapsed. A missing node costs the network one slot, not the chain.
* **Misses.** When a block belongs to a later round, exactly **one** node is named as having missed (the round-0 producer
  of that height; `missedProducersFor`), so a future-dated block cannot frame many nodes at once. Three consecutive misses
  suspend the node for `baseSuspensionSeconds` (10 min), doubling on each repeat up to `maxSuspensionSeconds` (24 h).
  Producing a block clears the counters. Suspension costs turns, never funds, and ends by itself
  (`consensus/producers.ts`).
* **Reconnect churn.** A node that drops and reconnects is not penalised for reconnecting: liveness comes from
  chain-recorded evidence (blocks and heartbeats), not from connection state.

### Who may produce a block

A block is valid only if its header signature verifies under the key that hashes to `header.producer` **and** that producer
is the scheduled one for `(height, round)` (`blockchain/block.ts`, `blockchain/chain.ts`). An outsider's block fails with
`NOT_PRODUCER_TURN`.

## 5. Timestamps and clocks

`validateBlockTime` (`consensus/time.ts`) requires:

* `timestamp >` median time past of the last 11 blocks;
* `timestamp ≥ parent.timestamp + 1 s`;
* `timestamp ≤ localTime + maxFutureDriftSeconds` (60 s).

The local clock is consulted only to **reject** a block that claims the future; it can never make an old block valid. A node
with a wrong clock harms itself (its blocks are refused), not the chain. No external time server, central uptime API or
operator-supplied time exists anywhere in the protocol.

**Limit.** A producer may date a block up to 60 s ahead, so it can claim a later round than real elapsed time supports — at
most `drift / targetBlockSeconds` (12) rounds ahead. It still cannot leave the producer set, and a node that claims rounds
it did not earn is the *only* node named when it does so.

## 6. Duplicate and conflicting blocks

* A node may hold at most `maxCandidatesPerHeight` (8) competing candidates for a height; more are refused.
* A producer that signs **two different blocks on the same parent** has equivocated. Any registered node can submit both
  signed headers in a `REPORT_EQUIVOCATION` statement; every node re-verifies both signatures and that they are distinct
  blocks on one parent. The identity is **banned permanently** and its reward wallet released
  (`transactions/executors/node-registry.ts`). A ban needs two valid signatures from the key, so a stranger cannot forge one.
* The node agent builds that report automatically from evidence its own chain observed (`node-agent.ts`).

## 7. Fork choice

A branch must contain the **finalized prefix** ([finality-v1.9.0.md](finality-v1.9.0.md)). Among such branches, the greatest
cumulative PoT weight wins (every valid block adds exactly one unit, so this is "most blocks"), then greatest height, then
the **lowest block hash**. The last rule makes the choice fully deterministic: two honest nodes holding the same candidates
choose the same head. Transactions cannot buy fork-choice authority. A reorganisation deeper than `maxReorgDepth` (256) is
refused.

## 8. Eligibility, admission and Sybil resistance

A node becomes a producer by registering — free, no gas, no bond, signed by its own identity key only. Registration is
limited (`maxRegistrationsPerBlock` 2; per period `max(16, ceil(n/10))` new nodes), a new node is not schedulable until it is
**mature** (64 blocks), and it must show liveness to stay in TIER 1.

**Honest limit — read this.** These are *speed* limits, not *cost*. Admission is not priced (that is the price of "no
deposit, no VPS"): a patient attacker with many machines can register many nodes. The consequences are in §10. The protocol
does not and cannot distinguish one operator running ten nodes from ten operators.

**Identity forgery.** A node statement is an ordinary transaction whose sender is the address of the node key, so the
standard signature check proves the key signed it. `nodeId = hash(public key)` is checked. Nobody can register or speak for a
node without its key.

## 9. Recovery

* **Restart.** State and the finalized checkpoint live in the chain database and the state root; a node replays and
  re-derives them, and refuses a database whose recomputed state root differs from a header's. Interrupted writes are covered by
  the safety record and the integrity check (`validate`).
* **Partition.** Each side keeps producing (no side needs a quorum to *produce*). Neither side can finalize more than the
  other unless it holds two thirds of the established producers ([finality-v1.9.0.md](finality-v1.9.0.md)). On healing,
  fork choice (§7) picks one branch; blocks on the loser are discarded unless the reorganisation would cross the finalized
  prefix, in which case it is refused.
* **A long-offline node** must obtain a recent finalized checkpoint from a source it trusts (weak subjectivity).

## 10. Assumptions and limits (stated, not hidden)

1. **Not Byzantine fault tolerant.** Producing needs no quorum. The guarantees hold while fewer than one third of the
   established producers are faulty (finality) and while an attacker does not control most of the producer set (liveness
   and chain choice).
2. **Sybil.** A fleet of nodes under one operator is indistinguishable from independent ones. Over one third of established
   producers can stall finality; over two thirds can control which chain is built. Maturity and rate limits only slow this
   down.
3. **Single-operator networks.** A fresh test network with one node has no finality (`available: false`) and says so.
4. **Timestamps** can be pushed 60 s ahead by a producer; see §5.
5. **No VPS is required**: a PC or home server with a stable connection can be a full node. Mobile devices are not
   automatically eligible: they run light clients unless an operator deliberately runs a full node that stays online, in sync
   and reachable.
6. **No hard-coded mainnet allocation changed**; the genesis allocation, supply cap and fees are those of 1.8.x.

## 11. Verifying all of this yourself

```bash
# the unit, integration and adversarial suites (obsidian-core)
cd obsidian-core && npm ci && npm run build && npx vitest run

# the specific properties
npx vitest run tests/security/producer-schedule.test.ts tests/integration/finality.test.ts \
               tests/security/equivocation-ban.test.ts tests/integration/genesis-fresh-start.test.ts \
               tests/unit/node-production-loop.test.ts tests/integration/p2p.test.ts
```

A running network can be cross-checked with `node scripts/verify-agreement.mjs <rpc-url> <rpc-url> …`, which compares the
genesis, the parameters, the block and the state root at the lowest common height, and every reported finalized checkpoint
(see [upgrading-1.9.0.md](upgrading-1.9.0.md) for a fresh test network).
