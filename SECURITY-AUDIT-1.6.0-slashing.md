# Obsidian Network 1.6.0 — validator slashing: hardening report and adversarial review

**Scope.** The validator-evasion path in the slashing mechanism shipped in this
release: the exact-20,000-OBS validator bond, `consensus.equivocationSlashBps`,
the `SLASH` transaction (type 12) and the state transition it runs, the evidence
window, the single registration bond, and the Sybil weight of a validator seat.

**What this document is.** A build report written by the change itself, with the
tests that lock every claim down. It is **not** an independent audit: no third
party reviewed this code, and nothing here should be read as a cryptographic
review. Section I lists what remains open, including that.

**Numbering.** The mandate listed Findings 1–4 and 11 to be fixed. Finding 1
(escaping the penalty by unregistering) and Finding 11 (Sybil weight of an
equal-membership committee) are identified by their subject matter; items **H2**,
**H3** and **H4** below are the defects the mandated inspection actually found in
the shipped path, each stated as "what an attacker gets today", so a reader can
compare them against the audit's wording directly.

---

## A. Files changed

| File | Change |
| --- | --- |
| `obsidian-core/src/blockchain/state.ts` | `slashTenure()` + `offenceChargesToCurrentRegistration()` (the liability window, read from committed state only); `applyEquivocationSlash()` now refuses a charge that falls outside the bonded registration's tenure instead of requiring status `ACTIVE` |
| `obsidian-core/src/consensus/slash-evidence.ts` | the verifier's status gate became the tenure gate; header contract documents the window and the two consequences (no escape by leaving, no charge into a fresh registration) |
| `obsidian-core/src/blockchain/chain.ts` | `checkGossipedTransaction()` refuses a `SLASH` body that cannot decode, so relaying undecodable evidence is a peer fault instead of free work |
| `obsidian-core/src/rpc/server.ts` | `/validators` returns a bounded page of the slash ledger (`slashing.count` = exact total, `slashing.shown` = page size) |
| `obsidian-core/tests/security/slashing.test.ts` | the escape, tenure, claim-boundary, re-registration, jail-liability, gossip, poisoning and Sybil tests; the vote template now casts votes inside the accused validator's tenure |
| `obsidian-core/tests/security/rpc-contract.test.ts` | asserts the bounded page on the public surface |
| `docs/consensus.md`, `docs/security-model.md`, `docs/api.md`, `CHANGELOG.md` | the window, the claim boundary and the bounded response, stated where operators read them |

Source and test diff: 387 insertions, 29 deletions across 10 files, plus this
document. No consensus parameter was added, removed or changed: `paramsHash`
stays `4a2883b2…`, so this is a rule-tightening inside the existing 1.6.0
identity, not a new chain — and the release archives are rebuilt from the same
source commit by the packaging gate.

## B. Slashing architecture

**B1 — A transaction, not an endpoint.** The penalty is applied by a `SLASH`
transaction inside the state transition. No RPC, no dashboard, no node-local
decision can slash anyone: an operator that never upgrades, never reads the API
and never talks to anyone still reaches the same verdict, because the verdict is
the block. `verifyEquivocationEvidence()` recovers the offender, the amount, the
round and the destination from the evidence and consensus state alone — a
submitter names nothing and gains nothing (the tests submit from wallets that
have never held a seal).

