# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

This repository is a **fresh start**: it carries the current protocol line and its releases. The history of earlier lines
(their changelog entries, upgrade notes, remediation reports and archives) is in the git history of this repository and is
deliberately not repeated here, so that nothing in the tree can be mistaken for the build you are running.

The authoritative params hash for a release is whatever `GET /params` reports on a node running it. For this release it is
`12211595855ba405b3d70f6161ef9371` on every network.

---

## [2.0.4]

**Software patch. No consensus change**: protocol stays 2.0.2, params hash `12211595855ba405b3d70f6161ef9371`, every genesis id unchanged; 2.0.2, 2.0.3 and 2.0.4 nodes share one network. Only the core software version (and the interface package that ships with it) moves to 2.0.4.

### Fixed: status strip, no peer or finality card, stale-page guard

Prompted by a report that the home page said "NODE UNREACHABLE" while other sections said active, and that cards reading
"FINALIZED —" and "PEERS 0" were still on screen. Nothing in this tree draws those two cards any more; a page that still
shows them is an **old bundle** (`public/js` is gitignored, so a `git pull` and a restart without `npm run build` keeps serving
the old pages against the new server). That is the likely cause, not a proven one: the report came without the page address
or the message shown beside the badge, and the deployment was not inspected.

- **Interface status strip:** the two reads (connection summary, chain status) are independent. One failing no longer turns the
  strip into "NODE UNREACHABLE"; it says ACTIVE, the network (MAINNET) and the height, and says NODE UNREACHABLE only when both
  fail, with the reason. It never shows a peer count or a finality figure.
- **Interface `/api/rpc?path=/status`:** the `peers` count and the `p2p` block are removed for visitors (finality fields already were).
- **Web App:** the dead "NODE" mock screen in `index.html` no longer carries a PEERS row.
- **Stale-page guard:** `npm run build:web` writes `public/js/build.json` (a fingerprint of `web/src`). The server compares it at start
  (a `warn` line) and reports it as `webBundle` (`current`, `stale`, `missing` or `unchecked`) in `GET /api/health`. It warns; it does
  not refuse to start. Fix: `npm run build` and restart the interface.
- Tests: `obsidian-interface/tests/{node-banner,web-bundle}.test.ts`, `server.test.ts`, `tests/scripts/public-finality-surfaces.test.mjs`.

---

## [2.0.3]

**Software patch. No consensus change: `PROTOCOL_VERSION` stays 2.0.2, the params hash is `12211595855ba405b3d70f6161ef9371`, every genesis id is unchanged, and
2.0.2 and 2.0.3 nodes share one network and peer with each other.** Only the core software version (and the interface package
that ships with it) moves to 2.0.3. This release also carries the two patches that were recorded under "Unreleased" after 2.0.2 (below).

### Changed: how far finality has got is no longer shown (obsidian-core, interface, Web App, extension)

The finalized height, the finalized hash, the finality lag and the producer count behind it are not shown to the public any more.

