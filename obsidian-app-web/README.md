# Obsidian app (web)

The Obsidian client as a web app. It uses the supplied HTML design verbatim and the
Obsidian Web platform's own API as its single backend.

## Status — read this before trusting anything here

**This is a foundation, not a finished app.** What exists today:

- `server/main.mjs` — a dependency-free server that serves `./public` and proxies
  `/api/*` to the platform. **Written and verified**: it refuses to start with no
  platform configured, boots when one is set, answers `/healthz`, and serves the
  shell with a 200.

What does **not** exist yet:

- **`public/index.html` is an unmodified copy of the supplied design file.** It
  still contains everything that file labels as demo data: the hardcoded
  `VALID` invitation list, `claim()` adding to a local balance with no transaction,
  the unverified sign-in, and the invented `TAKEN` / `FEE` / `PRICE` constants.
  **None of it talks to a real backend.** Treat it as the design source, not as the
  app.
- No data layer, no signing, no notifications, no service worker.

## Running it

```sh
OBSIDIAN_PLATFORM_URL=https://your-platform.example npm start
```

It refuses to start without `OBSIDIAN_PLATFORM_URL`. That is deliberate: an app with
no backend renders empty states everywhere and looks broken rather than
misconfigured, and the failure message is more useful than the blank screen.

| Variable | Meaning | Default |
| --- | --- | --- |
| `OBSIDIAN_PLATFORM_URL` | Origin of the Obsidian Web platform | required |
| `APP_PORT` | Port to listen on | `8790` |
| `APP_HOST` | Address to bind | `0.0.0.0` |

## Why the proxy

The browser talks to one origin only. That means one cookie jar, one CORS story, one
place a failure can come from — and the platform's address never reaches the client,
so a deployed app cannot be repointed by editing its JavaScript.

The server holds no account state, no keys and no session of its own. It is a pipe.
A 4xx from the platform stays a 4xx, so the app shows the server's own reason instead
of a generic one. An unreachable platform is reported as `ERR_PLATFORM_UNREACHABLE`
rather than turned into an empty 200 that would render as a chain with no data.
