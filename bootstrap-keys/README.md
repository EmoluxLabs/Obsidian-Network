# Bootstrap validator keys

This directory holds the **private** halves of the finality bootstrap committee's
keys. Nothing here is committed except this file: `.gitignore` ignores
`bootstrap-keys/*` and re-includes only `README.md`, so a key generated here
cannot be added to the repository by accident.

## What is public and what is secret

| Material | Where it lives | Committed? |
| --- | --- | --- |
| Public keys of the committee | `obsidian-core/src/genesis/bootstrap-keys.ts` | **Yes** — they are hashed into the `genesisId` and printed by `GET /genesis` |
| Private keys of the committee | `<network>-bootstrap-validators.json` in this directory | **No** — mode 0600, never commit, never transmit |

The protocol only ever needs the public keys. The private halves matter to the
operators who will bond 20,000 OBS each and sign finality votes; whoever holds
them controls a committee seat, so they belong in offline custody (a hardware
wallet, an air-gapped machine, a sealed backup) — not on the node's disk if you
can avoid it.

## Regenerating a set

```bash
npm --prefix obsidian-core run build          # the script uses the protocol's own keys module
node scripts/generate-bootstrap-keys.mjs --network mainnet --count 4
```

The script prints the public keys, the derived address of each key, the quorum,
and a ready-to-paste array. To change a committed set:

1. generate the new set (a different directory, `--out /secure/path`);
2. paste the public keys into `obsidian-core/src/genesis/bootstrap-keys.ts`;
3. `npm --prefix obsidian-core run build`;
4. read the new identities from `node obsidian-core/dist/index.js genesis init --network <name>`
   and update the genesis ids wherever they are published (the `CHANGELOG` entry,
   `docs/LAUNCH-GUIDE.md`, `docs/mainnet-launch.md`, `docs/DEPLOYMENT-GUIDE.md`);
5. run `node --test tests/scripts/repo-consistency.test.mjs` — it fails if any
   published identity does not match what the code derives.

**Changing a committed set changes the genesis id, which is a new network.**
It is not an upgrade path, and it is the reason these lists are constants rather
than configuration.

## The size is bounded by arithmetic, not preference

Every validator needs one exact 20,000 OBS bond plus the gas its registration
transaction requires (0.01 OBS):

```
4 × 20,000.01 =  80,000.04 OBS  ≤  100,000 OBS genesis allocation   ✓
5 × 20,000.01 = 100,000.05 OBS  >  100,000 OBS genesis allocation   ✗ by 0.05
```

The genesis allocation is exactly 100,000 OBS to the first protocol-valid mining
claim and the bond is exactly 20,000 OBS, so **four** is the largest committee
that can be funded at height 0. Mainnet commits four keys with a quorum of
three; testnet commits three with a quorum of three. The invariant is asserted in
`obsidian-core/tests/integration/bootstrap-committee.test.ts`, so a future change
to the bond, the allocation or the gas rule fails a test instead of producing a
committee that cannot bond.

## Operator checklist

1. Derive the `obs1…`/`tobs1…` address of your committed public key (the
   generator prints it). You must control that address: the protocol accepts a
   validator registration only from the account its key controls.
2. Receive 20,000.01 OBS (the bond plus one registration fee) on that address.
3. Send `VALIDATOR REGISTER` with `bond = 20,000 OBS` and `validatorKey` = your
   committed key. Any other amount is refused with `ERR_VALIDATOR_BOND_MISMATCH`.
4. Stay online through the 64-block stability window. Three of the four seats
   finalize the first checkpoint; the fourth may be offline.

If fewer than three committed keys ever register, the chain still produces blocks
and serves every API — finality simply does not advance, and `/finality` and
`/status` report the shortfall instead of pretending otherwise.
