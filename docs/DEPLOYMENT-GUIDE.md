# Obsidian Network — the complete beginner's deployment guide

**For branch `arena/01a0e1df-obsidian-network` · protocol 1.1.0 · written for someone with an Android phone and no prior coding experience.**

This guide is built from the actual repository. Every command in it was run
against this code. Where the repository does not support something, it says
**NOT DOCUMENTED IN THE CURRENT REPOSITORY** instead of inventing an answer.

> **Read this first.** The honest recommendation, argued with evidence at the
> very end in *"What I should deploy first"*, is: **do not launch mainnet yet.**
> Start with a local devnet on your phone, then a private testnet, then a public
> testnet. Mainnet is the one decision you cannot undo.

---

## Table of contents

- [Words you need to know](#words-you-need-to-know)
- [Git concepts: branch, tag, archive, deployment](#git-concepts)
- [A. How to prepare the repository](#a-how-to-prepare-the-repository)
- [B. How to move the branch to main](#b-how-to-move-the-branch-to-main)
- [C. Testnet from zero](#c-testnet-from-zero)
- [D. Public testnet](#d-public-testnet)
- [E. Mainnet](#e-mainnet)
- [F. Frontends](#f-frontends)
- [G. Wallet](#g-wallet)
- [H. Mining registration](#h-mining-registration)
- [I. Node operators](#i-node-operators)
- [J. Cloudflare](#j-cloudflare)
- [K. Security checklist](#k-security-checklist)
- [L. Troubleshooting](#l-troubleshooting)
- [M. Android guide](#m-android-guide)
- [N. Windows guide](#n-windows-guide)
- [O. Decision guide](#o-decision-guide)
- [P. Master checklist](#p-master-checklist)
- [What I should deploy first](#what-i-should-deploy-first)

---

## Words you need to know

Each term is explained the first time it matters. Skim this, then come back.

| Word | What it actually means here |
|---|---|
| **Terminal / shell** | A window where you type commands instead of clicking. On Android this is the Termux app. |
| **Command** | A line of text you type and press Enter on. `ls` lists files. |
| **Repository (repo)** | The folder containing all the project's code and its history. |
| **Git** | The program that tracks every change to the repo. |
| **Clone** | Download a copy of the repo to your device. |
| **Branch** | A named line of development. Yours is `arena/01a0e1df-obsidian-network`. |
| **Commit** | One saved change, with a message and a unique id like `b34e581`. |
| **Push / pull** | Send your commits to GitHub / fetch GitHub's commits to you. |
| **Node.js** | The program that runs this project's JavaScript. Version 20.10+ required. |
| **npm** | Node's package installer, comes with Node.js. |
| **Build** | Turn the human-readable source into the files the computer runs (`dist/`). |
| **Node (Obsidian node)** | One running copy of the blockchain software. Confusingly, "Node.js" and "a node" are different things. |
| **Consensus** | The rules all nodes agree on. The only source of truth. |
| **RPC** | "Remote Procedure Call" — the node's HTTP API you read chain data from. |
| **P2P** | "Peer to peer" — how nodes talk to each other. |
| **Port** | A numbered door on a computer. RPC and P2P each use one. |
| **Devnet / testnet / mainnet** | Throwaway network / practice network / the real one with real OBS. |
| **Genesis** | The very first block. Everything descends from it. |
| **PARAMS_HASH** | A fingerprint of the consensus rules. Nodes with different fingerprints will fork. |
| **PoT** | Proof of Time, this chain's consensus. |
| **VPS** | "Virtual Private Server" — a computer you rent in a data centre, always on. |
| **SSH** | The way you log into a VPS from your phone or PC. |
| **Frontend** | A website users see. In this project they are static folders. |
| **Interface** | This project's server that serves the frontends and proxies reads to nodes. |

---

## Git concepts

You asked for the difference between these. It matters, because deploying the
wrong one is how people ship old code.

| Thing | What it is | When you deploy from it |
|---|---|---|
| **Development branch** (`arena/01a0e1df-obsidian-network`) | Where work happens. Changes often. This is where all 404 tests and the 1.1.0 archives currently live. | Local devnet and private testnet only. |
| **`main` branch** | Convention: the branch that reflects "current accepted state". **In this repository `main` is still at the original `459a6c1 Initial commit`** — none of the work has been merged into it yet. | Never deploy `main` today; it is effectively empty. |
| **Release branch** | A branch frozen for a release, e.g. `release/1.1.0`, that only receives fixes. **NOT DOCUMENTED IN THE CURRENT REPOSITORY** — no release branch exists and no document describes one. | Optional; see §B. |
| **Git tag** | A permanent, immovable label on one exact commit, e.g. `v1.1.0`. Unlike a branch it never moves. **No tags currently exist in this repository.** | Tag first, then build the archive from the tag. |
| **Release archive** | The `.zip`/`.tar.gz` files in `releases/`, built by `scripts/package-releases.sh`, each listed in `SHA256SUMS`. This is what `docs/mainnet-launch.md` says to launch from. | **Mainnet. Always.** |
| **Deployed node** | A running `obsidian-core` process with a data directory. It is not code, it is a live thing holding chain state. | — |
| **Frontend deployment** | The static site folders (`landing/`, `mine/`, …) served by the interface, a static host, or Cloudflare Pages. | — |

**The rule from `docs/mainnet-launch.md` §1.1, quoted:** "Never launch from a
working copy. Launch from a signed release archive."

---

## A. How to prepare the repository

Do this before every deployment, in this order. Each command is explained
before you run it.

### A1. Where am I?

```bash
cd ~/Obsidian-Network
pwd
```

`cd` means "change directory" — move into the project folder. `pwd` means
"print working directory" — it shows where you are, so you can confirm you are
in the right place. Expect something ending in `/Obsidian-Network`.

### A2. Check Git status

```bash
git status
```

This lists files you have changed but not saved to Git. **You want to see
`nothing to commit, working tree clean`.** If it lists files, you have
uncommitted work — deal with it before deploying, because the packaging script
refuses to build from a dirty tree.

### A3. Check the current branch

```bash
git branch --show-current
```

Expect exactly:

```
arena/01a0e1df-obsidian-network
```

If it says anything else, switch:

```bash
git checkout arena/01a0e1df-obsidian-network
```

### A4. Pull the latest code

```bash
git pull origin arena/01a0e1df-obsidian-network
```

`pull` downloads commits from GitHub (`origin`) and applies them to your copy.

Confirm which commit you are on:

```bash
git log --oneline -1
```

Write this id down. It is the exact code you are about to deploy.

### A5. Install dependencies

Dependencies are third-party code the project needs. `npm ci` installs the
exact versions recorded in `package-lock.json` — "ci" means "clean install",
and unlike `npm install` it never silently upgrades anything.

```bash
cd obsidian-core && npm ci && cd ..
cd obsidian-interface && npm ci && cd ..
```

### A6. Build

Building converts TypeScript source into runnable JavaScript in `dist/`.

```bash
npm --prefix obsidian-core run build
npm --prefix obsidian-interface run build
```

`--prefix X` means "run this command as if you were inside folder X".

The interface build prints `wrote 12 site shells`. **Build the core first** —
the interface build compiles the core and copies a browser-safe subset out of
it, so it fails on a clean checkout if the core has not been built.

### A7. Run the project's actual tests

Four separate suites, **404 tests total**:

```bash
npm --prefix obsidian-core test          # 233 tests
npm --prefix obsidian-interface test     # 151 tests
node --test cloudflare/test/worker.test.mjs   # 7 tests
node --test tests/e2e/cluster.test.mjs        # 13 tests, starts 3 real nodes
```

The last one binds ports 39630–39635 and takes about a minute. **Do not run two
copies of it at once** — they fight over the ports and fail for no real reason.

### A8. Run the invariant check

This asserts 50 economic and protocol constants — the 21,000,000 cap, the
mining schedule, the 40/60 split, and the absence of removed features.

```bash
node scripts/check-invariants.mjs
```

Expect exactly:

```
protocol 1.1.0: all 50 invariants hold.
```

Any other output means a consensus constant has changed. Stop.

### A9. Verify protocol 1.1.0 and PARAMS_HASH

Start a throwaway devnet node, ask it what it is, then stop it.

```bash
cd obsidian-core
node dist/index.js start --network devnet --data-dir /tmp/checknode \
  --rpc-port 38630 --p2p-port 38631 --offline --no-mine
```

Leave that running. In a **second terminal** (in Termux: swipe from the left
edge → **New session**):

```bash
curl -s localhost:38630/status
```

`curl` fetches a web address and prints the result. Expect to see:

- `"protocolVersion":"1.1.0"`
- `"paramsHash":"5ed3d6409bd4e723f83f00469e976062"`

Stop the node with **Ctrl+C** in the first terminal.

**Every node you run must report the same `paramsHash`.** Different hash =
different rules = guaranteed fork.

### A10. Verify genesis configuration

```bash
cd obsidian-core
node dist/index.js genesis init --network mainnet
```

This prints a JSON document. Deterministically, every time, it contains:

```json
"genesisId": "20a787220fa49a2d8a41276b370705a16add75ba",
"genesisHash": "43d0b6d29a99a84955ebd1797231c4d0b887c684c342d7ce4360a5668ade0ebc"
```

To see just those two lines:

```bash
node dist/index.js genesis init --network mainnet | grep -i genesis
```

Run it twice and compare. Identical output is the point.

### A11. Verify release artifacts and checksums

A checksum is a fingerprint of a file. If one byte changes, the fingerprint
changes completely.

```bash
cd releases
sha256sum -c SHA256SUMS
```

Expect 11 lines, each ending `OK`.

Then verify an archive properly:

```bash
../scripts/verify-release.sh obsidian-core-1.1.0.tar.gz --with-tests
```

This checks the digest, extracts to a temporary folder (never over your work),
checks entry points, and runs the shipped tests. It **exits non-zero** if the
digest mismatches or the archive is not listed, so it is safe to use as a gate.

### A12. Signatures

**NOT DOCUMENTED IN THE CURRENT REPOSITORY.** The release process produces
SHA-256 checksums and a `MANIFEST.json`, and `docs/release-verification.md`
describes verifying them — but there is **no GPG/PGP signing key, no `.asc` or
`.sig` files, and no signing step in `scripts/package-releases.sh`**. The word
"signed release" appears in the documentation as an intention.

**What is needed before proceeding:** a decision on who holds the release
signing key, where its public half is published, and whether signing happens
locally or in CI. Until then, checksums prove *integrity* (the file was not
corrupted) but not *authenticity* (that you produced it). For a public mainnet
this gap should be closed.

---

## B. How to move the branch to main

### B0. Should you?

**Not yet.** Merging to `main` does not deploy anything in this repository —
there is no deployment automation watching `main`. Its only effect is to make
`main` the accepted state. Do it when you have finished testing, not before.

**When you should NOT merge and should deploy from the archive instead:**

- Deploying **mainnet**. `docs/mainnet-launch.md` §1.1 is explicit: launch from
  a verified release archive, not a working copy or a branch.
- Any time you cannot state exactly which commit is running in production.

### B1. Back up the branch first

A backup branch is a second name pointing at the same commit, so you can always
come back.

```bash
git checkout arena/01a0e1df-obsidian-network
git pull origin arena/01a0e1df-obsidian-network
git branch backup/pre-main-$(date +%Y%m%d)
git push origin backup/pre-main-$(date +%Y%m%d)
```

> Your working session is tied to `arena/01a0e1df-obsidian-network`. Creating a
> backup branch is a safety net; keep doing your actual work on the session
> branch.

### B2. Create a safety tag

A tag is permanent and never moves — better than a branch for "this exact code".

```bash
git tag -a safety/pre-main-$(date +%Y%m%d) -m "State before merging to main"
git push origin safety/pre-main-$(date +%Y%m%d)
```

`-a` makes an annotated tag (with author and message), `-m` supplies the
message.

### B3. Merge into main

```bash
git checkout main
git pull origin main
git merge arena/01a0e1df-obsidian-network
```

**Expect conflicts.** `main` is at `459a6c1 Initial commit` and contains a
different `README.md`; your branch has rewritten it and added everything else.

### B4. If conflicts occur

Git will list conflicted files and `git status` shows them under "Unmerged
paths". For this repository, your branch's version is the correct one in
essentially every case:

```bash
# take your branch's version of every conflicted file
git checkout --theirs .
git add -A
git commit
```

`--theirs` means "the branch being merged in" — your work.

If you would rather not reason about conflicts at all, replace `main` wholesale
with your branch's tree:

```bash
git checkout main
git reset --hard arena/01a0e1df-obsidian-network
git push --force-with-lease origin main
```

`--force-with-lease` refuses to overwrite if someone else pushed in the
meantime — always prefer it to plain `--force`. **Only do this while you are
the sole person working on the repository.**

### B5. Verify main contains exactly the intended code

Compare the file trees. If the two hashes match, the contents are byte-identical:

```bash
git rev-parse main^{tree}
git rev-parse arena/01a0e1df-obsidian-network^{tree}
```

And confirm nothing differs:

```bash
git diff main arena/01a0e1df-obsidian-network --stat
```

Empty output = identical.

### B6. Create the release tag

```bash
git checkout main
git tag -a v1.1.0 -m "Obsidian Network 1.1.0 — protocol 1.1.0, PoT, node runner rewards"
git push origin v1.1.0
```

Then **rebuild the archives from the tag**, so the archives and the tag agree:

```bash
git checkout v1.1.0
./scripts/package-releases.sh
cd releases && sha256sum -c SHA256SUMS
```

### B7. How to avoid deploying an old commit

Three habits:

1. **Record the commit id** before you deploy (`git log --oneline -1`) and check
   it against what is running.
2. **Deploy from a tag or an archive, never from "latest"**, because "latest"
   changes under you.
3. **Ask the running node what it is** rather than trusting your memory:
   ```bash
   curl -s localhost:8630/version
   ```

---

## C. Testnet from zero

This section runs **three nodes on one machine** (your phone or PC). It uses
the `devnet` network, which is the throwaway network with 5-second blocks.

> Why devnet and not testnet? Both work. `devnet` is designed for exactly this
> and its default ports (38630/38631) are unlikely to clash. Substitute
> `--network testnet` (ports 18630/18631) if you prefer.

### C1. What to install

- Node.js 20.10 or newer (22 LTS recommended) — from `docs/node-operator.md` §1
- Git
- `curl`

Android: see [§M](#m-android-guide). Windows: see [§N](#n-windows-guide).

### C2. Get the code and build

```bash
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
git checkout arena/01a0e1df-obsidian-network
npm --prefix obsidian-core ci
npm --prefix obsidian-core run build
```

### C3. Start node 1

```bash
cd obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-long-passphrase-here'
node dist/index.js start --network devnet \
  --data-dir /tmp/obs/n1 --rpc-port 38630 --p2p-port 38631 --mine
```

`export` sets an environment variable for this terminal session. The keystore
passphrase protects the node's identity key. If you do not set it, the node
generates one, writes it beside the keystore and warns you — fine for a test,
not for mainnet.

**Expected output** (the important lines):

```
chain ready  network=devnet chainId=7780 height=0 genesisId=30ebaab3771c75cd3f66828bd7329a08fc92639b
p2p listening  host=0.0.0.0 port=38631
rpc listening  host=0.0.0.0 port=38630
obsidian core ready  maxSupplyObs=21000000000000000000000000
```

### C4. Check it is running

New terminal:

```bash
curl -s localhost:38630/health
curl -s localhost:38630/status
```

After ~15 seconds run `/status` again — `height` must have increased. Blocks
come every 5 seconds.

### C5. Node 2 and node 3, and how they find each other

Nodes discover peers two ways: **seed nodes** you give them at startup, and
**peer exchange**, where a connected peer tells them about others.

The `--seeds` flag takes `host:port` of a node's **P2P** port (not RPC),
comma-separated.

Terminal 2:

```bash
cd ~/Obsidian-Network/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-long-passphrase-here'
node dist/index.js start --network devnet \
  --data-dir /tmp/obs/n2 --rpc-port 38640 --p2p-port 38641 \
  --seeds 127.0.0.1:38631 --mine
```

Terminal 3:

```bash
cd ~/Obsidian-Network/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-long-passphrase-here'
node dist/index.js start --network devnet \
  --data-dir /tmp/obs/n3 --rpc-port 38650 --p2p-port 38651 \
  --seeds 127.0.0.1:38631,127.0.0.1:38641 --mine
```

Each node needs **its own data directory**. Sharing one corrupts state.

### C6. Verify peer connectivity

```bash
curl -s localhost:38630/peers
curl -s localhost:38640/peers
curl -s localhost:38650/peers
```

Each should list the others.

### C7. Verify heights converge

```bash
for p in 38630 38640 38650; do
  echo -n "$p: "; curl -s localhost:$p/status | grep -o '"height":[0-9]*' | head -1
done
```

Heights should be within a block or two. They will never be exactly equal at
all times — blocks propagate.

### C8. Verify state root, PoT weight, PARAMS_HASH, protocol version

The **state root** is a fingerprint of the entire world state. Two honest nodes
at the same height must have the same one.

```bash
curl -s localhost:38630/block/$(curl -s localhost:38630/status | grep -o '"headHash":"[^"]*"' | cut -d'"' -f4)
```

PoT weight and consensus identity:

```bash
curl -s localhost:38630/pot
```

Expect `"consensus":"PROOF_OF_TIME"`, `observedSpacingMs` near 5000, and
`blocksPerMinute` near 12.

PARAMS_HASH and protocol version on **all three**:

```bash
for p in 38630 38640 38650; do
  echo -n "$p: "; curl -s localhost:$p/status | grep -o '"paramsHash":"[^"]*"'
done
```

All three must print `5ed3d6409bd4e723f83f00469e976062`.

### C9. Create a wallet

```bash
cd obsidian-core
node dist/index.js wallet new
```

This runs **locally** and prints an address, a private key and a recovery
phrase. Nothing is sent anywhere. Save the private key and phrase offline; the
address is safe to share.

### C10. Submit transactions

Available routes, from `obsidian-core/src/rpc/server.ts`:

```bash
curl -s localhost:38630/tx/encode    # build the canonical bytes to sign
curl -s localhost:38630/tx/gas       # what gas a transfer would cost
curl -s localhost:38630/tx/simulate  # dry run, changes nothing
curl -s localhost:38630/tx/submit    # submit a signed transaction (POST)
curl -s localhost:38630/next-nonce   # the next sequence number for an address
```

`docs/transaction-format.md` documents canonical encoding, signing and
submitting without the interface. The practical path for a beginner is the
wallet frontend (§F, §G) rather than hand-signing.

### C11. Test mining registration and claims

```bash
curl -s localhost:38630/mining/schedule
curl -s "localhost:38630/mining/status?address=<your-address>"
curl -s localhost:38630/mining/claims
```

Rules enforced by consensus: one claim per 4 hours, at most 6 per 24 hours,
0.001 OBS/day initially. **A devnet cannot show you a full day of mining in a
minute** — block timestamps are protocol time and cannot be fast-forwarded.
What you can verify is that a second claim inside 4 hours is *rejected*.

### C12. Test the Genesis Invitation and its one-time rule

This is interface-level, so start the interface (§C14) first, then:

```bash
# 1. The first account requires the Genesis Invitation
curl -s -X POST http://localhost:8788/api/auth/google \
  -H 'content-type: application/json' \
  -d '{"idToken":"<a real Google ID token>"}'
# -> 403 ERR_GENESIS_INVITE_REQUIRED

# 2. With the correct invitation -> 200, account created
# 3. The same invitation again -> 403 ERR_GENESIS_INVITE_INVALID_OR_USED
```

Check status without revealing anything:

```bash
curl -s http://localhost:8788/api/auth/config
```

It reports `"genesisInvite":{"configured":true,"redeemed":false}` and never the
code or its hash.

> Real Google sign-in needs `OBSIDIAN_GOOGLE_CLIENT_ID` and a real token. The
> automated tests cover the whole flow with a stubbed verifier:
> `npm --prefix obsidian-interface test` → `tests/genesis-invite.test.ts` (23
> tests) and the genesis tests in `tests/server.test.ts`, including 8
> simultaneous registrations racing for one invitation with exactly one winner.

### C13. Test node registration and rewards

```bash
curl -s localhost:38630/nodes/registry
curl -s localhost:38630/nodes/rewards
curl -s localhost:38630/nodes/status/<nodeId>
curl -s localhost:38630/revenue
```

Registering requires a 100 OBS bond and a signed transaction — see §I and
`docs/node-runner-rewards.md`. On a fresh devnet nobody has 100 OBS yet, so
this is testable only after mining or after the genesis allocation.

### C14. Start the interface and test frontends

```bash
cd ~/Obsidian-Network
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build
cd obsidian-interface
OBSIDIAN_NODE_URLS=http://127.0.0.1:38630,http://127.0.0.1:38640 \
OBSIDIAN_INTERFACE_HOST=0.0.0.0 \
OBSIDIAN_INTERFACE_PORT=8788 \
OBSIDIAN_GENESIS_INVITE_HASH='<the hash from scripts/new-genesis-invite.mjs>' \
node dist/server/main.js
```

Then check all twelve sites answer:

```bash
for p in / /mine/ /wallet/ /explorer/ /social/ /capsule/ /ons/ /circle/ /developer/ /node/ /app/ /audit/; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8788$p)"
done
```

All twelve must print `200`.

Test frontend-to-node communication (the interface proxies reads; the browser
never talks to a node directly):

```bash
curl -s 'http://localhost:8788/api/rpc?path=/status'
curl -s 'http://localhost:8788/api/rpc?path=/pot'
curl -s 'http://localhost:8788/api/rpc?path=/supply'
```

### C15. Test the explorer and API

Open `http://localhost:8788/explorer/` in your phone's browser. Per
`docs/explorer.md` it shows blocks and transactions and **never wallet
balances** — that is deliberate, not missing.

### C16. Shut down and restart safely

Press **Ctrl+C** once in each node's terminal. That is a graceful shutdown; the
node flushes state and exits. Do not kill -9 unless it hangs.

To restart, run the same command with the **same `--data-dir`**. The chain
resumes. To start over, delete the data directory:

```bash
rm -rf /tmp/obs
```

Verify integrity after any unclean shutdown:

```bash
node dist/index.js validate --network devnet --data-dir /tmp/obs/n1
```

---

## D. Public testnet

Moving from "three nodes on my phone" to "nodes on the internet".

### D1. What kind of server

From `docs/node-operator.md` §1:

| | Minimum | Comfortable |
|---|---|---|
| OS | Linux x86-64 or arm64 | Ubuntu 22.04/24.04 LTS |
| Node.js | 20.10+ | 22 LTS |
| CPU | 1 core | 2+ (mining benefits) |
| RAM | 512 MB | 1 GB |
| Disk | a few hundred MB | 20–50 GB SSD, room to grow |
| Network | inbound TCP on the p2p port | static IP or stable DNS |

That is a very small VPS — the cheapest tier at most providers is enough for a
testnet.

### D2. How many servers, and where

**Three, minimum.** `docs/mainnet-launch.md` §1.2 states the reasoning: three
is the point at which losing one operator does not stop block production or
leave one party defining the chain.

**Different providers and different countries, yes.** The whole argument for
decentralisation collapses if all three are in one data centre behind one
company's billing department.

### D3. Install on each server

```bash
ssh user@your-server-ip
sudo apt update && sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version      # must be >= 20.10

git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
git checkout arena/01a0e1df-obsidian-network
npm --prefix obsidian-core ci
npm --prefix obsidian-core run build
```

> The NodeSource line is the standard way to install a current Node.js on
> Debian/Ubuntu. It is not part of this repository.

### D4. Secure the server

Before exposing anything:

```bash
# a non-root user
sudo adduser obsidian
sudo usermod -aG sudo obsidian

# SSH keys instead of passwords: on your phone/PC
ssh-keygen -t ed25519
ssh-copy-id obsidian@your-server-ip

# then disable password login
sudo nano /etc/ssh/sshd_config
#   PasswordAuthentication no
#   PermitRootLogin no
sudo systemctl restart ssh
```

### D5. Firewall and ports

The project's ports, from `obsidian-core/src/protocol/networks.ts`:

| Network | Chain id | RPC | P2P | Address prefix |
|---|---|---|---|---|
| mainnet | 7777 | 8630 | 8631 | `obs1` |
| testnet | 7778 | 18630 | 18631 | `tobs1` |
| staging | 7779 | 28630 | 28631 | `sobs1` |
| devnet | 7780 | 38630 | 38631 | `dobs1` |

For a public **testnet**:

```bash
sudo ufw allow 22/tcp        # SSH — do this first or you lock yourself out
sudo ufw allow 18631/tcp     # P2P: must be reachable from the internet
sudo ufw enable
sudo ufw status
```

**Do not open the RPC port to the world.** Keep RPC on `127.0.0.1` and put the
interface or a reverse proxy in front of it. `.env.example` says this plainly:
"Keep RPC on loopback and publish an interface (or a proxy) instead. Never put a
CDN in front of p2p."

### D6. Configure the node

Use `obsidian-core/deployment/node.env.example` as the starting point. The
config file for testnet is `obsidian-core/config/testnet.json`. Per host, set:

- `publicHost` — the address other nodes dial you on
- `seedNodes` — the other nodes' `host:port` (P2P port)
- `miningRewardAddress` — a wallet you generated offline
- `rpcHost` — leave `127.0.0.1`
- `strictDataDir` — leave `true`

### D7. Node keys

```bash
sudo mkdir -p /etc/obsidian
sudo sh -c 'printf %s "a-long-random-passphrase" > /etc/obsidian/keystore.pass'
sudo chmod 600 /etc/obsidian/keystore.pass

node dist/index.js keygen --network testnet --data-dir /var/lib/obsidian-node
```

Prefer `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE` over
`OBSIDIAN_KEYSTORE_PASSPHRASE` — `.env.example` explains why: a passphrase in a
shell variable ends up in shell history and in process listings.

Back up `node-key.json` and store its passphrase **separately**.

### D8. Run it as a service

The repository ships a systemd unit:
`obsidian-core/deployment/systemd/obsidian-node.service`. systemd is Linux's
service manager: it starts the node at boot and restarts it if it dies.

```bash
sudo cp obsidian-core/deployment/systemd/obsidian-node.service /etc/systemd/system/
sudo nano /etc/systemd/system/obsidian-node.service   # adjust paths/user
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-node
sudo systemctl status obsidian-node
sudo journalctl -u obsidian-node -f     # live logs
```

### D9. TLS and reverse proxy

TLS ("HTTPS") encrypts traffic. You need it for any public web endpoint.

The repository ships nginx configs:
- `obsidian-core/deployment/nginx/obsidian-node.conf`
- `obsidian-interface/deployment/nginx/obsidian-interface.conf`

nginx is a reverse proxy — it accepts public HTTPS and forwards to your local
process. Certificates come from Let's Encrypt via `certbot`
(**not part of this repository**).

**Is a reverse proxy required?** For the **interface**, yes if you expose it
publicly and are not putting Cloudflare in front. For **P2P**, no — never proxy
P2P. For **RPC**, only if you deliberately publish read access.

If a proxy terminates TLS in front of the interface, set
`OBSIDIAN_INTERFACE_TRUST_PROXY=true`, and only then.

### D10. Persistent storage, backups, logs

- **Data directory**: `/var/lib/obsidian-node` (from `.env.example`). This is
  the chain. Keep it on disk that survives a reboot.
- **Backups**: `docs/node-operator.md` §7 covers backup and restore. The
  irreplaceable file is `node-key.json`; chain data can be re-synced from peers,
  an identity cannot be regenerated.
- **Logs**: `journalctl -u obsidian-node`. Logs are JSON when `logJson` is true.

### D11. Monitoring and health checks

From `docs/mainnet-launch.md` §5, alert on:

| Signal | Check | Bad |
|---|---|---|
| Height stalled | `/status` | unchanged > 60 s |
| Spacing drift | `/pot` | `observedSpacingMs` outside ~3000–8000 |
| Peer collapse | `/peers` | near zero |
| Params divergence | `/params` | differs between nodes |
| Supply invariant | `/supply` | `invariantOk` not `true` — **halt condition** |
| Clock drift | `timedatectl` | more than a second or two |

A minimal check from your phone:

```bash
watch -n 10 'curl -s https://rpc1.example.org/status'
```

**NOT DOCUMENTED IN THE CURRENT REPOSITORY:** there is no Prometheus `/metrics`
endpoint, no Grafana dashboard and no alerting configuration. Monitoring today
means polling the RPC routes above yourself. *What is needed:* a decision on a
monitoring stack, or accept manual polling for a testnet.

### D12. Clock discipline

Proof of Time accepts a block only if its timestamp beats the median of the last
11 blocks, beats its parent, and is no more than 60 seconds ahead of the
receiving node's clock. A wrong clock rejects honest blocks.

```bash
sudo timedatectl set-ntp true
timedatectl status     # expect: System clock synchronized: yes
```

### D13. Connect the frontends

Point the interface at **several** nodes so it can fail over:

```bash
OBSIDIAN_NODE_URLS=https://rpc1.example.org,https://rpc2.example.org,https://rpc3.example.org
```

The browser never contacts a node directly; it calls the interface, which
proxies an allowlisted set of read routes.

---

## E. Mainnet

**Primary source: `docs/mainnet-launch.md`.** Read it in full before doing any
of this. What follows is the same sequence with more explanation for a beginner.

### E1. Mainnet facts to verify, not trust

| | |
|---|---|
| Network id | `obsidian-mainnet-1` |
| Chain id | `7777` |
| Genesis id | `20a787220fa49a2d8a41276b370705a16add75ba` |
| Genesis hash | `43d0b6d29a99a84955ebd1797231c4d0b887c684c342d7ce4360a5668ade0ebc` |
| Protocol version | `1.1.0` |
| PARAMS_HASH | `5ed3d6409bd4e723f83f00469e976062` |
| RPC / P2P port | 8630 / 8631 |
| Address prefix | `obs1` |
| Max supply | 21,000,000 OBS |
| Supply at height 0 | **0 OBS** |

Verify on two independent machines:

```bash
node dist/index.js genesis init --network mainnet
```

Same `genesisId` and `genesisHash` on both, or they are not running the same
protocol.

### E2. There is no premine

At height 0 total supply is zero. There is no token sale, no foundation
allocation and no administrator. The only two issuance events that will ever
exist are the **genesis allocation** (100,000 OBS to the first protocol-valid
mining claim) and **mining claims**. Both are checked against the 21,000,000 cap
inside the state transition.

### E3. Launch from a verified archive

```bash
cd releases
sha256sum -c SHA256SUMS
../scripts/verify-release.sh obsidian-node-operator-1.1.0.tar.gz
../scripts/verify-release.sh obsidian-core-1.1.0.tar.gz --with-tests
```

The operator package ships `dist/` without tests, so `--with-tests` reports
"no test script; skipping" there — verify the core archive too.

### E4. Three independent nodes

Same as §D2, but stricter: different operators, different hosting, ideally
different jurisdictions. Provision each per §D3–D8 with `--network mainnet`.

### E5. Start node 1, then 2 and 3

```bash
node dist/index.js start --config config/mainnet.json
```

Expect `height=0` and `genesisId=20a787220fa49a2d8a41276b370705a16add75ba`.

Confirm the state is genuinely empty:

```bash
curl -s localhost:8630/supply
```

Expect `totalSupplyObs: "0.000000000000000000"`, `invariantOk: true`.

Then nodes 2 and 3 with `--seeds node1.example.org:8631`, and afterwards update
every node's `seedNodes` to include the others and restart, so the topology is
a mesh rather than a star around node 1.

### E6. Verify convergence and identical rules

```bash
curl -s localhost:8630/peers
curl -s localhost:8630/status
curl -s localhost:8630/pot
curl -s localhost:8630/params | grep -o '"paramsHash":"[^"]*"'
```

**Every node must print the same params hash.** A mismatch means one node is
running different consensus rules and will fork. Stop it.

### E7. Compliance, invariants, supply

```bash
curl -s localhost:8630/audit/compliance
node scripts/check-invariants.mjs          # all 50 invariants hold
node dist/index.js audit --network mainnet
```

All sixteen removed features must report `present: false`: `wac`,
`legacyGenesisAllocation`, `signupAllocation`, `miningKyc`,
`miningWithdrawalRequiresWac`, `nativeExchange`, `explorerExposesBalances`,
`browserClockControlsMining`, `serverStoresPrivateKeys`, `adminMintPath`,
`proofOfWorkConsensus`, `blockHeaderNonce`, `selfReportedNodeMetrics`,
`adminRewardOverride`, `gasCountedAsPlatformRevenue`, `nodeIdentityIsIpAddress`.

### E8. Publish the seed list

**Only now.** Publishing bootstrap addresses before you have finished validating
invites people onto a chain you have not checked.

### E9. Genesis Invitation and the first registration

Generate the invitation on the machine that will run the interface:

```bash
node scripts/new-genesis-invite.mjs
```

Write the plaintext on paper. Put the hash in the interface's environment as
`OBSIDIAN_GENESIS_INVITE_HASH`. The first person to sign in with that code
becomes the first account. It grants **0 OBS** — it is a door key, not money.

### E10. The genesis allocation event

The first accepted **mining claim** awards 100,000 OBS and designates the
treasury. Nobody triggers it; it happens in consensus when a real user submits a
valid claim.

```bash
curl -s localhost:8630/genesis
```

Before:

```json
"state": { "allocationClaimed": false, "recipient": "", "treasuryWallet": "",
           "amount": "100000000000000000000000" }
```

After, `allocationClaimed` is `true` and `recipient`/`treasuryWallet` hold the
winning address, with `claimedAtHeight` and `claimedByTxId` recorded
permanently. Verify independently:

```bash
curl -s localhost:8630/tx/<claimedByTxId>
curl -s localhost:8630/supply        # genesisIssuedObs = 100000
```

**Confirm the recipient is identical on every node.** Divergence here is a
consensus failure and must halt the launch.

Until that claim exists there is no treasury, and operations that pay it (ONS
registration, business pages, protocol land sales) are refused with a clear
error rather than routed somewhere else.

### E11. Mining pool, node pool, the 40/60 split

- **Gas** (0.02%, capped at 0.01 OBS) goes to the **Mining Pool**, whole. It is
  never counted as platform revenue.
- **Platform revenue** (ONS registration/renewal, business pages, protocol land
  sales, explicit payments) splits **40% to the node runner pool, 60% to the
  treasury**, inside the state transition.

```bash
curl -s localhost:8630/revenue
curl -s localhost:8630/nodes/rewards
```

### E12. Frontends, DNS, HTTPS, Cloudflare

See §F and §J. Prove the network does not depend on the edge: stop the
Cloudflare worker and confirm blocks still advance and `/status` still answers
directly from a node. If anything stops, the deployment is wrong.

### E13. Final launch checklist

Use the one in `docs/mainnet-launch.md` §7 — it is the authoritative version —
and the expanded one in §P below.

---

## F. Frontends

There are **twelve**, from `obsidian-interface/scripts/build-sites.mjs`. They
are **generated by the build**, not hand-written HTML: the source is
`obsidian-interface/web/src/pages/<name>.ts` and the build writes a folder at
the repository root.

**All twelve share the same deployment model.** Each is a static folder (HTML +
shared JS bundles + CSS) that needs the interface server for its `/api/` calls.
None of them is a separate app with its own build command.

| # | Site | Directory | Entry point (source) | What it does | Needs backend? |
|---|---|---|---|---|---|
| 1 | Landing | `landing/` → served at `/` | `web/src/pages/landing.ts` | Project description. Only three CTAs: Start Mining, Create Wallet, Explorer. | No (static) |
| 2 | Mine | `mine/` | `web/src/pages/mine.ts` | Mining claims and schedule | Yes |
| 3 | Wallet | `wallet/` | `web/src/pages/wallet.ts` | Non-custodial wallet, client-side signing | Yes (reads) |
| 4 | Explorer | `explorer/` | `web/src/pages/explorer.ts` | Blocks and transactions. **Never wallet balances.** | Yes |
| 5 | Social | `social/` | `web/src/pages/social.ts` | OBS Social | Yes |
| 6 | Capsule | `capsule/` | `web/src/pages/capsule.ts` | Time Capsule Wall | Yes |
| 7 | ONS | `ons/` | `web/src/pages/ons.ts` | `.obs` names | Yes |
| 8 | Circle | `circle/` | `web/src/pages/circle.ts` | Obsidian Circle land | Yes |
| 9 | Developer | `developer/` | `web/src/pages/developer.ts` | API docs for developers | Yes |
| 10 | Node | `node/` | `web/src/pages/node.ts` | Node runner rewards, registry, scores | Yes |
| 11 | App | `app/` | `web/src/pages/app.ts` | Sign-in, invites, **Genesis Invitation**, wallet linking | Yes |
| 12 | Audit | `audit/` | `web/src/pages/audit.ts` | Compliance and decentralisation audit | Yes |

### F1. One build command for all of them

```bash
npm --prefix obsidian-interface run build
```

This runs, in order: build the core → sync browser-safe modules → bundle the
web JS → check nothing browser-unsafe leaked in → write the 12 site shells →
compile the server.

### F2. What must be deployed

- The twelve site folders
- `obsidian-interface/public/` (CSS, assets, logo)
- `obsidian-interface/web/core/` (browser-safe core modules)
- `obsidian-interface/dist/` (the server), unless you are hosting statics only

The ready-made bundle of exactly this is the release archive
`obsidian-interface-selfhost-1.1.0.tar.gz`.

### F3. Where they should live

**Recommended: the interface server itself** (`node dist/server/main.js`). It
serves all twelve and provides the `/api/` routes they need. This is the
deployment the tests and the Docker image cover.

**Cloudflare Pages** could host the static folders, but then `/api/` must still
reach an interface instance, and you must configure that routing yourself.
**NOT DOCUMENTED IN THE CURRENT REPOSITORY:** there is no Pages configuration,
no `_redirects`/`_routes.json`, and no documented split-hosting setup. *What is
needed:* a decision on whether statics are split from the API, and if so the
routing rules. The supported path is the interface server, optionally behind the
Cloudflare Worker in `cloudflare/`.

### F4. Which API they connect to

All of them call **relative** URLs on the same origin:

- `/api/rpc?path=/status` — allowlisted proxied reads
- `/api/auth/...` — sign-in and invites
- `/api/nodes/...` — node pool health

They never contain a node address. The interface decides which node to read,
health-checks them, and fails over.

### F5. Configuration

The frontends themselves need no environment variables. The **interface** does:

| Variable | Meaning |
|---|---|
| `OBSIDIAN_NODE_URLS` | Comma-separated node RPC URLs (use 2+) |
| `OBSIDIAN_INTERFACE_HOST` | Bind address (`0.0.0.0` to accept outside traffic) |
| `OBSIDIAN_INTERFACE_PORT` | Port, default 8788 |
| `OBSIDIAN_INTERFACE_DATA_DIR` | Where the account list is stored |
| `OBSIDIAN_GOOGLE_CLIENT_ID` | Enables sign-in; empty disables account creation |
| `OBSIDIAN_GENESIS_INVITE_HASH` | Hash of the single-use Genesis Invitation |
| `OBSIDIAN_INTERFACE_ALLOWED_ORIGINS` | CORS allowlist; empty = same-origin only |
| `OBSIDIAN_INTERFACE_TRUST_PROXY` | `true` only behind a TLS proxy you control |
| `OBSIDIAN_INTERFACE_MAX_INVITES` | Invites per account (protocol default 5) |

### F6. Test locally, deploy, update

Locally: §C14. Deploy: copy the selfhost archive, set the environment, run
`node dist/server/main.js` under systemd
(`obsidian-interface/deployment/systemd/obsidian-interface.service`). Update:
stop the service, replace the files with a newly verified archive, start it.
The interface holds no chain state, so replacing it is safe and reversible.

---

## G. Wallet

### G1. The security model in one line

**The private key never leaves the device.** There is no code path that sends it
to a server, and the interface's browser bundle is checked at build time by
`scripts/check-browser-safe.mjs`.

### G2. Key generation

Keys come from a cryptographically secure random generator. They are **never**
derived from an email address, Google ID, username, date of birth or account
id. Two ways to create one:

```bash
node dist/index.js wallet new     # CLI, offline
```

or the Wallet frontend, which generates in the browser.

You receive an **address** (safe to share), a **private key** (never share) and
a **recovery phrase** (never share).

### G3. What must never touch the server

- The private key
- The recovery phrase
- Any passphrase protecting them

Not in an API call, not in a log, not in analytics, not in browser storage you
sync to a cloud. The account store on the server holds an *advisory* wallet
address only, and the code comments mark it "never trusted".

### G4. Signing and submitting

1. Build the transaction (`/tx/encode` gives the canonical bytes).
2. Sign locally with the private key.
3. Submit the signed transaction (`POST /tx/submit`).
4. Confirm by polling `/tx/<txId>`.

Gas is 0.02% of the transferred amount, capped at 0.01 OBS, and returns to the
Mining Pool. Check before sending with `/tx/gas`, and dry-run with
`/tx/simulate`, which changes nothing.

Confirmation depth: soft 12 blocks, hard 64 (`block.confirmationDepthSoft` /
`confirmationDepthHard`). At 5-second blocks that is about a minute and about
five minutes.

### G5. Backup and recovery

Your backup **is** the recovery phrase and private key, written down offline.
There is no "forgot password" — non-custodial means whoever holds the key holds
the funds, and nothing in this system can undo that. `SECURITY.md` puts reports
that reduce to "I gave away my key" out of scope for exactly this reason.

---

## H. Mining registration

### H1. Two layers, and which is which

| Layer | What it controls | Who enforces |
|---|---|---|
| **Application** | Who may use *this interface deployment*: Google sign-in, invite codes, the Genesis Invitation, sessions | The interface server |
| **Consensus** | Who may mine, how much, how often, and the supply cap | Every node, independently |

The application layer cannot create OBS, change a claim, or make anyone
eligible. Deleting the interface's account file costs access, not money.

### H2. Google login

Implemented. The browser gets a Google ID token; the **server** verifies it
against Google's public keys. A body field claiming `isGoogleUser: true` is
**deliberately never read** — the code comments say so.

Requires `OBSIDIAN_GOOGLE_CLIENT_ID`. If empty, account creation is disabled
entirely, and the wallet, miner and explorer keep working without accounts.

### H3. Invitations

- **Genesis Invitation** — one per deployment, single use, bootstraps the first
  account. Format `OBS-GENESIS-XXXX-XXXX-XXXX-XXXX`, 80 bits of entropy, stored
  only as a salted scrypt hash. Redemption is atomic: the check and the
  spend happen in one synchronous step, so simultaneous attempts cannot both
  win. Grants **0 OBS** and no authority.
- **Member invites** — every account may issue at most 5, enforced server-side.
  A separate store, a separate format, a separate code path.

Previously the first account needed no credential at all; whoever reached a
fresh deployment first became its first member. That is now closed.

### H4. Zero OBS at registration

`registry.newAccountBalance` is `0`, asserted by
`scripts/check-invariants.mjs`. Registering creates an access record, nothing
more.

### H5. Mining claims

| Rule | Value |
|---|---|
| Claim interval | every 4 hours (14,400 s) |
| Max claims | 6 per 24 hours |
| Initial rate | 0.001 OBS/day |
| Per claim | 0.000166666666666666 OBS |
| Active miner | ≥ 1 valid claim in the last 30 days |
| Reduction | −0.5% per 100,000 active miners |
| Floor | 0.0002 OBS/day |
| Per block | 1 claim per wallet |

### H6. The browser clock is irrelevant

Eligibility derives from **block timestamps**, not your device. Changing your
phone's clock does nothing. A node's own clock can only *reject* a block (the
60-second future-drift bound), never admit one. `/audit/compliance` reports
`browserClockControlsMining: {present: false}`.

### H7. Anti-replay

Every claim carries a unique claim id with replay and idempotency protection and
an atomic state transition, so multi-tab, multi-device and racing submissions
cannot double-claim.

### H8. The 100,000 OBS genesis allocation

Awarded to the **first protocol-valid mining claim** — not at registration, not
to the first account, not to whoever holds the Genesis Invitation. It is awarded
exactly once by a one-way flag, and that wallet simultaneously becomes the
on-chain treasury.

---

## I. Node operators

Follow `docs/node-operator.md`; this is the short version.

1. **Hardware**: §D1 above.
2. **OS**: Linux. Install Node.js 20.10+.
3. **Install**: clone and build, or use `obsidian-node-operator-1.1.0.tar.gz`
   (built `dist/`, deployment recipes, docs, `verify-release.sh`,
   `check-invariants.mjs`).
4. **Keys**: `node dist/index.js keygen`. Set
   `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE`. Back up `node-key.json`.
5. **Configure**: `config/mainnet.json`, set `publicHost`, `seedNodes`,
   `miningRewardAddress`. Keep `rpcHost` on loopback and `strictDataDir: true`.
6. **Firewall**: open the P2P port only.
7. **Run**: the systemd unit; `journalctl -u obsidian-node -f` for logs.
8. **Backups**: `docs/node-operator.md` §7.
9. **Updates**: §8 of the same document.

### Earning the 40% share

From `docs/node-runner-rewards.md`:

- **Register** with a `NODE_REGISTRY` transaction and a **100 OBS bond**,
  returned in full on deregistration.
- **Heartbeats** prove you are alive; **attestations** from at least 2 other
  nodes prove it independently — uptime is never self-reported.
- **Fault reports** penalise misbehaviour (2000 bps).
- **Scoring**: uptime 40%, participation 25% (blocks 60% / coverage 40%),
  reliability 20%, responsiveness 15%. No node may take more than 5% of a
  period. Periods are 24 hours.
- **Wallet changes** take effect one period later.

Verify your rewards:

```bash
curl -s localhost:8630/nodes/status/<nodeId>
curl -s localhost:8630/nodes/rewards
curl -s localhost:8630/revenue
```

---

## J. Cloudflare

### J1. What it is responsible for

From `cloudflare/README.md` and `wrangler.toml`:

- **DNS** — pointing your domain at your servers
- **TLS** — HTTPS certificates at the edge
- **Caching** — short-lived caching of read-only chain data
  (`CHAIN_CACHE_SECONDS = "5"`)
- **Gateway** — forwarding to `OBSIDIAN_ORIGIN` (your interface)
- **Static assets** — from `OBSIDIAN_ASSETS_ORIGIN`
- **Rate limiting and DDoS absorption**

Deploy with `wrangler` after editing `cloudflare/wrangler.toml`. Terraform for
the zone config is in `cloudflare/terraform/main.tf`.

### J2. What it must NEVER be

- **Never a consensus authority.** It cannot create, move or price OBS, and it
  cannot decide a claim.
- **Never the only copy of chain data.** It is a cache in front of nodes.
- **Never in front of P2P.** `.env.example`: "Never put a CDN in front of p2p."
- **Never handling private keys or write operations.** The worker never caches
  requests carrying cookies or writes.

### J3. Why this matters

The trust hierarchy is one-directional:

```
consensus → node state → verified chain data → APIs and indexes → frontend cache
```

Cloudflare sits at the far right. If Cloudflare becomes authoritative, the
chain's guarantees reduce to "whatever one company's edge says", and an outage
or a compromised account becomes a consensus event instead of a website outage.

**The test:** turn the worker off. Blocks must keep being produced and `/status`
must still answer directly from a node. The CI Docker job performs the
equivalent check — it stops the interface and confirms the node keeps producing.

---

## K. Security checklist

**Servers**
- [ ] SSH keys only; `PasswordAuthentication no`, `PermitRootLogin no`
- [ ] A non-root user runs the node
- [ ] Firewall: P2P port open, RPC closed, SSH restricted
- [ ] Automatic security updates
- [ ] NTP synchronised (Proof of Time depends on it)

**Keys**
- [ ] `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE`, mode 0600, not the plain variable
- [ ] Generated `.pass` companion files deleted
- [ ] `node-key.json` backed up; passphrase stored separately
- [ ] Node identity holds no funds — it is not a wallet
- [ ] Wallet private keys and recovery phrases offline, never on a server

**Genesis Invitation**
- [ ] Plaintext written on paper / in a password manager, offline
- [ ] Only `OBSIDIAN_GENESIS_INVITE_HASH` on the server
- [ ] Never in a commit, screenshot, chat message or issue
- [ ] `failedAttempts` monitored via the store for brute-force attempts

**Secrets**
- [ ] `.env` is gitignored and never committed
- [ ] GitHub repository secrets for CI only; no secrets in workflow files
- [ ] Cloudflare API tokens scoped to the minimum needed
- [ ] Rotate anything ever pasted into a chat, a log or a screenshot

**Supply chain**
- [ ] `npm ci` (exact locked versions), never `npm install` on a server
- [ ] `npm audit --omit=dev --audit-level=high` before releases
- [ ] Verify every archive with `scripts/verify-release.sh` before running it
- [ ] Confirm the running commit matches the intended one

**Exposure**
- [ ] Private RPC (loopback) for control; public reads only through the
      interface or a rate-limited proxy
- [ ] `rpcAllowSubmit` never on a public unauthenticated port
- [ ] CORS allowlist set deliberately
- [ ] Cloudflare rate limiting enabled

**People**
- [ ] Publish the official domains so users can spot fake wallet sites
- [ ] Never ask a user for a private key — and say so, loudly, on the wallet page
- [ ] Vulnerability reports go through `SECURITY.md`, privately

**Emergency key rotation**
- Node identity: `keygen` a new one, deregister the old node id, re-register.
- Wallet: create a new wallet, move funds, retire the old address.
- Genesis Invitation: if unredeemed, generate a new one and replace the hash. If
  already redeemed, it is spent and cannot be revived — that is enforced.

---

## L. Troubleshooting

### Node will not start

**Symptom:** the process exits immediately.
**Cause:** wrong Node.js version, missing build, or a data directory from
another network.
```bash
node --version                      # must be >= 20.10
ls obsidian-core/dist/index.js      # must exist
```
**Fix:** `npm --prefix obsidian-core ci && npm --prefix obsidian-core run build`.
If the log says the data directory belongs to another network, use a different
`--data-dir`; that refusal is `strictDataDir` protecting you.

### Port already in use

**Symptom:** `EADDRINUSE`.
```bash
ss -ltnp | grep 8630
```
**Fix:** stop the other process, or pass `--rpc-port` / `--p2p-port` with free
numbers. Remember each network has its own defaults (devnet is 38630).

### Cannot find peers

**Symptom:** `/peers` is empty.
```bash
curl -s localhost:8630/peers
sudo ufw status                     # is the P2P port open?
```
**Cause:** firewall, wrong seed, seeds pointed at an RPC port instead of P2P, or
`--offline`.
**Fix:** open the P2P port, pass `--seeds host:8631` (P2P port), remove
`--offline`.

### Different genesis hash

**Symptom:** peers refuse each other; `/genesis` differs.
**Cause:** different networks, or different code.
**Fix:** run `genesis init --network mainnet` on both and compare. They must
match exactly. If not, one machine is on different code — redeploy the same
archive.

### Different PARAMS_HASH

**Symptom:** nodes fork.
```bash
curl -s localhost:8630/params | grep -o '"paramsHash":"[^"]*"'
```
**Cause:** different protocol versions or modified parameters.
**Fix:** all nodes to the same release. **This is a halt condition during a
launch.**

### Different protocol version

```bash
curl -s localhost:8630/version
```
**Fix:** upgrade the lagging node. Nodes compare core version, protocol version,
network id and genesis id at handshake, so a mismatched binary is rejected by
the network rather than quietly showing a different chain.

### Heights diverge

**Symptom:** one node's height lags or leads persistently.
**Cause:** lost peers, clock drift, or a fork.
```bash
curl -s localhost:8630/status
curl -s localhost:8630/peers
timedatectl status
```
**Fix:** restore peers and NTP. A few blocks of difference is normal
propagation; a persistent gap is not.

### State roots diverge

**Symptom:** same height, different state root.
**Cause:** a genuine consensus bug or one node running different code.
**Fix:** capture both heads (`/block/<hash>`) from each side **before**
restarting anything — that evidence is what makes the bug findable — then report
privately per `SECURITY.md`.

### PoT weight differs

```bash
curl -s localhost:8630/pot
```
Compare `cumulativePotWeight`. Differences at the tip are normal; persistent
differences at the same height indicate a fork. Fork choice is
`POT_WEIGHT_THEN_TIME_THEN_LOWEST_HEADER_HASH`.

### Transaction rejected

**Cause:** bad signature, wrong nonce, expired, insufficient balance, or over
size limits (`maxTxBytes` 16384, `maxMemoBytes` 256).
```bash
curl -s "localhost:8630/next-nonce?address=<addr>"
curl -s localhost:8630/tx/simulate
```
**Fix:** use the nonce the node reports, and simulate before submitting.
Transactions expire after 240 blocks.

### Transaction stuck

```bash
curl -s localhost:8630/mempool
curl -s localhost:8630/tx/<txId>
```
**Fix:** if it has expired it will never confirm — rebuild it with a current
nonce and resubmit.

### Mining claim rejected

**Cause:** inside the 4-hour interval, already 6 claims in 24 hours, a replayed
claim id, or a second claim for the same wallet in one block.
```bash
curl -s "localhost:8630/mining/status?address=<addr>"
```
**Fix:** wait. Changing your device clock will not help and is not consulted.

### Invite code rejected

`ERR_INVITE_REQUIRED` (none supplied), `ERR_INVITE_INVALID` (unknown), or
`ERR_INVITE_USED` (already accepted). Each account may issue only 5.

### Genesis Invitation already used

**Symptom:** `ERR_GENESIS_INVITE_INVALID_OR_USED`.
```bash
curl -s http://localhost:8788/api/auth/config
```
If `genesisInvite.redeemed` is `true`, it is spent permanently — by design, and
it cannot be revived by restarting with a new hash. Later accounts use member
invites. If the deployment was never meant to be bootstrapped yet, you are
looking at a different data directory than you think.

`ERR_GENESIS_INVITE_NOT_CONFIGURED` means `OBSIDIAN_GENESIS_INVITE_HASH` is
unset — registration is closed until you set it.

### Frontend cannot reach the API

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:8788/
curl -s 'http://localhost:8788/api/rpc?path=/status'
curl -s http://localhost:8788/api/nodes
```
**Cause:** the interface is down, or every configured node is unhealthy.
**Fix:** check `OBSIDIAN_NODE_URLS` points at reachable nodes; the interface
health-checks and fails over, but cannot invent a healthy node.

### CORS error

**Symptom:** the browser console reports a blocked cross-origin request.
**Cause:** the frontend is on a different origin than the interface.
**Fix:** set `OBSIDIAN_INTERFACE_ALLOWED_ORIGINS` to the exact origin, or serve
the frontends from the same origin (the supported arrangement).

### Cloudflare error

5xx from the edge with the origin healthy: check `OBSIDIAN_ORIGIN` in
`wrangler.toml`, and confirm the origin is reachable from outside. **Bypass
Cloudflare and hit the origin directly** to prove where the fault is:
```bash
curl -s https://interface.example/api/rpc?path=/status
```

### Wallet cannot connect / signing failure

The wallet signs in your browser. A signing failure is a wrong key, a corrupted
recovery phrase, or a browser blocking the crypto APIs. Try a different browser
before assuming key loss. **Never paste a private key into a support channel.**

### Node reward missing

```bash
curl -s localhost:8630/nodes/status/<nodeId>
```
**Cause:** score below the 1000 bps minimum, uptime under 5000 bps, fewer than 2
attesters, an unreturned bond, or a wallet change that takes effect next period.
**Fix:** check the score breakdown on `/node/` and fix the weakest component.

### State corruption

```bash
node dist/index.js validate --network mainnet --data-dir /var/lib/obsidian-node
```
**Fix:** restore from backup, or delete the data directory and re-sync from
peers. The chain is replicated; only `node-key.json` is irreplaceable.

### Server restart

With systemd the node restarts automatically. Confirm:
```bash
sudo systemctl status obsidian-node
curl -s localhost:8630/status
```

### Disk full

```bash
df -h
du -sh /var/lib/obsidian-node
```
**Fix:** add disk, or move the data directory to a bigger volume and update
config. A node that cannot write will stop following the chain.

### Certificate / HTTPS problem

```bash
curl -vI https://your-domain 2>&1 | grep -i 'expire\|SSL'
```
**Fix:** renew with certbot, or check Cloudflare's TLS mode. This affects the
website only — consensus does not use TLS between nodes in the way browsers do.

---

## M. Android guide

You do not have a PC. This whole thing works from a phone.

### M1. Install Termux

**Install from F-Droid, not the Play Store** — the Play Store version is
abandoned and breaks.

1. Open `https://f-droid.org` in your browser and install the F-Droid app.
2. Open F-Droid, search **Termux**, install it.
3. Also install **Termux:Widget** if you want shortcuts (optional).

Termux gives you a Linux terminal on Android. Nothing is rooted; it lives in its
own sandbox.

### M2. Set it up

Open Termux and type each line, pressing Enter after each:

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs git openssh nano curl
```

`pkg` is Termux's installer. `openssh` lets you log into servers. `nano` is a
simple text editor.

Check Node.js is new enough:

```bash
node --version
```

Needs **v20.10.0 or higher**. If Termux gives you something older:
`pkg install nodejs-lts`.

Give Termux access to your phone's storage (so you can save files where other
apps see them):

```bash
termux-setup-storage
```

Tap **Allow**.

### M3. Clone the repository

```bash
cd ~
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
```

If the repository is private, GitHub will ask for a username and password —
use a **Personal Access Token** as the password (GitHub → Settings → Developer
settings → Personal access tokens).

### M4. Switch to the branch

```bash
git checkout arena/01a0e1df-obsidian-network
git branch --show-current
```

### M5. Build

```bash
npm --prefix obsidian-core ci
npm --prefix obsidian-core run build
```

This takes a few minutes on a phone. **Keep Termux in the foreground** or
Android may kill it. To prevent that, run `termux-wake-lock` first.

### M6. Run the tests

```bash
npm --prefix obsidian-core test
node scripts/check-invariants.mjs
```

### M7. Editing files

Inside Termux: `nano filename`. Save with **Ctrl+O**, Enter; exit with
**Ctrl+X**. Termux shows a row of special keys above the keyboard; if not,
swipe up on the keyboard area.

For comfortable editing, install **Acode** from F-Droid/Play Store. To open
Termux files in Acode, keep your work under `~/storage/shared/` or use Acode's
SFTP to connect to your VPS directly.

### M8. Create an environment file

```bash
cd ~/Obsidian-Network
cp .env.example .env
nano .env
```

Fill in your values. `.env` is gitignored — it will not be committed.

### M9. Generate keys

Node identity (for a node):

```bash
cd obsidian-core
node dist/index.js keygen --network devnet --data-dir ~/obs/n1
```

A wallet (offline):

```bash
node dist/index.js wallet new
```

Write the recovery phrase on **paper**. Not in a screenshot — screenshots sync
to cloud backups.

The Genesis Invitation:

```bash
cd ~/Obsidian-Network
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build
node scripts/new-genesis-invite.mjs
```

### M10. Multiple terminals

Swipe from the **left edge** of Termux → **New session**. You need three for a
three-node testnet, plus one for `curl`.

### M11. The whole testnet, from your phone

Follow §C exactly — it was written to work in Termux. Summary:

```bash
# session 1
cd ~/Obsidian-Network/obsidian-core
termux-wake-lock
export OBSIDIAN_KEYSTORE_PASSPHRASE='a-long-passphrase'
node dist/index.js start --network devnet --data-dir ~/obs/n1 \
  --rpc-port 38630 --p2p-port 38631 --mine

# session 2
cd ~/Obsidian-Network/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='a-long-passphrase'
node dist/index.js start --network devnet --data-dir ~/obs/n2 \
  --rpc-port 38640 --p2p-port 38641 --seeds 127.0.0.1:38631 --mine

# session 3
cd ~/Obsidian-Network/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='a-long-passphrase'
node dist/index.js start --network devnet --data-dir ~/obs/n3 \
  --rpc-port 38650 --p2p-port 38651 --seeds 127.0.0.1:38631,127.0.0.1:38641 --mine

# session 4 — check
curl -s localhost:38630/status
curl -s localhost:38630/peers
curl -s localhost:38630/pot
```

Then the interface:

```bash
cd ~/Obsidian-Network/obsidian-interface
OBSIDIAN_NODE_URLS=http://127.0.0.1:38630,http://127.0.0.1:38640 \
OBSIDIAN_INTERFACE_HOST=127.0.0.1 OBSIDIAN_INTERFACE_PORT=8788 \
OBSIDIAN_GENESIS_INVITE_HASH='<your hash>' \
node dist/server/main.js
```

Open `http://localhost:8788/` in your phone's browser. All twelve sites work.

### M12. Connect to a VPS from Android

```bash
ssh-keygen -t ed25519
ssh-copy-id user@your-server-ip
ssh user@your-server-ip
```

The first command makes a key pair; the second installs the public half on the
server; the third logs in. After that, no password.

### M13. Upload and download files

```bash
# phone -> server
scp releases/obsidian-node-operator-1.1.0.tar.gz user@server:/home/user/

# server -> phone
scp user@server:/home/user/node-key.json.backup ~/storage/shared/
```

`scp` is "secure copy", over the same SSH connection.

### M14. Monitor and restart from your phone

```bash
ssh user@server 'systemctl status obsidian-node'
ssh user@server 'journalctl -u obsidian-node -n 50'
ssh user@server 'sudo systemctl restart obsidian-node'
ssh user@server 'curl -s localhost:8630/status'
```

### M15. GitHub Codespaces (if your phone struggles)

Codespaces gives you a real Linux machine in a browser tab, free for a monthly
quota. On github.com, open the repository → **Code** → **Codespaces** → create
one on branch `arena/01a0e1df-obsidian-network`. Every command in this guide
works there, and it will not be killed by Android.

---

## N. Windows guide

### N1. Install

1. **Git** — `https://git-scm.com/download/win`. Accept the defaults; this also
   installs **Git Bash**, a terminal where the commands in this guide work
   unchanged.
2. **Node.js 22 LTS** — `https://nodejs.org`. Tick "Add to PATH".
3. **VS Code** (recommended) — `https://code.visualstudio.com`. A code editor
   with a built-in terminal.
4. **Windows Terminal** (optional) from the Microsoft Store.

> Use **Git Bash**, not Command Prompt or PowerShell. The `export VAR=value`
> syntax and the `for` loops in this guide are Bash syntax.

Verify:

```bash
node --version    # v20.10+ or v22
npm --version
git --version
```

### N2. GitHub authentication

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

When Git asks for credentials, use a **Personal Access Token** as the password,
not your GitHub password. Or install GitHub CLI (`https://cli.github.com`) and
run `gh auth login`.

### N3. Clone, branch, build, test

```bash
cd ~
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
git checkout arena/01a0e1df-obsidian-network

npm --prefix obsidian-core ci
npm --prefix obsidian-core run build
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build

npm --prefix obsidian-core test
npm --prefix obsidian-interface test
node --test cloudflare/test/worker.test.mjs
node --test tests/e2e/cluster.test.mjs
node scripts/check-invariants.mjs
```

### N4. Create a release

```bash
git status                      # must be clean
./scripts/package-releases.sh
cd releases && sha256sum -c SHA256SUMS
```

The script refuses a dirty tree on purpose, so the archives always match a
commit.

### N5. SSH to a VPS from Windows

Windows 10/11 include OpenSSH:

```bash
ssh-keygen -t ed25519
ssh-copy-id user@your-server-ip     # if missing, paste ~/.ssh/id_ed25519.pub manually
ssh user@your-server-ip
```

### N6. Deploy

```bash
scp releases/obsidian-node-operator-1.1.0.tar.gz user@server:/home/user/
ssh user@server
tar -xzf obsidian-node-operator-1.1.0.tar.gz
cd obsidian-core && npm ci --omit=dev
```

Then follow §D6–D8.

### N7. Frontend deployment

```bash
scp releases/obsidian-interface-selfhost-1.1.0.tar.gz user@server:/home/user/
ssh user@server
tar -xzf obsidian-interface-selfhost-1.1.0.tar.gz
cd obsidian-interface && npm ci --omit=dev
```

Set the environment variables from §F5 and run under systemd using
`obsidian-interface/deployment/systemd/obsidian-interface.service`.

### N8. Monitoring from Windows

```bash
ssh user@server 'journalctl -u obsidian-node -f'
curl -s https://rpc1.example.org/status
```

---

## O. Decision guide

| | **Local devnet** | **Private testnet** | **Public testnet** | **Mainnet** |
|---|---|---|---|---|
| **Purpose** | Learn the commands; see it work | Rehearse multi-machine operation | Real internet conditions, real strangers | The real economy |
| **Where** | Your phone/PC, one machine | 2–3 VPS you control | 3+ VPS, independent providers | 3+ VPS, independent **operators** |
| **Risk** | None | Very low | Low — no real value | **Permanent.** Mistakes are on-chain forever |
| **Nodes** | 1–3 | 2–3 | 3–5 | 3 minimum, more is better |
| **Access** | You | You | Anyone | Anyone |
| **Real OBS?** | No (devnet) | No | No (testnet prefix `tobs1`) | **Yes** |
| **Good for testing** | CLI, builds, RPC routes, wallet creation, Genesis Invitation flow, all 12 frontends | Peer discovery across real networks, firewalls, systemd, backups, restarts | NAT/DNS/TLS, Cloudflare, load, hostile traffic, node runner registration and scoring over real periods | Nothing. Mainnet is not a test |
| **Do NOT test here** | Multi-machine networking | Public exposure | Anything that needs real value | Everything — test it before |
| **Move on when** | You can start 3 nodes, see them peer, and all 12 sites return 200 | Nodes survive reboots and you can restore from backup | It has run for days without intervention, reward periods have settled, and you have practised a rollback | — |

---

## P. Master checklist

**Repository**
- [ ] `git status` clean
- [ ] On branch `arena/01a0e1df-obsidian-network`
- [ ] `git pull` done; commit id recorded: ________
- [ ] Dependencies installed with `npm ci`

**Build and tests**
- [ ] `obsidian-core` builds
- [ ] `obsidian-interface` builds (`wrote 12 site shells`)
- [ ] Core tests: 233 pass
- [ ] Interface tests: 151 pass
- [ ] Edge worker tests: 7 pass
- [ ] Cluster e2e: 13 pass
- [ ] `node scripts/check-invariants.mjs` → all 50 invariants hold

**Protocol**
- [ ] `/status` reports `protocolVersion: 1.1.0`
- [ ] PARAMS_HASH `5ed3d6409bd4e723f83f00469e976062` on **every** node
- [ ] `genesis init` deterministic across two machines
- [ ] Mainnet genesis id `20a787220fa49a2d8a41276b370705a16add75ba`
- [ ] Height 0 supply is 0; `invariantOk: true`

**Release**
- [ ] Tag created (`v1.1.0`) and pushed
- [ ] Archives built from the tag
- [ ] `sha256sum -c SHA256SUMS` → 11 OK
- [ ] `verify-release.sh ... --with-tests` passes
- [ ] Signatures — **NOT IMPLEMENTED**; gap acknowledged

**Wallet and access**
- [ ] Wallet created offline; recovery phrase on paper
- [ ] Private key never sent anywhere
- [ ] Genesis Invitation generated; plaintext offline
- [ ] `OBSIDIAN_GENESIS_INVITE_HASH` set on the interface only
- [ ] First registration tested; replay refused
- [ ] Member invites work and cap at 5

**Mining**
- [ ] `/mining/schedule` correct
- [ ] Claim inside 4 hours is rejected
- [ ] Registration credits 0 OBS

**Nodes**
- [ ] Node 1 running, own data dir, own key
- [ ] Node 2 running, independent host
- [ ] Node 3 running, independent host
- [ ] `/peers` non-empty in both directions
- [ ] Heights converge
- [ ] NTP synchronised on all hosts
- [ ] Keystore passphrase via file; `.pass` companions deleted
- [ ] `node-key.json` backed up

**Network**
- [ ] P2P port open; RPC not publicly exposed
- [ ] Firewall enabled; SSH key-only
- [ ] TLS valid on public endpoints
- [ ] DNS pointing at the right hosts
- [ ] Cloudflare configured as cache/gateway only
- [ ] **Cloudflare turned off as a test; consensus unaffected**

**Frontends**
- [ ] All 12 sites return 200
- [ ] `/api/rpc?path=/status` proxies correctly
- [ ] Explorer shows no wallet balances
- [ ] Account page shows the Genesis Invitation state

**Operations**
- [ ] systemd services enabled and surviving reboot
- [ ] Backups taken and a restore rehearsed
- [ ] Monitoring/alerting in place (manual polling is the documented option)
- [ ] `/audit/compliance`: all 16 removed features absent
- [ ] Rollback procedure practised

**Launch**
- [ ] Seed list published only after validation
- [ ] Genesis allocation observed, identical on every node
- [ ] Treasury designated on-chain
- [ ] Post-launch monitoring running

---

## What I should deploy first

An honest comparison, with the evidence.

### What the repository actually proves today

**Strong evidence:**
- **404 automated tests** pass: core 233, interface 151, edge 7, three-node
  cluster 13.
- **50 protocol invariants** hold, and the checker is proven to fail on drift.
- **CI is green across 7 jobs** on every push, including a **Docker job** that
  builds both images, runs a two-container stack, watches the chain height
  advance inside the container, and confirms stopping the interface does not
  stop consensus.
- **A mainnet node boots from the packaged release archive** with height 0,
  supply 0, `invariantOk: true`, and the correct genesis id.
- **Release archives** are reproducible and checksum-verified (11 OK).
- Removed features stay removed, asserted at runtime.

**Genuine gaps, stated plainly:**
1. **No release signing.** Checksums prove integrity, not authorship. For a
   public mainnet handling real value, this should be closed first.
2. **No monitoring stack.** No `/metrics`, no dashboards, no alerting. You would
   be polling RPC by hand — workable for a testnet, thin for mainnet.
3. **Nothing has ever run for more than minutes.** `docs/IMPLEMENTATION-REPORT.md`
   says so: no multi-day soak test, so memory growth over weeks is unknown, and
   **node reward settlement has never been observed over real 24-hour periods** —
   it is tested by invoking the block routine at a period boundary.
4. **Google OAuth has never been exercised against Google.** Token verification
   is tested against injected keys and a JWKS document.
5. **`main` is empty** and **no tags exist**. There is no released, tagged,
   immutable point to launch from yet.
6. **One operator.** Mainnet needs three independent operators; you currently
   have one person. This is organisational, not technical, and it is the
   hardest one to fix quickly.
7. **The genesis allocation is irreversible.** Once the first valid mining claim
   lands, 100,000 OBS exists and the treasury is fixed forever. Before that, a
   relaunch is free; after it, it is not.

### The recommendation

**Deploy in this order. Do not skip.**

**1. Local devnet, today, on your phone (§C + §M).**
Zero risk, and it teaches you every command. You will know it worked when three
nodes peer, heights converge, `/pot` reports `PROOF_OF_TIME`, and all twelve
sites return 200. *Evidence it will work:* the cluster e2e suite does exactly
this on every CI run.

**2. Private testnet on 2–3 cheap VPS (§D).**
This is where you learn the things a phone cannot teach: firewalls, systemd,
reboots, backups, restoring from a backup, clock discipline. *Do not skip the
restore rehearsal.* A backup you have never restored is a hope, not a backup.

**3. Public testnet, and leave it running for weeks (§D).**
This is the step that closes gaps 3 and 4. Let reward periods actually settle
over real days. Register a node, post heartbeats, collect attestations, watch a
payout. Exercise Google sign-in with a real client id. Watch memory over a
fortnight.

**4. Close the release-signing gap (§A12) and decide on monitoring (§D11)**
while the testnet runs.

**5. Recruit two more independent operators.** Mainnet's security argument is
that no single party defines the chain. With one operator that argument is
false, whatever the code does.

**6. Then, and only then, mainnet (§E).**

### What I would not do

**Do not launch mainnet this week.** Not because the code is bad — the evidence
above is unusually strong for a project this young — but because the genesis
allocation is a one-way door, the reward system has never completed a real
period, and three independent operators do not yet exist. None of those are
fixed by launching sooner.

**Do not deploy from `main`.** It is still at `459a6c1 Initial commit`. Deploying
it would ship an empty repository.

**Do not deploy mainnet from a branch.** `docs/mainnet-launch.md` §1.1 is
explicit: launch from a verified release archive.

---

## Related documents

| Document | What it covers |
|---|---|
| `docs/mainnet-launch.md` | The authoritative mainnet runbook |
| `docs/node-operator.md` | Running a node day to day |
| `docs/node-runner-rewards.md` | The 40/60 split and registration |
| `docs/proof-of-time.md` | The consensus rules |
| `docs/release-verification.md` | Verifying archives |
| `docs/self-hosting.md` | Running the interface |
| `docs/security-model.md` | Trust boundaries and honest limitations |
| `docs/api.md` | Every RPC route |
| `docs/transaction-format.md` | Signing without the interface |
| `SECURITY.md` | Reporting vulnerabilities |
| `CONTRIBUTING.md` | Changing the code |
| `CHANGELOG.md` | What changed, and what is consensus-breaking |
