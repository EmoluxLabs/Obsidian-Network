# Self-host the interface

The interface is a reader: it serves static pages and proxies an allowlist of
reads to Obsidian Core nodes. It stores no chain data, no keys and no funds.
Deleting it changes nothing about the chain.

## 1. Build

```bash
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network/obsidian-interface
npm ci
npm run build      # builds core → copies browser-safe modules → bundles 9 sites → typecheck
npm test           # store, node pool, real HTTP server, config discovery, hardening, wallet vault, browser pages, live node
npm run verify     # typecheck + build + test in one shot
```

`npm run build` does four things worth knowing about:

1. builds `obsidian-core` and copies only the browser-safe modules into
   `web/core` (the sync **fails** if any copied module imports a Node built-in);
2. bundles 9 page entries with `esbuild --platform=browser`;
3. runs `scripts/check-browser-safe.mjs`, which refuses node built-ins and
   `process.env` reads in the shipped bundles;
4. writes the nine site directories (`landing/`, `mine/`, `wallet/`,
   `explorer/`, `ons/`, `node/`, `developer/`, `app/`, `audit/`) at the
   repository root, each with its own `index.html`.

## 2. Configure

```ini
# /etc/obsidian/testnet/interface.env — one file per network (see deployment/interface.env.example)
OBSIDIAN_NODE_URLS=http://127.0.0.1:18630,http://node2.example:18630
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_TRUST_PROXY=false
```

With the template unit (`obsidian-interface@testnet`) the network and data directory come from the
instance name, so the file holds only the rest. With the plain `obsidian-interface.service` add
`OBSIDIAN_INTERFACE_NETWORK=testnet` and `OBSIDIAN_INTERFACE_DATA_DIR=/var/lib/obsidian-interface`. An
environment file has no trailing comments: text after a value becomes part of the value. If the file, a
flag and `OBSIDIAN_NETWORK` name different networks the interface refuses to start.

Everything is also a flag (`--network`, `--nodes`, `--port`, `--data-dir`,
`--allow-origin`, `--max-invites`, `--trust-proxy`, `--log-level`). The interface
**refuses to start** if the network is not named, or if the built assets, the
site shells or the node list are missing: a half-configured reader that silently
reads the wrong chain is worse than one that does not boot.

**One interface, one network.** The network you name decides which nodes are
accepted: a node that follows another network or chain id is excluded from every
read (`/api/nodes` says `wrong network: …`), and if *all* of them are, the proxy
answers `503 ERR_WRONG_NETWORK` instead of showing another chain's data. It also
decides the defaults, so two interfaces on one host cannot collide:

| Network | Interface port | Default node |
| --- | --- | --- |
| mainnet | 8788 | `http://127.0.0.1:8630` |
| testnet | 18788 | `http://127.0.0.1:18630` |
| staging | 28788 | `http://127.0.0.1:28630` |
| devnet | 38788 | `http://127.0.0.1:38630` |

The interface listens on **127.0.0.1** unless told otherwise (`--host 0.0.0.0`),
so putting nginx in front is not undone by the raw port also being reachable.

**Protecting it.** Registration hashes passwords (slow on purpose) and so
does sign-in. Hashing runs on the thread pool, never on the event loop, and every
costly route is rationed per client address: 30 auth attempts burst then one
every 3 seconds, 300 proxied reads burst then 10 a second, and one `nodes/refresh`
every 2 seconds for the whole deployment. Behind a reverse proxy set
`OBSIDIAN_INTERFACE_TRUST_PROXY=true`: the limits then apply per *visitor* (the
last `X-Forwarded-For` entry, which is the one your proxy appended), the session
cookie is marked `Secure`, and `X-Forwarded-Host`/`-Proto` are trusted.

List **two or more nodes**, ideally ones you run. The interface scores them by
height and latency, fails over automatically, refuses to blend two chains by
flagging a genesis mismatch, and returns `503 ERR_NO_HEALTHY_NODE` rather than
inventing data when everything is down.

