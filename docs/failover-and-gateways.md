# Interface failover, gateways and the DNS/TLS work that is not in this repository

**Status of this page.** The repository can make each interface host report whether it should receive traffic
(`/api/ready`, `/api/health`; the node has `/readyz`, `/livez`). Everything below that needs a public DNS zone, a
certificate authority, a CDN or a second machine was **not exercised** from the build sandbox. Configuration here is
marked *untested* where that applies. Do not treat public failover, DNS or TLS as working until you have run the
drill in section 5 on your own hosts.

## 1. What fails over, and what does not

An interface host is the web platform (sites, explorer, wallet pages, `/api/*`) plus a node pool that proxies to
nodes. Two kinds of traffic go through it:

| Traffic | State it needs | Can any host serve it? |
|---|---|---|
| Static sites, explorer, wallet pages | none | **Yes.** |
| `/api/rpc`, `/api/nodes`, `/api/health`, `/api/ready` | the chain, read from its own node pool | **Yes**, each host reads the chain itself. The chain is the shared truth; no host is the source of it. |
| Signed transaction relay (`/api/rpc?path=/tx/submit`) | none (the transaction carries its own signature) | **Yes.** |
| Sign-up, sign-in, sessions, invites, wallet link, mining gate certificates (`/api/auth/*`, `/api/wallet/*`, `/api/mining/certificate`) | the **account store**, a file local to one deployment, and the gate issuer key | **Only the one `primary` host.** An `edge` host refuses them (503 `ERR_EDGE_READ_ONLY`). |

The account store is local to each interface deployment, and it enforces "one wallet per account, one account per
wallet" and the one-time Genesis Invitation. Two hosts with two stores would each enforce that only among their own
users, so account routes must not be load-balanced across independent hosts. **The store is deliberately not
replicated** (two writers would break "one wallet per account"); the safe multi-host design in 1.8.0 is a role:

* `OBSIDIAN_INTERFACE_ROLE=primary` (the default): holds accounts, wallet links and the gate key. Run **exactly one** per
  network.
* `OBSIDIAN_INTERFACE_ROLE=edge`: read-only. Serves static pages, chain reads and the relay of signed transactions.
  Refuses `/api/auth/*`, `/api/wallet/link*`, `/api/mining/certificate` and mining claims with 503 `ERR_EDGE_READ_ONLY`,
  naming the primary when `OBSIDIAN_INTERFACE_PRIMARY_URL` is set. It creates no accounts and **must never be given the
  gate keystore**. `/api/ready` reports the role. There is no dedicated edge page or redirect: account calls there fail with the 503 above, whose
  message names the primary, so point users at the primary for account actions.

Additional hosts therefore serve only the chain-facing and static traffic. The gate issuer key lives on the primary only. If the primary dies, chain reads, wallets that already
hold their keys and transaction relay keep working on the others; sign-in and new mining claims wait for the primary
(or for a restore of its account store and keystore onto a standby, which is a manual operation).

## 1b. Automatic primary failover (1.8.1): a lease, not a DNS record

Version 1.8.0 made the primary a manual role. 1.8.1 lets **several primary-capable hosts share one durable account
store and elect exactly one leader**, so a dead primary is replaced without an operator and without two hosts ever
writing the store or signing certificates at once. DNS and health checks decide where traffic *goes*; they are never
what decides who is *allowed to issue*.

**How it works** (`server/lease.ts`, `store.ts`, `index.ts`):

* The hosts point `OBSIDIAN_INTERFACE_LEASE_DIR` at one shared directory. The leader holds a lease there
  (`lease.json`: holder, advertised url, fencing token, renewed-at, expires-at), taken and renewed under a lock
  directory (`lease.lock`).
* The leader keeps its authority only for `ttl - 2*skew` of **monotonic** time counted from the *start* of its last
  successful renewal. A follower takes over only when the **wall clock** passes `expiresAt + skew`. The two windows do
  not overlap, which needs `ttl > 4*skew` (defaults: ttl 15 s, skew 2 s; the server refuses a configuration that breaks
  this). A leader that cannot renew stops acting as leader **before** anyone else can start.
* Every store write re-checks the lease under the lock and carries the fencing token. A host that lost the lease
  without noticing (a paused VM, a long GC, a partition) gets a `FencingError` on its next write and the shared file is
  left untouched. The certificate issuer calls `assertLeader()` immediately before signing, so a deposed host cannot
  issue.
* A standby answers account, wallet-link, certificate and claim routes with **503 `ERR_NOT_LEADER`**
  (`Retry-After: 2`, `X-Obsidian-Standby: 1`, `leader` naming the current leader). `GET /api/ready` is 503 on a standby
  (so a load balancer sends account traffic only to the leader) and reports `leader{...}`; `GET /api/health` stays 200.
  A promoted host re-reads the store, then starts issuing. A clean shutdown releases the lease so takeover is immediate.
* An unreadable or corrupt lease file never counts as "free": nobody takes over until the file is readable or an
  operator intervenes.

