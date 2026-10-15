# Finality — protocol 1.9.0

**What this is:** a *producer-diversity checkpoint*. A block is declared final when enough **distinct, established
producers** have since built on it. It is derived from the chain alone.

**What this is not:** deterministic Byzantine finality. There are no votes, no locks, no bond and no quorum certificate,
so finality here is *conditional and economic*, and the conditions are stated in §5. The words "final" and "finalized" in
the RPC mean exactly this and nothing stronger.

Code: `obsidian-core/src/consensus/finality.ts`; parameters: `CONSENSUS_PARAMS.consensus.finality`
(`obsidian-core/src/protocol/params.ts`); tests: `obsidian-core/tests/integration/finality.test.ts`.

---

## 1. No voting, no timer, no administrator

* Nobody signs a finality message. Nothing is gossiped for finality. There is no certificate.
* No local timer, wall clock, operator or admin decides it.
* Finality is computed **inside the block state machine** from the blocks themselves, stored in the world state
  (`state.s.finality`) and **committed in the state root**. A node that computes a different checkpoint computes a different
  state root, and its block is refused. That is the independent verification: it is the same check every block already
  passes, not an extra feature.

## 2. The rule

Let `H` be the head being applied and `n_head` the number of eligible producers at `H`.

```
W = clamp(3 × n_head, 32, 1024)          blocks (the window)
h = H − W                                the candidate checkpoint
base(h) = nodes that were registered AND mature at height h and are, at H, still registered,
          unbanned and live (a sign of life on this chain within 30 reward periods).
          A SUSPENDED node still counts: see below.
n = |base(h)|
```

Block `h` (and every ancestor) becomes **final** if and only if

```
n ≥ 2   and   |{ distinct producers of blocks h+1 … H that belong to base(h) }| ≥ floor(2n/3) + 1
```

The finalized height **only ever moves forward** (monotonic): a later head cannot lower it, and a restart reads it back
from state.

## 3. State, restart, upgrade boundary

| Item | Behaviour |
| --- | --- |
| State | `finalizedHeight`, `finalizedHash` in world state, committed in the state root. |
| Genesis | `finalizedHeight = 0`, `finalizedHash = ''` (a genesis block cannot contain its own hash; the node reads `canonicalHashAt(0)`). |
| Restart | The checkpoint is read from the stored state; it never regresses (test: "survives a restart"). |
| Upgrade | None. 1.9.0 is a fresh start; there are no earlier checkpoints to migrate, and the old finality committee and votes do not exist. |
| Fewer than 2 established producers | `available: false` and a reason. The chain keeps advancing and **nothing is called final**. A single-node network therefore never finalizes — by design, not by bug. |

## 4. Exposure

* `GET /finality` — `model`, `available`, `reason`, `finalizedHeight`, `finalizedHash`, `headHeight`, `lag`,
  `eligibleProducers`, `window`, `quorum`, `minProducers`, `producersSeen`, `candidateHeight`, `derivedFrom`, `assumptions`.
  `available` says the rule can run (at least `minProducers` established); when it is running but short of its quorum,
  `reason` says how many of the required producers have built above `candidateHeight`.
* `GET /status` — `finalizedHeight`, `finalizedHash`, `finalityAvailable`, `finalityEligibleProducers`.
* `GET /producers` — the producer set and the same finality block.
* `obsidian finality` (CLI) and `/readyz` (finality lag against `maxLag`).
* Interfaces display "final" only for blocks at or below `finalizedHeight` and show "unavailable" otherwise. They compute
  nothing themselves.

## 5. Security argument and its assumptions

**Claim.** If fewer than one third of the established producers are faulty, and honest producers never build on a branch
that does not contain the finalized prefix, two conflicting blocks cannot both become final.

**Why.** To finalize block `B` at height `h` on branch X, more than two thirds of `base(h)` must have produced a block above
`B` on X. For a conflicting `B'` on branch Y, more than two thirds must have produced above `B'` on Y. Two sets each
larger than 2n/3 intersect in more than n/3 producers: each of those built on **both** branches.

**Therefore these hold, and these do not:**

| Situation | Result |
| --- | --- |
| A partition with each side holding a minority | Neither side finalizes (it needs two thirds). **No side can finalize itself.** |
| A malicious producer alone | Cannot finalize anything (a single producer is one distinct producer; test: "a single producer … cannot finalize"). |
| A half of a split suspends the other half | Suspension (three missed slots) does **not** remove a node from the base. If it did, each half of a partition would suspend the other half, shrink the denominator, and finalize itself, producing two conflicting final chains. This was a real defect found while writing the 3\|3 split test (the old rule finalized a block of its own at height 175 on one half) and is pinned by `finality.test.ts` for 2\|2, 3\|3 and 3\|2 splits. Whatever a half can finalize is a block both halves share. |
| One of two producers, or two of three | Cannot finalize (the quorum for two is two, for three it is three). Finality simply waits until the missing producer is back, then resumes and catches up. |
| One third or more of established producers faulty | The guarantee **is gone**: they can stall finality, or build on both sides. |
| A producer that builds on two branches | It is counted on both. Nothing is locked and nothing is bonded, so it is **not punished for it**. (Producing two different blocks on one *parent* is punished by a permanent ban — see [consensus-v1.9.0.md](consensus-v1.9.0.md) §6 — but building on two different branches is not equivocation.) |
| A node offline longer than the reorg window | Must obtain a recent finalized checkpoint from a source it trusts (weak subjectivity). The protocol cannot supply that proof. |
| Sybil fleet above one third | Breaks the assumption; admission is rate-limited and delayed, not priced ([consensus-v1.9.0.md](consensus-v1.9.0.md) §8). |

**Conflicting chains.** Fork choice requires the finalized prefix, so a branch that omits a finalized block — even a longer
one — is refused (test: "refuses a branch that omits the finalized block").

## 6. Verifying it independently

```bash
# every node answers from its own state; they must agree
for p in 38630 38640 38650; do curl -s localhost:$p/finality | jq '{finalizedHeight, finalizedHash, available}'; done
node scripts/verify-agreement.mjs http://127.0.0.1:38630 http://127.0.0.1:38640 http://127.0.0.1:38650
```

`verify-agreement.mjs` checks that every reported finalized checkpoint is the block that every other node holds at that
height. Finality is not available until at least two nodes have been registered for 64 blocks; with the 5-second target
that is roughly a few minutes of block time on a fresh network, and then another window (32 blocks) after that.

## 7. Limits (the honest list)

* Checkpoint finality is **not** BFT and is **not** a vote.
* It needs at least two established producers, and a quorum of them alive: with `n` producers it advances only while `floor(2n/3)+1` of them are producing. Any finality that does not trust a single party has this liveness cost; the chain itself never waits for it.
* The base shrinks only by **long silence**: a node with no sign of life on this chain for 30 reward periods stops
  counting. A partition that lasts longer than that, with both halves still holding at least `minProducers` nodes, lets
  each half drop the other and finalize separately. That horizon (30 days) is the price of finality that does not stall
  for ever behind abandoned nodes; operators who see a split must heal it well before then.
* It does not remove the need for weak subjectivity for nodes that were offline for a long time.
* It does not defend against a Sybil fleet — see the producer-admission limits.
