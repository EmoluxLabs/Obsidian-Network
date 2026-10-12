# Upgrading from 1.8.0 to 1.8.1 (install 1.8.2)

> **Install 1.8.2, not 1.8.1.** Tag `v1.8.1` exists and its archives are intact, but they predate one more fix: a race in
> the data-directory lock (F-11 in [remediation-1.8.1.md](remediation-1.8.1.md)) that CI caught in `v1.8.1`'s own test run.
> 1.8.2 differs from 1.8.1 only by that fix. Everything below applies to both; read "1.8.1" as "the 1.8.1 line".

**1.8.1 is a software release, not a protocol change.** The protocol version stays `1.8.0`, the params hash stays
`1d6cba55f0975f8b0d6345658f1c1cb1`, every genesis id is unchanged, the state snapshot format stays 5 and
`MIN_CORE_VERSION` stays `1.8.0`. A 1.8.0 node and a 1.8.1 node peer with each other (`tests/integration/p2p.test.ts`),
so nodes can be upgraded one at a time with no coordinated cut-over. No data is migrated; nothing is reinitialised.

## Node operator

1. Back up the data directory, the node keystore and the gate keystores first (see [operations.md](operations.md) section 8).
2. Stop the node. Replace the binaries with the 1.8.2 archive (verify it first: [release-signing.md](release-signing.md);
   **the 1.8.2 release is not signed because no publisher key exists yet**, so you can check integrity but not authorship).
3. Start it as before, with `--require-init`. `obsidian status` and `GET /readyz` should say `ready`. `/readyz` now also
   carries `checks.identity`, `checks.finality`, `checks.gateAuthority` and `advisories`; read the advisories.
4. **Mainnet only, new creation:** `init --generate-gate-key` now needs `--gate-key-count 3` or more. An existing network
   is not affected, but `/gate` and `/readyz` will *advise* if its active set has fewer than three keys.

## Interface host

Nothing changes unless you set the new variables. To use automatic failover, read
[failover-and-gateways.md](failover-and-gateways.md) section 1b first (the lease is **not** safe on NFS) and then set
`OBSIDIAN_INTERFACE_LEASE_DIR` and `OBSIDIAN_INTERFACE_ADVERTISE_URL` on each primary-capable host. An `edge` host must
not be given a lease directory. Every primary-capable host needs the gate keystore.

## Users

Nothing visible. A wallet vault written by any earlier release still opens. A vault whose stored fields were damaged or
modified now says so (instead of hanging or failing with a parser error); restore it from the recovery phrase.

## Rolling back

Stop the node, install the 1.8.0 archive, start it. Nothing 1.8.1 wrote is incompatible with 1.8.0: the lease directory
and the new environment variables are ignored by 1.8.0, and the chain, manifest and keystores are unchanged.

## Not covered

Desktop installers are built per platform and are not produced by the packaging script; the desktop app embeds the core
it was staged with, so rebuild it from this release to carry the 1.8.1 fixes. The extension and the web wallet bundles
pick up the vault validation when they are rebuilt from this tree.
