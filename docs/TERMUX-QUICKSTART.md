# Termux quick start

Everything needed to run an Obsidian node and its interface on an Android phone, one network at a time. It
has three parts: set the phone up once (sections 1 and 2), run the network you want (sections 3 to 6, one
section each, each complete on its own), and what to do when it does not work (sections 7 and 8).

**Three rules make this work, and they are why these commands look the way they do.**

1. **Every command is one line you can paste on its own.** Nothing is split across lines, and nothing needs
   a second command to have run first except where the text says so.
2. **Nothing is `export`ed.** A variable you export stays in your Termux session and quietly changes the next
   network you start, which is how one network's invitation or passphrase used to end up on another. Where a
   setting is needed, it is written in front of the one command that needs it and goes away with it.
3. **When something does not work, run `doctor`.** `cd ~/obsidian/run && bash obsidian-network.sh <network> doctor`
   checks the phone, the install, the ports, the keys and your shell, and prints `PROBLEM` next to anything
   wrong, with the command that fixes it. Fix the first one and run it again.

A phone can comfortably run one network at a time (about 150 MB of memory for a node and its interface).
Running several together works, because each has its own ports and data, but expect it to slow the phone.

## 1. One-time setup

Install [Termux from F-Droid](https://f-droid.org/packages/com.termux/) (the Play Store build is out of date
and cannot install packages). Then paste:

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git curl termux-tools
node -v     # must print v20.10 or newer
```

If `pkg` asks about replacing a configuration file, press Enter to keep the default. Then keep Android from
killing the node:

```bash
termux-wake-lock
```

and on the phone: Settings → Apps → Termux → Battery → **Unrestricted**. If Termux shows
`[Process completed (signal 9)]`, Android is killing its child processes: on Android 14 and newer turn on
Settings → System → Developer options → **Disable child process restrictions**.

## 2. Download, check and install

Needs the internet, and tolerates a slow or unstable connection: it fetches only 2.6 MB, one file at a time,
and tries each file up to eight times. Paste these five lines together:

```bash
rm -rf ~/obsidian/src; mkdir -p ~/obsidian; cd ~/obsidian
G="git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60"
for i in 1 2 3 4 5 6 7 8; do rm -rf src; $G clone --depth 1 --filter=blob:none --no-checkout --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git src && break; echo "attempt $i did not finish, trying again in 5 seconds"; sleep 5; done
cd src && for f in SHA256SUMS obsidian-node-operator-1.6.1.tar.gz obsidian-interface-selfhost-1.6.1.tar.gz; do for i in 1 2 3 4 5 6 7 8; do $G checkout HEAD -- releases/$f && break; echo "$f: attempt $i did not finish, trying again in 5 seconds"; sleep 5; done; done
ls -l releases
```

It must list three files: `SHA256SUMS` and two `.tar.gz` archives. If it does not, the troubleshooting table
in section 7 matches the first line of the error to its fix, and [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) (Step 4)
has a browser route for a connection that keeps dropping.

Check the files are exactly what was published. You must see `OK` for both archives and nothing else:

```bash
cd ~/obsidian/src/releases
sha256sum -c --ignore-missing SHA256SUMS
```

Unpack both archives into one directory:

```bash
mkdir -p ~/obsidian/run
cd ~/obsidian/src/releases
tar xzf obsidian-node-operator-1.6.1.tar.gz      -C ~/obsidian/run
tar xzf obsidian-interface-selfhost-1.6.1.tar.gz -C ~/obsidian/run
ls ~/obsidian/run        # obsidian-core  obsidian-interface  obsidian-network.sh  landing  mine ...
```

Install the node's libraries (about 4 MB; if it stops, run the same line again, because npm keeps what it has
already downloaded):

```bash
cd ~/obsidian/run/obsidian-core
npm ci --omit=dev --fetch-retries=10
```

You are done installing. From here on, every command starts with `cd ~/obsidian/run`, which is where the
helper script lives.

## 3. Devnet

Chain id **7780** · addresses start `dobs1` · node **38630** · peers **38631** · interface **http://127.0.0.1:38788**

Devnet is the throwaway network: nothing on it has value, and it is the right place to learn the system.

**1. Start it.** One line, nothing to make or export first:

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet start
```

