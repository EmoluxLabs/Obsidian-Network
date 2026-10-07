# Proof of Time (PoT)

Obsidian Network's consensus is **Proof of Time**. This document says what that
means in the code, what it does not mean, and how to check every claim below
against a node you run yourself.

It is deliberately specific. "We call it Proof of Time" is not an argument, and
a protocol does not become time-based because its documentation says so. Every
section names the file and the route you can use to verify it.

---

## 1. The short version

| | Proof of Work | Obsidian's Proof of Time |
|---|---|---|
| What buys the right to produce a block | Computation, spent in a race | The validator schedule, once protocol time has advanced |
| What an attacker must acquire | Hash power | A majority of the validator set, and they still cannot move time |
| Headline network metric | Hash rate | **Time-Rate** — verified blocks and transactions per minute of protocol time |
| "Difficulty" means | How many hashes a block costs | **PoT Difficulty** — how block spacing compares with the protocol target |
| Fork choice | Most accumulated work | Finalized PoT anchor, fixed **PoT Weight**, height, then the lowest block hash |
| Energy | Security is proportional to it | Irrelevant; a faster machine buys nothing |

Obsidian still uses cryptography everywhere: SHA-256 for block ids, Merkle
roots, state roots and PoT Weight; secp256k1 ECDSA for transactions, blocks,
node identities and reward-wallet ownership; PBKDF2 and AES-GCM for the browser
vault. **Hashing is how the protocol proves integrity and identity. It is not
the competition, and computing faster does not earn anything.** That distinction
is the whole content of "PoT, not PoW".

---

## 2. Why time, and not work

Obsidian's core product is a mining claim that a person makes from a phone,
every four hours, six times a day. That design has exactly one hard problem:
**deciding what time it is** without letting the participant decide.

A Proof of Work chain does not solve that problem — it sidesteps it, by making
block production expensive instead of timely. Obsidian solves it directly:

- the chain carries its own clock, derived from block timestamps;
- every rule that matters (claim windows, name expiry, reward
  periods, oracle staleness) is evaluated against that clock;
- a participant's device clock, the website's clock, Cloudflare's clock and the
  node operator's clock are all, individually and collectively, unable to move
  it.

If the protocol can hold that line, it does not need a computational race, and
paying for one would be a pure waste. So it does not have one.

---

## 3. How time is established

### 3.1 Median time past

`medianTimePast(ancestors)` — `obsidian-core/src/consensus/time.ts`

The clock is the **median** timestamp of the last `medianTimePastWindow`
(11) blocks, nearest parent first. Median, not maximum and not mean: one absurd
timestamp cannot move it, whether it comes from honest clock skew or a hostile
producer. Shifting median time past requires a majority of the window, which
requires the validator schedule, which is the thing consensus already governs.

### 3.2 The rules a block's timestamp must satisfy

`validateBlockTime(header, ancestors, localTime)` — same file, and enforced in
`ChainManager.connectBlock` via `checkBlockTimestamp`.

```
timestamp >  median time past of the last 11 ancestors
timestamp >  parent timestamp                       (strict monotonicity)
timestamp <= this node's own clock + 60 seconds     (maxFutureDriftSeconds)
```

The first two clauses are computed **entirely from chain data**, so every node
reaches the same verdict. The third is the only place a validating node's own
clock appears, and it is worth being precise about what it can do:

> A node's clock can only **reject** a block that claims to be from the future.
> It can never **admit** a block the chain-derived rules reject.

That asymmetry is the security property. A node with a clock set ten years fast
does not accept backdated blocks — it just falls behind honest peers and rejects
nothing it should have accepted. A node with a clock set ten years slow rejects
current blocks and stops following the chain. Neither can convince anyone else
of anything, because the other two clauses are not theirs to decide.

### 3.3 Protocol time

`ChainManager.protocolTime` — `obsidian-core/src/blockchain/chain.ts`

```
protocolTime = max(local wall clock, head timestamp + 1, median time past + 1)
```

