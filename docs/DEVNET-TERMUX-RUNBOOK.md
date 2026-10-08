# Devnet on Termux — start a node and test the whole platform

A walk-through of a devnet on an Android phone, from an empty Termux to a registered account,
with checks along the way that tell you the system is doing what it claims. It is about
**devnet only**: chain id `7780`, addresses start `dobs1`, node RPC `38630`, node P2P `38631`,
interface `38788`. Nothing on devnet has value and you cannot damage any other network from
here. (The other networks have their own sections in [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md).)

Paste these into **Termux on Android** (on a laptop: any Linux or macOS shell, or Git Bash on
Windows — **not** PowerShell).

**Internet** is needed for steps 1–3 only. From step 4 on, devnet runs with the radio off: you
can switch on aeroplane mode and it keeps producing blocks.

---

## 1. Install the tools (internet)

Install Termux from **F-Droid or the project's GitHub releases**, not the Play Store: that build
is years old and cannot install a current Node.js.

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git curl termux-tools
termux-wake-lock
node -v     # must print v20.10 or newer
```

`termux-wake-lock` stops Android suspending the node when the screen goes off (release it later
with `termux-wake-unlock`). Also set Settings → Apps → Termux → Battery → **Unrestricted**. If you
see `[Process completed (signal 9)]` the system killed Termux's child processes: on Android 14+
enable Settings → System → Developer options → **Disable child process restrictions**; the
Android 12L/13 equivalent needs `adb` — see [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) §1A, step 3.

## 2. Get the release and verify it (internet)

This fetches only what the install uses (the checksum file, the built node and the built interface:
2.6 MB in all). It fetches each file separately and tries each one up to eight times, so a dropped
connection costs you one file's progress rather than everything. There is no backslash in it on purpose:
a command split over two lines is easy to break when it is pasted on a phone. On a slow connection it
takes a few minutes: keep Termux open and the screen on while it runs. If a step fails, the
troubleshooting table at the end of [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) (§8) matches the first line of each
error to its fix, and Step 4 of that guide has a browser route for a connection that keeps dropping,
because a browser resumes an interrupted download and `git` in Termux cannot.

```bash
rm -rf ~/obsidian/src; mkdir -p ~/obsidian; cd ~/obsidian
G="git -c http.version=HTTP/1.1 -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60"
for i in 1 2 3 4 5 6 7 8; do rm -rf src; $G clone --depth 1 --filter=blob:none --no-checkout --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git src && break; echo "attempt $i did not finish, trying again in 5 seconds"; sleep 5; done
cd src && for f in SHA256SUMS obsidian-node-operator-1.6.1.tar.gz obsidian-interface-selfhost-1.6.1.tar.gz; do for i in 1 2 3 4 5 6 7 8; do $G checkout HEAD -- releases/$f && break; echo "$f: attempt $i did not finish, trying again in 5 seconds"; sleep 5; done; done
ls -l releases
cd ~/obsidian/src/releases
sha256sum -c --ignore-missing SHA256SUMS
```

You must see three files listed, then `OK` for `obsidian-interface-selfhost-1.6.1.tar.gz` and
`obsidian-node-operator-1.6.1.tar.gz` and nothing else. If any line says `FAILED`, or the answer is
`no file was verified`, stop, delete `~/obsidian` and start again; do not run the code. (An archive
you have not checked is a download, not a release.) Do not use GitHub's "Download ZIP": it leaves out
`releases/`. To go further and have the archive re-run its own test suite, which takes a few minutes
on a phone, clone the whole project into its own folder (about 11 MB) and run the script from there:

```bash
rm -rf ~/obsidian/full; git clone --depth 1 --branch arena/414b663a-obsidian-network https://github.com/EmoluxLabs/Obsidian-Network.git ~/obsidian/full
cd ~/obsidian/full
./scripts/verify-release.sh releases/obsidian-node-operator-1.6.1.tar.gz
```

## 3. Unpack and install (internet — the last step that needs it)

Both archives go into one directory: the operator archive is the built node and the helper
script, the self-host archive is the built interface and the nine sites.

```bash
mkdir -p ~/obsidian/run
cd ~/obsidian/src/releases
tar xzf obsidian-node-operator-1.6.1.tar.gz      -C ~/obsidian/run
tar xzf obsidian-interface-selfhost-1.6.1.tar.gz -C ~/obsidian/run

