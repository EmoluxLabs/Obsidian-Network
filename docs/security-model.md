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
| Cloudflare / any CDN | caching and forwarding bytes | being an authority; a cached answer is labelled as cached and expires in seconds |
| Oracle sources | publishing price observations | deciding the price alone — the median of ≥2 fresh sources is used, within bounds |

## 3. Honest limitations

1. **Nothing on chain is private.** Every transaction, name and node registry
   entry is public state that any node can serve, and masked addresses are a
   privacy *measure*, not a guarantee: correlated activity can still be linked.
2. **Mining is not free money.** 0.001 OBS/day at launch. The schedule is in
   `docs/mining.md`; anyone reading it carefully will see that early issuance is
   deliberately small.
3. **A weak keystore passphrase is a weak wallet.** The vault uses
   PBKDF2-SHA256 (210,000 iterations) + AES-256-GCM. That is strong against casual
   attacks and not against a serious cracker. Use a long passphrase.
6. **A malicious node can lie to you about state; it cannot forge a signature.**
   If you need certainty, run a node and compare. The interface mitigates this by
   reading multiple nodes, flagging genesis mismatches, and naming the node that
   answered.
7. **The oracle is an unpermissioned reporting feed, not a trusted source
   registry.** Any funded account can submit and choose source identifiers;
   bounds, freshness, deviation and per-account cooldowns limit values but do not
   provide Sybil resistance. Core prices are OBS-denominated and do not consume
   this median. Treat `/oracle` as informational telemetry only.
8. **The Docker recipes are built and probed in CI, not on your machine.**
   Every push builds both images, runs a two-container stack, watches the chain
   height advance inside the container and confirms that stopping the interface
   does not stop consensus. `deployment/docker/verify.sh` repeats that locally —
   run it before trusting an image you built yourself.
9. **One chain, one history: reorgs deeper than 256 blocks are refused.** Above
   that depth the node stops rather than pretending; this is a deliberate
   conservative bound, not an oversight.

## 4. Threats and mitigations

| Threat | Mitigation in this codebase | Regression test |
| --- | --- | --- |
| Forged sign-in (a client asserting `miningEnabled`, `mfaEnabled`, an account id) | no client-supplied flag is ever read; the server derives everything from the password hash, the invite and the TOTP step it verified | `obsidian-interface/tests/server.test.ts` |
| Many mining accounts from one inbox | uniqueness is checked against a canonical Gmail address (dots and `+tags` removed) computed server-side, and enforced in the store with no await between check and insert | `obsidian-interface/tests/identity.test.ts`, `tests/server.test.ts` |
| Replayed TOTP code | the consumed step is recorded; the same code is refused afterwards | `obsidian-interface/tests/identity.test.ts` |
| Reused recovery code | codes are stored only as scrypt hashes and removed the moment one matches | `obsidian-interface/tests/server.test.ts` |
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
| Manipulated device clock used to mine early | eligibility is evaluated against block timestamps; a node's own clock can only reject a future-dated block, never admit a backdated one | `obsidian-core/tests/unit/proof-of-time.test.ts` |
| Producer back-dating or stalling chain time | timestamp must exceed median time past and strictly exceed the parent's; protocol time never falls behind the chain head | same, plus `tests/integration/consensus.test.ts` |
| Node claiming uptime it did not have | there is no field for it: uptime is counted from heartbeats that **other** registered nodes attested, and unattested heartbeats score zero | `obsidian-core/tests/unit/node-rewards.test.ts` |
| Operator registering someone else's wallet to steal rewards | the reward wallet itself must sign the registration transaction, and the node key must sign the statement | `tests/integration/node-runners.test.ts` |
| Sybil node farm | one reward identity per node per wallet, binding proven by signatures from both; uptime needs attestations from other nodes; any single node is capped at 5% of a period; a fleet cannot attest itself | same |
| Validator equivocation | two conflicting signed proposals or two conflicting finality votes for one slot forfeit half the validator bond to the Mining Pool, enforced in the state transition on every node; being offline is never slashable | new in 1.6.0 |
| An honest validator double-signing by accident | the node signs at most **one** proposal per (height, round), and the slot is written to the crash-safe safety lock *before* the signature exists — so a retry after a locally rejected block, a crash or a restart cannot produce the second header of an equivocation pair. A later round of the same height is a different slot and stays available, so the liveness backstop is unaffected | `obsidian-core/tests/security/slashing.test.ts` |
| Stolen node key redirecting rewards | a wallet change must be submitted by the **current** reward wallet and takes effect a period later; accrued rewards are never redirected | same |
| Replayed node registration proof | proofs carry `issuedAt`/`expiresAt` checked against protocol time, capped at one hour | same |
| Reward period settled twice | `lastSettledPeriod` is consensus state, and settlement is a block routine rather than a callable endpoint | same |
| ONS revenue silently diverted | the 90/10 split is exact integer arithmetic inside the state transition, asserted to sum back to the amount on every credit | `tests/unit/node-rewards.test.ts` |

## 5. What a security review should look at first

1. `obsidian-core/src/blockchain/state-machine.ts` — the state transition itself.
2. `obsidian-core/src/transactions/executors/*` — per-type authorisation rules.
3. `obsidian-core/src/consensus/*` — proposer schedule, PoT time rules, fork
   choice, reorg limits and the absence of mathematical finality.
4. `obsidian-core/src/economy/*` — the revenue split, node scoring and the
   settlement routine (the only code that pays anyone who is not a miner).
5. `obsidian-interface/web/src/lib/wallet.ts` — the only code that touches keys.
6. `obsidian-interface/server/index.ts` — the trust boundary between browser and
   node.
