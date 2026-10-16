# ONS Marketplace (2.0.0)

The ONS Marketplace lets the owner of a `.obs` name sell it for a fixed price in OBS, and lets anyone make an offer on a
name that is not for sale. It is **protocol**, not an application: a listing, an offer, the OBS locked behind an offer and
every ownership change are consensus state, recomputed by every node and rejected if invalid. The interface only reads
that state and builds transactions the chain validates again. There is no mock, simulated or frontend-only payment or
balance anywhere in it.

* Transaction type `ONS_MARKET` (`14`), eight operations — `LIST` 1, `UPDATE_PRICE` 2, `DELIST` 3, `BUY` 4, `OFFER` 5,
  `ACCEPT_OFFER` 6, `DECLINE_OFFER` 7, `CANCEL_OFFER` 8. Wire format: [transaction-format.md](transaction-format.md).
* Code: `obsidian-core/src/transactions/executors/marketplace.ts` (the operations), `src/economy/market.ts` (the one
  function that releases escrow and the per-block routine), `src/transactions/executors/ons.ts` (the listing lock),
  `src/rpc/market-views.ts` (read views), `src/indexer/indexer.ts` (history).
* Identity: this is a protocol change, so **2.0.0 is a new line with a new genesis for every network**. See
  [upgrading-2.0.0.md](upgrading-2.0.0.md). The gate keys and the mining gate are untouched.

## Parameters (`ons.market`, in `params.ts`, part of the params hash)

| Parameter | Value | Meaning |
| --- | --- | --- |
| minimum price / offer | 0.001 OBS | anti-spam floor; not a fee. A smaller or zero amount is rejected (`ERR_AMOUNT_ZERO`). |
| offer lifetime | 7 days | a pending offer lapses after this and its escrow returns to the maker. |
| pending offers per name | 16 | bounds the work a block does per name. |
| pending offers per maker | 32 | each offer locks funds; bounds the escrow one account can park. |
| settled-offer retention | 90 days | settled offers stay in state as an audit trail, then are pruned; the chain's events keep the history. |
| commission | **none** | the seller receives exactly the price (or the accepted amount). Nothing is deducted or minted. |

Amounts are 18-decimal seals (`1 OBS = 10^18` seals). Prices and offers must be canonical integers, positive, and no
larger than the maximum supply; malformed or overflowing values fail decoding (`ERR_MALFORMED`) and bodies must be
canonically encoded, so one transaction has one byte representation.

## Listings

Fixed price, one active listing per name.

| Operation | Who | Rules |
| --- | --- | --- |
| `LIST` | the owner | the name must be active (not expired), not already listed, with **no ordinary transfer offer and no recovery in flight**; price ≥ minimum. Pending offers on the name are refunded in the same transaction (see below). |
| `UPDATE_PRICE` | the owner | the name must be listed by the sender; new price ≥ minimum. |
| `DELIST` | the owner | allowed during the grace period too. Restores ordinary use. |
| `BUY` | anyone but the seller | the transaction states the **price and seller the buyer reviewed**; the chain buys only if both still hold. |

Ownership stays with the seller until a purchase succeeds. Re-pricing or delisting and buying race in block order, and
exactly one outcome stands: a buyer who loses gets `ERR_MARKET_STATE` (no longer listed) or
`ERR_MARKET_PRICE_MISMATCH` (price or seller changed), and nothing moves.

## The listing lock (consensus, not interface)

While a name is listed the owner cannot use or manage it as an ordinary active name. Every executor that would do so
checks the listing first and fails with `ERR_NAME_LISTED`; racing transactions in the same block are evaluated in order
against the state the earlier ones left, so none can slip past.

| Operation on a listed name | Result |
| --- | --- |
| `ONS UPDATE_ADDRESS` (re-point the name) | blocked |
| `ONS TRANSFER` (offer to another address) | blocked |
| `ONS ACCEPT_TRANSFER` | blocked |
| `ONS SET_RECOVERY`, `START_RECOVERY`, `FINALIZE_RECOVERY` | blocked |
| `ONS RENEW` | blocked (a listing lapses with the name; renew after delisting) |
| `ONS_MARKET LIST` again | blocked (`ERR_MARKET_STATE`: one listing per name) |
| `ONS_MARKET OFFER` on it | blocked (also: by the owner on their own name, or by a maker who already has a pending offer on that name) |
| `ONS_MARKET ACCEPT_OFFER` | blocked: an unlisted name is required |
| resolution (`/names/:name`, the recipient resolver) | the name **does not resolve**: the resolver reports `NAME_LISTED` and wallets refuse to send to it |
| `ONS CANCEL_TRANSFER`, `CANCEL_RECOVERY` | allowed (they only remove a pending state) |
| `ONS_MARKET UPDATE_PRICE`, `DELIST` | allowed (owner) |
| `ONS_MARKET BUY` | allowed (anyone but the owner) |

