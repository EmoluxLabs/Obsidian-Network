# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

The authoritative params hash for a release is whatever `GET /params` reports on
a node running it. For 1.2.0 that is `dbbf8511bfe5bee493f80f3dd23a047a`.

---

## [1.2.11] — 2026-10-02

Documentation. No code change to the node or the server; `PROTOCOL_VERSION`
stays 1.2.0 and the params hash is unchanged.

### Fixed

The product pages were corrected in 1.2.8–1.2.10, but the documentation had
drifted exactly the same way and still priced the protocol in dollars:

* `docs/circle.md` — land "bounded between **$100 and $30,000 per m²**",
  appreciation "capped at $30,000/m²", depreciation "floored at $100/m²", and
  a purchase price "converted to OBS at the protocol oracle price". The real
  band is **0.01–5 OBS per m²** with no conversion at all.
* `docs/ons.md` — the fee table said "$5.00 equivalent, paid in OBS at the
  protocol price", followed by a paragraph explaining that registration fails
  with `ERR_ORACLE_UNAVAILABLE` when fewer than two sources are fresh. The fee
  is **0.05 OBS**, and an empty feed can no longer close a feature it does not
  price.
* `docs/social.md` — "$50 equivalent … `social.businessPagePriceUsd = 50.00`,
  converted at the oracle median" → **0.005 OBS**, `social.businessPagePrice`.
* `docs/faq.md`, `docs/node-runner-rewards.md`, `docs/removal-report.md` and
  `docs/IMPLEMENTATION-REPORT.md` — the same `$50` business page and
  `$100–$30,000` GLV figures in revenue tables and summaries.

Deliberate mentions of dollars are kept and are all denials or history: "where
did the $5 activation go", "no $5 activation", the removal report's record of
the deleted `$5 USDT` gate, and one defect record quoting its own symptom.

### Added

* The copy guard added in 1.2.10 now covers `docs/*.md` as well as the page
  sources and generated HTML — five checks in total. Documentation is part of
  the product surface, and it drifted for the same reason the pages did:
  nothing was checking it.

### Tests

Interface 175 (was 174). Core 244. Invariants 55.

---

## [1.2.10] — 2026-10-02

Interface only. No consensus change; `PROTOCOL_VERSION` stays 1.2.0.

### Fixed

* **Obsidian Circle still advertised land in dollars.** Its pricing paragraph
  read "each first-level division carries a GLV from **$100 to $30,000 per
  m²**… raises the GLV by 25 basis points up to the **$30,000 ceiling**". Land
  was repriced into OBS in 1.2.0 and the real band is **0.01 – 5 OBS per m²**,
  so the page quoted figures off by six orders of magnitude in a currency the
  protocol does not use. It now describes the band in OBS and the division
  detail shows a **Protocol band** row read live from `/params`
  (`circle.minGlvObs` – `circle.maxGlvObs`).

  This was the last dollar price in the product, and it was found by scanning
  the shipped bundles rather than by reading the pages — four manual passes
  over the copy had missed it.

### Removed

* The USD helpers in `web/src/lib/ui.ts` — `usd`, `usdDollars`,
  `usdMicroFromDollars`, `usdText` — and the oracle readers
  `oraclePriceText` / `oraclePriceMicro`. Every one was unused by every page
  after the repricing. They are deleted rather than left in place: keeping
  dollar formatters invites the next page to reach for one and reintroduce a
  dependency the protocol deliberately does not have. `GET /oracle` still
  exists for reporting, and no fee or state transition reads it.
* Their unit tests went with them; `format.test.ts` and `ui.ts` both say why.

### Added

* `tests/no-usd-copy.test.ts` — four checks over the page sources and the
  generated site HTML: no literal dollar amount may be shown to a user
  (the standing denial "no $5 activation" is the one deliberate exception),
  no copy may claim a feature is gated on a price feed, no page may read
  `registrationFeeUsd` / `businessPagePriceUsd` / `minGlvUsd` / `maxGlvUsd`,
  and no generated shell may contain a dollar price. Prose is not covered by
  any type and no fixture catches it; this is the check that would have found
  the Circle paragraph in 1.2.0.

### Tests

Interface 174 (177 minus the 7 deleted USD-helper cases, plus 4 new copy
guards). Core 244 unchanged. Invariants 55.

---

## [1.2.9] — 2026-10-02

Interface copy and a repository-wide dead-code sweep. No consensus change;
`PROTOCOL_VERSION` stays 1.2.0 and the params hash is unchanged.

