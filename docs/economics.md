# Economics

This document is the map of where OBS is allowed to go. Every number quoted here
is a consensus parameter in `obsidian-core/src/protocol/params.ts`, enforced by
the state transition and asserted by `scripts/check-invariants.mjs` (55 checks).
The revenue classification is declared in `obsidian-core/src/economy/accounting.ts`
and the split arithmetic is exact integer arithmetic — there is no float and no
rounding leak anywhere in an amount path.

The short version: **the protocol has no sale, no premine, no administrator and
no mint authority.** OBS is issued by two rules (a one-time genesis allocation
and the mining schedule), and every fee is paid in OBS at a price fixed by
consensus, so no external feed can change what anything costs.

---

## 1. Where OBS comes from

| Issuance path | Amount | When |
| --- | --- | --- |
| Genesis allocation | exactly **100,000 OBS**, once, ever | to the wallet behind the first protocol-valid mining claim; that wallet simultaneously becomes the treasury |
| Mining rewards | schedule below | per accepted claim, capped by the 21,000,000 OBS supply cap |

That is the complete list. `issue()` accepts only `GENESIS_ALLOCATION` and
`MINING_REWARD`; the supply cap is checked inside the state transition, and
`/audit/compliance` re-confirms at runtime that no other issuance path exists.

### The mining schedule

| Parameter | Value |
| --- | --- |
| Minimum interval between claims by one wallet | 4 hours |
| Maximum claims per wallet per rolling day | 6 |
| Network daily reward at genesis participation | 0.001 OBS |
| Reward per claim at genesis participation | 0.000166666666666666 OBS |
| Active-miner window | a wallet must have registered within 30 days |
| Reduction | 0.5% (50 bps) per 100,000 active miners |
| Absolute daily floor | 0.0002 OBS |
| Claims per wallet per block | 1 |

Eligibility, the reward amount and the claim id are all derived from chain data
(`/mining/schedule`, `/mining/status`, `/mining/claims`). Nothing in the mining
path reads a wall clock, a request header or a client timestamp: the countdown a
page shows is a rendering of protocol time, and a manipulated browser clock
changes what the countdown says and nothing else.

Reward settlement inside a claim is deliberate: **Mining Pool funds are spent
first, and only the remainder is newly issued.** Gas recycled into the pool
therefore pays real rewards before any new OBS is minted.

---

## 2. What things cost

Every price the protocol charges is denominated in OBS and fixed by consensus.
The dollar column that used to exist here is gone because the parameter is gone,
not because it was hidden: no fee and no state transition converts through an
exchange rate.

| Action | Price | Destination |
| --- | --- | --- |
| Gas on any value-bearing transaction | min(0.02% of the amount, 0.01 OBS) | Mining Pool |
| `.obs` name registration | 0.05 OBS | ONS revenue, split 90/10 |
| `.obs` name renewal | 0.05 OBS | ONS revenue, split 90/10 |
| Validator bond | exactly 20,000 OBS (returned in full at unbonding) | locked, not spent |
| Node runner registration | nothing | no transfer exists |

Gas is **never** ONS revenue: it goes to the Mining Pool. The validator bond is
not revenue either — it stays attributable to its owner and is returned in full,
so the supply invariant counts it as locked value rather than income.

### The equivocation penalty

A validator that is proven, with signatures every node can check, to have signed
two conflicting block proposals for one height and round, or two conflicting
finality votes for one anchor, forfeits **half its bond** —
`consensus.equivocationSlashBps = 5000` applied to the validator's own recorded
bond, which is 10,000 of the 20,000 OBS. The penalty is not a number in the
code: it is a consensus parameter applied to a bond, so `slashed + remaining`
always equals the bond exactly, in integers, with nothing rounded and nothing
created.

The slashed seals are credited to the **Mining Pool** in the same state
transition. They are not revenue, they are not burned, they do not go to the
treasury (its share of a slash is exactly zero) and they do not go to the
submitter — total supply is unchanged by a slash, to the seal. The remaining
half stays the validator's own money and is claimable after the ordinary
unbonding delay.

Being offline is **not** slashable. Missing a slot, failing to vote, restarting
or losing the network costs a validator its turns (the missed-slot jail), never
its capital.

Other enforceable limits: maximum 16 KiB per signed transaction, 256-byte memo,
64 out-events per transaction, 240-block expiry window, and a minimum transfer of
one seal (1e-18 OBS).

### Name terms

An `.obs` registration grants ownership for **1 year**, with a 30-day grace
period after expiry before the name returns to the pool.

---

## 3. Where ONS revenue goes

**ONS registration and renewal fees are the protocol's only revenue source.**
They are split **at the moment they are received, inside the state transition,
by every node**:

```
ONS revenue
   ├── 90%  →  Node Runner Reward Pool
   └── 10%  →  protocol treasury wallet (genesis-designated)
```

The arithmetic is `nodePool = floor(total × 9000 / 10000)` and
`treasury = total − nodePool`, so the two parts always add back to the whole.
Flooring the node share is deliberate: the last seal of rounding dust is never
lost — it lands in the treasury — and the split is checked by
`assertSplitInvariant` on every credit.

Nothing else enters this pool: gas funds the Mining Pool, issuance follows the
mining schedule, the genesis allocation is a one-time grant, and bonds are
returned to their owners. `GET /revenue` publishes the classification.

