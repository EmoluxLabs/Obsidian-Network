# Devnet on Termux — start a node and test the whole platform

Every command below was run end to end against the **1.2.17 release archives**,
on a phone-shaped layout: archives unpacked, dependencies installed, two nodes
peered, the interface serving all twelve sites, and an account registered with
the devnet Genesis Invitation. The exact source commit is recorded inside each
archive in `releases/MANIFEST.json`.

Paste these into **Termux on Android** (on a laptop: Git Bash on Windows, or any
shell on Linux/macOS — **not** PowerShell).

Devnet is a throwaway network. chainId `7780`, addresses start `dobs1`, and
nothing on it has value. You cannot damage mainnet from here.

**Internet:** steps 1–3 only. From step 4 on, devnet runs with the radio off —
you can switch on aeroplane mode and it keeps producing blocks.

---

## 1. Install the tools (internet)

Install Termux from **F-Droid or the project's GitHub releases**, not the Play
Store: the Play Store build is years old and cannot install a current Node.

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git
termux-wake-lock
node -v   # must print v20.10 or newer
```

`nodejs-lts` is the stable line and satisfies the `>=20.10.0` requirement;
`pkg install nodejs` (cutting edge) works too — pick one, not both.

`termux-wake-lock` stops Android from suspending the node the moment the screen
goes off. If the command is not found, `pkg install -y termux-tools` (and on
some mirrors `termux-api` plus the Termux:API app) provides it. Release it later
with `termux-wake-unlock`.

## 2. Get the release and verify it (internet)

Do not skip the verification. An archive you have not checked is a download,
not a release.

```bash
mkdir -p ~/obsidian && cd ~/obsidian
git clone --depth 1 --branch v1.2.17 \
  https://github.com/EmoluxLabs/Obsidian-Network.git src
cd ~/obsidian/src/releases
sha256sum -c SHA256SUMS
```

Every line must say `OK` (eleven of them). If any says `FAILED`, stop — delete
the folder and start again; do not run the code.

Then check that the archive you are about to run extracts and passes its own
gate. The operator archive carries a runnable copy of the node and its tests:

```bash
cd ~/obsidian/src
./scripts/verify-release.sh releases/obsidian-node-operator-1.2.17.tar.gz
```

It should end with `OK: obsidian-node-operator-1.2.17.tar.gz verified.` (On a
phone this step is optional — it re-runs the core test suite, which takes a
couple of minutes. `sha256sum -c` above is the essential check.)

## 3. Unpack and install (internet — the last step that needs it)

The operator archive is a working node; the selfhost archive is the node plus
the twelve web sites. The interface has **no runtime dependencies at all** —
only the node installs packages.

```bash
mkdir -p ~/obsidian/run/node ~/obsidian/run/iface
cd ~/obsidian/src/releases
tar xzf obsidian-node-operator-1.2.17.tar.gz      -C ~/obsidian/run/node
tar xzf obsidian-interface-selfhost-1.2.17.tar.gz -C ~/obsidian/run/iface

cd ~/obsidian/run/node/obsidian-core
npm ci --omit=dev
```

If `npm ci` fails (some mirrors have trouble fetching the `esbuild` binary on
Android), install just what the running node imports — nothing else is loaded:

```bash
npm install --omit=dev --no-audit --no-fund \
  @noble/curves@1.6.0 @noble/hashes@1.5.0 @scure/bip39@1.4.0 ws@8.22.0
