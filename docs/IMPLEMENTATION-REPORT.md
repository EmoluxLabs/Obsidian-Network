# Obsidian Network — implementation report

**Version 1.0.0 · protocol 1.0.0 · fourteen deliverables, fifteen answers.**

This report follows the fifteen required points in order. It states what exists,
what was verified, and — where it applies — what is **not** production ready. No
point is answered with a filename as proof of function: every claim below is tied
to a command whose output was observed, and the two items that could not be
verified in the development environment are labelled as such instead of being
dressed up.

---

## 1. Core node and consensus — **done, tested**

`obsidian-core/` contains the node: block production and validation, the state
machine, canonical encoding, the p2p layer, the RPC server, the indexer and nine
transaction executors.

* Deterministic binary encoding (`src/protocol/encoding.ts`) with one canonical
  encoder and no JSON in any hashing or signing path; every hash is domain
  separated (`src/protocol/domains.ts`).
* Blocks commit to a transactions root, an events root and a **state root** that
  every node recomputes. Two nodes that compute different state from the same
  block are detecting a bug or a lie, not disagreeing about policy.
* Fork choice is most-accumulated-work → length → lowest header hash; reorgs
  deeper than 256 blocks are refused rather than silently accepted.
* Four isolated networks (mainnet 7777, testnet 7778, staging 7779, devnet 7780)
  with distinct genesis documents, ids, hashes, ports and address prefixes; a
  data directory written by another network is refused at startup.

**Verification:** `cd obsidian-core && npm ci && npm run build && npm test` →
**154 tests in 7 files, all passing** (consensus 42, applications 27, protocol
security 19, RPC hardening 16, crypto/amounts 26, mining schedule 17, peer retry
and ban policy 7).

On top of that, `node --test tests/e2e/cluster.test.mjs` (11 tests) starts three
real nodes chained by seed peers and drives them end to end — a mining claim, a
payment with gas, a replay, an oracle submission, an ONS registration and an
explorer read — asserting that all three nodes independently agree on height,
balances, name records and supply. That run is part of the packaging gate.

## 2. Maximum supply and issuance — **done, tested**

* Hard maximum **21,000,000 OBS**, enforced on every issuance path.
* The only issuance paths are the one-time genesis allocation and mining rewards.
  There is no administrative mint, and a supply-violating transition is refused
  with `SUPPLY_EXCEEDED`.
* The supply invariant (`balances + mining pool + locked capsule commitments +
  validator bonds = totalSupply ≤ 21,000,000`) is asserted by `verifySupplyInvariant()`
  and exposed at `GET /supply`.

**Verification:** `tests/security/protocol-security.test.ts` asserts the
invariant holds after a refused over-issuance; a live node answers
`curl -s localhost:8630/params | jq .maximumSupplyObs` → `21000000.000000000000000000`.

## 3. Genesis and the treasury wallet — **done, tested**

* The legacy 3,000,000 OBS allocation is gone: `legacyGenesisAllocationRemoved`
  is the constant `0n`, and a running node reports
  `legacyGenesisAllocation.present = false`.
* The new allocation is **100,000 OBS awarded atomically to the first
  protocol-valid mining claim** — not at registration, not to a founder address.
  Awarding it flips `genesisAllocationClaimed` from `false` to `true` and records
  `genesisRecipient`, and all nodes converge on the same recipient.
* That recipient's wallet **is** the on-chain treasury wallet; platform revenue is
  routed to it and user funds never are. It is readable at `GET /status`
  (`treasuryWallet`) and `GET /genesis`.
* Registration on the interface creates an account with **0 OBS**
  (`registry.newAccountBalanceObs = 0`).

**Verification:** the security suite mines the first claim on a fresh chain
(allocated 100,000.000166666666666666 OBS) and proves a second miner receives only
the ordinary reward; a live devnet reproduces the same numbers on all three nodes.

## 4. Wallets — **done, tested**

* Created **immediately after registration** (and without any registration at
  all): a wallet needs a passphrase, not an account.
* Keys come from the WebCrypto CSPRNG and are never derived from an email,
  Google subject id, username, date of birth, account id or anything else
  guessable; the recovery phrase is 24 BIP-39 words at `m/44'/7777'/0'/0/0`.
* Exported as address + private key + recovery phrase, as a downloadable text file.
* At rest in the browser the vault is PBKDF2-SHA256 (210,000 iterations) →
  AES-256-GCM; a wrong passphrase or a tampered vault fails the tag check.
