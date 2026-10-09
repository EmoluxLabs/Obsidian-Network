# Obsidian Node

Desktop application (the `obsidian-node-desktop/` directory of the Obsidian-Network repository) for running and operating an Obsidian Network node. It is a front end for
the **real** `@obsidian/core` node, not a second implementation: the app starts the core as a
child process, reads its RPC on `127.0.0.1`, and signs with the core's own key and transaction
code. The visual design is the template in `obsidian-node-design.zip` (kept untouched;
`npm run verify:template` checks it).

* Screens: Overview, Node, Network & Peers, Validator Centre, Wallet, Transactions, Explorer,
  Logs & Diagnostics, Settings, Help. See [docs/IMPLEMENTATION-MAP.md](docs/IMPLEMENTATION-MAP.md)
  for what each screen and action is wired to.
* Networks: mainnet, testnet, staging, devnet (one data directory, wallet and settings each).
* No demo data anywhere in production code. Unavailable data is shown as unavailable, not as zero.

## Download

Installers (Windows, macOS, Linux), checksums and install steps: **[DOWNLOAD.md](DOWNLOAD.md)**.

## Build and run

Requires Node 20.10+ (22 recommended) and a built core:

```
(cd ../obsidian-core && npm ci && npm run build)   # the sibling in this repository; or set OBSIDIAN_CORE_DIR
npm ci
npm run stage:core         # copies the built core + production deps into vendor/ (gitignored)
npm start                  # build + launch Electron
npm run dist               # installers into release/ (needs the Electron download)
npm run dist:dir           # unpacked app only
```

If you cannot download Electron, install with `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`; everything
except launching and packaging still works.

## Checks

```
npm run verify:template    # template ZIP untouched, logo and colour tokens identical
npm run lint               # project rules (no mock data, no Node in the renderer, every control wired …)
npm run typecheck
npm test                   # build + 22 tests, including a real devnet node
npm run test:ui            # headless-browser end-to-end against a real devnet node (see tests/ui/README.md)
```

## Security model

* `contextIsolation`, `sandbox`, no `nodeIntegration`; the preload exposes one `invoke` limited
  to an allow-list generated from `src/shared/contract.ts`; there is no channel to read files,
  run commands or fetch secrets.
* The renderer is loaded from a private `obsidian-app://` scheme with a strict CSP
  (`connect-src 'none'`); navigation, new windows, webviews and permission requests are denied.
* Wallets are encrypted vaults (PBKDF2-SHA256 600k + AES-GCM). The recovery phrase is shown once
  at creation and never again; the passphrase is required for every signature and is never kept.
* The node RPC is bound to loopback; the app refuses non-loopback RPC URLs.
* Logs and diagnostics are redacted (recovery phrases, keys, passphrases, tokens, home path).

## Data

Everything is under the OS user-data directory for "Obsidian Node": `settings.json`, `logs/`, and per network
`networks/<network>/` with `data/` (chain), `node-key.json` + `node-key.pass` (the node's own identity keystore and
its generated passphrase, owner-only files — this key holds no wallet funds unless you fund the validator account),
and `wallet/vault.json` (your encrypted wallet).
Uninstalling does not delete it. The app never initialises a genesis or wipes data without an
explicit confirmation.

## Known limits

* Auto-update and code signing are not configured. The bundled logo is 200×200, too small for a
  platform icon, so the default Electron icon is used until a 512×512 icon is added in
  `build-resources/`.
* The remote-node mode does not exist by design.
