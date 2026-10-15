# Gate authority: disaster-recovery runbook

For the mining gate keys of [gate-authority.md](gate-authority.md). Read the "safe minimum" table there first: **what you
can recover from is decided by how many keys you have and who holds them**, before anything goes wrong.

**What the gate set is, and is not.** The *public* active/revoked key set and the epoch are part of the chain's state,
so every node has them; losing a node loses none of it. The *private* keys exist only in the encrypted keystores you
were given at `init`. They are never on chain, never in a node's data directory, never replicated, and never printed.
A restored node cannot sign certificates, and no peer can hand it the ability to.

Keep this table filled in somewhere outside the repository (it contains no secrets, only who and where):

| Key (public, first 12 hex) | Holder | Keystore location | Backup location | Last restore-tested |
| --- | --- | --- | --- | --- |
| | | | | |

## Before any incident

1. At least **three** keys (mainnet requires it), each keystore with a **different** person or machine, each with an
   **offline backup in a different place**. Back up the keystore *file* and the passphrase separately.
2. Once per quarter, **test a restore** of every keystore on a throw-away devnet: `obsidian gate sign` a harmless
   proposal with it (the signing step proves the file and passphrase work; nothing is sent).
3. Know the quorum: `obsidian gate status --network <net>` shows active keys, epoch and required approvals.
4. Run a dry run of a rotation on testnet before you ever need it on mainnet.

## A. Routine rotation (planned)

```bash
obsidian gate status  --network mainnet
obsidian gate propose --network mainnet --add <NEW_PUB> --remove <OLD_PUB> --out proposal.json   # no secret needed
# Each holder, separately. `sign` prints exactly what is being approved before it writes the approval.
obsidian gate sign   --proposal proposal.json --keystore <their keystore> --out proposal.json
obsidian gate submit --proposal proposal.json --dry-run        # checks the quorum, sends nothing
obsidian gate submit --proposal proposal.json
obsidian gate status --network mainnet                          # epoch +1, new key active, old key revoked
```

Add the new key **and** remove the old one in one update, or add first and remove later, so the platform is never left
without an active issuer. Then restart the interface with the new keystore. The old key is revoked **permanently**: it
cannot be re-added, even by a majority.

## B. One key is stolen or suspected

A thief with an active key can mint certificates for any wallet until it is revoked. Speed matters; do not wait to be sure.

1. Stop the platform issuing: stop the interface on the host that used the key (or unset its keystore).
2. `propose --remove <STOLEN_PUB> --add <FRESH_PUB>`; the **other** holders sign; `submit`.
3. From the first block after the update, claims certified by the stolen key are refused, including certificates still
   inside their 15-minute life.
4. Restart the interface with the fresh key. Review claims mined in the exposure window with `obsidian status` and the
   explorer; claims already on chain are final and are not undone.
5. With **3 keys** the other two are exactly the majority (2 of 3): if **two** keys are stolen the thief **is** the
   majority and can rewrite the set. With 5 keys (3 needed) it takes three.

## C. One key is lost (not stolen)

Same as B, signed by a majority of the remaining keys. If the lost key's keystore turns up later, it cannot approve
anything and cannot be re-added: the chain rejects an approval from a key that is not active, and a revoked key is
rejected permanently. (`tests/security/gate-recovery.test.ts` covers both.)

## D. A majority is lost or unreachable

Nothing on chain can change the set. This is deliberate: a rule that let anyone override the majority would be a
backdoor. Mining keeps working only while the *active* keys' holders can still issue certificates; if every active key
is gone, no new `MINING_CLAIM` can be certified.

**The only recovery is a new genesis.** That is a new network: new genesis id, new gate keys,
a published migration for balances. It cannot be done silently and **this repository does not and must not do it for
you**; follow your network's governance, publish the new genesis id through an independent channel, and treat the old
chain as frozen. The cost of this path is the reason section "before any incident" asks for three or more keys.

A "quorum loss fails safe" check is part of the tests: with 1 of 3 keys, an update is refused ("needs 2 of 3 ... and
has 1"), state is untouched and certificates from the surviving key keep being valid.

## E. A node's disk is lost or corrupt

The node holds no gate private key, so this is an ordinary node recovery.

1. Do **not** reinitialise a directory that has an identity. `init` refuses a different gate list on a directory that
   already has one and refuses another network's directory; `join` refuses to re-point a joined directory. On a directory
   with chain data but no recorded identity, start with `--require-init` so a node cannot quietly create a new genesis.
2. Restore the data directory from backup if you have one (`obsidian validate` replays and verifies it), or re-join:
   `obsidian join --peer <https url of a node you trust> --genesis-id <the id you pinned>`.
3. The node syncs and verifies every block itself, including every gate rotation and revocation, and arrives at the same
   gate set and state root as everyone else. Compare `obsidian gate status` and `GET /gate` with another node.

## F. The platform (interface) host is lost

The issuer key lives in a keystore on the primary-capable hosts. Restore that keystore file from backup on a new host,
set `OBSIDIAN_GATE_KEYSTORE` and the passphrase variable, and start the interface. If the keystore is also gone, treat
the key as lost (section C): rotate to a new key. With automatic failover (see
[failover-and-gateways.md](failover-and-gateways.md)), every primary-capable host holds a copy, so count each one as a
place the key can be stolen from.

## G. Checks after any recovery

```bash
obsidian gate status --network <net>               # active keys, epoch, quorum; no secrets
curl -s localhost:<rpc>/gate | jq '.issuerKeys, .epoch, .warnings'
curl -s localhost:<rpc>/readyz | jq '.checks.gateAuthority, .advisories'
```

`gate-closed`, `gate-single-key` or `gate-below-three-keys` in `advisories` means the set is not in the shape this
runbook assumes. Compare the set on at least two independently operated nodes.

## What this runbook does not cover

Compromise of a majority of keys (the chain cannot tell a thief from the owners), coercion of key holders, and the legal
or governance process for a new genesis.