Removing the listing restores everything. A purchase atomically replaces the owner, clears the listing and wipes the old
owner's pending transfer, recovery and recovery address (the existing ownership-change rule), so the old owner keeps no
right over the name.

**Documented consequence — a lost key.** A listing is locked state: if the owner loses the key, nobody can delist, and the
name stays locked until it is bought or its term and grace end and it is deleted. The recovery path is blocked while
listed by design (otherwise a recovery address could defeat the lock). Delist, or let the name sell, before you risk the
key.

## Buying

The chain verifies in this order, and any failure rejects the whole transaction with no partial state:

1. the listing is active; 2. the buyer is not the seller; 3. the name's owner is still the seller; 4. the transaction's
price and seller equal the listing's; 5. signature, chain, nonce, replay and expiry rules; 6. gas is exactly the protocol
gas for the price; 7. the buyer's **spendable** balance covers price + gas.

Then, in one state transition: the buyer is debited price + gas; the **seller is credited the full price**; gas goes to
the Mining Pool; the name moves to the buyer (`ONS_TRANSFERRED`, `via: MARKET`); the listing is deleted; the old owner's
rights are revoked; events `ONS_SOLD` and `ONS_TRANSFERRED` are emitted. The block is rejected if any step throws, so a
buyer can never pay without receiving the name, and a name can never move without payment. A seller needs no balance to be
paid.

## Offers and escrow

Offers are for **owned, unlisted names only**. An offer is a request to the current owner; nothing happens to the name
until the owner accepts.

* `OFFER` carries the name, the amount and the owner it is addressed to (`counterparty`). The offer's id is the id of the
  transaction that made it. It records the name, the owner at offer time, the maker, the amount and the time.
* **Escrow is immediate.** The amount leaves the maker's spendable balance and is held in consensus-state escrow
  (`spendable = balance − locked`). Gas is charged on top, from the spendable balance, never from escrow. The offer *is*
  the escrow record: it identifies the offer, name, maker, owner and amount, and a pending offer holds exactly its amount.
* An offer's own expiry is the earlier of 7 days and the end of the name's term.
* Rejected: an offer on a listed name, by the owner on their own name, on an expired name, below the minimum, from a maker
  with insufficient spendable funds, a second pending offer from the same maker on the same name, and beyond the
  per-name or per-maker limits.

| State | Entered by | Escrow | Name |
| --- | --- | --- | --- |
| `PENDING` | `OFFER` | held | stays with the owner |
| `ACCEPTED` | `ACCEPT_OFFER` (owner) | paid to the owner in full | moves to the maker |
| `DECLINED` | `DECLINE_OFFER` (owner) | returned to the maker | unchanged |
| `CANCELLED` | `CANCEL_OFFER` (maker) | returned to the maker | unchanged |
| `EXPIRED` | the block routine, 7 days after the offer | returned to the maker | unchanged |
| `INVALIDATED` | a listing, an ownership change or the name's expiry | returned to the maker | unchanged |

`PENDING` is the only state that holds escrow and leaving it is the only way to release it. Every release goes through one
function (`closeOffer`), which refuses an offer that is not `PENDING`; so an offer reaches **exactly one terminal state**
and its escrow is paid **exactly once**, however accept, decline, cancel, listing, transfer and expiry race — the first in
block order wins and the rest fail with `ERR_MARKET_STATE`.

`ACCEPT_OFFER` requires: the sender is the current owner; the offer is `PENDING`, unexpired and addressed to that owner;
the amount in the transaction equals the escrow; the name is **not** listed. It then atomically moves the name to the
maker, releases the escrow to the owner (full amount, no commission), marks the offer `ACCEPTED`, wipes the old owner's
transfer and recovery state, refunds every *other* pending offer on the name (`INVALIDATED`), and emits events. It carries no
gas (it moves no new value in), so an owner with an empty balance can still accept and be paid.

`DECLINE_OFFER` is the owner's; `CANCEL_OFFER` is the maker's. Either works on any `PENDING` offer. An offer made to a
previous owner cannot be decided by a new one (`ERR_UNAUTHORIZED`); it has already been refunded when ownership changed.

## Listing ↔ offer exclusivity

