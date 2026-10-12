# Upgrading from 1.7.0 to 1.8.0

**1.8.0 is a protocol change and starts a new chain.** The protocol version is part of the genesis id and the gate key
state is part of the state root, so a 1.7.0 chain cannot be continued by 1.8.0 and the two do not peer (the handshake
refuses it, with a message naming the side that must upgrade). Nothing is migrated automatically. This is acceptable only
for a network that has not launched or is disposable; if a chain holding real value existed, stop and design a migration
first (none is provided).

## What a node operator does

1. Keep the 1.7.0 data directory where it is (do not delete it until the new node is healthy). 1.8.0 refuses to open it.
2. Install the 1.8.0 archive (`releases/obsidian-node-operator-1.8.1.tar.gz`, verified with `scripts/verify-release.sh`).
3. Create the network on a **fresh** data directory with **three or more** gate keys, held by different people:
   `obsidian init --network <name> --generate-gate-key --gate-key-count 3 --data-dir <new dir>` (see
   [gate-authority.md](gate-authority.md)). Other nodes `join` it with the genesis id you publish.
4. `obsidian start` now hosts the interface by default. If you already run the interface separately (systemd units, the
   helper script), set `OBSIDIAN_NODE_ONLY=1` or pass `--no-interface` so two interfaces do not compete for the port.
   The shipped systemd units and `scripts/obsidian-network.sh` already do.
5. If you run several interface hosts, make exactly one `primary` and the rest `edge`
   ([failover-and-gateways.md](failover-and-gateways.md)).
6. `/peers` shows detail only to the local machine now. Tools that read it from elsewhere must use `/nodes`, or set
   `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true` knowingly.

## What changes for users

Nothing visible: wallets, claims and accounts work the same; the new chain starts at height 0.

## Not covered

Desktop installers are built per platform and are not produced by the packaging script (the source and build recipe are
in the archive). The desktop app embeds the core it was staged with: rebuild it from this release to get 1.8.0.
