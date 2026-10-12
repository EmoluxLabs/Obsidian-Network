# Consensus and finality: what is assumed, what is tested, and what is not claimed (1.8.1)

**Read this first.** This document is the authors' own analysis of their own protocol. It has **not** been verified by
anyone independent, it is **not** a formal proof, and nothing in the repository should be quoted as "independently
audited" or "formally verified". Where safety cannot be justified from the assumptions below, that is said plainly in
section 7. 1.8.1 changes **no consensus rule**: the protocol is still 1.8.0, the params hash and every genesis id are
unchanged (see [upgrading-1.8.1.md](upgrading-1.8.1.md)).

The rules themselves are in [consensus.md](consensus.md) and [proof-of-time.md](proof-of-time.md). This file states what
those rules *depend on*.

## 1. Model

| Assumption | Why it is needed | What happens if it fails |
| --- | --- | --- |
| **Loosely synchronised clocks.** A block timestamp must be above the median of the last blocks and not further ahead of the validating node's clock than the drift bound; proposer rounds are derived from timestamps (5 s slots). | Proposer rotation, protocol time and mining intervals all read timestamps. | A node with a badly wrong clock rejects honest blocks or proposes in the wrong slot. It does not by itself break safety, but it can stall *that node*. Run NTP/chrony. |
| **Fewer than one third of the finality committee is Byzantine** (`f < N/3`). | Safety of checkpoint finality (section 3). | If `>= N/3` validators double-sign, two conflicting checkpoints can both be certified. The protocol detects and slashes this *after the fact* (equivocation evidence, half of the bond); it does not prevent it. |
| **At least `floor(2N/3)+1` committee members are honest and online.** | Liveness of finality. | Blocks keep being produced, but no new checkpoint is certified until quorum returns. The chain does not finalize wrongly; it stops finalizing. |
| **Bond is the only Sybil resistance.** One validator is one vote. | There is no identity layer. | A well-funded actor holding `k` bonds holds `k` votes (`security-model.md` limitation 11). |
| **A majority of the gate-authority keys is honest and available.** | The gate is a *trusted authority set*, not a consensus participant: a `MINING_CLAIM` needs a certificate from an active gate key. | A majority of stolen keys can mint certificates for any wallet and rewrite the set; a lost majority freezes the set (recoverable only by a new genesis). See [gate-authority.md](gate-authority.md) and [gate-recovery-runbook.md](gate-recovery-runbook.md). This is a **centralisation point by design** and should be described as one. |
| **The genesis id the operator pinned is the right one.** | Bootstrap trust. Everything is checked against it. | A wrong pin joins the wrong network. Nothing in the protocol can tell. |
| **Standard cryptographic assumptions**: secp256k1 signatures are unforgeable, the hash is collision resistant, domain tags are never reused across message types. | Everything. | Everything. |

## 2. Block production and fork choice

* Every valid block adds one unit of PoT weight; fork choice is: descends from the locally finalized checkpoint, then
  greatest accumulated weight, then greatest height, then **lowest header hash**. It is a total order with no
  arrival-order component, so two nodes holding the same two branches pick the same one.
* Because weight is per block (not per stake or work), fork choice alone gives **no economic protection against a
  reorganisation by whoever can produce valid blocks**; the protection is the proposer schedule (only the scheduled
  proposer's block is valid in its round), the 256-block cap on ordinary reorganisation, and finality.
* **Genesis-open mode.** While no validator is registered, any node may propose; the first registered validator closes
  open mode for every round. A brand-new network is therefore unprotected by the schedule until validators register.
* **Before finality, a block is not final.** The 12/64 confirmation depths in the interfaces are guidance, not a
  guarantee.

## 3. Finality

* **Committee.** Every `ACTIVE` validator with exactly the protocol bond in the *parent* state of the target block holds
  one vote; bond size adds no weight. Mainnet's first committee is the 4 keys committed in genesis (quorum 3, one
  validator may be offline); testnet's is 3 keys (**quorum 3, so no validator may be offline**); staging and devnet
  have no bootstrap committee.
* **Quorum.** `floor(2N/3)+1` distinct valid signatures.
* **Safety claim (accountable).** Two conflicting certified checkpoints at the same height require at least
  `2q - N > N/3` validators to have signed both, i.e. a provable offence by more than a third of the committee (or a
  cryptographic failure). The arithmetic is tested for every `N` from 1 to 3000
  (`tests/security/consensus-properties.test.ts`); the *protocol-level* claim rests on the assumptions in section 1.
* **What finality is not.** It is checkpoint finality with a fixed committee per transition, **not** a claim that the
  protocol is generally BFT, that blocks cannot be reorganised before they are certified, or that an honest minority is
  protected from a Byzantine third.
* **Set transitions.** A certificate is checked against the committee reconstructed from the target's parent state, so a
  vote from a validator removed (or not yet added) at that height does not count; the next target uses the updated set.
  `tests/integration/finality.test.ts` covers stale-set, wrong-set and wrong-network votes.
* **Equivocation.** Proposer and vote equivocation produce canonical, order-independent, bounded evidence that is
  gossiped and slashable.
