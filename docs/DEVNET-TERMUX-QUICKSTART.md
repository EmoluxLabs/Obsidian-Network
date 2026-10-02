# Devnet on Termux — build from source, run a node, bring the platform up

Copy-paste commands for **Termux on Android**. At the end you have a devnet
chain producing blocks on your phone and all twelve sites open in your browser.

This targets **protocol 1.3.0 built from the branch**, not a release archive.
There are no 1.3.0 archives yet, so everything is built from source. (The older
`DEVNET-TERMUX-RUNBOOK.md` is pinned to the shipped 1.2.16 archives and is still
correct *for that release* — it will not give you the 1.3.0 fixes.)

> **devnet is a toy chain.** Chain id `7780`, addresses start `dobs1`, and it is
> wiped whenever you delete the data directory. No devnet OBS is worth anything
> and a `dobs1…` address is rejected by every other network.

---

## 0. What you will end up running

| | |
|---|---|
| Node RPC | `http://127.0.0.1:38630` |
| Node p2p | `0.0.0.0:38631` |
| Interface (12 sites) | `http://127.0.0.1:8788` |
| Chain id / prefix | `7780` / `dobs1` |
| Protocol version | `1.3.0` |
| Params hash | `286b5a6f0bcfef5a3e77ca02e726d260` |
| Devnet genesis hash | `068889406778de25525fbd4ae0f455b86f9470379a94d9568b00aaff32b92d6a` |

Two long-running processes, so you need two shells. Section 1 installs `tmux`
for that.

---

## 1. Install the tools (needs internet)

```bash
pkg update -y && pkg upgrade -y
pkg install -y nodejs-lts git tmux
```

Check the version — the build needs **Node 20.10 or newer**:

```bash
node -v && npm -v && git --version
```

Keep Android from suspending your node the moment the screen goes off:

```bash
termux-wake-lock
```

---

## 2. Get the code

```bash
mkdir -p ~/obsidian && cd ~/obsidian
git clone --branch arena/01a0fc55-obsidian-network \
  https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network
```

Already cloned? Update instead:

```bash
cd ~/obsidian/Obsidian-Network
git fetch origin && git checkout arena/01a0fc55-obsidian-network && git pull
```

---

## 3. Install dependencies and build (needs internet — last step that does)

```bash
cd ~/obsidian/Obsidian-Network
npm ci --prefix obsidian-core
npm ci --prefix obsidian-interface
```

Build the node, then the interface. The interface build **also rebuilds the
core and regenerates `web/core/`**, so run it second and do not skip it:

```bash
npm --prefix obsidian-core run build
npm --prefix obsidian-interface run build
```

Expected tail of the second command:

```
built 12 browser entries (browser-safe ✓)
browser bundles are free of node built-ins and process.env reads ✓
wrote 12 site shells (landing → root, others → their own directories)
```

This is the slowest step on a phone — a few minutes is normal.

Confirm you built 1.3.0:

```bash
node obsidian-core/dist/index.js version
```

---

## 4. Prove the chain identity before you run it

```bash
node obsidian-core/dist/index.js genesis init --network devnet
```

`genesisHash` must be
`068889406778de25525fbd4ae0f455b86f9470379a94d9568b00aaff32b92d6a` and
`paramsHash` must be `286b5a6f0bcfef5a3e77ca02e726d260`. Run it twice — the same
two values, every time, on every machine. If they differ you are not running
the protocol this document describes.

---

## 5. Start the node

Open a tmux session so the node survives you switching apps:

```bash
tmux new -s node
```

Inside it:

```bash
cd ~/obsidian/Obsidian-Network/obsidian-core
export OBSIDIAN_KEYSTORE_PASSPHRASE='pick-a-long-devnet-passphrase'
node dist/index.js start \
  --network devnet \
  --data-dir "$HOME/obsidian/data" \
  --keystore "$HOME/obsidian/data/node-key.json" \
  --mine \
  --log-level info
```

You want these lines:

```
chain ready        height=0  genesisId=f34124f3…
rpc listening      0.0.0.0:38630
obsidian core ready
```

Then a `block produced` roughly every 5 seconds.

Detach with **Ctrl-b** then **d**. Reattach any time with `tmux attach -t node`.

The passphrase encrypts the node's identity key. Any string works on devnet,
but if you lose it you cannot reuse that data directory — delete it and start
from height 0.

---

## 6. Check the node is telling the truth

New shell (swipe from the left edge → **New session**, or `tmux new -s check`):

```bash
cd ~/obsidian/Obsidian-Network
curl -s localhost:38630/status | head -c 400; echo
```

Height should climb every few seconds. `protocolVersion` must be `1.3.0` and
`paramsHash` must match section 4.

```bash
# Proof of Time — the consensus identity, with no hash rate anywhere
curl -s localhost:38630/pot | head -c 300; echo

# supply invariant, recomputed from state rather than asserted
curl -s localhost:38630/supply | head -c 300; echo

# the validator rotation, including the round and the liveness backstop
curl -s localhost:38630/validators; echo
```

---

## 7. Make a wallet (do this with the radio off if you like)

```bash
cd ~/obsidian/Obsidian-Network
node obsidian-core/dist/index.js wallet new --network devnet
```

Prints an address, a derivation path and a 24-word recovery phrase, **once**,
and stores nothing. The address starts `dobs1`. On 1.3.0 this is real BIP-32 —
the phrase restores the same keys in any standard wallet, which was not true
before.

Check whether that address may mine:

```bash
ADDR=dobs1…paste-yours
curl -s "localhost:38630/mining/status?address=$ADDR" | head -c 400; echo
```

A fresh devnet address comes back `"eligible": true` with
`"claimsRemainingInCycle": 6`. The **first** valid claim on a fresh chain also
takes the 100,000 OBS genesis allocation.

---

## 8. Create the Genesis Invitation

The first interface account needs a one-time invite. Generate it:

```bash
cd ~/obsidian/Obsidian-Network
node scripts/new-genesis-invite.mjs
```

It prints a code (`OBS-GENESIS-…`) **once** and a hash. **Write the code down
now** — it is not recoverable, and you need it to register. Copy the long
`scrypt$…` hash for the next step.

---

## 9. Start the interface

Third session (`tmux new -s iface`):

```bash
cd ~/obsidian/Obsidian-Network/obsidian-interface
export OBSIDIAN_NODE_URLS=http://127.0.0.1:38630
export OBSIDIAN_INTERFACE_HOST=127.0.0.1
export OBSIDIAN_INTERFACE_PORT=8788
export OBSIDIAN_INTERFACE_DATA_DIR=$HOME/obsidian/iface-data
export OBSIDIAN_GENESIS_INVITE_HASH='scrypt$32768$8$1$…paste the whole hash…'
node dist/server/main.js
```

**Single quotes around the hash.** It contains `$`, and double quotes let the
shell eat it.

Wait for `interface listening  port=8788  nodes=1`.

Now open **`http://127.0.0.1:8788/`** in your phone's browser. All twelve sites
are paths on that one port:

```
/   /app/   /mine/   /wallet/   /explorer/   /circle/
/ons/   /social/   /capsule/   /node/   /audit/   /developer/
```

Check them all at once:

```bash
for p in / /app/ /mine/ /wallet/ /explorer/ /circle/ /ons/ /social/ /capsule/ /node/ /audit/ /developer/; do
  printf "%-12s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' localhost:8788$p)"
done
```

Twelve `200`s.

---

## 10. Register and mine

```bash
curl -s localhost:8788/api/auth/config; echo
```

Expect `"accountsExist":false` and `"genesisInvite":{"configured":true,"redeemed":false}`.

In the browser at **`http://127.0.0.1:8788/app/`**:

1. Register with a Gmail address, a 12+ character password, and the
   `OBS-GENESIS-…` code from section 8.
2. Save the ten recovery codes — shown **once**.
3. Add the TOTP secret to an authenticator app and enter the 6-digit code.
   Mining opens on the account only after this.
4. Go to **`/mine/`**, paste the `dobs1…` address from section 7, and claim.

Watch the balance land from the shell:

```bash
curl -s -X POST localhost:38630/wallet/balance \
  -H 'content-type: application/json' -d "{\"address\":\"$ADDR\"}"; echo
```

The first successful claim pays `100000.000166666666666666` OBS — the genesis
allocation plus one claim reward.

The browser never talks to the node directly; everything goes through the
interface's single proxy route, `/api/rpc?path=…`:

```bash
# GET
curl -s "localhost:8788/api/rpc?path=/status" | head -c 300; echo

# GET with a query of its own — URL-encode the ? and = as %3F and %3D
curl -s "localhost:8788/api/rpc?path=/mining/status%3Faddress%3D$ADDR" | head -c 200; echo

# POST — the body is forwarded as-is
curl -s -X POST "localhost:8788/api/rpc?path=/wallet/balance" \
  -H 'content-type: application/json' -d "{\"address\":\"$ADDR\"}" | head -c 200; echo
```

---

## 11. Reaching it from another device (optional)

By default both services bind to `127.0.0.1`, which is phone-only. To open them
to your Wi-Fi:

```bash
# node:      add --rpc-host 0.0.0.0
# interface: export OBSIDIAN_INTERFACE_HOST=0.0.0.0
ifconfig 2>/dev/null | grep 'inet ' | grep -v 127.0.0.1
```

Then browse to `http://<that-ip>:8788/` from a laptop on the same network.

Only do this on a network you trust. `rpcAllowSubmit` is `true` on devnet, so
anyone who can reach port 38630 can submit transactions to your node.

---

## 12. Stop, reset, start over

Ctrl-C in each tmux session, then:

```bash
tmux kill-server
termux-wake-unlock

# wipe the chain and the interface accounts, back to height 0
rm -rf ~/obsidian/data ~/obsidian/iface-data
```

The genesis invite hash is tied to the interface data directory's account
state; after wiping, generate a fresh invite (section 8).

---

## Known footguns

- **Build the interface, not just the core.** `npm --prefix obsidian-interface
  run build` is what regenerates `web/core/`. Skipping it leaves the browser
  bundles stale or missing, and the sites fail in ways that look like node bugs.
- **The node RPC rejects browser requests by default.** It refuses any request
  carrying an `Origin` header unless you pass `--cors`. This is deliberate —
  reach the chain through the interface on 8788, not directly on 38630.
- **Android will kill a backgrounded node.** `termux-wake-lock` before you
  start, and leave Termux running. Battery optimisation for Termux should be
  disabled in Android settings for anything long.
- **Devnet addresses are `dobs1`.** A `obs1…` mainnet address is rejected here,
  on purpose.
- **A 1.2.x node will not peer with this one.** `MIN_CORE_VERSION` is 1.3.0 and
  the params hash changed; the handshake refuses, with a reason.
- **Low on space?** `node_modules` for both packages plus the build is a few
  hundred MB. `df -h $HOME` before you start.
