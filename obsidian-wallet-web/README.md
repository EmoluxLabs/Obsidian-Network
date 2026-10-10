# Obsidian Wallet (web)

A non-custodial wallet for the Obsidian Network that runs in the browser. Keys are made and kept on the user's device;
the node only ever sees public addresses and finished, signed transactions.

It is a **client of the network's own code**. It has no chain, node, RPC server, key format, address format, fee rule or
payment URI of its own:

| Need | Where it comes from |
| --- | --- |
| Recovery phrase, key derivation, address, signing, transaction bytes, QR encode/decode, the encrypted vault | the signing bundle that `obsidian-app-web` builds from `obsidian-core` (`obsidian-app-web/web/*`) |
| Chain reads, amount parsing, node calls | `obsidian-app-web/public/data.mjs` |
| Network identity check before any signature | `obsidian-app-web/public/wallet.mjs` (`getContext`) |
| Camera and photo QR scanning | `obsidian-app-web/public/scanner.mjs` |
| Server (origin check, security headers, body cap, gateway) | `obsidian-app-web/server/main.mjs`, three settings only (below) |
| The chain itself | an Obsidian node, through the platform's existing `/api/rpc` gateway |

`npm run build` copies those files into `public/js/` (generated, not committed). They are copies of the web app's files,
not a second implementation: a signature made here and one made in the web app are the same code.

The look is the supplied design (`EmoluxLabs/OBS-Dex-Wallet-Web-App`, `obsidian-wallet.html`), kept unmodified in
`template/` (`TEMPLATE.sha256`; a test fails if it changes). Nothing the design invented was carried over: its P-256
keys, `obs1` + 38 hex addresses, word list, `0.001` fee, "ledger", private-key export and sample balances do not exist on
this network and are not in the shipped code (`tests/template.test.mjs` and `npm run lint` check that).

## Run

```sh
# once: dependencies of the pieces this reuses
(cd ../obsidian-core && npm ci && npm run build)
(cd ../obsidian-interface && npm ci)
(cd ../obsidian-app-web && npm ci)

npm run build                  # the signing bundle and shared modules into public/js/
npm run start:devnet           # or start:testnet / start:staging / start:mainnet
```

The wallet serves ONE network, named on the command line, and refuses to start if the platform behind it reports another
(exit 2/3). Ports: mainnet 8791, testnet 18791, staging 28791, devnet 38791. `APP_PORT` / `APP_HOST` override them. The
platform it reads from is that network's own platform port on the same machine; for mainnet it must be given explicitly.
Run a devnet with `scripts/obsidian-network.sh devnet start` at the repository root.

## Screens (design → this wallet)

| Design screen | Here | What is real |
| --- | --- | --- |
| Splash | `splash` | shown while the network is verified |
| Welcome | `welcome` | the active network and its prefix are named; test networks say their coins have no value |
| Create wallet (password) | `create1` | 12-character minimum, confirmed twice, nothing generated before it passes |
| Recovery phrase | `create2` | 24 real BIP-39 words from secure randomness; **nothing is stored until the backup is confirmed**; no copy, download or share control |
| Import | `import` | recovery phrase (12 or 24 words) or an encrypted backup produced by this wallet. Private keys are refused: the only supported secret is the phrase |
| Unlock | `unlock` | wrong password is refused by the authenticated cipher; repeated failures are delayed |
| Home | `home` | exact balance from the node, recent transactions, the network card, lock |
| Receive | `receive` | the real address as a QR the web app's own decoder reads back, copy, share, network warning. The code holds the address only: this protocol defines no payment URI, so none is invented |
| Send | `send` | recipient and amount validation, QR scan or photo, live protocol fee |
| Review | `review` | recipient (first and last characters emphasised), amount, fee, total, balance after, network, password to authorize |
| Transaction status | `status` / `tx` | prepared → signed → accepted by the node → in the mempool → in a block (with confirmations), or rejected / not sent / expired |
| Activity | `activity` | the node's indexed history plus what this device sent and the node has not listed yet |
| Backup | `backup` | phrase after the password, hides after a minute / lock / tab hidden; encrypted backup download |
| Remove | `remove` | deletes the encrypted wallet and this wallet's records from the browser |

Price and fiat value are shown as **"unavailable"**: the network has no verified price source, so there is no number.

## How the money moves

1. **Prepare.** The recipient must be a bare address of the active network (checked by the protocol's own `readScanned`:
   bech32 checksum and prefix). Names, links, `obsidian:` URIs and mixed case are refused. The amount is decimal digits
   with at most 18 places, never rounded. The page asks the node for the balance and for a fee quote; it signs only if
   the fee the node quotes equals the protocol rule the bundle computes itself (`expectedGas`). A balance it cannot read
   is "Unavailable", never `0`, and blocks sending.
2. **Review.** Everything that will be signed is on the screen. Nothing is signed until the password is entered.
3. **Sign.** The password opens the vault (PBKDF2-SHA-256, 600,000 rounds, AES-GCM); the phrase is derived to a key in
   memory, the payment is signed locally, and the key material is dropped. The network identity is verified against the
   node (chain id, genesis, address prefix) immediately before.
