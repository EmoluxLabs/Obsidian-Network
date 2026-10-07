# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

The authoritative params hash for a release is whatever `GET /params` reports on
a node running it. For 1.6.0 that is `2f95e359a447f9e55ba2dbd75e589361`.

---

## [1.6.0] — 2026-10-07

**Consensus-breaking, new-genesis release for a pre-launch network.** Params hash
is `2f95e359a447f9e55ba2dbd75e589361`; mainnet genesis id is
`3a7ced6f7e6a14f40fc310d9a5de6d834b5cbd4c` and genesis block hash is
`f79d1a1a1acab6c803b839b378aeb6c7f668bb8ebdd63ed55b189caae6a2677b`. A 1.6.0
node rejects 1.5.x peers and data directories, and it does not migrate a 1.5
chain: this release is for an unstarted network. 1.5.x release archives and the
1.5 historical record in this changelog are untouched.

### Consensus and security

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

### Verification in this release

* Core typecheck and build, interface typecheck and build, and the full core,
  interface, script, cloudflare and end-to-end suites were run against this
  candidate. `.github/workflows/ci.yml` is the running record of what is checked
  and prints the counts itself, so they are not hard-coded here.
* `scripts/check-invariants.mjs` asserts the 90/10 split (including the
  remainder), the ONS-only revenue classification, the 20,000 OBS bond and the
  fork-choice order.

### Not in this release

* No claim of general BFT, universal immutability, production readiness,
  independent cryptographic review, or physical power-loss testing.
* No automatic migration from 1.5.x, and no mainnet value transfer: a 1.6
  network starts from its own genesis.
