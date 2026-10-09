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
10. **One validator is one vote, and the bond is the admission barrier — not vote
    weight.** Every active validator holds exactly 20,000 OBS, casts exactly one
    finality vote, and counts exactly once in the committee hash and the 2/3+1
    quorum. Nothing is weighted by stake, and bond size cannot buy influence:
    a second seat costs a second full bond. That makes the honest cost of
    controlling a quorum *n/2 × 20,000 OBS plus the ability to lose half of it on
    a provable offence*, but it also means the barrier to entry is a fixed amount
    of capital rather than a share of a pool. **This is a deliberate design
    choice, not an oversight, and it is not being changed here.** A
    stake-weighted upgrade would be a separate, larger change: the quorum rule,
    the committee hash, the certificate format, the evidence rules, the P2P
    messages and every test would have to move together, because a committee hash
    computed one way and a quorum counted another way is a consensus split. It is
    documented as future work in `docs/consensus.md`, not implemented.
11. **Sybil resistance comes from the bond, and only from the bond.** There is no
    identity check, no proof of personhood and no anti-collusion mechanism: anyone
    who can fund *k* separate 20,000 OBS bonds controls *k* seats and *k* votes,
    and no amount of code in this repository can tell the difference between one
    operator with ten seats and ten operators. The protocol's answer is economic
    — each seat costs a full bond and each offence forfeits half of it — and the
    honest statement of the residual risk is that a well-funded single actor can
    hold a majority. Mitigations that exist: the exact bond (no discount, no
    partial seat), duplicate-identity prevention (a registration binds one key to
    one sender, and a slashed registration cannot re-register without claiming
    the remainder and bonding a fresh 20,000), and equal voting weight so that
    splitting a large holding across seats buys no extra influence.
12. **No independent security audit has been performed.** The analysis in this
    repository — including the 1.6.1 consensus and slashing remediation — was
    written and reviewed by the same people who wrote the code, with adversarial
    tests as the check. That is not a substitute for an external review, and no
    claim of independent verification is made anywhere in these documents.
13. **Crash and power-loss behaviour is reasoned about and unit-tested, not
    tested against real hardware.** Durability follows a fixed order (block, then
    state and events, then the canonical marker and checkpoint, then the in-memory
    head, then publication), and the tests simulate a process that dies between
    steps by rebuilding from storage. Nobody has pulled the plug on a machine
    running this node, and no filesystem-level fault injection has been run.
14. **The network layer has not been tested against a hostile peer.** Per-link
    token buckets, bounded queues, bounded evidence and the relay caps are all
    implemented and unit-tested, and every peer-supplied object is validated
    before it is trusted. What has not been done is a sustained adversarial
    campaign: no fuzzed handshake, no eclipse attempt, no partition-and-rejoin
    soak, no measurement of a node's behaviour under a real sybil flood. The
    bounds are there; the confidence that they are sufficient is not.

## 4. Threats and mitigations

| Threat | Mitigation in this codebase | Regression test |
| --- | --- | --- |
| Forged sign-in (a client asserting `miningEnabled`, `mfaEnabled`, an account id) | no client-supplied flag is ever read; the server derives everything from the password hash, the invite and the TOTP step it verified | `obsidian-interface/tests/server.test.ts` |
| Many mining accounts from one inbox | uniqueness is checked against a canonical Gmail address (dots and `+tags` removed) computed server-side, and enforced in the store with no await between check and insert | `obsidian-interface/tests/identity.test.ts`, `tests/server.test.ts` |
| Replayed TOTP code | the consumed step is recorded; the same code is refused afterwards | `obsidian-interface/tests/identity.test.ts` |
| Reused recovery code | codes are stored only as scrypt hashes and removed the moment one matches | `obsidian-interface/tests/server.test.ts` |
| Invite farming | 5 invites per account enforced in the store, not the page | `tests/server.test.ts` |
| Mining claim posted straight to a node, skipping the account system | consensus (1.7.0): a `MINING_CLAIM` needs a certificate from a genesis-committed issuer key, bound to one network, wallet and claim id, valid ~15 min; checked in the mempool, producer, validator and replay; no committed key means no claim | `obsidian-core/tests/security/mining-gate.test.ts`, `tests/e2e/ecosystem.test.mjs` |
| Unbounded name-registry read | `/names` and `getnames` page at most 500 records | `obsidian-core/tests/security/rpc-hardening.test.ts` |
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
| Validator equivocation | two conflicting signed proposals or two conflicting finality votes for one slot forfeit half the validator bond to the Mining Pool, enforced in the state transition on every node; being offline is never slashable | `obsidian-core/tests/security/slashing.test.ts` |
| Own bond escaping after equivocating | the offence is charged to the registration that held the bond, and an `UNBONDING` or `JAILED` registration is still liable for its whole tenure — leaving the committee does not close the record, it only starts the clock (20,160 blocks). Claiming the remainder closes it, and a re-registered key answers for its new tenure only | `obsidian-core/tests/security/slashing.test.ts` |
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
