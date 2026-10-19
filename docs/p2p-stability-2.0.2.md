# Peer privacy, three-node stability and peer discovery (2.0.2 patch)

This is the written record of one piece of work: a request to take peer and node lists off every public surface, to find out
why two of three mainnet nodes keep stopping, and to make peer discovery and reconnection automatic and bounded. It holds the ten
reports that request asked for. **Nothing in it was run against a production node:** the sandbox this work was done in has no
access to the servers, so every statement about the deployed software is either marked *source-derived* or listed as missing
evidence (section 2). The patch is on the working branch only; nothing was deployed, restarted, tagged or released.

What is **unchanged**, checked by running the built code before and after: the params hash, the genesis id of all four networks,
chain ids (7777, 7778, 7779, 7780), network ids, address prefixes (`obs`, `tobs`, `sobs`, `dobs`), the wire protocol and the
handshake, the snapshot format, and the keystore and data formats. No consensus rule, parameter, fee, key or validator-set code
was touched; the changed source files are listed in section 3.

Evidence labels used throughout: **REPRODUCED** (ran it, saw it), **TESTED** (a test that fails without the change passes with it),
**SOURCE** (read from the code, not run), **NOT RUN**.

---

## 1. Peer visibility report

**Rule applied.** A peer list is a map of the network. Nodes find each other over the P2P protocol; nobody needs a public
directory for that. So the node's operator sees peers (a caller on the node's own machine, with no proxy headers, or the
explicit `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true`); everyone else sees counts at most. This is the rule `GET /peers` already had;
it now covers the other routes that disclosed the same thing. No new authentication mechanism was added.

| Surface | Before | After |
| --- | --- | --- |
| Node `GET /nodes` | **public**: this node's signed announcement, plus address, node id, height and score of every known peer | operator only; everyone else gets `{ self: null, peers: [], detail: "counts-only" }` |
| Node JSON-RPC `getpeers`, `getnodes` | **public**, unrestricted | operator only; everyone else gets an empty answer, not an error |
| Node `GET /status`, `p2p` block | **public**, including `lastError` (text that can name a peer address), node id, identity and this node's advertised endpoint | counts only for everyone but the operator |
| Node `GET /peers` (counts-only view) | counts, but also this node's id, identity and endpoint | counts only |
| Node `GET /network` | a hint telling readers to query `/nodes` on several nodes | hint rewritten: discovery is node to node |
| Interface `/api/nodes` | **public**: every node URL, height, latency, genesis, peers | `{ network, live, consensusHeight, genesisMismatch }` |
| Interface `/api/nodes/refresh` (POST) | returned the same table | returns the same four fields |
| Interface `/api/nodes/detail` | did not exist | the table, **only** to a caller on the server itself; 404 to anything carrying a proxy header |
| Interface `/api/rpc?path=/peers`, `/nodes` | proxied (allowlisted) | refused (`ERR_REJECTED`) |
| Interface response header `x-obsidian-node` | **the node's URL, on every proxied read** | constant `chain` (a marker the CDN worker keys on) |
| Cloudflare worker and Terraform cache list | cached `/nodes…` | only `/nodes/registry`, `/nodes/status/`, `/nodes/rewards` (the on-chain node-runner registry) |
| Platform pages | banner showed peers, the node address and latency; Network panel listed nodes and URLs; Explorer, Landing, Developer pages showed peer counts and "Peer detail" | banner: LIVE / NO NODES, height, network height; panel: "Connection to the chain"; counts and detail rows removed |
| Web App explorer | NODES THIS APP READS list, PEERS row | CONNECTION (reachable, network height); PEERS row removed |
| Browser extension | PEERS row, "NODES BEHIND THIS SERVER" list with hostnames | link status only |
| Wallet web | peer count read into its node object (not displayed) | field removed |
| Desktop app | peer tables from the operator's own node | **kept, on purpose**: it is the operator's console on their own machine and reads the node's operator-only `/peers` over loopback |

**Deliberately kept.** P2P discovery, node-to-node messaging, block and transaction propagation, the interface's internal node
pool (it reads each configured node's `/status`, never `/nodes`), `/api/health` and `/api/ready` (counts of configured and
healthy nodes, no address), `/health` and `/readyz` (a count, no address), auto-reconnect.

