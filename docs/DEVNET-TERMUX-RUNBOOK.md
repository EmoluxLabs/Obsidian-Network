# Devnet on Termux — start a node and test the whole platform

Every command below was run end to end before this page was written, against
the **1.2.13 release archives**, not a working tree. Paste them into **Termux on
Android** (on a laptop: Git Bash on Windows, or any shell on Linux/macOS —
**not** PowerShell).

Devnet is a throwaway network. chainId `7780`, addresses start `dobs1`, and
nothing on it has value. You cannot damage mainnet from here.

**Internet:** needed for steps 1, 2 and 3 only. Steps 4 onwards run offline —
you can switch on aeroplane mode after step 3 and the node will keep producing
blocks on its own.

---

## 1. Install the tools (internet)

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs git termux-api
termux-wake-lock
node -v   # must print v20 or newer
```

`termux-wake-lock` stops Android from suspending the node the moment the screen
goes off. Release it later with `termux-wake-unlock`.

## 2. Get the release and verify it (internet)

Do not skip the verification. An archive you have not checked is a download,
not a release.

```bash
mkdir -p ~/obsidian && cd ~/obsidian
git clone --depth 1 --branch v1.2.13 \
  https://github.com/EmoluxLabs/Obsidian-Network.git src
cd ~/obsidian/src/releases
sha256sum -c SHA256SUMS
```

Every line must say `OK`. If any line says `FAILED`, stop — delete the folder
and start again; do not run the code.

Then check the archive you are about to use actually extracts, builds and
passes its own tests:

```bash
cd ~/obsidian/src
./scripts/verify-release.sh releases/obsidian-node-operator-1.2.13.tar.gz
```

It should end with `OK: obsidian-node-operator-1.2.13.tar.gz verified.`

## 3. Unpack and install (internet — the last step that needs it)

```bash
mkdir -p ~/obsidian/run/node ~/obsidian/run/iface
cd ~/obsidian/src/releases
tar xzf obsidian-node-operator-1.2.13.tar.gz      -C ~/obsidian/run/node
tar xzf obsidian-interface-selfhost-1.2.13.tar.gz -C ~/obsidian/run/iface

cd ~/obsidian/run/node/obsidian-core      && npm ci --omit=dev
cd ~/obsidian/run/iface/obsidian-interface && npm ci --omit=dev
```

`npm ci --omit=dev` is the **only** step that needs the network. Everything
after this works with the radio off.

## 4. Start the devnet node (offline from here on)

```bash
cd ~/obsidian/run/node/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='pick-any-devnet-passphrase'
node dist/index.js start \
  --network devnet \
  --data-dir ./data/devnet \
  --mine \
  --log-level info
```

Leave this session running. Within about five seconds you should see
`produced block` lines, one every five seconds. The startup line must say
`"chainId":7780` and `"version":"1.2.13"`.

Open a **second Termux session** (swipe from the left edge → **New session**)
for everything below.

## 5. Check the node is honest about itself

```bash
curl -s localhost:38630/health | head -c 400; echo
```

Four things to look at:

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
curl -s localhost:38630/audit/compliance   | head -c 600; echo
curl -s localhost:38630/audit/decentralization | head -c 600; echo
```

In `/audit/compliance`, all sixteen rows must read `"present":false`. In
`/audit/decentralization`, all ten answers must be `NO`.

## 6. Make a wallet, with the radio off

Turn on **aeroplane mode** first. The point is to prove key generation never
needs a network.

```bash
cd ~/obsidian/run/node/obsidian-core
node dist/index.js wallet new --network devnet
```

Write the 24 words on paper. Nothing is stored: that output is the only copy.
When you are done reading, clear the scrollback so the words are not sitting in
a buffer:

```bash
clear && printf '\033[3J'
```

## 7. Start the interface (the 12 sites)

```bash
cd ~/obsidian/run/iface/obsidian-interface
export OBSIDIAN_NODE_URLS=http://127.0.0.1:38630
export OBSIDIAN_INTERFACE_HOST=127.0.0.1
export OBSIDIAN_INTERFACE_PORT=8788
export OBSIDIAN_INTERFACE_DATA_DIR=$HOME/obsidian/run/iface-data
export OBSIDIAN_GENESIS_INVITE_HASH='PASTE-YOUR-DEVNET-HASH-HERE'
node dist/server/main.js
```

Use **single quotes** around the hash — it contains `$`, and double quotes
would let the shell eat it.

Then open `http://127.0.0.1:8788/` in your phone's browser. All twelve sites
are paths on that one port:

```
/  /app/  /mine/  /wallet/  /explorer/  /circle/
/ons/  /social/  /capsule/  /node/  /audit/  /developer/
```