A node never believes it is earlier than the chain it holds. This is what stops
back-dating from bypassing a cooldown: even a node whose operator rewinds the
system clock will report and use a time at or after the chain's head.

### 3.4 What this means for a mining claim

The countdown in the interface is a rendering of protocol time read from a node.
Changing your device clock changes the countdown you see and **nothing** the
protocol accepts: the claim is validated in the block that includes it, against
that block's timestamp, under the rules above. See `docs/mining.md` and
`obsidian-core/src/mining/rules.ts`.

Verify it: `tests/unit/proof-of-time.test.ts` drives backdated, future-dated,
non-advancing and clock-skewed cases; `tests/integration/consensus.test.ts`
asserts chain time must advance on every block.

---

## 4. Who may produce a block

`scheduledProposer(state, height, round)` — `obsidian-core/src/consensus/proposer.ts`

```
round(parent, block) = max(0, floor((block.timestamp - parent.timestamp) / targetBlockSeconds) - 1)
proposer(height, round) = activeValidators[(height + round) mod validatorCount]
```

Deterministic round-robin over the bonded, unjailed validator set, sorted by
address. There is no randomness to grind, no leader election to win and no
advantage to computing faster. While **no** validator is registered the network
is in "genesis open" mode and any node may propose; the first registered
validator closes open mode for every round.

A block produced out of turn is rejected with `ERR_NOT_PRODUCER_TURN`.

### The round, and why it exists

A validator that does not show up must cost the network **one slot, not the
chain**. The round counts how many target intervals have elapsed since the
parent block: a block produced on schedule is round 0 and the rule reduces to
the plain `height mod validatorCount` rotation. Each further interval of silence advances the round and hands the turn to the
next validator, cycling through the active set. It never falls through to an
unregistered key. If the entire active set is offline the chain halts rather
than permitting an unbonded node to bypass validator admission.

The round is derived entirely from two timestamps that are already committed to
the headers, so every node computes the same answer from the block alone — no
extra header field, no out-of-band round negotiation, and nothing new to sign.
A proposer cannot simply claim a high round to steal a turn: the timestamp rules
in section 3 bound how far ahead a block may be dated and require it to exceed
the median time past, so the reachable round range is small and every node
checks it against the same chain data.

Verify it: `tests/e2e/cluster.test.mjs` registers a single validator, SIGKILLs
it, and proves unregistered survivors do not manufacture later blocks.

---

## 5. PoT Weight, fork choice and checkpoint finality

`potWeight(txCount) = 1` — `obsidian-core/src/blockchain/block.ts`

Every valid scheduled block contributes exactly one unit, whether empty or full.
Transaction volume, gas paid and computing speed cannot buy fork authority.

A candidate must descend from the locally verified finalized checkpoint. Among
eligible branches, `compareTips` prefers fixed PoT Weight, then height, then the
lexicographically lowest block hash. The rule is a pure function of the two
candidates, so every node resolves an equal-height fork to the same block
regardless of peer arrival order or unauthenticated vote gossip. The identifier
is `FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH`.

Finality is native to PoT rather than replacement consensus. `ACTIVE` bonded
validators in the target parent state each have one membership vote, regardless
of bond size. `floor(2N/3)+1` signatures produce a sequential certificate only
after target block, ancestry, proposer, state transition, network identity and
validator-set hash checks. The first certificate requires a non-empty set stable
for 64 parent states; later certificates advance one block at a time.

A finalized block and every ancestor are a local safety lock. A valid certificate
can resolve a deep partition beyond the 256-block ordinary reorg limit, with
bounded recovery work. Votes and certificates do not trust wall-clock time.
This gives checkpoint safety under the stated greater-than-two-thirds
honest-membership assumption; it is not a blanket BFT, immutability, zero-reorg
or production-readiness claim. Signed proposer and vote equivocation evidence is
validated, bounded, persisted and gossiped, with no slashing in 1.6.0.

---

## 6. PoT Difficulty

`potDifficulty(ancestors)` — `obsidian-core/src/consensus/time.ts`, published at
`GET /pot`.

