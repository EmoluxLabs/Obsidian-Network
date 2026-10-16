# Attack campaign for 2.0.2 — five rounds, what broke, what now stands

This is the record of a deliberate attack campaign against 2.0.1: five rounds, each starting with an exploit written as a
failing test, followed by a fix, followed by a re-attack of everything already fixed. It is written to be re-run
(`obsidian-core/tests/security/attack-r*.test.ts`, `obsidian-interface/tests/interface-hardening.test.ts` "attack round 3",
`tests/scripts/repo-consistency.test.mjs`), not to be believed.

**What it is not.** It is not an independent audit, it did not touch a live network, and it does not show the system is
secure. It shows that the specific attacks below worked against 2.0.1 and no longer work against 2.0.2, and it lists the one
attack class that still works. Nothing here makes a network "100% decentralised": decentralisation is a property of who runs
the nodes and holds the keys, and the code can only avoid adding a party everyone has to trust. **None of the 2.0.2 defences
adds one**: there is no admin key, no allow-list, no central switch, no operator-run service. Every defence is a rule each
node checks for itself from data it already has.

## Round 1 — the transaction pool

| Attack (worked against 2.0.1) | How it worked | Defence in 2.0.2 | Test |
|---|---|---|---|
| **Free fresh-key pool starvation (R26)** | A gossiped transaction was pooled after a signature check only. An empty-body `MINING_CLAIM` from a brand-new key, gas 0, costs nothing and is pooled, so the pool's 10,000 slots (and a producer's block space) can be filled by an attacker with nothing | A pool only holds what could possibly be valid: a claim needs a valid gate certificate and eligibility, a node statement must pass the registry's own check, and every other type needs an existing sender account. These checks read the head state and do not copy it. State-race failures (the sender's account not yet visible) are not blamed on the peer | `attack-r1-pool.test.ts` |
| **Registration crowding (R26)** | Valid, free node registrations could fill the pool and crowd out other evidence | Registrations have their own small class (16), as gate updates and evidence already did | same |
| **Free dust spam and state bloat (R27)** | A payment of 1 seal paid zero gas, so creating accounts cost nothing | Consensus: `gas.minGas` and `tx.minTransfer` are 0.000001 OBS | same |
| **Grindable zero-gas ordering (R28)** | Zero-gas transactions were ordered by arrival, which an attacker controls | Producer policy: paid first (by gas, then arrival), then the zero-gas class round-robin by type, so no one type or sender takes a block. This is not consensus: blocks are valid in any order | same |

## Round 2 — economic chaos

A seeded adversary (seeds 11, 4242, 90210, 140 steps each) drove node REGISTER, HEARTBEAT, ATTEST, CHANGE_WALLET, CANCEL,
RECLAIM and DEREGISTER, payments and ONS fees across many reward periods, deliberately including wrong uptime windows. After **every** step it checked: the supply invariant, no negative balance or lifetime reward, nothing paid
out of the node pool beyond what flowed in, a state snapshot that round-trips to the same root, and an unchanged state root on
every rejected block. A second scenario ran 5 diligent nodes and 12 hostile ones for 8 simulated days with real ONS revenue.
**No invariant broke.** The pool distributed exactly its inflow (0.36 OBS of 0.36 OBS), and the sum on node records equalled
`lifetimeDistributed`. `attack-r2-economy-chaos.test.ts`.

The same scenario measured a real limit, recorded as **R36** below.

## Round 3 — the interface (gateway)

| Attack | How it worked | Defence | Test |
|---|---|---|---|
| **IPv6 rotation (R30)** | Rate limits were per address. An IPv6 customer owns a /64 (2^64 addresses), so every request could carry a fresh "client" | Budgets are per IPv6 /64 (IPv4-mapped addresses are the IPv4 address) | `interface-hardening.test.ts` |
| **Limiter flood (R31)** | Once the table passed 20,000 entries it was scanned on every request, and never shrank while the entries were young: 60,000 requests from fresh keys took **24.8 s** of CPU to answer | Bounded table (least-recently-used out), at most one sweep a second | same |
| **Account lock-out (R32)** | Ten wrong passwords from anyone locked the account for 15 minutes for everyone, including the owner, repeatable forever | Failures count per (account, address block): the guesser is shut out, the owner is not. Only 100 failures from many addresses lock the account for all | same |
| **Slow clients (R33)** | The interface used Node's defaults (60 s for headers, 300 s for a body, unlimited connections) so a few thousand trickling sockets hold every descriptor | 10 s headers, 20 s request, 2,048 connections, as the node RPC already did | same |

