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

## 2. Transferring

A transfer is one signed transaction:

```bash
# via any interface: ONS → transfer, or directly
curl -s -X POST http://127.0.0.1:8630/tx/submit -d '{"tx":"<signed hex>"}'
```

Rules the protocol enforces:

* only the current owner may transfer (`ERR_UNAUTHORIZED` otherwise);
* the record's `owner` and `address` both move to the recipient — a transfer that
  updated only one of them would leave the name pointing at an address the
  recipient does not control (`ons.test` in the core suite asserts both);
* transfers cost no ONS fee, only the standard payment gas on any value attached;
* a name cannot be in two places: the mapping is a single state entry, and the
  state root commits to it.

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

`GET /names` lists registered names with a `prefix` filter, so a client can
implement search without an index of its own.

## 4. Renewal and expiry

A name expires at `registeredAt + term + grace`. Past that point the mapping is
no longer valid and the name becomes registrable again; the node's response
reflects the height at which validity ended. Renewal is a normal ONS transaction
signed by the current owner.

## 5. Updating the target address

An owner may point a name at a different address they control without transferring
ownership (`ONS → UPDATE_ADDRESS`). This is how a name becomes a stable identity
while the underlying wallet rotates. Only the owner can do it, and the change is
a normal chain transaction—visible and timestamped, with the same reorg risk and advisory confirmation depths as every other transaction.