| Variable | Meaning |
|---|---|
| `OBSIDIAN_INTERFACE_LEASE_DIR` | Shared directory holding the lease and the account store. Enables election. Refused on an `edge`. |
| `OBSIDIAN_INTERFACE_LEASE_TTL_MS` | 3000-600000, default 15000. |
| `OBSIDIAN_INTERFACE_MAX_CLOCK_SKEW_MS` | 0-60000, default 2000. Hosts must keep clocks within this (use NTP/chrony). |
| `OBSIDIAN_INTERFACE_ADVERTISE_URL` | The URL other hosts and edges should use to reach this host. |
| `OBSIDIAN_INTERFACE_PRIMARY_URLS` | For an **edge**: the candidate primaries it probes. It names a primary only when exactly one host claims leadership; two claimants, a redirect, or no answer means "no primary" and it fails closed. |

**What survives a failover.**

| Item | Survives? |
|---|---|
| Accounts, wallet links, invites, one-time Genesis Invitation, mining enrolment | **Yes**, they are in the shared store. |
| Sessions (cookie logins) | **Yes**, but sessions are flushed about every 2 s. A crash inside that window costs the affected users a re-login, and can equally undo a logout made inside that window (the session returns until it expires or is logged out again). Critical account writes (registration, recovery, wallet link) are persisted on the spot, not on the timer. |
| Gate certificates already issued | Stay valid until their 15-minute expiry. They are bound to a wallet and claim id and the chain accepts a given claim once, so they cannot be spent twice. |
| In-flight requests to the dead primary | Fail; the client retries against the new leader (`Retry-After: 2`). No request is duplicated by the failover itself. |
| Gate keystore | Every primary-capable host needs its own copy of the gate keystore and passphrase (each is allowed to become leader). **That multiplies the places the gate key lives.** Keep the set of primary-capable hosts small, treat each as a key-holding machine, and prefer a 3-of-5 gate set so one compromised host is revocable. |

**What this is not.**

* **The file lease is not safe on NFS or most network file systems** (lock and rename semantics vary, and attribute
  caching can let two hosts both believe they hold the lock). Use a local disk shared by processes on **one machine**,
  or a file system with proper POSIX locking you have tested. **For genuinely separate machines, put the lease in a
  system built for it (etcd, or a Postgres advisory lock / row with a fencing token)**; the `LeaderElector` interface
  is small, but that adapter is **not implemented** here.
* It is not a database. The store is still one JSON file; a corrupt disk is a restore-from-backup event.
* It provides **application** availability for the account/gate tier. Availability of DNS, TLS certificates, the
  machines, the network and the chain nodes behind it is infrastructure you operate (sections 3-5).

**Tested** (`tests/lease.test.ts`, `tests/ha-config.test.ts`, `tests/server.test.ts` "primary failover",
`tests/e2e/failover.test.mjs`): election, renewal, expiry, takeover, stale and skewed clocks, a deposed leader's write
fenced, a throwing promotion hook, no duplicate issuance across a promotion, standby refusal, an unreadable lease file,
two hosts claiming leadership, and **real OS processes**: SIGKILL of the leader under request load with the standby
taking over, restart of the old leader as a standby, a paused leader that wakes up fenced, partition-then-heal. **Not
tested:** NFS or any multi-machine file system; real DNS/CDN/TLS; a kill of the *machine* (only the process).

## 2. nginx in front of several interface hosts (untested across hosts)

```nginx
# Reads and static content: any healthy host. Passive health: a host that fails 3 times is skipped for 20 s.
upstream obsidian_read {
    server iface-a.internal:8788 max_fails=3 fail_timeout=20s;
    server iface-b.internal:8788 max_fails=3 fail_timeout=20s;
    server iface-c.internal:8788 backup;
    keepalive 16;
}
# Accounts, wallet linking, gate certificates: the primary only.
upstream obsidian_accounts {
    server iface-a.internal:8788;
}

server {
    listen 443 ssl http2;
    server_name app.mineobs.network www.mineobs.network mineobs.network;
    # ssl_certificate ... (see section 4)

    location /api/auth/   { proxy_pass http://obsidian_accounts; include proxy_common.conf; }
    location /api/wallet/ { proxy_pass http://obsidian_accounts; include proxy_common.conf; }
    location /api/mining/ { proxy_pass http://obsidian_accounts; include proxy_common.conf; }
    location /api/        { proxy_pass http://obsidian_read;     include proxy_common.conf; }
    location /            { proxy_pass http://obsidian_read;     include proxy_common.conf; }
}
```

**With automatic failover (section 1b), untested:** list every primary-capable host in the accounts upstream and let a
standby's 503 move the request on. A standby refuses before it touches anything, so retrying a `POST` on `503` cannot
duplicate an action (the lease, not nginx, is what prevents two hosts from issuing).

```nginx
upstream obsidian_accounts {
    server iface-a.internal:8788 max_fails=0;   # max_fails=0: a standby's 503 is expected, do not eject it
    server iface-b.internal:8788 max_fails=0;
}
location /api/auth/ {
    proxy_pass http://obsidian_accounts;
    include proxy_common.conf;
    proxy_next_upstream error timeout http_503 non_idempotent;   # POST is retried only on connect failure or a 503
    proxy_next_upstream_tries 2;
    proxy_connect_timeout 2s;
}
# repeat for /api/wallet/ and /api/mining/
```