**B2 — Only two things are slashable.** Proposer equivocation (one validator
signed two different block headers for the same height *and the same round*) and
finality-vote equivocation (two conflicting `POT_FINALITY` votes for one anchor,
the same conflict rule the node's own admission path uses). Being offline,
missing a slot, failing to vote, restarting, losing connectivity, or voting twice
for the *same* block is never slashable — that is the miss-slot jail, which costs
time, not capital. The proposer evidence carries both parent headers bound by
`child.prevHash === blockHash(parent)`, so the round cannot be manufactured.

**B3 — Liability is a window (the Finding-1 fix).** The offence is charged to the
**registration**, not to the address: it must fall inside
`[registeredAtHeight, unbondingStartHeight]` of the record that holds the bond
now. Consequences:

* an `UNBONDING` or `JAILED` registration is still liable for its whole tenure —
  `activeValidators()` drops it from the rotation immediately, but its bond is
  still escrowed, so unregistering only starts the clock on how long the evidence
  has to arrive. Before this change, a validator could equivocate, send
  `UNREGISTER` and be unpunishable for the rest of the unbonding delay, then
  claim the whole 20,000 OBS: the penalty was optional for anyone who acted
  quickly;
* a fresh registration is never charged for an earlier tenure, so re-registering
  the same key cannot drag an old offence into a new bond — the mirror image of
  the same defect, and the reason a griefer cannot punish an operator twice for
  one crime;
* the window closes when the remainder is claimed. The record is gone, evidence
  about it is refused with `NOT_FOUND`, identically on every node. The unbonding
  delay is therefore the protocol's evidence window: **20,160 blocks**.

The window is computed from consensus state only (`registeredAtHeight`,
`unbondingStartHeight`, `status`) — all of them already committed in the state
root — so a node replaying from genesis derives the same window as the node that
watched the offence happen. No historical block, no committee reconstruction and
no retained checkpoint is needed, which is what makes the verifier safe for a
node that syncs after the fact.

**B4 — Forgery resistance.** Both signatures must verify under the finality
signature domain; both must belong to the same key; the key must control the
address the evidence names *and* be the key the current registration recorded;
the network id, chain id, genesis id, protocol version and params hash must be
the running node's; proposer evidence must be canonical (`rebuilt.id === id`)
with parents bound by hash and PoT weight; vote evidence must agree on the anchor
and the validator-set hash and differ in the target block. Altered, truncated,
cross-network, cross-chain, cross-genesis, cross-parameters, future-height,
stranger and non-conflicting evidence are all refused — asserted field by field
and value by value in `refuses a mutated vote evidence blob for every field and
every junk value`, `refuses cross-network, cross-chain, cross-genesis and
cross-rule evidence` and `refuses malformed bodies, unknown operations,
out-of-band gas and unsigned senders`.

**B5 — Exactly one slash per registration.** `state.s.slashes` is keyed by the
canonical evidence id and lives in the state root; the record's status becomes
`SLASHED` and its `slashEvidenceId` is recorded. A replay — another block,
another peer, ten more submitters, a restart — finds the ledger or the status and
is refused. A second, genuinely *different* equivocation by the same registration
is refused too: one registration is slashed once.

**B6 — The offender leaves immediately.** A slashed validator is gone from the
rotation and from the finality committee in the block that applied the evidence
(`activeValidators()` skips `SLASHED`), with no restart and no operator action. The
surviving half is claimed through the ordinary `CLAIM_UNBONDED` path after the
ordinary delay, and re-registering requires a fresh full bond — the remainder is
never a discounted seat.

**B7 — The honest validator cannot convict itself.** A proposer signs at most one
proposal per (height, round), and the slot is written to the crash-safe safety
lock **before** the signature exists, so a rejected block, a crash or a restart
leaves the slot closed. A later round of the same height is a different slot and
stays available.

**B8 — Error codes are part of the contract.** `NOT_FOUND` (no such validator, or
a claimed registration), `REPLAY` (already slashed, or a pair that does not
conflict), `UNAUTHORIZED` (offence outside the current registration's tenure),
`VALIDATOR_BOND_MISMATCH`, `BAD_SIGNATURE`, `VERSION_MISMATCH`, `WRONG_CHAIN_ID`,
`MALFORMED`, `NOT_YET_VALID`. All of them are deterministic from the block and
the state, so two nodes never disagree about *why* a slash was refused.

## C. Economics: nothing is created, nothing is destroyed

* `consensus.validatorBond` = 20,000 OBS exactly; `consensus.equivocationSlashBps`
  = 5,000; the penalty is `bond × bps / 10_000` in integer arithmetic, so a
  proven offence costs exactly 10,000 OBS and leaves 10,000 OBS held by the
  validator. No amount is hard-coded in the executor: the ratio is hash-committed
  (`paramsHash`), and `slashAmountFor()` is exercised over a thousand random bonds
  (`derives exactly half for a thousand random bonds, never a rounded or invented
  amount`).
* `slashAmount + remaining == bondBefore` is re-checked in the state transition
  (`slashSumsBack`), so a verifier that ever produced a non-splitting amount
  cannot move value.
* The penalty is credited to the **Mining Pool** in the same transition
  (`poolInflow`), never to the treasury, never to ONS revenue, never to the
  submitter. `treasuryShareObs` is published as `'0'`.
* Every slash test asserts `beforeTotalSupply == afterTotalSupply`,
  `poolDelta == BOND / 2`, `metrics.totalTreasuryRevenue` unchanged,
  `nodeRewards.unclaimedRevenue` unchanged and
  `verifySupplyInvariant().ok === true`, including the unbonding and the
  re-registration cases. The bonded half is still the validator's own property:
  when it is claimed, supply is unchanged again.

## D. The 100 OBS node-runner bond is gone as a mechanism

The obsolete `nodeRewards.registrationBond` (100 OBS) is not set to zero — it is
deleted: no parameter, no executor check, no ledger, no state-root field, no RPC
field, no UI copy, no document. The protocol has exactly one registration bond,
the validator's 20,000 OBS, enforced in one place. A sweep for
`NODE_BOND_REQUIRED|lockNodeBond|releaseNodeBond|bondedSeals|registrationBond`
across `*.ts`, `*.mjs`, `*.md` and `*.json` (excluding build output) returns only
the assertions *that the identifier is absent*: `CHANGELOG.md`,
`tests/security/rpc-contract.test.ts`, `tests/security/slashing.test.ts` and
`scripts/check-invariants.mjs`. The economic-invariant script asserts the absence
on every run.

## E. Regression audit: the earlier fixes still hold

| Fix | Where it lives now | Evidence |
| --- | --- | --- |
| ON-06 durable write before in-memory publication | `chain.connectBlock()` (`putBlock` → state/events → canonical/checkpoint → `this.state` → `emit('block')`), plus the double-sign lock written before the signature | `tests/security/slashing.test.ts` restart tests, `tests/unit/storage-safety.test.ts` |
| ON-07 validator sender/key/address binding | `executeValidator(REGISTER)` requires `validatorKey` to control `tx.sender`; the slash verifier requires the signing key to be the registered key | `slashing.test.ts` (forged signer, address mismatch), `tests/security/protocol-security.test.ts` |
| ON-08 `maxEventsPerTx` (64) | `applyTransactions` compares `takeEvents()` against the bound before the transaction is kept | `tests/unit/event-limits.test.ts` |
| ON-09 RPC slowloris/resource hardening | body ceiling (`MAX_BODY_BYTES`), rate buckets, exact-route allowlist; the slash endpoint now also returns a bounded page | `tests/security/rpc-hardening.test.ts`, `rpc-contract.test.ts` |
| ON-10 dependency security | pinned lock files, `npm audit --audit-level=moderate` in CI for both packages | CI `core`/`interface` jobs |
| secp256k1 compact / low-S / RFC-6979 | `src/crypto/*` | `tests/unit/crypto-and-amounts.test.ts` |
| 40/60 mining accounting, 21M cap, ONS 90/10 | `src/mining/*`, `src/economy/*` | `tests/unit/mining-schedule.test.ts`, `node-rewards.test.ts`, `scripts/check-invariants.mjs` (46 checks) |
| Finality persistence + finalized-history reorg protection | `FinalityStore`, `chain.reorganise()` | `tests/integration/finality.test.ts`, `slashing.test.ts` reorg tests |
| Bounded P2P queues, network isolation, genesis identity binding | `src/networking/p2p.ts`, `genesis/bootstrap-keys.ts` | `tests/unit/networking-hardening.test.ts`, `tests/e2e/networks.test.mjs` |

The `/validators` page bound and the gossip body check are the only surfaces this
change touches; neither is a consensus rule (the gossip check is a peer-policy
filter and the page bound is an HTTP shape), so no previously passing consensus
test changes meaning.

## F. Finality after the change

* Quorum stays **equal-membership**: `floor(2n/3) + 1` distinct validators, one
  vote per address. Slashing does not introduce vote weight, delegation or
  stake-weighting, and this change adds none.
* Fork choice is untouched: finalized anchor, then fixed PoT weight, then height,
  then the lowest canonical hash. A slash changes the active set, which changes
  who may propose, not how branches are compared.
* The committee loses a slashed validator in the same block; because the vote
  rule needs two thirds of the *current* committee, removing a misbehaving member
  can only make a conflicting certificate harder, never easier.
* A validator that has left the committee cannot influence finality afterwards:
  the ordinary admission path checks eligibility against the parent state's
  committee, so a claimed validator's later votes are rejected by every honest
  node even though the slashing path no longer knows the record.

## G. Sybil analysis

**What a seat costs.** Exactly 20,000 OBS, one seat per account (a second
`REGISTER` from the same address is refused), locked for an unbonding delay of
20,160 blocks, with a fee-less and permissionless registration — and `20,001` or
`19,999` OBS is refused just as firmly as zero. Weight is therefore linear in
capital with no way to buy more than one vote per bond, and no way to reuse a
bond across accounts: `N` seats cost `N × 20,000` OBS plus `N` wallets, asserted
by `gives one account one seat: extra weight costs another wallet and another
full bond` and the 19,999/20,000/20,001 sequence.

**What a funded adversary can do.** With one third of the seats it can stall
finality (a vote needs two thirds) and, with the proposer rotation, delay blocks.
That is a liveness cost, paid at 20,000 OBS per seat, and it is the standard
property of any two-thirds quorum — including a stake-weighted one, where the
same fraction of capital buys the same power. Switching to stake weighting would
not remove this; it would only hide it behind a balance instead of a count.

**What it cannot do.** Rewrite finalized history (finalized blocks are protected
in the reorganiser); mint, burn or move someone else's funds (no such path
exists, and the supply invariant is asserted on every run); slash an honest
validator (that needs two signatures by the victim's own registered key); take
another validator's bond (the slash is charged to the offender's own record);
profit from a slash (the proceeds go to the Mining Pool, and the submitter gains
nothing).

**Why the price is not paid later.** An attacker who equivocates loses half the
bond *per proven offence*, and a slashed seat must be replaced with a fresh full
bond — the 10,000 OBS remainder cannot be re-used as a seat. The economics of
farming the rotation therefore require real capital, forfeitable on proof.

**Mitigations added or asserted here:** the escape window is closed (H1/H2), the
tenure bound prevents punishing a fresh registration (H3), the exact bond and
one-account-one-seat rules are asserted rather than assumed, and the quorum's
count semantics are pinned by a test. **Not mitigated, by design:** an adversary
that can fund a third of the seats can halt finality. That is documented rather
than papered over (section I), because changing it means changing the quorum, and
the mandate forbids that.

## H. Tests

Run against this tree (`obsidian-core`), all green:

| Suite | Result |
| --- | --- |
| `tests/security/slashing.test.ts` | 35 passed (35), including the escape, tenure, claim-boundary, re-registration, jail, gossip, poisoning and Sybil cases |
| `obsidian-core` full suite | 425 passed, 11 skipped (436) — 26 files |
| `npm run typecheck` (source + tests) | clean |
| `scripts/check-invariants.mjs` | 46/46 invariants hold |
| `tests/scripts/repo-consistency.test.mjs` | 29 passed (29) |
| `obsidian-interface` build | 9 site shells written |
| packaging gate | see `releases/RELEASE-NOTES-1.6.0.md`: core, interface, edge worker, signing, soak, invite, repo consistency, three-node cluster E2E and the four-network isolation/ecosystem/helper/Termux suites, then archive build and `sha256sum -c` |

The specific guarantees the mandate listed are covered as follows:

| Requirement | Test |
| --- | --- |
| 19,999 rejected / 20,000 accepted / 20,001 rejected | `keeps the validator bond exact` |
| no second bond mechanism | `publishes no node-runner registration bond in consensus parameters` |
| full proposer-equivocation sequence | `slashes exactly half the bond into the mining pool …` |
| full vote-equivocation sequence | `slashes a validator that signs two conflicting votes for one anchor` |
| forged evidence: wrong key, hash, height, round, network, chain, genesis, set hash, address, duplicate, non-conflict | `forged and altered evidence cannot slash anyone`, `refuses a pair that is not a conflict` |
| cross-network and cross-chain replay | `refuses cross-network, cross-chain, cross-genesis and cross-rule evidence` |
| replay ×2/×10/other submitters/restart = exactly one slash | `slashes once for twelve submissions …`, `remembers the slash across a restart …` |
| unregistration does not escape the penalty | `does not let an unregistration escape the penalty …` |
| a claimed registration is closed | `is closed once the remainder is claimed …` |
| a fresh registration is not charged for an old tenure | `refuses evidence that predates the registration …`, `a fresh registration with the same key …` |
| offline behaviour is not slashable (and the jail shelters nothing) | `never slashes for going offline …` |
| reorg: canonical vs non-canonical | `keeps a losing slash entirely out of canonical state`, `applies a reorged-in slash exactly once …` |
| restart persistence | `remembers the slash across a restart and still refuses the replay` |
| accounting invariants | every slash test asserts supply, pool delta, treasury delta and the supply invariant |
| spam: undecodable bodies refused at gossip, inapplicable slash dropped by the producer, no displacement of paid work | `refuses an undecodable slash body at gossip …`, `is dropped by a producer instead of poisoning a block …`, `tests/unit/mempool-security.test.ts` |
| Sybil: one seat per account, exact bond, count-based quorum | `counts one seat as one vote …`, `gives one account one seat …` |
| fuzz / property | `derives exactly half for a thousand random bonds …`, `refuses a mutated vote evidence blob for every field and every junk value` |

## I. Remaining risks and honest limits

1. **The evidence window is the unbonding delay (20,160 blocks).** After the
   remainder is claimed, a proven offence cannot be charged — the protocol holds
   no bond to take and will not claw back a paid-out balance. Reporting is free
   and permissionless, and evidence survives in each node's finality store
   (bounded at 256 records), but the guarantee is a window, not eternity. A
   longer unbonding delay is the only way to lengthen it.
2. **No independent review.** This work was written and tested by the same author
   as the code it reviews. No external auditor has seen it; the cryptography is
   used, not reviewed here.
3. **Committee membership is not re-proven for vote evidence.** The verifier
   cannot reconstruct the historical committee without history it does not keep,
   so it proves *double-signing by a key that is bonded now*, plus the tenure
   window — not "this validator was a committee member at that anchor". A
   non-member's conflicting votes are therefore punishable. This is the
   conservative direction (it needs the offender's own signatures) and it keeps
   the verifier self-contained; the alternative would make an honest node's
   verdict depend on pruned state.
4. **Votes need not reference an existing block.** Vote evidence is verified
   between the two votes, not against a block lookup, so an offender can be
   slashed for conflicting votes about a target that never existed. That cannot
   punish anyone else, but it does mean the evidence is about the signature, not
   about the chain.
5. **The slash ledger is unbounded consensus state.** One entry per applied
   slash, each requiring a real equivocation and a forfeited bond. The public
   endpoint returns a bounded page (`count`/`shown`) so no HTTP answer grows with
   it; the state itself does grow, and a future release may add a Merkled
   accumulator if that ever matters.
6. **A slashed validator's key remains usable.** After the registration is
   claimed, the key can still sign votes and proposals — none of which are
   accepted (committee eligibility is checked against the parent state), but they
   are gossip noise. Revocation would need a key blacklist in consensus state.
7. **Free reporting can also mean free garbage.** Undecodable `SLASH` bodies are
   now refused at gossip, and the producer drops inapplicable ones without
   retrying them, but a *well-formed* worthless body can still be relayed once
   and pooled: the pool is bounded (10,000 transactions, 32 MiB, 64 per sender)
   and equal-or-higher-gas work is never displaced, so the cost is bounded, not
   zero.
8. **The release is unsigned and the tag is operator-verifiable only.** Archive
   checksums are published and rebuilt by CI, but there is no release signing key
   in this repository.
