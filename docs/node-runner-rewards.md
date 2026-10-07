# Node Runner Rewards

Independent nodes are the network. This document defines exactly how Obsidian
pays for them: where the money comes from, how a node becomes eligible, how its
contribution is measured without ever asking it, and how the payout is computed
so that any node can recompute and disagree.

Everything here is protocol state and protocol arithmetic. There is no admin
panel, no allowlist, no company database and no discretionary allocation.

---

## 1. The split

```
                        ONS revenue
                              │
                  ┌───────────┴───────────┐
                90%                      10%
                  │                        │
                  ▼                        ▼
      Node Runner Reward Pool      Treasury wallet
                                   (designated on-chain by
                                    the genesis rule)
```

ONS registration and renewal fees are the protocol's **only** revenue source.
Implemented in `splitOnsRevenue()`
(`obsidian-core/src/economy/accounting.ts`) and applied by
`WorldState.creditOnsRevenue()` inside the state transition — not by a
worker, a website or a scheduled job.

Exact integer arithmetic:

```
nodeRunnerPool = floor(amount × 9000 / 10_000)
treasury       = amount − nodeRunnerPool
```

The treasury takes the remainder, so the two parts always sum back to the
amount and no seal can be lost to rounding in either direction. The invariant is
asserted on every credit (`assertSplitInvariant`) and tested at amounts from one
seal to the entire 21,000,000 OBS supply.

If no treasury wallet has been designated yet (nobody has made the first valid
mining claim), the treasury share is **not** abandoned: it is recorded in
`nodeRewards.unclaimedRevenue` and held by the Mining Pool as protocol value,
then paid to the treasury as soon as the designation exists
(`claimUnclaimedRevenue`).

---

## 2. What counts as ONS revenue

Only the two fees the protocol charges for names. Both are enumerated in
`RevenueSource` and recorded on-chain with the split event, so an auditor can
classify every basis point from chain data alone.

| Source | What it is |
|---|---|
| `ONS_REGISTRATION` | A `.obs` name registration fee (0.05 OBS) |
| `ONS_RENEWAL` | A `.obs` name renewal fee (0.05 OBS) |

### What is deliberately NOT ONS revenue

Listed in `NOT_ONS_REVENUE`, with a reason attached to each, and asserted
by tests:

| Flow | Why it is excluded |
|---|---|
| User-to-user transfers | The sender owns the funds; the protocol is only the messenger |
| Mining rewards | Issued by the protocol schedule, never paid in by a user |
| Transaction gas | Gas funds the Mining Pool — see §3 |
| Validator bonds | The bond stays the validator's own money and returns at unbonding |
| Node registration | Moves no funds at all — there is no registration bond |
| Treasury spending | It pays out credited revenue; it is not new income |
| Escrowed balances | Held by the protocol for their owner, not the protocol's money |

---

## 3. Gas is not revenue

Gas is 0.02% of the transferred amount, capped at 0.01 OBS, and **all of it goes
to the Mining Pool** exactly as before. It is not split 90/10, it is not
treasury income, and it is not node-runner income.

Mixing the two would have been the easy mistake: it would have quietly diverted
miner income into node rewards. The accounting categories in
`economy/accounting.ts` exist precisely so that this cannot happen by accident,
and `GET /revenue` reports the gas total separately with a note saying so.

---

## 4. Node identity

Three distinct things, deliberately separated:

```
Node Identity  (secp256k1 keypair, generated on the node, never leaves it)
      ↓
Node Operator  (the human)
      ↓
Reward Wallet  (an obs1… address the operator controls)
```

- `nodeId` is the 20-byte hash of the node's public key. It **is** the identity.
- An **IP address is never an identity**. A node can change IP, hosting
  provider, machine and domain and remain the same node. The `endpoint` field is
  an optional discovery hint, is validated only as `host:port`, and is never
  used for scoring or for reward attribution.
- The reward wallet receives payouts. One wallet may back exactly one node, and
  one node has exactly one reward wallet at a time.

---

## 5. Registration, and proving you own the wallet

`NODE_REGISTRY / REGISTER` — `transactions/executors/node-registry.ts`

```
Run Obsidian Core
      ↓  generates/loads the node identity key, prints the node id
Sync and peer
      ↓
Node signs a registration statement with the NODE key
      ↓  domain: OBSIDIAN:NODE_REGISTRATION:v1
      ↓  contains: networkId, chainId, nodeId, rewardWallet, endpoint,
      ↓            issuedAt, expiresAt
Reward wallet signs and pays for the transaction (nothing is locked)
      ↓
Protocol verifies BOTH signatures, binds nodeId → rewardWallet
      ↓
Node is reward-eligible from the next full period
```

**Two keys, two jobs.** The node key proves the node consents; the wallet key
(via the ordinary transaction signature) proves the operator controls the payout
address. Neither alone is sufficient:

- someone who steals a node key cannot point rewards at their own wallet — the
  current wallet must sign the change;
- someone who knows your wallet address cannot attach it to their node — the
  transaction must be signed by that wallet.

