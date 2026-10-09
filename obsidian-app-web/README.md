# Obsidian app (web)

The Obsidian client as a web app. It uses the supplied HTML design verbatim and the
Obsidian Web platform's own API as its single backend. Keys never leave the browser.

## What it does

| Screen | What it is for | Backed by |
| --- | --- | --- |
| Sign up / sign in / recover | One account for the whole ecosystem | platform `/api/auth/*`: Gmail + password + invite + MFA, as the platform states it |
| Home | Account at a glance: recovery codes (shown once), MFA, linked address | platform session, node |
| Mine | Claim once per four hours; the claim is signed in the browser | the node's own eligibility (`/mining/status`), `/tx/submit` |
| Wallet | Create a wallet (24 words, proven before sealing) or import one; **Receive** shows your address as a QR code; **Send** can scan someone's QR into the recipient; history | the node, signed on this device |
| Explorer | Overview, blocks, claims, names, the reward pool, audit, search | the node, read-only, addresses masked, no balances, no address search |
| ONS | Search, register and list `.obs` names | the node and a signed ONS transaction |
| API | Run any public read the gateway allows and see the node's own answer | `/api/rpc?path=…` |
| Menu | MFA enrolment, invitations, link your wallet (once, by signing a challenge), claim alerts, sign out | platform `/api/auth/*`, `/api/wallet/link` |

Every figure comes from the platform or the node. A value not yet answered renders as
`—`; nothing is defaulted, estimated or invented. The design's own demo behaviours
(`claim`, `send`, `buy`, `startM`, `onsq`, the `TAKEN`/`PRICE`/`RATE` constants, the
Edge Node screen) are unreachable, and `tests/no-dead-ends.test.mjs` fails if a screen
calls a handler that does not exist, a handler nothing can reach, or a screen that is
not there.

## One ecosystem

This app and the Obsidian Web platform are two front ends on **one** backend: the
platform's account store (`/api/auth/*`) and the node's ledger.

- **Accounts.** The app has no account system of its own; it calls the platform's. An
  account made here signs in on the platform and the other way round, with the same
  password, the same MFA secret, the same recovery codes and the same invitations
  (a spent invitation is spent in both).
- **Claims.** A claim is a signed `MINING_CLAIM` transaction. The app and the platform
  build **byte-identical** bytes from the same phrase (`tests/parity.test.mjs`), so a
  claim from either is the same claim on the ledger. The chain, not either front end,
  prevents a double claim: each claim id is single-use, a wallet gets one claim per
  block and one per four-hour interval. Both front ends ask the node "may this wallet
  claim?" before signing, and the node refuses a second claim even if one is forged.
  The app additionally holds its Claim button after you submit, since the node's
  answer does not change until a block holds the claim.
- **Names.** ONS names are on-chain; a name taken through one product is taken in both.
- **Wallet vault.** The browser vault is the platform's own format (`obsidian.vault.v1`,
  PBKDF2-SHA256 600,000, AES-GCM, passphrase of at least 12). Browsers keep storage
  per origin, so two products share a vault only when served from one origin; across
  origins the recovery phrase moves a wallet, and gives the same address in both.

`tests/e2e-cross-product.mjs` proves all of this against a live node, platform and app
(27 checks, including a forged double claim and the same transaction submitted twice).

## Layout

```
public/index.html   the design, byte-for-byte unchanged
public/real.mjs     module entry: replaces the design's render/go, wires every handler
public/screens.mjs  the screens (they read the design's helpers by bare name)
public/explorer.mjs the explorer's sections and detail pages
public/data.mjs     reads from the platform; rejects HTML/garbage instead of showing "no data"
public/wallet.mjs   bridge to the signing bundle (loaded lazily)
public/scanner.mjs  the camera / photo QR scanner overlay
web/qr.mjs          QR drawing and decoding, and what a scanned code may mean
public/notify.mjs   claim-ready notifications
web/                the bundle's source: signing, vault, protocol operations
public/js/          GENERATED bundle (git-ignored): npm run build:web
server/main.mjs     dependency-free static server + /api proxy + network guard
server/networks.mjs the four networks, and the check that the platform is on this one
scripts/start.mjs   the per-network entry point behind `npm run start:<network>`
```

The design binds `render`/`go` as function declarations, so they are properties of
`window` and replaceable; `V`, `S`, `hdr`, `nav` are `const` and are not. `real.mjs`
never reads them off `window` — `tests/design-contract.test.mjs` pins this, because
getting it wrong leaves the page rendering normally while running the demo.

## Running it

One deployment serves **one network**. Pick the script for the network:

```sh
npm run build:web                      # builds core, syncs it, bundles the browser code

npm run start:devnet                   # :38790, platform defaults to http://127.0.0.1:38788
npm run start:staging                  # :28790, platform defaults to http://127.0.0.1:28788
npm run start:testnet                  # :18790, platform defaults to http://127.0.0.1:18788
OBSIDIAN_PLATFORM_URL=https://platform.example npm run start:mainnet   # :8790
```

