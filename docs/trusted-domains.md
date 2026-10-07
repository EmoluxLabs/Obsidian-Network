# Trusted domains

Which web pages a node or an interface will answer, and how to add yours.

## What "trusted" means

A page served from a trusted origin may call a node or an interface from a browser. That is all.

* It changes nothing about consensus.
* It does not let a page act for a user. A transaction still has to be signed with a key the page
  does not have, and it carries the chain id and address prefix of the one network it was signed for,
  so a page on one network's domain cannot move funds on another's.
* Without it a browser refuses the call, and the node answers `403 origin not allowed`. That is what
  stops an unknown website from reading a node on a visitor's behalf.

## The project's own domain, trusted by default

`obsmainnet.us.ci` and **every subdomain beneath it** are trusted by default, over HTTPS only. These
are the names the project uses:

| Hostname | Used for |
| --- | --- |
| `obsmainnet.us.ci` | the mainnet interface: the landing page and every site |
| `api.obsmainnet.us.ci` | the mainnet node's API |
| `devnet.obsmainnet.us.ci` | the devnet interface |
| `testnet.obsmainnet.us.ci` | the testnet interface |
| `staging.obsmainnet.us.ci` | the staging interface |
| `wallet.`, `explorer.`, `mine.`, `ons.`, `node.`, `developer.`, `interface.` + `obsmainnet.us.ci` | mainnet's sites, when each is served on its own host |

How you lay these out is yours to choose: the software only needs the names to sit under the domain.
Any other subdomain you create later is trusted the moment it exists, with nothing to configure.

A node reports what it knows about itself on `GET /network`: `domains` is the list of hostnames **of its
own network** (a devnet node names `devnet.obsmainnet.us.ci` and none of mainnet's, because those names
are what people check a wallet address against), and `trust` says whether the official domain is trusted
and by which patterns.

## What a trusted page can reach

| | Node | Interface |
| --- | --- | --- |
| Chain reads (`/status`, `/blocks`, `/names/…`, …) | yes | yes (`/api/rpc`, `/api/nodes`, `/api/health`) |
| Submitting a signed transaction | yes | yes (`/api/rpc?path=/tx/submit`) |
| Cookies, accounts, sessions, wallet linking | none exist | **no** — same-origin only |

The interface keeps accounts out of reach on purpose. Cookies are host-only, and a page on a sibling
subdomain is a different origin; letting every subdomain act as a signed-in user would mean that taking
over one forgotten subdomain takes over every account. The official domain is therefore trusted for
**reading the chain and relaying transactions**, with no cookies, and an interface answers it with no
`Access-Control-Allow-Credentials`.

The interface's own pages still call only their own origin (its Content-Security-Policy is
`connect-src 'self'`). Cross-origin trust matters for pages hosted somewhere else — a static site on its
own subdomain, a third-party tool — that call `api.obsmainnet.us.ci` or an interface directly.

## Adding your own domains

Two settings take a list, one for the node and one for the interface. Each entry is an **exact origin**
or a **whole-subdomain pattern**:

```bash
# Node: pages that may read this node.
OBSIDIAN_RPC_CORS_ORIGINS=https://wallet.example.org,https://*.example.net

# Interface: pages that may call this interface WITH COOKIES (accounts, sessions).
OBSIDIAN_INTERFACE_ALLOWED_ORIGINS=https://app.example.org
```

* `https://wallet.example.org` matches that origin and no other.
* `https://*.example.net` matches `https://a.example.net` and `https://a.b.example.net`. It does **not**
  match `https://example.net` itself: write that one too if you want it.
* An entry in the **interface** list gets the full treatment, cookies included. Listing an origin there
  is a statement that every page it serves is as trusted as the interface's own.
* The node's list is for the node's public API only, which has no cookies. A node also still accepts `*`
  (every origin) if you write it on purpose; never combine that with a public RPC port.

What is refused when the configuration is read, with the reason, so a typo is never silently ignored:

* a wildcard on a public suffix or a shared host — `*.com`, `*.co.uk`, `*.github.io`, `*.vercel.app`,
  `*.us.ci` — because that would trust strangers; write the name you own (`*.yourname.us.ci`);
* a wildcard over plain HTTP, or with the `*` anywhere but the whole left-most label;
* a path, a query, a fragment or a user name; a missing scheme.

Matching is by whole labels, on a dot. `https://*.example.net` does not match
`https://example.net.evil.test`, `https://evilexample.net` or `https://example.net@evil.test`.

## Turning the default off

```bash
OBSIDIAN_RPC_TRUST_OFFICIAL_DOMAINS=false          # node
OBSIDIAN_INTERFACE_TRUST_OFFICIAL_DOMAINS=false    # interface (or the flag --no-trust-official-domains)
```

A node run this way answers a browser only for the origins in its own list.

## Checking it

```bash
# Allowed: the answer names the page that asked.
curl -s -D - -o /dev/null -H 'Origin: https://wallet.obsmainnet.us.ci' http://127.0.0.1:8630/status | grep -i '^access-control'

# Refused: 403, with no access-control header.
curl -s -w ' [%{http_code}]\n' -H 'Origin: https://obsmainnet.us.ci.evil.test' http://127.0.0.1:8630/status
```

A request with no `Origin` header at all (curl, the interface server talking to its node, another node)
is never affected by any of this.

## Behind Cloudflare or nginx

* Pass the `Origin` header through to the interface and the node, and do not add a CORS header of your
  own: the software sets exactly the headers described above, and a second one makes browsers refuse the
  response.
* The edge gateway in `cloudflare/` caches chain reads. A cached answer to one site carries that site's
  name in `Access-Control-Allow-Origin`, so the gateway keeps a separate entry for every origin that asks
  and never serves one site's copy to another.
* A subdomain you stop using should lose its DNS record the same day. A name that points nowhere can be
  claimed by someone else, and they would then be on a trusted domain.
