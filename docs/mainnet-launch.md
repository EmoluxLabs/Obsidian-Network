# Mainnet launch runbook

This is the operational sequence for bringing Obsidian Network mainnet up. It is
written to be followed literally, in order, by the people running the first
nodes. Every step has a command and an observable result; if a result does not
match, stop and resolve it before continuing — a chain is much easier to fix
before it has users than after.

**Mainnet facts this document depends on**

| | |
|---|---|
| Network id | `obsidian-mainnet-1` |
| Chain id | `7777` |
| Genesis id | `4c2c37aa2ea29512cee4833151697237c1372ff3` |
| Genesis hash | `42735b1aabd4dd9252cd5e37a9e058dcfea71bbcff758b679c3b93cde51acb31` |
| Protocol version | `1.2.0` |
| Params hash | published at `/params`; must be identical on every node |
| Default RPC port | 8630 |
| Default p2p port | 8631 |
| Address prefix | `obs1` |
| Max supply | 21,000,000 OBS |
| Supply at height 0 | **0 OBS** |

Confirm the genesis identity yourself before trusting this table:

```bash
node dist/index.js genesis init --network mainnet
```

Two independent machines must print the same `genesisId` and `hash`. They are
derived deterministically from the genesis document and the consensus
parameters; if they differ, the two machines are not running the same protocol
and must not be peered.

---

## 0. What launch does and does not involve

Obsidian mainnet does **not** have a token sale, a premine, a foundation
allocation or an administrator. At height 0 the total supply is zero. There is
nothing to distribute and nobody to distribute it.

The only issuance events that will ever exist are:

1. **The genesis allocation** — 100,000 OBS, awarded exactly once, to the wallet
   behind the *first protocol-valid mining claim* accepted into a block. It is
   not awarded at registration and cannot be assigned by anyone. That wallet
   simultaneously becomes the on-chain treasury.
2. **Mining claims** — 0.001 OBS/day initially, per the published schedule.

Both are validated against the 21,000,000 cap inside the state transition. There
is no third path: `issue()` accepts only `GENESIS_ALLOCATION` and
`MINING_REWARD`, which the compliance audit re-confirms at runtime.

So "launching mainnet" means: start honest nodes, let them find each other,
publish the seed list, and open the interface. The economy starts itself.

---

## 1. Before launch day

### 1.1 Verify the release you intend to run

Never launch from a working copy. Launch from a signed release archive.

```bash
# from the releases/ directory of the tag you are launching
sha256sum -c SHA256SUMS

# the artifact you will actually run
../scripts/verify-release.sh obsidian-node-operator-1.2.17.tar.gz

# the same code with its test suite attached, which the operator package omits
../scripts/verify-release.sh obsidian-core-1.2.17.tar.gz --with-tests
```

Expected: every archive reports `OK`, and the verifier prints the package
version and protocol version it found. The core archive additionally runs its
254 tests and they must pass. The node operator package ships `dist/` without
tests, so `--with-tests` reports "ships no self-contained test suite; skipping" there — that is
why you verify the core archive too, which does ship its suite.

`verify-release.sh` exits non-zero if a digest does not match or the archive is
not listed in `SHA256SUMS`, so it is safe to use as a gate in a deployment
script. Confirm that for yourself once — append a byte to a copy of an archive
and watch it refuse.

**Signatures.** A digest list proves the bytes did not change; it does not prove
who produced them, because anyone who can edit the archive can edit
`SHA256SUMS` beside it. The signed path is:

```bash
../scripts/verify-release.sh obsidian-node-operator-1.2.17.tar.gz --signature-only
```

That checks the detached signature against the publisher key in
`keys/release-key.pub` and stops there. **The 1.2.17 archives in this repository
are unsigned**: no publisher key exists in the workspace that built them, so the
command above reports that there is no signature to check rather than a success.
Do not announce a launch on unsigned archives — generate the publisher key
(`scripts/sign-release.sh --keygen` on an offline machine you control), sign the
archives, publish `keys/release-key.pub` through a second channel, and have
every operator verify the signature before they run the node. `docs/release-verification.md`
documents the whole path, including what a `gpgv`-only host can and cannot do.

