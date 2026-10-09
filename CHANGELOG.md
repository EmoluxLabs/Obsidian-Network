# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

The authoritative params hash for a release is whatever `GET /params` reports on
a node running it. For 1.7.0 that is `bffeacb35532ba3df70cda8c27ed6c96` (see the note in 1.7.0 about gate keys).

---

## [1.7.0] — 2026-10-09

**Consensus-breaking, new-genesis release for a pre-launch network.** Protocol and core version are `1.7.0`,
the params hash is `bffeacb35532ba3df70cda8c27ed6c96`, and the genesis snapshot format is 4. A 1.7.0 node rejects
1.6.x peers at the handshake and refuses a 1.6.x data directory; there is no migration, so this is for an
unstarted network (or a disposable one that is reset on purpose).

The mainnet genesis of a document that commits **no** gate keys has id `2dc198e4e57cb482df4e0f89e3a28daaf427ccff`
and block hash `8ffcf7c18a5ba07b6a67fee4a373a62c62e9da612e7b66dcd9437597695b0475`. **A real network commits its
issuer keys in genesis, so its id is different from these**; read the id from `GET /health` on your own node.

### The sign-up gate is now a consensus rule

Before, the account system (sign-up, invitation, MFA, one wallet per account) was enforced only by the platform,
so anyone could post a `MINING_CLAIM` straight to a node's `/tx/submit`. That door is closed.

- A `MINING_CLAIM` must carry a **certificate** signed by an issuer key committed in genesis
  (`miningGateKeys`). The signature covers `GATE|networkId|chainId|address|claimId|issuedAt` under the new domain
  `OBSIDIAN:MINING_GATE:v1`, so it is bound to one network, one wallet and one claim id (which is replay-protected,
  so a certificate cannot be reused or moved). It is valid from 60 s before to 15 min after `issuedAt`, measured
  against the including block's protocol time, so a leaked certificate is nearly worthless and an account that is
  disabled stops mining within minutes.
- The check runs in the mempool, block production, block validation and sync replay, before every other claim
  check. A block with an ungated claim is invalid. Eligibility and timing are unchanged and remain a pure function
  of the wallet's own history; the issuer decides **who may be certified**, never **when** a wallet may claim.
- The issuer public keys are part of the genesis id and of every state root, so nodes with different lists do not
  peer, and a node cannot be quietly pointed at another list. A chain that commits no key **fails closed**: no claim
  is accepted.
- The platform issues certificates with `POST /api/mining/certificate {address, claimId}` only to a signed-in,
  MFA-confirmed account whose single linked wallet is that address. Its private key lives in an encrypted keystore
  (`OBSIDIAN_GATE_KEYSTORE`, `OBSIDIAN_GATE_KEYSTORE_PASSPHRASE[_FILE]`), never in the repository.
- Browser, extension, desktop app and `scripts/obsidian-network.sh` request a certificate before signing a claim.
  The script generates a devnet/staging issuer key on first start.
- **Mainnet and testnet keys are deliberately not committed.** Generate them with
  `node scripts/generate-mining-gate-key.mjs` on a machine you trust and set the same
  `OBSIDIAN_MINING_GATE_PUBLIC_KEYS` on every node of that network (or commit them in
  `obsidian-core/src/genesis/gate-keys.ts` and rebuild). Without keys a mainnet node accepts no claim.
- Not solved, stated plainly: the issuer key is a trust root. Whoever holds it can certify any wallet, so the
  one-account and one-wallet rules are as strong as that key's custody. The key list is in genesis, so rotating it
  needs a new genesis. The platform clock must be NTP-synced (window −60 s/+900 s), and while the platform is down
  nobody can start a claim.

### Name registry reads are bounded

`GET /names` and JSON-RPC `getnames` took no limit and returned the whole registry. They now accept `limit`
(1–500, default 200), `offset` and `prefix`; the REST reply adds `matched`, `offset`, `limit` and `hasMore` and keeps
`count` as the registry size.

### Other changes in this release

