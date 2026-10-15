# Upgrading to 1.9.0 — a fresh start

**1.9.0 is not an upgrade of a running chain.** It is a new protocol line with a new genesis for each network. Nothing is
migrated: not chain state, not balances, not validators, not bonds, not finality checkpoints, not node registries, not
names. A 1.8.x node **cannot join** a 1.9.0 network and the other way round: the handshake carries the protocol version,
the genesis id and the params hash, and a peer that differs on any of them is refused (`tests/integration/p2p.test.ts`,
`tests/security/protocol-identity.test.ts`).

Design documents, in reading order: [consensus-v1.9.0.md](consensus-v1.9.0.md) → [finality-v1.9.0.md](finality-v1.9.0.md) →
[node-binding-v1.9.0.md](node-binding-v1.9.0.md) → [node-rewards-v1.9.0.md](node-rewards-v1.9.0.md) → [ons.md](ons.md) →
[wallet.md](wallet.md).

## What changed for each reader

| Reader | Before | Now |
| --- | --- | --- |
| Node operator | a bonded **validator** had to register, vote and hold a quorum; without validators the chain halted ("No Validator") | any **registered, online, synced** node produces blocks on a deterministic schedule; there are no validators, bonds, votes or bootstrap-validator locks |
| Reward earner | rewards tied to the validator/old node-runner logic | **90 %** of the ONS revenue pool, split by eligible weight, settled exactly once per period ([node-rewards-v1.9.0.md](node-rewards-v1.9.0.md)) |
| Node binding | a bond and a registration transaction paid for with gas | paste an address; **no gas, no wallet signature, no bond** ([node-binding-v1.9.0.md](node-binding-v1.9.0.md)) |
| Name owner | transfer by a single transaction | offer → acceptance by the recipient; the new owner pays renewals; delayed recovery ([ons.md](ons.md)) |
| Wallet user | recovery by phrase only | creation shows phrase **and** private key; a separate, locally validated private-key recovery ([wallet.md](wallet.md)) |
| Operator tooling | `/validators`, staking screens, the bootstrap-committee environment variable | `/producers`, `/finality`, `/nodes/status/:nodeId`; no staking UI; the environment variable is gone |

**Unchanged on purpose:** the mining gate keys and mechanism (`obsidian-core/src/genesis/gate-keys.ts` is byte-identical to
the 1.8.2 file), the supply constants, the genesis allocation rules, fees, ONS prices and periods, transaction formats,
network ids and address prefixes.

## Version and identity

* Protocol and core `1.9.0`; `MIN_CORE_VERSION` `1.9.0`; state snapshot format 6; wire version 1.
* Params hash (every network): `38dd9243481cd35a68003648e2710001`.
* Genesis ids are different from 1.8.x. Read them from `obsidian genesis init --network <net>` (reproducible: every node
  computes the same genesis hash and state root) or from a running node's `GET /genesis`; they are listed in
  [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md).

## Operators

1. Do **not** point a 1.9.0 binary at a 1.8.x data directory. Use a new data directory; keep the old one as an archive.
   A database whose genesis differs from the one configured is refused at start.
2. Keep your node keystore: the node identity key is the same kind of key and stays with you. Back it up
   ([operations.md](operations.md)). It is never uploaded and nothing asks for it.
3. Bind a reward wallet by address (`obsidian register <address>`). **Never paste a private key into any node screen.**
4. Run the node with block production on. It registers itself, heartbeats and attests on its own; the first blocks it can
   produce come after the **maturity** (64 blocks).
5. Finality is `available: false` until at least two established producers exist. That is expected on a new network.

## A fresh test network, step by step (devnet)

```bash
cd obsidian-core && npm ci && npx tsc -p .

# node A: create the chain
node dist/index.js init --network devnet --data-dir /tmp/net/a
node dist/index.js register <dobs1… address of a wallet you control> --network devnet --data-dir /tmp/net/a
node dist/index.js start --network devnet --data-dir /tmp/net/a --keystore /tmp/net/a/node-key.json \
     --no-interface --port-offset 0

# node B (another terminal, or another machine): join A
node dist/index.js join --peer http://127.0.0.1:<A rpc port> --genesis-id <devnet genesisId> --network devnet --data-dir /tmp/net/b
node dist/index.js register <another dobs1… address> --network devnet --data-dir /tmp/net/b
node dist/index.js start --network devnet --data-dir /tmp/net/b --keystore /tmp/net/b/node-key.json \
     --no-interface --rpc-port <p> --p2p-port <p+1> --seeds 127.0.0.1:<A p2p port>
```

`init` creates the genesis and prints its id; `join` fetches nothing it cannot check — it refuses a peer whose genesis id is
not the one you passed. A network with no mining-gate key verifies blocks but rejects mining claims (a warning says so).
`dobs1…` addresses come from the wallet (`obsidian wallet new`) or any interface wallet on the devnet; testnet, staging and
mainnet use `tobs1…`, `sobs1…` and `obs1…`.

## Checking that nodes agree

```bash
node scripts/verify-agreement.mjs http://127.0.0.1:<rpcA> http://127.0.0.1:<rpcB> http://127.0.0.1:<rpcC> --wait 20
curl -s localhost:<rpcA>/finality
curl -s localhost:<rpcA>/producers
```

`verify-agreement.mjs` is read-only. For every node it fetches the genesis, the parameters, the head, and the block hash and
state root at a height they all hold, and exits non-zero on any difference. Run it from a machine that is not one of the
nodes. It also checks that every reported finalized checkpoint is the block every other node holds at that height.

## Rolling back

There is nothing to roll back **to**: 1.8.x is a different chain. To stop using 1.9.0, stop the node and delete its (new) data
directory; the 1.8.x data directory was never touched.

## Not covered

Desktop installers are built per platform; the desktop app embeds the core it was staged with, so rebuild it from this
release. No mainnet launch is performed by this release: the launch steps are in [mainnet-launch.md](mainnet-launch.md).
