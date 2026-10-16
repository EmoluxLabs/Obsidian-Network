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
| T1 | A malicious peer or join source supplies its own gate keys to a new node | `join` recomputes the genesis id from the peer's document and accepts it only if it equals an id the operator pinned out of band; the pin is mandatory (no trust on first use) | `tests/unit/network-manifest.test.ts` (wrong pin, swapped key, extra key, tampered list, wrong chain, wrong protocol, malformed keys, bad pin syntax); `tests/e2e/operations.test.mjs` (a live process serving different keys) |
| T2 | Two processes start on one data directory and corrupt the chain | the data-directory lock; stale-lock takeover was racy (finding 1) and is now serialised | `tests/unit/storage-safety.test.ts` (fails on the old code); live duplicate start in the e2e |
| T3 | An operator starts a "mainnet" node with a different key list or the wrong directory and silently creates or joins another chain | `network.json` records the identity; start adopts it, refuses a conflict naming both sides, refuses another network's directory, refuses a manifest whose keys no longer derive its id; `--require-init` forbids creating a chain | unit + e2e as above |
| T4 | A corrupt or hand-edited manifest is "fixed" by guessing | a corrupt manifest is a hard error and is never rewritten | unit + e2e |
| T5 | A node of another network, chain or version is accepted as a peer | handshake checks network id, chain id, genesis id, parameter hash, exact protocol version, minimum core version | `tests/integration/p2p.test.ts`, `tests/security/protocol-security.test.ts` |
| T6 | Peer impersonation or replay of a recorded hello | signature by the key that derives the claimed identity, over a challenge the acceptor issued for this connection; ±300 s timestamp | `p2p.test.ts` ("rejects a RECORDED hello replayed...", "made-up challenge") |
| T7 | Resource exhaustion by sockets or frames | connection limits, per-IP inbound limit, handshake timeout, pre-handshake frame cap, per-link message budgets | `p2p.test.ts` (megabyte before hello; flood throttle) |
| T8 | An idle unauthenticated socket makes a node look connected, hiding isolation from the operator or a monitor | only handshake-verified links count as peers; the rest are `pendingHandshakes` | `p2p.test.ts` ("does NOT count a connection as a peer..."; fails on the old code) |
| T9 | A saved peer is shown as connected; a dead node looks healthy | `peers`/`status` read live links; saved peers are a separate figure; an unreachable node is `UNREACHABLE`, exit 1 | e2e ("when A dies...") |
| T10 | An isolated node (P2P listener failed) keeps receiving traffic | `/readyz` is 503 when the listener is down or the node is syncing; a balancer can drain it | `tests/integration/readiness.test.ts` |
| T11 | A leaked or stolen gate private key | Encrypted at rest, mode 0600, outside the data dir, never in the manifest/output/peer traffic, refuses overwrite. Since 1.8.0 a stolen or lost key is revoked on chain by a majority of the others (`gate-recovery-runbook.md`); mainnet `init` now refuses fewer than 3 keys so that a majority exists to do it | `network-manifest.test.ts` (gate key tests) |
| T12 | A lookalike domain is trusted (`mineobs.network.attacker.example`, `evilmineobs.network`, userinfo tricks, other ports, HTTP, extra labels) | one exact-hostname policy, parsed with the URL parser; no wildcard on a public suffix; HTTPS only | `tests/security/trusted-origins.test.ts` (22), `obsidian-interface/tests/server.test.ts` |
| T13 | A trusted origin is used to act as a signed-in user | trusted origins get public reads and signed-tx relay only; no credentials header; account routes need an operator-listed origin | `obsidian-interface/tests/server.test.ts` |
| T14 | Sensitive RPC exposed to the internet | the node RPC binds `127.0.0.1` by default; `doctor` warns otherwise; the node has no key- or admin-bearing HTTP route (POST routes are transaction submit/simulate/encode/gas, balance/quote queries and JSON-RPC); a public read-only node can set `rpcAllowSubmit=false` | `tests/security/rpc-hardening.test.ts` (no route echoes key material) |
| T15 | The interface used as an open proxy | `/api/rpc` takes a path on the configured node list, not a host | `obsidian-interface/tests/server.test.ts` (existing) |

## Not defended against (residual risk)

* **Gate key compromise or loss** (T11): recoverable by the remaining majority; a stolen or lost *majority* needs a new
  genesis. Certificates are short-lived, which narrows what a stolen certificate does, not what a stolen key does.
* **Domain takeover** of `mineobs.network` or `obsmainnet.us.ci`: the policy trusts the name.
* **A wrong pinned id**: if the operator pins an id obtained from an attacker, `join` adopts the attacker's network.
  The pin is only as good as the channel it came by.
* **Eclipse by the first peers**: a node whose only seeds are hostile follows a chain the hostile peers serve, if that
  chain is valid for the genesis it pinned. It cannot be made to accept a different genesis; it can be starved of the
  honest chain. Use several independent seeds.