4. **Submit.** `/tx/submit` through the gateway. Each answer is reported as what it is:
   * the node accepted it → **Submitted**; **Pending** once the node lists it in its mempool; **Confirmed** only when a
     block holds it, with the node's own confirmation count;
   * the node refused it (HTTP 4xx) → **Rejected**, with the node's reason, and no retry button (the same bytes would be
     refused again);
   * the answer was lost (network error, 5xx) → **Not confirmed sent**. The wallet does not guess: "Check with the node"
     looks the transaction id up, and "Send the same transaction again" re-sends the SAME signed bytes (same id, so the
     chain cannot apply it twice). It never signs a second payment for the same click.
5. **No double submit.** A guard stops a double click or double Enter from signing twice, and a second payment is
   refused while one is unsettled.

## Security model

* **Generation.** `crypto.getRandomValues` through the bundle's `generatePhrase`; the address is derived by the real
  derivation, and the vault is reopened and compared before it is kept.
* **Storage.** Only the encrypted vault (`obsidian.vault.v1`), its public address, and a list of submitted transaction
  ids and amounts are stored. The phrase and password are never written to storage, cookies, URLs or the console, and
  never sent anywhere (the end-to-end test searches every request, console line and stored value for them).
* **Backups.** The downloadable file is the encrypted vault. An imported file is size-limited, shape-checked and its
  iteration count range-checked **before** any key stretching, so a hostile file cannot make the page spin.
* **Idle.** The wallet locks after inactivity, and the shown phrase is wiped when the tab is hidden.
* **Page.** The server sends `script-src 'self'` (no inline script at all; the app's own `APP_STRICT_SCRIPTS`),
  `default-src 'self'`, `connect-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(self)`. The wallet's own code uses no inline handler or
  inline style (`npm run lint`). Everything from the node is inserted as text, through one escaping function.
  `style-src` still allows inline styles because the shared camera overlay sets a few.
* **API surface.** `APP_API_ALLOW=/api/rpc`: sign-in, accounts, claims and node-control routes of the full web app answer
  404 here.
* **Dependencies.** None added. The wallet is plain ES modules plus the code listed above; `npm ci` is needed only in the
  packages it reuses. Browser test libraries (puppeteer-core, @sparticuz/chromium) are used by the end-to-end test only and
  are not dependencies.
* **Camera.** `getUserMedia` is called only when Scan QR is tapped. A denial, a missing camera, or an insecure page each
  say so and offer a photo. A scan only fills the recipient field, after the same validation as typing; it never
  submits, never fills the amount, never signs. A code from another network is refused by name.

## What a browser wallet cannot promise

Say these plainly to users:

* Anyone with the recovery phrase controls the funds, and there is no recovery without it. The password cannot be reset.
* The phrase is derived to a key inside the page for each signature. A browser cannot lock memory or guarantee wiping it;
  malware on the device, a malicious browser extension or a compromised browser can read it. Use a device you trust.
* Whoever serves the page can change the page. Serve it only over HTTPS from a host you control, with the headers above
  (camera access also needs HTTPS or localhost). There is no subresource-integrity or signed-release mechanism yet.
* Clearing site data deletes the encrypted wallet: keep the written phrase (or an encrypted backup plus its password).
* The wallet trusts the node it is pointed at for balances and history (it does not verify light-client proofs, and
  there are none to verify). A dishonest node can lie about balances or hide a transaction; it cannot move funds. The
  network identity check stops a node of the wrong network from being used to sign, not a dishonest node of the right one.
* `/finality` is not proxied by the gateway, so "Confirmed" means included in a block the node reports, with its
  confirmation count; it does not claim economic finality.
* The node masks counterparties in history, so received and sent rows show the other party partly masked.
* Mainnet and testnet are not started or funded by this repository's tests. Only a disposable local devnet is.

## Tests

```sh
npm test            # fast: template kept byte for byte, no placeholders shipped, pure logic, screens, served policy
npm run lint        # static checks: parse, no inline script/handler/style, no eval, no other host, no demo data
npm run test:e2e    # slow: a real devnet (node + platform) and the wallet in a real browser
```

`test:e2e` starts a throwaway devnet in a temporary directory, funds a disposable wallet with a real mining claim, and
drives the screens with headless Chromium: create (nothing stored before the backup is confirmed), lock/unlock, receive
(the QR is decoded from the screen), import by phrase and by encrypted backup, hostile backups, validation, a real
payment checked against the node (balances, fee, one transaction, nonce), QR scanning by camera and by photo (denied
camera, wrong network), a node that refuses, a connection that dies before and after the node saw the transaction,
unreadable balances, hostile text in history, the page's CSP, a mismatched network, wallet removal, and a search of
everything the browser sent for secrets. It needs `puppeteer-core` and `@sparticuz/chromium` in `$UITEST_DIR` (default
`/tmp/uitest`) and a built `obsidian-core`, `obsidian-interface` (`npx tsc -p tsconfig.json`) and `obsidian-app-web`.
