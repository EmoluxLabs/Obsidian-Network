# Obsidian Network 1.8.0

Built from commit `2da363bfdec4406f5ebce29d724dde738d4874b2` at 2026-10-12T12:24:15Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
bash ../scripts/verify-release.sh obsidian-core-1.8.0.tar.gz --with-tests
```

This locally produced candidate is **unsigned**. SHA-256 verifies integrity, not
publisher authorship. Do not treat it as an independently reproduced or signed
public release.

## Assets

* obsidian-app-web-1.8.0.tar.gz
* obsidian-app-web-1.8.0.zip
* obsidian-cloudflare-1.8.0.tar.gz
* obsidian-cloudflare-1.8.0.zip
* obsidian-core-1.8.0.tar.gz
* obsidian-core-1.8.0.zip
* obsidian-extension-1.8.0.tar.gz
* obsidian-extension-1.8.0.zip
* obsidian-interface-1.8.0.tar.gz
* obsidian-interface-1.8.0.zip
* obsidian-interface-selfhost-1.8.0.tar.gz
* obsidian-interface-selfhost-1.8.0.zip
* obsidian-network-source-1.8.0.tar.gz
* obsidian-node-desktop-1.8.0.tar.gz
* obsidian-node-desktop-1.8.0.zip
* obsidian-node-operator-1.8.0.tar.gz
* obsidian-node-operator-1.8.0.zip
* obsidian-wallet-web-1.8.0.tar.gz
* obsidian-wallet-web-1.8.0.zip

| Asset | Contents |
| --- | --- |
| obsidian-core | the node: source, tests, built `dist/`, deployment recipes |
| obsidian-interface | the reader: server, tests, browser bundles, every site directory (nine pages, light and mobile-first) |
| obsidian-cloudflare | the edge gateway: worker, tests, Terraform |
| obsidian-node-operator | what an operator installs: built node, systemd/nginx/Docker recipes, docs |
| obsidian-interface-selfhost | a ready-to-serve interface: built bundles, sites, systemd/nginx/Docker recipes |
| obsidian-wallet-web | the browser wallet: source, tests, built page |
| obsidian-app-web | the web app: source, tests, built bundle |
| obsidian-extension | the browser extension: source, tests, unpacked build |
| obsidian-node-desktop | the desktop node app: source and build recipe (installers are built per platform, not here) |
| obsidian-network-source | the entire repository at this commit |

## What is in this release

* Proof of Time block production plus native sequential checkpoint finality:
  `floor(2N/3)+1` equal active-validator memberships, a 64-parent-state
  stable-set bootstrap, finalized-history reorg protection, and signed bounded
  proposer/vote equivocation evidence
* fork choice is finalized anchor → fixed PoT weight → height → the lowest
  block hash, so equal-height ties resolve identically on every node
* protocol 1.6.0 is genesis-bound and rejects 1.5.x peers/data; it does not
  include a live-chain migration
* 1349 automated tests, all of them run immediately before packaging: core (635), interface (317), edge worker (17), web app, web wallet and extension (284), release verification and signing behaviour (6), soak verdict rules (5), the genesis invitation generator (3), repository consistency (29), the three-node cluster end-to-end suite (15) and the four-network isolation suite, the interface-to-node ecosystem suite, the per-network helper script and the Termux quick-start page run as written (38)
* the first valid miner still receives 100,000 OBS and becomes treasury; ONS
  registration and renewal are the only revenue source and split exactly 90%
  node runners / 10% treasury, and the validator bond is exactly 20,000 OBS
* no WAC, no $5 activation, no legacy signup allocation, no admin mint, no
  native exchange — verify with `curl -s localhost:8630/audit/compliance`
* no claim of general BFT, universal immutability, production readiness,
  independent cryptographic review, or physical power-loss testing

## Containers

Docker images are built, started and probed by the `docker` job in CI on every
push — including a full node + interface compose stack whose chain height is
observed to advance, and a check that stopping the interface does not stop
consensus. To verify on your own machine:

```bash
bash obsidian-core/deployment/docker/verify.sh
bash obsidian-interface/deployment/docker/verify.sh
```

See `docs/security-model.md` (trust boundaries and honest limitations) and
`docs/DEPLOYMENT-GUIDE.md` "What I should deploy first" (the remaining risks) for the
verification boundary, and `.github/workflows/ci.yml` for what every gate checks.
