# UI end-to-end test

`ext.e2e.mjs` drives the **built** extension (`dist/`) in headless Chromium against a real devnet stack.

```bash
# 1. a devnet stack: obsidian-core node, obsidian-interface platform (with OBSIDIAN_GENESIS_INVITE_HASH set), obsidian-app-web
#    app server on http://127.0.0.1:38790 (npm run start:devnet), node RPC on 38630.
# 2. the browser libraries (not dependencies of the package):
npm install --no-save puppeteer-core @sparticuz/chromium
# 3.
npm run build
GENESIS_INVITE=OBS-GENESIS-XXXX-XXXX-XXXX-XXXX node tests/ui/ext.e2e.mjs   # SHOTS_DIR=/tmp/shots to keep screenshots
```

Use a **fresh** stack per run: the genesis invitation can be redeemed once. Everything the test creates is disposable
(an account on a devnet, a wallet generated for the run). It never touches mainnet.

`shim.js` is a test-only stand-in for `chrome.*` (storage, permissions, tabs, notifications, runtime), and `harness.mjs` serves
`dist/` with the manifest's CSP header. This is not a real extension load; see the README's *Limits*.