```
observed   = (tip.timestamp − oldest.timestamp) / (blocks − 1)     seconds
rawBps     = 10_000 × target / observed        (> 10_000 when blocks are fast)
difficulty = clamp(rawBps, minDifficultyBps, maxDifficultyBps)
spacingMs  = max(minBlockSpacingMs, target × 1000 × difficulty / 10_000)
```

with `target = 5s`, a `720`-block window, and bounds of 2 500–40 000 bps.

**PoT Difficulty is a measurement, not a gate.** It reports how block spacing is
tracking the protocol target — the number an explorer shows where a PoW chain
shows difficulty. It deliberately does **not** add a rejection rule, and it is
worth saying why, because the opposite choice looks more rigorous and is worse:

- a devnet, a catching-up node and a burst of real activity all legitimately
  produce blocks faster than target;
- gating on them would slow a healthy network without making it harder to
  attack, since an attacker's constraint is the validator schedule, not spacing;
- the properties that actually matter — no backdating, no stalling, no running
  into the future — are already enforced by §3.2, which cannot be satisfied by
  computing faster.

The published field is explicit about this: `/pot` → `difficulty.role` is
`MEASUREMENT`, with a note saying what acceptance really depends on. A protocol
that publishes a number should say what the number does.

When the chain is younger than the window, `warmingUp: true` is returned with a
zero observation rather than an invented figure.

---

## 7. Time-Rate

`timeRate(ancestors, windowSeconds)` — same file, published at `GET /pot`.

```
windowSeconds       = tip.timestamp − oldest.timestamp   (within the window)
blocksPerMinute     = (blocks − 1) × 60 / windowSeconds
transactionsPerMin  = Σ txCount × 60 / windowSeconds
```

Unit: `BLOCKS_AND_TXS_PER_MINUTE`, over a 24-hour window, with the derivation
returned in a `method` string so a client can re-explain it without guessing.

Time-Rate is the Obsidian-native replacement for hash rate. A PoW chain
advertises hash rate because its security is bought with computation; Obsidian's
is bought with verified time, so the headline metric is how much verified state
the network carries per minute of protocol time. **It cannot be raised by
computing harder** — two chains with identical timing produce identical
Time-Rate regardless of the hardware that produced them, and that is asserted in
`tests/unit/proof-of-time.test.ts`.

With fewer than two blocks in the window, Time-Rate returns zeros and says why
in `method`, rather than fabricating a rate.

---

## 8. Nonce-like values: what exists and why

The word "nonce" survives in exactly two places in Obsidian, and neither is
PoW-style grinding. There is **no** nonce search, **no** nonce competition and
no field in a block header that anyone iterates over.

| Where | What it is | Why it is not PoW |
|---|---|---|
| `TxEnvelope.nonce` | The sender's account sequence number | An ordering and replay guard, exactly as in an account-based ledger. It is `expectedNonce = account.nonce`; there is nothing to search — any value but the next one is rejected with `ERR_BAD_NONCE`. |
| `ONS` record salt | Random salt generated when a name is registered | A hiding value, so two identical registrations do not produce the same commitment. Generated once from the CSPRNG and never iterated. |

Block headers contain: protocol version, chain id, height, previous hash,
transaction root, state root, params hash, timestamp, producer, cumulative PoT
Weight, transaction count, events root and the producer's signature. There is no
nonce field, because there is nothing to grind for.

Deterministic signature nonces (RFC 6979) exist inside ECDSA, as in every
correct ECDSA implementation. They are a property of the signature scheme, not
of consensus.

---

## 9. What "time-intensive" does and does not claim

Obsidian does not claim to need zero computation. Validating a block means
verifying signatures, recomputing a Merkle root, replaying a state transition
and hashing a state root — real work, on every node, for every block.

What Obsidian claims is narrower and checkable: **no participant gains authority
by performing more computation than another.** There is no puzzle whose solution
confers the right to produce a block, and no quantity in the protocol that
increases when a participant computes more. That is the difference between a
chain that is secured by computation and one that is secured by time.

