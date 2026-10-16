# ONS — Obsidian Name Service

A `.obs` name maps to **exactly one wallet address**, and that mapping is
blockchain state. Nodes recompute it, reject double registrations, and apply
transfers as ordinary signed transactions. No DNS, no registrar and no company
sits in the middle.

## 1. Registering

| Parameter | Value |
| --- | --- |
| Fee | **0.05 OBS** (`ons.registrationFee`), renewal **0.05 OBS** |
| Term | 365 days (`termSeconds`) |
| Grace | 30 days (`graceSeconds`) |
| Length | 3–63 characters |

The fee is a **consensus parameter denominated in OBS**: the same number on
every node, with no exchange rate and no price feed involved. Registration
therefore works on a chain that has never received a price submission — the
interface reads `ons.registrationFeeObs` from `GET /params` and will not invent
a fee if it cannot reach a node at all.

Until 1.2.0 this fee was a dollar amount converted at an oracle median, and an
empty feed closed registration. That is gone: a dead feed can no longer close a
feature it does not price.

## 2. Ownership: transfer, acceptance, linked-wallet edit and recovery (1.9.0)

A name never changes hands because its owner said so. Every ownership operation is a signed ONS transaction, applied in
consensus state, atomic, replay-safe (nonce and expiry like every transaction) and **gas-free** (no value moves); each needs an
**unexpired** name. Pricing, term and grace are unchanged ([§1](#1-registering)).

| Operation | Who signs | Effect |
| --- | --- | --- |
| `TRANSFER` (offer) | the current owner | Offers the name to one recipient (`to`, a lowercase address). Nothing changes yet. One open offer at a time; it lapses after `transferOfferSeconds` (7 days). |
| `ACCEPT_TRANSFER` | the offered recipient | Atomically moves `owner`, the resolved `address`, the transfer count **and the remaining term** to the recipient. Any other sender is refused. |
| `CANCEL_TRANSFER` | the owner | Withdraws an open offer. |
| `UPDATE_ADDRESS` | the owner (the "linked wallet" edit) | Changes only the address the name resolves to. It touches nothing else and is **independent of any node reward wallet**. |
| `RENEW` | the current owner | Extends the term. After a transfer, **the new owner pays all future renewals**; the old owner can no longer renew. |
| `SET_RECOVERY` | the owner | Names a **recovery address** (empty clears it). Refused while a recovery is in flight. |
| `START_RECOVERY` | the recovery address | Proposes a new owner address; takes effect only after `recoveryDelaySeconds` (7 days). |
| `CANCEL_RECOVERY` | the owner | Stops a recovery in flight. |
| `FINALIZE_RECOVERY` | the recovery address or the new owner | After the delay, if the owner has not cancelled, ownership moves. |

Rules the protocol enforces:

* only the current owner may offer, cancel, renew, edit or set a recovery address (`ERR_UNAUTHORIZED` otherwise); only the
  named recipient may accept;
* a transfer to a mistyped address costs nothing: it is an offer nobody accepts, and it lapses;
* **any ownership change wipes the previous owner's open offer, pending recovery and recovery address**, so a new owner never
  inherits the previous owner's recovery path;
* the recipient, recovery address and new owner address must be canonical lowercase; the `UPDATE_ADDRESS` pointer stays as
  permissive as payments are;
* a name cannot be in two places: the mapping is a single state entry and the state root commits to it.

`GET /names/<name>` additionally shows `transferCount`, `pendingTransfer {to, offeredAt, offerExpiresAt}`, `recoveryAddress`
and `pendingRecovery {by, newAddress, startedAt, effectiveAt}` when they exist.

### What recovery cannot do — stated plainly

* The recovery address is a **credential-based, delayed and cancellable** path, not a back door. It cannot transfer, renew or
  edit; it can only start a recovery that the owner can cancel for seven days.
* **If the owner key is stolen, the thief is the owner:** they can cancel a recovery, clear the recovery address and keep the
  name. Recovery protects against *loss*, not against *theft of the owner key*.
* **If the owner key is lost and no recovery address was set (or its key is lost too), the name cannot be recovered by
  anyone.** There is no administrator and no override.
* `RENEW` needs an unexpired name; a name that has lapsed past grace is registrable by anyone and cannot be recovered.
* The 10 % treasury share of every fee goes to the treasury wallet, as before.

### Selling a name: the ONS Marketplace (2.0.0)

Ownership can also change by a **sale**: the owner lists the name at a fixed OBS price and anyone can buy it, or a buyer
makes an offer on an unlisted name with the OBS locked in protocol escrow until the owner decides. Both are signed
`ONS_MARKET` transactions applied in consensus state and are specified in [marketplace-v2.0.0.md](marketplace-v2.0.0.md).
What matters for the rules above:

* **A listed name is locked.** While it is listed the owner cannot `UPDATE_ADDRESS`, `TRANSFER`, `ACCEPT_TRANSFER`,
  `SET_RECOVERY`, `START_RECOVERY`, `FINALIZE_RECOVERY` or `RENEW` it (`ERR_NAME_LISTED`), and it **does not resolve**: the
  recipient resolver refuses it with `NAME_LISTED` and the interfaces will not pay it. `CANCEL_TRANSFER` and
  `CANCEL_RECOVERY` stay allowed.
* A name with an open ordinary transfer offer or a recovery in flight cannot be listed until the owner cancels it.
* A sale and an accepted offer are ownership changes like any other: **the old owner's open offer, recovery and recovery
  address are wiped**, and every other pending Marketplace offer on the name is refunded.

## 3. Resolution

```bash
curl -s http://127.0.0.1:8630/names/obsidian.obs | jq
```

```json
{
  "name": "obsidian.obs",
  "owner": "obs1…",
  "address": "obs1…",
  "registeredAt": 1790500020,
  "registeredAtHeight": 26,
  "expiresAt": 1822036020
}
```

A name that is listed on the Marketplace answers with `locked: true` and `resolved: false`, and a client must not pay it
(`GET /market/name/<name>` gives the full Marketplace status).

`GET /names` lists registered names with a `prefix` filter and `limit`/`offset` paging (at most 500 per page), so a client can
implement search without an index of its own.

## 4. Renewal and expiry

A name expires at `registeredAt + term + grace`. Past that point the mapping is
no longer valid and the name becomes registrable again; the node's response
reflects the height at which validity ended. Renewal is a normal ONS transaction
signed by the **current** owner: after a transfer the new owner is the one who renews.

## 5. Updating the target address

An owner may point a name at a different address they control without transferring
ownership (`ONS → UPDATE_ADDRESS`). This is how a name becomes a stable identity
while the underlying wallet rotates. Only the owner can do it (a recovery address cannot), and the change is
a normal chain transaction—visible and timestamped, with the same reorg risk and advisory confirmation depths as every other transaction.

## 6. Paying a name

A PAYMENT carries an address and nothing else: the state machine runs its address check on the recipient, so a `.obs`
name written into that field is refused as an invalid address. A name therefore has to become an address **before** the
transaction is built, and every interface that sends does it the same way, with one resolver
(`obsidian-core/src/protocol/recipient.ts`):

1. Only text ending in `.obs` is a name. It is normalised exactly as the protocol does (trim, lowercase, one `.obs`
   suffix) and checked against the registration rules (length, characters, interior hyphens, reserved names). A string
   that fails is refused without asking the node.
2. The record is read from the node's own `GET /names/<name>` (through the gateway, as every other read). The resolver
   also reads the node's chain id, address prefix and head-block time, and holds them against what the app is configured
   for. A node on another chain is refused.
3. The answer must be a record for that very name, with an integer expiry, and an `address` that passes the same address
   validator as one typed by hand, with this network's prefix. The node does not report expiry state, and an expired name
   can be registered by anyone, so a record whose expiry is not after the head-block time is refused.
4. The person is shown the name, the **whole** resolved address, the network and the status, and confirms. Nothing is
   signed before that.
5. Immediately before signing the name is resolved again; a different address, a lapsed name or an unreadable record
   stops the payment. The transaction carries the resolved address, never the name.

Failures are told apart: *ONS name not found on Mainnet.* (the node answered "name not registered"), *Could not resolve
this ONS name. Please try again.* (timeout, transport error, a node error, an unknown route — the answer is unknown,
nothing is guessed), *ONS name resolved to an invalid OBS address. Transaction blocked.*, a malformed or wrong-network
answer, and an expired name. A failed lookup is never reported as an invalid address.

The QR scanner and the image reader in the wallet accept a bare address only; a name scanned from a code is not filled in.
This is client behaviour only: nothing in consensus, the transaction format or the node's RPC changed.
