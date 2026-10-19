# Operating an Obsidian node: bootstrap, join, diagnostics

Every command on this page exists in the built CLI (`obsidian-core/dist/index.js`). The package installs it under two
names, `obsidian` and `obsidian-core`; they are the same program. From a checkout, `node obsidian-core/dist/index.js`
is the same thing again, and the examples below write it as `obsidian`.

```
obsidian <network> <command> [options]      network = mainnet | testnet | staging | devnet
obsidian <command> --network <name> [options]
obsidian node <command> [options]           `node` before init|start|status|peers|sync|doctor is accepted;
                                            a bare `obsidian node` is still `start`
```

`mainnet init` is `init --network mainnet`. It is spelling, not a second implementation. Giving both a network word
and a different `--network` is a usage error.

| Command | What it does |
|---|---|
| `init` | Creates (or confirms) the network identity in the data directory. Idempotent. Never starts a node, never touches chain data. |
| `join --peer <http url> --genesis-id <40 hex>` | Adopts a network from a peer, verified against the genesis id **you** pinned. |
| `start` | Runs the node. |
| `status` | What a running node reports: alive, ready, height, finality, P2P listener, **live** peers. |
| `peers` | The peers connected right now (handshake verified), and how many are only remembered. |
| `sync [status]` | Local height against connected peers. |
| `doctor` | Checks configuration, ports, keys, manifest, a running node and the interface; says what to fix. |
| `validate` | Replays and verifies a data directory (existing command). |

Options added for these commands: `--require-init`, `--generate-gate-key`, `--gate-key-count <n>` (mainnet needs 3+),
`--allow-single-gate-key` (explicit, recorded override), `--gate-dir <path>`, `--peer <url>`,
`--genesis-id <hex>`, `--url <http url>` (ask this node instead of the local one), `--json`.

**Exit codes.** `0` success. `1` failure (a refused operation, an unreachable or not-ready node, a failed check).
`2` usage error. `3` it works but something needs attention (a degraded node, a doctor warning). Scripts can tell
"broken" from "degraded".

## 1. Bootstrap a fresh network on one authorised node

Do this once, on the machine that will be the first node of the network.

```bash
export OBSIDIAN_KEYSTORE_PASSPHRASE='...at least 12 characters...'      # the node's own identity key
export OBSIDIAN_GATE_KEYSTORE_PASSPHRASE='...another 12+ characters...' # the mining gate authority key
obsidian mainnet init --data-dir ~/obsidian-data/mainnet --generate-gate-key --gate-key-count 3
obsidian mainnet start --require-init --data-dir ~/obsidian-data/mainnet
```

`init` refuses mainnet with fewer than three gate keys (see [gate-authority.md](gate-authority.md)); it writes one
keystore per key, to be handed to **different** people or machines. It prints the **genesis id**, the genesis hash, the public gate key(s), and where the encrypted gate keystore was
written (`<data-dir>/../gate-authority/<network>-mining-gate.keystore.json`, mode 0600, outside the node's data
directory). Give the genesis id to everyone who will join, **through a channel other than the first node** (a
published announcement, a signed release note). That id is the root of trust (section 2).

What `init` guarantees, and what is tested (`tests/unit/network-manifest.test.ts`, `tests/e2e/operations.test.mjs`):

* **Deterministic.** The genesis id is derived from the network definition, the gate
  keys. The same inputs give the same id on any machine.
* **Idempotent.** Run it again: it reports `existing`, writes nothing, does not regenerate the gate key, and exits 0.
* **No replacement.** A different gate key list, a different network, or a directory with an unreadable manifest is
  refused by name, and nothing is changed. An existing gate keystore file is never overwritten.
* **Gate keys cannot be added later.** They are part of the genesis id. A directory created without one stays without
  one; the fix is a new network (a new data directory), not an edit.
* **Passphrases** come from the environment or `OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE`, never from an argument
  (arguments are visible in `ps`). They are not printed or written anywhere.

The identity is recorded in `<data-dir>/network.json` (public values only). From then on, `start` resumes **that**
network: a missing key list is filled in from the manifest, a conflicting one is refused with both sides named.
`start` without `init` still creates a new network in an empty directory, as before, so existing launchers keep
working. `--require-init` (or `OBSIDIAN_REQUIRE_INIT=1`) turns that off: use it in production services so a wrong or
empty data directory is an error and not a new chain.

