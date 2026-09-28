# Self-host the interface

The interface is a reader: it serves static pages and proxies an allowlist of
reads to Obsidian Core nodes. It stores no chain data, no keys and no funds.
Deleting it changes nothing about the chain.

## 1. Build

```bash
git clone https://github.com/EmoluxLabs/Obsidian-Network.git
cd Obsidian-Network/obsidian-interface
npm ci
npm run build      # builds core → copies browser-safe modules → bundles 11 sites → typecheck
npm test           # 61 tests: tokens, store, node pool, real HTTP server, config discovery
npm run verify     # typecheck + build + test in one shot
```

`npm run build` does four things worth knowing about:

1. builds `obsidian-core` and copies only the browser-safe modules into
   `web/core` (the sync **fails** if any copied module imports a Node built-in);
2. bundles 11 page entries with `esbuild --platform=browser`;
3. runs `scripts/check-browser-safe.mjs`, which refuses node built-ins and
   `process.env` reads in the shipped bundles;
4. writes the site directories (`landing/`, `mine/`, `wallet/`, `explorer/`,
   `social/`, `capsule/`, `ons/`, `circle/`, `developer/`, `app/`, `audit/`) at
   the repository root, each with its own `index.html`.

## 2. Configure

```ini
# /etc/obsidian/interface.env
OBSIDIAN_NODE_URLS=http://127.0.0.1:8630,http://node2.example:8630
OBSIDIAN_INTERFACE_HOST=127.0.0.1
OBSIDIAN_INTERFACE_PORT=8788
OBSIDIAN_INTERFACE_DATA_DIR=/var/lib/obsidian-interface
OBSIDIAN_GOOGLE_CLIENT_ID=
OBSIDIAN_INTERFACE_TRUST_PROXY=false
```

Everything is also a flag (`--nodes`, `--port`, `--data-dir`, `--google-client-id`,
`--allow-origin`, `--max-invites`, `--trust-proxy`, `--log-level`). The interface
**refuses to start** if the built assets, the site shells or the node list are
missing: a half-configured reader that silently reads the wrong chain is worse
than one that does not boot.

List **two or more nodes**, ideally ones you run. The interface scores them by
height and latency, fails over automatically, refuses to blend two chains by
flagging a genesis mismatch, and returns `503 ERR_NO_HEALTHY_NODE` rather than
inventing data when everything is down.

## 3. Run it

```bash
# foreground
node dist/server/main.js

# systemd
sudo install -m 0644 deployment/systemd/obsidian-interface.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now obsidian-interface

# docker (context is the repository root; see deployment/docker/Dockerfile)
docker build -f obsidian-interface/deployment/docker/Dockerfile -t obsidian/interface .
docker run -d --rm -p 127.0.0.1:8788:8788 \
  -e OBSIDIAN_NODE_URLS=http://host.docker.internal:8630 --add-host host.docker.internal:host-gateway \
  obsidian/interface:1.0.0

# nginx in front (TLS + cache), see deployment/nginx/obsidian-interface.conf
```

`deployment/docker/verify.sh` builds the image, starts it, waits for
`/api/health`, fetches the landing page and a bundle, and checks that the security
headers are present. **Run it in your environment**: a Dockerfile is not proof of
deployability.

## 4. Accounts (optional)

Sign-in is invite-only and disabled entirely when `OBSIDIAN_GOOGLE_CLIENT_ID` is
empty — the wallet, miner, explorer, ONS, capsules, circle and social pages all
keep working without an account, because they need a *wallet*, not an account.

When enabled:

* the ID token is verified server-side against Google's JWKS (RS256, issuer,
  audience, expiry, `email_verified`, ±60 s clock skew);
* the first account bootstraps the deployment; every later account needs an
  unused invite code;
* each account may issue at most **5** invites, enforced by the server;
* sessions are HttpOnly, SameSite=Lax cookies (14 days), and the store contains no
  key material — asserted by the test suite.

The account page is the only surface whose Content-Security-Policy allows
`accounts.google.com`; every other page keeps `script-src 'self'` with no inline
scripts at all.

## 5. Behind Cloudflare

See `cloudflare/README.md`. The short version: CDNs are allowed to *cache* chain
reads for a few seconds and are never allowed to answer a write, a session check
or an account query. If Cloudflare is down, your nodes keep producing blocks and
your own interface keeps working — only the edge copy stops.

## 6. Operating notes

| Task | Command |
| --- | --- |
| Check what it can see | `curl -s localhost:8788/api/health \| jq` |
| Force a node health sweep | `curl -s -X POST localhost:8788/api/nodes/refresh` |
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
