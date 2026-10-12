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
