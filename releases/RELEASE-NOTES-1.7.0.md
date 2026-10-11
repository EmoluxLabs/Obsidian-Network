# Obsidian Network 1.7.0

Built from commit `707aae00d75a707d4bba9ab90b75359551eb6aac` at 2026-10-11T20:41:21Z.

## Verify before you run

```bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
bash ../scripts/verify-release.sh obsidian-core-1.7.0.tar.gz --with-tests
```

This locally produced candidate is **unsigned**. SHA-256 verifies integrity, not
publisher authorship. Do not treat it as an independently reproduced or signed
public release.

## Assets

* obsidian-cloudflare-1.7.0.tar.gz
* obsidian-cloudflare-1.7.0.zip
* obsidian-core-1.7.0.tar.gz
* obsidian-core-1.7.0.zip
* obsidian-interface-1.7.0.tar.gz
* obsidian-interface-1.7.0.zip
* obsidian-interface-selfhost-1.7.0.tar.gz
* obsidian-interface-selfhost-1.7.0.zip
* obsidian-network-source-1.7.0.tar.gz
* obsidian-node-operator-1.7.0.tar.gz
* obsidian-node-operator-1.7.0.zip

| Asset | Contents |
| --- | --- |
| obsidian-core | the node: source, tests, built `dist/`, deployment recipes |
| obsidian-interface | the reader: server, tests, browser bundles, every site directory (nine pages, light and mobile-first) |
| obsidian-cloudflare | the edge gateway: worker, tests, Terraform |
| obsidian-node-operator | what an operator installs: built node, systemd/nginx/Docker recipes, docs |
| obsidian-interface-selfhost | a ready-to-serve interface: built bundles, sites, systemd/nginx/Docker recipes |
| obsidian-network-source | the entire repository at this commit |

## What is in this release

* Proof of Time block production plus native sequential checkpoint finality:
  `floor(2N/3)+1` equal active-validator memberships, a 64-parent-state
  stable-set bootstrap, finalized-history reorg protection, and signed bounded
  proposer/vote equivocation evidence
* fork choice is finalized anchor → fixed PoT weight → height → the lowest
  block hash, so equal-height ties resolve identically on every node
* a mining claim is valid only with a certificate from the mining gate: the
  issuer public keys are committed in genesis and hashed into the genesis id, so
  every node of a network must be given the same list, and a chain that commits
  none accepts no claim (it fails closed)
* protocol 1.7.0 is genesis-bound and rejects peers and data directories of
  earlier protocol versions at the handshake; it does not include a live-chain
  migration
* name registry reads are bounded (`limit`/`offset`/`prefix` on `GET /names`,
  `getnames` over JSON-RPC), and block sync no longer stalls when a peer serves
  fewer blocks than the requested overlap
* four applications ship in this release: `obsidian-app-web/` (the web app),
  `obsidian-wallet-web/` (Obsidian Wallet, the non-custodial browser wallet),
  `obsidian-extension/` (Obsidian Node Extension, MV3) and
  `obsidian-node-desktop/` (Obsidian Node, the Electron app whose installers
  are built by `.github/workflows/desktop-release.yml`)
* 959 automated tests, all of them run immediately before packaging: core (529), interface (306), edge worker (17), release verification and signing behaviour (9), soak verdict rules (5), the genesis invitation generator (3), repository consistency (37), the three-node cluster end-to-end suite (15) and the four-network isolation suite, the interface-to-node ecosystem suite, the per-network helper script and the Termux quick-start page run as written (38)
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