cd ~/obsidian/run/obsidian-core
npm ci --omit=dev --fetch-retries=10
```

`--omit=dev` installs only the node's runtime libraries (five, plus the one small package they share: about 4 MB, no native code) and no compiler or build
tool, which is what makes this work on Android. The interface has **no** runtime packages. If
`npm ci` fails on your mirror:

```bash
npm install --omit=dev --no-audit --no-fund --fetch-retries=10 @noble/curves@1.6.1 @noble/hashes@1.5.0 @scure/bip32@1.5.0 @scure/bip39@1.4.0 ws@8.22.0
```

## 4. The devnet Genesis Invitation (offline)

The interface will not let anyone register until it has one. Two ways, pick one.

**The invitation that ships with this release.** The helper already has its *hash* (it is public: the
hash is `scrypt$32768$8$1$952b1429899a01aeb55b6e0a30430bc5$ef36a024ec45a8698b76e9b9678abe84a83f8ace7d8a05b73a1f50251409ca41`),
so `bash obsidian-network.sh devnet start` uses it and there is nothing to export. The matching *code* was
given to you separately and is never written in this repository.

**Or mint your own**, which prints a code once and stores only its hash:

```bash
cd ~/obsidian/run
bash obsidian-network.sh devnet invite
```

The invitation is a door key worth **0 OBS** and no authority: it only registers the first
account, once, for this deployment. Redemption is recorded in the interface's data directory, so
resetting devnet (step 13) makes the same invitation usable again.

## 5. Start devnet (offline from here on)

```bash
cd ~/obsidian/run
bash obsidian-network.sh devnet start
```

You will see each real command printed as it runs, then "node is answering", "interface is
answering" and the address to open. A block follows roughly every five seconds. Look at it:

```bash
bash obsidian-network.sh devnet status
```

```
network   : devnet   (data: /data/data/com.termux/files/home/obsidian-data/devnet)
node : running, pid 4731, port 38630
interface : running, pid 4759, port 38788
chain     : obsidian-devnet-1 (chain id 7780, protocol 1.6.1)
height    : 40    peers: 0    syncing: false
supply    : 0 seals
interface : http://127.0.0.1:38788  accounts exist: false  genesis invitation: {"configured":true,"redeemed":false}
```

(`logs` follows both log files; `stop` stops this network's node and interface and nothing else.)

## 6. Check the node is honest about itself

```bash
curl -s localhost:38630/health
```

Fields that matter:

| Field | Expected on devnet | Why it matters |
|---|---|---|
| `network` / `networkId` | `devnet` / `obsidian-devnet-1` | you are on devnet, not another chain |
| `chainId` | `7780` | transactions commit to this; another network's are refused |
| `genesisId` | `1e7ca102f6720a7682e9a396958f2a17330dc001` | the identity of this chain |
| `paramsHash` | `2dd76ca2b2305d725f3a975bfca04eb5` | the consensus rules; a different value means different rules |
| `coreVersion` / `protocolVersion` | `1.6.1` / `1.6.1` | |
| `supplyOk` | `true` | the 21,000,000 OBS cap invariant holds |
| `height` | climbing | the chain is alive |

More of the platform, straight from the node:

```bash
curl -s localhost:38630/params  | head -c 600; echo     # every protocol price
curl -s localhost:38630/pot     | head -c 400; echo     # Proof of Time state
curl -s localhost:38630/supply  | head -c 400; echo     # supply and the invariant
curl -s localhost:38630/status  | head -c 500; echo     # height, peers, mempool
curl -s localhost:38630/audit/compliance        | head -c 600; echo
curl -s localhost:38630/audit/decentralization  | head -c 600; echo
```

`/supply` must say `"invariantOk":true` and `"maxSupplyObs":"21000000.000000000000000000"`. In
`/audit/compliance` there are seventeen rows: the **sixteen** that name mechanisms this network
removed (a WAC token, a signup allocation, mining KYC, an admin mint path, proof-of-work, …) must
all read `"present":false`, and the one positive row, `revenueSplitEnforced`, reads `true` on
purpose. In `/audit/decentralization` all ten answers must be `NO`.

## 7. Make a wallet, with the radio off

Turn on **aeroplane mode** first. The point is to prove key generation never needs a network.

```bash
cd ~/obsidian/run
bash obsidian-network.sh devnet wallet
```

The address must start `dobs1`. Write the 24-word recovery phrase on paper: that output is the
only copy and nothing stores it. Then clear the scrollback:

```bash
clear && printf '\033[3J'
```

One phrase is **one key on every network**; only the address prefix changes. Make a new wallet
for each network, and never reuse a test phrase for anything you mean to keep.

## 8. The interface — nine sites on port 38788

`start` already launched it. Open **http://127.0.0.1:38788/** in your phone's browser. All nine
sites are paths on that one port:

```
/  /app/  /mine/  /wallet/  /explorer/
/ons/  /node/  /audit/  /developer/
```

Or check them all at once from a second Termux session (swipe in from the left edge → **New
session**) — nine `200`s:

```bash
for p in / /app/ /mine/ /wallet/ /explorer/ /ons/ /node/ /audit/ /developer/; do
  printf "%-12s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:38788$p)"
