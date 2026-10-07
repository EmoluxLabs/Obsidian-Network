# Optional infrastructure-as-code for the edge layer.
#
#   terraform init && terraform plan -var 'zone_id=...' -var 'domain=obsidian.example'
#
# Nothing here is required for the chain to function, and nothing here holds a
# key or a secret that could move OBS. Deleting the whole configuration leaves
# the network untouched: it removes a cache in front of a reader.

terraform {
  required_version = ">= 1.6"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.40"
    }
  }
}

variable "zone_id" {
  type        = string
  description = "Cloudflare zone id for the domain that hosts the interface."
}

variable "domain" {
  type        = string
  description = "Apex domain, e.g. obsidian.example"
}

variable "interface_host" {
  type        = string
  description = "Interface origin hostname (the thing the CDN is allowed to read)."
}

resource "cloudflare_record" "interface" {
  zone_id = var.zone_id
  name    = "interface"
  type    = "CNAME"
  content = var.interface_host
  proxied = true
  comment = "Obsidian Interface (self-hosted reader). Cacheable; never authoritative."
}

resource "cloudflare_record" "seed" {
  count   = 2
  zone_id = var.zone_id
  name    = "seed${count.index + 1}"
  type    = "A"
  content = var.seed_ips[count.index]
  proxied = false
  comment = "Obsidian Core bootstrap peer (port 8631). Never proxied: p2p is node-to-node traffic."
}

variable "seed_ips" {
  type        = list(string)
  description = "Public IPs of two or more bootstrap nodes."
}

# The reads that are public, identical for every visitor, and fine to be five
# seconds old. This list is the same one src/worker.js caches (and a test pins
# the two together). Everything else under /api/rpc is NOT cached: in particular
# `/wallet/<address>/next-nonce` (a stale nonce makes a wallet's second
# transaction collide with its first), `/mining/status`, `/mempool`, `/tx/` and
# `/address/`. The rule below overrides the origin's `Cache-Control: no-store`,
# so it must never be wider than this list.
locals {
  cacheable_rpc_paths = [
    "/status", "/blocks", "/names",
    "/mining/schedule", "/oracle", "/network", "/audit", "/pot", "/revenue", "/nodes",
  ]
  cacheable_expression = join(" or ", [
    for p in local.cacheable_rpc_paths :
    "(http.request.uri.path eq \"/api/rpc\" and starts_with(http.request.uri.query, \"path=${p}\"))"
  ])
}

# Cache only the read surface, and only briefly.
resource "cloudflare_ruleset" "cache" {
  zone_id     = var.zone_id
  name        = "obsidian cache"
  description = "Short TTLs on chain reads; never cache writes, sessions or documents"
  kind        = "zone"
  phase       = "http_request_cache_settings"

  rules {
    action      = "set_cache_settings"
    description = "Chain reads may be five seconds old, and keep their x-obsidian-node header"
    expression  = "(${local.cacheable_expression}) and not http.cookie contains \"obsidian_session\""
    enabled     = true

    action_parameters {
      cache = true
      edge_ttl {
        mode    = "override_origin"
        default = 5
      }
    }
  }
}

# Rate limit transaction submission. The interface's own body ceiling and node
# validation still apply; this only stops bulk noise at the edge.
resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.zone_id
  name        = "obsidian rate limits"
  description = "Protect the interface, not the consensus"
  kind        = "zone"
  phase       = "http_ratelimit"

  rules {
    action      = "block"
    description = "Transaction submission: 30/min per IP"
    expression  = "(http.request.uri.path eq \"/api/rpc\" and http.request.method eq \"POST\")"
    enabled     = true

    ratelimit {
      characteristics     = ["ip.src"]
      period              = 60
      requests_per_period = 30
      mitigation_timeout  = 60
    }
  }
}
