# Obsidian Network 1.1.0

Built from commit `3a0651880f094bec04de83907f9fe96e7f51bd53` at 2026-09-30T18:23:47Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
./verify-release.sh obsidian-core-1.1.0.tar.gz   # extract, build, test
```

## Assets

* obsidian-cloudflare-1.1.0.tar.gz
* obsidian-cloudflare-1.1.0.zip
* obsidian-core-1.1.0.tar.gz
* obsidian-core-1.1.0.zip
* obsidian-interface-1.1.0.tar.gz
* obsidian-interface-1.1.0.zip
* obsidian-interface-selfhost-1.1.0.tar.gz
* obsidian-interface-selfhost-1.1.0.zip
* obsidian-network-source-1.1.0.tar.gz
* obsidian-node-operator-1.1.0.tar.gz
* obsidian-node-operator-1.1.0.zip

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
* 363 automated tests run before packaging: core (233), interface (123), edge worker (7). The three-node cluster end-to-end suite was skipped (--skip-e2e): run `node --test tests/e2e/cluster.test.mjs` before trusting this build.
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