The first account on a network needs a Genesis Invitation code. Devnet ships with a disposable one: you
were given its **code** with the guide, and it opens devnet and nothing else. (If you lose the code,
make an invitation of your own with the two lines at the end of this section.)

`start` runs the node, waits until it answers, runs the interface, waits until that answers, and then
prints the address. A phone can take a minute: it prints a line every 15 seconds while it waits.
Running it again is safe; it never starts a second copy.

**2. Open it.** In Chrome or Firefox on the same phone, type `http://127.0.0.1:38788` in the address bar.
Create your account with the Genesis Invitation code you were given, then make a wallet on the Wallet page.

**3. Look after it.** Every line below is a complete command; run the one you need.

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet status
cd ~/obsidian/run && bash obsidian-network.sh devnet logs
cd ~/obsidian/run && bash obsidian-network.sh devnet wallet
cd ~/obsidian/run && bash obsidian-network.sh devnet doctor
cd ~/obsidian/run && bash obsidian-network.sh devnet stop
```

`logs` follows the log until you press Ctrl-C (that leaves the network running). `wallet` prints a
recovery phrase **once** and stores it nowhere: write it down. `doctor` checks this phone and this network
and says what to fix. `stop` stops devnet's node and interface and nothing else.

**4. Start devnet over from block 0.** This deletes devnet's chain, its node key and its accounts, and
nothing else. The invitation hash and the passphrase file are kept.

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet stop
cd ~/obsidian/run && bash obsidian-network.sh devnet reset --yes
```

To use an invitation of your own instead of the one that ships, make one and restart. It prints the code
**once**, so write it down:

```bash
cd ~/obsidian/run && bash obsidian-network.sh devnet invite
cd ~/obsidian/run && bash obsidian-network.sh devnet restart
```

## 4. Testnet

Chain id **7778** · addresses start `tobs1` · node **18630** · peers **18631** · interface **http://127.0.0.1:18788**

Testnet is the public rehearsal: the same rules as the real network, with coins that have no value. Run it before anything else goes near the real one.

**1. Make the invitation, then start it.** The first account on a network needs a Genesis Invitation
code. `invite` prints one **once** (write it down; only its hash is stored) and it opens
testnet and nothing else. You only do this the first time.

```bash
cd ~/obsidian/run && bash obsidian-network.sh testnet invite
cd ~/obsidian/run && bash obsidian-network.sh testnet start
```

`start` runs the node, waits until it answers, runs the interface, waits until that answers, and then
prints the address. A phone can take a minute: it prints a line every 15 seconds while it waits.
Running it again is safe; it never starts a second copy.

**2. Open it.** In Chrome or Firefox on the same phone, type `http://127.0.0.1:18788` in the address bar.
Create your account with the code from step 1, then make a wallet on the Wallet page.

**3. Look after it.** Every line below is a complete command; run the one you need.

```bash
cd ~/obsidian/run && bash obsidian-network.sh testnet status
cd ~/obsidian/run && bash obsidian-network.sh testnet logs
cd ~/obsidian/run && bash obsidian-network.sh testnet wallet
cd ~/obsidian/run && bash obsidian-network.sh testnet doctor
cd ~/obsidian/run && bash obsidian-network.sh testnet stop
```

`logs` follows the log until you press Ctrl-C (that leaves the network running). `wallet` prints a
recovery phrase **once** and stores it nowhere: write it down. `doctor` checks this phone and this network
and says what to fix. `stop` stops testnet's node and interface and nothing else.

**4. Start testnet over from block 0.** This deletes testnet's chain, its node key and its accounts, and
nothing else. The invitation hash and the passphrase file are kept.

