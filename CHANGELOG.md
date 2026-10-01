# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

The authoritative params hash for a release is whatever `GET /params` reports on
a node running it. For 1.2.0 that is `dbbf8511bfe5bee493f80f3dd23a047a`.

---

## [1.2.4] — 2026-10-01

Interface only. No consensus change; `PROTOCOL_VERSION` stays 1.2.0.

### Fixed

* **An upgraded deployment could still run the old wallet bundle.** Page
  bundles were served from stable URLs (`/js/wallet.js`) with
  `Cache-Control: public, max-age=300`, so a browser that had cached the 1.2.1
  wallet kept deriving mainnet `obs1…` addresses on devnet after its owner had
  installed the fix — the bug looked unfixed because the fixed code was never
  fetched. `build-sites.mjs` now writes a content hash into every asset URL
  (`/js/wallet.js?v=<sha256-16>`, same for the stylesheet), and the server
  caches an asset only when it is requested with a hash, then as `immutable`.
  Anything asked for without one, and every site shell, is `no-store`.

### Tests

Interface 169 (was 168): the real generated `wallet/index.html` must reference
a hashed bundle, and the server must cache a hashed request while refusing to
cache a bare one.

---

## [1.2.3] — 2026-10-01

Node and interface. No consensus change: the params hash, the genesis hash and
`PROTOCOL_VERSION` (1.2.0) are unchanged.

### Fixed

* **`wallet new` ignored `--network`.** The CLI derived every wallet with the
  default `obs` prefix, so `wallet new --network devnet` printed a mainnet
  `obs1…` address that the devnet node could only answer `ERR_BAD_ADDRESS` to.
  This is the command-line twin of the browser bug fixed in 1.2.2 and was found
  by running the published Termux runbook end to end. The command now resolves
  the network with `getNetwork()` and derives with its `addressHrp`; the output
  also reports `network`, `chainId` and `addressHrp`, and the warning text says
  which network the wallet belongs to.
* `deriveWallet`, `deriveWalletRange`, `generateKeyPair` and
  `keyPairFromPrivateKey` now accept the address prefix as an argument instead
  of silently applying the mainnet default.

### Tests

Core 242 (was 240): a new `tests/unit/cli-wallet.test.ts` runs the built CLI
once per network and asserts each address carries that network's prefix, is
valid under it, and is invalid under all three others.

---

## [1.2.2] — 2026-10-01

Interface only. No consensus change: the params hash, the genesis hash and
`PROTOCOL_VERSION` (1.2.0) are unchanged, and a 1.2.0 node peers with a 1.2.2
node. Node operators do not have to upgrade; anyone running the web interface
should.

### Fixed

* **The browser wallet derived mainnet addresses on every network.** The wallet
  library defaulted its address prefix to `obs`, so a wallet created while the
  interface was pointed at devnet was handed an `obs1…` address. The node then
  correctly refused every claim and payment signed by it with
  `not a valid address for this network`, which read as a broken wallet. The
  prefix is now a required argument: `Wallet.create` and `Wallet.fromPhrase`
  take the connected network's `addressHrp`, the vault records it, and legacy
  vaults are back-filled from the address they already hold.
* **The wallet and mining pages now refuse to guess.** Both resolve the network
  from `GET /network` during boot. If no network can be learnt, the wallet page
  does not offer to create a wallet at all rather than deriving blind. If a
  stored vault belongs to another network, both pages show which network the
  wallet is for and which one the interface is on, and offer to re-derive the
  same keys under the right prefix (`switchNetwork()`); the mining page blocks
  claiming with that explanation instead of letting the node reject a signed
  claim.

### Security

Not exploitable, and now proven by test rather than by inspection.
`verifyTxSignature` binds `ctx.addressHrp` into the signed message, so a
foreign-prefix sender fails `ERR_BAD_SIGNATURE` before any balance is touched.
Seven new tests assert it directly: one key pair yields four distinct
addresses across `obs`/`tobs`/`sobs`/`dobs`, `isValidAddress` rejects every
foreign prefix, a real signature valid under `obs` is invalid under `dobs`, and
on a live devnet harness a mainnet-addressed mining claim, a `tobs1` sender and
a mainnet recipient are each rejected. No supply path was ever affected.

### Tests

Core 240 (was 233); interface 168 (was 164), including two cases in
`live-ui.test.ts`, the only suite that runs against a non-mainnet node.

---

## [1.2.1] — 2026-10-01

Interface only. No consensus change: the params hash and the genesis hash are
unchanged, and a 1.2.0 node peers with a 1.2.1 node.

### Fixed

