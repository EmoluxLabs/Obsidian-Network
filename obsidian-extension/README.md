# Obsidian Network — browser extension

A Manifest V3 extension (Chrome, Edge, Firefox) that is a **client of an Obsidian app server**. It has no node, ledger,
wallet format, consensus rule or RPC of its own: every balance, height, claim window and block it shows is what a real
Obsidian node reported through the app server, and every transaction is built, signed and submitted by the same
`@obsidian/core` code the web app uses.

## What is where

| Piece | Source | Notes |
|---|---|---|
| Design (CSS, design script, icons) | `template/obsidian-extension.zip` | The supplied template, verified by SHA-256 on every build and never modified. `popup.css`, `popup.js` and `icons/` are copied from it byte-for-byte. |
| Behaviour (screens, wallet, signing, explorer, claims, payments, names) | `../obsidian-app-web/public/*.mjs` + `js/obsidian.js` | Copied at build time, not forked. The web app and the extension cannot drift. |
| Extension shell | `src/`, `manifest.json` | Connect screen, NODE screen, options page, service worker, the click bridge. |

The web app gained a small, optional `ObsidianHost` seam (server address, Menu rows, notifier, address announcement).
With no host it behaves exactly as before; `obsidian-app-web/tests/host-hooks.test.mjs` proves both directions.

## Build, test, package

```bash
# one-time: the core and the web app's dependencies
(cd ../obsidian-core && npm ci && npm run build)
(cd ../obsidian-app-web && npm ci)

npm run build      # dist/ (runs the web app's bundle build and its browser-safety check)
npm test           # node tests (manifest, bridge, config, host, claim watch, service worker, built package)
npm run package    # release/obsidian-extension-<version>.zip + .sha256 (deterministic)
npm run lint:webext
```

Load `dist/` unpacked (`chrome://extensions` → Developer mode → Load unpacked; Firefox: `about:debugging` → Load
Temporary Add-on → `dist/manifest.json`), then open the extension and **CONNECTION SETTINGS**.

## Connecting

The extension asks for exactly one thing at runtime: permission to contact the server you enter (an `https://` address,
or `http://` for `localhost`/`127.0.0.1` only). It saves the connection only if `/app-config.json` says the server is the
network you chose, so a wrong-network server is refused before anything is shown, signed or sent. Run
`obsidian-app-web` (`npm run start:devnet` etc.) next to a node and platform, or use a public app server for your network.

## Screens

Home, Mine (claim), Wallet (send / receive / key), Explorer, ONS, API, Menu — the web app's real screens — plus:

* **NODE**: connection state (loading / connected / stale / unavailable), height, finalized height, last block age,
  peers, sync, mempool, protocol, genesis id, the nodes behind the server, the registered validator set (read-only), and
  an on-screen RUN CHECKS diagnostic. When the node stops answering the last figures are labelled **STALE** with their age.
* **Validators**: read-only. Registering or running a validator needs a node's signing key and a bond; that is not done in
  a browser, so no control for it exists. Use Obsidian Node (the desktop app) or obsidian-core.
* **Options** (CONNECTION): server, network, diagnostics (identity, platform, node, genesis agreement), alert status, disconnect.

## Security notes

* Permissions: `storage`, `alarms`, `notifications`. Host access is `optional_host_permissions` only, requested per server
  on a click. No content scripts, no `externally_connectable`, no web-accessible resources, no dapp provider injection.
* CSP for extension pages: own scripts only, no eval, no inline script, no remote code. The web app's `onclick="ObsidianX('a')"`
  strings cannot run under that CSP, so `bridge.js` removes them and dispatches by a strict call-shape parser (only globals named
  `Obsidian…`, only quoted string literals; no eval). It is unit-tested against hostile input.
* The design file's demo behaviours (fake sign-in, claim, send, name purchase, edge node switch) are disabled before the first
  screen; a test asserts only navigation remains reachable.
* The wallet vault is the web app's: the recovery phrase is sealed on this device under a passphrase and shown nowhere else;
  signing needs the passphrase for every claim and payment. Nothing secret is stored in extension storage, sent in a message
  or logged. The service worker never sees a key.
* Claim alerts: the service worker asks the node (`/mining/status`) about once a minute and notifies when the **node** says
  `eligible === true`, once per claim opportunity. It never computes eligibility and never claims. The public address is copied
  to extension storage only while alerts are on.
* Service-worker suspension: nothing is kept in memory; each alarm re-reads storage. Listeners are registered at load.

## Tests

`npm test` (node): manifest least-privilege and CSP, bridge parser, server-address validation, identity / wrong-network
checks, every failure kind (unreachable, timeout, malformed, unsupported, rejected), diagnostics, host seam, claim watch,
service worker with a fake browser, and the **built** package (template bytes preserved, app-web modules identical, imports
resolve, no eval / remote code / inline handlers, deterministic zip).

`tests/ui/ext.e2e.mjs`: the built extension in headless Chromium, served with the manifest's own CSP, against a real
devnet stack (node + platform + app server): first run, options and refusals, the NODE screen and its STALE state,
sign-up with an invitation, TOTP, wallet import, linking, a real claim confirmed by the node, a real payment (no duplicate on a
double click, wrong passphrase signs nothing), explorer, alerts, wrong network, permission withdrawn, server down. See
`tests/ui/README.md`.

## Limits (read these)

* **Not loaded in a real Chrome or Firefox.** The only browser available to the build environment is a headless shell that
  cannot load extensions, so the UI test serves the built files as pages with a stub of `chrome.*` and
  `--disable-web-security` standing in for host permissions. The manifest is validated by `web-ext lint` (0 errors), not by a
  browser's loader.
* **Session cookie from an extension page is unverified in a real browser.** The app server's cookie is `SameSite=Lax`; it is
  expected to be sent because the extension holds a host permission for that server, but only a real browser can confirm it.
* **Unsigned.** The zip is not signed or store-submitted; signing needs store credentials that do not belong in this repo.
* Camera QR scanning (`SCAN WALLET QR`) uses `getUserMedia`, which behaves differently in a popup; use **OPEN IN A TAB**.
* `web-ext lint` warnings that remain are expected: `background.service_worker` is ignored by Firefox (Chrome needs it, the
  template ships both), and `innerHTML` assignments are the web app's escaped renderer (reviewed; all dynamic values pass `esc`).