**Judgement calls the operator may want to reverse.** (a) A bare *peer count* is no longer shown on public pages, because it is
a peer-health display; the count is still in `/status` for tooling. (b) `/api/health` still reports how many nodes are configured
and healthy; that is what a load-balancer check needs. (c) The node-runner registry (`/nodes/registry`, `/nodes/status/<id>`) is
consensus state about reward participants, built from transactions already public in blocks; a registration may carry an
optional endpoint hint that anyone can read from the block itself. The shipped node agent registers none. The UI no longer
displays it, but the API cannot hide chain data.

**Tests.** `obsidian-core/tests/security/rpc-peers-privacy.test.ts` (every route above for a proxied caller leaks no
address, node id or endpoint; the operator still gets detail; `OBSIDIAN_RPC_PUBLIC_PEER_DETAIL` publishes all peer routes at once and
only on purpose), `obsidian-interface/tests/server.test.ts` ("the interface publishes no peer or node list", including that
the internal pool still fails over), `tests/scripts/public-peer-surfaces.test.mjs` (source guard over every public UI file, the proxy,
the CDN worker; shown to fail when a `client.peers()` call is put back). Results: section 4.

---

## 2. Root-cause report

**Status: the production cause is NOT established. No claim is made that any change below stops the two nodes from stopping.**

### 2.1 Missing production evidence

Nothing about the deployed nodes was available. Required, and not seen:

1. Which commit and version each of the three nodes runs (a 2.0.1 node and a 2.0.2 node refuse each other at the handshake; that
   looks like "peers keep dropping", not like a crash).
2. Whether the two failing nodes are *stopping* (process exit) or *losing peers* (process up, `peers: 0`). The report says "stop or
   crash"; these have different causes.
3. For each stop: exit status and signal, `NRestarts`, the journal for the minute before. An out-of-memory kill, a full disk, a
   passphrase missing at restart, a port held by a stale process and an unhandled error each look different here.
4. The unit file, the env file (variable *names* only), and the data directory of each node; the working node versus each failing node.
5. `seedNodes` / `OBSIDIAN_SEED_NODES`: mainnet ships `seedNodes: []`, so a node with none configured has nobody to dial. This alone does
   not explain a stop; it is a thing to check.
6. Clock offset (a hello more than 300 s off is refused; a block more than 10 s ahead is refused), disk space and inodes, memory, the
   open-file limit, the firewall rules for the P2P port, and the advertised address of each node.
7. Whether `OBSIDIAN_MINING_ENABLED=false` on node 2 is still the case, and which node is which (the working one is the interesting one).

### 2.2 Safe, read-only commands for the operator

Run on each node, **one node at a time**, as a user who can read the journal. None changes anything, restarts anything or prints a
secret. Do not paste env *values* anywhere; the command below prints names only. The unit and paths are the ones this repository
ships (`obsidian-node@mainnet`, `/var/lib/obsidian/mainnet/node`, `/etc/obsidian/mainnet/node.env`); substitute your own if they differ.

