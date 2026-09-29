# Obsidian Network 1.0.0

Built from commit `98fb63e66dda41336c8e06d3c2ccad8bef2ca882` at 2026-09-28T13:13:24Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
./verify-release.sh obsidian-core-1.0.0.tar.gz   # extract, build, test
```

## Assets

* obsidian-cloudflare-1.0.0.tar.gz
* obsidian-cloudflare-1.0.0.zip
* obsidian-core-1.0.0.tar.gz
* obsidian-core-1.0.0.zip
* obsidian-interface-1.0.0.tar.gz
* obsidian-interface-1.0.0.zip
* obsidian-interface-selfhost-1.0.0.tar.gz
* obsidian-interface-selfhost-1.0.0.zip
* obsidian-network-source-1.0.0.tar.gz
* obsidian-node-operator-1.0.0.tar.gz
* obsidian-node-operator-1.0.0.zip

| Asset | Contents |
| --- | --- |
| obsidian-core | the node: source, tests, built `dist/`, deployment recipes |
| obsidian-interface | the reader: server, tests, browser bundles, every site directory |
| obsidian-cloudflare | the edge gateway: worker, tests, Terraform |
| obsidian-node-operator | what an operator installs: built node, systemd/nginx/Docker recipes, docs |
| obsidian-interface-selfhost | a ready-to-serve interface: built bundles, sites, systemd/nginx/Docker recipes |
| obsidian-network-source | the entire repository at this commit |

## What is in this release

* consensus, p2p, RPC, indexer and the nine transaction executors
* 286 automated tests, all of them run immediately before packaging: core (156), interface (112), edge worker (7) and the three-node cluster end-to-end suite (11)
* no WAC, no $5 activation, no legacy signup allocation, no admin mint, no
  native exchange — verify with `curl -s localhost:8630/audit/compliance`

## What is not

Docker images were not built in the development environment (Docker is
unavailable there). Run `deployment/docker/verify.sh` on your machine before
relying on the container recipes; see `docs/IMPLEMENTATION-REPORT.md` item 12.