The node's **private key is never transmitted and never requested**. Nothing in
the registration path, the RPC surface or the interface accepts a private key.

Registration proofs carry `issuedAt`/`expiresAt`, validated against protocol
time and capped at one hour, so a captured statement is worthless by the time an
attacker could get it mined.

### No registration deposit

Registering a node runner **moves no funds**. There was once a 100 OBS
registration bond, and it was removed as a mechanism rather than set to zero:
two bonds with one name is exactly how an economic rule ends up enforced in one
place and not another. The protocol has exactly one bond — the validator's
20,000 OBS — and it is enforced in one place.

What keeps the registry honest is what a node cannot fake: an identity bound to
a reward wallet by signatures from both, one node per wallet, attestations that
must come from *other* nodes, and a per-node cap on any period's payout. A Sybil
fleet therefore needs ten distinct funded identities and cannot attest itself
into an uptime it does not have.

---

## 6. Evidence: the protocol never asks a node how it did

There is **no field** in which a node can report its uptime, its participation,
its efficiency or its hash rate. The only statements a node may make are:

| Statement | Signed by | What it proves |
|---|---|---|
| `HEARTBEAT` | The node key | "I am alive in this reward period, at this height" |
| `ATTEST` | An observing node's key | "I observed *another* node alive in this period" |
| `REPORT_FAULT` | An observing node's key | "*Another* node misbehaved, for this reason" |

Constraints that make those statements meaningful:

- one heartbeat per node per period (a replay is `ERR_NODE_HEARTBEAT_TOO_SOON`);
- a node **cannot attest itself** (`ERR_NODE_BAD_SUBJECT`);
- a node cannot report itself;
- statements must name the period the including block belongs to;
- statements are paid for by the node's reward wallet, so each carries a nonce
  and costs gas — spam is not free and duplicates cannot both land;
- a heartbeat cannot claim a height the network has not reached.

Everything else is read directly from the chain: **blocks produced** are counted
by the settlement routine from the block producer, not from any claim.

---

## 7. The scoring formula

`scoreNode(evidence)` — `obsidian-core/src/economy/node-rewards.ts`. All integer,
all basis points, all deterministic.

```
uptimeBps         = min(10_000, heartbeats / heartbeatsPerPeriod × 10_000)
                    scaled by distinctAttesters / requiredAttesters
                    (capped at bootstrapUptimeBps in a peerless network)

producedBps       = blocksProduced / blocksExpected × 10_000
coverageBps       = peersAttested / (peerUniverse − 1) × 10_000
participationBps  = producedBps × 0.6 + coverageBps × 0.4

reliabilityBps    = 10_000 − (corroboratedFaults + invalidAttestations) × 2_000

responsivenessBps = responsiveHeartbeats / totalHeartbeats × 10_000
                    (responsive = reported height within 12 blocks of the network)

scoreBps = uptimeBps         × 40%
         + participationBps  × 25%
         + reliabilityBps    × 20%
         + responsivenessBps × 15%

weight   = scoreBps − minScoreBps,  when registered
                                    and uptimeBps ≥ minUptimeBps (50%)
                                    and scoreBps  ≥ minScoreBps  (10%)
           otherwise 0
```

Design decisions worth stating plainly:

- **Uptime is gated on independent attestation.** A node that heartbeats
  perfectly but that no peer corroborates scores **zero** uptime, and the
  returned `reasons` say exactly that. Partial corroboration gives partial
  credit (one of two required attesters → half).
- **A single-node network is honest about itself.** With no peers to observe it,
  uptime is capped at `bootstrapUptimeBps` (50%) and the score explains why,
  rather than awarding a perfect score to a network of one.
- **A fault needs corroboration.** One node's accusation is recorded on-chain
  but changes no payout; a penalty applies only when independent reporters
  agree. This stops a node from smearing a competitor.
- **Latency is not a component.** Responsiveness measures whether the node's
  *verification* kept up with the chain, not how fast its network link is.
  Nothing in the formula rewards expensive hardware.

---

## 8. Settlement

`processNodeRewardRoutine` — `obsidian-core/src/economy/settlement.ts`, called
from `runBlockRoutines` for **every block on every node**.

Periods are fixed 24-hour windows of protocol time. The first block whose
timestamp falls in a new period settles the period that just closed:

1. wallet changes whose effective period has arrived take effect **first**, so
   the receiving wallet is the one the protocol recorded earlier — never one
   introduced in the same block that pays out;
2. every node registered **before the period opened** is scored (a node that
   appeared mid-period has partial evidence and waits for the next period
   rather than being judged against a full one);
3. `weight = scoreBps − minScoreBps`;
4. `shareBps = floor(weight × 10_000 / Σweight)`, then capped at
   `maxNodeShareBps` (5%);
5. `amount = floor(pool × shareBps / 10_000)`;
6. the remainder is **carried into the next period** — never burned, never
   improvised;
7. `Σ paid + pool remaining == pool before` is asserted before anything is
   written, and the supply invariant is re-verified for the whole block.

Properties:

- **No operator, service or cron is involved.** Settlement happens because a
  block happened, exactly like ONS name expiry.