* A listed name accepts **no new offers** and its **offers cannot be accepted**.
* Listing a name that already has pending offers is allowed, and **atomically invalidates and refunds all of them** in the
  same transaction: each becomes `INVALIDATED`, its escrow returns to its maker once, and `ONS_OFFER_INVALIDATED` records
  it. Nothing is auto-accepted, and no escrow is ever left behind a listing.
* A name that is deleted after its grace period, or whose owner changes, refunds its offers the same way, so funds are
  never locked indefinitely: every offer ends within 7 days at the latest.

## Fees and who pays

| Operation | Gas | Paid by |
| --- | --- | --- |
| `BUY` | 2 basis points of the price, capped at 0.01 OBS | the buyer, on top of the price |
| `OFFER` | 2 basis points of the amount, capped at 0.01 OBS | the maker, on top of the escrowed amount |
| `LIST`, `UPDATE_PRICE`, `DELIST`, `ACCEPT_OFFER`, `DECLINE_OFFER`, `CANCEL_OFFER` | none (a nonzero gas is `ERR_BAD_GAS`) | — |

Gas goes to the Mining Pool exactly as for a payment. The Marketplace adds no fee to the ONS fee model: registration and
renewal fees are unchanged, and a sale is not ONS revenue. Escrow is custody, not revenue and not new supply: it is a
separate balance in state (`marketEscrowObs` in `/supply`), the supply-conservation check counts it alongside account
balances and the pools, and it must equal the sum of the pending offers, so no OBS is created or destroyed by any
Marketplace path.

## Reads (RPC)

All amounts are exact. Routes are listed with their shapes in [api.md](api.md): `GET /market`, `/market/listings`,
`/market/listing/:name`, `/market/name/:name` (status `AVAILABLE`, `EXPIRED`, `OWNED` or `LISTED`, plus `canRegister`,
`canBuy`, `canOffer`), `/market/offers/name/:name`, `/market/offers/incoming/:address`, `/market/offers/outgoing/:address`,
`/market/offer/:id` (state and escrow), `/market/events`. `/names/:name` adds `marketStatus`, `listing`, `locked` and
`resolved`; `/wallet/balance` reports `balance` as the spendable amount with `lockedObs` and `totalObs`.

Every read is derived from world state at the head. The indexer (`/market/events`, history) is a convenience that is
rebuilt from the chain's blocks and **never authoritative**: a stale or wrong index cannot authorise anything, because
every transaction re-validates against consensus state.

## Search outcomes and stale data

| Search result | What the interface shows | Authority |
| --- | --- | --- |
| A — available | the existing registration flow | the chain's registration rules |
| B — owned and listed | "Listed on ONS Marketplace", price, seller, **Buy** | `BUY` names the price and seller; a changed listing is rejected |
| C — owned, not listed | **Make Offer** | `OFFER` is re-checked (not listed, not own, funds) |
| D — stale or unreachable data | the interface says it cannot read the node and offers nothing | the chain re-validates everything; a stale screen authorises nothing |

## Reorgs, finality and persistence

Marketplace state is part of the world state and the state root (snapshot format 7), so listings, offers and escrow are
persisted, snapshot-restored and replayed identically, and a reorg replays blocks from the fork point: whatever a reorged
block did to listings, offers, escrow or ownership is recomputed from the surviving chain. A purchase or an accepted
offer is final when its block is final under the documented finality rule ([finality-v1.9.0.md](finality-v1.9.0.md)),
which is a producer-diversity checkpoint, not Byzantine finality — see [consensus-assumptions.md](consensus-assumptions.md).
Wait for the checkpoint, not one confirmation, before handing over anything outside the chain.

## Clients

| Client | Marketplace support |
| --- | --- |
| Interface — ONS page (`/ons/`) | feed, search outcomes, buy, offer, list, re-price, delist, accept, decline, cancel, escrow, history |
| Mobile web app (`obsidian-app-web`) — ONS screen | the same, in its own design |
| Wallet web, desktop, extension | no ONS management; they only **resolve** names to pay, and refuse a listed name (`NAME_LISTED`) |

Interfaces never show success on submission: they poll the node until the new state is visible and say "not confirmed
yet" otherwise.

## Tests

`obsidian-core/tests/integration/marketplace.test.ts` (consensus: listing, lock, buy, offers, escrow, exclusivity,
adversarial, reorg and restart), `tests/security/rpc-marketplace.test.ts` (RPC, indexer), the marketplace case in
`tests/security/decoder-fuzz.test.ts`, `tests/unit/recipient.test.ts` (resolution of a listed name), and the interface and
mobile-app suites. Counts are in the CHANGELOG entry for this release.
