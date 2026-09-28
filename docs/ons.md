# ONS — Obsidian Name Service

A `.obs` name maps to **exactly one wallet address**, and that mapping is
blockchain state. Nodes recompute it, reject double registrations, and apply
transfers as ordinary signed transactions. No DNS, no registrar and no company
sits in the middle.

## 1. Registering

| Parameter | Value |
| --- | --- |
| Fee | $5.00 equivalent, paid in OBS at the protocol price |
| Term | 365 days (`termSeconds`) |
| Grace | 30 days (`graceSeconds`) |
| Length | 3–63 characters |

The dollar fee is converted through the **protocol oracle median**: at least two
independent submissions, bounded (1 µ$ … 1e12 µ$), no older than 36 hours, and at
most 25% apart. If fewer than two sources are fresh, the node rejects the
registration with `ERR_ORACLE_UNAVAILABLE`. The interface shows the price it read
from the node and cannot price a name on its own — try it with the oracle empty
and the button refuses, which is the intended behaviour, not a bug.

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
a normal chain transaction — visible, timestamped and irreversible.