### 1.2 Decide the bootstrap set

You need **at least three** independently operated, independently hosted nodes
before you announce the network. Three is the minimum at which the loss of one
operator does not stop block production or leave a single party defining the
chain. More is better; different hosting providers and different jurisdictions
are better still.

For each bootstrap node record: operator, hostname, region, provider, RPC URL
(if public), and p2p `host:port`.

### 1.3 Provision each node

Requirements, per `docs/node-operator.md`: Linux x86-64 or arm64, Node.js ≥
20.10, 2 vCPU, 4 GB RAM, 50 GB SSD (growing), and a stable clock.

The clock matters more than usual here. Proof of Time accepts a block only if
its timestamp is greater than the median of the last 11 blocks, greater than its
parent, and no more than 60 seconds ahead of the receiving node's local clock.
A node whose clock is badly wrong will reject honest blocks. Install NTP and
confirm it is disciplined:

```bash
timedatectl set-ntp true
timedatectl status     # expect: System clock synchronized: yes
```

### 1.4 Create each node identity

```bash
export OBSIDIAN_KEYSTORE_PASSPHRASE='<long random passphrase, from a manager>'
node dist/index.js keygen --network mainnet --data-dir /var/lib/obsidian/mainnet
```

Record the printed `nodeId`. Back up `node-key.json` and store the passphrase
separately from it.

If `OBSIDIAN_KEYSTORE_PASSPHRASE` is not set the node generates one and writes it
to a companion file beside the keystore, and warns you. That is acceptable for a
laptop and **not** acceptable for mainnet: set the variable and delete the
companion file.

> The node identity keystore is the only private key a node ever holds. It signs
> node metadata, heartbeats and attestations. It is **not** a wallet and holds no
> funds. User private keys never reach a node, a server, a log or a worker.

### 1.5 Configure

Start from `obsidian-core/config/mainnet.json` and set, per host:

* `publicHost` — the address other nodes should dial you on.
* `seedNodes` — the other bootstrap nodes' `host:port` (leave empty on the first
  node until the others exist; fill it in afterwards).
* `miningRewardAddress` — the wallet that receives block-production credit.
  Generate it with `node dist/index.js wallet new`, offline, and keep the private
  key off the server.
* `rpcHost` — keep `127.0.0.1` and put nginx/Cloudflare in front if you intend to
  expose RPC publicly. Do not bind an unauthenticated RPC to `0.0.0.0` without a
  reverse proxy and rate limiting.

Leave `strictDataDir: true`. It is what stops a node from silently adopting a
data directory written by a different network.

---

## 2. Launch sequence

### 2.1 Start the first node

```bash
node dist/index.js start --config config/mainnet.json
```

Expect, in the log:

```
chain ready   network=mainnet chainId=7777 height=0
              genesisId=4c2c37aa2ea29512cee4833151697237c1372ff3
obsidian core ready   maxSupplyObs=21000000000000000000000000
```

Then confirm the state is genuinely empty:

```bash
curl -s localhost:8630/supply
```

Expect `totalSupplyObs: "0.000000000000000000"`, `invariantOk: true`,
`genesisIssuedObs: "0.000000000000000000"`.

### 2.2 Start nodes 2 and 3, pointed at node 1

```bash
node dist/index.js start --config config/mainnet.json --seeds node1.example.org:8631
```

Confirm they converge:

```bash
curl -s localhost:8630/peers | head
curl -s localhost:8630/status     # heights within a block or two of each other
```

Then update every node's `seedNodes` to include the others and restart them, so
the bootstrap set is not a star around node 1.

### 2.3 Confirm consensus is healthy

On each node:

```bash
curl -s localhost:8630/pot
```

Expect `consensus: "PROOF_OF_TIME"`, `difficulty.observedSpacingMs` converging on
5000, and `timeRate.blocksPerMinute` near 12. `warmingUp: true` is normal until
the window fills.