```

`esbuild` is a build-time tool for the browser bundles. The compiled node in
`dist/` imports only `node:*`, `ws`, `@noble/*` and `@scure/bip39`, so the node
runs without it.

## 4. Make the devnet Genesis Invitation (offline)

The interface will not let anyone register without one, and the generator script
is not inside the release archives — but the compiled module is. One command,
run from the unpacked interface:

```bash
cd ~/obsidian/run/iface/obsidian-interface
node --input-type=module -e "const { newGenesisInvitation } = await import('./dist/server/genesis-invite.js'); const { code, hash } = newGenesisInvitation(); console.log('INVITE : ' + code); console.log('EXPORT : export OBSIDIAN_GENESIS_INVITE_HASH=' + JSON.stringify(hash));"
```

You get two lines, one like `INVITE : OBS-GENESIS-XXXX-XXXX-XXXX-XXXX` and one
starting `EXPORT : export OBSIDIAN_GENESIS_INVITE_HASH=`, followed by a long
`scrypt` string.

Write the **code** on paper; it is shown once and cannot be recovered from the
hash. Hold on to the whole `EXPORT` line — step 9 needs it, and the hash
contains shell-special characters, so keep it in the single quotes as printed.
This invitation is a door key worth **0 OBS** and no authority; it only
registers the first account, once, for this deployment.

## 5. Start the devnet node (offline from here on)

```bash
cd ~/obsidian/run/node/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='pick-any-devnet-passphrase'
node dist/index.js start \
  --network devnet \
  --data-dir ./data/devnet \
  --mine \
  --log-level info
```

Leave this session running. The startup line must show `"chainId":7780`,
`"version":"1.2.17"` and `"mining":true`, then blocks begin: one roughly every
five seconds.

Open a **second Termux session** (swipe from the left edge → **New session**)
for everything below.

## 6. Check the node is honest about itself

```bash
curl -s localhost:38630/health
```

Four fields matter:

| Field | Expected | Why it matters |
|---|---|---|
| `paramsHash` | `dbbf8511bfe5bee493f80f3dd23a047a` | consensus rules; a different value means different rules |
| `protocolVersion` | `1.2.0` | |
| `chainId` | `7780` | you are on devnet, not mainnet |
| `height` | climbing | the chain is alive |

More of the platform, straight from the node:

```bash
curl -s localhost:38630/params  | head -c 600; echo    # every protocol price
curl -s localhost:38630/pot     | head -c 400; echo    # Proof of Time state
curl -s localhost:38630/supply  | head -c 300; echo    # supply + invariant
curl -s localhost:38630/status  | head -c 400; echo    # height, peers, mempool
curl -s localhost:38630/audit/compliance       | head -c 600; echo
curl -s localhost:38630/audit/decentralization | head -c 600; echo
```

In `/audit/compliance`, all sixteen rows must read `"present":false`. In
`/audit/decentralization`, all ten answers must be `NO`.

## 7. More than one node (optional, still offline)

Three sessions, three data directories, one devnet. Node 1 above is the seed.

```bash
# session 2 — node 2
cd ~/obsidian/run/node/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='pick-any-devnet-passphrase'
node dist/index.js start --network devnet \
  --data-dir ~/obsidian/run/n2 --rpc-port 38640 --p2p-port 38641 \
  --seeds 127.0.0.1:38631 --mine

# session 3 — node 3
node dist/index.js start --network devnet \
  --data-dir ~/obsidian/run/n3 --rpc-port 38650 --p2p-port 38651 \
  --seeds 127.0.0.1:38631,127.0.0.1:38641 --mine
```

`--seeds` takes **P2P** ports (38631-style), not RPC ports. Check they found
each other — `peers` must be ≥1 and the heights must agree:

```bash
for p in 38630 38640 38650; do
  curl -s localhost:$p/status | \
    python3 -c "import json,sys; d=json.load(sys.stdin); print(d['height'], 'peers', d['peers'], d['headHash'][:12])"
done
```

Each node needs its **own** data directory; sharing one corrupts state. Use
`--no-mine` on the extra nodes if you want a single producer and two followers.

## 8. Make a wallet, with the radio off

Turn on **aeroplane mode** first. The point is to prove key generation never
needs a network.

```bash
cd ~/obsidian/run/node/obsidian-core
node dist/index.js wallet new --network devnet
```

The address must start `dobs1`. Write the recovery phrase on paper — that output
is the only copy. Clear the scrollback when you are done reading:

```bash
clear && printf '\033[3J'
```

## 9. Start the interface (the 12 sites)

```bash
cd ~/obsidian/run/iface/obsidian-interface
export OBSIDIAN_NODE_URLS=http://127.0.0.1:38630,http://127.0.0.1:38640
export OBSIDIAN_INTERFACE_HOST=127.0.0.1
export OBSIDIAN_INTERFACE_PORT=8788
export OBSIDIAN_INTERFACE_DATA_DIR=$HOME/obsidian/run/iface-data
export OBSIDIAN_GENESIS_INVITE_HASH='PASTE-YOUR-EXPORT-LINE-HERE'
node dist/server/main.js
```

Use **single quotes** around the hash — it contains `$`, and double quotes would
let the shell eat it. Drop the second node from `OBSIDIAN_NODE_URLS` if you did
not start it.

Then open `http://127.0.0.1:8788/` in your phone's browser. All twelve sites are
paths on that one port:

```
/  /app/  /mine/  /wallet/  /explorer/  /circle/
/ons/  /social/  /capsule/  /node/  /audit/  /developer/
```

Or check them all at once from a third session — twelve `200`s:

```bash
for p in / /app/ /mine/ /wallet/ /explorer/ /circle/ /ons/ /social/ /capsule/ /node/ /audit/ /developer/; do
  printf "%-12s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8788$p)"
done
```

**To open it from another device on the same Wi-Fi** (a laptop browser, a second
phone), start both bound to the network instead of loopback:

```bash
# node: add --rpc-host 0.0.0.0 ; interface: export OBSIDIAN_INTERFACE_HOST=0.0.0.0
pkg install -y iproute2 2>/dev/null
ip -4 addr show wlan0 | grep inet
```

That prints a line like `inet 192.168.1.42/24 brd … scope global wlan0` — the
address before the `/` is your phone's. If `wlan0` is not it, `ip -4 addr show`
lists every interface. (Android's Wi-Fi settings screen shows the same address.)
Then browse
`http://192.168.1.42:8788/` from the other device. This exposes devnet to your
whole Wi-Fi network. On devnet that is only a nuisance; keep the defaults unless
you mean it.

## 10. Test the new account system

This is the part that changed in 1.2.0: no Google, no email, no password reset.

```bash
curl -s localhost:8788/api/auth/config; echo
```

Expect `"authMethod":"GMAIL_PASSWORD_MFA"`, `"accountsExist":false` and
`"genesisInvite":{"configured":true,"redeemed":false}`. If `configured` is
`false`, step 4's hash did not reach the server — restart it with the export.

Register the first account in the browser at `http://127.0.0.1:8788/app/` —
Gmail address, password of 12+ characters, and the **devnet** Genesis Invitation
from step 4. The page then shows ten recovery codes **once**; copy or download
them before ticking the box. Next it shows a TOTP secret: add it to any
authenticator app, enter the 6-digit code, and mining opens on the account.

Four behaviours worth poking at deliberately:

```bash
# a non-Gmail address is refused
curl -s -X POST localhost:8788/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"someone@example.com","password":"a-long-enough-pass-9","inviteCode":"X"}'; echo

# one inbox = one mining account. After registering john.smith@gmail.com,
# this must come back ERR_EMAIL_IN_USE even with a valid member invite:
curl -s -X POST localhost:8788/api/auth/register -H 'content-type: application/json' \
  -d '{"email":"johnsmith+mining@googlemail.com","password":"a-long-enough-pass-9","inviteCode":"<a real invite>"}'; echo

# there is no password reset endpoint, by design
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:8788/api/auth/reset

# the Genesis Invitation is single use — a second attempt is permanently dead
```

Re-using the same TOTP code on `/api/auth/login` is refused
(`ERR_MFA_INVALID`), and a recovery code works exactly once.

## 11. Read the chain through the interface

The browser never talks to the node directly; the interface proxies it:

```bash
curl -s "localhost:8788/api/nodes"; echo
curl -s "localhost:8788/api/rpc?path=/status" | head -c 300; echo
curl -s "localhost:8788/api/rpc?path=/audit/compliance" | head -c 300; echo
```

`"genesisMismatch":false` means the interface and the node agree on which chain
this is.

## 12. Run the test suites yourself (needs dev dependencies, so: internet)

```bash
cd ~/obsidian/src
npm --prefix obsidian-core ci
npm --prefix obsidian-core run build
npm --prefix obsidian-core test                                    # 246
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build
npm --prefix obsidian-interface test                              # 191
node scripts/check-invariants.mjs                                 # 55
node --test cloudflare/test/worker.test.mjs                       # 9
node --test tests/scripts/release-signing.test.mjs                # 9
node --test tests/e2e/cluster.test.mjs      # 13 — starts 3 real nodes, ~1 minute
```

468 in total. Build the core before the interface, and the interface before
testing it, or you will get spurious `../../core/*.js` failures.

## 13. Prove the 1.2.17 wallet fix (the `obs1`-on-devnet bug)

Before 1.2.17 the browser wallet derived a **mainnet** `obs1…` address no matter
which network the interface was on, and the node then refused everything it
signed with `not a valid address for this network`. Four checks, with the node
and the interface both running:

**1 — the node tells the interface which network it is.**

```bash
curl -s "localhost:8788/api/rpc?path=/network" | head -c 200; echo
```

Must contain `"addressHrp":"dobs"` and `"chainId":7780`. The wallet page reads
exactly this before it derives anything.

**2 — a mainnet address is still rejected by the node (it always was).**

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:38630/wallet/balance \
  -H 'content-type: application/json' \
  -d '{"address":"obs16ahf37l5ums7ln2q9kv5rc7rrufswn5d755ete"}'
```

`400`. That is correct and is not the bug — the bug was the interface handing
you that address in the first place.

**3 — a devnet address is accepted.** Make one offline, then ask for its balance:

```bash
cd ~/obsidian/run/node/obsidian-core
ADDR=$(node dist/index.js wallet new --network devnet | grep -o 'dobs1[0-9a-z]*' | head -1)
echo "$ADDR"
curl -s -X POST localhost:38630/wallet/balance -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\"}"; echo
```

The address must start `dobs1` and the balance call must answer `200` with
`"balanceObs":"0.000000000000000000"`.

**4 — the browser wallet, which is where the bug lived.** Open
`http://127.0.0.1:8788/wallet/`:

* With no vault, create one. The address shown must start **`dobs1`**, and the
  page must name the network as `devnet`.
* Stop the node (Ctrl-C), reload the page: it must **refuse to offer wallet
  creation at all** and say it cannot tell which network you are on. Deriving
  blind is what caused the bug.
* If you already hold an old `obs1…` vault from 1.2.1, unlock it: the page now
  says *"This wallet is a mainnet wallet, but this interface is on devnet"* and
  offers to re-derive. Accept it — the 24 words and the private key do not
  change, only the address does. Then `/mine/` will let you claim; before
  1.2.17 it let you sign a claim the node could only throw away.

## 14. Stop and reset

```bash
# Ctrl-C in the node session and the interface session, then:
termux-wake-unlock

# wipe devnet and start from height 0 again
rm -rf ~/obsidian/run/node/obsidian-core/data/devnet
rm -rf ~/obsidian/run/n2 ~/obsidian/run/n3
rm -rf ~/obsidian/run/iface-data     # also un-burns the Genesis Invitation
```

Deleting `iface-data` is what lets you reuse the same devnet Genesis
Invitation: redemption is recorded per deployment, in that folder. Generate a
fresh invitation (step 4) if you would rather not reuse the code.

---

### Upgrading an interface you have already opened in a browser

From 1.2.17 the markup points at content-hashed bundles
(`/js/wallet.js?v=<hash>`), so a new build gets a new URL and your browser
cannot serve you the old one. Check it after any upgrade:

```bash
curl -s localhost:8788/wallet/ | grep -o 'src="[^"]*"'
```

That must print `src="/js/wallet.js?v=…"` with a 16-character hash, and the hash
must change whenever the bundle does.

If you first opened the interface on **1.2.3 or earlier**, that browser is still
holding an un-hashed, cacheable copy of the old bundle and will keep running it.
Clear it once: in Chrome on Android, ⋮ → History → Clear browsing data →
*Cached images and files*; or just open the page in a new Incognito tab. A fixed
page that a cache keeps you from loading looks exactly like a page that was
never fixed — this is what made the wallet appear to still produce `obs1…`
addresses after the fix had been installed.

### Known footguns

* **Do not use your mainnet Genesis Invitation here.** Redemption is permanent
  for whichever deployment spends it.
* One node, one data directory. Two nodes sharing `./data/devnet` corrupt it.
* `--seeds` wants **P2P** ports (`38631`, `38641`, …), never RPC ports.
* `--rpc-host 0.0.0.0` exposes the node to your whole Wi-Fi network. On devnet
  that is only a nuisance, but keep the default `127.0.0.1` unless you mean it.
* If `npm ci` fails with a compiler error, install build tools:
  `pkg install -y build-essential python` — or use the four-package install in
  step 3, which needs no compiler.
* Android will kill a backgrounded Termux without `termux-wake-lock`. A node
  that gets killed is not a bug in the protocol.
