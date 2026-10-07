# Launch guide — run Obsidian Network 1.6.0

This is the one document to follow to get a network running, on an Android phone (Termux) or
on any Linux machine. It covers, in this order:

1. Installing the release (once).
2. **Devnet** — its own section, its own commands.
3. **Testnet** — its own section, its own commands.
4. **Staging** — its own section, its own commands.
5. **Mainnet** — its own section, its own commands.
6. The interface: ports, what it serves, how it is reached.
7. Hosting on a server (Oracle Cloud, free and paid).
8. Upgrading, backing up and troubleshooting.

**Only want the commands, for a phone?** [TERMUX-QUICKSTART.md](TERMUX-QUICKSTART.md) is this guide boiled down to
what you paste: set up once, then one section per network, then what to do when something does not work. It
also explains why nothing in it is `export`ed, and `doctor`, a command that tells you what is wrong.

The four network sections never share a command. You run one network by following its section
and nothing else; the networks are separate chains that happen to share a code base.

Companion documents: [DEVNET-TERMUX-RUNBOOK.md](DEVNET-TERMUX-RUNBOOK.md) (a longer devnet
walk-through that exercises the whole platform), [ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md)
(servers), [node-operator.md](node-operator.md) (day-to-day operation),
[mainnet-launch.md](mainnet-launch.md) (the mainnet runbook).

---

## 0. What keeps the networks apart

Four chains, each with its own genesis, its own ports, its own data and its own accounts:

| Network | Chain id | Address prefix | Node RPC | Node P2P | Interface |
| --- | --- | --- | --- | --- | --- |
| mainnet | 7777 | `obs1` | 8630 | 8631 | 8788 |
| testnet | 7778 | `tobs1` | 18630 | 18631 | 18788 |
| staging | 7779 | `sobs1` | 28630 | 28631 | 28788 |
| devnet | 7780 | `dobs1` | 38630 | 38631 | 38788 |

What stops a mistake from becoming a mixed-up network:

* **There is no default network.** `node dist/index.js start` without `--network` refuses to
  run (it used to default to mainnet, which is how someone eventually starts the wrong chain).
* **A data directory remembers its network.** A node pointed at a directory another network
  wrote refuses to start rather than mixing the two.
* **Peers are checked on connection.** A devnet node dialling a mainnet peer is refused with
  `ERR_WRONG_NETWORK` before it exchanges a single block, and the node that dialled logs a warning
  naming the address (`… is on another network or version than this one`), so a seed pasted from the
  wrong section shows up as a message, not just as `peers: 0`.
* **An interface is told its network** with `--network` and refuses a node that follows
  another (`503 ERR_WRONG_NETWORK`), so a wrong `--nodes` address cannot show you the wrong chain.
* **Addresses carry the network in their prefix**, and a node rejects another network's address.
* **A Genesis Invitation belongs to one deployment.** Never reuse one across networks.
* **One recovery phrase is one key on every network** — only the address prefix changes.
  Make a separate wallet for each network (`bash obsidian-network.sh <network> wallet`), and
  never type a mainnet phrase into a test network or reuse a test phrase on mainnet.
* **The helper script keeps a separate home per network** (`~/obsidian-data/<network>/`),
  so `stop` and `reset` for one can never touch another.

---

## 1. Install the release (once, for every network)

You need **Node.js 20.10 or newer** (22 LTS recommended) and about 300 MB of disk. Nothing is
compiled on your device: the release archives hold the built node and interface, and the only
packages installed are the node's runtime libraries: five pure-JavaScript packages and the one small package they share.

### 1A. Termux on Android, step by step