```bash
cd ~/obsidian/run && bash obsidian-network.sh testnet stop
cd ~/obsidian/run && bash obsidian-network.sh testnet reset --yes
```

To make a new invitation after a reset, run step 1 again.

## 5. Staging

Chain id **7779** · addresses start `sobs1` · node **28630** · peers **28631** · interface **http://127.0.0.1:28788**

Staging is the dress rehearsal for a release: run the exact build you intend to ship against a chain nobody depends on.

**1. Make the invitation, then start it.** The first account on a network needs a Genesis Invitation
code. `invite` prints one **once** (write it down; only its hash is stored) and it opens
staging and nothing else. You only do this the first time.

```bash
cd ~/obsidian/run && bash obsidian-network.sh staging invite
cd ~/obsidian/run && bash obsidian-network.sh staging start
```

`start` runs the node, waits until it answers, runs the interface, waits until that answers, and then
prints the address. A phone can take a minute: it prints a line every 15 seconds while it waits.
Running it again is safe; it never starts a second copy.

**2. Open it.** In Chrome or Firefox on the same phone, type `http://127.0.0.1:28788` in the address bar.
Create your account with the code from step 1, then make a wallet on the Wallet page.

**3. Look after it.** Every line below is a complete command; run the one you need.

```bash
cd ~/obsidian/run && bash obsidian-network.sh staging status
cd ~/obsidian/run && bash obsidian-network.sh staging logs
cd ~/obsidian/run && bash obsidian-network.sh staging wallet
cd ~/obsidian/run && bash obsidian-network.sh staging doctor
cd ~/obsidian/run && bash obsidian-network.sh staging stop
```

`logs` follows the log until you press Ctrl-C (that leaves the network running). `wallet` prints a
recovery phrase **once** and stores it nowhere: write it down. `doctor` checks this phone and this network
and says what to fix. `stop` stops staging's node and interface and nothing else.

**4. Start staging over from block 0.** This deletes staging's chain, its node key and its accounts, and
nothing else. The invitation hash and the passphrase file are kept.

```bash
cd ~/obsidian/run && bash obsidian-network.sh staging stop
cd ~/obsidian/run && bash obsidian-network.sh staging reset --yes
```

To make a new invitation after a reset, run step 1 again.

## 6. Mainnet

Chain id **7777** · addresses start `obs1` · node **8630** · peers **8631** · interface **http://127.0.0.1:8788**

**Mainnet is real.** Its coins are the 21,000,000 OBS that exist, and its data cannot be reset with the helper.
Read [mainnet-launch.md](mainnet-launch.md) before you start it, and run it with at least three independent
operators: one node on a phone is a rehearsal of the commands, not a launch.

Mainnet will not make a passphrase for you, because a passphrase stored next to the key it protects protects
nothing. You choose one (12 or more characters), keep a copy somewhere else, and give it to the node for the
one command that starts it.

**1. Type your passphrase.** Paste this one line **by itself**, press Enter, then type the passphrase (nothing
is shown as you type) and press Enter again. Pasting it together with other lines would make the next line
your passphrase.

```bash
read -r -s -p "Mainnet passphrase (12+ characters): " MP; echo
```

**2. Make the invitation, then start it.** `invite` prints a code **once**: write it down. It opens mainnet and
nothing else. Paste both lines. The second one carries your passphrase from step 1 for that one command only:

```bash
cd ~/obsidian/run && bash obsidian-network.sh mainnet invite
cd ~/obsidian/run && OBSIDIAN_KEYSTORE_PASSPHRASE="$MP" bash obsidian-network.sh mainnet start
```

Use that second line whenever you start or restart mainnet. If other operators gave you peers, name them in
front of that same command (the address here is an example; replace it with theirs, as `host:peer-port`):

