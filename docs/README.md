# Obsidian Network documentation

Start here, then read only what you need. Every document describes what the
software in this repository actually does — including the places where it does
less than you might hope, which are called out explicitly rather than buried.

## For everyone

| Document | What it answers |
| --- | --- |
| [Obsidian-Network-Technical-Paper.pdf](Obsidian-Network-Technical-Paper.pdf) | The whole network in one readable PDF: architecture, Proof of Time consensus, finality, mining and the gate, economics, node rewards, security model and limitations (a summary of the documents below, not a replacement) |
| [protocol.md](protocol.md) | How the chain works: blocks, transactions, state roots, consensus, the four networks |
| [consensus.md](consensus.md) | Block validity, fork choice, reorganisation, the producer schedule, derived finality and suspension |
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
| [web-separation.md](web-separation.md) | The main platform, the Web App and the Wallet web app as three services on three ports (8789 / 8790 / 8791) behind three nginx vhosts: install, port check, verification, rollback |
| [numeric-display.md](numeric-display.md) | How amounts, counts and long addresses or ids are shown on every interface: the one formatter, the shortening policy, copy and accessibility rules, and the layout rules that keep long values inside their card |
| [trusted-domains.md](trusted-domains.md) | Which browser origins a node or interface answers: the project's own domain by default, how to add yours (exact origins and wildcards), what is refused |
| [marketplace-v2.0.0.md](marketplace-v2.0.0.md) | The ONS Marketplace: fixed-price listings, the listing lock, buying, offers and escrow, the state machines, fees, reads, and what is and is not supported |
| [upgrading-2.0.0.md](upgrading-2.0.0.md) | Moving to 2.0.0: a new genesis with no migration, what changed for each reader, a fresh devnet and a Marketplace walk-through |
| [upgrading-2.0.2.md](upgrading-2.0.2.md) | Moving to 2.0.2: the consensus changes (minimum gas and transfer, two-slot future drift), a new genesis, what to check |
| [attack-campaign-2.0.2.md](attack-campaign-2.0.2.md) | The five-round attack campaign: what worked against 2.0.1, what stops it now, and the one attack class that is still open (Sybil nodes) |
| [auth-incident-2.0.2.md](auth-incident-2.0.2.md) | Sign-in refused after registration on mainnet: what was verified, the three defects fixed, a read-only diagnosis tool, and the reviewed deployment and rollback plan |
| [upgrading-2.0.1.md](upgrading-2.0.1.md) | Moving to 2.0.1: the two consensus fixes (registration inside the grace period, canonical recipient addresses), a new genesis, what to check |
| [upgrading-1.9.0.md](upgrading-1.9.0.md) | Moving to 1.9.0: a fresh start with no migration, what changed for each reader, a fresh devnet step by step, how to check that nodes agree |
| [consensus-v1.9.0.md](consensus-v1.9.0.md) | The consensus specification: slots, producer schedule, eligibility, timestamps, skipped slots, duplicate blocks, fork choice, equivocation, recovery, Sybil limits, and what the tests establish |
| [finality-v1.9.0.md](finality-v1.9.0.md) | Producer-diversity checkpoint finality: the rule, the state, restart and partitions, and exactly what it does not guarantee |
| [node-binding-v1.9.0.md](node-binding-v1.9.0.md) | Binding a node to a reward wallet with no gas and no signature: uniqueness, atomicity, change and reclaim, and why squatting is possible |
| [node-rewards-v1.9.0.md](node-rewards-v1.9.0.md) | The 90 % reward formula: pool source, periods, uptime evidence, weights, rounding, caps, remainder and safeguards |
| [consensus-assumptions.md](consensus-assumptions.md) | What consensus and finality assume, what the tests establish and where safety cannot be justified (no independent verification is claimed) |
| [gate-recovery-runbook.md](gate-recovery-runbook.md) | Gate key theft, loss, lost majority, lost node, lost platform host: the steps |
| [wallet-custody.md](wallet-custody.md) | Who holds wallet keys, the vault format, what was reviewed and what was not |
| [release-signing.md](release-signing.md) | Signing a release, pinning the publisher fingerprint, verifying on a clean machine, reproducing a build |
| [gate-authority.md](gate-authority.md) | Rotating, revoking and recovering the mining gate keys on chain (1.8.0): the update rule, `gate propose/sign/submit`, playbooks |
| [operations.md](operations.md) | Bootstrap a network (`init`), join one (`join`), `status` / `peers` / `sync` / `doctor`, health endpoints, ports, the gate authority and its limits |
| [failover-and-gateways.md](failover-and-gateways.md) | Running several interface hosts: what can fail over, nginx upstreams, the DNS/TLS work that is outside the repository (untested) |
| [threat-model.md](threat-model.md) | Threats, controls and the tests that pin them, and the risks that remain |
| [security-audit-master.md](security-audit-master.md) | Findings of the master audit pass: severity, location, status, regression test |
| [obsidian-mobile-blueprint.md](obsidian-mobile-blueprint.md) | Developers of the app interfaces: what the mobile design blueprint defines, and the five placeholder behaviours in it that must never be ported as blockchain facts |
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