- **Node RPC:** only the operator (a caller on the node's own machine, with no forwarding header) or a node with
  `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true` receives them. For everyone else `GET /finality` is a `404`, and the finality
  fields are left out of `GET /status`, `GET /readyz` (`checks.finality` and the `finality-lagging` advisory) and `GET /producers`;
  JSON-RPC `getfinality` returns null and `getstatus` omits them. A node answers `/readyz` with the same ready / not ready verdict.
- **Interface:** `/finality` is no longer on the `/api/rpc` allowlist, and finality fields are stripped from proxied `/status` and
  `/producers` bodies, so a node that has not been upgraded cannot leak them through the interface either.
- **Web App and extension:** the FINALIZED row and FINALITY section of the explorer, the FINALIZED HEIGHT and FINALITY rows of the
  extension, and `/finality` in the API screen are gone.
- **Not changed:** the node still computes finality and consensus uses it exactly as before; the desktop node console (a local operator
  tool) still shows it; `/metrics` is documented as a private, operator-scraped endpoint and still carries the finality gauges, so keep it off the
  public internet. ONS name-recovery finalisation is a different thing and is untouched.
- Tests: `obsidian-core/tests/security/rpc-finality-privacy.test.ts`, `obsidian-interface/tests/server.test.ts`,
  `tests/scripts/public-finality-surfaces.test.mjs`, `obsidian-app-web/tests/explorer.test.mjs`.

---

## Also in 2.0.3: peer privacy, peer discovery and background-failure patch (no consensus or protocol change)

Prompted by a report that two of three mainnet nodes repeatedly stop. The production cause is **not established** from the
code (no production access; see [docs/p2p-stability-2.0.2.md](docs/p2p-stability-2.0.2.md)). Real defects found and fixed on
the way; the report says for each whether it was reproduced, tested or only read from the source. The wire protocol, the handshake, the params hash and every
consensus rule are unchanged.

### Changed: peers are no longer published
- Node RPC: `GET /nodes`, JSON-RPC `getpeers` / `getnodes`, and the `p2p` block of `GET /status` now follow the rule `GET /peers`
  already had: full detail for a caller on the node's own machine (no proxy headers) or with
  `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true`; everyone else gets counts (`/nodes`: an empty directory). `GET /peers` counts-only no
  longer includes this node's id, identity or advertised endpoint.
- Interface: `/api/nodes` answers `{ network, live, consensusHeight, genesisMismatch }` and names no node. The table moved to
  `/api/nodes/detail`, which answers only a caller on the server itself. `/peers` and `/nodes` are no longer proxied by
  `/api/rpc`. The `x-obsidian-node` header is now the constant `chain` (a CDN marker), not the node's URL.
- Pages and apps (platform, Web App, wallet web, extension): the node list, the node URLs, latency, peer counts and the
  "Peer detail" row are gone. The Cloudflare worker and Terraform cache only the node-runner registry paths, never `/nodes`.
- Unchanged on purpose: P2P discovery, the desktop app's operator-local peer tables, the interface's internal node pool.

### Fixed: peer discovery and reconnection (obsidian-core)
- Two nodes that dialled each other at the same moment each closed the newer link and both ended with none (reproduced six
  rounds out of six on loopback). Both now keep the link opened by the node with the lower node id; a link
  silent for two ping intervals loses to a fresh one.
- A node that started with one seed never learned the others: it never asked the peers it had dialled for addresses. It now asks
  after every handshake and every 60 s.
- An unreachable address was retried on a fixed schedule up to one hour, with no jitter, and an outbound link that closed
  before the handshake counted as nothing. Delay is now 15 s doubling to **5 min**, varied by ±20 %; misbehaviour keeps its one-hour ban.
- A node no longer dials its own advertised address, and counts dials already in flight when filling its peer set.

### Fixed: background failures could end the process (obsidian-core)
- The chain-sync routine ran as an un-awaited promise with no `catch`; an exception in it was an unhandled rejection, which ends
  a Node.js process. Sync, block-production, agent, mempool-prune and status timers are now guarded and log the failure.
- A process that does die from an unhandled error writes one structured `fatal` line (message, stack head, uptime, memory) and
  exits **70**, so `systemctl status` tells a software fault from a configuration error.

### Verification (this sandbox; nothing was run against a live network)
Core 1004 passed (an earlier full run: 1003 passed, 1 failed in `node-agent`, a test that is also flaky on the unmodified base);
interface 661 passed; Web App 411; extension 51; wallet web 49; Cloudflare worker 17; three-process cluster e2e 15; repo checks
(consistency 31, web separation 11, public peer surfaces 5). New: `p2p-discovery` (13), `peer-backoff-jitter`, `crash-report`,
the extended `rpc-peers-privacy` (28) and the interface "no peer or node list" tests. Params hash and the four genesis ids are
identical before and after.


## Also in 2.0.3: interface authentication patch (made after the 2.0.2 tag; no consensus change)

Prompted by a report that sign-in answered 401 after a successful registration on mainnet. The registration-to-sign-in path was
verified correct end to end, so the production cause is not established from the code (see
[docs/auth-incident-2.0.2.md](docs/auth-incident-2.0.2.md)); three real defects found on the way are fixed.

### Fixed (interface)
- A sign-in request that is not one (empty or cut-off body, not JSON, email or password not text) is now `400 ERR_BAD_REQUEST`
  instead of the "credentials are not valid" answer that a wrong password gets.
- A stored password hash that is truncated or malformed (odd or invalid hex, a salt under 8 or a key under 16 bytes, a zero cost)
  is refused instead of being compared over the bytes that survived.
- A failed disk write during registration no longer leaves a ghost account in memory or marks the Genesis Invitation spent;
  the half-made account is removed and the same invitation still works.

- The invitation list shows each code spelled as it was issued (`XXXX-XXXX-XXXX-XXXX`); it used to return the store's
  normalised form, so the same invitation had two spellings on the platform and the app depending on when it was looked at.

### Changed (tests)
- `e2e-cross-product.mjs`: the names part runs only when `FUNDER_PHRASE` (default: the standard test phrase) holds enough
  to pay a registration fee, and says `SKIPPED` otherwise. A fresh development network has no wallet that can pay one
  until its first mining claim (the first valid claim on a chain receives the one-time genesis allocation); the part used to fail
  with an insufficient-funds error that said nothing about the code under test.

### Fixed (node RPC and wallets; no consensus or version change)
- **Treasury earnings and Node Runner rewards were missing from a wallet's activity.** The treasury's 10 % of each ONS fee is
  credited by consensus inside the buyer's transaction, and Node Runner rewards at period settlement; no transaction names the
  receiving wallet, so the transaction list never showed them even though the balance rose. The indexer now records these
  credits from the block events (rebuilt once from the stored blocks on first start), `GET /address/<address>` returns them as
  `credits`, and the Web App, the standalone wallet, the platform wallet and the desktop wallet list them (*Treasury earnings*,
  *Node Runner reward*). Needs a node running this build; an older node simply returns no `credits`. See [docs/ons.md](docs/ons.md).
- The indexer labelled a name that a wallet sent with its `.obs` suffix twice (`name.obs.obs`) in transaction lists and credits; the
  label now carries the suffix once. (The platform wallet puts the suffix on the wire; the executor already ignored it.)
- Tests: `credits-index.test.ts` (core).

### Fixed (web sites; no consensus or version change)
- **A deployed update could keep showing the previous screens.** (1) The Web App sent no cache header for its pages and modules,
  so a CDN in front of it could keep serving the old `real.mjs`; they are now `Cache-Control: no-store`. (2) The platform marked any
  `/js/…?v=<anything>` request immutable for a year; it now does so only when `v` is the file's real content hash, so a page from a
  newer build served beside bundles from an older one (pulled, not rebuilt) cannot pin the old bytes under the new address.
  (3) Browser bundles are build output, not in git; [docs/web-separation.md](docs/web-separation.md) now states the update as pull,
  **rebuild**, restart, check, with `curl` checks.
- The platform's *Your names* rows have a **Manage** button that opens the owner actions (the screens existed but only appeared after searching
  a name, which is easy to miss).