Cross-check that all nodes agree on the protocol itself:

```bash
curl -s localhost:8630/params | grep -o '"paramsHash":"[^"]*"'
```

**Every node must print the same params hash.** A mismatch means one node is
running different consensus rules and will fork. Stop it.

### 2.4 Confirm nothing removed has come back

```bash
curl -s localhost:8630/audit/compliance
```

Every one of these must report `present: false`: `wac`,
`legacyGenesisAllocation`, `signupAllocation`, `miningKyc`,
`miningWithdrawalRequiresWac`, `nativeExchange`, `explorerExposesBalances`,
`browserClockControlsMining`, `serverStoresPrivateKeys`, `adminMintPath`,
`proofOfWorkConsensus`, `blockHeaderNonce`, `selfReportedNodeMetrics`,
`adminRewardOverride`, `gasCountedAsPlatformRevenue`, `nodeIdentityIsIpAddress`.

And run the economic invariants against the build you deployed:

```bash
node scripts/check-invariants.mjs     # expect: all 55 invariants hold
```

### 2.5 Publish the seed list

Only now publish the bootstrap `host:port` list — in the repository, on the
developer site, and in the interface configuration. Publishing it earlier invites
people onto a chain you have not finished validating.

---

## 3. The genesis allocation event

The first accepted mining claim awards 100,000 OBS and designates the treasury.
This happens by itself, in consensus, the moment a real user submits a valid
claim. Nobody triggers it and nobody can direct it.

Watch for it:

```bash
curl -s localhost:8630/genesis
```

Before, the `state` object reads:

```json
"state": { "allocationClaimed": false, "recipient": "", "treasuryWallet": "",
           "amount": "100000000000000000000000" }
```

After the first valid claim, `allocationClaimed` is `true` and `recipient` and
`treasuryWallet` both hold the winning address, with `claimedAtHeight` and
`claimedByTxId` recorded permanently. The flag is one-way: there is no code path
that sets it back to `false`.

Independently verify the event rather than trusting the field:

```bash
curl -s localhost:8630/tx/<claimedByTxId>        # the claim, and its events
curl -s localhost:8630/supply                    # genesisIssuedObs = 100000
```

Confirm on **every** bootstrap node that the recipient is identical. Divergence
here is a consensus failure and must halt the launch.

Until that claim exists there is no treasury, and operations that pay the
treasury (ONS registration, business pages, protocol land sales) are refused
with a clear error rather than silently routed somewhere else. That is intended:
revenue cannot be collected before there is a designated on-chain recipient.

---

## 4. Bring up the interface and the edge

The interface is a reader. It holds no keys, and the network does not depend on
it.

```bash
OBSIDIAN_NODE_URLS=https://rpc1.example.org,https://rpc2.example.org,https://rpc3.example.org \
OBSIDIAN_INTERFACE_HOST=0.0.0.0 OBSIDIAN_INTERFACE_PORT=8788 \
node dist/server/main.js
```

Point it at **several** nodes, not one — it health-checks them and fails over.
Then confirm all twelve sites answer:

```bash
for p in / /mine/ /wallet/ /explorer/ /social/ /capsule/ /ons/ /circle/ /developer/ /node/ /app/ /audit/; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8788$p)"
done
```

Cloudflare, if you use it, is a cache and a gateway. Deploy it from
`cloudflare/`. Then prove the network does not depend on it: stop the worker and
confirm blocks still advance and `/status` still responds directly from a node.
If anything stops, the deployment is wrong.

---

## 5. Post-launch monitoring

Per node, alert on:

* **Height stalled** — `/status` height unchanged for > 60 s.
* **Spacing drift** — `/pot` `observedSpacingMs` outside roughly 3000–8000.
* **Peer collapse** — `/peers` count at or near zero.
* **Params divergence** — `/params` hash differing between nodes. Page someone.
* **Supply invariant** — `/supply` `invariantOk` anything but `true`. This is the
  most serious alert in the system; treat it as a halt condition.