- **A period cannot settle twice**: `lastSettledPeriod` is consensus state.
- **Nobody can be paid for a period they did not qualify in**: the score is
  built from that period's evidence bucket.
- **The block producer cannot steer it**: the routine reads the pool, the
  registry and the evidence, and nothing else.
- **If no node qualifies, the whole pool is carried forward** — it is never
  burned and never redirected to the treasury.

---

## 9. Changing a reward wallet

`NODE_REGISTRY / CHANGE_WALLET`

- must be signed by the node identity key (domain
  `OBSIDIAN:NODE_WALLET_CHANGE:v1`);
- must be **submitted by the current reward wallet** — a stranger cannot start
  the process;
- takes effect `walletChangeDelayPeriods` (1) periods later, not instantly;
- the target wallet must not already back another node;
- only one change may be pending at a time.

**Rewards already accrued are never redirected.** Settlements for earlier
periods have already credited the wallet that earned them, and the delay means a
stolen node key cannot sweep a period that is in flight.

`POST /change-wallet`-style instant redirection does not exist in this protocol.

---

## 10. Deregistration

`NODE_REGISTRY / DEREGISTER`, signed by the node key and submitted by the reward
wallet. Nothing is returned because nothing was locked, the node stops being
scored immediately, and every already-settled payout stays where it was paid. The period in progress is
forfeited, because a node that has left cannot be attested for it.

---

## 11. Sybil resistance without a gatekeeper

| Attack | What stops it |
|---|---|
| One machine, ten node identities, one wallet | One wallet may back only one node (`ERR_NODE_WALLET_IN_USE`) |
| One machine, ten identities, ten wallets | Each needs its own identity and reward wallet, proven by both signatures, and the fleet still cannot attest itself into uptime |
| A fleet attesting itself | A node cannot attest itself; a fleet that is one point of failure earns like one node's worth of corroboration |
| One operator taking a whole period | `maxNodeShareBps` caps any single node at 5% of a period |
| Fabricated uptime | There is no field for it; uptime requires peers' signed attestations |
| Fabricated participation | Blocks produced are read from the chain |
| Replayed uptime proofs | One heartbeat per node per period, bound to the period |
| Smearing a competitor | A fault counts only when independent reporters corroborate it |
| Registering someone else's wallet | The wallet itself must sign the transaction |

No step above requires an administrator to approve a node, and none of it can be
overridden by one.

---

## 12. Transparency

Everything needed to audit the economics is on-chain and served read-only:

| Route | What it answers |
|---|---|
| `GET /revenue` | Lifetime ONS revenue, the 90/10 totals, a per-source breakdown, every protocol-held balance, and what is excluded and why |
| `GET /nodes/registry` | Every registered node with the current period's evidence |
| `GET /nodes/rewards` | The pool, the scoring parameters and every settled period with per-node payouts |
| `GET /nodes/status/:nodeId` | One node's score, its four components, the reasons, the evidence and its settled rewards |
| `GET /params` | `nodeRewards` — every constant used above |

No wallet balances are exposed by any of them: the Explorer's balance-privacy
rule is unaffected. A reward wallet address appears where a payout appears,
because the payout itself is public chain state.

The interface renders all of this at `/node/`, including the four score bars and
the evidence behind them. Where a metric does not exist yet, the page says so
rather than displaying a zero that looks like a measurement.

---

## 13. Parameters

Compile-time constants of the protocol version, part of `PARAMS_HASH`:

| Parameter | Value |
|---|---|
| `nodePoolShareBps` / `treasuryShareBps` | 9 000 / 1 000 (90% / 10%) |
| `periodSeconds` | 86 400 |
| `equivocationSlashBps` (validator slashing) | 5 000 (half the validator bond) |
| `minUptimeBps` | 5 000 |
| `minScoreBps` | 1 000 |
| `maxNodeShareBps` | 500 |
| `minAttesters` | 2 |
| `bootstrapUptimeBps` | 5 000 |
| `heartbeatsPerPeriod` | 1 |
| `maxAttestationsPerAttester` | 64 |
| `faultPenaltyBps` | 2 000 |
| `responsiveHeightLag` | 12 |
| `scoreWeights` | uptime 4 000, participation 2 500, reliability 2 000, responsiveness 1 500 |
| `participationWeights` | blocks 6 000, coverage 4 000 |
| `walletChangeDelayPeriods` | 1 |
| `evidenceWindowPeriods` | 3 |
| `proofMaxValiditySeconds` | 3 600 |

---

## 14. Verifying it

```bash
cd obsidian-core
npx vitest run tests/unit/node-rewards.test.ts        # the arithmetic
npx vitest run tests/integration/node-runners.test.ts # the chain behaviour
```

The integration suite registers real nodes with real signatures and asserts,
among other things: a forged proof is rejected, a foreign wallet cannot be
registered, a duplicate wallet is refused, a heartbeat cannot be replayed, a
node cannot attest itself, nothing is locked at registration, a period cannot settle
twice, and two independent nodes replaying the same blocks reach the identical
state root — which is what proves the reward state is consensus, not bookkeeping.