- `obsidian-node-desktop`: the supervisor passes `OBSIDIAN_MINING_GATE_PUBLIC_KEYS` (public configuration, and only
  from the app's own environment) to the node it supervises.
- New tests: `rpc-hardening` and `mining-gate` (core), gate issuance in `obsidian-interface`, and gated flows in
  `tests/e2e`, `tests/scripts`, the app-web, desktop and extension end-to-end suites.

### Security audit of the app server, web app, extension, desktop app and node RPC

- **obsidian-app-web: unauthenticated remote crash fixed.** `GET /%E0%A4%A` threw inside the
  request handler and stopped the process. Malformed URLs now answer 400 and the server survives.
- **obsidian-app-web / extension: stored-XSS in inline handlers fixed.** Screens put chain-supplied
  strings (block height, transaction id, name, claim ids) into `onclick="…('${esc(value)}')"`.
  The browser decodes the attribute before parsing it as JavaScript, so `esc()`'s `&#39;` turned
  back into a quote and let a hostile or compromised node break out of the string. Handler
  arguments now go through `arg()`, which `\uXXXX`-escapes everything outside `[A-Za-z0-9._:@-]`.
  Regression tests execute the decoded attributes.
- **obsidian-app-web server:** same-origin policy for state-changing `/api` calls (foreign `Origin`,
  `Origin: null` and cross-site `Sec-Fetch-Site` get 403; `APP_ALLOWED_ORIGINS` for a separate
  front end), security headers and a CSP, a 1 MB body cap (413), and `APP_TRUST_PROXY` so the
  platform rate-limits each visitor instead of treating the whole web app as one client.
- **obsidian-core RPC:** `POST /rpc` with `null`, an array or a scalar answered 500 and an oversize
  body answered 400; they are now 400 and 413. `getblocks` clamps its limit to 1..500. An oversize body is now read and discarded (up to 8 MB) instead of the request being destroyed, so the client receives its 413 instead of a connection reset.
- **obsidian-node-desktop:** the external-link allowlist no longer accepts dot segments that
  GitHub resolves to another repository, and the `app://` handler answers 400 on a malformed
  percent sequence instead of throwing.
- New tests: `tests/e2e-adversarial.mjs` (app-web), `tests/server-hardening.test.mjs`,
  `rpc-hardening` additions, and the extension's `tests/ui/hostile.e2e.mjs`.

---

### Carried forward unchanged from 1.6.1

This repository keeps one changelog entry: the release it ships. 1.7.0 carries every rule of 1.6.1 unchanged and adds
the two changes above; the 1.6.1 identity values (params hash, genesis ids) were superseded and are not repeated.
1.6.1 itself was a consensus-breaking new-genesis release: it rejected 1.6.0 peers and data directories, and it
existed because a slashing-liability rule had been fixed *without moving the protocol identity*, which would have let
two nodes compute different state roots under one version string. The full account is in
[docs/remediation-1.6.1.md](docs/remediation-1.6.1.md).

### 1.6.1 consensus and slashing remediation

* **The protocol identity moved with the rules it describes** (`1.6.0` →
  `1.6.1`, params hash `4a2883b2…` → `2dd76ca2…`, and with it all four genesis
  ids). Identity is derived, not transcribed: `CONSENSUS_PARAMS` feeds
  `computeParamsHash`, the document feeds `genesisId`, and both feed the state
  root, the handshake, the finality signature domain and every signed message.
  A node on 1.6.0 and a node on 1.6.1 cannot agree on a block, a certificate, a
  vote or a handshake, and the two cannot be confused for one another.
* **Whether production is open is consensus state, not an inference from a
  count.** `validatorModeEstablished` is committed in the state root *ahead of*
  the validator list, set only by the first successful registration, never
  cleared, and refused if absent from a snapshot (snapshot format 2 → 3). An
  established chain with no active validator halts for every round instead of
  reopening to any node — the old rule read "no validators" as "bootstrap", so a
  jail that emptied the set handed the chain to whoever could produce a block.
* **A jail term is a duration, not a block count.** `jailedUntilTime`
  (`jailSlots × targetBlockSeconds` = 50,400 s) is committed state; the term
  lapses in the first block whose timestamp reaches it, and may lapse in a block
  the jailed validator itself produces. A height-denominated term could never
  expire on a chain that had stopped producing — and stopping is what a jail can
  cause.
* **One predicate decides whether a finality vote is valid.**
  `validateCanonicalFinalityVote` (`src/consensus/finality-vote.ts`) is the only
  implementation; vote admission, restoration, certificate verification,
  equivocation detection, evidence verification and block execution all call it,
  against the historical committee and the historical schedule. Both halves of an
  accusation must satisfy it, so a node cannot be made to slash on a vote it
  would have rejected.
* **Slash evidence is bounded before it is verified.** A block carries at most 8
  reports and 65,536 bytes of evidence (`ERR_EVIDENCE_LIMIT`), counted in a
  pre-pass before any signature is checked; a producer verifies at most 32
  reports and 1 MiB per attempt; the mempool holds 256 pending reports, 8 per
  sender, in 4 MiB, checked before generic eviction. Submission stays
  permissionless and a report that does not fit waits rather than being dropped.
* **Verification is separated from application.** `verifyEvidence` is pure —
  safe in P2P admission, mempool, simulation and certificate paths — while
  `applyEquivocationSlash` alone mutates state. There is one implementation of
  each, so the paths cannot drift.

### Consensus and security (carried from the 1.6.0 ruleset)

* **Finality bootstraps only from a public, genesis-committed set.** The
  bootstrap validator keys are a protocol constant
  (`obsidian-core/src/genesis/bootstrap-keys.ts`) hashed into the genesis id:
  mainnet commits **4 keys, quorum 3**; testnet commits 3 keys, quorum 3;
  staging and devnet commit none and take their committee from
  `OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS`. A network with a committed set
  refuses to start with any other list — an empty one included — because that
  would be a different chain wearing the same network name. Where no set is
  committed, an empty list means no finality bootstrap at all: a node never
  derives an initial trusted committee from its own local fork. Both are
  fail-closed defaults, asserted by tests.
* **The committed set is bounded by the protocol's own arithmetic.** Every
  validator needs one exact 20,000 OBS bond *plus* the registration gas, so
  `5 × 20,000.01 = 100,000.05` exceeds the 100,000 OBS genesis allocation while
  `4 × 20,000.01 = 80,000.04` fits. Mainnet therefore commits four keys and
  finality needs three of them; a fifth validator joins through the ordinary
  registry after the first checkpoint. This was found by the launch rehearsal —
  the earlier five-key plan could not have bonded, and finality would have
  stalled for a reason no unit test would have shown.
* **Fork choice is deterministic and ordered**: finalized anchor → fixed
  one-unit-per-valid-block PoT weight → height → lowest header hash. Ties are
  resolved by hash rather than left to arrival order.
* **Missing finality state fails closed.** A chain whose stored head is above
  genesis refuses to start when its finality journal is missing, instead of
  silently re-deriving a safety lock from whatever it can see locally.
* Certificate anchor semantics are strict: a certificate must extend the local
  anchor, its votes must be from the committee for the target parent state, and
  a certified branch may repoint the chain only through the validated
  certificate path. Finality fixture rounds are derived from block timestamps,
  so the adversarial suites are deterministic rather than order-dependent.

### Economics

* **ONS is the protocol's only revenue source.** The registration and renewal
  fees are split exactly **90% to the Node Runner Reward Pool and 10% to the
  treasury**, inside the state transition, with exact integer arithmetic
  (`nodePool = floor(amount × 9000 / 10000)`, `treasury = amount − nodePool`,
  remainder to the treasury) and an invariant check on every credit.
  `GET /revenue` reports the whole obligation, what has been credited and what
  is still unclaimed, and re-adds the split (`sumsBack`).
* **The validator bond is exactly 20,000 OBS.** A registration offering any
  other amount is refused with `ERR_VALIDATOR_BOND_MISMATCH`; the parameter is
  published on `/params`.
* **Equivocation is slashable, in the state transition, for every node to
  check.** A validator proven to have signed two conflicting block proposals for
  one height and round, or two conflicting finality votes for one anchor,
  forfeits `consensus.equivocationSlashBps = 5000` of its own recorded bond —
  10,000 of the 20,000 OBS — credited to the Mining Pool in the same transition.
  The penalty is a parameter applied to a bond (`slashed + remaining == bond`,
  integers only), never a hard-coded amount; the treasury's share is exactly
  zero and total supply is unchanged to the seal. Submitting evidence is an
  ordinary permissionless `SLASH` transaction (type 12) that costs no gas and
  that any account may send; the evidence, the offender, the round and the
  destination are all recomputed by every node, so no submitter names anything.
  A slashed validator leaves the rotation and the finality committee in the
  block that applied the evidence, the surviving half stays claimable after the
  ordinary unbonding delay, and re-registering needs a fresh full bond. Being
  offline is **not** slashable: missing slots is still a jail, not a penalty.
  The applied-slash ledger and the validator's status are consensus state, so a
  replay — another block, another peer, a restart — finds it and is refused.
  Liability follows the **registration**, not the address: an offence is charged
  to the bond that was held when it happened, so an `UNBONDING` or `JAILED`
  validator is still liable for its whole tenure (unregistering starts the clock
  on the evidence window instead of escaping the penalty — 20,160 blocks, the
  unbonding delay, and the record closes when the remainder is claimed), while a
  fresh registration answers only for its own tenure. Equivocation evidence is
  refused at gossip unless its body decodes, so relaying undecodable evidence is
  a peer fault instead of free work for every node, and `/validators` returns a
  bounded page of the ledger (`slashing.count` / `slashing.shown`) rather than a
  response that grows with every slash the chain ever applied.
* **The 100 OBS node-runner registration bond is removed as a mechanism, not
  set to zero.** The protocol now has exactly one registration bond — the
  validator's 20,000 OBS — enforced in one place, with `registrationBond`
  deleted from `nodeRewards`, from the node registry executor, from the state
  root, from the RPC surface and from the documents. Registering a node runner
  moves no funds at all.
* Gas still funds the Mining Pool and is never counted as revenue. The genesis
  allocation is still exactly 100,000 OBS to the first protocol-valid mining
  claim, which also designates the treasury — no address is hard-coded and
  nothing is minted by an administrator.

### Removed products

* **Circle (land), Social and Time Capsules are removed from the protocol, not
  hidden.** Their transaction types have no executor, their state is not written
  or read, their RPC routes are gone from the node and from the interface's
  proxy allowlist, their pages and bundles are deleted, and their documents are
  no longer shipped. Existing property-holding code paths were deleted rather
  than left dormant.
* The indexer no longer decodes or describes the removed products.

### Interface

* **Light, mobile-first redesign.** One stylesheet, phone-first: the base rules
  are the narrow-screen layout and `min-width` queries only add room. It is a
  light theme (`color-scheme: light`), inputs are 16px so a phone browser does
  not zoom on focus, touch targets are at least 44px, and nothing may be wider
  than the viewport. Tested from 320px to 1440px.
* Nine pages ship: landing, mine, wallet, explorer, ONS, node runners,
  developer, account, audit. The navigation is a drawer behind one button at
  every width, and the landing page keeps exactly three calls to action.

### Fixed

* **The compliance audit keeps its published row names.** `GET /audit/compliance`
  reports `gasCountedAsPlatformRevenue: false` — gas is remitted to the mining
  pool and is never routed through the ONS split — the name the CI check, the
  deployment guide and the removal report already use. A core test now
  reads the CI workflow's forbidden list and asserts the running node answers
  every row, so a row renamed on one side only cannot pass as green again.

* **The current guides say what the code says.** A consistency pass found and
  corrected claims the tree had outgrown: build examples quoting a retired site
  count (the build writes nine), a checklist line hard-coding a test count, an
  evidence block quoting stale test, invariant, alert-rule and dashboard-panel
  counts, release-tag and `RELEASE-NOTES` examples naming a tag that does not
  exist, a retired front-end count, headings left from the old revenue split, a
  "what replaced them" paragraph still promising revenue streams the protocol
  does not have, a compliance-audit example missing three of the rows the node
  serves, and one route the node has always served and the reference never named
  (`GET /wallet/<address>/next-nonce`). Re-introducing any of the stale counts,
  tag versions, the shortened key list or an undocumented route makes
  `tests/scripts/repo-consistency.test.mjs` fail.

* **The node's RPC enforces the HTTP verb.** Reads answer `GET`/`HEAD`; the seven
  body-carrying endpoints (`/tx/submit`, `/tx/simulate`, `/tx/encode`, `/tx/gas`,
  `/wallet/balance`, `/wallet/quote`, `/rpc`) answer `POST` only; every other verb,
  and a verb on the wrong kind of route, is `405` with an `Allow` header. Before,
  a read endpoint answered `PUT`, `DELETE`, `PATCH` and `POST` exactly like `GET`.
  This is an HTTP-layer change only: the params hash, genesis ids and every
  consensus rule are untouched. A black-box probe of a live node (malformed and
  oversized bodies, path abuse, header abuse, 300 idle sockets, a 400-request
  burst, a 200-socket flood and a 16 MB frame at the P2P port) found nothing else.
  The deployment guide's "submit transactions" examples, which called `POST`
  routes with `GET` and named a route that does not exist, now show the real
  calls, and its network table no longer labels a purpose column "Block time".

### Verification in this release

* Core typecheck and build, interface typecheck and build, and the full core,
  interface, script, cloudflare and end-to-end suites were run against this
  candidate. `.github/workflows/ci.yml` is the running record of what is checked
  and prints the counts itself, so they are not hard-coded here.
* `scripts/check-invariants.mjs` asserts the 90/10 split (including the
  remainder), the ONS-only revenue classification, the single 20,000 OBS bond,
  the absence of any node registration bond, the 5,000 bps equivocation penalty
  and the fork-choice order.

### Not in this release

* No claim of general BFT, universal immutability, production readiness,
  independent cryptographic review, or physical power-loss testing.
* **No independent security audit.** The 1.6.1 remediation was written and
  reviewed by the same people who wrote the code, with adversarial tests as the
  check. `docs/security-model.md` §3 says this in the same words.
* **No power-loss or hardware crash testing.** Durability follows a fixed write
  order and the suites simulate a process dying between steps by rebuilding from
  storage; nobody has pulled the plug on a machine running this node.
* **No hostile-peer testing.** The bounds are implemented and unit-tested, but no
  fuzzed handshake, eclipse attempt, partition soak or sybil flood has been run
  against a live node.
* **No signed release.** `releases/` carries no `SHA256SUMS.asc`;
  `scripts/verify-release.sh` prints `UNSIGNED RELEASE` rather than passing
  quietly, and `docs/release-process.md` §5 states the operational requirement.
* No automatic migration from 1.6.x, and no mainnet value transfer: a 1.7
  network starts from its own genesis.
* **No mainnet or testnet mining-gate key.** Operators generate their own; until one is configured a node of that
  network accepts no mining claim.