**Step 1 — install Termux from F-Droid** (<https://f-droid.org/packages/com.termux/>) or the
project's GitHub releases. Do **not** use the Play Store build: it is years out of date and
cannot install a current Node.js.

**Step 2 — update, and install the tools.** Paste into Termux:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git curl termux-tools
node -v     # must print v20.10 or newer
```

If `pkg` asks about replacing a configuration file, press Enter to keep the default.

**Step 3 — keep Android from killing the node.**

```bash
termux-wake-lock
```

Then, on the phone: Settings → Apps → Termux → Battery → **Unrestricted**. On **Android 12 and
newer** the system may also kill Termux's child processes (you will see
`[Process completed (signal 9)]`). On **Android 14+** turn on Settings → System → Developer
options → **Disable child process restrictions** (enable Developer options first by tapping
*Build number* seven times in Settings → About phone). On Android 12L and 13 the equivalent is,
from a computer with `adb`: `adb shell "settings put global settings_enable_monitor_phantom_procs false"`.

**Step 4 — download the release.** (Steps 2, 4 and 7 need the internet. After Step 7 a devnet
runs happily with the radio off.)

This fetches only what the next steps use: the checksum file, the built node and the built
interface, 2.6 MB in all. It fetches each file separately and tries each one up to eight times, so a
dropped connection costs you one file's progress rather than everything, and a download that stalls
for a minute is cut off and retried instead of hanging. Paste these five lines and press Enter. There
is no backslash in them on purpose: a command split over two lines is easy to break when it is pasted
on a phone.

```bash
rm -rf ~/obsidian/src; mkdir -p ~/obsidian; cd ~/obsidian
G="git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60"
for i in 1 2 3 4 5 6 7 8; do rm -rf src; $G clone --depth 1 --filter=blob:none --no-checkout --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git src && break; echo "attempt $i did not finish, trying again in 5 seconds"; sleep 5; done
cd src && for f in SHA256SUMS obsidian-node-operator-1.6.0.tar.gz obsidian-interface-selfhost-1.6.0.tar.gz; do for i in 1 2 3 4 5 6 7 8; do $G checkout HEAD -- releases/$f && break; echo "$f: attempt $i did not finish, trying again in 5 seconds"; sleep 5; done; done
ls -l releases
```

The last line must list three files: `SHA256SUMS`, `obsidian-node-operator-1.6.0.tar.gz` (0.5 MB) and
`obsidian-interface-selfhost-1.6.0.tar.gz` (2 MB). On a slow connection this takes a few minutes (at 15 KB/s,
about three): keep Termux open and the screen on while it runs. If it does not list all three, read the
first line of the error and find it in the troubleshooting table at the end of this guide (§8), or use the
browser route below. The first command removes any half-finished earlier attempt, so running this step
again is always safe. `--branch` names the branch you are installing from; this release was delivered on
`arena/414b663a-obsidian-network`.

**If your connection keeps dropping** (the sign is `Connection reset by peer` or `early EOF`, again and
again), download the two archives with your phone's browser instead. A browser resumes an interrupted
download; `git` and `curl` in Termux cannot. Open both links and let them finish (they land in Downloads):

* <https://github.com/EmoluxLabs/Obsidian-Network/raw/arena/414b663a-obsidian-network/releases/obsidian-node-operator-1.6.0.tar.gz>
* <https://github.com/EmoluxLabs/Obsidian-Network/raw/arena/414b663a-obsidian-network/releases/obsidian-interface-selfhost-1.6.0.tar.gz>

Then copy them where Step 5 expects them. `termux-setup-storage` asks for permission once; tap Allow. The
last command fetches the checksum file (1 KB), in case the commands above did not get that far:

```bash
termux-setup-storage
mkdir -p ~/obsidian/src/releases
cp ~/storage/downloads/obsidian-node-operator-1.6.0.tar.gz ~/storage/downloads/obsidian-interface-selfhost-1.6.0.tar.gz ~/obsidian/src/releases/
cd ~/obsidian/src/releases && curl -fL --retry 8 -o SHA256SUMS https://github.com/EmoluxLabs/Obsidian-Network/raw/arena/414b663a-obsidian-network/releases/SHA256SUMS
ls -l
```

If the browser added a number to a file name, `ls ~/storage/downloads | grep obsidian` shows what it saved;
rename it in the Downloads app or with `mv`. Step 5 checks every file, so a wrong or half-downloaded one
cannot slip through.

Do **not** use GitHub's "Download ZIP" instead: it leaves out the `releases/` folder, which is
where the built archives are. If you also want the whole project (source, scripts and tests, about
11 MB), clone it into a separate folder. Nothing in the install needs it:

```bash
git clone --depth 1 --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git ~/obsidian/full
```

**Step 5 — verify the archives.** Do not skip this: an archive you have not checked is a
download, not a release.

```bash
cd ~/obsidian/src/releases
sha256sum -c --ignore-missing SHA256SUMS
```

You must see `OK` for the two archives Step 4 downloaded, `obsidian-interface-selfhost-1.6.0.tar.gz`
and `obsidian-node-operator-1.6.0.tar.gz`, and nothing else (`--ignore-missing` skips the other archives
that `SHA256SUMS` lists). If any line says `FAILED`, or the answer is `no file was verified`, stop, delete
`~/obsidian` and start again — do not run the code. (`SHA256SUMS` proves the files were not damaged or altered in transit; it
does not prove who published them. See [release-verification.md](release-verification.md).)

**Step 6 — unpack both archives into one directory.** The operator archive is the built node
plus the helper script; the self-host archive is the built interface plus the nine sites. They
are designed to sit side by side.

```bash
mkdir -p ~/obsidian/run
cd ~/obsidian/src/releases
tar xzf obsidian-node-operator-1.6.0.tar.gz      -C ~/obsidian/run
tar xzf obsidian-interface-selfhost-1.6.0.tar.gz -C ~/obsidian/run
ls ~/obsidian/run        # obsidian-core  obsidian-interface  obsidian-network.sh  landing  mine ...
```

**Step 7 — install the node's runtime packages (six small packages, about 4 MB, no native code).**

```bash
cd ~/obsidian/run/obsidian-core
npm ci --omit=dev --fetch-retries=10
```

`--omit=dev` is what keeps this light and compiler-free: the build tools (`esbuild`,
TypeScript, the test runner) are not needed to *run* a node. The interface has no runtime
packages at all. `--fetch-retries=10` makes npm try each download up to ten times, which a slow or
unstable connection needs. If it still stops, run the same command again: npm keeps every package it has
already downloaded. If `npm ci` fails on your mirror, install the five it needs by name (npm adds the one they share):

```bash
npm install --omit=dev --no-audit --no-fund --fetch-retries=10 @noble/curves@1.6.0 @noble/hashes@1.5.0 @scure/bip32@1.5.0 @scure/bip39@1.4.0 ws@8.22.0
```

**Step 8 — smoke test.**

```bash
cd ~/obsidian/run
node obsidian-core/dist/index.js version
bash obsidian-network.sh help
```

You should see core and protocol `1.6.0`, and the helper's usage. Now go to the section for
the one network you want. Devnet is the place to start.

### 1B. Any Linux or macOS machine

Skip Steps 1–3 and install Node.js 20.10+ with your package manager (Debian/Ubuntu:
<https://github.com/nodesource/distributions>). Then follow Steps 4–8 unchanged. On a server
you will normally run the node under systemd instead of the helper; see
[ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md).

### What the helper script is

`obsidian-network.sh <network> <command>` only wraps the real commands (it prints each one as
it runs it) and adds no behaviour the node or interface does not already have. Commands:
`start`, `stop`, `restart`, `status`, `logs`, `wallet`, `invite`, `reset`. It keeps everything for
one network under `~/obsidian-data/<network>/` (override with `OBSIDIAN_HOME`). Environment
variables it understands are listed at the top of the script (`bash obsidian-network.sh help`).

---

## 2. Devnet

Chain id **7780** · addresses start `dobs1` · node RPC **38630** · node P2P **38631** · interface **http://127.0.0.1:38788** · genesis id `bf2b4dff2671e2e52e6a6eb58da1cc55cc0d90bb`

Devnet is the throwaway network: nothing on it has value, it is reset whenever you like,
and it is the right place to learn the system. Everything in this section is about devnet
and uses only devnet's ports.

### Start it — one command

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet start
```

Nothing to make or export first. The interface will not let anyone register without a Genesis
Invitation, and devnet ships with a disposable one: its **hash** is built into the helper (and printed
below), and you were given the matching **code** separately. The command starts the node, waits until it
answers, starts the interface, waits until that answers, and prints the address to open. A phone can take a
minute; it prints a line every 15 seconds while it waits. Re-running it is safe; it never starts a second
copy.

To use an invitation of your own instead (it prints the code **once**, and stores only its hash):

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet invite
cd ~/obsidian/run && bash obsidian-network.sh devnet restart
```

The shipped hash, for the record: `scrypt$32768$8$1$952b1429899a01aeb55b6e0a30430bc5$ef36a024ec45a8698b76e9b9678abe84a83f8ace7d8a05b73a1f50251409ca41`.
It opens devnet and no other network.

```bash
bash obsidian-network.sh devnet status      # running? which ports? what height? peers?
bash obsidian-network.sh devnet logs        # follow both logs (Ctrl-C leaves them running)
bash obsidian-network.sh devnet wallet      # a devnet wallet; the address starts dobs1
bash obsidian-network.sh devnet doctor      # checks this phone and this network, and says what to fix
bash obsidian-network.sh devnet stop        # stops THIS network's node and interface only
```

### The same thing by hand

This is exactly what the command above runs. Two terminals (Termux: swipe in from the left
edge, **New session**).

```bash
# terminal 1 — the node
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network devnet --data-dir ~/obsidian-data/devnet/node --rpc-port 38630 --p2p-port 38631
```

```bash
# terminal 2 — the interface
cd ~/obsidian/run/obsidian-interface
OBSIDIAN_GENESIS_INVITE_HASH='scrypt$32768$8$1$952b1429899a01aeb55b6e0a30430bc5$ef36a024ec45a8698b76e9b9678abe84a83f8ace7d8a05b73a1f50251409ca41' node dist/server/main.js --network devnet --port 38788 --nodes http://127.0.0.1:38630 --data-dir ~/obsidian-data/devnet/interface
```

Open **http://127.0.0.1:38788** in a browser on the same device. The interface port for
devnet is **38788**; all nine sites are paths on it (`/`, `/app/`, `/mine/`, `/wallet/`,
`/explorer/`, `/ons/`, `/node/`, `/audit/`, `/developer/`).

### Check that it is the right chain and that it is alive

```bash
curl -s localhost:38630/status            # networkId obsidian-devnet-1, chainId 7780, height climbing
curl -s localhost:38630/health            # paramsHash 4a2883b210c4a7aeb873f9d669e2476f
curl -s localhost:38788/api/health         # the interface answers
curl -s localhost:38788/api/auth/config    # genesisInvite: configured true, redeemed false
```

### Add a second devnet node (same device or another)

Every node needs its own data directory. `--seeds` takes the **P2P** port of a node that is
already running, never an RPC port.

```bash
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network devnet --data-dir ~/obsidian-data/devnet/node2 --rpc-port 38640 --p2p-port 38641 --seeds 127.0.0.1:38631
```

On another machine, replace `127.0.0.1` with the first node's address and open TCP **38631**
there. Both nodes should report the same `headHash` once they have synced.

### Reset devnet (start again from height 0)

```bash
bash obsidian-network.sh devnet stop
bash obsidian-network.sh devnet reset --yes    # deletes devnet's chain, node key and interface accounts
```

Resetting also un-burns the Genesis Invitation, because redemption is recorded in the
interface's data directory.

---

## 3. Testnet

Chain id **7778** · addresses start `tobs1` · node RPC **18630** · node P2P **18631** · interface **http://127.0.0.1:18788** · genesis id `95a85596046aa989e2faecc370a54f4ab8ef4a26`

Testnet is the public rehearsal: the same rules as mainnet with coins that have no value. Run it before anything else goes near mainnet. Everything in this section is about testnet and uses only testnet's ports.

### Start it — one command

```bash
cd ~/obsidian/run

# A Genesis Invitation for THIS testnet interface (the devnet one does not apply here):
bash obsidian-network.sh testnet invite        # prints the code ONCE; keep it. Stores only its hash.

bash obsidian-network.sh testnet start
```

```bash
bash obsidian-network.sh testnet status      # running? which ports? what height? peers?
bash obsidian-network.sh testnet logs        # follow both logs (Ctrl-C leaves them running)
bash obsidian-network.sh testnet wallet      # a testnet wallet; the address starts tobs1
bash obsidian-network.sh testnet doctor      # checks this phone and this network, and says what to fix
bash obsidian-network.sh testnet stop        # stops THIS network's node and interface only
```

### The same thing by hand

```bash
# terminal 1 — the node
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network testnet --data-dir ~/obsidian-data/testnet/node --rpc-port 18630 --p2p-port 18631
```

```bash
# terminal 2 — the interface
cd ~/obsidian/run/obsidian-interface
OBSIDIAN_GENESIS_INVITE_HASH='<the hash printed by the invite command, in single quotes>' node dist/server/main.js --network testnet --port 18788 --nodes http://127.0.0.1:18630 --data-dir ~/obsidian-data/testnet/interface
```

Open **http://127.0.0.1:18788**. The interface port for testnet is **18788**.

### Check that it is the right chain and that it is alive

```bash
curl -s localhost:18630/status            # networkId obsidian-testnet-1, chainId 7778, height climbing
curl -s localhost:18630/health            # paramsHash 4a2883b210c4a7aeb873f9d669e2476f
curl -s localhost:18788/api/health         # the interface answers
curl -s localhost:18788/api/auth/config    # genesisInvite: configured true, redeemed false
```

### Add another testnet node

The first testnet node is the seed. Give other operators its public address and the P2P port; they point `--seeds` at it. Every node needs its own data directory.

```bash
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network testnet --data-dir ~/obsidian-data/testnet/node2 --seeds FIRST_NODE_ADDRESS:18631
```

Open TCP **18631** on the first node's firewall (the P2P port only — never the RPC port).

### Reset testnet

```bash
bash obsidian-network.sh testnet stop
bash obsidian-network.sh testnet reset --yes    # deletes testnet's chain, node key and interface accounts
```

---

## 4. Staging

Chain id **7779** · addresses start `sobs1` · node RPC **28630** · node P2P **28631** · interface **http://127.0.0.1:28788** · genesis id `c5ae0bbfb755e1bc84656a42fd78542b8aad0952`

Staging is the dress rehearsal for a release: run the exact build you intend to ship, against a chain nobody depends on, before it reaches testnet or mainnet. Everything in this section is about staging and uses only staging's ports.

### Start it — one command

```bash
cd ~/obsidian/run

# A Genesis Invitation for THIS staging interface (no other network's invitation applies here):
bash obsidian-network.sh staging invite        # prints the code ONCE; keep it. Stores only its hash.

bash obsidian-network.sh staging start
```

```bash
bash obsidian-network.sh staging status      # running? which ports? what height? peers?
bash obsidian-network.sh staging logs        # follow both logs (Ctrl-C leaves them running)
bash obsidian-network.sh staging wallet      # a staging wallet; the address starts sobs1
bash obsidian-network.sh staging doctor      # checks this phone and this network, and says what to fix
bash obsidian-network.sh staging stop        # stops THIS network's node and interface only
```

### The same thing by hand

```bash
# terminal 1 — the node
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network staging --data-dir ~/obsidian-data/staging/node --rpc-port 28630 --p2p-port 28631
```

```bash
# terminal 2 — the interface
cd ~/obsidian/run/obsidian-interface
OBSIDIAN_GENESIS_INVITE_HASH='<the hash printed by the invite command, in single quotes>' node dist/server/main.js --network staging --port 28788 --nodes http://127.0.0.1:28630 --data-dir ~/obsidian-data/staging/interface
```

Open **http://127.0.0.1:28788**. The interface port for staging is **28788**.

### Check that it is the right chain and that it is alive

```bash
curl -s localhost:28630/status            # networkId obsidian-staging-1, chainId 7779, height climbing
curl -s localhost:28630/health            # paramsHash 4a2883b210c4a7aeb873f9d669e2476f
curl -s localhost:28788/api/health         # the interface answers
curl -s localhost:28788/api/auth/config    # genesisInvite: configured true, redeemed false
```

### Add another staging node

The first staging node is the seed; other staging nodes point `--seeds` at it. Every node needs its own data directory.

```bash
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network staging --data-dir ~/obsidian-data/staging/node2 --seeds FIRST_NODE_ADDRESS:28631
```

Open TCP **28631** on the first node's firewall (the P2P port only — never the RPC port).

### Reset staging

```bash
bash obsidian-network.sh staging stop
bash obsidian-network.sh staging reset --yes    # deletes staging's chain, node key and interface accounts
```

---

## 5. Mainnet

Chain id **7777** · addresses start `obs1` · node RPC **8630** · node P2P **8631** · interface **http://127.0.0.1:8788** · genesis id `3a7ced6f7e6a14f40fc310d9a5de6d834b5cbd4c`

**Mainnet is real.** Its data cannot be reset by the helper, its coins are the 21,000,000 OBS
that exist, and a mistake here is not a throwaway. Before you start it, read
[mainnet-launch.md](mainnet-launch.md) (the bootstrap set, genesis verification, monitoring,
rollback and the launch checklist) and run it with at least three independent operators. A
single mainnet node on a phone is a rehearsal of the commands, not a launch. Everything in this
section is about mainnet and uses only mainnet's ports.

### Start it — one command

Mainnet will not invent a passphrase for you: a passphrase generated and stored next to the
key it protects protects nothing. Choose one of 12 or more characters, keep a copy somewhere
else, and give it to the node for the one command that starts it.

**1. Type your passphrase.** Paste this one line **by itself**, press Enter, then type the passphrase
(nothing is shown) and press Enter again. Pasted together with other lines, the next line would become your
passphrase.

```bash
read -r -s -p "Mainnet passphrase (12+ characters): " MP; echo
```

**2. Make the invitation, then start.** `invite` prints the code **once**: keep it. It opens mainnet and
nothing else. The start line carries the passphrase for that one command only, and is the line to use every
time you start or restart mainnet:

```bash
cd ~/obsidian/run && bash obsidian-network.sh mainnet invite
cd ~/obsidian/run && OBSIDIAN_KEYSTORE_PASSPHRASE="$MP" bash obsidian-network.sh mainnet start
```

If other operators gave you peers, name them in front of that same command (this address is a
documentation example; replace it with theirs, as `host:P2P-port`, comma separated):

```bash
cd ~/obsidian/run && OBSIDIAN_KEYSTORE_PASSPHRASE="$MP" OBSIDIAN_SEED_NODES='203.0.113.10:8631' bash obsidian-network.sh mainnet start
```

When you are done, `unset MP` forgets the passphrase from this session.

On a server that must restart unattended, put the passphrase in a file only the service
account can read and set `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE` instead (the systemd template in
[ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md) does this).

```bash
bash obsidian-network.sh mainnet status      # running? which ports? what height? peers?
bash obsidian-network.sh mainnet logs        # follow both logs (Ctrl-C leaves them running)
bash obsidian-network.sh mainnet wallet      # a mainnet wallet; the address starts obs1
bash obsidian-network.sh mainnet doctor      # checks this phone and this network, and says what to fix
bash obsidian-network.sh mainnet stop        # stops THIS network's node and interface only
```

### The same thing by hand

```bash
# terminal 1 — the node (type the passphrase first, as in step 1 above; MP is set in this terminal)
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE="$MP" node dist/index.js start --network mainnet --data-dir ~/obsidian-data/mainnet/node --rpc-port 8630 --p2p-port 8631 --seeds 203.0.113.10:8631      # example address: use the real operators'
```

```bash
# terminal 2 — the interface
cd ~/obsidian/run/obsidian-interface
OBSIDIAN_GENESIS_INVITE_HASH='<the hash printed by the invite command, in single quotes>' node dist/server/main.js --network mainnet --port 8788 --nodes http://127.0.0.1:8630 --data-dir ~/obsidian-data/mainnet/interface
```

Open **http://127.0.0.1:8788**. The interface port for mainnet is **8788**.

### Check that it is the right chain and that it is alive

```bash
curl -s localhost:8630/status            # networkId obsidian-mainnet-1, chainId 7777, height climbing
curl -s localhost:8630/health            # paramsHash 4a2883b210c4a7aeb873f9d669e2476f
curl -s localhost:8630/supply            # "invariantOk":true and maxSupplyObs 21000000
curl -s localhost:8788/api/health         # the interface answers
curl -s localhost:8788/api/auth/config    # genesisInvite: configured true, redeemed false
```

The genesis id of a genuine mainnet node is `3a7ced6f7e6a14f40fc310d9a5de6d834b5cbd4c`. If yours differs, you are not on
mainnet: stop and find out why before you trust anything it says.

### Add another mainnet node

Mainnet needs independent operators on independent infrastructure. A second node of your own
on the same device adds redundancy against nothing. Each operator runs their own node, with
their own key and data directory, and points `--seeds` at the others:

```bash
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE="$MP" node dist/index.js start --network mainnet --data-dir ~/obsidian-data/mainnet/node --seeds FIRST_NODE_ADDRESS:8631
```

Open TCP **8631** on the node's firewall (the P2P port only — never the RPC port).

### Stopping mainnet

```bash
bash obsidian-network.sh mainnet stop
```

There is deliberately no `reset` for mainnet: `bash obsidian-network.sh mainnet reset` refuses.
If you are certain you want to delete mainnet data, do it by hand, after a backup.

---

## 6. The interface

An **interface** is the web front end: the landing page, wallet, miner, explorer, ONS,
node dashboard, audit and developer pages — nine sites served from one
process on one port. It holds accounts (email, password, TOTP) and sessions, and it proxies
read-only requests to a node. **It never holds a private key**: keys are made and kept in the
browser.

One interface serves **one network**, chosen with `--network`, and listens on that network's own
port:

| Network | Interface port | Open |
| --- | --- | --- |
| mainnet | 8788 | http://127.0.0.1:8788 |
| testnet | 18788 | http://127.0.0.1:18788 |
| staging | 28788 | http://127.0.0.1:28788 |
| devnet | 38788 | http://127.0.0.1:38788 |

The commands that start each one are in that network's section above (§2–§5), as part of
`obsidian-network.sh <network> start` and again by hand.

Things worth knowing:

* **It listens on 127.0.0.1 by default**, so only the device it runs on can reach it. That is the
  safe default. To reach it from another device, set `OBSIDIAN_INTERFACE_HOST=0.0.0.0` (or
  `--host 0.0.0.0`) and use the device's address — and read the next point.
* **The wallet needs a secure origin.** Browsers hide their cryptography from plain-HTTP pages
  that are not `localhost` / `127.0.0.1`. Over Wi-Fi at `http://192.168.x.x:PORT` you can
  browse the explorer and the other pages, but the wallet page will tell you it cannot create
  or open a wallet. Use the device itself, or serve the interface over HTTPS (§7).
* **Behind nginx or Cloudflare**, set `OBSIDIAN_INTERFACE_TRUST_PROXY=true` — and only then.
  Setting it on a directly exposed port lets any client forge the address the rate limits use.
* **It checks its node.** `curl -s localhost:<port>/api/nodes` lists the nodes it reads, whether
  each is healthy, and `lastError` if it turned one away for following another network.
* **Several nodes, for resilience:** `--nodes http://127.0.0.1:38630,http://other-host:38630`
  (comma separated; the interface health-checks them and fails over).

### The first account and the Genesis Invitation

A fresh interface lets nobody register until it has a **Genesis Invitation**: a single-use code
that creates the first account. Only the *hash* is configured on the interface
(`OBSIDIAN_GENESIS_INVITE_HASH` or `--genesis-invite-hash`); the code is shown once when it is
minted and is stored nowhere. It is worth 0 OBS and grants no authority — it just opens the door
once. Mint one with `bash obsidian-network.sh <network> invite`. After the first account exists,
every further account needs an ordinary invite from a member.

Registration needs a Gmail address, a password of 12+ characters and the invitation; then the
page shows ten recovery codes **once** and a TOTP secret to add to an authenticator app. There is
no password reset by design — the recovery codes are the way back in.

---

## 7. Hosting on a server

A phone is a good rehearsal and a poor server. For something other people can reach:

* **[ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md)** — a full step-by-step guide for Oracle
  Cloud, **free tier and paid**: creating the machine, opening the ports in both places Oracle
  filters them, installing from the verified archives, one systemd unit per network
  (`obsidian-node@testnet`, `obsidian-interface@testnet`, …), nginx and HTTPS in front of each
  interface, backups and monitoring.
* The same guide works on any Ubuntu or Debian VPS; only the "create the machine" part is
  Oracle-specific.
* Docker recipes are in `obsidian-core/deployment/docker/` and
  `obsidian-interface/deployment/docker/`, and the Cloudflare edge is in `cloudflare/`
  (see [self-hosting.md](self-hosting.md)).

---

## 8. Upgrading, backing up, troubleshooting

### Prove it works on your machine

`scripts/fresh-machine-test.sh` does what this guide does — verifies the archives, unpacks them,
installs the packages and starts **all four networks** on their default ports with the helper — and then
checks about a hundred claims: each network is itself (network id, chain id, genesis id, params hash), the
interfaces serve the right network and all nine sites, the Genesis Invitation works exactly once, a
second node joins and agrees, nodes and interfaces of different networks refuse each other (and say so),
and everything stops cleanly. It needs `git`, `curl`, `sha256sum`, `tar` and `setsid` (Termux:
`pkg install util-linux`), the default ports free, and about four minutes. It lives in the whole project, which Step 4 did not download, so the first line fetches that (about 11 MB):

```bash
rm -rf ~/obsidian/full; git clone --depth 1 --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git ~/obsidian/full
cd ~/obsidian/full && bash scripts/fresh-machine-test.sh
```

It prints one `ok` or `FAIL` line per claim and exits non-zero if any failed.

### Upgrade

Stop the network, unpack the new release into a **new** directory, install packages, and start
with the same data. The data lives in `~/obsidian-data/<network>/`, outside the code, so it is
untouched.

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet stop      # use the network you run
mv ~/obsidian/run ~/obsidian/run.old
# ...repeat Steps 4-7 of section 1A for the new release...
cd ~/obsidian/run && bash obsidian-network.sh devnet start
```

Peers compare core version, protocol version, network id and genesis id when they connect, so a
mismatched binary is refused rather than silently forking your view of the chain.

**1.6.0 is a new genesis for a pre-launch network, not an in-place upgrade.** The chain identity is
derived from the genesis document, which now also commits the public finality bootstrap keys
(see [consensus.md](consensus.md)), so the new identity is written from scratch: a 1.5.x data
directory is rejected at startup and cannot be loaded. Stop the old node, move its directory aside
for reference, and start 1.6.0 on a fresh data directory — do not delete the old one until you have
confirmed the new node is healthy. Because mainnet has not launched, nothing of value is lost; if a
value-bearing 1.5.x chain ever exists, stop and design a migration instead, because this release
does not provide one.

A patch release *within* 1.6.x (1.6.0 → a later 1.6.1) is different: the protocol version and genesis
identity do not move, the node replays a chain written by the earlier build without a state-root
mismatch, and you keep your data directory. `reset` is only for starting a network over on purpose.

The interface is a light, mobile-first application of nine pages, and the Audit and Node pages state
where the 90% ONS revenue share goes and when each part is paid.

### Back up

What matters is the node's **identity key** (`~/obsidian-data/<network>/node/node-key.json`) and
its passphrase, stored in different places. The chain can be re-synced from peers; an identity
cannot be regenerated. On mainnet, also back up the interface's data directory (accounts).

### Troubleshooting

| You see | It means | Do this |
| --- | --- | --- |
| `fatal: You must specify a repository to clone.`, or `bash: https://github.com/…: No such file or directory` | a command that was split over two lines lost its line break when pasted | use Step 4 exactly as written: every command in it is one line |
| `fatal: destination path 'src' already exists and is not an empty directory` | an earlier attempt left a half-finished folder | `rm -rf ~/obsidian/src`, then repeat Step 4 (its first line does this) |
| `Could not resolve host: github.com`, `Failed to connect to github.com`, or it just hangs | no internet, or a VPN, Private DNS or the network provider is in the way | run `curl -sI https://github.com` and look for `HTTP/2 200` on its first line; switch between Wi-Fi and mobile data, turn off any VPN or Private DNS, then repeat Step 4 |
| `RPC failed; curl 56 Recv failure: Connection reset by peer`, `curl 18`, `curl 92`, `early EOF`, `invalid index-pack output` or `Operation too slow` | the connection dropped or stalled in the middle of the download (common on slow mobile data; the whole-project download of earlier versions of this guide, 11 MB, failed this way at about 90%) | Step 4 now fetches 2.6 MB, one file at a time, and retries each file eight times by itself; run it again, on Wi-Fi if you can, with Termux open and the screen on. If it keeps failing, use the browser route under Step 4: a browser resumes an interrupted download |
| `SSL certificate problem` or `certificate is not yet valid` | the phone's date or time is wrong, or Termux is too old | set Date & time to automatic; `pkg update -y`; install Termux from F-Droid, not the Play Store |
| `Remote branch … not found in upstream origin` | the branch name was typed wrongly (the hex id is easy to mistype), or the branch was deleted | paste the name instead of typing it; `git ls-remote --heads https://github.com/EmoluxLabs/Obsidian-Network.git` lists the branches that exist |
| `git: command not found` | Step 2 did not finish | `pkg install -y git`, then repeat Step 4 |
| `No space left on device` | the phone is full | free about 300 MB, then repeat Step 4 |
| `fatal: no network selected` | there is no default network | add `--network devnet` (or testnet, staging, mainnet) |
| `ERR_WRONG_NETWORK` | a peer, a node or a data directory belongs to another network | check the ports and `--data-dir`; one directory per network |
| `fatal: listen EADDRINUSE: address already in use` | another process (maybe this network, already running) has the port | `bash obsidian-network.sh <network> status`; or run a second copy with `OBSIDIAN_PORT_OFFSET=10` |
| `data directory … is in use by another Obsidian process (pid N)` | a node is already running on that directory | stop it first; never share a data directory |
| `must provide a passphrase of at least 12 characters` | the keystore passphrase is missing or too short | set `OBSIDIAN_KEYSTORE_PASSPHRASE` to 12 or more characters |
| Interface shows "no healthy node" | the node is not running, or `--nodes` points at the wrong port | `status`, then check the RPC port for that network |
| Wallet page: "cannot use the browser's cryptography" | the page is plain HTTP at a non-localhost address | open `http://127.0.0.1:<port>` on the device, or use HTTPS |
| `[Process completed (signal 9)]` in Termux | Android killed the process | Step 3 of section 1A |
| `npm ci` fails on a phone | a mirror problem | use the five-package `npm install` in Step 7 |
| Peers stay at 0 | the seed is unreachable, its P2P port is closed, or it follows another network | check `--seeds` is the **P2P** port of a node on **this** network; open it in the firewall; look in the log for `is on another network or version than this one` |

More detail: [node-operator.md](node-operator.md) §9.