`non_idempotent` also retries a `POST` that failed after being sent on a `timeout`; if you cannot accept that, drop
`timeout` from the list and let the client retry. This configuration has **not been run against real nginx**.

Open-source nginx has only **passive** health checks (`max_fails`). Active checks use `GET /api/ready` and need
either NGINX Plus, HAProxy (`option httpchk GET /api/ready`), or the health checker of the DNS/CDN provider. Use
`/api/ready` (not `/api/health`) for that: `/api/health` is 200 whenever the process is up, `/api/ready` is 503 when
the host cannot reach a healthy node of its own network or sees a genesis mismatch.

`proxy_common.conf` is a file you create; it should set `proxy_set_header Host $host;`, `X-Forwarded-For`, and the interface must be started
with `OBSIDIAN_INTERFACE_TRUST_PROXY=true` (see `obsidian-interface/deployment/nginx/obsidian-interface.conf`, which
is the tested single-host template).

**No open proxy.** The interface forwards only to the node URLs in its own configuration (`OBSIDIAN_NODE_URLS`),
and `/api/rpc` takes a *path* on those nodes, not a host. nginx must likewise only name your own upstreams; never
`proxy_pass $arg_url` or a variable built from a request.

## 3. Hostnames and what trusts them

The trusted browser origins are a central, exact-hostname policy (`obsidian-core/src/config/trusted-origins.ts`,
mirrored in `obsidian-interface/server/trusted-origins.ts`; see `docs/trusted-domains.md`). For `mineobs.network` the
exact hosts are `mineobs.network`, `www`, `app`, `wallet`, `api`, `node`, `status` (and `testnet.`, `staging.`,
`devnet.` for those networks), HTTPS only, default port, no wildcard. `mineobs.network.attacker.example`,
`evilmineobs.network`, `a.app.mineobs.network`, `app.mineobs.network:8443`, `http://app.mineobs.network` and
`https://mineobs.network@evil.test` are refused (tests in `obsidian-core/tests/security/trusted-origins.test.ts` and
`obsidian-interface/tests/server.test.ts`).

A trusted origin may **read** public chain data and relay a signed transaction. It does not get cookies, sessions or
account routes: CORS tells a browser what a page may read; it does not authenticate anyone. Accounts stay same-origin
(or an origin the operator lists in `OBSIDIAN_INTERFACE_ALLOWED_ORIGINS`).

Not changed by this work and still the operator's job: session cookies are `HttpOnly`, `SameSite=Lax`, `Secure` behind
`OBSIDIAN_INTERFACE_TRUST_PROXY=true` and **host-only** (no `Domain=` attribute), so `app.` and `wallet.` do not share a
session. Share a session across subdomains only by deliberately adding a `Domain=` cookie, which this repository does
not do.

**You must own `mineobs.network`.** The policy trusts the name; it does not and cannot verify who controls the DNS. If
the domain lapses or its registrar account is taken, a stranger gets read access to nodes that trust it. Operators who
do not want it set `OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS=false` and `OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS=false`.

## 4. DNS and TLS (not in the repository; untested here)

1. One `A`/`AAAA` record per hostname per host, or a provider load balancer / health-checked record set that returns
   only healthy hosts (Route 53 failover/weighted with a health check on `/api/ready`; Cloudflare Load Balancing; or
   round-robin plus short TTLs, 30-60 s, which fails over slowly and not at all for clients that cache).
2. A certificate for every hostname on every host: `certbot --nginx -d app.mineobs.network ...` per host (HTTP-01
   needs port 80 reachable on the host that answers), or a wildcard through DNS-01 shared across hosts. Renewal must be
   monitored; an expired certificate on one host is an outage for the share of traffic routed to it.
3. HSTS is already in the nginx template. Only enable `includeSubDomains`/preload when every subdomain is HTTPS.
4. If a CDN sits in front, restore the visitor address (`set_real_ip_from` the CDN's ranges only) or rate limits become
   per edge; see `docs/ORACLE-VPS-DEPLOYMENT.md`.
5. P2P is not HTTP: the P2P port (`8631` etc.) must be open directly to peers, not through the CDN.

## 5. Failover drill (run this before you rely on any of the above)

1. `curl -s https://app.mineobs.network/api/ready` through each host directly (by IP with `--resolve`); expect 200.
2. Stop the node on host B (or block its RPC). Its `/api/ready` must become 503 within the health-check interval,
   and the balancer must stop sending it traffic. `obsidian status --url http://B:8630` should say not ready.
3. Stop the interface on host A (the account primary): reads must continue on B; sign-in must fail visibly, not
   fall through to B.
4. Start both again; confirm `/api/ready` returns to 200 and the balancer returns them to rotation.
5. Record what you measured. The repository's tests cover the endpoints' behaviour, not your DNS, TLS or provider.
