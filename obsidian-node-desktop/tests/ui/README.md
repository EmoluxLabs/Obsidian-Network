# UI end-to-end test (headless Chromium, real devnet node)

The Electron binary cannot be run on every CI box, so the interface is also tested in a real
browser against a real node: `src/dev/bridge.ts` serves the **same renderer** over HTTP and
forwards the **same IPC channels** (same handlers, same services) to a disposable devnet
node. It is for development and tests only and is excluded from the packaged app.

```
npm run stage:core                # once
npm i --no-save puppeteer-core @sparticuz/chromium
npm run test:ui                   # SHOTS_DIR=/tmp/shots node tests/ui/ui.e2e.mjs for screenshots
```

* `ui.e2e.mjs` — 19 steps: routes, network switch, settings, node start, wallet create, claim
  funds, send (wrong passphrase refused), validator fund → register → active → unbond (claim
  blocked until the delay), logs/diagnostics, help, stop, restart, SIGKILL honesty, and no
  console errors.
* `fund.mjs` — helper that funds a devnet wallet through the node's own first mining claim.
* `browser.mjs` — launcher and small helpers (`waitText` is case-insensitive because the CSS
  upper-cases labels).

Each run uses a fresh temporary data directory and a new genesis. A genesis invitation is
single-use, so data directories are never reused.

`puppeteer-core` and `@sparticuz/chromium` are deliberately not in `package.json`
(they download a browser); install them on demand as above.
