# Upgrading to 2.0.1 — two consensus fixes, a new genesis

**2.0.1 is not an upgrade of a running chain.** It changes two consensus rules, so the params hash and every network's
genesis id change and nothing is migrated. A 2.0.0 node **cannot join** a 2.0.1 network and the other way round: the
handshake carries the protocol version, the genesis id and the params hash, and a peer that differs on any of them is
refused. Nothing was deployed on 2.0.0, so there is no chain to carry over.

Everything in [upgrading-2.0.0.md](upgrading-2.0.0.md) (the Marketplace) and [upgrading-1.9.0.md](upgrading-1.9.0.md) still
applies unchanged.

## What changed

| Rule | 2.0.0 | 2.0.1 |
| --- | --- | --- |
| Registering a name | free the moment the term ended, so a stranger could take a name in its 30-day grace period (wiping any listing and offers) | free only when no record exists or the grace period has also passed; otherwise `ERR_NAME_TAKEN` |
| Recipient and pointer addresses (payment, `UPDATE_ADDRESS`, treasury grant) | bech32 text in any single case was accepted, so an all-uppercase address (QR codes carry one) credited an account nobody can sign for | the address must be canonical lowercase; anything else is `ERR_BAD_ADDRESS` |

2.0.1 also fixes block production (no validation rule changed): a producer could assemble a block over the per-block limit on
node registrations (three registrations pooled in one slot), reject it itself, and then, held by the double-sign lock, stop the
whole network from building on that parent. Assembly now counts the limits across the whole block, leaves transactions that do
not fit in the pool for the next block, and checks the finished block the way a validator will before signing.

For clients nothing changes in what a person types: the encoders in this repository lowercase an all-uppercase address before
signing, and the RPC reads and simulates the lowercase form. A hand-built transaction that carries an uppercase address is now
refused, which is the point.

## Version and identity

* Protocol and core `2.0.1`; `MIN_CORE_VERSION` `2.0.1`; state snapshot format 7; wire version 1.
* The params hash and the genesis ids of 2.0.1 were superseded by 2.0.2 (see [upgrading-2.0.2.md](upgrading-2.0.2.md)); a running
  node's `GET /genesis` and `obsidian genesis init --network <net>` always print the values of the build you are running.

## Operators

1. Do **not** point a 2.0.1 binary at a 2.0.0 (or older) data directory; a database whose genesis differs from the configured
   one is refused at start. Use a new data directory.
2. Keep your node keystore: the identity key is the same kind of key and is never uploaded.
3. Nothing about producing, finality, node binding, rewards, the gate or the Marketplace changed.
