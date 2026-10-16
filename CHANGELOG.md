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
`22a70aa431c4e9bd69c8bb44a70bbc38` on every network.

---

## [2.0.1]

**Consensus-breaking: two rule fixes and a block-production fix found by a five-pass audit of 2.0.0, a new genesis for every network, no migration.** A
2.0.0 node accepts transactions that a 2.0.1 node rejects, so the two cannot share a network (the handshake refuses the
mismatch). Nothing was deployed on 2.0.0. See [docs/upgrading-2.0.1.md](docs/upgrading-2.0.1.md).

### Fixed (consensus)
- **A name in its grace period could be registered by a stranger.** `REGISTER` treated a name as free as soon as its term
  ended, although renewal, transfer and the market all treat the 30-day grace as the owner's. A stranger could register a
  lapsed name inside the grace period, which also wiped its listing and offers. A name is now registrable only when no
  record exists or `expiresAt + grace` has passed (`ERR_NAME_TAKEN` otherwise).
- **An all-uppercase recipient address credited an account nobody can sign for.** Bech32 accepts an all-uppercase string
  (a QR code usually carries one), but account keys are the lowercase text, so a payment, `UPDATE_ADDRESS` pointer or
  treasury grant to `OBS1…` created a phantom account and the funds were unspendable. Every recipient or pointer address
  must now be canonical lowercase (`ERR_BAD_ADDRESS` otherwise); the client encoders lowercase an all-uppercase address
  before signing, and the RPC lowercases addresses it reads or simulates.

### Fixed (block production: a chain halt)
- **Three node registrations in one slot could stop a network for good.** The per-block limits (at most 2 node
  registrations, a cap on equivocation reports, one claim per wallet per block) are counted per block by a validator, but
  block assembly tried each pooled transaction on its own with a fresh count, so the limits never applied there. A producer
  could sign a block with three registrations, every validator (the producer included) rejected it with
  `ERR_NODE_REGISTRATION_LIMIT`, and the double-sign lock then stopped every node from building another block on that parent.
  Found by the cluster end-to-end test (it stalled at height 6 when three operators registered in the same slot; it depends
  on timing, so earlier runs passed by luck). Assembly now carries one tally for the whole block, a transaction that only
  failed because the block was full stays pooled for the next block, and before signing the producer replays the
  assembled list exactly as a validator will and signs an empty block if the roots differ. No validation rule changed.

### Fixed (clients and gateway)
- The interface gateway sent no `X-Content-Type-Options: nosniff` on origin rejections (403) and on the CORS preflight (204).
- Mobile layout: the account page widened the whole page on a phone (a visually hidden live-region inside a scrolling table
  escaped its clip); the web app's Marketplace sort buttons overflowed a 375 px screen.
- An owned, unlisted name showed `Expires —` on the ONS page; it now shows the name's expiry.
- Name validation in the web app (3–24) and the interface (3–32) disagreed with consensus (3–63, no edge hyphen, no `--`,
  reserved names); both now apply the consensus rule, with a parity test.
- Desktop and wallet-web browser end-to-end tests had gone stale (they expected a 1.x core version and unrounded balances) and
  are repaired; a new opt-in browser test drives the Marketplace through the real pages
  (`tests/e2e/browser-marketplace.test.mjs`).
- `scripts/fresh-machine-test.sh`: `cd` failures now stop the script. The script itself had drifted from the product (it
  expected the pre-1.9 passphrase behaviour, 11 archives and old genesis ids) and is brought up to date; its first full run
  on 2.0.1 found two real gaps, both fixed: an interface unpacked beside the node could not start with a mining gate key
  configured (it needs the node's installed libraries; `obsidian-network.sh` now links them), and the guide's second-devnet-node
  command started a different chain (the helper-made gate key is part of a test network's genesis id; the guide now says so and
  passes the key). The updated script passes 96/96 on 2.0.1.

### Added
- Tests: `address-canonical`, `marketplace-property` (a model-based test of the Marketplace state machine against an
  independent oracle), registration-in-grace cases, `name-rule-parity`, and the browser tests above.
- A node-runners test that pools more registrations than a block may hold and requires a producer to build a block its own
  chain accepts.
- Threat-model entries R23, R24 and R25.

### Changed
- Protocol and core `2.0.1`, `MIN_CORE_VERSION` `2.0.1`; params hash and every genesis id change (see
  [docs/LAUNCH-GUIDE.md](docs/LAUNCH-GUIDE.md)). The gate keys, supply, fees, gas and the Marketplace rules are unchanged.

---

## Carried from 2.0.0: the ONS Marketplace

The 2.0.0 line introduced the Marketplace below; 2.0.1 keeps every rule of it (and fixes the two gaps above). The release
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
