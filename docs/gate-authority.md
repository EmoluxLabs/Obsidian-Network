# Gate authority: rotating, revoking and recovering the mining gate keys (protocol 2.0.2)

Since 1.7.0 a `MINING_CLAIM` is valid only with a short-lived certificate signed by a **mining gate issuer key**
(the platform signs one for a signed-in account that has linked a wallet; see [mining.md](mining.md)). 1.7.0
committed those public keys in genesis and could never change them. **1.8.0 makes them changeable on chain, by a
majority of the current keys, without a new genesis.** Private keys are never broadcast, never put on chain and
never printed.

## What is on chain

| Field (state, in the state root) | Meaning |
| --- | --- |
| `genesis.miningGateKeys` | The keys committed at genesis. Immutable. Part of the genesis id. |
| `genesis.gateKeysActive` | The keys whose certificates the chain accepts **now**. Starts as the genesis list. |
| `genesis.gateKeysRevoked` | Keys that were removed. A revoked key can never be added back (at most 64 are remembered). |
| `genesis.gateEpoch` | Counts accepted updates. Starts at 0. |

A certificate is checked against the **active** set at the block that includes the claim. A revoked key's
certificates stop working at the first block after the update, including certificates still inside their 15 minute
life.

## The update transaction (`GATE_AUTHORITY`, gas 0)

An update adds and/or removes keys. It is valid only when:

* its epoch is exactly the current epoch + 1 (so an old approval cannot be replayed);
* it carries approvals from at least `floor(n/2) + 1` of the `n` current active keys, each a signature over
  `GATEUPDATE|networkId|chainId|epoch|add|remove` (domain `OBSIDIAN:GATE_AUTHORITY:v1`), so an approval is bound to
  one network, one chain, one epoch and one exact change;
* at most 8 keys are added and at most 8 removed in one update, and the result has between 1 and 8 active keys;
* it never re-adds a revoked key.

The transaction's own sender decides nothing: authority comes only from the approvals, so the CLI signs the envelope
with a throwaway key and no balance is needed. The mempool holds at most 16 pending updates and 2 per sender; gossip,
RPC submission and block assembly all check an update against current state first.

## The safe minimum (1.8.1 policy; no consensus change)

The threshold is `floor(n/2) + 1`, so the number of keys is the whole security argument:

| Active keys | Approvals needed | What one stolen key can do | What losing keys does |
| --- | --- | --- | --- |
| 1 | 1 | **Everything**: sign certificates for any wallet, and replace itself so the real operator is locked out | Losing it ends the gate: new genesis |
| 2 | 2 | Sign certificates until revoked, but cannot revoke or replace anything alone | Losing either one means the other cannot rotate: new genesis |
| 3 | 2 | Sign certificates until the other two revoke it | One lost or stolen key is recoverable; two lost is not |
| 5 | 3 | Same, with a wider margin | Two lost or stolen are recoverable |

A single-key authority has no recovery path, so **mainnet `init --generate-gate-key` refuses fewer than 3 keys**
(`--gate-key-count 3`), before it writes anything. `--allow-single-gate-key` overrides that for an operator who accepts
the risk in writing; the override is recorded in the init output. Testnet, staging and devnet accept 1. Keys that
arrive by configuration (`OBSIDIAN_MINING_GATE_PUBLIC_KEYS`) are not blocked, because the chain, not this tool, owns
that decision; they are **warned about** instead: `/gate` carries `warnings` and `/readyz` carries `advisories` with
`gate-closed` (no keys: nobody can mine), `gate-single-key` and `gate-below-three-keys`. Advisories never change the
`ready` answer, so a load balancer does not pull a node out of service for a governance concern.

Three keys on one machine are still one failure. `--gate-key-count 3` writes **three separate keystores**; move each to
a different person, machine and backup before you rely on the quorum. The disaster-recovery procedures are in
[gate-recovery-runbook.md](gate-recovery-runbook.md).

## Operating it

First network start: create **three or more** keys, held by different people or machines, so one stolen key can be
revoked by the other two. (With one key, that key alone can replace itself; with two, both must agree.)

```bash
obsidian init --network testnet --generate-gate-key --gate-key-count 3 --data-dir <dir>
```

Passphrases come from `OBSIDIAN_GATE_KEYSTORE_PASSPHRASE` or `OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE`, never from an
argument. The encrypted keystores are written outside the node's data directory.

```bash
obsidian gate status --network testnet                               # live keys, epoch, quorum, revoked (no secrets)
obsidian gate propose --network testnet --add <pub> --remove <pub> --out proposal.json   # anyone, no secret
obsidian gate sign --proposal proposal.json --keystore <gate keystore> --out proposal.json   # each key holder
obsidian gate submit --proposal proposal.json --dry-run               # checks the quorum, sends nothing
obsidian gate submit --proposal proposal.json                         # sends it to the node
```

`sign` shows exactly what the holder is approving before writing the approval. `submit` refuses a proposal whose epoch
is stale or whose approvals do not reach the quorum.

After an update is mined, `/gate` on the node shows the new set. The platform (`obsidian-interface`) re-reads the active
set; if its own issuer key was revoked it answers **503 `ERR_GATE_KEY_INACTIVE`** instead of issuing certificates the
chain would refuse. Restart it with the replacement key's keystore (`OBSIDIAN_GATE_KEYSTORE` / the passphrase variable).

### Playbooks

* **Rotate** (routine): propose `--add new --remove old`, collect a majority of signatures, submit, wait for the block,
  switch the platform to the new keystore. Add the new key before removing the old one so there is no outage.
* **A key is stolen**: the thief can sign certificates for any wallet until you act. Immediately propose `--remove stolen` (plus `--add` a fresh key), sign with a majority of the *other* keys,
  submit. Claims signed by the stolen key are rejected from the next block.
* **A key is lost** (not stolen): same procedure, signed by a majority of the keys that remain.
* **A majority is lost**: nothing can change the set. **The only recovery is a new genesis (a new network)** with new
  keys. This is deliberate: a rule that let anyone override the majority would be a backdoor. Keep the keystores
  backed up in separate places.

## Status of the claims in this document

Implemented and tested: the update rules, state root, snapshot round trip, quorum edge cases, replay and cross-network
rejection, mempool quotas, the certificate cut-over at the including block, the RPC `/gate`, `/tx/encode|decode` and the
CLI proposal/sign/submit flow (`tests/security/gate-authority.test.ts`, `tests/unit/gate-cli.test.ts`).
The recovery properties (rotated set and revocations survive a restart, an offline node catches up through a rotation to
the same state root, two fresh nodes converge, a lost key is replaced, a "restored" revoked key can never approve or be
re-added, quorum loss fails safe, conflicting same-epoch updates leave exactly one winner, cross-network approvals are
refused, no gate private key is ever in the data directory) are `tests/security/gate-recovery.test.ts`; the minimum-key
policy is `tests/unit/network-manifest.test.ts`; the `/readyz` dimensions are `tests/integration/readiness.test.ts`.
Residual risk: compromise of a majority of keys; loss of a majority (recoverable only by a new network); gossip may reject
a brand-new update on a node that is one block behind (the update is re-relayed and accepted once it catches up).
