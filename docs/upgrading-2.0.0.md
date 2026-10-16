# Upgrading to 2.0.0 — the ONS Marketplace, a new genesis

**2.0.0 is not an upgrade of a running chain.** It adds a consensus feature (the ONS Marketplace: a new transaction type, new
state and new consensus parameters), so the params hash and every network's genesis id change, and nothing is migrated. A
1.9.x node **cannot join** a 2.0.0 network and the other way round: the handshake carries the protocol version, the genesis
id and the params hash, and a peer that differs on any of them is refused
(`tests/integration/p2p.test.ts`, `tests/security/protocol-identity.test.ts`).

What the Marketplace is: [marketplace-v2.0.0.md](marketplace-v2.0.0.md). Everything else in
[upgrading-1.9.0.md](upgrading-1.9.0.md) (a fresh start, no validators, producer schedule, checkpoint finality, node binding)
still applies unchanged.

## What changed for each reader

| Reader | Before | Now |
| --- | --- | --- |
| Name owner | a name could be transferred by offer and acceptance only | the owner can also **list** it at a fixed OBS price; while listed it is **locked** (no edit, transfer, renewal or recovery, and it does not resolve) |
| Buyer | no way to buy a name | **buy** a listed name in one transaction (price and seller are signed in); or **offer** on an unlisted name with the OBS locked in escrow |
| Wallet user | `balance` was the whole balance | `balance` is what you can **spend**; OBS locked in offers is reported separately (`lockedObs`) and `totalObs` is both |
| Client author | no Marketplace routes | `GET /market…` routes ([api.md](api.md)); `ONS_MARKET` (type 14) in `/tx/encode` |
| Name resolver (all wallets) | a registered, unexpired name resolved | a **listed** name is refused with `NAME_LISTED`, so nobody pays a name whose owner has put it up for sale |
| Operator | — | nothing to configure: no new flag, key or setting |

**Unchanged on purpose:** the mining gate keys and mechanism (`obsidian-core/src/genesis/gate-keys.ts` is byte-identical to the
1.9.0 file), supply constants, genesis allocation rules, ONS registration and renewal fees, gas, network ids and address
prefixes. The Marketplace charges **no commission**.

## Version and identity

* Protocol and core `2.0.0`; `MIN_CORE_VERSION` `2.0.0`; state snapshot format 7; wire version 1.
* Params hash `e147216a83f62936572c8d9855989a7d` on every network (it commits to the new `ons.market` parameters).
* New genesis ids on every network; read them from `obsidian genesis init --network <net>` or a running node's `GET /genesis`.
  They are listed in [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md).

## Operators

1. Do **not** point a 2.0.0 binary at a 1.9.x data directory. Use a new data directory and keep the old one as an archive; a
   database whose genesis differs from the configured one is refused at start.
2. Keep your node keystore: the node identity key is the same kind of key. It is never uploaded.
3. Nothing about producing, finality, node binding or rewards changed.

## A fresh test network, step by step (devnet)

The commands are the ones in [upgrading-1.9.0.md](upgrading-1.9.0.md#a-fresh-test-network-step-by-step-devnet) — `init`,
`register`, `start`, `join`, then `scripts/verify-agreement.mjs`. Once it is producing, exercise the Marketplace:

1. Create two wallets (the interface wallet pointed at the devnet) and fund them. A devnet has no faucet: start the node with a
   mining-gate issuer key (`OBSIDIAN_MINING_GATE_PUBLIC_KEYS`), have one wallet make the first mining claim with a certificate
   from that key (it receives the genesis allocation), and pay the other wallet with an ordinary payment.
   `tests/e2e/ecosystem.test.mjs` does exactly this, and then runs the Marketplace steps below with the interface's own code.
2. Register a name from wallet A (`ONS REGISTER`, 0.05 OBS).
3. **Listing:** A lists it (`ONS_MARKET LIST`, price 10 OBS). `GET /market/name/<name>` says `LISTED`; `GET /names/<name>`
   says `resolved: false`; an `UPDATE_ADDRESS` from A is refused with `ERR_NAME_LISTED`.
4. **Buy:** B buys it (`BUY`, naming the price and A as seller). A's balance rises by exactly 10 OBS, B's falls by 10 OBS plus
   gas, and `GET /names/<name>` shows B as owner. A second buyer is refused.
5. **Offer:** the new owner B holds the name; A offers 3 OBS on it. `GET /wallet/balance` for A
   shows `lockedObs: 3` and a spendable balance 3 OBS (plus gas) lower. B accepts: the name moves to A and B is paid 3 OBS.
   Repeat with a decline and a cancel and check the escrow returns exactly once.
6. `GET /supply` shows `marketEscrowObs: 0` again when nothing is pending, and `invariantOk: true` throughout.

## Rolling back

There is nothing to roll back **to**: 1.9.x is a different chain. To stop using 2.0.0, stop the node and delete its (new) data
directory; the 1.9.x data directory was never touched.

## Not covered

No mainnet launch is performed by this release ([mainnet-launch.md](mainnet-launch.md)). Desktop installers are built per
platform. Wallet web, the desktop app and the extension have no ONS management screen: they resolve names to pay and refuse a
listed one, nothing more.
