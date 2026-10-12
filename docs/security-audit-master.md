# Security audit: master execution pass (core 1.7.x)

Scope and honesty: this pass concentrated on process startup and the data-directory lock, network identity, the P2P
handshake and peer reporting, the RPC surface (health/readiness, privileged routes), trusted origins and cookies, and
dependency state. It was **not** a fresh line-by-line review of every file in the monorepo; earlier audits
(`SECURITY-AUDIT-1.6.0-slashing.md`, `audit/index.html`, the 1.6.x/1.7.0 remediation notes) cover consensus, slashing,
the gate and the web apps, and their findings were not re-opened here. Severity is the author's judgement, not a CVSS
score. Every finding below has a regression test unless it says otherwise.

| # | Severity | Finding | Where | Status | Regression test |
|---|---|---|---|---|---|
| 1 | **High** (chain-dir corruption) | Stale data-directory lock takeover was racy: two processes that read the same stale pid each deleted "the stale lock" and each created their own, so **both held the lock** on one chain directory. Reproduced in 10 of 10 trials with 12 racing processes. | `obsidian-core/src/storage/lock.ts` | Fixed: exclusive takeover guard file, owner re-read under the guard, bounded retries, 2 s grace for an empty file so a live owner mid-creation is not evicted. 0 of 10 bad trials after the fix. | `tests/unit/storage-safety.test.ts` (fails on the old code, passes now) |
| 2 | Medium | `peers` in `/health`, `/status`, `/metrics` and `/peers` counted every open socket, including ones that had not completed the handshake. An idle connection made an isolated node report a peer for the handshake-timeout window; a monitor was told "connected" about nobody. (An existing test helper already filtered `nodeId !== ''`, working around it.) | `obsidian-core/src/networking/p2p.ts` (`peerCount`, `activeConnections`) | Fixed: only handshake-verified links are peers; the rest are `pendingHandshakes`. Connection limits still count every socket. | `tests/integration/p2p.test.ts` ("does NOT count a connection as a peer", verified to fail on the old code) |
| 3 | Medium (availability) | No readiness signal: a node whose P2P listener failed to bind only logged a warning and kept answering `/health` as healthy; there was nothing a balancer or script could ask. | `obsidian-core/src/rpc/server.ts` | Fixed: `/livez`, `/readyz` (503 when no tip, syncing, or the listener is down). | `tests/integration/readiness.test.ts` (7), `rpc-hardening` route list |
| 4 | Medium | A data directory had no recorded identity. The genesis id depends on the bootstrap and gate key lists, which come from configuration, so the same directory could be started with different inputs; there was no operator-facing statement of which network a directory is, and no explicit, idempotent way to create one. | new `src/config/network-manifest.ts`, `src/node.ts`, `src/index.ts` | Fixed by design: `network.json`, `init`, `join`, adopt-or-refuse on start, `--require-init`. The behaviour of the old code when started with changed keys was **not re-measured**; the claim is about what is guaranteed now. | `tests/unit/network-manifest.test.ts` (30), `tests/e2e/operations.test.mjs` (13) |
| 5 | Low | Only one trusted domain family existed. `mineobs.network` and its named hosts had to be added without opening a wildcard or a lookalike. | `obsidian-core/src/config/trusted-origins.ts`, interface copy | Implemented as exact hosts, HTTPS only, no wildcard. | `trusted-origins.test.ts` (22), interface `server.test.ts` (2 new), `rpc-contract.test.ts` |
| 6 | Low | `/peers` is a public read route and lists connected and known peer addresses (topology disclosure). | `obsidian-core/src/rpc/server.ts` | **Fixed in 1.8.0**: full detail only for a local caller (loopback, no forwarding headers) or when `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL` is set; the interface proxy marks its requests so it never leaks it. Residual: a proxy that adds no forwarding header looks local. | `tests/security/rpc-peers-privacy.test.ts` (10), interface proxy `via` test |
| 7 | Info | The `health` and `finality` CLI commands used `fetch` without a timeout and printed a raw error when the node is down. | `obsidian-core/src/index.ts` | **Fixed in 1.8.0**: both use the bounded `httpGetJson` (8 s). `status` reports `UNREACHABLE`. | `tests/unit/cli-fetch-timeout.test.ts` (against a server that never answers) |
| 8 | Info | Dependency state: `npm audit --omit=dev` reported 0 vulnerabilities for `obsidian-core` and `obsidian-interface` when run for this pass. | | n/a | n/a |

Reviewed without a new finding (from reading the code and the existing tests): the handshake checks listed in
`docs/operations.md` §4; the absence of any key-bearing or administrative HTTP route on the node; session cookies
(`HttpOnly`, `SameSite=Lax`, `Secure` when behind a trusted proxy, no `Domain=`).

Known limits that are design constraints, not bugs: gate key rotation/revocation inside one genesis is impossible
without a consensus change; account state is per interface host (see `docs/failover-and-gateways.md`).