Any statement of the form "Obsidian is energy-intensive because it is a
blockchain" is false here, and so is "Proof of Time means no computation".

---

## 10. Replay, duplication and race protection

Time-based rules invite time-based attacks, so each has a specific defence:

| Attack | Defence | Where |
|---|---|---|
| Replaying an old transaction | Account nonce + `recentTxIds` replay set + `validUntil` expiry | `state-machine.ts`, `transactions/encode.ts` |
| Replaying a mining claim | Unique claim id derived from (wallet, sequence, chain), stored in `recentClaimIds` | `transactions/executors/mining.ts` |
| Two claims in one block | `maxClaimsPerBlockPerWallet = 1`, enforced during block application | `state-machine.ts` |
| Multi-tab / multi-device double claim | The claim is only real once a block includes it; the second one hits the interval rule or the claim-id replay set | `mining/rules.ts` |
| Backdating a claim to skip a cooldown | Cooldowns compare against block timestamps, which cannot go backwards | §3.2, §3.3 |
| Replaying a node heartbeat or attestation | One heartbeat per node per reward period; attestations deduplicated per (period, observer, subject) | `transactions/executors/node-registry.ts` |
| Replaying a node registration proof | Proofs carry `issuedAt`/`expiresAt`, validated against protocol time, max one hour | same |
| Reusing a signature across networks | Every signed message carries the network id, the chain id and its own domain tag | `protocol/domains.ts` |
| Settling a reward period twice | `lastSettledPeriod` is consensus state | `economy/settlement.ts` |

---

## 11. How to verify all of this yourself

```bash
# 1. Run a node.
cd obsidian-core && npm ci && npm run build
node dist/cli.js --network devnet --data-dir /tmp/obs --offline

# 2. Ask it what its consensus is, and check the numbers it reports.
curl -s localhost:38630/pot | jq
curl -s localhost:38630/params | jq '.proofOfTime, .consensus'
curl -s localhost:38630/finality | jq

# 3. Recompute Time-Rate yourself from the blocks it serves.
curl -s 'localhost:38630/blocks?limit=50' | jq '[.blocks[] | {timestamp, txCount}]'

# 4. Run the suite that asserts the rules in this document.
npx vitest run tests/unit/proof-of-time.test.ts
```

`/pot` returns nothing a client has to trust: every field is derived from blocks
the same endpoint will hand you.

---

## 12. Parameters

All of these are compile-time constants of the protocol version, included in
`PARAMS_HASH`, and therefore impossible to change at runtime or per operator.

| Parameter | Value | Meaning |
|---|---|---|
| `proofOfTime.consensus` | `PROOF_OF_TIME` | The protocol's consensus identity |
| `proofOfTime.weightRule` | `FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH` | Fork choice |
| `consensus.finality.quorum` | `floor(2N/3)+1` | Equal-membership checkpoint threshold |
| `consensus.finality.bootstrapSetStabilityBlocks` | 64 | Stable-set requirement before first certificate |
| `proofOfTime.difficultyTargetSeconds` | 5 | Target block spacing |
| `proofOfTime.difficultyWindowBlocks` | 720 | Difficulty measurement window |
| `proofOfTime.minDifficultyBps` / `maxDifficultyBps` | 2 500 / 40 000 | Published bounds |
| `proofOfTime.minBlockSpacingMs` | 200 | Floor for the reported spacing |
| `proofOfTime.timeRateWindowSeconds` | 86 400 | Time-Rate window |
| `block.medianTimePastWindow` | 11 | Blocks in the median clock |
| `block.maxFutureDriftSeconds` | 60 | How far ahead a timestamp may claim to be |
| `block.targetBlockSeconds` | 5 | Target spacing |

---

## 13. Related documents

- `docs/consensus.md` — validators, jailing, reorganisation.
- `docs/mining.md` — the claim schedule and its time rules.
- `docs/node-runner-rewards.md` — the 90/10 ONS split and how node participation is
  measured (also time-based, also non-self-reported).
- `docs/security-model.md` — the full threat list and what answers each one.