done
```

The interface runs by hand as `node dist/server/main.js --network devnet --port 38788 --nodes
http://127.0.0.1:38630 --data-dir ~/obsidian-data/devnet/interface` from
`~/obsidian/run/obsidian-interface`; the helper just supplies those flags.

**Opening it from another device on the same Wi-Fi.** By default the interface listens on
`127.0.0.1`, so only the phone itself can reach it. To let a laptop or second phone in, restart it
bound to the network:

```bash
bash obsidian-network.sh devnet stop
OBSIDIAN_INTERFACE_HOST=0.0.0.0 bash obsidian-network.sh devnet start
pkg install -y iproute2 2>/dev/null; ip -4 addr show wlan0 | grep inet
```

That prints a line like `inet 192.168.1.42/24 …`; browse `http://192.168.1.42:38788/` from the
other device. **Limit:** browsers hide their cryptography from plain-HTTP pages at a LAN address,
so on that other device you can read the explorer and the other pages, but the **wallet page
will say it cannot create or open a wallet** and offers no form. Use the phone itself for the
wallet, or put the interface behind HTTPS. This also exposes devnet to everyone on that Wi-Fi,
which on devnet is only a nuisance; keep the loopback default unless you mean it.

## 9. Test the account system

No Google, no email verification, no password reset. First check the front door:

```bash
curl -s localhost:38788/api/auth/config; echo
```

Expect `"authMethod":"GMAIL_PASSWORD_MFA"`, `"inviteOnly":true`, `"accountsExist":false` and
`"genesisInvite":{"configured":true,"redeemed":false}`. If `configured` is `false`, the hash in
step 4 did not reach the server: stop, set it, start again.

Register the first account in the browser at `http://127.0.0.1:38788/app/`: a Gmail address, a
password of 12+ characters, and the devnet Genesis Invitation **code**. The page then shows ten
recovery codes **once** — copy them before ticking the box — and then a TOTP secret to add to an
authenticator app; enter the 6-digit code and mining opens on the account.

