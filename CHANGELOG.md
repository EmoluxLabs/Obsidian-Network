# Changelog

All notable changes to Obsidian Network are recorded here. This project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html), with one addition
specific to a blockchain: **any release that changes the params hash is
consensus-breaking and every node must upgrade together.** Such releases say so
in their first line.

This repository is a **fresh start**: it carries one release, one protocol line and one chain. The history of earlier
lines (their changelog entries, upgrade notes, remediation reports and archives) is in the git history of this repository
and is deliberately not repeated here, so that nothing in the tree can be mistaken for the build you are running.

The authoritative params hash for a release is whatever `GET /params` reports on a node running it. For this release it is
`38dd9243481cd35a68003648e2710001` on every network.

---

## [1.9.0]

**Consensus-breaking fresh start: a new protocol, a new genesis for every network, no migration.** Chain state, balances,
validators, bonds, finality checkpoints, node registries and names of any earlier line do not carry over, and an earlier node
cannot join (the handshake carries the protocol version, genesis id and params hash). See
[docs/upgrading-1.9.0.md](docs/upgrading-1.9.0.md).

### Removed
- **The validator model, entirely**: the validator registration transaction (type 8) and the slashing transaction (type 12),
  the 20,000 OBS bond, unbonding, jailing and slashing of funds, validator-only proposer selection, finality votes and
  certificates, the committed bootstrap committee and `obsidian-core/bootstrap-keys/`, the "No Validator" halt, the
  validator-mode and bootstrap locks, `OBSIDIAN_BOOTSTRAP_VALIDATOR_PUBLIC_KEYS`, the `/validators` route and every staking
  screen. There is no compatibility switch.
- The earlier release archives, release notes and dated reports, and the upgrade and remediation documents of earlier lines.

### Added
- **Producer schedule** (`consensus/schedule.ts`, `producers.ts`): every registered, mature, live, unsuspended node takes a
  turn, chosen deterministically from chain state; skipped slots pass the turn on; three misses suspend a node; two blocks on
  one parent ban it permanently. No vote, administrator or central scheduler. Specification:
  [docs/consensus-v1.9.0.md](docs/consensus-v1.9.0.md).
- **Derived checkpoint finality** (`consensus/finality.ts`): final once two thirds of at least three established producers have
  built on a block; committed in the state root; monotonic; restart-safe. It is checkpoint (economic) finality, not BFT:
  [docs/finality-v1.9.0.md](docs/finality-v1.9.0.md). New routes `GET /producers`; `GET /finality` reports the derived model.
- **Node ↔ reward-wallet binding with no gas and no wallet signature**, stored in consensus state, one node per wallet, atomic
  and concurrency-safe, with delayed wallet change and owner reclaim: [docs/node-binding-v1.9.0.md](docs/node-binding-v1.9.0.md).
  CLI: `obsidian register <address>`, `obsidian binding`. The node agent registers, heartbeats, attests and reports
  equivocation with the node's own key.
- **Node rewards**: 90 % of the ONS revenue pool split by eligible weight, hourly uptime windows from chain-recorded evidence,
  exact largest-remainder rounding, per-node cap, minimum payout and carried remainder, settled exactly once per period:
  [docs/node-rewards-v1.9.0.md](docs/node-rewards-v1.9.0.md).
- **ONS ownership**: transfer by offer and explicit acceptance (the remaining term travels, the new owner renews), cancel,
  linked-address update, and delayed, cancellable recovery by a recovery address. `GET /names/<name>` shows pending offers and
  recoveries: [docs/ons.md](docs/ons.md).
- **Wallet**: creation shows the recovery phrase and the private key and requires confirmation that both were written down; a
  separate private-key recovery flow validates locally (64 hexadecimal characters, no echo of the input), shows the derived
  address for confirmation, and creates nothing on invalid input. Platform wallet, web app, web wallet and desktop wallet:
  [docs/wallet.md](docs/wallet.md).
- `scripts/verify-agreement.mjs`: a read-only check that several nodes agree on genesis, parameters, block, state root and
  finality.
- Explorer, extension and desktop show the producer set, finality and node participation instead of validators.

### Changed
- Protocol and core version `1.9.0`; minimum peer core version `1.9.0`; state snapshot format 6. Every genesis id and the params
  hash change.
- **Unchanged on purpose:** the mining gate keys and mechanism (`genesis/gate-keys.ts` is byte-identical), the supply constants and
  genesis-allocation rule, fees, ONS prices and periods, transaction formats, network ids and address prefixes.
- **Token amounts show at most 6 decimals, rounded to nearest** (`99999.820626666666666664` reads `99,999.820627`); a real amount
  below the shown precision reads `<0.000001`, never `0`. The exact 18-digit value is kept in a tooltip and wherever a person
  authorises an exact movement. Raw amounts in calculations, payloads, API responses and storage are unchanged.
- The interface's `/api/auth/config` also returns `chainId` (additive).

### Fixed
- **Finality under partition.** Suspension no longer shrinks the finality base, so neither half of a split can drop the other,
  finalize on its own and produce two final chains (pinned for 2|2, 3|3 and 3|2 splits). `minProducers` is 2, so a two-node
  network finalizes.
- **No passphrase is ever generated or stored by the node or the helper script, on any network.** The order is
  `OBSIDIAN_KEYSTORE_PASSPHRASE`, then a 0600 `OBSIDIAN_KEYSTORE_PASSPHRASE_FILE` you made, then a hidden prompt on the
  terminal (twice for a new key); with none of these the start refuses and writes nothing. (A test network's *gate issuer*
  key, a different key used only by the interface, still gets a generated passphrase file.)
- **One name for the fork-choice rule.** The two parameters that name it (`weightRule` and `forkChoice`) now hold the same
  value, and a repository invariant fails if they ever differ.
- **Block pacing.** The producer loop woke only every 5 s and could therefore take a due turn up to 5 s late, stretching blocks
  to about twice the target. It now wakes every second and leaves `blockProductionIntervalSeconds` after the parent.
- Stale genesis ids and retired terms removed from the documentation; unused node-registry domain constants removed.
- **Paying a `.obs` name.** Typing a registered name as the recipient was refused as an invalid OBS address in some
  interfaces. Every sender now resolves the name through one resolver, shows the whole resolved address and network for
  confirmation, re-resolves just before signing, and never guesses when the lookup fails. No consensus change.

### Known limits
- Admission of nodes is rate-limited, not priced: a patient actor with many machines can capture a third of the producers.
- Finality needs at least two established producers, a quorum of them alive, and fewer than a third faulty; it is quorum finality over producer diversity, not accountable BFT finality, and a partition longer than 30 reward periods can split it.
- An unsigned wallet binding can be squatted until the wallet owner reclaims it.
- ONS recovery protects against loss, not theft, of the owner key.
- Reward weight is a composite score (uptime 40 %), not uptime alone.
- No independent review; no hostile-network, eclipse or real-partition test.