* **Clock drift** — host NTP offset above a second or two.

`docs/node-operator.md` §6 covers the per-node specifics, §7 backup and restore.

**Do not hand-write those checks.** `obsidian-core/deployment/monitoring/`
carries the whole stack: Prometheus scraping the node's `/metrics`, alert rules
for every condition above (plus node runner jail, mempool backlog and reorg
depth), a Grafana dashboard, and an Alertmanager routing tree with two inhibit
rules — a mempool backlog behind a stalled chain, and a syncing node behind a
restart — so a single root cause does not page you five times. Start it with:

```bash
cd obsidian-core/deployment/monitoring
docker compose up -d          # prometheus :9090, alertmanager :9093, grafana :3000
```

Every receiver in `alertmanager.yml` is a `CHANGE-ME` placeholder **on purpose**:
Alertmanager refuses to start until you name a real destination, because a
routing file that quietly delivers to `example.invalid` looks healthy and tells
nobody anything. Point at least one receiver at a channel a human actually
reads, then confirm end to end by triggering it —
`amtool alert add alertname=ObsidianHeightStalled severity=critical` — and
watching the message arrive. `deployment/monitoring/README.md` has the amtool
verification steps.

---

## 6. If the launch goes wrong

**Before the genesis allocation is claimed**, a relaunch is cheap: there is no
issued supply and no user funds. Stop every node, delete the mainnet data
directories, correct the problem, and start again from §2. Announce clearly that
the genesis id has changed, and republish it.

**After the genesis allocation is claimed**, the chain has real economic state
and must not be restarted casually. Fix forward: a consensus change requires a
new release, a published params hash, and coordinated operator upgrades. The
protocol treasury cannot be reassigned by configuration — moving it is a
consensus upgrade, deliberately.

**If nodes fork** (different heads at the same height), compare params hashes
first — divergent parameters are the usual cause. If parameters match, capture
both heads (`/block/<hash>`) from each side before restarting anything; that
evidence is what makes the bug findable.

---

## 7. Launch checklist

```
[ ] Release archives verified: sha256sum -c SHA256SUMS
[ ] verify-release.sh --with-tests passes on the node operator archive
[ ] Publisher signature verified (--signature-only), or the archives are
    deliberately unsigned and every operator has been told so in writing
[ ] Publisher public key published somewhere other than the release page
[ ] node scripts/check-invariants.mjs -> all 55 invariants hold
[ ] >= 3 bootstrap nodes, independent operators, independent hosting
[ ] NTP disciplined on every host (timedatectl: synchronized yes)
[ ] OBSIDIAN_KEYSTORE_PASSPHRASE set; companion .pass files deleted
[ ] Keystores backed up; passphrases stored separately
[ ] genesis init prints the expected genesisId and hash on every host
[ ] All nodes report height 0 and total supply 0 at first start
[ ] All nodes report an identical params hash
[ ] Peers established in both directions; heights converge
[ ] /pot reports PROOF_OF_TIME, spacing near 5000 ms
[ ] /audit/compliance: all 16 removed features absent
[ ] RPC not exposed unauthenticated; proxy and rate limits in place
[ ] Interface configured with multiple node URLs; 12 sites return 200
[ ] Cloudflare removed from the path as a test; consensus unaffected
[ ] Prometheus, Alertmanager and Grafana up from deployment/monitoring
[ ] Every CHANGE-ME receiver replaced; a test alert reached a human
[ ] Monitoring and alerting live before announcement
[ ] Seed node list published
[ ] Genesis allocation event observed and identical across all nodes
```

---

## Related

* `docs/node-operator.md` — running and maintaining a node day to day
* `docs/node-runner-rewards.md` — registering for the 40% revenue share
* `docs/proof-of-time.md` — the consensus rules referenced above
* `docs/release-verification.md` — verifying archives and signatures
* `docs/security-model.md` — the trust boundaries and what breaks them