Before the genesis allocation designates a treasury wallet, its 10% is recorded
as `UNCLAIMED_REVENUE`: it is held as an explicit protocol obligation in the
Mining Pool, is **not** anyone's spendable income, and miners cannot spend it.
It is paid to the treasury by the first mining claim that designates one. Since
the genesis allocation goes to the first valid claim, in practice a treasury
exists from the first block that contains a claim.

### When it is paid

| Share | Paid | How to see it |
| --- | --- | --- |
| **Treasury, 10%** | **In the same block as the ONS fee that produced it**, once a treasury wallet is designated. Before that, it is held as an unclaimed obligation and credited by the block that designates the treasury. There is no batch job and no manual step. | `GET /revenue`: `split.treasuryCreditedObs` and `split.treasuryUnclaimedObs`. |
| **Node runners, 90%** | **Once per protocol period (24 hours)**, by the first block after the period closes, to the registered nodes in proportion to the score their recorded evidence earned. Until then it waits in the Node Runner Reward Pool. If no node is registered, the pool is carried forward and paid once nodes register and earn a score. | The next payout time and the time remaining are on the Node and Audit pages and in `GET /revenue` (`timing`). |

Two things commonly mistaken for a missing payment:

* **The treasury wallet is whoever made the first valid mining claim.** Registering a name from that wallet
  costs the whole fee and returns 10% of it, so the fee costs it 90%.
* **The 90% is not in the treasury.** It is in the node-runner pool, and `GET /revenue` shows both
  (`split.nodeRunnerPoolObs` and the full `split.treasuryObs`, credited plus unclaimed) along with the
  treasury wallet's address in full, so the treasury's balance can be looked up the ordinary way and
  checked against what it was credited.

### What is not ONS revenue

User-to-user transfers, mining rewards, gas, validator bonds, node runner bonds,
escrowed balances and treasury spending. The list is enumerated in
`NOT_ONS_REVENUE` and asserted by tests, so a misclassification is a failing
build rather than a slow leak.

### The treasury

The treasury wallet is fixed by the genesis rule — it is the wallet that claimed
the one-time allocation. No administrator can change it, no key the project
holds can spend it, and the only outflow the protocol performs from it is a
`TREASURY GRANT` signed by that wallet, paid out of revenue it was credited.
Once the winning claim is sufficiently buried, operators treat the treasury as
fixed policy, and native finality (see [consensus.md](consensus.md)) makes the
allocation final rather than merely deep.

---

## 4. Node runner rewards

90% of ONS revenue funds the node runner pool, settled once per
closed reward period (24 hours of protocol time). A node's share is computed by
every node from chain data — registration, heartbeats, peer attestations,
produced blocks — and **no operator ever reports a number**:

| Gate or weight | Value |
| --- | --- |
| Minimum verified uptime | 50% (below this a node is scored but earns nothing) |
| Minimum total score | 10% of the maximum |
| Uptime / participation / reliability / responsiveness | 40% / 25% / 20% / 15% |
| Within participation: blocks / peer coverage | 60% / 40% |
| Attestations required (when peers exist) | `min(2, n − 1)` distinct attesters |
| Its own uptime contribution when it has no peers | 50% (bootstrap) |
| Maximum one node may take from a period's pool | 5% |
| Heartbeats accepted per node per period | 1 |
| Fault reports per reporter per period | 8, each corroborated report costing 20% of score |
| Evidence kept | 3 periods; reward-wallet changes take effect after 1 period |
| Minimum time between registration and earning | 1 block |

A node that misses its slots is jailed by consensus (see
[consensus.md](consensus.md) §4) and earns nothing for the periods it was
offline. The detailed mechanism, including how attestations are corroborated
and how payouts are settled exactly once per period, is in
[node-runner-rewards.md](node-runner-rewards.md).

---

## 5. Supply invariant

Locked value counts toward supply while it is locked: validator bonds and node
registration bonds are recorded by the supply invariant even though they are not
spendable. The invariants every node checks
are:

- total issued never exceeds **21,000,000 OBS**;
- total supply equals the sum of all category balances — nothing is created or
  destroyed by a transfer;
- the recorded revenue split always adds back to the revenue received.

Verify on a running node:

```bash
curl -s localhost:8630/supply | jq '{totalSupplyObs, maxSupplyObs, invariantOk}'
curl -s localhost:8630/revenue | jq .                 # ONS revenue and the 90/10 split, from chain data
curl -s localhost:8630/audit/compliance | jq .        # no admin mint, no sale, no native exchange
node scripts/check-invariants.mjs                     # 55 checks; exits non-zero on drift
```

## 6. What deliberately does not exist

- **No premine, no token sale, no foundation allocation.** At height 0 the
  total supply is zero.
- **No admin mint path.** Issuance is the two rules in §1 and nothing else.
- **No native exchange, no order book, no custody.** Price discovery happens on
  external markets; the protocol consumes no price to function.
- **No mining KYC, no paid activation, no withdrawal gate.** Removed mechanisms
  are asserted absent at `/audit/compliance` and in CI on every push.
- **No gas as ONS revenue.** Gas is Mining Pool value and stays there.

Historical note: until protocol 1.2.0 several fees were denominated in dollars
and converted at a protocol oracle median, which meant an oracle outage could
close features. That dependency was removed; the oracle transaction type still
exists so a node can publish an OBS/USD observation for reporting, but no fee
and no state transition reads it.
