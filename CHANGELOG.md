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
`e147216a83f62936572c8d9855989a7d` on every network.

---

## [2.0.0]

**Consensus-breaking: the ONS Marketplace, a new genesis for every network, no migration.** A new transaction type, new
consensus state and new consensus parameters change the params hash and every genesis id; a 1.9.x node cannot join a 2.0.0
network and the other way round. See [docs/upgrading-2.0.0.md](docs/upgrading-2.0.0.md) and the specification
[docs/marketplace-v2.0.0.md](docs/marketplace-v2.0.0.md).

### Added
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

### Changed
- Protocol and core version `2.0.0`; minimum peer core version `2.0.0`; state snapshot format 7. The params hash and every genesis
  id change. `/wallet/balance`'s `balance` is now the **spendable** amount (identical to before while nothing is escrowed).
- **Unchanged on purpose:** the mining gate keys and mechanism (`genesis/gate-keys.ts` is byte-identical), supply constants,
  genesis-allocation rule, ONS fees and periods, gas, network ids and address prefixes.

### Known limits
- A listing is locked state: with a lost key a listed name stays locked until it is bought or expires (the recovery path is blocked
  while listed by design). Offer slots can be squatted at a cost (16 per name, 7 days). See the threat model, R20 to R22.
- Marketplace finality is the producer-diversity checkpoint, not Byzantine finality (R6, R17, R18).
- Not tested here: browser UI flows in a real browser, the desktop UI test, the wallet web browser test.