* Signing happens in the page, with the **same encoder the node runs**: the
  interface build copies core modules into `web/core` and *fails* if any of them
  imports a Node built-in, then a second check refuses node built-ins and
  `process.env` reads in the shipped bundles.

**Verification:** `npm --prefix obsidian-interface run build` ends with
`browser bundles are free of node built-ins and process.env reads ✓`;
`tests/server.test.ts` asserts the account store never contains private key
material while still storing the advisory address the user chose to publish.

## 5. Authentication — **done, tested**

* **Invite-only.** The first account bootstraps a deployment; every later account
  needs an unused invite.
* Google ID tokens are verified **server-side** against Google's JWKS (RS256,
  issuer, audience, expiry, `email_verified`, ±60 s clock skew). The client's
  `isGoogleUser` claim is never read — a forged token is rejected with
  `ERR_UNAUTHORIZED` even when the body announces it as a Google user.
* At most **5 invites per account**, enforced by the store and the HTTP layer.
* Sessions are opaque, HttpOnly, SameSite=Lax cookies with a 14-day TTL,
  destroyable at logout.

**Verification:** `obsidian-interface/tests/{auth,server,store}.test.ts` — 41
tests cover token forgery, wrong audience/issuer, expired and not-yet-valid
tokens, unverified email, invite reuse, the invite cap and session lifecycle.

## 6. Mining — **done, tested**

* Protocol-authoritative claim: the node supplies eligibility, the next claim id
  and sequence, and the reward. **The browser or device clock is never
  authoritative** — eligibility is computed from the chain head timestamp.
* One claim every 4 hours, at most 6 per 24-hour cycle, one claim per wallet per
  block.
* 0.001 OBS/day at launch → **0.000166666666666666 OBS per claim**; −0.5% per
  100,000 active miners, hard floor 0.0002 OBS/day. An active miner is a wallet
  with at least one valid claim in the last 30 days.
* Every claim carries a unique claim id; replay, stale sequence, stale nonce and
  duplicate submission are all refused. Multi-tab or multi-device races resolve to
  a single claim, because the protocol — not the page — owns the counter.
* Withdrawals require **no KYC and no WAC**: a mined balance is moved by an
  ordinary payment with the ordinary gas.

**Verification:** `tests/unit/mining-schedule.test.ts` (17) plus the mining
sections of `tests/security/protocol-security.test.ts`, which assert
`ERR_MINING_TOO_SOON`, `ERR_MINING_CYCLE_LIMIT`, replay refusal, the genesis claim
consuming cycle slot 1, and `claimSequence`/`minedSupply` after two claims.

## 7. Gas — **done, tested**

* 0.02% of the transferred amount (2 basis points), capped at 0.01 OBS,
  deterministic and node-validated; a transaction that under-declares is refused
  with `ERR_BAD_GAS`.
* 100% returns to the **Mining Pool**.
* The browser computes nothing of its own: `expectedGas()` is imported from the
  core module, so the wallet's number and the node's number cannot drift.

**Verification:** `tests/security/protocol-security.test.ts` asserts
`expectedGas(1000 OBS) === 0.01 OBS`, `expectedGas(1 OBS) === 0.0002`,
`basisPoints === 2`, and a node-observed pool delta after a signed payment.

## 8. Removed mechanisms — **done, verifiable**

`$5 USDT` activation, WAC purchase/generation, WAC-gated withdrawal, the
3,000,000 OBS genesis allocation, mining KYC and the native exchange do not exist
in the code. This is not asserted in prose: a running node answers

```bash
curl -s localhost:8630/audit/compliance | jq
# wac.present=false, legacyGenesisAllocation.present=false, signupAllocation.present=false,
# miningKyc.present=false, miningWithdrawalRequiresWac.present=false,
# nativeExchange.present=false, explorerExposesBalances.present=false
```

The removal is a constant in `src/protocol/params.ts` (`legacyGenesisAllocationRemoved: 0n`,
`wacEnabled: false`, `miningKycRequired: false`, `nativeExchangeEnabled: false`),
so the state machine cannot quietly reintroduce it. Procedure and expected output:
`docs/removal-report.md`.

## 9. Applications — **done, tested**

