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

The test page is served from `http://127.0.0.1:4173`, which is not a `chrome-extension://` origin, so start the app server with
`APP_ALLOWED_ORIGINS=http://127.0.0.1:4173` (a real extension needs no such setting).

`hostile.e2e.mjs` needs the same stack but no invitation: it puts a proxy between the screens and the app server that appends
HTML and script payloads (including a quote breakout for inline handlers) to every string the server returns, then walks every
screen and control and fails if anything runs, becomes an element, or keeps an `on*` attribute. With `HOSTILE_TARGET=webapp`
it walks the web app itself instead (where inline handlers are real). It also fails if the payload is not visibly rendered on
at least 10 screens, so a crawl that reached nothing cannot pass. Run it from the directory that holds `puppeteer-core`:
`cd /tmp/uitest && node <repo>/obsidian-extension/tests/ui/hostile.e2e.mjs`. Its detection of the old escaping flaw is
proved by `obsidian-app-web/tests/explorer.test.mjs` (which executes the decoded handlers), not by this crawl.

Use a **fresh** stack per run: the genesis invitation can be redeemed once. Everything the test creates is disposable
(an account on a devnet, a wallet generated for the run). It never touches mainnet.

`shim.js` is a test-only stand-in for `chrome.*` (storage, permissions, tabs, notifications, runtime), and `harness.mjs` serves
`dist/` with the manifest's CSP header. This is not a real extension load; see the README's *Limits*.