Or check them all at once from a third session:

```bash
for p in / /app/ /mine/ /wallet/ /explorer/ /circle/ /ons/ /social/ /capsule/ /node/ /audit/ /developer/; do
  printf "%-12s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8788$p)"
done
```

Twelve `200`s.

## 8. Test the new account system

This is the part that changed in 1.2.0: no Google, no email, no password reset.

```bash
curl -s localhost:8788/api/auth/config; echo
```

Expect `"authMethod":"GMAIL_PASSWORD_MFA"`, `"accountsExist":false` and
`"genesisInvite":{"configured":true,"redeemed":false}`.

Register the first account in the browser at `http://127.0.0.1:8788/app/` —
Gmail address, a password of 12+ characters, and your **devnet** Genesis
Invitation. The page then shows ten recovery codes **once**; copy or download
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

## 9. Read the chain through the interface

The browser never talks to the node directly; the interface proxies it:

```bash
curl -s "localhost:8788/api/nodes"; echo
curl -s "localhost:8788/api/rpc?path=/status" | head -c 300; echo
curl -s "localhost:8788/api/rpc?path=/audit/compliance" | head -c 300; echo
```

`"genesisMismatch":false` means the interface and the node agree on which chain
this is.

## 10. Run the test suites yourself (needs dev dependencies, so: internet)

```bash
cd ~/obsidian/src
npm --prefix obsidian-core ci && npm --prefix obsidian-core test        # 240
npm --prefix obsidian-interface ci
npm --prefix obsidian-interface run build
npm --prefix obsidian-interface test                                    # 168
node scripts/check-invariants.mjs                                       # 55
node --test cloudflare/test/worker.test.mjs                             # 7
node --test tests/e2e/cluster.test.mjs    # 13 — starts 3 real nodes, ~1 minute
```

Build the interface **before** testing it, or you will get spurious
`../../core/*.js` failures.

## 10b. Prove the 1.2.13 wallet fix (the `obs1`-on-devnet bug)

Before 1.2.13 the browser wallet derived a **mainnet** `obs1…` address no matter
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

**3 — a devnet address is accepted.** Make one offline, then ask for its
balance:

```bash
cd ~/obsidian/run/node/obsidian-core
ADDR=$(node dist/index.js wallet new --network devnet | grep -o 'dobs1[0-9a-z]*' | head -1)
echo "$ADDR"
curl -s -X POST localhost:38630/wallet/balance -H 'content-type: application/json' \
  -d "{\"address\":\"$ADDR\"}"; echo
```

The address must start `dobs1` and the balance call must answer `200` with
`"balanceObs":"0"`.

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
  1.2.13 it let you sign a claim the node could only throw away.

## 11. Stop and reset

```bash
# Ctrl-C in the node session and the interface session, then:
termux-wake-unlock

# wipe devnet and start from height 0 again
rm -rf ~/obsidian/run/node/obsidian-core/data/devnet
rm -rf ~/obsidian/run/iface-data     # also un-burns the Genesis Invitation
```

Deleting `iface-data` is what lets you reuse the same devnet Genesis
Invitation: redemption is recorded per deployment, in that folder.

---

### Upgrading an interface you have already opened in a browser

From 1.2.13 the markup points at content-hashed bundles
(`/js/wallet.js?v=<hash>`), so a new build gets a new URL and your browser
cannot serve you the old one. Check it after any upgrade:

```bash
curl -s localhost:8788/wallet/ | grep -o 'src="[^"]*"'
```

That must print `src="/js/wallet.js?v=…"` with a 16-character hash, and the
hash must change whenever the bundle does.

If you first opened the interface on **1.2.3 or earlier**, that browser is
still holding an un-hashed, cacheable copy of the old bundle and will keep
running it. Clear it once: in Chrome on Android, ⋮ → History → Clear browsing
data → *Cached images and files*; or just open the page in a new Incognito
tab. A fixed page that a cache keeps you from loading looks exactly like a page
that was never fixed — this is what made the wallet appear to still produce
`obs1…` addresses after the fix had been installed.

### Known footguns

* **Do not use your mainnet Genesis Invitation here.** Redemption is permanent
  for whichever deployment spends it.
* `--rpc-host 0.0.0.0` exposes the node to your whole Wi-Fi network. On devnet
  that is only a nuisance, but keep the default `127.0.0.1` unless you mean it.
* If `npm ci` fails with a compiler error, you are missing build tools:
  `pkg install -y build-essential python`.
* Android will kill a backgrounded Termux without `termux-wake-lock`. A node
  that gets killed is not a bug in the protocol.
