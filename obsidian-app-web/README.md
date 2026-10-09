# Obsidian app (web)

The Obsidian client as a web app. It uses the supplied HTML design verbatim and the
Obsidian Web platform's own API as its single backend. Keys never leave the browser.

## What it does

| Screen | Backed by |
| --- | --- |
| Sign up / sign in / recover | platform `/api/auth/*` — Gmail + password + invite + MFA, as the server states it |
| Home | account, invites, recovery codes (shown once), MFA, linked address |
| Mine | the node's own eligibility (`/mining/status`); claims are signed in the browser and submitted to `/tx/submit` |
| Wallet | balance, history, send (payment), receive, wallet set-up on this device |
| Explorer | blocks, transactions, addresses and `.obs` names, straight from the node |
| ONS | name lookup, registration, renewal, address update, transfer |
| API | the routes the proxy exposes |

Every figure comes from the platform or the node. A value not yet answered renders as
`—`; nothing is defaulted, estimated or invented. The design's own demo behaviours
(`claim`, `send`, `buy`, `startM`, `onsq`, the `TAKEN`/`PRICE`/`RATE` constants, the
Edge Node screen) are unreachable.

## Layout

```
public/index.html   the design, byte-for-byte unchanged
public/real.mjs     module entry: replaces the design's render/go, wires every handler
public/screens.mjs  the screens (they read the design's helpers by bare name)
public/data.mjs     reads from the platform; rejects HTML/garbage instead of showing "no data"
public/wallet.mjs   bridge to the signing bundle (loaded lazily)
public/notify.mjs   claim-ready notifications
web/                the bundle's source: signing, vault, protocol operations
public/js/          GENERATED bundle (git-ignored): npm run build:web
server/main.mjs     dependency-free static server + /api proxy
```

The design binds `render`/`go` as function declarations, so they are properties of
`window` and replaceable; `V`, `S`, `hdr`, `nav` are `const` and are not. `real.mjs`
never reads them off `window` — `tests/design-contract.test.mjs` pins this, because
getting it wrong leaves the page rendering normally while running the demo.

## Running it

```sh
npm run build:web                      # builds core, syncs it, bundles the browser code
OBSIDIAN_PLATFORM_URL=http://127.0.0.1:8788 npm start
```

`OBSIDIAN_PLATFORM_URL` is required; without it the server exits with code 2.

| Variable | Meaning | Default |
| --- | --- | --- |
| `OBSIDIAN_PLATFORM_URL` | Origin of the Obsidian Web platform | required |
| `APP_PORT` | Port to listen on | `8790` |
| `APP_HOST` | Address to bind | `0.0.0.0` |

The app has no runtime dependencies. `build:web` needs `obsidian-core` and
`obsidian-interface` installed (`npm ci` in each); `npm test` builds them if absent.

## Networks and addresses

The address prefix belongs to the network: `obs` (mainnet), `tobs`, `sobs`, `dobs`.
One phrase gives one key and a different address on each. The app reads the prefix
from the node (`/network` → `addressHrp`) and never guesses it; an address cached
under another network is re-encoded in place, with no passphrase. If the node does not
report a prefix, signing is refused.

## Why the proxy

The browser talks to one origin: one cookie jar, one CORS story, and the platform's
address never reaches the client. The server holds no account state and no keys. A 4xx
stays a 4xx; an unreachable platform is `ERR_PLATFORM_UNREACHABLE` (502), never an
empty 200. `Origin`/`Referer` are not forwarded (this server is the platform's client,
not the browser's) and `X-Forwarded-For` is appended to, never trusted.

## Tests

```sh
npm test                 # 90+ tests, no network, no dependencies
APP_URL=http://127.0.0.1:8790 npm run test:integration   # against a running app + platform
```

- `derivation`, `signing` — the canonical derivation and signature, per network prefix
- `ops` — claim/payment/ONS sequencing against a fake node and a real vault
- `data`, `server` — the wire contract and the proxy, over real sockets
- `design-contract` — the promises the app makes about the design it does not edit
- `boot` — loads `real.mjs` as the page does and renders every screen
- `bundle` — exercises the shipped bundle (skipped until `build:web` has run)

`tests/e2e-auth.mjs` drives the account flow (register, MFA, sign-in, invites, link
wallet) against a live platform started with a fresh data dir and
`OBSIDIAN_GENESIS_INVITE_HASH`; run it with `GENESIS_CODE=… node tests/e2e-auth.mjs`.
It consumes the genesis invitation, so it is not part of `npm test`. The platform's
password rule also requires a digit, which `/api/auth/config` does not advertise; the
app shows the server's message when it is refused.

Verified end to end against a live devnet node: a claim, a payment and a `.obs`
registration, each signed by this app's own code, accepted, included and reflected in
balances.

## Not done

- No browser-driven test: the suite stubs the DOM, so layout and CSS are unverified here.
- No service worker; notifications work only while the page is open.
- Mainnet has not been exercised, only devnet.