### Fixed

* **The landing page still described an oracle the protocol no longer uses.**
  One pillar listed "oracle prices" among the things the platform keeps as
  chain state, which reads as the network needing an external USD source to
  work. It does not. That pillar now says prices are consensus parameters
  denominated in OBS and that no exchange rate is required.
* **The developer page carried a whole "Prices and the oracle" section**
  claiming "dollar-priced features (ONS registration, business pages, land)
  convert through the protocol price" and would fail with
  `ERR_ORACLE_UNAVAILABLE`. All of that stopped being true in 1.2.0. It now
  documents the OBS parameter table, and says plainly that a node may still
  publish an OBS/USD observation for reporting while no fee and no state
  transition reads it. Its verification snippet also stopped naming the
  long-gone 1.0.0 archive.

### Changed

* `noUnusedLocals` and `noUnusedParameters` are now on for obsidian-core and
  the interface server. Only the browser bundle enforced them, which is how
  four dead oracle imports (`usdMicroToSeals`, `sealsToUsdMicro`,
  `requirePrice`) survived the repricing that removed their reason to exist.
  The sweep cleared fourteen findings in total: unused imports in `chain.ts`,
  `proposer.ts`, `initialize.ts`, `node.ts`, `index.ts`, `node-registry.ts`
  and `ons.ts`; a dead `connecting` field in `p2p.ts`; dead locals in
  `mining/rules.ts`, `land.ts` and `ons.ts`; and four unused parameters marked
  `_ctx` so the signatures stay stable.

  One of these was checked as a possible consensus bug and cleared:
  `mining/rules.ts` computed `storedCycleStart` and never used it, while
  cycle comparison used the raw stored value. Every write of
  `mining.cycleStartAt` goes through `alignedCycleStart()`, so the comparison
  was already correct and no claim accounting was affected.

### Tests

Core 244, interface 177, invariants 55, cluster e2e 13, worker 7 — unchanged
and all green, which is the point: this release removes code, it does not
change behaviour.

---

## [1.2.8] — 2026-10-01

Interface and docs. No consensus change; `PROTOCOL_VERSION` stays 1.2.0.

### Fixed

* **Three pages still priced things in dollars after the protocol stopped.**
  1.2.0 repriced every protocol fee into OBS and the node began sending
  `ons.registrationFeeObs`, `ons.renewalFeeObs` and
  `social.businessPagePriceObs`. The browser kept reading the removed
  `…Usd` fields, so:
  - **ONS registration was dead.** The page computed the fee from
    `params.ons.registrationFeeUsd` (undefined on every real node) at an
    oracle median, and when the feed was unusable — the normal state of a
    chain that prices nothing in dollars — it displayed "registration is
    closed right now". A user could never register a name.
  - **Business page purchase was dead**, for the same reason, and would have
    signed a wrong amount if a feed had existed.
  - **The landing page advertised the wrong model**, showing a "Protocol
    price" tile and stating that "features priced in dollars (names, business
    pages, land) refuse to execute while the protocol price is stale".
  All three now read the OBS fee from `/params`. The landing page shows the
  actual registration fee and states plainly that no protocol fee consults a
  price source. ONS stays open on a chain with no feed and refuses to guess
  only when it cannot reach a node at all.
* Removed unused `usdMicroToSeals` / `sealsToUsdMicro` imports left in the
  land and social executors by the repricing.

### Why the tests missed it

`pages.test.ts` fixtures were updated to the new *behaviour* but kept the old
*field names*, so the suite asserted against a `/params` shape no node sends.
Fixed, and three new guards added:

* **Live contract test** — asserts the real node's `/params` carries the `…Obs`
  fields, that the `…Usd` fields are gone, and that the values are the agreed
  ones (names 0.05, business page 0.005, bond 50, land band 0.01–5).
* **Live ONS test** — on a chain whose oracle is unusable, the page must still
  show `0.05 OBS` and keep the register button enabled.
* **Static proxy contract** — every RPC path `client.ts` can call must appear
  on the interface proxy allowlist, compared by reading both files. This is
  the check that would have caught the `/wallet/balance` outage in 1.2.6.

### Tests

Interface 177 (was 173). Core 244 unchanged.

---

## [1.2.7] — 2026-10-01

Interface only. No consensus change; `PROTOCOL_VERSION` stays 1.2.0.

### Fixed