* **Crash recovery.** Finality state is a checksummed, atomically replaced file bound to network, chain, genesis,
  protocol version and params hash; startup fails closed if it is corrupt, incompatible or inconsistent with the chain.
  Tested by simulated restarts and corrupted files; **not** by physical power loss.

## 4. State machine

* The state root is a deterministic function of the ordered blocks. A block that fails any validation step does not
  alter state: the candidate state is built on a copy and committed only after the state root matches.
* Supply is conserved: `verifySupplyInvariant` holds after every accepted block and `/health` returns 500 if it fails.
* Replay protection: per-account nonces, `validUntil`, a chain id in every signed transaction, domain-separated signing
  digests.

## 5. What the tests establish (and the limits of each)

| Property | Evidence | Limit |
| --- | --- | --- |
| Quorum arithmetic: strictly more than 2/3, never more than N, two quorums overlap by more than N/3, a committee with the maximum tolerated faults can still form a quorum, monotone in N, nonsense sizes give no quorum | `consensus-properties.test.ts`, every N in 1..3000 | Arithmetic only. It says nothing about the protocol using the number correctly. |
| Two independent nodes that apply the same blocks reach the same tip, state root and balances; supply is conserved after every step | the same file: 3 seeded runs of 40 random valid and invalid steps | Samples a small transaction mix (payments and claims) on devnet. Not exhaustive. |
| An invalid block (bad nonce, overdraft, gas mismatch, duplicate, expired, uncommitted gate issuer, wrong parent/height/roots/chain id, stripped transactions) leaves root, tip, supply and balances unchanged, **and is refused for the stated reason** (a guard rejects a refusal that was only a state-root mismatch) | same file | Same sample. |
| Conflicting finalized checkpoints refused; no finalization by a stale set; equivocation evidence; restart and corruption handling | `finality.test.ts`, `finality-primitives.test.ts`, `slashing*.test.ts`, `storage-safety.test.ts` | In-process, with fake time. |
| Gate-set rotation, revocation, replay, cross-network approvals, quorum loss, restart, catch-up | `gate-authority.test.ts`, `gate-recovery.test.ts` | In-process. |
| Genesis determinism and identity | `network-manifest.test.ts`, `genesis` tests, `scripts/check-invariants.mjs` | Pins the ids in this repository. |
| Version compatibility | `MIN_CORE_VERSION`, hello-message checks, snapshot format 5 | A 1.7.x node is refused on 1.8.0 networks by design. |

## 6. Review of the parts you asked about

| Area | Finding |
| --- | --- |
| Proposal and ordering | One scheduled proposer per round; proposals outside their round are invalid; same-round equivocation is evidence. |
| Fork choice | Total order, deterministic. Weak against a block-producing adversary on its own (section 2); relies on the schedule and finality. |
| Validator admission and removal | Exact bond, ordinary `VALIDATOR` tx; the bootstrap committee is genesis-committed and excludes extra registrations until the first checkpoint; unbonding and jailing are in `consensus.md`. |
| Partitions | The minority side cannot finalize; on heal the finalized branch wins (nodes refuse to reorganise below the finalized height). A partition deeper than 256 blocks is refused by ordinary reorganisation and recoverable only via a certificate. Not exercised on a real network. |
| Epochs | Gate epochs are strictly sequential; finality has no epochs (a checkpoint extends the previous one). |
| Replay | Nonces, chain id, `validUntil`, domain tags; gate approvals bind network, chain, epoch and exact change. |
| Genesis determinism | The id hashes network, chain id, protocol version, timestamp, address prefix, the bootstrap committee and the gate keys. |
| Checkpoint crash recovery | Atomic, checksummed; fails closed. |
| Version compatibility | Protocol version is part of the genesis id and every vote; mixed versions do not join. |

## 7. Where safety cannot be justified from what is here

1. **Liveness on testnet.** A 3-validator committee with quorum 3 stops finalizing if any single validator is down.
   That is a property of the chosen parameters, not a bug, but it is not fault tolerant.
2. **Pre-finality reorganisations** are bounded (256) but possible; applications must wait for finality for value.
3. **A Byzantine third** breaks the finality guarantee (accountably, but after the damage).
4. **A funded actor can buy a quorum** (bond is the only barrier) and the genesis allocation limits mainnet's committee to
   four.
5. **The gate authority is a trusted party.** Its compromise or loss is outside what consensus can repair.
6. **No hostile-network test.** No eclipse, no sustained adversarial peer campaign, no real partition soak.
7. **No independent review, no formal model.** Section 5 is sampling and unit testing by the authors.

Because of 7, **no claim of independent verification is made**. If you need one, commission a review of
`src/consensus`, `src/blockchain` and `src/transactions/executors` against this document.

## 8. Changing the protocol

A consensus-visible change must (a) bump `PROTOCOL_VERSION` and the params hash, (b) change the genesis id for any
network that adopts it, (c) raise `MIN_CORE_VERSION`, (d) ship a migration or an explicit "new network" statement in the
upgrade notes, and (e) update this file. `tests/scripts/repo-consistency.test.mjs` and `scripts/check-invariants.mjs`
fail the build if the pieces disagree.