| App | State |
| --- | --- |
| Wallet | non-custodial, browser-generated keys, send/receive, local signing, export |
| Explorer | blocks, transactions, names, parcels, capsules; **never wallet balances**, masked addresses, own id format |
| OBS Social | profiles, posts, comments, follows, DMs (client-side encrypted), tipping 100% to the creator, business pages at $50-equivalent with the 70/30 split (30% → treasury) |
| ONS | `.obs` names mapped to exactly one wallet, transferable, **mapping stored as blockchain state** |
| Time Capsule Wall | immutable commitments, ≥0.0001 OBS lock, unlock transfers the lock to the Mining Pool without the creator online, 1000× Time Travel preview paid to the pool once per capsule per account for 30 s, plus capsule statistics |
| Obsidian Circle | Earth → country → state → city → district → street → parcelle navigation, search by place/landmark/GPS, GLV/ILV/MSP fields, USD pricing paid in OBS at the protocol price, one ≤1 m² plot per transaction with the GLV updated between purchases, no retroactive benefit for the buyer, buybacks that pay the current GLV and reduce it, a marketplace that never moves the GLV, and gifting at standard gas |

**Verification:** `tests/integration/applications.test.ts` (27 tests) exercises
ONS registration/transfer/update, capsule create/preview/unlock economics, land
protocol purchase with price-mismatch refusal, buyback, marketplace sale, gift,
social profile/post/follow/tip, business pages and the indexer's transaction
descriptions. `tests/security/rpc-hardening.test.ts` asserts the explorer surfaces
never return balances and never echo key material.

## 10. Interface, multi-node and failover — **done, tested**

* The interface discovers and reads **multiple nodes**, scores them by height and
  latency, fails over automatically, and refuses to blend two chains (a differing
  genesis id is flagged, and the majority chain serves reads).
* Reads never touch a node directly from the browser: they go through
  `/api/rpc?path=…`, an **exact-route allowlist** that rejects traversal and
  anything outside the list; a failed node is skipped and the next tried.
* When nothing is healthy the interface answers `503 ERR_NO_HEALTHY_NODE` rather
  than inventing data.
* Strict security headers: CSP with `script-src 'self'`, `frame-ancestors 'none'`,
  `base-uri 'none'`, `form-action 'none'`, `nosniff`, `DENY`, `no-referrer`. The
  account page — the only surface that needs a third party — is the only place
  where `accounts.google.com` is allowed, and no page anywhere uses inline script.
* **Self-hostable**: flags/environment configuration, `refuses-to-start`
  validation of its own prerequisites, systemd unit, nginx config, Dockerfile and
  compose file, all under `obsidian-interface/deployment/`.

**Verification:** `obsidian-interface/tests/` — **61 tests** over the real HTTP
server: invite-only registration, invite reuse, the five-invite cap, session
lifecycle, origin policy, header policy, allowlist rejection, failover between a
healthy and a dead node, honest 503s, 413 on oversized bodies, and an honest 404
instead of a mismatched fallback page. During development the interface was run
against the three-node devnet: `/api/nodes` reported all three healthy
(heights 33/33/33, latencies 16–23 ms) and `/api/rpc` served live chain reads.

## 11. Cloudflare as gateway and hosting only — **done, tested**

* `cloudflare/` ships a worker whose contract is *forward, cache, stay out of the
  way*: writes and session routes are never cached, cached chain reads keep the
  `x-obsidian-node` header naming the node that produced the data, and an
  unreachable origin produces an honest `ERR_ORIGIN_UNREACHABLE` instead of a
  fabricated response.
* Cache rules, WAF and rate limits, TLS and DNS are documented as code with
  reasons (`cloudflare/cloudflare-config.md`, `cloudflare/terraform/main.tf`).
* **A Cloudflare outage cannot stop consensus**: nothing in the node consults it,
  no node URL is Cloudflare-only, and DNS-only records are used for p2p and seeds.

**Verification:** `cloudflare/test/worker.test.mjs` — 7 tests, passing (cache hit
naming its node, POST never cached, session routes bypassing cache, honest 503,
CSP not weakened).

## 12. Release integrity and packaging — **done, with one honest caveat**

`scripts/package-releases.sh` builds and tests all three components, then emits:

