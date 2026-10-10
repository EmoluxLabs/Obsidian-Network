# The supplied design

`obsidian-wallet.html` is the design file from `EmoluxLabs/OBS-Dex-Wallet-Web-App` (branch `main`, commit `4d3fa32`),
copied here **unmodified** (`TEMPLATE.sha256` records its SHA-256; `tests/template.test.mjs` fails if it changes).

It is a design reference, not code that ships. Its cryptography (P-256), address format (`obs1` + 38 hex), word list,
fee (`0.001`), "ledger" and private-key export are demo placeholders that do not exist on the Obsidian Network, so none
of them were carried over. What the wallet takes from it is the look (tokens, spacing, type), the screens, their order
and their copy. See `../README.md` for the screen-by-screen mapping.
