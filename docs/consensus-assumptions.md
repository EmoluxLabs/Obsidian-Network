# Consensus and finality: what is assumed, what is tested, and what is not claimed

**Read this first.** This document is the authors' own analysis of their own protocol. It has **not** been verified by
anyone independent, it is **not** a formal proof, and nothing in the repository should be quoted as "independently
audited" or "formally verified". Where safety cannot be justified from the assumptions below, that is said plainly in
section 6. Protocol 1.9.0 is a fresh start: it has no validators, bonds or votes (see [upgrading-1.9.0.md](upgrading-1.9.0.md)).

The rules themselves are in [consensus-v1.9.0.md](consensus-v1.9.0.md), [finality-v1.9.0.md](finality-v1.9.0.md),
[consensus.md](consensus.md) and [proof-of-time.md](proof-of-time.md). This file states what those rules *depend on*.

## 1. Model

| Assumption | Why it is needed | What happens if it fails |
| --- | --- | --- |
| **Loosely synchronised clocks.** A block timestamp must be above the median of the last blocks and not further ahead of the validating node's clock than the drift bound; producer rounds are derived from timestamps (5 s slots). | Producer rotation, protocol time, reward periods and mining intervals all read header timestamps. | A node with a badly wrong clock rejects honest blocks or produces in the wrong slot. It does not by itself break safety, but it can stall *that node*. Run NTP/chrony. |
| **Fewer than one third of the established producers are faulty** (`f < n/3`). | Safety of checkpoint finality ([finality-v1.9.0.md](finality-v1.9.0.md) section 5). | A third or more can stall finality or build on both sides of a fork. Nothing is bonded, so nothing is confiscated: the protocol does not punish building on two branches. |
| **At least three established producers, and two thirds of them online.** | Finality is only available with `n >= 3` and needs `floor(2n/3)+1` distinct producers. | Blocks keep being produced, but nothing new is called final. The chain does not finalize wrongly; it stops finalizing. |
| **Registration is rate-limited and delayed, not priced.** | There is no identity layer and no deposit. | A patient actor with many machines can register many nodes and reach a third (or a majority) of the producer set. The protocol cannot tell one operator with ten nodes from ten operators. |
| **A majority of the gate-authority keys is honest and available.** | The gate is a *trusted authority set*, not a consensus participant: a `MINING_CLAIM` needs a certificate from an active gate key. | A majority of stolen keys can mint certificates for any wallet and rewrite the set; a lost majority freezes the set (recoverable only by a new genesis). See [gate-authority.md](gate-authority.md) and [gate-recovery-runbook.md](gate-recovery-runbook.md). This is a **centralisation point by design** and is described as one. |
| **The genesis id the operator pinned is the right one.** | Bootstrap trust. Everything is checked against it. | A wrong pin joins the wrong network. Nothing in the protocol can tell. |
| **A node that was offline for long obtains a recent checkpoint from a source it trusts** (weak subjectivity). | A branch that contains the finalized prefix is accepted. | An eclipsed, long-offline node can be fed a false history. The protocol cannot supply that proof. |
| **Standard cryptographic assumptions**: secp256k1 signatures are unforgeable, the hash is collision resistant, domain tags are never reused across message types. | Everything. | Everything. |

## 2. Block production and fork choice

* The producer for a block is a pure function of the parent state and two header timestamps; only the scheduled producer's
  block is valid in its round (`NOT_PRODUCER_TURN` otherwise). There is no vote, no administrator and no central scheduler.
* Every valid block adds one unit of PoT weight; fork choice is: contains the locally finalized checkpoint, then greatest
  accumulated weight, then greatest height, then **lowest header hash**. It is a total order with no arrival-order
  component, so two nodes holding the same two branches pick the same one.
* Because weight is per block (not per stake or work), fork choice alone gives **no economic protection against a
  reorganisation by whoever holds enough of the producer set**; the protection is the schedule, the 256-block cap on
  ordinary reorganisation, the equivocation ban, and finality.
* **Open start.** On a fresh chain nobody is registered yet, so any key may produce the first blocks until the first
  registration; after that only registered nodes may. A brand-new network is therefore unprotected by the schedule for its first
  moments, and the producer set stays small (and easy to capture) until more nodes register.
* **Before finality, a block is not final.** The 12/64 confirmation depths in the interfaces are guidance, not a guarantee.

## 3. Finality

* **Rule.** A block `h = H - W` is final when at least `floor(2n/3)+1` distinct established producers (those that were mature
  at `h`) produced blocks above it within the window `W = clamp(3n, 32, 1024)`, and `n >= 3`. It is computed in the state
  machine and committed in the state root: another node cannot disagree without disagreeing about the block.