Mainnet and Testnet never mix: a manifest records its network, chain id and genesis id, and a process started for
another network on the same directory is refused. The networks also have separate address prefixes, chain ids,
genesis ids and default ports (section 5), and nodes of different networks are refused at the handshake.

## 2. Join an existing network from another machine

```bash
obsidian mainnet join --data-dir ~/obsidian-data/mainnet \
    --peer http://203.0.113.5:8630 --genesis-id <40-hex id printed by init>
obsidian mainnet start --require-init --data-dir ~/obsidian-data/mainnet --seeds 203.0.113.5:8631
```

(Use the id the first node's `init` printed. It is deliberately not written here: any id in a document is one more thing to trust.)

`join` fetches `/genesis` from the peer, **recomputes** the genesis id from the document the peer sent, and writes the
manifest only if it equals the id you pinned. Consequences, all covered by tests:

* A peer that serves a different gate key (or chain id, network id, protocol version, an extra key, a
  tampered list, malformed keys) is refused, and nothing is written.
* The pin is mandatory and must be 40 lowercase hex characters. There is no trust-on-first-use mode.
* Only **public** keys are ever learned. No private key is requested, sent or accepted.
* The request is bounded: 8 s timeout, 256 KiB maximum, redirects refused.
* An unreachable peer is an error, not a hang; the directory stays joinable.

This is verifiable transitive trust: the gate keys a node learns from any peer are accepted only because they hash to
an id obtained out of band. A peer cannot choose the keys.

The peer connection itself is separate and also authenticated (section 4).

## 3. Diagnostics

```bash
obsidian status --network mainnet                 # exit 0 ready, 3 degraded, 1 not ready/unreachable
obsidian node peers --network mainnet
obsidian node sync status --network mainnet
obsidian mainnet doctor --data-dir ~/obsidian-data/mainnet
obsidian status --network mainnet --url http://203.0.113.5:8630 --json   # ask a remote node's public routes
```

Rules the output follows:

* **Connected means connected.** `peers` and the `connected` count come from the node's live, handshake-verified links.
  The saved peer book is reported on its own line ("known") and never added to the count. A socket that has connected
  but not finished the handshake is counted as `pendingHandshakes`, not as a peer (it used to inflate `peers`; see
  `docs/security-audit-master.md`, finding 2).
* **Unreachable is not zero.** If nothing answers, `status` says `UNREACHABLE` and exits 1.
* After a peer dies, its count drops to 0 within seconds while the saved book keeps it
  (`tests/e2e/operations.test.mjs`, "when A dies...").

`doctor` runs these checks and prints a fix for each failure: data directory writable; lock holder; manifest versus
configuration (a conflict is a FAIL naming both sides); node key opens with the configured passphrase (it never prints
the passphrase and never creates a key); gate key present in the genesis and whether this host is configured as an
issuer; a running node (readiness, P2P listener, peers, last peer problem); RPC and P2P port availability (only when no
node answers there, so it never reports a port "in use" about itself); RPC bound to loopback; the interface's
`/api/ready`.

### Health endpoints

| Endpoint | Where | Meaning |
|---|---|---|
| `GET /livez` | node RPC | The process answers. Always 200. No chain, peer or database dependency. |
| `GET /readyz` | node RPC | 200 `ready` / `ready-degraded`, or 503 `not-ready`. Not ready when there is no chain tip, the node is syncing (or behind a peer by more than one block) or the P2P listener failed. Zero peers is `ready-degraded` (`degraded: ["no-peers"]`) because the first node of a network has none. |
| `GET /health` | node RPC | Version, network, genesis id, height, peers, supply invariant. 500 if the supply invariant fails. |
| `GET /peers` | node RPC | Connected peers, saved peers, P2P status, last peer problem. |
| `GET /api/health` | interface | The interface process is up, how many nodes it sees. |
| `GET /api/ready` | interface | 200 only when it reaches at least one healthy node of its own network, with no genesis mismatch. |

**What `/readyz` tells apart (1.8.1).** One answer is not enough to run a network, so the body reports each dimension
separately under `checks`, and only the first three decide the status code:

| Question | Where to read it | Decides 200/503? |
|---|---|---|
| Is the process alive? | `GET /livez` | (separate endpoint) |
| Is RPC ready? | `checks.rpc` | no (if you got an answer, it is) |
| Is the chain loaded? | `checks.chain` (`height`, `headHash`) | **yes** |
| Syncing, or synced? | `checks.sync` (`syncing`, `behindBy`) | **yes** |
| Is the P2P listener up? How many peers? | `checks.p2p` | **yes** (listener); peers only `degraded: no-peers` |
| Is it the network I pinned? | `checks.identity` (`genesisId`, `networkId`); a mismatch adds `identity-mismatch` to `degraded` | no, but `status` becomes `ready-degraded` |
| Is consensus alive? | `checks.lastBlockAgeSeconds` | no |
| Is finality progressing? | `checks.finality` (`finalizedHeight`, `lag`, `maxLag` 64); a lag adds `finality-lagging` to `advisories`. Shown to a caller on the node's machine only; a public caller gets neither | no |
| Is the gate authority sound? | `checks.gateAuthority` (`open`, `activeKeys`, `quorum`, `epoch`, `warnings`) | no (`advisories`: `gate-closed`, `gate-single-key`, `gate-below-three-keys`) |
| Interface role and its dependencies | interface `GET /api/ready` (`role`, `leader`, nodes) | its own 200/503 |

`degraded` lists things that make the node less useful; `advisories` lists things an operator should fix that never
justify draining a node. A load balancer should key on the status code; a dashboard should graph the dimensions.

`/readyz` returns no address, key or peer list. **`/peers` (1.8.0)** gives the full peer detail only to a caller on the
node's own machine (a loopback connection with no forwarding headers: `X-Forwarded-*`, `Forwarded`, `Via`, `X-Real-IP`);
anyone else gets counts only. The interface proxy marks its requests with `Via`, so the public never receives detail
through it. To publish the detail anyway set `rpcPublicPeerDetail` / `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true`. A reverse
proxy in front of the node must add a forwarding header (the shipped nginx file sets `X-Forwarded-For`); a bare TCP
proxy that adds none would look local. `/nodes`, JSON-RPC `getpeers` and `getnodes`, and the `p2p` block of `/status` follow
the same rule (counts for everyone else): peers find each other over the P2P protocol, not through a public directory.
The finalized height and its lag follow it too: `/finality` is a `404`, and the finality fields of `/status`, `/readyz` and `/producers`
are left out, for anyone who is not the operator (consensus is unchanged; only what is shown). The same switch publishes them.

## 4. Peer discovery and the handshake

Discovery is layered: configured seeds (`--seeds`, `OBSIDIAN_SEED_NODES`), the saved peer book, and peer exchange
(gossiped addresses are only hints and are dialled and verified like any other). Every connection must complete a
challenge–response handshake before any other message is processed. The acceptor checks, in this order of cost:
timestamp within ±300 s; finality checkpoint well-formed; **genesis id**; **chain id and network id**; **consensus
parameter hash**; **protocol version** (exact match) and minimum core version; not itself; the **public key derives the
claimed identity address and signs the whole hello**; the signature covers **this connection's challenge** (a recorded
hello replayed on another connection is refused); the peer's finalized checkpoint does not conflict with local history;
one live connection per node id. Frames are size-limited before parsing (a peer that has not said hello cannot make the
node parse a megabyte), messages are rate-budgeted per link, inbound connections are limited per IP, and handshakes time
out. These are covered by `tests/integration/p2p.test.ts` and `tests/security/protocol-security.test.ts`.