* **Peer list**: since 1.8.0 `/peers` shows addresses only to a local caller; a proxy that adds no forwarding header would look local. `/nodes` still lists known peers by design.
* **PID reuse** can make a stale lock look held (the safe direction: the start is refused until it is cleared).
* **Multi-host interface**: account state is one store. Either run one `primary` with `edge` hosts, or share a store and a lease between primary-capable hosts (1.8.1, failover-and-gateways.md §1b); a file lease is not safe on NFS.
* **Gate keys**: a majority of keys stolen lets an attacker rewrite the set; a majority lost makes the set unchangeable (a new network is the only recovery).

## 1.8.1 additions

| # | Threat | Control | Evidence |
|---|---|---|---|
| T16 | Two interface hosts both believe they are primary and both issue gate certificates or write accounts (split brain) | lease with fencing token, monotonic self-expiry shorter than the takeover window, write-time fence, `assertLeader()` before signing, standby refuses (503) | `lease.test.ts`, `server.test.ts` "primary failover", `e2e/failover.test.mjs` (real processes: SIGKILL under load, paused leader wakes up fenced, partition/heal) |
| T17 | A deposed or paused leader overwrites the shared account store | `FencingError` on a write whose token is no longer current; the file is untouched | `lease.test.ts`, `failover.test.mjs` |
| T18 | A clock skewed by more than the configured bound steals or keeps leadership | `ttl > 4*skew` enforced at startup; leader trusts itself only `ttl - 2*skew` of monotonic time; follower waits `expiresAt + skew` | `lease.test.ts` (stale and skewed clocks), `ha-config.test.ts` |
| T19 | A mainnet authority is created with a single gate key that can replace itself and cannot be recovered | `init` refuses fewer than 3 keys on mainnet (explicit `--allow-single-gate-key`); `/gate` and `/readyz` warn about 0, 1 or 2 keys from any source | `network-manifest.test.ts`, `gate-cli.test.ts`, `readiness.test.ts` |
| T20 | A restart, offline period or rotation leaves a node on a stale or different gate set | the set is rebuilt from the chain; catch-up through rotation and revocation reaches the same state root; replayed, skipped, conflicting and cross-network updates are refused for the stated reason | `tests/security/gate-recovery.test.ts` (9), `gate-authority.test.ts` (25) |
| T21 | A node health check says "ready" while finality, the gate or the identity is broken | `/readyz` reports identity, finality, gate authority and last-block age separately, with `degraded` and `advisories` | `readiness.test.ts` |
| T22 | A tampered or damaged wallet vault freezes the page (huge iteration count) or is accepted in a downgraded form | the envelope is validated before any key derivation (version, KDF, iteration range, field sizes) | `wallet-vault.test.ts`, `vault-interop.test.mjs` |
| T23 | A planted or stale session cookie survives sign-in | fresh secret on every sign-in, the presented session is ended, only server-issued tokens are accepted | `server.test.ts` "planted session cookie" |
| T24 | A release archive or manifest is swapped, or a release is signed by an unknown party | Ed25519 signature over SHA256SUMS + MANIFEST.json + version + commit; the verifier trusts only a fingerprint **it** pinned; integrity, version, tag, changelog and embedded-binary agreement checked | `release-tool.test.mjs` (12) |
| T25 | A credential is committed | `scripts/scan-secrets.mjs` over every tracked file, current tree and (once, by hand) history; findings print rule and line only | `scan-secrets.test.mjs` |
| T26 | A known-vulnerable dependency ships | `npm audit` on every package with a lockfile (0 vulnerabilities when last run; re-run before a release); wallet-web and the extension have no dependencies | output of `npm audit` at release time |

## Residual-risk register (1.9.0)

Severity is the authors' judgement. "Owner" is who has to act. Nothing here is closed by code in this repository.