```bash
# identity of the build and of the chain this node is on  (compare all three nodes: they must match, field for field)
git -C /opt/obsidian/obsidian-core rev-parse HEAD 2>/dev/null
curl -s http://127.0.0.1:8630/health | jq '{network,networkId,chainId,genesisId,coreVersion,protocolVersion,height,headHash,peers,syncing}'
curl -s http://127.0.0.1:8630/params | jq '.paramsHash'
curl -s http://127.0.0.1:8630/finality | jq '{finalizedHeight,lag,available,eligibleProducers,quorum}'
curl -s http://127.0.0.1:8630/peers | jq '{p2p,connected:[.connected[]|{address,inbound,height,version}],known:(.known|length)}'   # full detail only works on the node itself

# how the process has been ending
systemctl show obsidian-node@mainnet -p Result -p ExecMainStatus -p ExecMainCode -p NRestarts -p ActiveEnterTimestamp -p MainPID
systemctl cat obsidian-node@mainnet                      # unit text; shows EnvironmentFile= paths, not values
journalctl -u obsidian-node@mainnet --since "-48h" --no-pager | grep -E "fatal|unhandled|Started|Stopped|Main process exited|ECONN|EADDRINUSE|ERR_" | tail -80
journalctl -u obsidian-node@mainnet --no-pager -n 200

# was it killed from outside? (needs root)
sudo journalctl -k --since "-7d" --no-pager | grep -i -E "out of memory|oom-kill|killed process" | tail
free -m; df -h /var/lib/obsidian; df -i /var/lib/obsidian
cat /proc/$(systemctl show -p MainPID --value obsidian-node@mainnet)/limits | grep -i "open files"

# configuration, names only
sudo sed -E 's/=.*/=<set>/' /etc/obsidian/mainnet/node.env | sort

# reachability
ss -ltnp | grep -E ':(8630|8631)\b'
sudo ufw status verbose 2>/dev/null; sudo iptables -S 2>/dev/null | grep -E "8631|DROP|REJECT" | head
timedatectl | grep -E "System clock|NTP"
sudo stat -c '%a %U %s bytes, modified %y' /var/lib/obsidian/mainnet/node/peers.json
```

From an outside machine, to test the P2P port without speaking the protocol: `nc -vz <node-address> 8631`.

### 2.3 What the code showed (and how far each finding goes)

| # | Finding | Evidence | Could it make a node *stop*? |
| --- | --- | --- | --- |
| D1 | Two nodes that dial each other at the same moment each keep their older link and close the newer one, often **different** ones, so both end with none. | **REPRODUCED**: 6 rounds out of 6 on loopback, 0 connections on both sides after 2.5 s; later, **TESTED** (fails with the old rule, passes with the new) | No. Peers drop and are redialled every 15 s. |
| D2 | A node whose only seed is A never learned B or C: the dialing side never asked for addresses and nothing asked again. | **REPRODUCED**: star topology, 35 s, B knew only A | No. With one seed down, the node is isolated. |
| D3 | An unreachable address was retried on 15 s doubling to **1 h**, no jitter; a link that closed before the handshake was not counted, so a refusing peer was redialled every sweep. | **SOURCE** | No. A peer that is back after an hour waits up to an hour. |
| D4 | The chain-sync routine is started as an un-awaited promise with a `finally` and **no `catch`**. An exception inside it is an *unhandled promise rejection*, which ends a Node.js process (default since Node 15). The production, agent, mempool and status timers had no guard either. | **SOURCE** for the missing `catch`; the Node.js behaviour is documented, **not** triggered here with a real fault. After the change, a throw is logged and swallowed (**TESTED**: no `unhandledRejection` fires). | **Possibly.** It is the only place found where a *networking* problem can end the process. No trigger was found and none is claimed. |
| D5 | There was no `unhandledRejection` / `uncaughtException` handler: the process died with Node's default exit status 1, the same status as a bad config, and nothing named the cause. | **SOURCE** | Makes the *next* stop diagnosable; fixes nothing by itself. |

D1 and D2 are real defects with real tests. D4 is a plausible path to "the process exits" and the only one found; it is not shown to be
what happened in production. The honest summary is: **the code cannot, by itself, explain two of three nodes stopping**, and the commands
in 2.2 are what will.

---

## 3. Fix summary

Smallest change that addresses D1–D5, plus the privacy work. No consensus, genesis, parameter, key, validator or wire change.

**Changed source (core):** `src/networking/p2p.ts`, `src/networking/peer-store.ts`, `src/node.ts`, `src/index.ts`, `src/rpc/server.ts`;
new `src/crash-report.ts`. **Interface:** `server/index.ts`, `web/src/lib/{client,node-banner}.ts`, `web/src/pages/{app,developer,explorer,landing,node}.ts`.
**Other surfaces:** `obsidian-app-web/public/explorer.mjs`, `obsidian-extension/src/{config,ext-screens}.mjs`, `obsidian-wallet-web/public/lib/chain.mjs`,
`cloudflare/{src/worker.js,terraform/main.tf,README.md,cloudflare-config.md}`. **Rebuilt tracked outputs:** the root site shells
(`landing/`, `app/`, …, `obsidian-interface/public/index.html`). **Docs:** `docs/{api,operations,node-operator,self-hosting,explorer,LAUNCH-GUIDE,DEPLOYMENT-GUIDE}.md`, `CHANGELOG.md`.

