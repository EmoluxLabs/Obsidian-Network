# Upgrading to 2.0.2 — three consensus parameters, a new genesis

**2.0.2 is not an upgrade of a running chain.** It changes three consensus parameters, so the params hash and every
network's genesis id change and nothing is migrated. A 2.0.1 node **cannot join** a 2.0.2 network and the other way round: the
handshake carries the protocol version, the genesis id and the params hash, and a peer that differs on any of them is refused.
Nothing was deployed on 2.0.1, so there is no chain to carry over. Everything in [upgrading-2.0.1.md](upgrading-2.0.1.md),
[upgrading-2.0.0.md](upgrading-2.0.0.md) and [upgrading-1.9.0.md](upgrading-1.9.0.md) still applies.

The reasons are in [attack-campaign-2.0.2.md](attack-campaign-2.0.2.md).

## What changed

| Rule | 2.0.1 | 2.0.2 |
| --- | --- | --- |
| `gas.minGas` (smallest gas on a transaction that has a base amount) | 0 (the 0.02% rule rounds to nothing below 5,000 seals) | 0.000001 OBS |
| `tx.minTransfer` (smallest payment) | 1 seal | 0.000001 OBS |
| `block.maxFutureDriftSeconds` (how far ahead of a node's clock a block may be dated) | 60 | 10 |

For a person nothing changes in what they type, except that a payment below 0.000001 OBS is refused. For an operator: keep
your clock within a few seconds (NTP). A node whose clock runs more than 10 seconds behind refuses blocks until it catches up,
and its peers record only a minor fault for sending them.

Not consensus, and therefore not versioned: the pool admits only what could be valid, block assembly is fair among free
transactions, address-block (IPv6 /64) limits, the interface's sign-in and slow-client limits. Any node can run them or not.

## Version and identity

* Protocol and core `2.0.2`; `MIN_CORE_VERSION` `2.0.2`; state snapshot format 7; wire version 1.
* Params hash `12211595855ba405b3d70f6161ef9371` on every network; new genesis ids, listed in [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md)
  and readable from `obsidian genesis init --network <net>` or a running node's `GET /genesis`.

## Operators

1. Do **not** point a 2.0.2 binary at a 2.0.1 (or older) data directory; a database whose genesis differs from the configured
   one is refused at start. Use a new data directory.
2. Keep your node keystore: the identity key is the same kind of key and is never uploaded.
3. Run more than one independent node if you depend on the network: Sybil nodes are the one attack class this release does not
   close (R36 in [threat-model.md](threat-model.md)).
