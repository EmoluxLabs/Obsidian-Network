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
believes it is earlier than the chain it holds, so mining claims, ONS terms
and transaction expiry cannot be back-dated to bypass a cooldown. Cooldowns are
enforced by validators against block timestamps, never by an interface
countdown.

---

## 2. Fork choice and finality

A candidate is considered only if it is protocol-valid and descends from the
node's locally verified finalized checkpoint. Eligible tips are compared in this
order:

1. **greatest accumulated fixed PoT Weight** — every valid block contributes one
   unit; transactions and fees do not add authority;
2. **greatest height**;
3. **lowest header hash** — a total order over otherwise equal candidates, so the
   same two branches resolve the same way on every node, every time.

There is no arrival-order component and no validator-support weighting: equal
weight and equal height are broken by the block hash the producer signed. The
published rule is
`FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH`.

### Native PoT checkpoint finality

Finality supplements Proof of Time; it does not replace block production with
proof of stake. For a target block, every `ACTIVE`, positively bonded validator
in the target's **parent state** has one membership vote. Bond size is admission
collateral only and does not multiply voting weight. Addresses and validator
keys come from the existing on-chain registry and are sorted canonically.

A checkpoint requires `floor(2N/3) + 1` distinct valid signatures. A vote commits
to protocol and network identities, the previous finalized checkpoint, target
height/hash/parent, proposer round and validator-set hash. A certificate is
accepted only after the target block and state transition pass normal validation
and the committee is reconstructed from the target parent. Duplicates, unknown
validators, wrong-network votes, invalid signatures and mismatched committees do
not count.

Two conflicting certificates require more than one third of the relevant
committee to violate the one-vote rule (or a cryptographic failure). This is a
narrow checkpoint-finality claim, **not** a claim that the whole protocol is
generally BFT, immutable, or free of all reorgs.

Open genesis has no committee. Its first certificate is allowed only after a
non-empty validator set remains identical for 64 parent states. After bootstrap,
certificates advance one block at a time. A membership transition is finalized
by the committee from its parent; the following target uses the updated set.

**Where the first committee comes from.** The bootstrap set is a *public,
genesis-committed* list of validator public keys. Every key is hashed into the
`genesisId` (with the network, chain id, protocol version, genesis timestamp and
address prefix), so two nodes compute the same genesis id only if they carry the
same list. The set is therefore not a local opinion, not a secret, and not
something a peer can talk a node into accepting.

The list is a protocol constant in `obsidian-core/src/genesis/bootstrap-keys.ts`:

| Network | Committed keys | Quorum `floor(2N/3)+1` | Notes |
| --- | --- | --- | --- |
| mainnet | 4 | 3 | one validator may be offline. Four is the largest committee the genesis allocation can fund: each operator needs one exact 20,000 OBS bond **plus** the registration gas, and 5 × 20,000.01 = 100,000.05 OBS exceeds the 100,000 OBS allocation while 4 × 20,000.01 = 80,000.04 OBS fits |
| testnet | 3 | 3 | a smaller public test committee |
| staging, devnet | none | — | each operator supplies its own set |

On a network with a committed set, the set is authoritative and cannot be
replaced: passing a different list (config file, `OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS`
or a hand-built genesis document) is a hard startup refusal, because it would
produce a different genesis id while looking like the same network. On staging,
devnet and private chains, operators configure their own list with
`OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS` (comma-separated lowercase compressed
secp256k1 keys) or the matching config field; malformed, duplicated or over-long
lists are refused, not trimmed.

Before the first certificate, only the committed keys may vote, and only if each
one has registered through the ordinary `VALIDATOR` transaction with exactly the
20,000 OBS bond. Extra registrations are excluded until that first checkpoint, so
the bootstrap committee cannot be joined by simply registering.

A network with an **empty** set has no bootstrap committee at all: the node will
not finalize anything until an on-chain validator set has been stable for the
64-parent-state window. It never derives an initial trusted committee from the
fork it happens to hold locally — an empty set means no finality, not
self-appointed finality.

### Equivocation

Nodes retain and gossip bounded cryptographic evidence for one proposer signing
different headers at the same height and round, or one validator signing
incompatible finality targets for the same finalized anchor. Evidence carries
both signed messages and is revalidated before storage or relay. Protocol 1.6.0
adds no slashing or punishment economics.

---

## 3. Reorganisation and recovery

Ordinary reorganisation finds the common ancestor, replays the winning branch,
recomputes state roots, persists the canonical tail and revalidates the mempool.
It is capped at 256 blocks. A valid certificate may adopt its certified branch
beyond that ordinary cap after signatures, committee, ancestry and block
validity checks pass; abandoned-transaction recovery remains bounded.