| Change | Where |
| --- | --- |
| Duplicate-connection tie-break: both ends keep the link opened by the lower node id; a link with no pong for 2 ping intervals loses to a fresh one. The deliberate close is not counted as a failure. | `p2p.ts` `incomingWins`, `dropLink` |
| `getaddr` after every handshake and every 60 s (existing message types, nothing new on the wire). | `p2p.ts` `requestAddresses`, `maintainPeers` |
| Unreachable-peer retry: 15 s doubling to a **5 min** cap, ±20 % jitter; a link that closes before the handshake counts as a failed attempt. Misbehaviour keeps its **1 h** ban. | `peer-store.ts` |
| Never dial an own address (seeded from the advertise address, learned on a refused self-dial); count in-flight dials when filling the peer set; skip them when sweeping. | `p2p.ts` |
| `syncFrom` can no longer reject; all timers and the seed dials at boot are guarded and log the failure (with the task name) instead of ending the process. | `p2p.ts`, `node.ts` |
| One structured `fatal` line and **exit 70** on an unhandled error. The node still stops: after an unplanned error the in-memory state cannot be trusted. | `crash-report.ts`, `index.ts` |
| Peer routes follow the operator-only rule (section 1). | `rpc/server.ts`, interface |

New, test-only options on `P2PService`: `maintainIntervalMs`, `addrRefreshMs` (defaults 15 s and 60 s, i.e. unchanged behaviour).

**Config changes required: none.** No new environment variable, no changed default that an operator must act on. The one operator-visible
behaviour change: a script that read `/nodes` or `getpeers` from a *non-local* address now gets an empty answer; run it on the node, or set
`OBSIDIAN_RPC_PUBLIC_PEER_DETAIL=true` knowingly.

**Not done:** no restart or watchdog was added (a node that dies from an unhandled error still dies; `Restart=always` in the shipped unit
already restarts it, which is also why a crash loop can look quiet). No version bump; see section 7.

---

## 4. Automatic discovery report

**How a node now finds and keeps peers** (all existing protocol; a peer is trusted only by the signed handshake, never for appearing in an answer):

1. Load identity and configured seeds (`OBSIDIAN_SEED_NODES`, `--seeds`) and the saved `peers.json` hints; dial seeds first.
2. Authenticate every link by the signed challenge–response; refuse another network id, chain id, protocol version, params hash or genesis
   id, a core below the minimum, an invalid identity, a self-connection.
3. Ask every connected peer for addresses right after the handshake and every 60 s; add them as *hints* (loopback, link-local and
   unspecified addresses refused on public networks; the book is bounded by `maxPeers`); dial them like any other candidate.
4. Keep a bounded set: dial target `max(2, min(maxOutbound, 8))`, in-flight dials counted, one link per node id, inbound per IP limited.
5. Detect stalled peers: ping every 20 s, drop after 4 silent intervals.
6. Back off an unreachable address 15 s → 5 min with ±20 % jitter; a peer that answers resets it. Misbehaviour still earns the 1 h ban.
7. Persist hints, so a restarted node resumes from its saved peers.

There is no central directory and no new trust: static bootstrap (`seedNodes`) is unchanged.

**Scenario results** (`obsidian-core/tests/integration/p2p-discovery.test.ts`, real loopback sockets, real handshakes and real chains; peer-store clock and the sweep interval are
the only things shortened). **TESTED** unless marked.

