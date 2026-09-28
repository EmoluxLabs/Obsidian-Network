# Cloudflare configuration reference

Everything below is optional. Each item names what it buys you and, where it
matters, what breaks if Cloudflare disappears tomorrow.

## 1. DNS

| Record | Name | Content | Proxy |
| --- | --- | --- | --- |
| `A`/`AAAA` | `interface` | your interface host | proxied |
| `A`/`AAAA` | `node1`, `node2`, … | your node hosts (RPC on 8630 stays firewalled) | **DNS only** |
| `SRV`/`A` | `seed1`, `seed2` | bootstrap peers used by `OBSIDIAN_SEEDS` (port 8631) | **DNS only** |

**Do not proxy the peer-to-peer port.** A p2p connection is a long-lived TCP
stream between nodes; putting a CDN in front of it adds latency and a failure
mode without adding any protection. Node-to-node traffic does not need TLS from
Cloudflare — it is authenticated and encrypted by the node handshake (signed node
metadata; see `docs/protocol.md`).

If DNS itself goes away, existing connections keep running and any node can be
reached by IP; `OBSIDIAN_SEEDS` accepts `host:port` and IP literals.

## 2. Cache rules

| Path | Edge cache | Why |
| --- | --- | --- |
| `/js/*`, `/css/*`, `/assets/*` | 5 minutes, `stale-while-revalidate=60` | Content-addressed by build; a stale style sheet cannot lie about the chain |
| `/api/rpc?path=/blocks…`, `/status`, `/names`, `/land…`, `/capsules…`, `/social…` | 5 seconds | A height five seconds old is still an honest height; the response keeps `x-obsidian-node` |
| `/api/rpc?path=/tx/submit` (POST) | **never** | A cached acceptance receipt would be a fabricated transaction |
| `/api/auth/*`, `/api/wallet/*` | **never** | Sessions and account state belong to one browser |
| `/` and site documents | `no-store` | A redeploy must not leave a stale page pinned |

The worker in `src/worker.js` implements exactly this table, and
`test/worker.test.mjs` asserts it.

## 3. WAF and rate limits

| Rule | Setting | Reasoning |
| --- | --- | --- |
| Rate limit `POST /api/rpc?path=/tx/submit` | 30 requests / minute / IP, burst 10 | Transaction spam is cheap to send and costs nodes real CPU |
| Rate limit `/api/auth/google` | 10 requests / minute / IP | Sign-in is a heavy cryptographic verification per call |
| Block | requests with body > 512 KB to `/api/*` | The interface already rejects > 256 KiB; do not spend bandwidth on it |
| Managed ruleset | Cloudflare OWASP | Free protection against commodity probes; it is outside the trust boundary |
| Bot fight mode | on, for `/api/auth/*` only | Account creation is the only action worth automating against; mining and reading are not gated on Cloudflare at all |

## 4. TLS

* Full (strict) to the interface origin, minimum TLS 1.2, HSTS with
  `includeSubDomains; preload` (the worker sets the header).
* Always Use HTTPS.
* Authenticated Origin Pulls so only Cloudflare can reach the origin — belt, plus
  the braces of the firewall rule that only allows Cloudflare IP ranges to the
  interface port.

## 5. Terraform

`terraform/main.tf` covers the records, cache rules, rate limits and the worker
route, so an operator can reproduce the configuration or delete it cleanly. It is
intentionally small: nothing in it touches consensus, and removing it removes
nothing from the chain.
