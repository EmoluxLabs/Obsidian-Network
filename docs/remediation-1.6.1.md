# Consensus and slashing remediation — 1.6.0 → 1.6.1

**Scope.** The critical consensus and slashing findings raised against the
1.6.0 tree, what was changed, what was deliberately *not* changed, what was
verified and how, and what remains open. Every claim about a rule names the code
that enforces it; every claim about a test names the suite that ran.

**Status of each finding**

| Finding | What it was | Status |
| --- | --- | --- |
| C-01 | consensus rules changed while the protocol identity stayed 1.6.0 — an undetectable fork | **fixed**: explicit versioned upgrade |
| H-01 | zero active validators re-opened production to any node | **fixed**: committed admission mode, halt instead |
| H-02 | finality-vote validity duplicated across paths | **fixed**: one predicate, every caller |
| H-03 | unbounded slash-evidence verification | **fixed**: bounded at consensus, producer and mempool |
| H-04 | one predicate set, verification separated from application | **fixed** |
| H-05 | equal voting weight undocumented as a design decision | **documented**; not redesigned |
| M-01 | release signing | **honestly stated**: architecture exists, no release is signed |
| M-02 | no independent audit | **stated** |
| M-03 | no power-loss testing | **stated** |
| M-04 | no hostile-peer testing | **stated** |

None of the ten stop conditions is live; §L lists what they were and why each
one is closed, together with the risks that are *not* closed.

---

## A. Files changed

`git diff --stat 336d8d1..HEAD` → **73 files, +3,006 / −368**, in nine commits
(`bc755b9`, `9402191`, `a3c55f0`, `ae29321`, `1484a2b`, `a492df5`, `1a9e33f`,
`027751f`).

| Area | Files |
| --- | --- |
| consensus core | `src/version.ts`, `src/protocol/params.ts`, `src/protocol/types.ts`, `src/protocol/errors.ts`, `src/consensus/finality-vote.ts` (new), `src/consensus/proposer.ts`, `src/consensus/slash-evidence.ts` |
| chain and state | `src/blockchain/state.ts`, `src/blockchain/state-root.ts`, `src/blockchain/chain.ts`, `src/blockchain/state-machine.ts`, `src/blockchain/mempool.ts` |
| execution | `src/transactions/executors/validator.ts`, `src/transactions/executors/slash.ts`, `src/transactions/types.ts` |
| tests | `tests/security/protocol-identity.test.ts`, `tests/security/validator-mode.test.ts`, `tests/security/finality-vote-predicate.test.ts`, `tests/security/evidence-resources.test.ts`, `tests/security/slashing.test.ts`, `tests/unit/mempool-security.test.ts`, `tests/integration/*`, `tests/helpers/harness.ts` |
| docs | `docs/consensus.md`, `docs/security-model.md`, `CHANGELOG.md`, plus the version/identity values in 11 further documents |
| release | `releases/*` (1.6.1 artefacts), `scripts/verify-release.sh`, the two `docker-compose.yml` image tags, both `package.json` + lock files, `obsidian-core/VERSION` |

---

## B. Consensus changes: old rule → new rule

### B1. Protocol identity follows the rules it describes (C-01)

**OLD RULE.** `PROTOCOL_VERSION`, `CORE_VERSION`, `MIN_CORE_VERSION` and
`computeParamsHash(CONSENSUS_PARAMS)` were untouched when the slashing-liability
rule changed. Two nodes — one applying the new rule, one not — shared a protocol
id, a params hash, a genesis id and a handshake, and differed only in the state
root they produced. Nothing in the protocol could detect that.

**NEW RULE.** `1.6.0` → `1.6.1` for all three version constants, which changes
`computeParamsHash` (the hash covers `protocolVersion`), which changes every
genesis id (the document carries `protocolVersion`), which changes the state
root, the handshake compatibility check, the finality signature domain and every
signed message. A 1.6.0 node rejects a 1.6.1 peer at the handshake and refuses a
1.6.1 data directory; a 1.6.1 node rejects 1.6.0 blocks, certificates, votes and
slash evidence field by field.

**WHY.** Identity is the mechanism by which a network agrees on which rules are
in force. Changing rules without moving it produces two chains that believe they
are one.

**PROTOCOL VERSION** 1.6.0 → 1.6.1 · **PARAMS HASH** see §D · **STATE-ROOT**
changes (params hash is an input) · **P2P** mixed-version handshakes are refused
· **FINALITY** a vote signed under the other version fails the identity rule
before any signature work · **REPLAY** cross-version evidence is rejected ·
**RESTART** a 1.6.0 data directory is refused, not migrated.