## Round 4 — consensus and the schedule

**Slot front-running (R29).** The producer of a block is a function of its *round*, and the round is computed from the block's
own timestamp. The only clock rule was "at most 60 s ahead of my clock". One scheduled producer could therefore sign, the
moment a parent appeared, a block dated up to eleven slots ahead, choose the round in which the schedule names *it*, and publish
it seconds before the honest round-0 producer's slot opened. The same block recorded the honest producer as having *missed* its
slot, and three misses in a row suspend a node. The test builds blocks for rounds 0 to 11 with the node clock at the parent's
timestamp: 2.0.1 accepted up to round 7 in that run; 2.0.2 accepts rounds 0 and 1 and refuses the rest.

Defence: `maxFutureDriftSeconds` 60 → 10 (two slots). A producer can now gain at most the next slot over an honest, on-time peer,
which is a race any peer can also run, not a free run of slots. This is a consensus parameter (it changes the params hash). A
node whose clock is more than 10 s behind refuses blocks until it catches up and is blamed only "minor".
`attack-r4-slot-frontrun.test.ts`.

## Round 5 — the edges, and a re-attack of everything

* **Address blocks on the node (R30).** The per-address inbound cap (8 sockets), the IP ban and the RPC rate limit were
  per address. They are now per /64: 20 sockets from 20 addresses of one /64 are capped at 8, and a ban on one covers the block.
  The RPC limiter uses the same bounded implementation as the gateway (one file, two copies, checked identical).
  `attack-r5-address-blocks.test.ts`, `rpc-contract.test.ts`.
* **RPC submit (R34).** `POST /tx/submit` copied the whole world state to simulate a transaction before checking anything. An
  unauthenticated caller could make the node do that for unsigned, unfunded transactions. It now runs the pool's cheap
  checks first.
* **CI (R35).** Actions were referenced by movable tag and two workflows had no `permissions`. Every action is pinned to a full
  commit SHA, every workflow declares a token permission, and `repo-consistency` fails if either regresses.
* **Re-attack.** Every earlier round's exploit test was re-run against the final tree, then the whole suite.

## What still works against it (R36 — open)

**Sybil nodes.** Registering a node is free; it is only rate-limited (16 a day, or a tenth of the registry) and delayed (64
blocks to mature). Producer slots, the finality quorum (two thirds of distinct mature producers) and the node-reward pool are
all shared by *count of nodes*, so an operator running many nodes holds many shares. Round 2 measured a fleet of 12 Sybil nodes
registering alongside 5 honest ones reached 12 of 17 registered nodes (the scenario registered one node every six hours; the
chain's own limit is looser). A fleet above a third can stall finality and one above two
thirds controls block production.

This was **not** "fixed", on purpose. A registration proof-of-work made of a hash is cheaper for a GPU than for a phone and
does not stop a funded attacker; a memory-hard one adds a verification cost an attacker can impose on everybody. Lowering the
registration rate (16 → 4 a day was tried and not kept: it broke three existing scenarios that register several nodes in a day, and in
principle it slows the attacker and honest operators equally, while the quota is shared and first-come, so an attacker can take it all). A real fix needs a scarce resource the attacker has to spend (a bond of OBS
locked while registered, or a cost tied to something that is scarce per human), which is an economic redesign that changes the
reward model and the genesis, not a patch. Until then the honest statement is: **an attacker with many machines can outvote
an honest minority of nodes**, which the consensus and node-rewards documents already say.

## Not covered

No external audit; no fuzzing campaign longer than the seeded runs above; no live network, no real browsers beyond the
existing end-to-end suites; the desktop and extension clients were not attacked again this campaign; keys, signing and
reproducible builds are as described in the release documents.
