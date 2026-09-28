# Security model

This document states what is trusted, what is not, and where the software is
weaker than the marketing of a typical blockchain project. Read the third section
before trusting anything.

## 1. Source of truth

```
consensus  →  node state  →  verified chain data  →  APIs and indexes  →  frontend cache
```

The arrow never points backwards. Concretely:

* a website cannot create, move or destroy OBS;
* a CDN cannot change what a transaction does;
* a database is never the ledger — the ledger is the chain, and any node can
  rebuild it from blocks;
* the browser clock never decides eligibility, expiry or reward;
* the interface stores no balances: it reads them from a node when a user asks,
  and it refuses to expose them on the explorer surface.

## 2. What is trusted

| Component | Trusted for | Not trusted for |
| --- | --- | --- |
| Obsidian Core node | validating and serving chain data | — (it is the reference implementation; run your own to check it) |
| Interface server | proxying to healthy nodes, holding invite state | keys, funds, prices, balances, consensus |
| Browser | generating and holding keys, signing | anything it asserts about the chain — nodes verify signatures |
| Google (optional) | proving an email belongs to a person at sign-in time | identity inside the protocol, wallet derivation, authorisation |
| Cloudflare / any CDN | caching and forwarding bytes | being an authority; a cached answer is labelled as cached and expires in seconds |
| Oracle sources | publishing price observations | deciding the price alone — the median of ≥2 fresh sources is used, within bounds |

## 3. Honest limitations

1. **Time capsules cannot force a secret out of a chain.** The protocol locks,
   commits and unlocks on time without the creator — but the payload is
   ciphertext the creator holds. A "preview" shows the teaser; a genuine reveal
   requires the creator to publish the key at or after `unlockAt`. Stated in
   `docs/capsules.md` and in the interface itself.
2. **A capsule file lost is a capsule unreadable.** The chain keeps the
   fingerprint, not the message.
3. **Mining is not free money.** 0.001 OBS/day at launch. The schedule is in
   `docs/mining.md`; anyone reading it carefully will see that early issuance is
   deliberately small.
4. **Direct messages are end-to-end encrypted by the interface, not by the
   protocol.** The chain records that a message transaction exists. Content
   confidentiality depends on the browser code you are running; use the
   self-hosted interface and read `web/src/pages/social.ts` if that matters to you.
5. **A weak keystore passphrase is a weak wallet.** The vault uses
   PBKDF2-SHA256 (210,000 iterations) + AES-256-GCM. That is strong against casual
   attacks and not against a serious cracker. Use a long passphrase.
6. **A malicious node can lie to you about state; it cannot forge a signature.**
   If you need certainty, run a node and compare. The interface mitigates this by
   reading multiple nodes, flagging genesis mismatches, and naming the node that
   answered.
7. **The oracle is a real trust surface.** Prices are a median of submissions
   within bounds and freshness limits; a majority of colluding sources could move
   a dollar-priced feature within that band. The blast radius is deliberately
   limited: the protocol *refuses* to act rather than guessing when sources are
   stale or disagree by more than 25%.
8. **Docker images were not built in the development environment used to write
   this repository.** The Dockerfiles and compose files are validated for
   structure, and `deployment/docker/verify.sh` exists to build, start and probe
   them — run it on your machine before trusting them (see
   `docs/IMPLEMENTATION-REPORT.md`, item 12).
9. **One chain, one history: reorgs deeper than 256 blocks are refused.** Above
   that depth the node stops rather than pretending; this is a deliberate
   conservative bound, not an oversight.

## 4. Threats and mitigations

| Threat | Mitigation in this codebase | Regression test |
| --- | --- | --- |
| Forged sign-in (`isGoogleUser: true`) | the flag is never read; the ID token is verified against Google's JWKS server-side | `obsidian-interface/tests/server.test.ts` |
| Invite farming | 5 invites per account enforced in the store, not the page | `tests/server.test.ts` |
| Replayed mining claim | unique `claimId` + per-wallet sequence + nonce + one claim per wallet per block | `obsidian-core/tests/security/protocol-security.test.ts` |
| Mined transaction re-mined | spent transaction id and advanced sequence | same |
| Gas underpayment | deterministic `expectedGas` equality check | `tests/security/protocol-security.test.ts` |
| Cross-network transaction | chain id, network id, genesis id and address prefix must match | `tests/security/rpc-hardening.test.ts` |
| Explorer used for balance surveillance | balance routes absent on explorer surfaces; addresses masked | `tests/security/rpc-hardening.test.ts` |
| Interface used as an open proxy | exact-route allowlist; traversal rejected | `obsidian-interface/tests/server.test.ts` |
| Oversized body → crash | hard ceiling answered with 413, drained socket | `tests/server.test.ts` |
| Session leak via CDN | `/api/auth/*` and cookie-bearing requests bypass caches | `cloudflare/test/worker.test.mjs` |
| Silent consensus split | genesis mismatch flagged; majority genesis wins reads | `tests/nodes.test.ts` |
| Admin mint | no mint path exists; supply invariant asserted on every run | `tests/security/protocol-security.test.ts`, `/audit/compliance` |
| Unauthorised treasury spend | treasury transactions must be signed by the treasury wallet | `tests/integration/applications.test.ts` |
| Peer-table poisoning / self-inflicted network partition | a refused socket is retried with exponential back-off instead of being banned, and dedupe by `nodeId` keeps exactly one live link per peer so duplicated connections cannot crowd out honest ones | `obsidian-core/tests/unit/peer-retry.test.ts` |
| Dishonest peer feeding bad blocks | invalid blocks and malformed messages cost score and earn a one-hour ban; reachability failures never do | same |

## 5. What a security review should look at first

1. `obsidian-core/src/blockchain/state-machine.ts` — the state transition itself.
2. `obsidian-core/src/transactions/executors/*` — per-type authorisation rules.
3. `obsidian-core/src/consensus/*` — fork choice, difficulty, finality bounds.
4. `obsidian-interface/web/src/lib/wallet.ts` — the only code that touches keys.
5. `obsidian-interface/server/index.ts` — the trust boundary between browser and
   node.