### Added (Web App; interface only, no consensus or version change)
- **ONS owner screens.** Every ownership operation the chain already had now has a screen in the Web App: change the address a
  name points to, offer it to another wallet, withdraw the offer, accept an offer, set or clear the recovery address, start,
  cancel and complete a recovery. Each is a review (name, network, every address in full) and then a passphrase; bad addresses
  (email, `.obs` name, wrong network, the owner's own) are refused before signing; a listed name shows why its actions are off;
  success is shown only after the node confirms. See [docs/ons.md](docs/ons.md). Incoming offers have no RPC, so a recipient finds the name by searching it.
- Tests: `ops.test.mjs` (refusals), `owner-actions-ui.test.mjs`, and `obsidian-app-web/tests/e2e-ons-owner.mjs` (real devnet, real browser).
- **The same owner screens on the main platform's ONS page** (`obsmainnet.us.ci/ons/`; interface only). They were left out of the
  first change only because that change was scoped to the Web App; there was never a technical reason. The platform page now has
  the same actions, the same review-then-passphrase flow, the same refusals and the same re-check against the node before signing
  (`web/src/lib/ons-owner.ts` holds the shared rules). Tests: `ons-owner.test.ts` (interface) and
  `obsidian-app-web/tests/e2e-browser-platform-ons.mjs` (real devnet, real browser, wallets made by the platform's own wallet code).

### Added
- `obsidian-app-web/tests/e2e-accounts-everywhere.mjs` and `e2e-browser-accounts.mjs`: one account across the platform and
  the web app (every account route, then the real pages in a browser), and the wallet site's closed account API. See
  [docs/web-separation.md](docs/web-separation.md).
- `obsidian-interface/scripts/auth-diagnose.mjs`: a read-only check of the accounts file, the installed build and (at a hidden
  prompt) a typed password, that prints no secret and changes nothing.
- Tests: `auth-flow` and `auth-diagnose` (interface), `signin-errors` (app front).

---

## [2.0.2]

**Consensus-breaking: three consensus parameters change after a five-round attack campaign against 2.0.1, a new genesis for every network, no migration.**
A 2.0.1 node accepts transactions and blocks that a 2.0.2 node refuses, so the two cannot share a network (the handshake
refuses the mismatch). Nothing was deployed on 2.0.1. See [docs/upgrading-2.0.2.md](docs/upgrading-2.0.2.md) and the full record
of what worked and what was fixed in [docs/attack-campaign-2.0.2.md](docs/attack-campaign-2.0.2.md).

### Changed (consensus)
- **Minimum gas and minimum transfer are 0.000001 OBS.** A 1-seal payment used to pay no gas, so accounts and state could be
  created for nothing (R27).
- **A block may be dated at most 10 seconds (two slots) ahead of a node's clock, down from 60.** With 60 seconds one scheduled
  producer could date a block up to eleven slots ahead, take another node's turn and have that node recorded as having missed
  it (R29). A producer can still win the next slot by a race any peer can run.

### Fixed (node)
- **A free fresh-key transaction could be pooled** (a gas-0 claim or node statement from a brand-new key, signature valid, body
  empty), so the pool could be filled for nothing. The pool now admits only what could be valid; registrations are a separate
  small class; block selection is fair among free transactions (R26, R28).
- **Per-address limits could be walked around with IPv6.** The RPC budget, the inbound-socket cap and the IP ban are now per /64
  (R30). The RPC limiter's table is bounded (a flood of fresh addresses cost work proportional to the table on every
  request, R31).
- **`POST /tx/submit` copied the whole state before checking a signature.** The pool's cheap checks run first (R34).

### Fixed (interface)
- Rate limits are per IPv6 /64 and bounded (60,000 requests from fresh addresses took 24.8 s of CPU before), sign-in failures are
  counted per account **and** address block (anyone could lock any account for 15 minutes with ten wrong passwords; the account
  now locks for everyone only after 100 failures from many addresses), and slow clients are cut off (10 s for headers, 20 s for the
  request, 2,048 connections) (R30–R33).

- The fee preview in the web wallet and the Marketplace review screen of the web app repeated the old gas rule and would have
  shown 0 gas for a small amount; both now show the 2.0.2 minimum (found by the web app's own test that compares the screen
  with the protocol rule, once the minimum changed).

### Fixed (build)
- CI actions are pinned to full commit SHAs and every workflow declares its token permission; `repo-consistency` fails if either
  regresses (R35).

### Not fixed (documented)
- **Sybil nodes (R36).** Node registration is free and rate-limited, not priced, and slots, finality and node rewards are shared
  by count of nodes. This needs a scarce resource and is an economic redesign, not a patch; see the attack-campaign document.

### Tests
- New attack tests: `attack-r1-pool`, `attack-r2-economy-chaos` (seeded; the supply invariant, snapshot round trips and
  rejection-leaves-no-trace held on every step), `attack-r4-slot-frontrun`, `attack-r5-address-blocks`, the gateway "attack
  round 3" group, and two `repo-consistency` checks. Tests that built many blocks in a second on the real clock now use a clock
  that keeps up with the chain.

---

## Carried from 2.0.0: the ONS Marketplace

The 2.0.0 line introduced the Marketplace below; 2.0.1 and 2.0.2 keep every rule of it (2.0.1 fixed two gaps in it, the grace-period registration and non-canonical addresses, and a block-assembly halt: see [docs/upgrading-2.0.1.md](docs/upgrading-2.0.1.md)). The release
heading is gone because the history of earlier releases lives in git.

**Consensus-breaking: the ONS Marketplace, a new genesis for every network, no migration.** A new transaction type, new
consensus state and new consensus parameters change the params hash and every genesis id; a 1.9.x node cannot join a 2.0.0
network and the other way round. See [docs/upgrading-2.0.0.md](docs/upgrading-2.0.0.md) and the specification
[docs/marketplace-v2.0.0.md](docs/marketplace-v2.0.0.md).

### Marketplace: what it added
- **ONS Marketplace, enforced by the protocol** (transaction type `ONS_MARKET`, 14):
  - **Fixed-price listings** (`LIST`, `UPDATE_PRICE`, `DELIST`): one active listing per name, owner only, price at least
    0.001 OBS, malformed or overflowing prices rejected.
  - **Listing lock, in consensus**: a listed name cannot be re-pointed, transferred, accepted, recovered or renewed, takes no
    offers, cannot be listed twice and **does not resolve** (`ERR_NAME_LISTED`; the recipient resolver refuses it). Removal
    restores it; a purchase revokes the old owner's rights atomically.
  - **Buy** (`BUY`): the transaction names the price and seller the buyer reviewed; the chain checks the listing, buyer is not
    seller, seller still owns, price unchanged and spendable funds, then pays the seller the **full price**, moves the name,
    deletes the listing and sends gas to the Mining Pool in one step, or does nothing.
  - **Offers with protocol escrow** (`OFFER`, `ACCEPT_OFFER`, `DECLINE_OFFER`, `CANCEL_OFFER`): only for owned, unlisted names;
    the amount is locked at once (`spendable = balance - locked`), gas is paid on top and never from escrow; accept moves the
    name and pays the owner in full, decline and cancel refund the maker; a lapsed offer (7 days) is refunded by the block
    routine. One terminal state per offer and escrow released exactly once, however the transactions race.
  - **Listing and offers are mutually exclusive**: listing a name refunds its pending offers atomically (`INVALIDATED`);
    an ownership change or the name's expiry does the same, so no escrow is ever stranded.
  - **No commission**; escrow is custody (`marketEscrowObs`), counted by the supply-conservation check.
  - **Reads**: `GET /market`, `/market/listings`, `/market/listing/<name>`, `/market/name/<name>`, `/market/offers/{name,incoming,outgoing}/…`,
    `/market/offer/<id>`, `/market/events`; `/names/<name>` adds `marketStatus`, `listing`, `locked`, `resolved`; `/wallet/balance`
    reports spendable `balance` with `lockedObs` and `totalObs`; `/supply` adds `marketEscrowObs`. The indexer records the
    history and is rebuilt from the chain, never authoritative.
  - **Interfaces**: the ONS page (`/ons/`) and the mobile web app's ONS screen have the feed, search outcomes (available, listed,
    owned), buy, offer, list, re-price, delist, accept, decline, cancel, escrow and history; success is shown only after the node
    reports the new state. Wallet web, desktop and extension have no ONS management and refuse to pay a listed name.

### Marketplace: what it changed
- Protocol and core version `2.0.0`; minimum peer core version `2.0.0`; state snapshot format 7. The params hash and every genesis
  id change. `/wallet/balance`'s `balance` is now the **spendable** amount (identical to before while nothing is escrowed).
- **Unchanged on purpose:** the mining gate keys and mechanism (`genesis/gate-keys.ts` is byte-identical), supply constants,
  genesis-allocation rule, ONS fees and periods, gas, network ids and address prefixes.

### Known limits
- A listing is locked state: with a lost key a listed name stays locked until it is bought or expires (the recovery path is blocked
  while listed by design). Offer slots can be squatted at a cost (16 per name, 7 days). See the threat model, R20 to R22.
- Marketplace finality is the producer-diversity checkpoint, not Byzantine finality (R6, R17, R18).
- Not tested here: browser UI flows in a real browser, the desktop UI test, the wallet web browser test.