* **Sign-in was impossible from a browser.** Browsers send an `Origin` header
  on same-origin POSTs, not only on cross-origin ones. The interface compared
  that header against an allowlist that is empty by default and rejected
  anything missing from it, so the account page's own requests came back
  `403 origin not allowed` — registration, login, MFA, invites and wallet
  linking all failed, on every deployment that had not manually allowlisted
  its own URL. The server now recognises its own origin (scheme from
  `x-forwarded-proto` only when `trustProxy` is set) before consulting the
  allowlist. A genuinely foreign origin is still refused, and a same-origin
  caller still gets no CORS headers.

  Found by a user, not by the suite: every existing test drove the API with
  bare `fetch` and curl, which send no `Origin` at all. Four tests now drive
  the account routes the way a browser does, and they fail against the old
  code.

---

## [1.2.0] — 2026-10-01

**Consensus-breaking.** The params hash becomes
`dbbf8511bfe5bee493f80f3dd23a047a` and the mainnet genesis hash becomes
`42735b1aabd4dd9252cd5e37a9e058dcfea71bbcff758b679c3b93cde51acb31`. A node on
1.1.0 will not peer with a node on 1.2.0, and `MIN_CORE_VERSION` is raised to
1.2.0 to make that refusal explicit rather than mysterious.

### Changed — every price the protocol charges is now in OBS

No consensus path consults an external price source any more. An oracle outage
can slow down reporting; it can no longer leave the chain unable to price
anything, and it can never influence what a block costs.

* **Validator bond: 1,000 OBS → 50 OBS.** Becoming a validator was priced out
  of reach of the people the network is for. Bond mechanics are unchanged: it
  is locked collateral, returned 20,160 blocks (~28 h) after unbonding.
* **ONS names: 0.05 OBS** to register and to renew.
* **Business pages: 0.005 OBS** to create.
* **Obsidian Circle land: starting price between 0.01 and 5 OBS** (previously a
  USD band resolved through the oracle). Appreciation, depreciation and
  buybacks are untouched, and a buyer is still never retroactively repriced.
  `/land/quote` now always answers, where before it returned 503 whenever the
  price feed was stale or under-sourced.

### Changed — sign-in is first-party

Google OAuth is **removed**. No third party decides who may hold an Obsidian
mining account, and the interface cannot be locked out by someone else's token
service. Registration is a Gmail address, a password, an invite code, and then
TOTP multi-factor before mining opens on the account.

* **Canonical Gmail identity, computed server-side.** Dots and `+tags` are
  stripped and `googlemail.com` folds into `gmail.com`, so one inbox gets
  exactly one mining account. The page is never asked whether an address is
  unique; the store rejects a clash with no `await` between the check and the
  insert, so simultaneous registrations cannot both win.
* **Passwords**: minimum 12 characters with letters and digits, stored only as
  salted scrypt hashes (N=32768). **No email verification and no password
  reset** — an email channel would make the mail provider an authority over
  mining accounts. No email is ever sent.
* **Ten single-use recovery codes** (`OBS-RECOVERY-XXXX-XXXX-XXXX`) are issued
  at registration and displayed exactly once, with copy and download, and the
  page will not move on until the user confirms they have written them down.
  Only hashes are stored, so no operator can recover them; a code is removed
  the moment it matches.
* **MFA is TOTP** (RFC 6238, SHA-1, 6 digits, 30 s, ±1 step) verified in this
  process, with the consumed step recorded so a code cannot be replayed.
  `miningEnabled` goes true only after a code is confirmed.
* **Stricter CSP everywhere.** The account page was the one surface that had to
  allow `accounts.google.com`; now every page serves `script-src 'self'`,
  `connect-src 'self'` and `frame-src 'none'`, with no third-party origin in
  the policy at all.
* `OBSIDIAN_GOOGLE_CLIENT_ID` and `--google-client-id` are gone. Nothing
  replaces them — there is no external credential to configure.

### Added

* `obsidian-interface/server/identity.ts` — canonical Gmail, password policy,
  scrypt hashing, recovery codes and TOTP, with no external dependencies.
* `POST /api/auth/{register,login,mfa/setup,mfa/confirm,recover}`, replacing
  `POST /api/auth/google`.
* `obsidian-interface/tests/identity.test.ts`, and new server tests covering
  canonical-address dedupe over real HTTP, TOTP replay refusal, recovery-code
  single use, and the refusal to trust any client-supplied account flag.

### Verified

Core 233 tests, interface 160 tests, 55 protocol invariants, edge-case suite 7,
3-node cluster end-to-end 13. `npm audit --omit=dev`: 0 vulnerabilities.

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
`4c2c37aa2ea29512cee4833151697237c1372ff3`.

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
* **Invite-only registration** with server-side token validation (Google-based at the time; replaced by first-party accounts in 1.2.0) and a
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