* **The wallet could not show a balance and mining could not claim.** The
  interface's read proxy refuses any route not on an explicit allowlist — the
  right design, but three routes the wallet and mining pages depend on were
  never added to it. Every balance lookup, fee quote and nonce fetch came back
  `400 route "/wallet/balance" is not exposed by the interface proxy`, so a
  correctly installed interface showed no balance and refused to claim.
  `/wallet/balance`, `/wallet/quote` and `/wallet/<address>/next-nonce` are now
  allowlisted. The `/wallet/` namespace itself is **not** opened: the nonce
  route is matched by a bounded pattern, and anything else under `/wallet/` is
  still refused.

### Tests

Interface 173 (was 171). Two new cases under "node proxy": the three wallet
routes must proxy (POST bodies included), and `/wallet/keys`, `/wallet/export`,
`/wallet/` and a traversal attempt must still be rejected.

`live-ui.test.ts` now carries a warning at the top of its fetch harness: it
answers `/api/rpc` itself, so it never exercises the allowlist, and any new
route a page calls needs a `server.test.ts` case too. That blind spot is how
this shipped.

---

## [1.2.6] — 2026-10-01

Node and docs. No consensus change: the params hash and the genesis hash are
unchanged and `PROTOCOL_VERSION` stays 1.2.0, so a 1.2.0 node peers with this
one.

### Added

* **`GET /metrics` — Prometheus text exposition.** Closes the monitoring gap
  `docs/DEPLOYMENT-GUIDE.md` has carried since 1.0.0, where the only way to
  watch a node was to poll `/status` and parse it yourself. Sixteen series,
  every one labelled `network` and `chain_id` so a single Prometheus can
  scrape several networks without conflating them: chain height, peers,
  mempool depth, supply and max supply in OBS, mining-pool balance, active
  miners, accounts, transactions, mining claims, names, validators, whether
  the genesis allocation is claimed, whether the supply invariant holds,
  whether the node believes it is syncing, and process uptime.

  The route exposes no address, no balance and no identity, and a test asserts
  that: it matches the output against bech32 addresses of all four networks
  and against anything key-shaped. Nothing in consensus reads it. Supply is
  published in OBS as a float because Prometheus has no integer type; the
  exact 18-decimal seal amounts stay on `/supply`.
* `docs/DEPLOYMENT-GUIDE.md` §D11 documents the metric names and three alerts
  worth having on day one, and the "genuine gaps" list is corrected: metrics
  exist, dashboards and alerting rules still do not.

### Fixed

* The three-node cluster suite checks its ports before starting. An
  interrupted run left nodes on 39630-39635, and the next run then reported
  four unrelated consensus failures five minutes later instead of the real
  cause. It now aborts in under a second naming the port and how to clear it.

### Tests

Core 244 (was 242): two new `/metrics` tests in the RPC hardening suite —
one for the exposition format and the sample values, one for what must never
appear in it.

---

## [1.2.5] — 2026-10-01

No runtime change from 1.2.4: the node, the server and every page bundle are
byte-identical in behaviour, and `PROTOCOL_VERSION` stays 1.2.0. This release
exists so the archives themselves carry the guard tests and the upgrade
instructions, since the project's rule is that operators run from a verified
archive rather than from a working tree.

### Added

* `obsidian-interface/tests/shipped-bundle.test.ts` — asserts against the file
  a browser is actually served, not the source it was built from: the wallet
  bundle must derive through `Wallet.create(network.addressHrp, …)`, must
  contain no literal mainnet prefix as a derivation input, and the content hash
  in `wallet/index.html` must equal the hash of the bundle on disk. The wallet
  bug survived two releases by hiding in the gap between source and artefact.
* `docs/DEVNET-TERMUX-RUNBOOK.md` — a section on upgrading an interface that is
  already open in a browser, including the one-line check
  (`curl -s localhost:8788/wallet/ | grep -o 'src="[^"]*"'`) and the cache
  clear needed once when coming from 1.2.3 or earlier.

### Verified

The 1.2.4 archives were extracted and run end to end before this release: the
node reported `"version":"1.2.4"` on devnet chainId 7780 and produced 55
blocks; all twelve site shells returned 200 with distinct hashed bundle URLs;
`sha256(public/js/wallet.js)[0:16]` equalled the `?v=` in the markup; a hashed
request answered `Cache-Control: public, max-age=31536000, immutable` and a
bare one `no-store`; a `dobs1…` address returned 200 from `/wallet/balance`
while a mainnet-prefixed one returned 400.

### Tests

Core 242, interface 171, invariants 55, cluster e2e 13, Cloudflare worker 7.

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