```
releases/obsidian-core-1.0.0.{zip,tar.gz}
releases/obsidian-interface-1.0.0.{zip,tar.gz}
releases/obsidian-cloudflare-1.0.0.{zip,tar.gz}
releases/obsidian-node-operator-1.0.0.{zip,tar.gz}      # what an operator installs
releases/obsidian-interface-selfhost-1.0.0.{zip,tar.gz} # ready-to-serve interface
releases/obsidian-network-source-1.0.0.tar.gz           # git archive of the commit
releases/SHA256SUMS
releases/MANIFEST.json          # version, commit, networks, protocol constants, asset sizes
releases/RELEASE-NOTES-1.0.0.md
```

`scripts/verify-release.sh` refuses any archive not listed in `SHA256SUMS`,
extracts into a temporary directory, checks entry points, and with `--with-tests`
runs the shipped suite. Nodes compare core version, protocol version, network id
and genesis id during the handshake, so a mismatched binary is rejected by the
network instead of quietly showing a different chain.

**The caveat, in full:** the archives are built and checksummed, but **the Docker
images were not built**, because Docker is not available in the development
environment used to write this repository. The Dockerfiles, compose files and
entrypoints are structurally valid and consistent with the binaries they copy, and
`deployment/docker/verify.sh` exists to build, start, health-check and probe them —
but until that script has been run on a machine with Docker, **the container
recipes are validated by inspection only**. They are marked *not production
verified* rather than *working*.

## 13. Documentation — **done**

`docs/` contains 17 documents: protocol, mining, wallet, ONS, capsules, circle,
social, explorer, security model (including a candid limitations section), FAQ,
removal report, node operator guide, self-hosting guide, API reference,
transaction format, release verification, and this report. Every document
describes observable behaviour and names the command that shows it.

## 14. Coin logo and brand assets — **done, authored here**

No image file was ever present in the workspace, so the mark was **authored as
geometry** in `assets/logo.svg` (a faceted obsidian hexagon with a cyan core) and
rasterised by `assets/render-logo.py`, a dependency-free renderer, into
`logo-512.png`, `logo-192.png`, `logo-32.png`, `favicon.ico` and a web manifest.
The same assets are served by the interface at `/assets/`. If a different official
logo exists elsewhere, replace `assets/logo.svg` and re-run
`python3 assets/render-logo.py` — nothing else references the geometry.

## 15. Final status — **what is verified, what is not**

**Verified by automated tests in this workspace (233 tests, all passing):**

| Suite | Tests | Covers |
| --- | --- | --- |
| `obsidian-core` unit | 50 | canonical encoding, hashing, addresses, amounts, mining schedule, peer retry policy |
| `obsidian-core` integration | 69 | consensus, blocks, reorg rules, all nine transaction types, indexer |
| `obsidian-core` security | 35 | replay, nonce, gas underpayment, wrong chain, supply cap, explorer masking |
| `obsidian-interface` | 61 | token verification, invites, sessions, store hygiene, node pool, HTTP server, site-root discovery |
| `cloudflare` | 7 | cache/proxy semantics, honest failures, no CSP weakening |
| `tests/e2e/cluster.test.mjs` | 11 | three real nodes: genesis claim, payment + gas, replay, oracle, ONS, supply invariant, explorer masking, protocol-time eligibility |

**Verified by running the system:** the cluster suite above *is* that run — three
Obsidian Core nodes started from the built output, chained by seed peers, and
driven through claim → payment → oracle → ONS → explorer, with all three nodes
agreeing on height, balances, name records and supply; the interface separately
reads live data from all three (health, heights, latency) through its allowlisted
proxy.

**Not verified, and stated as such:**

1. **Docker images** — no Docker in the development environment (point 12).
2. **Google OAuth against the live endpoint** — token verification is tested
   against injected RSA keys and a JWKS document; the network path to Google was
   not exercised here.
3. **Long-run stability** — no multi-day soak test was performed, so memory
   growth over weeks of operation is unknown.
4. **A real browser session** — the page code is type-checked, bundled and
   browser-safety-checked, and every server interaction is tested over HTTP, but
   no headless browser drove the UI in this environment.
5. **Economic parameters** — the mining schedule, gas rate, land GLV formula and
   oracle bounds are implemented exactly as specified and tested for correctness;
   whether they are the *right* numbers for production is a design decision
   outside what tests can answer.

Everything else in this report is backed by a command whose output was observed,
and every claim about absent mechanisms can be re-checked against a running node
in about ten seconds with the commands in `docs/removal-report.md`.