## 3. Run it

```bash
# foreground: the network is always named, and its own port follows (testnet: 18788)
node dist/server/main.js --network testnet

# systemd: one instance per network, the text after the @ is the network
# (settings in /etc/obsidian/testnet/interface.env, data in /var/lib/obsidian/testnet/interface)
sudo install -m 0644 deployment/systemd/obsidian-interface@.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now obsidian-interface@testnet
# (obsidian-interface.service, without the @, is the same unit for a machine that runs one
#  network only; it takes OBSIDIAN_INTERFACE_NETWORK from its settings file)

# docker (context is the repository root; see deployment/docker/Dockerfile)
docker build -f obsidian-interface/deployment/docker/Dockerfile -t obsidian/interface .
# the container always listens on 8788 inside; the host side is the network's own port (testnet 18788)
docker run -d --rm -p 127.0.0.1:18788:8788 \
  -e OBSIDIAN_INTERFACE_NETWORK=testnet \
  -e OBSIDIAN_NODE_URLS=http://host.docker.internal:18630 --add-host host.docker.internal:host-gateway \
  obsidian/interface:1.6.1

# nginx in front (TLS + cache), see deployment/nginx/obsidian-interface.conf
```

`deployment/docker/verify.sh` builds the image, starts it, waits for
`/api/health`, fetches the landing page and a bundle, and checks that the security
headers are present. **Run it in your environment**: a Dockerfile is not proof of
deployability.

## 4. Accounts (optional)

Sign-in is invite-only and disabled entirely when no Genesis Invitation hash is
empty — the wallet, miner, explorer, ONS and node pages all keep working
without an account, because they need a *wallet*, not an account.

When enabled:

* registration takes a Gmail address, a password of at least 12 characters, and
  an invite code; the address is canonicalised **server-side** (dots and `+tags`
  removed, `googlemail.com` folded into `gmail.com`) so one inbox gets one
  mining account, whatever the page claims;
* passwords are stored only as salted scrypt hashes (N=32768), and there is no
  password reset and no email verification — ten single-use recovery codes are
  issued once at registration and shown once;
* multi-factor is TOTP (RFC 6238, 6 digits, 30 s, ±1 step), verified in this
  process with the consumed step recorded so a code cannot be replayed; mining
  stays closed on an account until MFA is confirmed;
* the first account bootstraps the deployment; every later account needs an
  unused invite code;
* each account may issue at most **5** invites, enforced by the server;
* sessions are HttpOnly, SameSite=Lax cookies (14 days), and the store contains no
  key material — asserted by the test suite.

Sign-in is entirely first-party, so **every** page — the account page included —
serves `script-src 'self'`, `connect-src 'self'` and `frame-src 'none'`, with no
third-party origin anywhere in the policy and no inline scripts at all.

## 5. Behind Cloudflare

See `cloudflare/README.md`. The short version: CDNs are allowed to *cache* chain
reads for a few seconds and are never allowed to answer a write, a session check
or an account query. If Cloudflare is down, your nodes keep producing blocks and
your own interface keeps working — only the edge copy stops.

## 6. Operating notes

| Task | Command |
| --- | --- |
| Check what it can see | `curl -s localhost:<interface port>/api/health \| jq` |
| Force a node health sweep | `curl -s -X POST localhost:<interface port>/api/nodes/refresh` |
| See which node answered | response header `x-obsidian-node` |
| Account/invite store | `<data-dir>/interface-accounts.json` (0600, atomic writes; a corrupt file is quarantined, never silently emptied) |
| Logs | JSON lines on stdout; `--log-level debug` for per-request detail |

## 7. What it will not do

* It will not sign anything for you: there is no server-side key and no signing
  endpoint.
* It will not show a wallet balance on the explorer surface, and its proxy does not
  expose balance routes there.
* It will not keep working “from cache” when the nodes are gone: it says
  `ERR_NO_HEALTHY_NODE` and stops, because a stale chain served confidently is a
  lie.
