# Consensus

This is the reference for **how Obsidian Network decides what happened**. It
covers block validity, fork choice, reorganisation, the validator set and
jailing. The temporal mechanism itself — why this is Proof of Time and not
proof-of-work — is in [proof-of-time.md](proof-of-time.md); the constants quoted
here are defined in `obsidian-core/src/protocol/params.ts` and checked by
`scripts/check-invariants.mjs`.

Everything in this document is a **protocol rule**, not an operator setting.
Changing any of it requires a protocol version bump and a coordinated upgrade:
nodes that disagree about a rule compute a different params hash and refuse each
other during the handshake.

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
believes it is earlier than the chain it holds, so mining claims, capsule locks
and transaction expiry cannot be back-dated to bypass a cooldown. Cooldowns are
enforced by validators against block timestamps, never by an interface
countdown.

---

## 2. Fork choice

When a node holds two branches it compares their tips, in order:

1. **greatest accumulated PoT Weight** — a block's weight is `1 + txCount`, the
   verified state it carries; weight accumulates from genesis;
2. **greatest height** — the most verified time;
3. **lowest header hash** — a fully deterministic tie-break.

There is no "most work" comparison anywhere in the protocol, and no randomness
to grind. The rule name published by every node is
`POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH` (`/params` → `proofOfTime`).

Because step 3 exists, two honest nodes holding the same blocks always agree on
the head. A branch that lags on weight but leads on height loses: time alone
does not win if the competing branch carries more verified state.

---

## 3. Reorganisation

A node reorganises when it learns of a branch that wins fork choice. The
reorganiser is deterministic:

1. find the **common ancestor** with the current canonical chain;
2. replay every block from the ancestor to the new head, recomputing state from
   the common ancestor up (`applyBlock` per block) — no state is trusted from
   the incoming branch;
3. persist the new canonical chain and a checkpoint, then revalidate the
   mempool against the new state.

A reorg deeper than **256 blocks** is refused (`ORPHAN_BLOCK`), not silently
accepted. The cap exists because a 256-block reversal on a 5-second chain is
already far beyond what honest network conditions produce; treating a deeper
replay as ordinary would turn a synchronisation incident into a rewrite of
long-settled history.

There is no finality gadget. Confirmation depths are advisory to interfaces:
12 blocks is "soft" (about a minute) and 64 blocks is what an interface may show
as settled for practical use. Consensus itself always follows the fork-choice
rule above.

---

## 4. Validators

Any account may become a validator. Registration is a `VALIDATOR` transaction
carrying:

| Field | Rule |
| --- | --- |
| bond | at least **50 OBS**, locked from the sender's balance |
| validatorKey | a 33-byte compressed public key |
| commissionBps | 0–10,000 (basis points; purely declarative) |

Bonded OBS leaves the spendable balance and is counted by the supply invariant
while bonded — it is still the validator's property, not protocol revenue.
There is no slashing: the worst a validator loses by being jailed is the rewards
it did not earn while jailed, and the bond itself is returned in full after
unbonding.

**Proposer selection.** The proposer of a height is deterministic:
`activeValidators[height mod activeValidatorCount]`, where the set is sorted by
address and jailed validators are excluded. While **no** validator is
registered, the network is in "genesis open" mode and any node may propose; the
first registered validator closes it. There is no leader election, no committee
and no bribery surface beyond the rotation itself — and a validator never gains
the power to mint, move balances or rewrite history, only to propose.

### Unbonding

`UNREGISTER` marks the validator `UNBONDING` and records the height. The bond
returns only after **20,160 blocks** (about 28 hours at the target spacing) via
`CLAIM_UNBONDED`. Until then the stake cannot be spent, which is what makes a
validator's commitment meaningful without locking funds forever.

### Jailing

Per block, the protocol tracks missed scheduled slots per validator:

- a missed scheduled slot adds 1 to the validator's running counter;
- any block in which the validator is not recorded as missing subtracts 1
  (floor 0), so the counter decays while the validator is responsive;
- crossing **40** net misses jails the validator for **10,080 blocks**
  (about 14 hours) and emits `VALIDATOR_JAILED`;
- when the jail expires the validator returns to `ACTIVE` with a reset counter
  and emits `VALIDATOR_UNJAILED`.

Jailing is height-driven and automatic: no dashboard action, no administrator
and no vote. A jailed validator simply produces no blocks — and earns nothing
from the node runner reward pool for the periods it was offline.

---

## 5. Transactions in consensus

The state machine dispatches exactly one executor per transaction type, and an
unknown type is a hard rejection — never a silent no-op:

| Id | Type | Id | Type |
| --- | --- | --- | --- |
| 1 | `PAYMENT` | 7 | `MINING_CLAIM` |
| 2 | `ONS` | 8 | `VALIDATOR` |
| 3 | `CAPSULE` | 9 | `TREASURY` |
| 4 | `LAND` | 10 | `GOVERNANCE` |
| 5 | `SOCIAL` | 11 | `NODE_REGISTRY` |
| 6 | `ORACLE` | | |

Rules that apply to every type — canonical encoding, nonce ordering, replay
rejection, size and memo limits, gas — are enforced in the state machine before
the executor runs (`obsidian-core/src/blockchain/state-machine.ts`). The
transaction envelope, signing digest and encoding are in
[transaction-format.md](transaction-format.md); the economic parameters those
executors enforce are in [economics.md](economics.md).

---

## 6. Networks and genesis

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

## 7. Verifying these rules on a running node

```bash
curl -s localhost:8630/params | jq .proofOfTime     # consensus identity, fork choice, difficulty
curl -s localhost:8630/pot                          # PoT Difficulty and Time-Rate
curl -s localhost:8630/validators                   # bonds, status, missed slots
curl -s localhost:8630/audit/compliance             # removed mechanisms, all present:false
node scripts/check-invariants.mjs                   # 55 invariants, exits non-zero on drift
```

`/audit/compliance` is the quickest way to confirm that the mechanisms this
document does **not** describe — proof-of-work, a header nonce, admin minting,
KYC-gated mining, a native exchange — remain absent at runtime.
