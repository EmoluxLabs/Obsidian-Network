# Obsidian Interface

The reader: a self-hostable web server that serves the Obsidian Network apps
(wallet, miner, explorer, ONS, Circle, Capsules, Social, developer docs and the
compliance audit) on top of one or more **Obsidian Core** nodes.

The interface is a *cache with an allowlist*, never an authority:

* It cannot create, move, price or decide anything — every number it shows is
  fetched from a node and re-fetched on the next page.
* It never holds a wallet key or a recovery phrase. Wallets are created and
  transactions are signed **in the browser**, and only signed bytes are relayed.
* Its `/api/rpc` proxy is an exact-route allowlist: the route is matched, the
  query string is forwarded to the node (`/blocks?limit=`, `/mining/status?address=`),
  and anything off the list is refused with `ERR_REJECTED`. There is no SPA
  fallback: an unknown path is an honest 404.
* It stops rather than guessing: no healthy node ⇒ `503 ERR_NO_HEALTHY_NODE`, a
  genesis mismatch between nodes is flagged instead of blended.

## Requirements

* Node.js **>= 20.10**, npm
* One or more Obsidian Core nodes to read from (two or more recommended)

## Install and build

```bash
npm ci
npm run build     # compile the server, typecheck, bundle the browser apps, write the 11 site shells
npm test          # 112 tests: auth, invites, store, node pool, HTTP server, config discovery,
                  # amount formatters, jsdom page tests, and a suite that drives the real
                  # pages against a real obsidian-core node (needs `npm run build` first)
```

`npm run build` writes:

* `dist/` — the compiled server
* `public/js/`, `public/css/`, `public/assets/` — browser bundles and brand assets
* the site shells (`landing/index.html`, `mine/index.html`, …) at `$SITE_ROOT`

## Run

```bash
export OBSIDIAN_NODE_URLS=http://127.0.0.1:8630,http://node2.example:8630
node dist/server/main.js --port 8788
```

All flags are listed by `--help`: `--host --port --nodes --data-dir --site-root
--public-dir --core-dir --google-client-id --allow-origin --max-invites
--trust-proxy --log-level`. Every one of them has an `OBSIDIAN_*` environment
equivalent (`deployment/interface.env.example`).

### Where the site shells are found

`--site-root` is the directory that holds `landing/`, `mine/`, `wallet/`, … When
it is not given, the interface looks in the checkout layout first (the parent of
this package, i.e. the repository root) and then inside this package — which is
the layout of the self-contained `obsidian-interface-selfhost` release. If the
shells are missing it **refuses to start** instead of serving a blank page.

A Dockerfile is not proof of deployability: `deployment/docker/verify.sh` builds
the image, starts it, waits for `/api/health` and checks headers and assets. Run
it in your environment.

## Security posture

| Property | How |
| --- | --- |
| Invite-only, server-enforced | Google ID tokens are verified against Google's JWKS **server-side**; `isGoogleUser: true` from a client is ignored; 5 invites per account, enforced in the store |
| Keys never leave the browser | wallet creation, keystore (PBKDF2 210k + AES-GCM) and signing happen in `web/src/lib/wallet.ts`; the server only ever sees signed transaction bytes |
| No balance surveillance | balances are only served by an explicit `POST /api/rpc` to `/wallet/balance`; explorer routes mask addresses |
| Cache safety | `/api/auth/*`, wallet and node-refresh routes are never cached; the Cloudflare worker in `../cloudflare` enforces the same rule at the edge |
| Headers | strict CSP, no wildcard CORS, `x-content-type-options`, no framing |

## Sites served

`landing` (root), `mine`, `wallet`, `explorer`, `ons`, `circle`, `capsule`,
`social`, `developer`, `app` (accounts) and `audit` (compliance). Each is a
separate directory with its own shell and bundle, so one can be deployed or
replaced on its own.

## Docs

* `../docs/self-hosting.md` — deployments, TLS, proxies, failover
* `../docs/wallet.md` — key handling and recovery
* `../docs/explorer.md` — what the explorer deliberately does not show
* `../docs/api.md` — the node RPC the interface reads
* `../docs/security-model.md` — trust boundaries

## Licence

Apache-2.0 — see `LICENSE`.