No reorganisation may fork below the locally finalized height, and no candidate
whose ancestry omits the finalized hash is admitted. A finality certificate may
move the chain onto its certified branch — that is the recovery path for a
partition deeper than the ordinary bound — but only after signatures, committee,
ancestry and full block validation pass, and never below the anchor the
certificate itself extends. Finality state is stored in
a checksummed, atomically replaced file bound to network, chain, genesis,
protocol version and params hash. Startup fails closed if the lock is corrupt,
incompatible, lacks its block, is noncanonical, or has an invalid certificate.
Automated tests simulate process restart and corrupted/missing files; they are
not claims of physical power-loss testing.

The 12/64 confirmation depths remain interface guidance. They are not aliases
for finality: inspect `GET /finality`, status fields and Prometheus metrics for
the locally verified checkpoint.

---

## 4. Validators

Any account may become a validator. Registration is a `VALIDATOR` transaction
carrying:

| Field | Rule |
| --- | --- |
| bond | exactly **20,000 OBS**, locked from the sender's balance |
| validatorKey | a 33-byte compressed public key |
| commissionBps | 0–10,000 (basis points; purely declarative) |

Bonded OBS leaves the spendable balance and is counted by the supply invariant
while bonded — it is still the validator's property, not protocol revenue.
There is no slashing: the worst a validator loses by being jailed is the rewards
it did not earn while jailed, and the bond itself is returned in full after
unbonding.

**Proposer selection.** The proposer of a height is deterministic:

```
round(parent, block)    = max(0, floor((block.timestamp - parent.timestamp) / targetBlockSeconds) - 1)
proposer(height, round) = activeValidators[(height + round) mod activeValidatorCount]
```

where the set is sorted by address and jailed validators are excluded. Round 0
is the ordinary case: the validator whose turn it is has the first ten seconds
after its parent. Each further whole slot (five seconds) hands the turn to the
next validator, cycling through the active set for every later round. Production
never opens to an unregistered key. If every active validator is offline the
chain stops; this intentionally chooses validator-set safety over permissionless
fallback liveness. The round is derived
from two timestamps already committed to the headers, so every node computes it
from the block alone: no extra header field, no round negotiation.

While **no** validator is registered, the network is in "genesis open" mode and
any node may propose; the first registered validator closes it for every round.
There is no auction or random leader election. Active validators also form the equal-membership PoT finality committee; that role does not grant power to mint or move balances, and bond size does not buy extra votes.

**What the schedule is, and is not.** It is a rule about *when* a block may
carry a given validator's name, enforced through timestamps. The proposer schedule itself is not a vote and does not by itself finalize a block. A block may be dated up to `maxFutureDriftSeconds` (60)
ahead of a node's clock, so a validator can claim a later round than real
elapsed time supports — at most `drift / targetBlockSeconds` rounds ahead. A later-round block is still only a candidate: finalized-anchor checks, ordinary validity, authenticated support and certificates decide whether it can become or remain canonical. Obsidian does not claim general Byzantine fault tolerance.

### Unbonding

`UNREGISTER` marks the validator `UNBONDING` and records the height. The bond
returns only after **20,160 blocks** (about 28 hours at the target spacing) via
`CLAIM_UNBONDED`. Until then the stake cannot be spent, which is what makes a
validator's commitment meaningful without locking funds forever.

### Jailing

Per block, the protocol tracks missed scheduled slots per validator:

- when the block that was finally produced belongs to a **later round** than 0,
  the **round-0 proposer** of that height is recorded as having missed its
  slot. Only that one validator is named per block — timestamps can be nudged
  inside the drift window, and blaming every validator the round skipped would
  let a single future-dated block frame several of them;
- a recorded miss adds 1 to the validator's running counter;
- a block the validator **itself produces** subtracts 1 (floor 0). Decay has to
  be earned by producing: an earlier rule, "any block it was not named in",
  could never jail an absent validator in a set of three or more, because an
  absent validator is the round-0 proposer of only one block in *n*;
- crossing **40** net misses jails the validator for **10,080 blocks**
  (about 14 hours) and emits `VALIDATOR_JAILED`;
- when the jail expires the validator returns to `ACTIVE` with a reset counter
  and emits `VALIDATOR_UNJAILED`.

With a single validator that has died, the survivors wait out a round for each
block until it is jailed after 41 blocks; then the validator set is empty,
production is open to everyone, and blocks return to the normal pace.

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
| 6 | `ORACLE` | 9 | `TREASURY` |
|   |   | 10 | `GOVERNANCE` |
|   |   | 11 | `NODE_REGISTRY` |

Ids 3, 4 and 5 belonged to the discontinued Circle (land), Social and Time
Capsule transactions. They are retired: no executor exists for them, and the
state machine rejects them as unknown types.

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
curl -s localhost:8630/finality                     # checkpoint, certificate, evidence
curl -s localhost:8630/audit/compliance             # removed mechanisms, all present:false
node scripts/check-invariants.mjs                   # the invariants; exits non-zero on drift
```

`/audit/compliance` is the quickest way to confirm that the mechanisms this
document does **not** describe — proof-of-work, a header nonce, admin minting,
KYC-gated mining, a native exchange — remain absent at runtime.
