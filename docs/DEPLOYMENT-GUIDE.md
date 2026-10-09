# Obsidian Network — the complete beginner's deployment guide

**Protocol 1.6.1 · written for someone with an Android phone and no prior coding experience.**

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
- [Branching model: why there is no `testnet` branch](#branching-model)
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
| **Branch** | A named line of development. Yours is `arena/414b663a-obsidian-network`. |
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
| **The delivery branch** (`arena/414b663a-obsidian-network`) | The branch this release was delivered on: the full source tree, the built release archives in `releases/`, and these docs. Clone from it to install (the launch guide's commands do) and start new work from it. | Local devnet, private testnet and rehearsals; **mainnet from the archives**. |
| **Default branch** | Whichever branch GitHub shows first (Settings → Branches); it is what a plain `git clone` checks out. GitHub refuses to delete the default branch, so if you want only the delivery branch to remain, **make it the default first**, then delete the others. | — |
| **Release branch** | A branch frozen for a release, e.g. `release/1.6.1`, that only receives fixes. Optional: this repository does not use one. | Optional; see §B. |
| **Git tag** | A permanent, immovable label on one exact commit, e.g. `v1.6.1`. Unlike a branch it never moves. The remote carries exactly one release tag, `v1.6.1`, on the commit the shipped archives were built from (§B6). | Tag first, then build the archive from the tag. |
| **Release archive** | The `.zip`/`.tar.gz` files in `releases/`, built by `scripts/package-releases.sh`, each listed in `SHA256SUMS`. This is what `docs/mainnet-launch.md` says to launch from. | **Mainnet. Always.** |
| **Deployed node** | A running `obsidian-core` process with a data directory. It is not code, it is a live thing holding chain state. | — |
| **Frontend deployment** | The static site folders (`landing/`, `mine/`, …) served by the interface, a static host, or Cloudflare Pages. | — |

**The rule from `docs/mainnet-launch.md` §1.1, quoted:** "Never launch from a
working copy. Launch from a signed release archive."

---

<a name="branching-model"></a>

## Branching model: why there is no `testnet` branch

A reasonable-sounding idea is to create one branch per network — `devnet`,
`testnet`, `staging`, `mainnet` — and deploy each branch to its matching
network. **Do not do this.** It is the single most common way a small team ends
up unable to answer "what code is actually running on mainnet?"

### Networks are chosen at runtime, not by branch

Every branch of this repository already contains **all four networks**:

```
obsidian-core/config/
├── devnet.json
├── testnet.json
├── staging.json
└── mainnet.json
```

You pick one when you start the node:

```bash
node dist/index.js start --network devnet
node dist/index.js start --network testnet
node dist/index.js start --network mainnet
node dist/index.js start --config config/mainnet.json   # equivalent, explicit
```

Each network is fully isolated by its own chain id, genesis, ports and address
prefix, so nodes on different networks physically cannot join each other:

| Network | Chain id | RPC | P2P | Address prefix | Block time |
|---|---|---|---|---|---|
| mainnet | 7777 | 8630 | 8631 | `obs1` | production |
| testnet | 7778 | 18630 | 18631 | `tobs1` | practice |
| staging | 7779 | 28630 | 28631 | `sobs1` | pre-production |
| devnet | 7780 | 38630 | 38631 | `dobs1` | 5 seconds |

The separation is enforced by **consensus**, not by which files you checked
out. A testnet node handed mainnet's genesis rejects it at the handshake.

### Why per-network branches actively cause harm

1. **They start identical and cannot stay identical.** Four copies of one tree
   drift the moment you commit to one of them. Now "testnet" and "mainnet" mean
   different code, and a fix applied to one silently misses the others.
2. **They hide the real question.** The thing you need to know before any
   deployment is *which commit is running*. A branch name cannot tell you that,
   because branches move. A tag and a commit id can.
3. **They invite merge accidents.** Merging `testnet` into `mainnet` to "promote
   a release" drags along every experiment that landed on testnet meanwhile.
4. **They contradict the launch rule.** `docs/mainnet-launch.md` §1.1: launch
   from a verified release archive, never a working copy — so a `mainnet`
   branch would not be what mainnet runs anyway.

### What to use instead

| You want | Use | Why |
|---|---|---|
| Run a different network | `--network <name>` | Already built in, isolated by consensus |
| A frozen, named version | **A tag** (`v1.6.1`) | Immutable; cannot drift |
| Something to deploy | **A release archive** from `releases/` | Checksummed, matches a commit |
| Ongoing work | This work branch | One place where change happens |
| A long-lived fix line | a `release/<line>` branch, only if needed | Optional; see §B |

The practical rule: **branches for work, tags for versions, flags for
networks.** Promotion from testnet to mainnet is not a merge — it is running
the same verified archive with a different `--network`.

### Per-network settings that genuinely differ

Things that vary per deployment belong in configuration and environment, not in
Git history:

- `obsidian-core/config/<network>.json` — `publicHost`, `seedNodes`, RPC binding
- `.env` (gitignored) — `OBSIDIAN_NODE_URLS`, `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE`,
  `OBSIDIAN_GENESIS_INVITE_HASH`

Two nodes on different networks should differ **only** in those, never in code.

### If you create the branches anyway

They are harmless as long as you treat them as **snapshots, not deployment
targets** — and they do fix one real problem: a branch pins one commit while
`main` moves. Paste this into a terminal (Termux on Android, Git
Bash on Windows — not PowerShell, the loop is Bash syntax):

```bash
cd ~/Obsidian-Network
git checkout arena/414b663a-obsidian-network
git pull origin arena/414b663a-obsidian-network

for b in main develop staging testnet devnet release/1.6.1; do
  git branch -f "$b" arena/414b663a-obsidian-network
  git push -u origin "$b"
done

git checkout arena/414b663a-obsidian-network   # back to the work branch
git branch -a
```

`git branch -f` moves the branch to your current commit, so re-running the loop
re-syncs them all. If `main` is protected on GitHub, that one push needs
`--force-with-lease` or a settings change.

Even then: **deploy from tags and archives, and select the network with
`--network`.**

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
arena/414b663a-obsidian-network
```

If it says anything else, switch:

```bash
git checkout arena/414b663a-obsidian-network
```

### A4. Pull the latest code

```bash
git pull origin arena/414b663a-obsidian-network
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

The interface build prints `wrote 9 site shells`. **Build the core first** —
the interface build compiles the core and copies a browser-safe subset out of
it, so it fails on a clean checkout if the core has not been built.

### A7. Run the project's actual tests

Several suites, plus the invariant check. Each must end with zero failures (the counts are in
the CI log and in the CHANGELOG's record of this release, not here, where they would go stale):

```bash
npm --prefix obsidian-core test                     # consensus, storage, p2p, rpc, security
npm --prefix obsidian-interface test                # accounts, wallet, pages, a live-node UI suite
node --test cloudflare/test/worker.test.mjs         # the edge gateway
node --test tests/e2e/cluster.test.mjs              # starts 3 real nodes
node --test tests/e2e/networks.test.mjs             # starts a node and an interface for each of the four networks
node --test tests/scripts/*.test.mjs                # signing, soak verdict, invitation, helper script, repo consistency
```

The cluster suite binds ports 39630–39635 and takes about a minute. **Do not run
two copies of it at once** — they fight over the ports and fail for no real
reason.

### A8. Run the invariant check

This asserts the economic and protocol constants — the 21,000,000 cap, the
mining schedule, the exact 90/10 ONS split, the 20,000 OBS validator bond, and
the absence of removed features.

```bash
node scripts/check-invariants.mjs
```

Expect one line of this form (N is however many invariants this release checks):

```
protocol 1.6.1: all N invariants hold.
```

Any other output means a consensus constant has changed. Stop.

### A9. Verify protocol 1.6.1 and PARAMS_HASH

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

- `"protocolVersion":"1.6.1"`
- `"paramsHash":"2dd76ca2b2305d725f3a975bfca04eb5"`

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
"genesisId": "56ec455d8afac5ef4f7d636ac03ef9e39bd5788f",
"genesisHash": "74e7dee44e8b579ac3048a716a480311bcd858b1740a1b6f99f1cda6b33dace3"
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
../scripts/verify-release.sh obsidian-core-1.6.1.tar.gz --with-tests
```

This checks the digest, extracts to a temporary folder (never over your work),
checks entry points, and runs the shipped tests. It **exits non-zero** if the
digest mismatches or the archive is not listed, so it is safe to use as a gate.

### A12. Signatures

**The tooling exists; no release is signed yet.**
`scripts/sign-release.sh` produces a detached GPG signature over `SHA256SUMS`
(re-checking every digest first, so an authentic signature can never cover a
stale list) and exports the public key. `scripts/verify-release.sh` verifies a
signature when one is present, with `gpg` or with `gpgv` alone, and prints
`UNSIGNED RELEASE` when there is none: a check that was not performed is never
reported as passed.

```bash
# the publisher, once, on a machine they control:
gpg --full-generate-key                 # ed25519, with a passphrase
./scripts/sign-release.sh               # or: ./scripts/sign-release.sh <KEYID>
```

**What is still needed before a mainnet launch:** the publisher must create the
key, sign the release and publish the fingerprint somewhere the archives are
not hosted. Until then checksums prove *integrity* (the file was not corrupted)
but not *authenticity* (that you produced it), and every release should be
treated as unsigned. See `docs/release-verification.md` §1b.

---

## B. How to move the branch to main

### B0. Should you?

This release was delivered on `arena/414b663a-obsidian-network`, and that branch is complete on its own: you
can keep it as your main line (make it the default branch in GitHub → Settings → Branches) and
skip this section. Merging into `main` is for people who keep `main` as their "accepted state"
branch.

**Not yet, if you do.** Merging to `main` does not deploy anything in this repository —
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
git checkout arena/414b663a-obsidian-network
git pull origin arena/414b663a-obsidian-network
git branch backup/pre-main-$(date +%Y%m%d)
git push origin backup/pre-main-$(date +%Y%m%d)
```

> Your working session is tied to `arena/414b663a-obsidian-network`. Creating a
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
git merge arena/414b663a-obsidian-network
```

**Expect no conflicts today.** `main` already contains the full tree (PR #1
merged the work branch). If you merge an older branch, take the branch being
merged in wherever the two disagree.

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
git reset --hard arena/414b663a-obsidian-network
git push --force-with-lease origin main
```

`--force-with-lease` refuses to overwrite if someone else pushed in the
meantime — always prefer it to plain `--force`. **Only do this while you are
the sole person working on the repository.**

### B5. Verify main contains exactly the intended code

Compare the file trees. If the two hashes match, the contents are byte-identical:

```bash
git rev-parse main^{tree}
git rev-parse arena/414b663a-obsidian-network^{tree}
```

And confirm nothing differs:

```bash
git diff main arena/414b663a-obsidian-network --stat
```

Empty output = identical.

### B6. Create the release tag

A tag is just a permanent label on one commit. **Tagging does not change any
files**, so the archives you build after tagging are byte-for-byte the archives
you would have built before tagging. The point of tagging first is that the
archives can then name an immutable commit instead of "whatever was checked out
that afternoon".

**Tag the commit you actually deploy.** `v1.6.1` exists on the remote and points
at the commit the shipped archives were built from; the next release tags its own
commit the same way.

```bash
cd ~/Obsidian-Network
git checkout arena/414b663a-obsidian-network
git pull origin arena/414b663a-obsidian-network
git status              # must print: nothing to commit, working tree clean
```

The clean tree matters: `scripts/package-releases.sh` **refuses to run on a
dirty tree** (unless you pass `--allow-dirty`), precisely so an archive always
corresponds to a real commit.

Confirm the version the tag is claiming. The script reads it from
`obsidian-core/package.json` and aborts if the interface disagrees:

```bash
node -p "require('./obsidian-core/package.json').version"     # -> 1.6.1
```

Create and push the tag:

```bash
git tag -a v1.6.1 -m "Obsidian Network 1.6.1 - protocol 1.6.1, committed finality bootstrap, ONS 90/10"
git push origin v1.6.1
```

`-a` makes an *annotated* tag, which records who made it and when. Verify it
landed on the commit you meant:

```bash
git show --stat v1.6.1 | head -5
git rev-parse v1.6.1^{commit}
git rev-parse arena/414b663a-obsidian-network
```

The last two commands must print the **same** commit id.

### B6b. Rebuild the archives from the tag

Because the tag points at the commit you are already standing on, you do **not**
need to check the tag out — and you should not, because `git checkout v1.6.1`
puts you in "detached HEAD", a state that confuses beginners and makes any
accidental commit hard to find. Just build where you are:

```bash
cd ~/Obsidian-Network
./scripts/package-releases.sh
```

**What this does, in order** (it is a release gate, not just a zip command):

1. Checks the core and interface versions match.
2. Refuses to continue if the working tree is dirty.
3. Records the commit id and a UTC build timestamp.
4. Builds both packages.
5. **Runs the test suites** - core, interface, edge worker, release verification
   and signing behaviour, and the three-node cluster end-to-end test - reading
   the counts back from the runs themselves.
6. Produces the archives with `git archive`, so what you download is exactly
   what was committed.
7. Writes `SHA256SUMS`, `MANIFEST.json`, and `RELEASE-NOTES-1.6.1.md`.

Expect it to take several minutes; the cluster test alone starts three real
nodes. It is the slow step on purpose.

**Useful flags:**

| Flag | Effect | When |
|---|---|---|
| `--skip-build` | Reuse the existing `dist/` | You just built, nothing changed |
| `--skip-e2e` | Skip the three-node cluster test | Never for a real release - the notes get stamped with a warning telling you to run it |
| `--allow-dirty` | Package an uncommitted tree | Experiments only. The archives then match no commit |

### B6c. Verify what you built

```bash
cd releases
sha256sum -c SHA256SUMS
```

Expect **11 lines, all ending `OK`**.

Confirm the manifest names the tagged commit:

```bash
grep -i commit MANIFEST.json
```

It must show the same id as `git rev-parse v1.6.1^{commit}`.

Then verify an archive the way a stranger would, including running its tests:

```bash
../scripts/verify-release.sh obsidian-core-1.6.1.tar.gz --with-tests
```

This exits non-zero on a digest mismatch or an unlisted archive, so it is safe
to use as a gate in a script.

Finally, read the generated notes:

```bash
head -20 RELEASE-NOTES-1.6.1.md
```

The test counts in there are **counted live during packaging**, not typed by
hand - so repackaging is also what corrects them if they ever drift.

### B6d. Commit the rebuilt archives

The archives changed, so the repository is now dirty again:

```bash
cd ~/Obsidian-Network
git status
git add releases
git commit -m "Rebuild 1.6.1 release archives from tag v1.6.1"
git push origin arena/414b663a-obsidian-network
```

> Note the ordering quirk: the tag labels the commit *before* the rebuilt
> archives are committed. That is normal and harmless - the archives are built
> from the tagged source tree, and `MANIFEST.json` records exactly which commit
> that was. An archive cannot contain itself.

### B6e. If you tagged the wrong commit

Tags are meant to be permanent, but nothing is published yet, so:

```bash
git tag -d v1.6.1                  # delete locally
git push origin :refs/tags/v1.6.1  # delete on GitHub
```

Then tag again. **Once other people have pulled a tag, never move it** - move a
tag and two people will have different code under the same name, which is the
exact failure the tag exists to prevent. Cut the next version instead.

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
git checkout arena/414b663a-obsidian-network
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

**Expected output.** The node logs one JSON object per line; these are the important ones (shortened,
with their timestamps removed):

```
{"level":"info","message":"chain ready","network":"devnet","chainId":7780,"height":0,"genesisId":"1e7ca102f6720a7682e9a396958f2a17330dc001"}
{"level":"info","message":"p2p listening","host":"0.0.0.0","port":38631}
{"level":"info","message":"rpc listening","host":"127.0.0.1","port":38630}
{"level":"info","message":"obsidian core ready","network":"devnet","rpc":"http://127.0.0.1:38630","mining":true}
{"level":"info","message":"produced block","height":1,"transactions":0}
```

Note the two addresses: **P2P listens on every interface** (peers must reach it) and **RPC listens on
127.0.0.1 only**, which is deliberate: the RPC is an operator control surface and is never exposed unless
you set `--rpc-host` yourself.

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

All three must print `2dd76ca2b2305d725f3a975bfca04eb5`.

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
curl -s -X POST http://localhost:38788/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"email":"yourname@gmail.com","password":"a-long-enough-pass-9"}'
# -> 403 ERR_GENESIS_INVITE_REQUIRED

# 2. With the correct invitation -> 200, account created
# 3. The same invitation again -> 403 ERR_GENESIS_INVITE_INVALID_OR_USED
```

Check status without revealing anything:

```bash
curl -s http://localhost:38788/api/auth/config
```

It reports `"genesisInvite":{"configured":true,"redeemed":false}` and never the
code or its hash.

> Sign-in is entirely first-party, so there is nothing external to configure
> and the whole flow is exercised by the automated tests:
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

Registering requires a signed transaction from the node identity and the reward
wallet, and no funds at all — see §I and `docs/node-runner-rewards.md`. It is
therefore testable immediately on a fresh devnet.

### C14. Start the interface and test frontends

```bash
cd ~/Obsidian-Network
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build
cd obsidian-interface
OBSIDIAN_NODE_URLS=http://127.0.0.1:38630,http://127.0.0.1:38640 \
OBSIDIAN_GENESIS_INVITE_HASH='<the hash from scripts/new-genesis-invite.mjs>' \
node dist/server/main.js --network devnet
```

`--network` is required: an interface serves exactly one network and refuses a node that follows another.
Devnet's interface listens on **38788** (mainnet 8788, testnet 18788, staging 28788) and on `127.0.0.1`
only, so it is reachable from this device and nowhere else.

Then check all nine sites answer:

```bash
for p in / /mine/ /wallet/ /explorer/ /ons/ /node/ /developer/ /app/ /audit/; do
  printf '%-14s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' http://localhost:38788$p)"
done
```

All nine must print `200`.

Test frontend-to-node communication (the interface proxies reads; the browser
never talks to a node directly):

```bash
curl -s 'http://localhost:38788/api/rpc?path=/status'
curl -s 'http://localhost:38788/api/rpc?path=/pot'
curl -s 'http://localhost:38788/api/rpc?path=/supply'
```

### C15. Test the explorer and API

Open `http://localhost:38788/explorer/` in your phone's browser. Per
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
git checkout arena/414b663a-obsidian-network
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
- `seedNodes` — the other nodes' `host:port` (P2P port), on the same network
- `rpcHost` — leave `127.0.0.1`

There is no reward address to set: Obsidian pays no block reward, and a node operator is paid through
the on-chain node registry (§I). A data directory written by another network is always refused, so
there is no switch for that either (`miningRewardAddress` and `strictDataDir` in older guides did
nothing and now only log a warning).

### D7. Node keys

Every network on a server has its own settings folder and its own key passphrase file. The commands
below are for **testnet**; [ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md) §7 has the same steps for
each of the four networks, written out separately.

```bash
sudo install -d -m 0750 -o root -g obsidian /etc/obsidian/testnet
sudo sh -c 'umask 037; head -c 18 /dev/urandom | base64 > /etc/obsidian/testnet/keystore.pass'
sudo chown root:obsidian /etc/obsidian/testnet/keystore.pass
```

The node creates its identity the first time it starts, under `/var/lib/obsidian/testnet/node/`.
Prefer `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE` over `OBSIDIAN_KEYSTORE_PASSPHRASE`: a passphrase in a
shell variable ends up in shell history and in process listings. (On **mainnet** you choose the
passphrase yourself: the node refuses to start with a generated one kept beside the key.)

Back up `node-key.json` and store its passphrase **separately**.

### D8. Run it as a service

The repository ships a systemd **template** unit: one instance per network, and the text after the
`@` is the network (it becomes `--network`, the settings folder and the data folder). systemd is
Linux's service manager: it starts the node at boot and restarts it if it dies.

```bash
sudo tee /etc/obsidian/testnet/node.env >/dev/null <<EOF
OBSIDIAN_KEYSTORE_PASSPHRASE_FILE=/etc/obsidian/testnet/keystore.pass
OBSIDIAN_RPC_HOST=127.0.0.1
OBSIDIAN_P2P_HOST=0.0.0.0
EOF
sudo install -m 0644 /opt/obsidian/obsidian-core/deployment/systemd/obsidian-node@.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now obsidian-node@testnet
sudo systemctl status obsidian-node@testnet
sudo journalctl -u obsidian-node@testnet -f     # live logs
```

The code lives in `/opt/obsidian/obsidian-core` (the node-operator archive extracted into
`/opt/obsidian`; see the Oracle guide §6). A typo in the instance name does not create a node: the
unit will not start for a network that has no settings folder.

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

- **Data directory**: `/var/lib/obsidian/<network>/node` (the template unit's own; one per
  network). This is the chain. Keep it on disk that survives a reboot.
- **Backups**: `docs/node-operator.md` §7 covers backup and restore. The
  irreplaceable file is `node-key.json`; chain data can be re-synced from peers,
  an identity cannot be regenerated.
- **Logs**: `journalctl -u obsidian-node@<network>`. Logs are JSON when `logJson` is true.

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

#### Prometheus

Every node serves `GET /metrics` in Prometheus text exposition
format (`text/plain; version=0.0.4`):

```bash
curl -s http://127.0.0.1:38630/metrics
```

Every sample is labelled `network` and `chain_id`, so one Prometheus can scrape
mainnet, testnet and devnet nodes without conflating them:

```
obsidian_chain_height{network="devnet",chain_id="7780"} 412
obsidian_peers{network="devnet",chain_id="7780"} 2
obsidian_supply_invariant_ok{network="devnet",chain_id="7780"} 1
```

Exposed: `obsidian_chain_height`, `obsidian_peers`,
`obsidian_mempool_transactions`, `obsidian_supply_obs`,
`obsidian_max_supply_obs`, `obsidian_pool_balance_obs`,
`obsidian_active_miners`, `obsidian_accounts_total`,
`obsidian_transactions_total`, `obsidian_mining_claims_total`,
`obsidian_names_total`, `obsidian_validators`,
`obsidian_genesis_allocation_claimed`, `obsidian_supply_invariant_ok`,
`obsidian_syncing`, `obsidian_uptime_seconds`.

Three alerts worth having on day one: `obsidian_chain_height` not increasing
over five minutes, `obsidian_peers == 0`, and `obsidian_supply_invariant_ok == 0`
(which should be impossible and means stop the node and investigate).

The route carries no address, no balance and no identity — it is tested for
that — but it is still part of the RPC surface, so keep it behind the same
firewall as the rest of the RPC port and scrape it from inside your network.
Supply figures are floats because Prometheus has no integer type; the exact
18-decimal seal amounts remain on `/supply`.

A ready scrape config, alert rules and dashboard ship with the node operator
archive under `obsidian-core/deployment/monitoring/`:

| File | What it is |
| --- | --- |
| `prometheus.yml` | scrape config, 15s interval, one job with a commented second target |
| `obsidian-alerts.yml` | eight rules: node down, chain stalled, node isolated, supply invariant false, finality stalled, syncing too long, mempool backlog, process restarted |
| `grafana-dashboard.json` | the dashboard — import it in Grafana and pick your Prometheus data source |

```bash
cp obsidian-core/deployment/monitoring/*.yml /etc/prometheus/
# Grafana → Dashboards → New → Import → upload grafana-dashboard.json
```

The dashboard has a `network` variable, so one Grafana serves mainnet,
testnet and devnet from the same Prometheus. A test asserts in both
directions that every metric the dashboard and the rules reference is actually
served, and that every metric served appears on a panel or in a rule — a
renamed metric fails the build instead of silently blanking a panel.

**Still not shipped:** real destinations and no recording rules.
`alertmanager.yml` ships with `CHANGE-ME` receiver placeholders, so
Alertmanager refuses to start until you supply a real one — a routing file that
silently delivers to `example.invalid` looks healthy and tells nobody anything.

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
| Genesis id | `56ec455d8afac5ef4f7d636ac03ef9e39bd5788f` |
| Genesis hash | `74e7dee44e8b579ac3048a716a480311bcd858b1740a1b6f99f1cda6b33dace3` |
| Protocol version | `1.6.1` |
| PARAMS_HASH | `2dd76ca2b2305d725f3a975bfca04eb5` |
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
../scripts/verify-release.sh obsidian-node-operator-1.6.1.tar.gz
../scripts/verify-release.sh obsidian-core-1.6.1.tar.gz --with-tests
```

The operator package ships `dist/` without tests, so `--with-tests` reports
"ships no self-contained test suite; skipping" there — verify the core archive too, which
ships its suite and runs it.

### E4. Three independent nodes

Same as §D2, but stricter: different operators, different hosting, ideally
different jurisdictions. Provision each per §D3–D8 with `--network mainnet`.

### E5. Start node 1, then 2 and 3

```bash
node dist/index.js start --config config/mainnet.json
```

Expect `height=0` and `genesisId=56ec455d8afac5ef4f7d636ac03ef9e39bd5788f`.

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
node scripts/check-invariants.mjs          # every invariant holds
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

Until that claim exists there is no treasury, and a `TREASURY` grant is refused
with a clear error rather than routed somewhere else.

### E11. Mining pool, node pool, the 90/10 split

- **Gas** (0.02%, capped at 0.01 OBS) goes to the **Mining Pool**, whole. It is
  never counted as ONS revenue.
- **ONS revenue** (name registration and renewal — the protocol's only revenue)
  splits **90% to the node runner pool, 10% to the treasury**, inside the state
  transition.

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

There are **nine**, from `obsidian-interface/scripts/build-sites.mjs`. They
are **generated by the build**, not hand-written HTML: the source is
`obsidian-interface/web/src/pages/<name>.ts` and the build writes a folder at
the repository root.

**All nine share the same deployment model.** Each is a static folder (HTML +
shared JS bundles + CSS) that needs the interface server for its `/api/` calls.
None of them is a separate app with its own build command.

| # | Site | Directory | Entry point (source) | What it does | Needs backend? |
|---|---|---|---|---|---|
| 1 | Landing | `landing/` → served at `/` | `web/src/pages/landing.ts` | Project description. Only three CTAs: Start Mining, Create Wallet, Explorer. | No (static) |
| 2 | Mine | `mine/` | `web/src/pages/mine.ts` | Mining claims and schedule | Yes |
| 3 | Wallet | `wallet/` | `web/src/pages/wallet.ts` | Non-custodial wallet, client-side signing | Yes (reads) |
| 4 | Explorer | `explorer/` | `web/src/pages/explorer.ts` | Blocks and transactions. **Never wallet balances.** | Yes |
| 5 | ONS | `ons/` | `web/src/pages/ons.ts` | `.obs` names | Yes |
| 6 | Developer | `developer/` | `web/src/pages/developer.ts` | API docs for developers | Yes |
| 7 | Node | `node/` | `web/src/pages/node.ts` | Node runner rewards, registry, scores | Yes |
| 8 | App | `app/` | `web/src/pages/app.ts` | Sign-in, invites, **Genesis Invitation**, wallet linking | Yes |
| 9 | Audit | `audit/` | `web/src/pages/audit.ts` | Compliance and decentralisation audit | Yes |

### F1. One build command for all of them

```bash
npm --prefix obsidian-interface run build
```

This runs, in order: build the core → sync browser-safe modules → bundle the
web JS → check nothing browser-unsafe leaked in → write the 9 site shells →
compile the server.

### F2. What must be deployed

- The nine site folders
- `obsidian-interface/public/` (CSS, assets, logo)
- `obsidian-interface/web/core/` (browser-safe core modules)
- `obsidian-interface/dist/` (the server), unless you are hosting statics only

The ready-made bundle of exactly this is the release archive
`obsidian-interface-selfhost-1.6.1.tar.gz`.

### F3. Where they should live

**Recommended: the interface server itself** (`node dist/server/main.js`). It
serves all nine and provides the `/api/` routes they need. This is the
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

A read that carries a query can be written either way — the whole read
percent-encoded, or the parameters beside `path`:

```bash
curl -s 'http://localhost:38788/api/rpc?path=%2Fnames%3Fprefix%3Dobs'
curl -s 'http://localhost:38788/api/rpc?path=/names&prefix=obs'
```

Both are the same read. Parameters written beside `path` are folded onto it in
the order given; **none is ever silently dropped**, because a dropped filter
returns an honest-looking 200 for a question nobody asked. Anything other than
the allowlisted routes — with or without a query — is refused with
`ERR_REJECTED`.

They never contain a node address. The interface decides which node to read,
health-checks them, and fails over.

### F5. Configuration

The frontends themselves need no environment variables. The **interface** does:

| Variable | Meaning |
|---|---|
| `OBSIDIAN_NODE_URLS` | Comma-separated node RPC URLs (use 2+) |
| `OBSIDIAN_INTERFACE_HOST` | Bind address; default `127.0.0.1` (`0.0.0.0` to accept outside traffic, and only behind HTTPS if the wallet is to work) |
| `OBSIDIAN_INTERFACE_NETWORK` | **Required** (or `--network`): `mainnet`, `testnet`, `staging` or `devnet`. There is no default |
| `OBSIDIAN_INTERFACE_PORT` | Port; default is the network's own: mainnet 8788, testnet 18788, staging 28788, devnet 38788 |
| `OBSIDIAN_INTERFACE_DATA_DIR` | Where the account list is stored |
| `OBSIDIAN_GENESIS_INVITE_HASH` | Hash of the single-use Genesis Invitation |
| `OBSIDIAN_INTERFACE_ALLOWED_ORIGINS` | Origins allowed to call the API with cookies (exact, or `https://*.example.org`); empty = same-origin only. Pages on `obsmainnet.us.ci` and its subdomains may always read chain data without cookies; see [trusted-domains.md](trusted-domains.md) |
| `OBSIDIAN_INTERFACE_TRUST_PROXY` | `true` only behind a TLS proxy you control |
| `OBSIDIAN_INTERFACE_MAX_INVITES` | Invites per account (protocol default 5) |

### F6. Test locally, deploy, update

Locally: §C14. Deploy: copy the selfhost archive, set the environment, run
`node dist/server/main.js` under systemd
(`obsidian-interface/deployment/systemd/obsidian-interface@.service`, one instance per network). Update:
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

You receive an **address** and **public key** (safe to share), a
**derivation path**, and a **24-word recovery phrase** (never share). The CLI
prints the phrase rather than a raw private key because the phrase is the
master secret the signing key is derived from — see §G6 for the exact output.

### G3. What must never touch the server

- The private key
- The recovery phrase
- Any passphrase protecting them

Not in an API call, not in a log, not in analytics, not in browser storage you
sync to a cloud. The account store on the server holds the wallet *address* and *public key* only. They are
what the platform checks a mining claim against: a claim is relayed only for a signed-in,
MFA-confirmed account, and only when it is signed by the wallet linked to that account. The
address grants no spending power.

**One wallet per account, and one account per wallet.** The wallet is a key the user makes on
their own device; it is never derived from the account (email, password or id). It is linked by
signing a challenge issued by the platform, which proves the device holds the key, and the link is
permanent: a second, different wallet is refused (`ERR_WALLET_LOCKED`) and so is a wallet already
linked to another account (`ERR_WALLET_TAKEN`). Whether a claim is *due* is not the platform's
decision: consensus decides it from the account's last claim, and the platform adds no cooldown.
Operator notes: an unproven address left by an earlier version counts as unlinked until its owner
signs; a wallet that claimed on chain before this rule, with no account, can be linked by the first
account that proves its key; claims submitted straight to a node bypass the platform; and an
account whose wallet is lost cannot mine again, so users must keep their 24 words.

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

### G6. Create a mainnet wallet on Termux, step by step

You can do this **today**, with no nodes running anywhere. A wallet is a key
pair, and generating a key pair is pure local mathematics — it does not touch
the network, and the chain does not need to know your address exists. An
address only becomes visible on-chain the first time it receives OBS.

Type each block into Termux and press Enter.

**1. Install the tools** (skip anything already installed):

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs git
node --version        # must be v20.10.0 or higher
```

**2. Get the code:**

```bash
cd ~
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
git checkout arena/414b663a-obsidian-network
```

**3. Build the core** (a few minutes on a phone):

```bash
termux-wake-lock
npm --prefix obsidian-core ci
npm --prefix obsidian-core run build
```

`termux-wake-lock` stops Android killing the build when the screen sleeps.

**4. Go offline.** Optional, and the paranoid-but-correct choice. Turn on
aeroplane mode. Key generation needs no network, so doing it offline removes
any doubt.

**5. Create the wallet:**

```bash
cd ~/Obsidian-Network/obsidian-core
node dist/index.js wallet new --network mainnet
```

**What you get** (example — never use this one, it is published in this guide):

```json
{
  "address": "obs1aywmjf2h7a83k2tzgxxjeca8az5uhkaac6nnhf",
  "publicKey": "0360f245b442d571d1568a2ab1a8712f069db4e6afc5553ce4d2bc3a2c8a824a39",
  "derivationPath": "m/44'/7777'/0'/0/0",
  "recoveryPhrase": "cable burger draft tiny talk shop like select nasty spring ticket stadium debate library custom valid manage surround buffalo suffer verb region abstract gasp",
  "warning": "This output is printed once and is NOT stored. ..."
}
```

| Field | Meaning | Share it? |
|---|---|---|
| `address` | Your mainnet address. `obs1` = mainnet | **Yes**, freely |
| `publicKey` | Derived from the key; proves signatures | Yes, harmless |
| `derivationPath` | `7777` is the mainnet chain id | Yes |
| `recoveryPhrase` | **24 words = the wallet itself** | **NEVER** |

The command prints a recovery phrase rather than a raw private key because the
phrase *is* the master secret — the signing key is derived from it along the
derivation path. Anyone who reads those 24 words owns the wallet, permanently
and irreversibly.

**6. Write the 24 words on paper.** Now, before closing Termux.

The output is printed **once** and stored nowhere. Close the terminal without
copying it and the wallet is gone — there is no recovery, no support desk, and
no administrator who can help. That is what "non-custodial" costs.

Do **not**: screenshot it (screenshots sync to Google Photos), paste it into
Notes/WhatsApp/email, save it in a file on the phone, or type it into any
website. Do: write it on paper, twice, check the spelling word by word, and
store the copies in two different physical places.

**7. Verify you copied it correctly** by generating a second throwaway wallet
and comparing the *format* — 24 lowercase words, spaces only. Then clear the
scrollback so the phrase is not sitting in Termux's buffer:

```bash
clear && printf '\033[3J'
```

**8. Turn networking back on.** Done. The wallet exists, needs no node, and
will be waiting whenever mainnet launches.

### G7. See the wallet interface with no nodes running

The wallet frontend also works offline, because signing is client-side. What
fails is only *chain reads* — which is exactly the right behaviour, and worth
seeing once.

```bash
cd ~/Obsidian-Network
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build

cd obsidian-interface
OBSIDIAN_NODE_URLS=http://127.0.0.1:38630 \
OBSIDIAN_INTERFACE_DATA_DIR=$HOME/obs/iface \
node dist/server/main.js --network devnet
```

Open **`http://localhost:38788/wallet/`** in your phone's browser. Keep Termux
running in the background; stop the server later with **Ctrl+C**.

Expect the page to **load normally (HTTP 200)** while balance and history show
an error. Check what the error actually is:

```bash
curl -s 'http://localhost:38788/api/rpc?path=/status'
```

```json
{"error":"no healthy Obsidian node: http://127.0.0.1:8630: fetch failed",
 "code":"ERR_NO_HEALTHY_NODE"}
```

**This is the correct result, not a bug.** It demonstrates the trust hierarchy
in §J: the interface refuses to invent chain data when it cannot reach a node.
It does not serve a cached balance, guess, or fall back to a database. No node,
no answer.

To see the wallet interface with live data, start a devnet node first (§C3),
point `OBSIDIAN_NODE_URLS` at `http://127.0.0.1:38630`, and use a `dobs1`
devnet address — a mainnet `obs1` address will not resolve on devnet, by
design.

### G8. Wallet safety rules

- The address is public. The 24 words are the wallet. There is nothing in
  between.
- No one legitimate will ever ask for your recovery phrase — not this project,
  not a node operator, not "support". Anyone who asks is stealing from you.
- Never type the phrase into a website. The official wallet never asks you to.
- Generate mainnet wallets offline where you can.
- A wallet holding real value should not live on a phone you also use for
  everything else.
- **The example wallet printed above is compromised by publication.** It exists
  to show the output shape. Never send anything to it.

## H. Mining registration

### H1. Two layers, and which is which

| Layer | What it controls | Who enforces |
|---|---|---|
| **Application** | Who may use *this interface deployment*: Gmail + password sign-in, MFA, invite codes, the Genesis Invitation, sessions | The interface server |
| **Consensus** | Who may mine, how much, how often, and the supply cap | Every node, independently |

The application layer cannot create OBS, change a claim, or make anyone
eligible. Deleting the interface's account file costs access, not money.

### H2. Sign-in

First-party, in four steps: a **Gmail address**, a **password**, an **invite
code**, then **TOTP multi-factor**. No third party decides who may hold an Obsidian
mining account, and the interface cannot be locked out by someone else's token
service.

- The address is **canonicalised server-side** (`server/identity.ts`): dots and
  `+tags` are stripped and `googlemail.com` folds into `gmail.com`, so
  `john.smith+mining@googlemail.com` and `johnsmith@gmail.com` are **one**
  mining account. The page is never asked whether an address is unique; the
  store rejects a clash with no `await` between the check and the insert, so a
  race cannot produce two accounts for one inbox.
- Passwords are at least 12 characters with letters and digits, stored only as
  salted scrypt hashes (N=32768). **There is no password reset and no email
  verification** — an email channel would make the mail provider an authority
  over mining accounts, and no email is ever sent.
- **Ten single-use recovery codes** (`OBS-RECOVERY-XXXX-XXXX-XXXX`) are issued
  at registration and shown exactly once, with the page refusing to move on
  until the user confirms they have written them down. Only scrypt hashes are
  kept, so no operator can recover them. They are the only route back into an
  account, and a used code is removed the moment it matches.
- **MFA is required before mining opens** on an account: RFC 6238 TOTP, SHA-1,
  6 digits, 30-second steps, ±1 step of tolerance, with the consumed step
  recorded so a code cannot be replayed against the login route.
- No client-supplied flag is trusted. A request asserting `mfaEnabled`,
  `miningEnabled` or an `accountId` is treated as noise; `tests/server.test.ts`
  asserts it.

Account creation remains disabled on a deployment that has no Genesis
Invitation configured, and the wallet, miner and explorer keep working with no
account at all.

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
3. **Install**: clone and build, or use `obsidian-node-operator-1.6.1.tar.gz`
   (built `dist/`, deployment recipes, docs, `verify-release.sh`,
   `check-invariants.mjs`).
4. **Keys**: `node dist/index.js keygen`. Set
   `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE`. Back up `node-key.json`.
5. **Configure**: `config/mainnet.json`, set `publicHost` and `seedNodes`. Keep `rpcHost` on
   loopback. (There is no reward address and no `strictDataDir` switch: see §D6.)
6. **Firewall**: open the P2P port only.
7. **Run**: the systemd unit; `journalctl -u obsidian-node -f` for logs.
8. **Backups**: `docs/node-operator.md` §7.
9. **Updates**: §8 of the same document.

### Earning the 90% share

From `docs/node-runner-rewards.md`:

- **Register** with a `NODE_REGISTRY` transaction: a signed identity, a reward
  wallet and no deposit. The only bond in the protocol is the validator's.
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
- **Static assets** — served by the interface behind the gateway; every path is forwarded to
  `OBSIDIAN_ORIGIN`, so there is no separate asset origin and no KV namespace to create
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
`FINALIZED_ANCHOR_THEN_FIXED_POT_WEIGHT_THEN_HEIGHT_THEN_LOWEST_HASH`.

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
curl -s http://localhost:38788/api/auth/config
```
If `genesisInvite.redeemed` is `true`, it is spent permanently — by design, and
it cannot be revived by restarting with a new hash. Later accounts use member
invites. If the deployment was never meant to be bootstrapped yet, you are
looking at a different data directory than you think.

`ERR_GENESIS_INVITE_NOT_CONFIGURED` means `OBSIDIAN_GENESIS_INVITE_HASH` is
unset — registration is closed until you set it.

### Frontend cannot reach the API

```bash
curl -s -o /dev/null -w '%{http_code}' http://localhost:38788/
curl -s 'http://localhost:38788/api/rpc?path=/status'
curl -s http://localhost:38788/api/nodes
```
**Cause:** the interface is down, or every configured node is unhealthy.
**Fix:** check `OBSIDIAN_NODE_URLS` points at reachable nodes; the interface
health-checks and fails over, but cannot invent a healthy node.

### CORS error

**Symptom:** the browser console reports a blocked cross-origin request.
**Cause:** the frontend is on a different origin than the interface.
**Fix:** set `OBSIDIAN_INTERFACE_ALLOWED_ORIGINS` to the exact origin (or a
`https://*.example.org` pattern), or serve the frontends from the same origin (the
supported arrangement). A page on `obsmainnet.us.ci` or any of its subdomains needs
nothing: it is trusted to read the chain by default. A node refuses an origin it
does not know with `403 origin not allowed`; add it to `OBSIDIAN_RPC_CORS_ORIGINS`.
See [trusted-domains.md](trusted-domains.md).

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
attesters, a registration that has been deregistered, or a wallet change that
takes effect next period.
**Fix:** check the score breakdown on `/node/` and fix the weakest component.

### A validator was slashed

```bash
curl -s localhost:8630/validators | jq .slashing, .appliedSlashes
```

**Cause:** this is not a fault of your node's connectivity. A slash requires
evidence that the validator key signed two conflicting block proposals for one
height and round, or two conflicting finality votes for one anchor. Being
offline, restarting or losing the network **cannot** produce a slash — that is
the missed-slot jail, which costs turns and pays nothing.
**Effect:** the validator left the rotation and the finality committee at the
height the evidence was applied, half the bond (10,000 of 20,000 OBS) is in the
Mining Pool, and the remaining half is claimable after the ordinary unbonding
delay. Re-registering needs a fresh full 20,000 OBS bond.
**Fix:** secure the validator key — the same key has signed conflicting
statements, so either the operator ran two nodes with one key or the key is
compromised. Claim the remainder after unbonding and re-register with new keys.

### State corruption

```bash
node dist/index.js validate --network mainnet --data-dir /var/lib/obsidian/mainnet/node   # stop the node first
```
**Fix:** restore from backup, or delete the data directory and re-sync from
peers. The chain is replicated; only `node-key.json` is irreplaceable.

### Server restart

With systemd the node restarts automatically. Confirm:
```bash
sudo systemctl status obsidian-node@mainnet
curl -s localhost:8630/status
```

### Disk full

```bash
df -h
du -sh /var/lib/obsidian/*
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

> The full, verified walkthrough — release archives, devnet, the interface, the
> wallet fix and the reset procedure — is `docs/DEVNET-TERMUX-RUNBOOK.md`. This
> section is the shorter reference for working on the repository itself.

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
git checkout arena/414b663a-obsidian-network
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
three-node devnet, plus one for `curl`.

### M11. The whole devnet, from your phone

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
OBSIDIAN_GENESIS_INVITE_HASH='<your hash>' \
node dist/server/main.js --network devnet
```

Open `http://localhost:38788/` in your phone's browser. All nine sites work.

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
scp releases/obsidian-node-operator-1.6.1.tar.gz user@server:/home/user/

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
one on branch `arena/414b663a-obsidian-network`. Every command in this guide
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
git checkout arena/414b663a-obsidian-network

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
scp releases/obsidian-node-operator-1.6.1.tar.gz user@server:/home/user/
ssh user@server
tar -xzf obsidian-node-operator-1.6.1.tar.gz
cd obsidian-core && npm ci --omit=dev
```

Then follow §D6–D8.

### N7. Frontend deployment

```bash
scp releases/obsidian-interface-selfhost-1.6.1.tar.gz user@server:/home/user/
ssh user@server
tar -xzf obsidian-interface-selfhost-1.6.1.tar.gz
cd obsidian-interface && npm ci --omit=dev
```

Set the environment variables from §F5 and run under systemd using
`obsidian-interface/deployment/systemd/obsidian-interface@.service` (one instance per network:
`obsidian-interface@testnet`, …).

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
| **Good for testing** | CLI, builds, RPC routes, wallet creation, Genesis Invitation flow, all nine frontends | Peer discovery across real networks, firewalls, systemd, backups, restarts | NAT/DNS/TLS, Cloudflare, load, hostile traffic, node runner registration and scoring over real periods | Nothing. Mainnet is not a test |
| **Do NOT test here** | Multi-machine networking | Public exposure | Anything that needs real value | Everything — test it before |
| **Move on when** | You can start 3 nodes, see them peer, and all 9 sites return 200 | Nodes survive reboots and you can restore from backup | It has run for days without intervention, reward periods have settled, and you have practised a rollback | — |

---

## P. Master checklist

**Repository**
- [ ] `git status` clean
- [ ] On branch `arena/414b663a-obsidian-network`
- [ ] `git pull` done; commit id recorded: ________
- [ ] Dependencies installed with `npm ci`

**Build and tests**
- [ ] `obsidian-core` builds
- [ ] `obsidian-interface` builds (`wrote 9 site shells`)
- [ ] Core tests: all pass
- [ ] Interface tests: all pass
- [ ] Edge worker tests: all pass
- [ ] Script tests (soak verdict, signing, helper, repo consistency): all pass
- [ ] Cluster e2e and four-network e2e: all pass
- [ ] `node scripts/check-invariants.mjs` → every invariant holds

**Protocol**
- [ ] `/status` reports `protocolVersion: 1.6.1`
- [ ] PARAMS_HASH `2dd76ca2b2305d725f3a975bfca04eb5` on **every** node
- [ ] `genesis init` deterministic across two machines
- [ ] Mainnet genesis id `56ec455d8afac5ef4f7d636ac03ef9e39bd5788f`
- [ ] Height 0 supply is 0; `invariantOk: true`

**Release**
- [ ] Tag created (e.g. `v1.6.1`) and pushed
- [ ] Archives built from the tag
- [ ] `sha256sum -c SHA256SUMS` → 11 OK
- [ ] `verify-release.sh ... --with-tests` passes
- [ ] Signatures — tooling ships (`scripts/sign-release.sh`); releases are **UNSIGNED** until a key is created and publication-ready

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
- [ ] All 9 sites return 200
- [ ] `/api/rpc?path=/status` proxies correctly
- [ ] Explorer shows no wallet balances
- [ ] Account page shows the Genesis Invitation state

**Operations**
- [ ] systemd services enabled and surviving reboot
- [ ] Backups taken and a restore rehearsed
- [ ] Monitoring/alerting in place (scrape config, rules, dashboard and routing ship under `deployment/monitoring/`; fill in real receivers)
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
- **The full automated suite passes** — core, interface, edge worker, release
  signing and verification, soak verdict rules, the genesis invitation
  generator, repository consistency, the three-node cluster, the four-network
  isolation suite and the interface-to-node ecosystem suite. The gate in
  `.github/workflows/ci.yml` runs them on every push and prints the counts
  itself, so no count here can go stale.
- **Every protocol invariant holds** (`node scripts/check-invariants.mjs`), and
  the checker is proven to fail on drift.
- **CI runs the whole gate on every push**, including a **Docker job** that
  builds both images, runs a two-container stack, watches the chain height
  advance inside the container, and confirms stopping the interface does not
  stop consensus.
- **A mainnet node started from this build** reports height 0, supply 0,
  `invariantOk: true` and the 1.6.1 genesis id, and refuses a substituted
  bootstrap committee.
- **Release archives** are reproducible and checksum-verified (11 OK).
- Removed features stay removed, asserted at runtime.

**Genuine gaps, stated plainly:**
1. **Releases are not signed yet — the tooling is, the key is not.**
   Checksums prove integrity, not authorship. `scripts/sign-release.sh` signs
   `SHA256SUMS` (re-checking every digest first, so an authentic signature can
   never cover a stale list), exports the public key and prints the
   fingerprint; `verify-release.sh` checks a signature when one is present and
   prints `UNSIGNED RELEASE` when it is not. No key is generated by this
   project, by CI or by any automation — a release key that something other
   than its owner can use signs nothing worth checking. **Until the publisher
   creates a key and runs that script, every release here is unsigned and
   should be treated as such.** See `docs/release-verification.md` §1b.
2. **Monitoring ships; your destinations do not.** `/metrics`, a scrape config,
   alert rules, a Grafana dashboard and an Alertmanager routing file under
   `deployment/monitoring/`. The
   routing ships with `CHANGE-ME` placeholders for every receiver, so
   Alertmanager refuses to start until you supply a real destination — a
   routing file that silently delivers to `example.invalid` looks healthy and
   tells nobody anything. On-call escalation is still yours to arrange.
3. **Nothing has been soaked for days.** `scripts/soak.mjs` records height,
   peers, mempool, supply, the invariant and RSS to a CSV and fails on a
   stalled chain, a false invariant or sustained memory growth — see
   `docs/soak-testing.md`. The longest run recorded in this repository is
   44.5 minutes — 90 samples, 12.01 blocks/min, invariant held on every
   sample, RSS down 1.7% across the second half — single node, no transaction
   load, on a 2-core sandbox. That is a smoke test, not a soak: no multi-day run
   exists, so memory growth over weeks is unknown, and
   **node reward settlement has never been observed over real 24-hour periods** —
   it is tested by invoking the block routine at a period boundary.
4. **Sign-in has never run at scale with real users.** The Gmail/password/MFA
   flow is covered end-to-end over real HTTP, including canonical-address
   dedupe, TOTP replay and recovery-code reuse, but it has not met a crowd.
5. **No launch has run from a tagged release.** `v1.6.1` is the first tag this
   repository has ever carried, and no mainnet has been started from it — or from
   anything before it.
6. **One operator.** Mainnet needs three independent operators; you currently
   have one person. This is organisational, not technical, and it is the
   hardest one to fix quickly.
7. **The genesis allocation is operationally consequential.** The canonical
   chain's first valid mining claim creates 100,000 OBS and selects treasury.
   Permitted reorgs replay that rule, so confirmation depth is advisory rather
   than mathematical finality. Before public launch, a relaunch is free; after
   users rely on the chain, it is not.

### The recommendation

**Deploy in this order. Do not skip.**

**1. Local devnet, today, on your phone (§C + §M).**
Zero risk, and it teaches you every command. You will know it worked when three
nodes peer, heights converge, `/pot` reports `PROOF_OF_TIME`, and all nine
sites return 200. *Evidence it will work:* the cluster e2e suite does exactly
this on every CI run.

**2. Private testnet on 2–3 cheap VPS (§D).**
This is where you learn the things a phone cannot teach: firewalls, systemd,
reboots, backups, restoring from a backup, clock discipline. *Do not skip the
restore rehearsal.* A backup you have never restored is a hope, not a backup.

**3. Public testnet, and leave it running for weeks (§D).**
This is the step that closes gaps 3 and 4. Let reward periods actually settle
over real days. Register a node, post heartbeats, collect attestations, watch a
payout. Put the sign-in and recovery flow in front of real users. Watch memory over a
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

**Do not deploy from `main`.** It now carries the full tree, but it moves;
deploy from a verified, tagged release archive (`docs/mainnet-launch.md` §1.1).

**Do not deploy mainnet from a branch.** `docs/mainnet-launch.md` §1.1 is
explicit: launch from a verified release archive.

---

## Related documents

| Document | What it covers |
|---|---|
| `docs/mainnet-launch.md` | The authoritative mainnet runbook |
| `docs/ORACLE-VPS-DEPLOYMENT.md` | Free Oracle Cloud server, domain and HTTPS, step by step |
| `docs/node-operator.md` | Running a node day to day |
| `docs/node-runner-rewards.md` | The 90/10 ONS split and registration |
| `docs/proof-of-time.md` | The consensus rules |
| `docs/release-verification.md` | Verifying archives |
| `docs/self-hosting.md` | Running the interface |
| `docs/security-model.md` | Trust boundaries and honest limitations |
| `docs/api.md` | Every RPC route |
| `docs/transaction-format.md` | Signing without the interface |
| `SECURITY.md` | Reporting vulnerabilities |
| `CONTRIBUTING.md` | Changing the code |
| `CHANGELOG.md` | What changed, and what is consensus-breaking |