| Scenario asked for | Result |
| --- | --- |
| All three start and discover each other (B and C know only A) | pass; each node ends with exactly two links |
| Node 2 started before node 1 | pass; B does not retry inside its backoff window, then joins with no operator action |
| Node 3 started while node 1 is down | pass; C joins through B, then A returns and all three are fully connected |
| Unexpected stop, restart after an outage | pass; the node resumes at its own height (not genesis), is redialled, catches up, and head hashes agree |
| Initial refusal then success | pass (as above) |
| Bootstrap unreachable, a known peer reachable | pass |
| Lost connection, rediscovered | pass; every socket cut without a close frame, nodes reconnect |
| Simultaneous dial (D1) | pass, 4 rounds, connection never drops to zero in 1.2 s of 25 ms samples; fails with the old tie-break |
| DNS failure for one bootstrap name | pass; failure recorded, no crash, the other seed still works. **Recovery of a name that starts resolving later was NOT tested separately**: it is the same retry path as a refusal. |
| Retry delay grows, is capped at 5 min, is not attempted on every sweep | pass (12 consecutive failures) |
| Own advertised address handed over by a peer | pass; never dialled. The *learned-on-refusal* self-dial path is **SOURCE only**. |
| Bounded peer set, no storm (7 nodes, one seed) | pass; no node has two links to one node id, outbound ≤ 8, address book ≤ limit |
| Another network's node handed over as an address | pass; refused, no link on either side |
| Incompatible network id or protocol version; malformed messages; handshake replay; flooding | already covered by `tests/integration/p2p.test.ts` (unchanged, passes) |
| A sync that throws | pass; swallowed and logged, no unhandled rejection, link stays up |
| The three-node *process* cluster (real `node dist/index.js` processes, seeds chained A←B←C) | `tests/e2e/cluster.test.mjs`: 15 of 15 |

**Mixed versions: measured, not assumed.** The patched build and the shipped 2.0.2 build were run against each other in one process
(the 2.0.2 source from the previous commit checked out beside the new one; a throwaway test, not committed, since it needs an old tree):
old/new and new/old connect, authenticate, gossip blocks both ways and sync; an old hub with one old and one new follower reaches the same head on all three.
**One thing is not fixed for mixed pairs:** when an old and a new node dial each other in the *same millisecond*, the old node's "keep the oldest" and the new
node's "keep the lower id" disagree about half the time, and both drop (8 of 10 artificial rounds). It is the old defect, only between those two builds; the
next sweep retries (not measured), and the new node does not penalise the old one for it. Once every node is patched it is gone.

---

## 5. Test report

All commands were run in this sandbox on the working branch; counts are what the runners printed. Run one suite at a time.

| Suite | Command | Result |
| --- | --- | --- |
| New discovery tests | `cd obsidian-core && npx vitest run tests/integration/p2p-discovery.test.ts` | 13 passed, on each of 3 consecutive runs |
| Core, all | `cd obsidian-core && OBSIDIAN_KEYSTORE_PASSPHRASE=… npx vitest run` | 1004 passed, 0 failed (62 files), 278 s. An earlier full run had 1003 passed and 1 failed: the flaky `node-agent` test below. |
| Interface, all | `cd obsidian-interface && npx vitest run` | 661 passed, 0 failed (25 files) |
| App web | `cd obsidian-app-web && npm run build:web && npm test` | 411 passed, 0 failed |
| Extension | `cd obsidian-extension && node scripts/build.mjs && npm test` | 51 passed |
| Wallet web | `cd obsidian-wallet-web && node scripts/build.mjs && npm test` | 49 passed |
| Cloudflare worker | `node --test cloudflare/test/*.mjs` | 17 passed |
| Cluster, 3 real processes | `node --test tests/e2e/cluster.test.mjs` | 15 passed |
| Repo checks | `node --test tests/scripts/repo-consistency.test.mjs`, `…/web-separation.test.mjs`, `…/public-peer-surfaces.test.mjs` | 31, 11, 5 passed |
| Typecheck | core `npx tsc -p tsconfig.json --noEmit` clean; interface `npm run typecheck` | clean (interface); see note |
| Interface build | `cd obsidian-interface && npm run build` | succeeded |