The identity is *derived*, not transcribed: `CONSENSUS_PARAMS` →
`computeParamsHash` → genesis document → `genesisId` → state root. No version
string is duplicated anywhere that consensus reads.

### B2. Whether production is open is committed state, not an inference (H-01)

**OLD RULE.** Production was open to any node whenever
`activeValidators.length === 0`, and the protocol inferred "genesis, before the
first validator" from that count. A jail, an unbonding or a slash that emptied
the active set therefore handed block production to any node that could produce
one — including the validator that had just been removed.

**NEW RULE.** `validatorModeEstablished` is a consensus value, committed in the
state root *ahead of* the validator list it qualifies, restored on restart, set
only by the state transition of the first successful `VALIDATOR_REGISTER`, and
never cleared. `proposerDecision` returns `OPEN` (bootstrap), `SCHEDULED`
(established, a named proposer) or `HALTED` (established, empty active set) —
the last for every round, for every candidate producer. A snapshot without the
indicator (format 2) is refused rather than read as "not established".

**WHY.** The count cannot distinguish "no validator has ever registered" from
"the last validator was just removed". Only the second is a halt, and only the
first may produce permissionlessly.

**PROTOCOL VERSION** 1.6.1 · **PARAMS HASH** unchanged by this item ·
**STATE-ROOT** `validatorModeEstablished` added, ordered before `validators` ·
**P2P** no new message; a block from an unauthorised producer is rejected with
`ERR_NOT_PRODUCER_TURN` · **FINALITY** none · **REPLAY** none · **RESTART**
restored from the snapshot; a format-2 snapshot is refused.

### B3. A jail term is a duration of protocol time, not a block count (H-01)

**OLD RULE.** A jail lasted 10,080 **blocks**. The counter advanced only when
blocks were produced.

**NEW RULE.** `jailedUntilTime = timestamp + jailSlots × targetBlockSeconds`
(10,080 × 5 = **50,400 s**) is committed state. `jailIsOver` is a pure function
of that field and the candidate block's timestamp; the term lapses in the first
block whose timestamp reaches it, and may lapse in a block the jailed validator
itself produces. A `JAILED` record with no term is jailed for ever.

**WHY.** A height-denominated term cannot expire on a chain that has stopped
producing — and stopping is exactly what a jail can cause once it empties the
active set. B2 turns that case into a halt; only a time-based term can end it.

**PROTOCOL VERSION** 1.6.1 · **STATE-ROOT** `jailedUntilTime` (u64, 0 = never
jailed) · **P2P** none · **FINALITY** a jailed validator is absent from the
committee, so it cannot vote or be certified · **REPLAY** none · **RESTART**
the term survives a restart and a long outage; the validator returns in the
first block after it, regardless of how long the node was down.

`jailEndsAt`/`jailIsOver` live in `src/protocol/params.ts` beside
`VALIDATOR_JAIL_SECONDS`, because the validator executor needs the same answer
the chain computes and `transactions/` is copied into the browser bundle while
`blockchain/` deliberately is not. `blockchain/state.ts` re-exports both, so
there is still exactly one rule.

---

## C. Protocol version

| | 1.6.0 | 1.6.1 |
| --- | --- | --- |
| `PROTOCOL_VERSION` | 1.6.0 | **1.6.1** |
| `CORE_VERSION` | 1.6.0 | **1.6.1** |
| `MIN_CORE_VERSION` | 1.6.0 | **1.6.1** |
| `STATE_SNAPSHOT_VERSION` | 2 | **3** |
| package versions / `VERSION` / image tags | 1.6.0 | **1.6.1** |

Mixed-version behaviour, tested in `tests/security/protocol-identity.test.ts`:
a 1.6.0 node rejects a block produced under 1.6.1 rules; two 1.6.1 nodes agree
on the same block; a 1.6.0 handshake is refused; a finality vote signed under
1.6.0 is rejected with a per-field identity message rather than being silently
ignored.

## D. Params hash and genesis identity

Measured on this tree by running a chain (`chain.status()`), not transcribed:

The 1.6.1 identity values were superseded by protocol 1.7.0, which changed the params hash and every genesis
identity (the mining gate keys are committed in genesis). The live values are the ones `genesis init --network <name>`
prints and the CHANGELOG records; they are deliberately not repeated here, so this report cannot drift from them.

The genesis `note` text still names the previous release. It is part of the
committed document, so editing it would move the genesis id again for no
benefit; the identity reads the `protocolVersion` field, not the prose.