Mainnet has **no** default platform: a production app is told, on purpose, which
platform it fronts, and refuses to start without it.

| Network | Chain | Prefix | Node RPC / P2P | Platform | This app |
| --- | --- | --- | --- | --- | --- |
| mainnet | 7777 | `obs1` | 8630 / 8631 | 8788 | 8790 |
| testnet | 7778 | `tobs1` | 18630 / 18631 | 18788 | 18790 |
| staging | 7779 | `sobs1` | 28630 / 28631 | 28788 | 28790 |
| devnet | 7780 | `dobs1` | 38630 / 38631 | 38788 | 38790 |

Running `node server/main.mjs` directly also works, with `OBSIDIAN_APP_NETWORK` set.

| Variable | Meaning | Default |
| --- | --- | --- |
| `OBSIDIAN_APP_NETWORK` | `mainnet`, `testnet`, `staging` or `devnet` | **required** (set by `start:<network>`) |
| `OBSIDIAN_PLATFORM_URL` | Origin of the Obsidian Web platform | **required** (defaulted by non-mainnet `start:` scripts) |
| `APP_PORT` | Port to listen on | the network's port, above |
| `APP_HOST` | Address to bind | `0.0.0.0` |
| `APP_NETWORK_RECHECK_MS` | How often the platform's network is re-verified | `30000` |
| `APP_TRUST_PROXY` | `true` only behind a reverse proxy you control that writes `X-Forwarded-For` (nginx `proxy_set_header X-Forwarded-For $remote_addr;`, never `$proxy_add_x_forwarded_for`). The visitor's address is then the last entry the proxy wrote, and the platform rate-limits per visitor. **Also start the platform with `OBSIDIAN_INTERFACE_TRUST_PROXY=true`**: this server is its proxy. Without both, every visitor is one client to the platform's limiter and a few requests lock everyone out of sign-in | `false` |
| `APP_ALLOWED_ORIGINS` | Extra exact origins (`https://wallet.example.org`, comma separated, no wildcards) allowed to make state-changing `/api` calls. Without it only this app's own origin and browser extensions (`chrome-extension://`, `moz-extension://`) may; a foreign `Origin`, `Origin: null` or a cross-site `Sec-Fetch-Site` gets `403 ERR_ORIGIN_NOT_ALLOWED` before anything reaches the platform | none |

What makes the four deployments different, and impossible to cross:

- **At start** the server asks the platform which network it follows (`/api/auth/config`
  and the node's `/network`: name, network id, chain id and address prefix) and **exits 3**
  if any of it disagrees with the network it was told it is. No variable and no
  default can make a testnet app front a mainnet platform.
- **While running** it re-checks every 30 s. If the platform changes network, `/api/*`
  answers `503 ERR_NETWORK_MISMATCH` and `/healthz` answers 503, so a load balancer
  takes it out. An unreachable platform is *not* a mismatch: it is reported, not fatal.
- **In the browser** the identity comes from `/app-config.json` (never from the
  platform it is checking). Signing is refused on a mismatch; addresses carry the
  network's prefix; non-mainnet apps show a coloured banner and a title suffix
  (`Obsidian Network — TESTNET`), and a red WRONG NETWORK strip appears if the node's
  chain differs from the app's.
- **Accounts and ledgers are separate**: each network has its own node, its own platform
  and its own account store. Nothing is shared between them but code.

Exit codes: `0` normal, `2` bad or missing configuration, `3` the platform is on a
different network. `GET /healthz` is the liveness/readiness probe.

The app has no runtime dependencies. `build:web` needs `obsidian-core` and
`obsidian-interface` installed (`npm ci` in each, and in this directory for the QR
libraries); `npm test` builds core if absent.

## Wallets and addresses

The address prefix belongs to the network: `obs` (mainnet), `tobs`, `sobs`, `dobs`.
One phrase gives one key and a different address on each. The app takes the prefix from
its network configuration and checks it against the node's (`/network` → `addressHrp`),
and never guesses; an address cached under another network is re-encoded in place, with
no passphrase. If the node does not report a prefix, signing is refused.

**Creating a wallet** generates a 24-word phrase in the browser (256 bits of entropy,
from the same core as the platform), shows it once, asks for three words chosen at
random to prove it was written down, and only then seals it under a passphrase of at
least 12 characters. The phrase is held in memory until sealed, never copied to the
clipboard, never stored in the clear and never sent anywhere. Leaving the screen
discards an unsealed phrase.

## Receive and scan (this app only)

**Receive** draws the wallet's address as a QR code (SVG, drawn in the browser) with the
address as text and a copy button. The code holds the bare address and nothing else: no
amount, no memo, nothing to keep secret.

**Send → SCAN WALLET QR** opens the camera, reads another wallet's Receive code and fills
the RECIPIENT field. That is all a scan does: it never sets an amount and never sends;
the user still checks the address, enters the amount and unlocks with the passphrase.
A scan is checked before it is used:

- an address from another network is refused, naming both networks (`obs1…` in the
  devnet app would never arrive);
- an address that fails its checksum is refused (misread or altered);
- your own address is refused; a `.obs` name is accepted; anything else (a URL, text) is refused;
- scanning continues after a refusal, and the camera is released as soon as a code is
  accepted, on Cancel, on Escape, and when the tab is hidden.

The camera needs HTTPS (or `localhost`). Where it is missing, denied or absent, the same
screen offers **Choose a photo** of the code, with the same checks.

This lives only in this app. The Obsidian Web platform is unchanged. QR encoding and
decoding come from two small libraries bundled into the browser build
(`qrcode-generator`, MIT; `jsqr`, Apache-2.0), so run `npm ci` in this directory before
`npm run build:web`. They are dev dependencies: the server still has none.

## Why the proxy

The browser talks to one origin: one cookie jar, one CORS story, and the platform's
address never reaches the client. The server holds no account state and no keys. A 4xx
stays a 4xx; an unreachable platform is `ERR_PLATFORM_UNREACHABLE` (502), never an
empty 200. `Origin`/`Referer` are not forwarded (this server is the platform's client,
not the browser's) and `X-Forwarded-For` is appended to, never trusted.

## Tests

```sh
npm test                 # 165+ tests, no network, no dependencies
APP_URL=http://127.0.0.1:38790 npm run test:integration   # against a running app + platform
```

- `derivation`, `signing`, `parity` — the canonical derivation and signature per network prefix, and byte-identical transactions with the platform
- `ops` — claim/payment/ONS sequencing against a fake node and a real vault
- `data`, `server` — the wire contract and the proxy, over real sockets
- `networks` — the four networks pinned to core's and the platform's tables; the exit codes; the start scripts
- `design-contract` — the promises the app makes about the design it does not edit
- `boot` — loads `real.mjs` as the page does, renders every screen, creates and seals a wallet, and runs the explorer search handler
- `explorer` — sections, masking, no balances, no address search
- `vault-interop` — the vault is the platform's format, in both directions
- `qr` — an address drawn as a QR reads back as itself on all four networks (from the SVG that is displayed); what a scan may mean
- `no-dead-ends` — no button without a function
- `bundle` — exercises the shipped bundle (skipped until `build:web` has run)

Live tests (not part of `npm test`: they need a node, a platform and an app on one network):

- `tests/e2e-auth.mjs` — the account flow against a platform started with a fresh data dir and `OBSIDIAN_GENESIS_INVITE_HASH`; consumes the genesis invitation (`GENESIS_CODE=… node tests/e2e-auth.mjs`).
- `tests/e2e-cross-product.mjs` — accounts both ways, claims both ways, forged double claims, one transaction submitted twice, names (`APP_URL`, `PLATFORM_URL`, optionally `GENESIS_CODE`).
- `tests/e2e-browser.mjs` — a real browser walks every screen with the real buttons (needs `puppeteer-core` and a Chrome; see the file header for `INVITE`, `FUNDER_PHRASE`, `CHROME_PATH`). It includes the QR flow, with Chromium's fake camera fed a video of a QR code.

Verified against live devnet: a claim, a payment and a `.obs` registration, each signed
by this app's own code, accepted, included and reflected in balances; the cross-product
run and the browser walk; and a complete testnet stack (node, platform, app) started
with `npm run start:testnet` and walked in the browser.

## Not done

- Mainnet has not been exercised, only devnet and testnet. `start:mainnet` and its
  refusals are covered by tests, but no mainnet node was run.
- The browser vault is per origin; sharing one vault with the platform needs both served
  from one origin (a reverse proxy), which this repository does not configure.
- Mining is gated on the platform, and this app follows it: the platform relays a claim only
  for a signed-in account that has a wallet linked and MFA confirmed, signed by that linked
  wallet. **One wallet per account, for good:** the link is made by signing a challenge from the
  platform with the wallet's own key (the vault passphrase unlocks it on this device), it can
  never be changed, and a wallet linked to one account can never be linked to, or claim for,
  another. The wallet stays an independent key made on the device; nothing about it is derived
  from the account. Eligibility is not decided by the platform or by the address but by
  consensus, from the account's last claim, and this app only reads the node's `/mining/status`.
  Consequence worth knowing: a lost wallet cannot be replaced, so the 24 words are the only
  way to keep mining on that account. Direct submissions to a node bypass the platform, so
  on-chain uniqueness is outside what this app or the platform can enforce.
- No service worker; claim alerts work only while the page is open.
