# Threat model: network bootstrap, join, peers, gate and trusted domains

Scope: the operational surface added or changed in this release line (init/join/manifest, readiness, peer reporting,
the data-directory lock, trusted domains) and the existing surfaces they depend on. It is a working model, not a proof.
"Tested" means a test in this repository fails if the control is removed or changed.

## Assets

1. Chain integrity (what the genesis id commits to; the data directory).
2. The mining gate authority private key (the only key that can authorise a mining claim).
3. The node identity key (proves "this is node X" in the handshake; no funds).
4. Operator availability (a node that starts, reports truthfully and recovers).
5. Users' wallet secrets: never held by a node, interface or this tooling.

## Adversaries and the controls

| # | Threat | Control | Evidence |
|---|---|---|---|
| T1 | A malicious peer or join source supplies its own gate or validator keys to a new node | `join` recomputes the genesis id from the peer's document and accepts it only if it equals an id the operator pinned out of band; the pin is mandatory (no trust on first use) | `tests/unit/network-manifest.test.ts` (wrong pin, swapped key, extra key, tampered list, wrong chain, wrong protocol, malformed keys, bad pin syntax); `tests/e2e/operations.test.mjs` (a live process serving different keys) |
| T2 | Two processes start on one data directory and corrupt the chain | the data-directory lock; stale-lock takeover was racy (finding 1) and is now serialised | `tests/unit/storage-safety.test.ts` (fails on the old code); live duplicate start in the e2e |
| T3 | An operator starts a "mainnet" node with a different key list or the wrong directory and silently creates or joins another chain | `network.json` records the identity; start adopts it, refuses a conflict naming both sides, refuses another network's directory, refuses a manifest whose keys no longer derive its id; `--require-init` forbids creating a chain | unit + e2e as above |
| T4 | A corrupt or hand-edited manifest is "fixed" by guessing | a corrupt manifest is a hard error and is never rewritten | unit + e2e |
| T5 | A node of another network, chain or version is accepted as a peer | handshake checks network id, chain id, genesis id, parameter hash, exact protocol version, minimum core version | `tests/integration/p2p.test.ts`, `tests/security/protocol-security.test.ts` |
| T6 | Peer impersonation or replay of a recorded hello | signature by the key that derives the claimed identity, over a challenge the acceptor issued for this connection; ±300 s timestamp | `p2p.test.ts` ("rejects a RECORDED hello replayed...", "made-up challenge") |
| T7 | Resource exhaustion by sockets or frames | connection limits, per-IP inbound limit, handshake timeout, pre-handshake frame cap, per-link message budgets | `p2p.test.ts` (megabyte before hello; flood throttle) |
| T8 | An idle unauthenticated socket makes a node look connected, hiding isolation from the operator or a monitor | only handshake-verified links count as peers; the rest are `pendingHandshakes` | `p2p.test.ts` ("does NOT count a connection as a peer..."; fails on the old code) |
| T9 | A saved peer is shown as connected; a dead node looks healthy | `peers`/`status` read live links; saved peers are a separate figure; an unreachable node is `UNREACHABLE`, exit 1 | e2e ("when A dies...") |
| T10 | An isolated node (P2P listener failed) keeps receiving traffic | `/readyz` is 503 when the listener is down or the node is syncing; a balancer can drain it | `tests/integration/readiness.test.ts` |
| T11 | A leaked or stolen gate private key | Encrypted at rest, mode 0600, outside the data dir, never in the manifest/output/peer traffic, refuses overwrite. **Not mitigated by this release inside consensus:** the key stays valid until a new genesis (see operations.md §6) | `network-manifest.test.ts` (gate key tests) |
| T12 | A lookalike domain is trusted (`mineobs.network.attacker.example`, `evilmineobs.network`, userinfo tricks, other ports, HTTP, extra labels) | one exact-hostname policy, parsed with the URL parser; no wildcard on a public suffix; HTTPS only | `tests/security/trusted-origins.test.ts` (22), `obsidian-interface/tests/server.test.ts` |
| T13 | A trusted origin is used to act as a signed-in user | trusted origins get public reads and signed-tx relay only; no credentials header; account routes need an operator-listed origin | `obsidian-interface/tests/server.test.ts` |
| T14 | Sensitive RPC exposed to the internet | the node RPC binds `127.0.0.1` by default; `doctor` warns otherwise; the node has no key- or admin-bearing HTTP route (POST routes are transaction submit/simulate/encode/gas, balance/quote queries and JSON-RPC); a public read-only node can set `rpcAllowSubmit=false` | `tests/security/rpc-hardening.test.ts` (no route echoes key material) |
| T15 | The interface used as an open proxy | `/api/rpc` takes a path on the configured node list, not a host | `obsidian-interface/tests/server.test.ts` (existing) |

## Not defended against (residual risk)

* **Gate key compromise or loss** (T11): requires a new genesis. Certificates are short-lived, which narrows what a
  stolen certificate does, not what a stolen key does.
* **Domain takeover** of `mineobs.network` or `obsmainnet.us.ci`: the policy trusts the name.
* **A wrong pinned id**: if the operator pins an id obtained from an attacker, `join` adopts the attacker's network.
  The pin is only as good as the channel it came by.
* **Eclipse by the first peers**: a node whose only seeds are hostile follows a chain the hostile peers serve, if that
  chain is valid for the genesis it pinned. It cannot be made to accept a different genesis; it can be starved of the
  honest chain. Use several independent seeds.
* **Public peer list**: `/peers` exposes connected and known peer addresses on any node whose RPC is reachable.
* **PID reuse** can make a stale lock look held (the safe direction: the start is refused until it is cleared).
* **Multi-host interface**: account state is per host (failover-and-gateways.md §1).