The historical values above are truncated on purpose: this tree's own
consistency gate refuses to carry an identity value no network derives, which is
the right rule for operator documentation. The full previous-release identities
are recorded in that release's notes and in the commit history.

---

## E. Slashing model — confirmation, unchanged

Verified by `scripts/check-invariants.mjs` and
`tests/security/slashing.test.ts`:

| Property | Value |
| --- | --- |
| validator bond | exactly **20,000 OBS** (`parseObs('20000')`); 19,999 and 20,001 rejected |
| penalty | `equivocationSlashBps = 5000` → **50 %**, derived as `validatorBond / 2n` |
| slashed | **10,000 OBS** |
| remaining with the validator | **10,000 OBS**, claimable via `CLAIM_UNBONDED` after the unbonding delay |
| to the Mining Pool | **10,000 OBS** |
| to the Treasury | **0 OBS** |
| supply | conserved to the seal — nothing burned, nothing minted, nothing paid to the submitter |
| arithmetic | integer `bigint` only; `slashAmount + remaining === validatorBond` |
| effect on the validator | `SLASHED` immediately, leaving the rotation and the committee in the same block; re-registration needs a fresh full 20,000 OBS after claiming the remainder |
| reporting | permissionless, gas-free `SLASH` (type 12) |

Nothing in 1.6.1 touches the percentage, the destination split, the bond or the
supply treatment.

## F. Zero-validator behaviour, before and after

| Situation | 1.6.0 | 1.6.1 |
| --- | --- | --- |
| genesis, no validator ever registered | any node may propose | any node may propose (**unchanged** — bootstrap mode) |
| first validator registers | closes open production | closes it **and commits the indicator for ever** |
| only validator unregisters / is jailed / is slashed | active set empties → **production reopens to any node** | **chain halts** for every round |
| all validators jailed | same | halt |
| all validators unbond | same | halt |
| restart at zero validators | mode re-derived from the count → open | mode restored from the snapshot → **halt** |
| unregistered node produces a block | accepted while the set is empty | rejected (`ERR_NOT_PRODUCER_TURN`) |
| validator returns | resumes | resumes — jail term lapsed in time, or a fresh registration |
| historical mode | not recorded | never erased; the indicator is append-only in effect |

## G. The finality-vote predicate and every caller

`validateCanonicalFinalityVote(vote, context)` in
`src/consensus/finality-vote.ts` is the **only** implementation. Rules, cheapest
first:

1. shape (heights, round, signature present, canonical form);
2. protocol identity — version, network, chain, genesis, params hash, each with
   its own rejection message;
3. the caller's local anchor, when the caller requires it;
4. the parent exists and `vote.height === parent.height + 1`;
5. the committee in force at `(parentHash, finalizedHeight)`, the
   `validatorSetHash`, and the signer's membership **with that key**;
6. the signature over the finality domain, with its key/address binding;
7. the target — existence, height, parent hash, round, and that the producer
   matches the schedule for that height and round;
8. ordinary extension (`height === finalizedHeight + 1` and
   `parentHash === finalizedHash`) or bootstrap extension.

Defaults: `requireTargetBlock: true`, `allowUnknownTarget: false`,
`allowBootstrapTarget: true`. Evidence verification is the one caller that
permits an unknown target, because a node that never received the equivocated
block must still recognise the offence.

**Callers** (all verified in `tests/security/finality-vote-predicate.test.ts`,
which also asserts no second implementation exists by reading the source):

| Path | Call site |
| --- | --- |
| vote admission | `chain.addFinalityVote` |
| certificate construction and verification | `chain.validateCertificateEnvelope` |
| equivocation detection and evidence admission | `chain.addEquivocationEvidence` |
| slash-evidence verification | `consensus/slash-evidence.ts` via `ctx.evidence` |
| block execution | `state-machine.ts` → the `SLASH` executor |
| vote restoration after restart | the finality store replay |

Both halves of an accusation must pass it independently.

## H. Evidence resource limits

| Layer | Limit | Constant |
| --- | --- | --- |
| block (consensus, deterministic) | ≤ **8** reports | `consensus.slashing.maxEvidencePerBlock` |
| block (consensus, deterministic) | ≤ **65,536** bytes of evidence | `consensus.slashing.maxEvidenceBytesPerBlock` |
| producer (node-local policy) | ≤ **32** verifications per attempt | `MAX_SLASH_VERIFICATIONS_PER_BLOCK` |
| producer (node-local policy) | ≤ **1 MiB** of evidence per attempt | `MAX_SLASH_VERIFICATION_BYTES_PER_BLOCK` |
| mempool | ≤ **256** pending reports, ≤ **8** per sender, ≤ **4 MiB** | `maxPendingEvidence`, `maxEvidencePerSender`, `maxEvidenceBytes` |
| relay cache | bounded by the existing `finality.maxPendingVotes` (512) — **no new cap was added** |

