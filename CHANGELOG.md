# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

The authoritative params hash for a release is whatever `GET /params` reports on
a node running it. For 1.1.0 that is `5ed3d6409bd4e723f83f00469e976062`.

---

## [1.1.0] — 2026-09-30

**Consensus-breaking.** The params hash changes, so mainnet has not launched
under 1.0.0 rules and will not. Launch from 1.1.0.

### Added

* **Proof of Time (PoT) as the named consensus identity.** Fork choice is
  most-accumulated PoT Weight → most time (height) → lowest header hash, where
  `potWeight = 1 + txCount`. A new `GET /pot` publishes the consensus name, the
  weight rule, PoT Difficulty and the Time-Rate. Documented in
  `docs/proof-of-time.md`.
* **PoT Difficulty as a published measurement**, not an acceptance gate: it
  reports how block spacing tracks the 5-second target over a 720-block window.
  Block acceptance remains gated by median time past, strict monotonicity
  against the parent, and the 60-second future-drift bound. Making spacing a
  gate was implemented, tested and deliberately removed — it locked out
  legitimately fast devnets and nodes catching up without raising the cost of
  any attack.
* **Node runner revenue sharing: 40% of platform revenue to node runners, 60%
  to the treasury**, settled on chain. Includes an on-chain node registry
  (`TxType.NODE_REGISTRY`) with registration, wallet change, deregistration,
  heartbeats, attestations and fault reports; a 100 OBS bond returned in full on
  deregistration; and per-period settlement. Documented in
  `docs/node-runner-rewards.md`.
* **Node scoring that cannot be self-reported**: uptime 40%, participation 25%,
  reliability 20%, responsiveness 15%, where participation is blocks produced
  60% / coverage 40%. Uptime is established by peer attestations (minimum two
  attesters), not by a node's own claim about itself. No node may take more than
  5% of a period.
* **`GET /revenue`, `GET /nodes/registry`, `GET /nodes/rewards` and
  `GET /nodes/status/:nodeId`** for inspecting the split and individual node
  standing.
* **The `/node/` operator site** — the revenue split diagram, recent
  settlements, node lookup with score breakdown, evidence, and registration
  steps.
* **The official OBS coin logo** as a hand-authored SVG (`assets/logo.svg`) with
  a deterministic rasteriser (`assets/render-logo.py`) producing the PNG sizes
  and favicon.
* **Seven new compliance audit rows**, all asserting absence:
  `proofOfWorkConsensus`, `blockHeaderNonce`, `selfReportedNodeMetrics`,
  `adminRewardOverride`, `gasCountedAsPlatformRevenue`, `nodeIdentityIsIpAddress`,
  plus `revenueSplitEnforced` asserting presence.
* **`scripts/check-invariants.mjs`** — 50 economic and protocol invariants
  checked against the built parameters, exiting non-zero on drift.
* **`docs/mainnet-launch.md`** — the launch runbook: bootstrap set, genesis
  verification, the genesis allocation event, monitoring, rollback and a
  checklist.
* **Continuous integration** (`.github/workflows/ci.yml`) running all four test
  suites, the invariant check, mainnet genesis determinism, a live mainnet node
  boot with a supply-invariant assertion, a **Docker job** that builds both
  images and runs the full compose stack, and a full release packaging run.
* `SECURITY.md`, `CONTRIBUTING.md` and this changelog.

### Changed

* Terminology throughout: proof-of-work language replaced with Proof of Time;
  `cumulativeWork` → `cumulativePotWeight`, `blockWork` → `potWeight`.
* Platform revenue from ONS registration and renewal, business pages, protocol
  land sales and explicit payments now routes through `creditPlatformRevenue`
  and is split. Gas is explicitly excluded — it goes to the mining pool, whole,
  as it always did.
* Revenue earned before a treasury exists is held as
  `nodeRewards.unclaimedRevenue` rather than being dropped or misrouted.
* The release manifest and end-to-end tests read `PROTOCOL_VERSION` from the
  build instead of hardcoding a version string.
* `scripts/verify-release.sh` now looks for `SHA256SUMS` beside the archive
  before beside itself, so verifying a downloaded release works the obvious way.
