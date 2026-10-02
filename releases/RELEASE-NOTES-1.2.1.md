# Obsidian Network 1.2.1

Built from commit `6c3a73512dc4d1dc7d2d4eb52e2e4ae780d8cc2c` at 2026-10-01T17:20:50Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
./verify-release.sh obsidian-core-1.2.1.tar.gz   # extract, build, test
```

## Assets

* obsidian-cloudflare-1.2.1.tar.gz
* obsidian-cloudflare-1.2.1.zip
* obsidian-core-1.2.1.tar.gz
* obsidian-core-1.2.1.zip
* obsidian-interface-1.2.1.tar.gz
* obsidian-interface-1.2.1.zip
* obsidian-interface-selfhost-1.2.1.tar.gz
* obsidian-interface-selfhost-1.2.1.zip
* obsidian-network-source-1.2.1.tar.gz
* obsidian-node-operator-1.2.1.tar.gz
* obsidian-node-operator-1.2.1.zip

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
* 417 automated tests, all of them run immediately before packaging: core (233), interface (164), edge worker (7) and the three-node cluster end-to-end suite (13)
* no WAC, no $5 activation, no legacy signup allocation, no admin mint, no
  native exchange — verify with `curl -s localhost:8630/audit/compliance`

## Containers

Docker images are built, started and probed by the `docker` job in CI on every
push — including a full node + interface compose stack whose chain height is
observed to advance, and a check that stopping the interface does not stop
consensus. To verify on your own machine:

```bash
bash obsidian-core/deployment/docker/verify.sh
bash obsidian-interface/deployment/docker/verify.sh
```

See `docs/IMPLEMENTATION-REPORT.md` item 12 for what that proves.