The block limit is enforced in a **pre-pass before execution**, so the first
oversized report cannot be reached by a chain of cheap ones; it fails with
`ERR_EVIDENCE_LIMIT`. A report that does not fit is not rejected — it stays
pooled for a later block. Submission remains permissionless, and one ruler
(`slashEvidenceBytes`, the canonical UTF-8 length of the evidence JSON) is used
everywhere, so no path can measure size differently from another.

Verification order, fixed and cheap-first: structure → size → canonical encoding
→ `evidenceId` → duplicate/replay (canonical state) → contextual → cryptographic
→ full consensus validation → state mutation. The seen/rejected/applied cache is
bounded, eviction-safe and never the only source of truth: replay is decided by
`slashes` in committed state.

## I. Persistence and crash safety

* `validatorModeEstablished`, `jailedUntilTime`, the slash records and the
  evidence ids are all in the committed world state, inside the state root.
* Snapshots are format **3**; `fromSnapshot` throws when the mode indicator is
  absent, so a pre-1.6.1 snapshot cannot be read as "bootstrap mode".
* Write order is unchanged from ON-06: block → state and events → canonical
  marker and checkpoint → in-memory head → publication. No new in-memory
  consensus state is published before its durable representation is committed.
* A valid slash survives a restart, and so does the halt: both are read from
  committed state, not from a cache.
* No node-local value participates in a consensus decision.

## J. State-root fields added

| Field | Type | Where it sits |
| --- | --- | --- |
| `validatorModeEstablished` | boolean | **before** `validators`, so two chains with the same empty list have different roots |
| `jailedUntilTime` | u64, on each validator record | `0` / absent = not jailed; a `JAILED` record with no term is jailed for ever |

Both are canonical, deterministic and covered by `computeStateRoot`; nothing
consensus-affecting was left out of the root.

## K. Tests

Run against this tree:

| Suite | Result |
| --- | --- |
| `obsidian-core` (vitest) | every file passes, nothing skipped |
| `obsidian-interface` (vitest) | every file passes |
| script suites (`node --test`) | all pass — consistency, edge, helper, cluster, ecosystem, networks, quickstart, signing, soak, invite |
| `scripts/check-invariants.mjs` | every invariant holds (re-run on every release) |
| `scripts/verify-release.sh` | the release archive verified |

Counts are deliberately not written here: a number in a document goes stale the
moment a test is added, and this repository's own gate rejects it. Each runner
prints its own counts, `.github/workflows/ci.yml` is the running record, and the
commit that shipped this release records the totals it was verified with. The
only skips in the whole gate are the release-signing checks in `signing`, which
cannot run without a GPG key — they report as skipped, never as passed.

New adversarial suites in this release:

| Suite | What it proves |
| --- | --- |
| `tests/security/protocol-identity.test.ts` | a 1.6.0 node rejects a 1.6.1-rule block; two 1.6.1 nodes agree; mixed handshakes are refused; old-protocol votes and evidence are rejected; the identity is derived, not duplicated |
| `tests/security/validator-mode.test.ts` | the nine H-01 edge cases: never-registered, first registration, sole validator leaving, all jailed, all unbonded, restart at zero, unregistered producer, return, historical mode never erased; plus the jail term in time |
| `tests/security/finality-vote-predicate.test.ts` | every predicate rule separately, purity (same inputs → same verdict, inputs unmutated), and a guard that no second implementation exists |
| `tests/security/evidence-resources.test.ts` | the block, producer and mempool limits, including a 1,000-address flood that cannot displace honest transactions |
| `tests/security/slashing.test.ts` | equivocation sequences, cross-tenure and cross-network replay, exactly-one-slash under ×2/×10/restart/other peers, accounting invariants |

Property and invariant coverage: supply conservation across a slash, no double
slash, no cross-tenure slash, no unauthorised proposer, signed-but-not-slashable,
and determinism of every predicate.

## L. Remaining risks and honest statements