Capabilities are advertised for information (`capabilities` in the hello); the node does not gate behaviour on them.

## 5. Ports

| Network | Chain id | Prefix | Node RPC (loopback) | Node P2P (public) | Interface | Data |
|---|---|---|---|---|---|---|
| mainnet | 7777 | `obs1` | 8630 | 8631 | 8788 | `…/mainnet/` |
| testnet | 7778 | `tobs1` | 18630 | 18631 | 18788 | `…/testnet/` |
| staging | 7779 | `sobs1` | 28630 | 28631 | 28788 | `…/staging/` |
| devnet | 7780 | `dobs1` | 38630 | 38631 | 38788 | `…/devnet/` |

`--port-offset N` adds N to every port of a node (check the result does not land on another node's port: offset 1 on
mainnet moves RPC to 8631, which is mainnet's P2P port). Only P2P and the interface are meant to be reachable from
outside. The node RPC stays on `127.0.0.1`: it carries the transaction relay and operator routes, and `doctor` warns when
it is bound elsewhere. Public traffic reaches chain data through the interface (`/api/rpc`, `/api/nodes`) or a reverse
proxy that exposes only the read routes. Do not publish the RPC port directly.

Interface per node (1.8.0): **`obsidian start` hosts the interface by default.** It supervises
`obsidian-interface/dist/server/main.js` as a child process (found through `OBSIDIAN_INTERFACE_DIR`, then
`../obsidian-interface`, then `./obsidian-interface`), on the network's interface port, with its data beside the node's
(`OBSIDIAN_INTERFACE_DATA_DIR`, default `<node data dir>/../interface`), output prefixed `[interface]`. If the files are
not built or not found, the node runs alone and says so. If an interface already answers on that port, nothing is started.
A crashed interface is restarted with a backoff (1 s up to 60 s); after 8 failures in a row the supervisor stops trying
and the node carries on. **The interface can never stop or slow the node.** Opt out with `--no-interface` or
`OBSIDIAN_NODE_ONLY=1` (the systemd units, `scripts/obsidian-network.sh`, which manages its own interface, and the
test harnesses all do). The interface is a separate process that talks to the node over its loopback RPC; it is not
linked into the node process.

## 6. Gate authority: provisioning, rotation, revocation, recovery

* **Provisioning.** `init --generate-gate-key` on the first node. The private key is encrypted, mode 0600, written
  outside the data directory, never put in the manifest, never sent to a peer. The public key goes into the genesis.
* **Which host holds it.** The machine that runs the account platform (`OBSIDIAN_GATE_KEYSTORE` with
  `OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE`). Nodes only verify; they hold the public key.
* **Rotation and revocation (1.8.0): on chain.** The keys in genesis are only the starting set. A majority of the
  *current* keys can add and revoke keys with a `GATE_AUTHORITY` transaction, no new genesis needed:
  `gate status | propose | sign | submit`. A revoked key's certificates stop being valid at the next block. Create three or
  more keys at `init` (`--gate-key-count 3`) so a stolen one can be revoked by the others. Full procedure and playbooks:
  [gate-authority.md](gate-authority.md).
* **Recovery.** Back up each encrypted keystore and its passphrase separately and offline. Lost or stolen key: the
  remaining majority replaces it. **If a majority is lost, no update is possible and the recovery is a new network
  with a new genesis** (stated, not hidden). The step-by-step runbook is [gate-recovery-runbook.md](gate-recovery-runbook.md).

## 7. Disposable validation

To try all of this without touching a real directory, use a temp directory and shifted ports, as the test does:

```bash
node --test tests/e2e/operations.test.mjs        # needs: npm --prefix obsidian-core run build
```

## 8. Restarting, backing up, and upgrading without losing the network

**What a restart loads.** `start` resumes the identity recorded in `<data-dir>/network.json` (network, chain id, genesis
id, the public gate and bootstrap keys), re-checks that the key list still derives that genesis id, replays and verifies
the chain it finds, restores the finality checkpoint (a corrupt or incompatible one makes startup fail rather than
continue), and rebuilds the active gate set from the chain, so a rotation or revocation made before the restart is still
in force. **A restart never regenerates a genesis or a key**: `init` is idempotent and refuses to overwrite a keystore,
and `--require-init` turns a wrong or empty data directory into an error.

**What to back up** (separately, offline, and test a restore):

| Item | Where | Why |
|---|---|---|
| Node data directory | `<data-dir>` (chain, `network.json`, finality checkpoint, peers) | Fast restore. Replaceable by re-syncing from peers against your pinned genesis id. |
| Node identity keystore + passphrase | per `OBSIDIAN_KEYSTORE_*` | Your node's identity key (producer and reward-evidence identity). **Not replaceable.** It never leaves your machine. |
| Gate keystores + passphrases | `<data-dir>/../gate-authority/*.keystore.json` | Not replaceable; one per holder. |
| Interface account store | `interface-accounts.json` under the interface data dir | Accounts, wallet links, sessions. Back it up while the interface is stopped or from a consistent snapshot. |
| Genesis id and the public key list | wherever you published them | The root of trust for any rebuild. |

A user's wallet vault is in **their** browser, and their recovery phrase is theirs; the platform keeps neither
(see [wallet-custody.md](wallet-custody.md)).

**Moving to 2.0.2 is not an in-place upgrade.** The protocol, params hash and genesis ids change (a fresh start), so use a
new data directory; keystores and wallets carry over untouched. See [upgrading-2.0.2.md](upgrading-2.0.2.md) for the checklist.

**Not tested here:** a full disk and torn writes at the filesystem level (the code writes finality state and keystores
by atomic replace and the tests simulate a crash between steps, but nobody has filled a disk or pulled a plug),
a restore of an AWS volume, and a restart under production load.
