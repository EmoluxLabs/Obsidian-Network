# Obsidian Network documentation

Start here, then read only what you need. Every document describes what the
software in this repository actually does — including the places where it does
less than you might hope, which are called out explicitly rather than buried.

## For everyone

| Document | What it answers |
| --- | --- |
| [protocol.md](protocol.md) | How the chain works: blocks, transactions, state roots, consensus, the four networks |
| [proof-of-time.md](proof-of-time.md) | What Proof of Time is, how time is established and verified, PoT Difficulty, Time-Rate, and why cryptographic hashing does not make this a proof-of-work chain |
| [mining.md](mining.md) | How OBS is issued, how a claim works, why your device clock is irrelevant |
| [wallet.md](wallet.md) | Where keys live, what a backup actually is, what "non-custodial" costs you |
| [security-model.md](security-model.md) | What is trusted, what is not, and the honest limitations |
| [faq.md](faq.md) | The questions people ask first, answered without marketing |
| [removal-report.md](removal-report.md) | The mechanisms that were removed, and how to verify their absence yourself |

## For users of the products

| Document | Product |
| --- | --- |
| [ons.md](ons.md) | `.obs` names: registration, transfer, resolution |
| [capsules.md](capsules.md) | The Time Capsule Wall, including the part that is physically impossible |
| [circle.md](circle.md) | Obsidian Circle: land, GLV/ILV/MSP, protocol pricing, buybacks |
| [social.md](social.md) | OBS Social: profiles, posts, follows, tips, business pages, DMs |
| [explorer.md](explorer.md) | What the explorer shows and why it never shows balances |

## For operators and developers

| Document | Audience |
| --- | --- |
| [node-operator.md](node-operator.md) | Anyone running a node: ports, keystore, seeds, monitoring, upgrades, backups |
| [node-runner-rewards.md](node-runner-rewards.md) | The 40/60 revenue split, registering a reward wallet, how uptime and participation are measured without self-reporting, and how payouts are settled |
| [self-hosting.md](self-hosting.md) | Anyone running the interface: systemd, Docker, nginx, Cloudflare |
| [api.md](api.md) | Every RPC route, with the fields it returns |
| [transaction-format.md](transaction-format.md) | Canonical encoding, signing, gas, and how to submit without the interface |
| [release-verification.md](release-verification.md) | How to verify a release archive before running it |

## Reports

| Document | Contents |
| --- | --- |
| [IMPLEMENTATION-REPORT.md](IMPLEMENTATION-REPORT.md) | The final 15-point report: what was built, what was verified, what is not production ready and why |

## Reproducing every claim

```bash
# core: consensus, protocol and security suites
cd obsidian-core && npm ci && npm run build && npm test

# interface: sessions, invites, node failover, security headers
cd ../obsidian-interface && npm ci && npm run verify

# edge: the gateway is a cache and a proxy, never an authority
cd ../cloudflare && node --test test/worker.test.mjs

# release archives and checksums
cd .. && ./scripts/package-releases.sh && (cd releases && sha256sum -c SHA256SUMS)
```
