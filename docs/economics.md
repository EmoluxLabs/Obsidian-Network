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
| `.obs` name registration | 0.05 OBS | qualifying platform revenue |
| `.obs` name renewal | 0.05 OBS | qualifying platform revenue |
| Business page activation | 0.005 OBS | qualifying platform revenue |
| Land protocol purchase / buyback | the division's GLV, bounded to 0.01–5 OBS per m² | purchase: qualifying platform revenue; buyback: treasury → owner |
| Capsule commitment | at least 0.0001 OBS | Mining Pool |
| Capsule Time Travel preview | 1000× the commitment, once per capsule per account for 30 s | Mining Pool |
| Validator bond | at least 50 OBS (returned in full at unbonding) | locked, not spent |
| Node runner registration bond | 100 OBS (returned in full at deregistration) | locked, not spent |

Gas is **never** platform revenue: it goes to the Mining Pool. A buyback is not
revenue either — it is the treasury paying an owner, and it is only permitted
when the protocol land reserve can fund it. Tips are 100% creator; nothing is
taken from them.

Other enforceable limits: maximum 16 KiB per signed transaction, 256-byte memo,
64 out-events per transaction, 240-block expiry window, and a minimum transfer of
one seal (1e-18 OBS).

### Name terms and capsule locks

An `.obs` registration grants ownership for **1 year**, with a 30-day grace
period after expiry before the name returns to the pool. A capsule locks for at
least one hour and at most 100 years; at its unlock time the commitment moves to
the Mining Pool **by state transition**, with no action required from the
creator, even if the creator is offline forever.

### Land

Every protocol parcel is **1 m², one parcel per transaction**. A protocol
purchase raises the division GLV by 0.25% and a buyback lowers it by 0.25%;
marketplace sales at the owner's asking price never move the GLV. A buyer is
never retroactively repriced — the purchase price is the GLV at that moment, and
that is the price the client must quote to be accepted. Full mechanics are in
[circle.md](circle.md).

---

## 3. Where platform revenue goes

Qualifying platform revenue — ONS registration and renewal, business page
activation, land protocol sales and an explicit treasury payment signed by a
platform wallet — is split **at the moment it is received, inside the state
transition, by every node**:

```
qualifying platform revenue
   ├── 40%  →  Node Runner Reward Pool
   └── 60%  →  protocol treasury wallet (genesis-designated)
```

The arithmetic is `nodePool = floor(total × 4000 / 10000)` and
`treasury = total − nodePool`, so the two parts always add back to the whole.
Flooring in favour of the treasury is deliberate: the last seal is never lost,
and the treasury is the account that pays it back out through land buybacks.

Before the genesis allocation designates a treasury wallet, qualifying revenue
is recorded as `UNCLAIMED_REVENUE`: it is held as protocol value in the Mining
Pool and **not** treated as anyone's income. Once the designation exists, the
recorded source decides its destination.

### What is not platform revenue

User-to-user transfers, mining rewards, capsule commitments and Time Travel
payments, gas, validator bonds, marketplace sale proceeds, tips and escrowed
balances. The list is enumerated in `NOT_PLATFORM_REVENUE` and asserted by
tests, so a misclassification is a failing build rather than a slow leak.

### Creator monetisation

Where a creator monetises (10,000 followers and 100,000 monthly views are the
eligibility thresholds), the split is **70% to the creator, 30% to the network**.
The network's 30% share is qualifying platform revenue and enters the 40/60
split above like any other source.

### The treasury

The treasury wallet is fixed by the genesis rule — it is the wallet that claimed
the one-time allocation. No administrator can change it, no key the project
holds can spend it, and the only outflow the protocol performs from it is a land
buyback. This is why the first claim is treated as irreversible in
[mainnet-launch.md](mainnet-launch.md).

---

## 4. Node runner rewards

40% of qualifying platform revenue funds the node runner pool, settled once per
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

Locked value counts toward supply while it is locked: capsule commitments,
validator bonds and node registration bonds are recorded by the supply
invariant even though they are not spendable. The invariants every node checks
are:

- total issued never exceeds **21,000,000 OBS**;
- total supply equals the sum of all category balances — nothing is created or
  destroyed by a transfer;
- the recorded revenue split always adds back to the revenue received.

Verify on a running node:

```bash
curl -s localhost:8630/supply | jq '{totalSupplyObs, maxSupplyObs, invariantOk}'
curl -s localhost:8630/revenue | jq .                 # sources and the 40/60 split, from chain data
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
- **No gas as platform revenue.** Gas is Mining Pool value and stays there.

Historical note: until protocol 1.2.0 several fees were denominated in dollars
and converted at a protocol oracle median, which meant an oracle outage could
close features. That dependency was removed; the oracle transaction type still
exists so a node can publish an OBS/USD observation for reporting, but no fee
and no state transition reads it.