Behaviours worth poking at deliberately (these are what the interface's own tests assert):

```bash
# a non-Gmail address is refused: 400 ERR_EMAIL_INVALID
curl -s -w ' [%{http_code}]\n' -X POST localhost:38788/api/auth/register -H 'content-type: application/json' -d '{"email":"someone@example.com","password":"a-long-enough-pass-9","inviteCode":"X"}'

# a wrong Genesis Invitation is refused: 403 ERR_GENESIS_INVITE_INVALID_OR_USED
curl -s -w ' [%{http_code}]\n' -X POST localhost:38788/api/auth/register -H 'content-type: application/json' -d '{"email":"first.operator@gmail.com","password":"a-long-enough-pass-9","inviteCode":"OBS-GENESIS-AAAA-AAAA-AAAA-AAAA"}'

# there is no password reset endpoint, by design: 404
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:38788/api/auth/reset
```

Once the first account exists, `/api/auth/config` reports `"accountsExist":true` and
`"genesisInvite":{"configured":true,"redeemed":true}`, and the same code is refused with `403`
forever. One inbox is one mining account (`john.smith@gmail.com` and `johnsmith+x@googlemail.com`
are the same inbox). A TOTP code cannot be used twice, so after confirming MFA wait for the next
code to sign in (`ERR_MFA_INVALID` otherwise), and each recovery code works exactly once.

## 10. Read the chain through the interface

The browser never talks to the node directly; the interface proxies it:

```bash
curl -s "localhost:38788/api/nodes"; echo
curl -s "localhost:38788/api/rpc?path=/status" | head -c 300; echo
curl -s "localhost:38788/api/rpc?path=/network" | head -c 300; echo
```

`"genesisMismatch":false` means the interface and its node agree on which chain this is, and
`/network` must say `"addressHrp":"dobs"` and `"chainId":7780` — the wallet page reads exactly
this before it derives an address. The interface proxies only what it knows is safe: a path with
`..` in it is refused with `400`, and it refuses a node that follows another network
(`503 ERR_WRONG_NETWORK`) instead of showing you the wrong chain.

## 11. More than one node (optional, still offline)

Each node needs its **own** data directory; sharing one is refused (the second stops with
`is in use by another Obsidian process`). Node 1 above is the seed. In a second session:

```bash
cd ~/obsidian/run/obsidian-core
OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters' node dist/index.js start --network devnet --data-dir ~/obsidian-data/devnet/node2 --rpc-port 38640 --p2p-port 38641 --seeds 127.0.0.1:38631
```

`--seeds` takes **P2P** ports (`38631`), never RPC ports. After about twenty seconds both nodes
should agree:

```bash
for p in 38630 38640; do
  curl -s localhost:$p/status | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['height'], 'peers', d['peers'], d['headHash'][:12])"
done
```

`peers` is 1 on each and the heights and head hashes match. (If Termux has no `python3`,
`pkg install -y python`, or just read the two `/status` outputs.) Add `--no-mine` to follow and
validate without producing blocks.

## 12. Run the test suites yourself (needs the source tree, so: internet)

The release archives run the platform; the suites need the development dependencies, so they run
from the cloned source:

```bash
cd ~/obsidian/src
npm --prefix obsidian-core ci && npm --prefix obsidian-core run build
npm --prefix obsidian-core test                         # consensus, storage, p2p, rpc, security
npm --prefix obsidian-interface ci && npm --prefix obsidian-interface run build
npm --prefix obsidian-interface test                    # accounts, wallet, pages, a live-node UI suite
node scripts/check-invariants.mjs                       # the economic constants
node --test cloudflare/test/worker.test.mjs
node --test tests/scripts/*.test.mjs
node --test tests/e2e/cluster.test.mjs                  # starts 3 real nodes, about a minute
node --test tests/e2e/networks.test.mjs                 # starts a node and interface per network
```

Build the core before the interface, and the interface before testing it, or you will get
spurious `../../core/*.js` failures. The suites bind fixed test ports (documented at the top of
each); do not run two copies at once, and stop devnet first if you want a quiet device.

## 13. Stop and reset

```bash
bash obsidian-network.sh devnet stop
termux-wake-unlock

# wipe devnet and start from height 0 again (keeps the invitation hash, un-burns the invitation)
bash obsidian-network.sh devnet reset --yes
```

`reset` deletes devnet's chain, its node key, its logs and the interface's accounts under
`~/obsidian-data/devnet/`; it is refused while anything is running and always refused for
mainnet. Mint a fresh invitation (step 4) if you would rather not reuse the code.

---

### Known footguns

* **Do not use a mainnet Genesis Invitation here.** Redemption is permanent for whichever
  deployment spends it.
* **One node, one data directory.** A second node on the same directory stops with `is in use by
  another Obsidian process`; do not copy a data directory between running nodes either.
* **`--seeds` wants P2P ports** (`38631`, `38641`, …), never RPC ports.
* **`OBSIDIAN_INTERFACE_HOST=0.0.0.0` exposes the interface** to your whole Wi-Fi network, and the
  wallet page will not work over plain HTTP there. Keep the default unless you mean it.
* **Android kills a backgrounded Termux** without `termux-wake-lock`, and on some versions even
  with it (step 1). A node that gets killed is not a bug in the protocol.
* **`npm ci` without `--omit=dev`** tries to fetch build tools (including a native `esbuild`
  binary) that a phone neither needs nor always can install.
* **After upgrading, check your browser is running the new bundle.** The markup points at
  content-hashed bundles (`/js/wallet.js?v=<hash>`), so a new build gets a new URL:
  `curl -s localhost:38788/wallet/ | grep -o 'src="[^"]*"'` must show a 16-character hash that
  changes whenever the bundle does. A browser holding an older, un-hashed copy of the page
  must clear it once (Chrome on Android: ⋮ → History → Clear browsing data →
  *Cached images and files*, or open a new Incognito tab).