Notes the numbers do not show:
- **`tests/unit/node-agent.test.ts`, one test ("says a heartbeat for a window it has not yet proven…"), is flaky on the unmodified base commit**: run three times on a clean checkout of `152e744` it passed once and failed twice with "block timestamp … is more than 10s ahead of this node's clock". It does not touch anything changed here. Not fixed.
- `npx tsc -p tsconfig.test.json` in core reports 4 errors, all in files this work did not touch (`marketplace-property`, `attack-r2-economy-chaos`, `gate-authority` tests). None in the new or changed tests.
- Existing tests were edited where behaviour was changed on purpose: `peer-retry.test.ts` (jitter pinned to its midpoint so the nominal delays are asserted), and the interface and app-web tests that read the node list or the node header.
- Mutation checks: the simultaneous-dial test fails when the old tie-break is put back; the source guard fails when `client.peers()` is put back. The "found by nodes that were already connected" test passes with *or without* the 60 s refresh, because the new node asks for addresses itself when it meets A; it asserts the outcome, not which path produced it.
- **Not run:** desktop tests; browser (headless) checks of the changed pages; anything against a live network; a soak.

---

## 6. Mainnet safety report

| Check | Result |
| --- | --- |
| params hash | `12211595855ba405b3d70f6161ef9371` before and after (computed from the built code) |
| genesis id, mainnet / testnet / staging / devnet | `470a92366594851f6d22522fbc1232e8605cf9cc` / `de626fc559b2fabeb44326fddb97a408bccaa7a5` / `7b6f3aee772da735a00ad37735232d97cc652e6f` / `1eec1cf5cc764459407d7b2a8c4c3be3b23dfa24`, identical before and after |
| chain id, network id, address prefix | 7777 / `obsidian-mainnet-1` / `obs` (and the other three), unchanged |
| core / protocol version | 2.0.2 / 2.0.2, unchanged; wire protocol 1; snapshot 7 |
| Consensus, fees, supply, issuance, finality, validator or producer set | no file touched (`git diff --stat` lists only networking, the node's timers, the RPC server and the crash handler) |
| Signature, peer-authentication and compatibility checks | not weakened; the handshake code path is unchanged apart from the duplicate rule and the self-address refusal |
| Keys, keystore, passphrases | not read, printed or changed; the crash line carries message, stack head, uptime and memory only (**TESTED**: no key or env text) |
| Database, data directory, `peers.json` | no format change (the peer record is unchanged; `forget()` only removes an address from memory); **no DB was opened, migrated or deleted** |
| Production | **untouched**: no deploy, restart, config change or tag |

Not verified live (cannot be, from here): the deployed height, finalized block, validator/producer set, data-directory identity and key
references of any node. The operator's "before" capture is in section 2.2; the same capture after each node's upgrade is the "after".

---

## 7. Deployment instructions (for approval; nothing here has been done)

**Release preparation is not finished, on purpose.** This is a patch on the working branch. It carries no version bump: a build from it reports
`2.0.2`, the same as the running nodes, which makes "which node has the patch?" unanswerable from `/health`. Two ways to proceed, operator's choice:
(a) deploy by **commit id** and record it per node; or (b) approve a **core-version-only `2.0.3`** (the tag `v2.0.2` is never moved). Source shows a peer
on a *newer* core than its own is only logged, `MIN_CORE_VERSION` stays 2.0.2 and `PROTOCOL_VERSION` stays 2.0.2, so 2.0.2 and 2.0.3 nodes interoperate
(**measured** above for patched/unpatched, not for a bumped number). A bump means a repository-wide consistency sweep and a signed-off release; it has not been started.

**Prerequisites.** Section 2.2 captured from all three nodes and kept. The cause of the stops understood well enough to say whether this patch is the
right answer; if the captures show something else (memory, disk, a version mix, a passphrase), fix *that* first.

**Rollout, one node at a time, never two, never all.** Start with the node that is currently failing least (a follower, never the only healthy producer).
For each node:

1. **Prepare the backup** (nothing is stopped or copied yet): note the unit file, the env file name and the keystore *path* (not its content). A copy of a live database may be inconsistent, so the data directory is copied only after a clean stop (step 4), e.g. `sudo rsync -a /var/lib/obsidian/mainnet/node/ /var/backups/obsidian-mainnet-node-$(date +%F)/`; check that the target has the space first (`du -sh`, `df -h`).
2. Build the release on a separate path, not over the running one: `git clone … /opt/obsidian/obsidian-core-patch && cd … && npm ci && npx tsc -p .`. Run `node dist/index.js version` and confirm `paramsHash` is `12211595855ba405b3d70f6161ef9371`.
3. Confirm the other two nodes are healthy and **finality has quorum without this node** (`/finality`: `available: true`). If not, **stop here**.
4. `sudo systemctl stop obsidian-node@mainnet` (a clean stop; `TimeoutStopSec=30`). Take the file copy prepared in step 1 now.
5. Point the unit's `WorkingDirectory` at the new build (a drop-in, `systemctl edit`), `daemon-reload`, `systemctl start`.
6. Wait for: `/health` identical to the captured identity, `height` rising to the others', `syncing: false`, `/peers` showing the other two, `/finality` `available: true`. Watch `journalctl -u obsidian-node@mainnet -f` for `fatal` or `background task failed`.
7. Hold for at least one finality interval before the next node. **Stop and roll back on any mismatch.**

**What would be a failed step:** a different genesis id or params hash; a height that does not advance; `peers: 0` after 2 minutes with seeds configured; finality unavailable; an exit status 70 line.

---

## 8. Rollback plan

Rollback is **to the previous build, with the data directory untouched**: stop the node, point `WorkingDirectory` back at the old build (remove the drop-in), `daemon-reload`, start.

Whether that is safe for the *database*: **SOURCE-based only.** The patch does not touch chain storage, the snapshot format (7) or the peer record format, and the
node does not write anything new to disk, so a 2.0.2 build should open the data directory the patched build used. That must be confirmed on the real node before relying
on it: the captured `peers.json` and the step-4 copy are the evidence; **never delete, reset or re-initialise the data directory as part of a rollback.** If the old build will not start on the data
as it is, restore the clean-stop copy from step 4 to a **new** directory and start from that, leaving the original aside.

---

## 9. Remaining risks

- **The production cause is unknown.** If it is memory, disk, a version mix or configuration, this patch will not change it.
- D4 (the unhandled rejection) is a plausible path to a process exit that was never triggered with a real fault.
- Mixed old/new pairs still lose a same-millisecond double dial (section 4) until every node is patched.
- A patched node still **exits** on an error nobody planned for (exit 70). That is deliberate; `Restart=always` brings it back in 5 s. A recurring `fatal` line is now a bug report, not noise.
- Desktop peer tables remain (operator-local). Peer *counts* and the configured/healthy node counts remain in `/status` and `/api/health`.
- The on-chain node-runner registry can carry an endpoint hint that the chain cannot hide.
- The two-sided `getaddr` traffic is more than before (one request per peer per 60 s, answered with up to 32 addresses); a `getaddr` is answered like any other message, under the existing per-link message throttle (there is no separate limit for it), and the traffic was **measured only on loopback**.
- Nothing was verified on a live network, in a headless browser, or on the desktop app.
- Pre-existing: a flaky `node-agent` test and four test-only type errors (section 5); the earlier open item R36.

---

## 10. Operator checklist

Before:
- [ ] Section 2.2 captured on all three nodes, saved off the servers, no secret in it.
- [ ] All three on the same `genesisId`, `paramsHash`, `protocolVersion`; versions noted.
- [ ] You know whether the failing nodes **exit** or **lose peers**, and the exit status.
- [ ] `OBSIDIAN_SEED_NODES` is set on every node, naming the *other* nodes' P2P addresses; each node's advertised address is reachable from the others (`nc -vz`).
- [ ] Disk, inodes, memory, open-files limit, clock (NTP) checked.
- [ ] `/finality` has quorum without the node you are about to touch.
- [ ] Backup of the data directory taken **after a clean stop**; unit and env files copied.
- [ ] Rollback understood; data directory is never reset.

Per node:
- [ ] New build in a separate path; `version` shows the unchanged params hash.
- [ ] Stop, copy, switch, start; identity unchanged; height rising; `/peers` shows the others; finality available.
- [ ] A wait of at least one finality interval; journal clean of `fatal`.

After:
- [ ] Capture 2.2 again and compare field for field.
- [ ] Public pages show no node list (`curl -s https://<site>/api/nodes` has four fields; `/api/rpc?path=/peers` is refused).
- [ ] Purge the CDN once, so a cached `/api/nodes` or `x-obsidian-node` from before is gone.
- [ ] Watch for `fatal` lines for a week; each one is worth a report.
