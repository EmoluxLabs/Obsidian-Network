# Obsidian Network 1.8.1

Built from commit `929f0d6fb07cdc63e2ba1578b37ba76e61ad1c20` at 2026-10-12T14:29:54Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
bash ../scripts/verify-release.sh obsidian-core-1.8.1.tar.gz --with-tests
```

SHA-256 verifies integrity, not publisher authorship. A release is **authenticated**
only when it carries `RELEASE-SIGNATURE.json` and you verify it against a publisher
fingerprint you obtained out of band:

```bash
node scripts/release-tool.mjs verify --releases releases --fingerprint '<pinned fingerprint>' --repo . --tag v1.8.1 --require-sbom
```

Without that file this is an unsigned candidate. Reproduce it independently with
`scripts/reproduce-release.sh` (docs/release-signing.md).

## Assets

* obsidian-app-web-1.8.1.tar.gz
* obsidian-app-web-1.8.1.zip
* obsidian-cloudflare-1.8.1.tar.gz
* obsidian-cloudflare-1.8.1.zip
* obsidian-core-1.8.1.tar.gz
* obsidian-core-1.8.1.zip
* obsidian-extension-1.8.1.tar.gz
* obsidian-extension-1.8.1.zip
* obsidian-interface-1.8.1.tar.gz
* obsidian-interface-1.8.1.zip
* obsidian-interface-selfhost-1.8.1.tar.gz
* obsidian-interface-selfhost-1.8.1.zip
* obsidian-network-source-1.8.1.tar.gz
* obsidian-node-desktop-1.8.1.tar.gz
* obsidian-node-desktop-1.8.1.zip
* obsidian-node-operator-1.8.1.tar.gz
* obsidian-node-operator-1.8.1.zip
* obsidian-wallet-web-1.8.1.tar.gz
* obsidian-wallet-web-1.8.1.zip

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
* protocol 1.8.1 is genesis-bound: it rejects 1.7.x and older peers and data and includes no live-chain
  migration (see docs/upgrading-1.8.0.md). `v1.7.0` is untouched
* **new in 1.8.0, consensus:** the mining gate keys can be rotated, revoked and recovered on chain by a majority of the
  current keys (`GATE_AUTHORITY`, `obsidian gate status|propose|sign|submit`, `init --gate-key-count`; docs/gate-authority.md).
  A lost majority is recoverable only by a new genesis
* **new in 1.8.0, operations:** `obsidian start` hosts the interface by default (`--no-interface` or
  `OBSIDIAN_NODE_ONLY=1` opts out); interface roles `primary`/`edge` for several hosts (accounts are not replicated);
  `/peers` detail is local-only; `health`/`finality` CLI reads are time-bounded; `init`, `join`, `status`, `peers`,
  `sync`, `doctor`, `/livez`, `/readyz`; the `mineobs.network` trusted-origin policy
* the archives now also carry the web app, the web wallet, the extension and the desktop sources
* nothing is signed: no publisher key exists, so these archives prove integrity, not authorship
* 1408 automated tests, all of them run immediately before packaging: core (656), interface (354), edge worker (17), web app, web wallet and extension (285), release verification and signing behaviour (6), soak verdict rules (5), the genesis invitation generator (3), repository consistency (29), the three-node cluster end-to-end suite (15) and the four-network isolation suite, the interface-to-node ecosystem suite, the per-network helper script and the Termux quick-start page run as written (38)
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
