# Obsidian Network 1.2.6

Built from commit `8c281eb9994dd568f6ea4614b07e463515e95c44` at 2026-10-01T19:43:30Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
./verify-release.sh obsidian-core-1.2.6.tar.gz   # extract, build, test
```

## Assets

* obsidian-cloudflare-1.2.6.tar.gz
* obsidian-cloudflare-1.2.6.zip
* obsidian-core-1.2.6.tar.gz
* obsidian-core-1.2.6.zip
* obsidian-interface-1.2.6.tar.gz
* obsidian-interface-1.2.6.zip
* obsidian-interface-selfhost-1.2.6.tar.gz
* obsidian-interface-selfhost-1.2.6.zip
* obsidian-network-source-1.2.6.tar.gz
* obsidian-node-operator-1.2.6.tar.gz
* obsidian-node-operator-1.2.6.zip

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
* 435 automated tests, all of them run immediately before packaging: core (244), interface (171), edge worker (7) and the three-node cluster end-to-end suite (13)
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
