# Obsidian Network documentation

Start here, then read only what you need. Every document describes what the
software in this repository actually does — including the places where it does
less than you might hope, which are called out explicitly rather than buried.

## For everyone

| Document | What it answers |
| --- | --- |
| [protocol.md](protocol.md) | How the chain works: blocks, transactions, state roots, consensus, the four networks |
| [consensus.md](consensus.md) | Block validity, fork choice, reorganisation, the validator set and jailing |
| [economics.md](economics.md) | Issuance, every OBS-denominated fee, the exact 90/10 ONS revenue split, node runner rewards and the supply invariant |
| [proof-of-time.md](proof-of-time.md) | What Proof of Time is, how time is established and verified, PoT Difficulty, Time-Rate, and why cryptographic hashing does not make this a proof-of-work chain |
| [mining.md](mining.md) | How OBS is issued, how a claim works, why your device clock is irrelevant |
| [wallet.md](wallet.md) | Where keys live, what a backup actually is, what "non-custodial" costs you |
| [security-model.md](security-model.md) | What is trusted, what is not, and the honest limitations |
| [faq.md](faq.md) | The questions people ask first, answered without marketing |
| [removal-report.md](removal-report.md) | The mechanisms that were removed, and how to verify their absence yourself |

## For users of the products

| Document | Product |
| --- | --- |
| [ons.md](ons.md) | `.obs` names: registration, renewal, transfer, resolution — the protocol's only revenue source |
| [wallet.md](wallet.md) | Keys, backups, and what a non-custodial wallet costs you |
| [mining.md](mining.md) | The claim schedule and how A PoT chain issues OBS |
| [explorer.md](explorer.md) | What the explorer shows and why it never shows balances |

## For operators and developers

| Document | Audience |
| --- | --- |
| [TERMUX-QUICKSTART.md](TERMUX-QUICKSTART.md) | **On a phone? Start here.** Only the commands to paste: set up once, then one section per network (devnet, testnet, staging, mainnet), then what to do when it does not work, and how to upgrade |
| [LAUNCH-GUIDE.md](LAUNCH-GUIDE.md) | **Start here to run anything.** Termux on Android step by step, then devnet, testnet, staging and mainnet each in its own section with its own commands and ports, the interface, and hosting |
| [node-operator.md](node-operator.md) | Anyone running a node: ports, keystore, seeds, monitoring, upgrades, backups |
| [node-runner-rewards.md](node-runner-rewards.md) | The 90/10 ONS revenue split, registering a reward wallet, how uptime and participation are measured without self-reporting, and how payouts are settled |
| [self-hosting.md](self-hosting.md) | Anyone running the interface: systemd, Docker, nginx, Cloudflare |
| [trusted-domains.md](trusted-domains.md) | Which browser origins a node or interface answers: the project's own domain by default, how to add yours (exact origins and wildcards), what is refused |
| [api.md](api.md) | Every RPC route, with the fields it returns |
| [transaction-format.md](transaction-format.md) | Canonical encoding, signing, gas, and how to submit without the interface |
| [release-process.md](release-process.md) | How a release is versioned, built, gated, signed and checked for peering compatibility |
| [release-verification.md](release-verification.md) | How to verify a release archive before running it |
| [mainnet-launch.md](mainnet-launch.md) | The launch runbook: bootstrap set, genesis verification, the allocation event, monitoring, rollback, and the launch checklist |
| [DEPLOYMENT-GUIDE.md](DEPLOYMENT-GUIDE.md) | The long-form beginner's guide that explains the concepts behind the commands: Git, releases, keys, nodes, networks, from one phone to a three-node mainnet |
| [DEVNET-TERMUX-RUNBOOK.md](DEVNET-TERMUX-RUNBOOK.md) | A devnet on an Android phone with Termux, and a tour of the whole platform with checks along the way (devnet only) |
| [ORACLE-VPS-DEPLOYMENT.md](ORACLE-VPS-DEPLOYMENT.md) | Hosting nodes and interfaces on Oracle Cloud, free tier and paid: the account, the server, both firewalls, one systemd service per network, nginx and HTTPS, backups |
| [soak-testing.md](soak-testing.md) | Running the soak harness and reading its CSV output |

## Reproducing every claim

```bash
# core: consensus, protocol and security suites
cd obsidian-core && npm ci && npm run build && npm test

# interface: sessions, invites, node failover, security headers
cd ../obsidian-interface && npm ci && npm run build && npm test

# edge: the gateway is a cache and a proxy, never an authority
cd .. && node --test cloudflare/test/worker.test.mjs

# scripts and live nodes: signing, the helper script, three nodes, four networks side by side
node --test tests/scripts/*.test.mjs tests/e2e/cluster.test.mjs tests/e2e/networks.test.mjs tests/e2e/ecosystem.test.mjs
node scripts/check-invariants.mjs

# release archives and checksums (this also runs everything above)
./scripts/package-releases.sh && (cd releases && sha256sum -c SHA256SUMS)
```