| ID | Risk | Severity | Why it is open | Owner / action |
|---|---|---|---|---|
| R1 | **No publisher signing key exists**, so no release is authenticated; all published archives are unsigned | High | A key must be created and held by the publisher; this project must not invent one | Publisher: `release-tool.mjs keygen` offline, publish the fingerprint in two independent places, `sign`, attach (release-signing.md) |
| R2 | The file lease is not safe on NFS or most network file systems | High for multi-machine HA | Needs a real coordination service | Operator: keep primary-capable hosts on one machine/local disk, or implement an etcd/Postgres elector |
| R3 | Every primary-capable host holds the gate keystore | Medium | Needed so any of them can lead | Operator: keep the set small, use a 3-of-5 gate set |
| R4 | Majority of gate keys stolen or lost | High | By design: the chain cannot tell a thief from the owners | Operator: separate holders, tested backups (runbook) |
| R5 | Consensus is reviewed only by its authors; no formal model; no hostile-network test | High | Needs independent reviewers | Commission an external review of `src/consensus` and `src/blockchain` |
| R6 | Finality needs at least two established producers and a quorum of them (all of them for two or three): with fewer, or with one offline, nothing new is called final and the chain keeps producing | Medium | Inherent liveness cost of quorum finality (`minProducers` 2, quorum 2/3+1) | Operator: run more nodes, or accept that a small network does not finalize |
| R15 | Registration is free: a patient actor with many machines can capture a third of the producers (stalling finality) or more | High | No deposit by design (no VPS, no bond) | Rate limits and maturity only; see consensus-v1.9.0.md section 8 |
| R16 | An unsigned node-wallet binding can be squatted by a stranger | Medium | Binding needs no wallet signature by design | The wallet owner reclaims it (node-binding-v1.9.0.md section 4) |
| R17 | A network partition longer than 30 reward periods, with at least two producers on each side, lets each side drop the other from the finality base and finalize separately | Medium | A silent node must eventually stop counting or abandoned nodes would stall finality for ever; suspension deliberately does *not* shrink the base (finality-v1.9.0.md section 7) | Operator: heal a split well inside 30 days; compare nodes with `scripts/verify-agreement.mjs` |
| R18 | Finality is quorum finality over producer diversity, not accountable BFT finality: it has no slashing of conflicting finalizations, and safety assumes fewer than a third of the producers are faulty | Medium | Accountable finality needs signed votes and a bond; both contradict the no-voting, no-bond design | A separate protocol decision (a vote-based finality gadget would be a new consensus version) |
| R19 | The desktop app generates the passphrase of its own node-identity key and keeps it in an owner-only file beside that key (`node-key.pass`), on every network | Low | The key signs only the node's own statements and holds no funds; the app has no terminal to ask on, and sealing the passphrase in the operating system's secret store could not be verified in this environment (no desktop session) | Operator: protect the user profile (full-disk encryption); future change: seal with the OS secret store |
| R20 | A listing is locked state: if the owner loses the key, the name stays locked (no delist, no recovery) until it is bought or its term and grace end | Medium | The listing lock must not be defeatable by a recovery address, or the lock would be meaningless; the owner key is the only authority | Owner: delist or sell before risking the key; documented in marketplace-v2.0.0.md |
| R21 | Offer-slot squatting: an actor with funds can park up to 16 pending offers on a name (each from a different account) for up to 7 days, crowding out genuine offers | Low | Each slot costs the squatter locked funds plus gas and every offer lapses; a larger cap would raise per-name work | Owner: decline them (frees the slot at once) or list the name (refunds all) |
| R22 | Escrow is a protocol-held balance (`marketEscrowObs`): a bug in its accounting would be a supply bug | Medium | The conservation check includes it and must equal the sum of the pending offers on every block, and every release goes through one function; both are tested, not independently reviewed | Reviewers: include `src/economy/market.ts` in the external review (R5) |
| R23 | A name inside its grace period could be registered by a stranger (2.0.0), taking a name its owner can still renew and wiping its listing and offers | Medium | Fixed in 2.0.1: `REGISTER` is allowed only after `expiresAt + grace`; covered by a marketplace test | Closed |
| R24 | A recipient or pointer address written in uppercase bech32 credited an account nobody can sign for (2.0.0): funds lost to a QR scan or a pasted address | High | Fixed in 2.0.1: consensus requires the canonical lowercase address; every encoder lowercases an all-uppercase address; covered by `address-canonical` | Closed |
| R25 | Block assembly did not enforce the per-block admission limits (node registrations, equivocation reports): with three registrations pooled in one slot a producer signed an over-limit block, every validator rejected it, and the double-sign lock stopped all producers from building on that parent, halting the chain (1.9.0 to 2.0.0) | High | Fixed in 2.0.1: one tally per assembled block, limit-deferred transactions stay pooled, and the assembled list is replayed as a validator would before signing (an empty block on any mismatch); covered by the node-runners test and the cluster end-to-end test | Closed |
| R7 | The vault header is not authenticated data (a locked page can be made to *display* another address) | Low | Needs a new vault version across four products | Future change, versioned and migrated |
| R8 | Script on the wallet origin can read an unlocked wallet | Medium | Inherent to a browser wallet | Never add third-party script to the wallet origin; use a clean browser profile for large balances |
| R9 | Domain takeover; wrong pinned genesis id; eclipse by hostile seeds | Medium | Trust roots outside the code | Operator: pin ids from two channels, use several independent seeds |
| R10 | A crash inside the ~2 s session flush window can undo a login or a logout | Low | Performance trade-off | Accepted, documented |
| R11 | Full-disk and torn-write behaviour, and real power loss, are untested | Medium | No filesystem fault injection | Operator: monitor disk, keep backups |
| R12 | Reproducible builds are not demonstrated for every artifact (no independent build comparison is recorded for this release) | Medium | Independent build environments were not available | Third party: rebuild with `reproduce-release.sh` on another machine |
| R13 | AWS testnet nodes still run code without the 1.8.x fixes | Medium | Outside the repository and the sandbox | Operator: deploy the fixed build, restart Node 2 with mining disabled, without resetting data |
| R14 | Desktop installers are not built or signed here | Medium | Per-platform build, signing identities | Operator: build and sign per platform |