**Closed.** None of the ten stop conditions is live: no consensus/version
mismatch (§B1), no live zero-validator permissionless production (§B2), no
duplicated finality or slashing validity (§G), complete vote validation for
slash evidence (§G), bounded slash verification (§H), no cross-tenure slashing
(evidence names the historical registration and tenure), no replayable slashing
(canonical state decides), deterministic validator state (§I), no
restart-dependent consensus (§I), no mixed-version ambiguity (§C).

**Open, and not claimed otherwise:**

1. **No independent security audit (M-02).** This remediation was written and
   reviewed by the same people who wrote the code. Adversarial tests are the
   check. That is not external verification, and no such claim is made anywhere
   in these documents.
2. **No power-loss or hardware crash testing (M-03).** Durability follows the
   fixed write order and the suites simulate a process dying between steps by
   rebuilding from storage. Nobody has pulled the plug on a machine running this
   node, and no filesystem-level fault injection has been run.
3. **No hostile-peer testing (M-04).** The bounds are implemented and
   unit-tested; no fuzzed handshake, eclipse attempt, partition soak or sybil
   flood has been run against a live node. The bounds exist; confidence that
   they are sufficient does not.
4. **No signed release (M-01).** `scripts/sign-release.sh` exists and produces a
   detached GPG signature after re-checking every digest, but `releases/` carries
   no `SHA256SUMS.asc`. `verify-release.sh` prints `UNSIGNED RELEASE` rather
   than passing quietly. The remaining requirement is operational: a key the
   publisher alone controls, with its fingerprint published somewhere other than
   the archive host. No key is generated by the project or by CI, deliberately.
5. **One validator, one vote (H-05).** Equal voting weight is retained by
   design; the 20,000 OBS bond is the admission barrier, not vote weight. A
   stake-weighted upgrade is documented as future work in
   `docs/security-model.md` §3 and not implemented: the quorum rule, the
   committee hash, the certificate format, the evidence rules, the P2P messages
   and every test would have to move together.
6. **Sybil resistance is economic only.** *k* funded bonds buy *k* seats and *k*
   votes, and no code here can distinguish one operator with ten seats from ten
   operators. Mitigations: the exact bond, duplicate-identity prevention, and
   equal weight so splitting a holding buys no extra influence. The residual
   risk — a well-funded single actor holding a majority — is stated, not solved.
7. **A latent preview/validation mismatch remains.** `scheduledProposerNow()`
   evaluates the schedule at `state.s.timestamp` while block validation uses the
   *block* timestamp. The two can differ when a jail lapses between them. It
   cannot cause an invalid block to be accepted (validation is authoritative and
   fails closed), but a node's local preview can name a proposer that validation
   then rejects. Not fixed in this release; recorded here rather than hidden.
8. **No general BFT claim.** Finality is PoT-checkpoint finality with an
   equal-weight committee. Deep reorgs beyond 256 blocks are refused rather than
   resolved.

---

## Self-audit against the mandate's fourteen questions

| # | Question | Answer |
| --- | --- | --- |
| 1 | Can two nodes with the same version disagree about consensus? | No. Version, params hash and genesis id all moved; mixed versions are refused at the handshake. |
| 2 | Can any node produce a block when the active set is empty? | No, once established. Tested for restart, jail, unbonding and slash. |
| 3 | Is the mode inferable from a count alone? | No. It is committed state, ordered ahead of the list it qualifies. |
| 4 | Is there more than one finality-vote validity function? | No — one, with a test that reads the source to prove it. |
| 5 | Does slash-evidence verification run the same predicate as admission? | Yes, through `ctx.evidence`. |
| 6 | Can a peer make a node verify unbounded evidence? | No. Three bounded layers, cheapest checks first, replay decided by canonical state. |
| 7 | Can the same evidence slash twice? | No. Canonical `evidenceId` plus committed `slashes`. |
| 8 | Can evidence from a non-canonical branch slash? | No. Evidence is validated against canonical historical state. |
| 9 | Does a valid slash survive a restart? | Yes, tested. |
| 10 | Is any consensus field outside the state root? | No. Both new fields are in the root. |
| 11 | Is any consensus decision node-local? | No. The producer policy limits are node-local *and* strictly tighter than the consensus limits, so they can only delay a report, never change a verdict. |
| 12 | Did anything economic change silently? | No. §E confirms the bond, the 50 %, the split and the supply treatment. |
| 13 | Was anything removed to make a test pass? | No. Every pre-existing protection is retained; the suites grew by 4 new files. |
| 14 | What is still unverified? | Independent audit, power-loss behaviour, hostile-peer behaviour, release signing — §L, stated as unverified rather than assumed. |