```bash
cd ~/obsidian/run && OBSIDIAN_KEYSTORE_PASSPHRASE="$MP" OBSIDIAN_SEED_NODES='203.0.113.10:8631' bash obsidian-network.sh mainnet start
```

**3. Open it.** In Chrome or Firefox on the same phone: `http://127.0.0.1:8788`.

**4. Look after it.** Every line below is a complete command:

```bash
cd ~/obsidian/run && bash obsidian-network.sh mainnet status
cd ~/obsidian/run && bash obsidian-network.sh mainnet logs
cd ~/obsidian/run && bash obsidian-network.sh mainnet wallet
cd ~/obsidian/run && bash obsidian-network.sh mainnet doctor
cd ~/obsidian/run && bash obsidian-network.sh mainnet stop
```

When you are finished, forget the passphrase from this session with `unset MP`. Mainnet cannot be reset with
the helper: that is real data, and deleting it is something you do by hand, on purpose.

## 7. If it does not work

First run `doctor` for the network you were starting. It names the problem and the fix:

```bash
cd ~/obsidian/run && bash obsidian-network.sh <network> doctor
```

(Write `devnet`, `testnet`, `staging` or `mainnet` in place of `<network>`.) If you need to ask for help, paste
its whole output.

| The first line you see | It means | Do this |
| --- | --- | --- |
| `cd: …/obsidian/run: No such file or directory` | the archives were never unpacked there | do section 2 again, from the download |
| `obsidian-core has no dependencies installed` | the libraries step was skipped or stopped | `cd ~/obsidian/run/obsidian-core && npm ci --omit=dev --fetch-retries=10` |
| `cannot find a built obsidian-core` | the two archives are not in the same directory, or you are not in `~/obsidian/run` | `cd ~/obsidian/run`, and unpack both archives there (section 2) |
| `Node.js 20.10 or newer is required` | Node is too old | `pkg upgrade -y` |
| `node did not answer within 180s, but it is still running` | a slow phone, not a failure | wait a minute, then run `status` |
| `node stopped while starting` | the log lines above it say why | the next rows match the usual causes |
| `could not decrypt the node keystore` | this network's key was made with a different passphrase | the helper keeps the right one for test networks; if you made the key by hand, give that passphrase for the one command: `OBSIDIAN_KEYSTORE_PASSPHRASE='…' bash obsidian-network.sh <network> start` |
| `listen EADDRINUSE` | something already uses one of this network's ports | `stop` the network, or move every port by 10: `OBSIDIAN_PORT_OFFSET=10 bash obsidian-network.sh <network> start` |
| `already running` and `was started BEFORE the build that is installed now` | you upgraded the files but the old program is still running | `bash obsidian-network.sh <network> restart` |
| `mainnet needs a passphrase YOU chose` | mainnet never makes one | section 6, step 1, then the start line that names `MP` |
| `no Genesis Invitation is configured` | nobody can make the first account yet | `bash obsidian-network.sh <network> invite`, then `restart` |
| `ignoring … from your shell` | a variable left in your session was set aside on purpose | nothing: it is a notice, and the network started with its own settings |
| the page does not open | the address is wrong, or the network is not running | type `http://127.0.0.1:` and the interface port from that network's section, on the same phone; run `status` |
| everything stops a few minutes after you leave Termux | Android is killing it | section 1: `termux-wake-lock`, Battery → Unrestricted, and the developer option |

## 8. Upgrade to a newer release

Your chains and accounts live in `~/obsidian-data/<network>/`, outside the code, so an upgrade keeps them.
Stop each network you run, move the old code aside, and repeat section 2:

```bash
cd ~/obsidian/run && bash obsidian-network.sh <network> stop
```

```bash
mv ~/obsidian/run ~/obsidian/run.old
```

Then do section 2 again (the download, the check, the unpack, the libraries) and start the network the way its
section says. If you forget to stop first, `start` tells you the old program is still running and which
command replaces it. When the new build works, `rm -rf ~/obsidian/run.old` frees the space.