* **Container recipes: five fixes, all found by executing them in CI.** The
  interface image now builds from the repository root as its Dockerfile
  requires (the previous context would have failed the build); image tags
  corrected from `1.0.0` to `1.1.0`; the node container's RPC and p2p ports are
  pinned so a non-mainnet network does not silently listen on a different port
  than the one published; the interface image copies each site to its own
  directory instead of flattening all twelve into one; and the `/node/` site is
  no longer omitted from the image.
* The source release archive no longer contains `releases/` (it was recursively
  embedding every other archive: 46 MB → 742 KB).

### Fixed

* **PoT Difficulty reported nonsense on a fresh chain.** The genesis-to-first-
  block gap was being averaged into observed spacing, producing values in the
  billions of milliseconds on a real release build. The gap whose older end is
  height 0 is now excluded by height, and the median of the remainder is used —
  a mean, or a median that still includes the genesis gap, is wrong at height 2.
* **The `/node/` site returned 404 in the built server.** Three separate site
  lists exist (the generator, the server allowlist, the navigation) and only two
  had been updated. A test now cross-checks them.
* **The `/node/` site was missing from both interface release archives.** The
  packaging script stages site directories by name and had not been updated, so
  anyone deploying from a release archive got a 404 for a site that worked in
  the repository. A test now asserts every generated site is staged.
* Test counts in the documentation corrected against a per-file recount.

### Verified

376 automated tests: core 233, interface 123, edge worker 7, three-node
end-to-end cluster 13. Plus 50 protocol invariants, and a mainnet node booted
from the packaged release archive reporting height 0, supply 0,
`invariantOk: true` and genesis id
`20a787220fa49a2d8a41276b370705a16add75ba`.

### Not production ready

Nothing is shipped in this release labelled production ready that has not been
executed. The container recipes, previously unverified, are now built and run by
CI on every push; see item 12 of `docs/IMPLEMENTATION-REPORT.md` for exactly
what that job proves and what it does not.

---

## [1.0.0] — 2026-09

Initial implementation of the Obsidian Network.

### Added

* **Obsidian Core**: deterministic binary encoding with domain-separated
  hashing, blocks committing to transaction/event/state roots, a round-robin
  validator schedule, median-time-past timestamp rules, a p2p layer with peer
  exchange and scoring, an RPC server, an indexer, and the transaction
  executors.
* **Four isolated networks** — mainnet 7777, testnet 7778, staging 7779,
  devnet 7780 — with distinct genesis documents, ids, ports and address
  prefixes, and a data directory that refuses to be reused across networks.
* **Supply**: a hard cap of 21,000,000 OBS enforced inside every issuance, with
  only two issuance sources and no administrative mint path.
* **Genesis**: 100,000 OBS awarded exactly once to the first protocol-valid
  mining claim — not at registration — atomically designating that wallet as the
  on-chain treasury. Registration credits zero.
* **Mining**: claims every 4 hours, at most 6 per 24 hours, 0.001 OBS/day
  initially, decreasing 0.5% per 100,000 active miners to a floor of 0.0002
  OBS/day, with replay and idempotency protection and no dependence on any
  device clock.
* **Gas**: 0.02% of the transferred amount, capped at 0.01 OBS, returning to the
  mining pool.
* **Non-custodial wallets** generated from cryptographically secure randomness,
  never derived from identity, with client-side signing and keys that never
  reach a server.
* **Invite-only registration** with server-side Google token validation and a
  server-enforced limit of five invites per account.
* **Applications as chain state**: the explorer (which never exposes wallet
  balances), OBS Social, ONS `.obs` names, the Time Capsule Wall, and Obsidian
  Circle land with GLV/ILV/MSP pricing.
* **Obsidian Interface**: a self-hostable reader serving the site directories,
  discovering multiple healthy nodes and failing over between them.
* **Cloudflare worker** as a cache and gateway whose outage cannot stop
  consensus.
* Release packaging with SHA-256 manifests and a verification script.

### Removed

The `$5 USDT WAC` in all its forms — activation, purchase, generation and
WAC-gated withdrawal — along with the 3,000,000 OBS genesis allocation, mining
KYC, and any native or personal exchange. Their absence is asserted at runtime
by `GET /audit/compliance` and documented in `docs/removal-report.md`.

[1.1.0]: https://github.com/EmoluxLabs/Obsidian-Network/releases/tag/v1.1.0
[1.0.0]: https://github.com/EmoluxLabs/Obsidian-Network/releases/tag/v1.0.0