* **Safety claim.** Two conflicting final blocks need more than `n/3` producers to have built on both branches. The quorum
  arithmetic is tested for every `n` from 1 to 3000 (`tests/security/consensus-properties.test.ts`); the *protocol-level* claim
  rests on the assumptions in section 1.
* **What finality is not.** It is checkpoint (economic) finality, **not** a claim that the protocol is generally BFT, that
  blocks cannot be reorganised before they are final, that a producer is punished for building on two branches, or that an
  honest minority is protected from a faulty third.
* **A single node never finalizes**, and neither do two of three; a partition without two thirds of the producers finalizes
  nothing (`tests/integration/finality.test.ts`).
* **Crash recovery.** The checkpoint is part of the state; it is re-derived on replay and never regresses. Tested by simulated
  restarts and corrupted files; **not** by physical power loss.

## 4. State machine

* The state root is a deterministic function of the ordered blocks. A block that fails any validation step does not alter
  state: the candidate state is built on a copy and committed only after the state root matches.
* Supply is conserved: `verifySupplyInvariant` holds after every accepted block and `/health` returns 500 if it fails.
* Replay protection: per-account nonces, `validUntil`, a chain id in every signed transaction, domain-separated signing
  digests; node statements are bound to a window or period.

## 5. What the tests establish (and the limits of each)

| Property | Evidence | Limit |
| --- | --- | --- |
| Quorum arithmetic: strictly more than 2/3, never more than n, two quorums overlap by more than n/3, monotone in n | `tests/security/consensus-properties.test.ts`, every n in 1..3000 | Arithmetic only. |
| Producer schedule: open start, maturity, registration-order independence, churn, skipped slot, suspension, recovery, timestamp rejection, duplicate blocks, tie-break | `tests/security/producer-schedule.test.ts` | In-process, fake time. |
| Finality: unavailable below three producers, advances only with three, a single producer and two of three cannot finalize, an independent replay computes the same checkpoint, restart, a branch omitting the finalized block is refused | `tests/integration/finality.test.ts` | In-process. |
| Equivocation ban and report forgery | `tests/security/equivocation-ban.test.ts` | In-process. |
| Two independent nodes that apply the same blocks reach the same tip, state root and balances; invalid blocks leave no trace and are refused for the stated reason | `consensus-properties.test.ts` (3 seeded runs of 40 random steps; targeted shapes) | Samples a small transaction mix on devnet. Not exhaustive. |
| Three separate OS processes on one host registered, produced, agreed and finalized; one was restarted and resumed | the procedure in [upgrading-1.9.0.md](upgrading-1.9.0.md), `scripts/verify-agreement.mjs` | One host, no hostile network, no real partition. |
| Gate-set rotation, revocation, replay, cross-network approvals, quorum loss, restart, catch-up | `gate-authority.test.ts`, `gate-recovery.test.ts` | In-process. |
| Genesis determinism and identity; an incompatible or older protocol version is refused | `tests/integration/genesis-fresh-start.test.ts`, `tests/security/protocol-identity.test.ts`, `tests/integration/p2p.test.ts`, `scripts/check-invariants.mjs` | Pins the ids in this repository. |

## 6. Where safety cannot be justified from what is here

1. **Sybil.** Admission is not priced. A third of the established producers is enough to stall finality, and more than a
   third to attack it; an actor with many machines can get there slowly.
2. **A fresh network** has few producers; with fewer than three, finality does not exist at all.
3. **Pre-finality reorganisations** are bounded (256) but possible; applications must wait for finality for value.
4. **No punishment for building on two branches**, only for two blocks on one parent.
5. **The gate authority is a trusted party.** Its compromise or loss is outside what consensus can repair.
6. **No hostile-network test.** No eclipse, no sustained adversarial peer campaign, no real partition soak.
7. **No independent review, no formal model.** Section 5 is sampling and unit testing by the authors.

Because of 7, **no claim of independent verification is made**. If you need one, commission a review of `src/consensus`,
`src/blockchain` and `src/transactions/executors` against this document.

## 7. Changing the protocol

A consensus-visible change must (a) bump `PROTOCOL_VERSION` and the params hash, (b) change the genesis id for any network
that adopts it, (c) raise `MIN_CORE_VERSION`, (d) ship a migration or an explicit "new network" statement in the upgrade
notes, and (e) update this file. `tests/scripts/repo-consistency.test.mjs` and `scripts/check-invariants.mjs` fail the build
if the pieces disagree.
