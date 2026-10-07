# Security policy

## Reporting a vulnerability

Report privately. Do not open a public issue, and do not demonstrate a finding
against mainnet.

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). If that is unavailable to you, open a
public issue containing only the words "security contact request" and no
details, and a maintainer will arrange a private channel.

Please include: what you found, how to reproduce it, which component and version
(`curl -s <node>/version`), and what you believe the impact is. A proof of
concept against a local devnet is ideal — `--network devnet` gives you a chain
you can attack freely.

**What to expect:** acknowledgement within 72 hours, an initial assessment
within 7 days, and updates as the fix progresses. Consensus-affecting issues are
coordinated with node operators before disclosure, because a fix nobody has
deployed is just a public exploit. We will credit you unless you ask us not to.

## Severity, as this project judges it

| Severity | Examples |
|---|---|
| **Critical** | Minting OBS outside `GENESIS_ALLOCATION`/`MINING_REWARD`; exceeding the 21,000,000 cap; spending another wallet's funds; claiming the genesis allocation twice; a remote crash that halts the network |
| **High** | Consensus divergence between honest nodes; forging a mining claim or bypassing the 4-hour interval; stealing node runner rewards; minting ONS revenue that was never paid; bypassing invite-only registration |
| **Medium** | Explorer leaking wallet balances or full addresses; RPC denial of service; oracle manipulation affecting USD-denominated pricing; node scoring manipulation |
| **Low** | Information disclosure without economic impact; issues requiring an already-compromised host |

Reports that reduce to "the user's device was compromised" or "the user gave
away their private key" are out of scope. The wallet is non-custodial by
design: whoever holds the key holds the funds, and nothing in this system can
undo that.

## Scope

**In scope:** `obsidian-core` (consensus, state, crypto, p2p, RPC, executors),
`obsidian-interface` (server, browser wallet, auth), `cloudflare/` (the worker),
the release pipeline in `scripts/`, and the published release archives.

**Out of scope:** third-party hosting providers, denial of service that requires
resources disproportionate to the target, social engineering, and anything that
depends on the reporter controlling a majority of bootstrap nodes.

## The invariants we care most about

These are asserted in code, re-checked at runtime by
`GET /audit/compliance`, and verified by `node scripts/check-invariants.mjs`.
Any way to violate one is a valid report, even if you cannot yet turn it into
stolen funds:

* Total supply never exceeds 21,000,000 OBS, and `issue()` accepts no source
  other than `GENESIS_ALLOCATION` and `MINING_REWARD`. There is no admin mint.
* The genesis allocation is awarded exactly once, to the first protocol-valid
  mining claim, and `allocationClaimed` never returns to `false`.
* Registration credits zero OBS.
* A wallet's private key never reaches a server, a log, a worker or an analytics
  call. Signing is client-side.
* Block acceptance never depends on a browser clock, and a node's local clock can
  only reject a block, never admit one.
* Gas is 0.02% capped at 0.01 OBS and returns to the mining pool; it is never
  counted as platform revenue.
* ONS revenue splits 90% node pool / 10% treasury, with no path that skips
  the split.
* The explorer never exposes wallet balances.

## Operational security for node operators

* Set `OBSIDIAN_KEYSTORE_PASSPHRASE` and delete the generated `.pass` companion
  file. A node that generates its own passphrase warns you for a reason.
* Do not bind RPC to `0.0.0.0` without a reverse proxy, TLS and rate limiting.
  `rpcAllowSubmit` on a publicly reachable unauthenticated port is an invitation.
* Keep `strictDataDir: true`.
* Verify archives with `scripts/verify-release.sh` before running them. It exits
  non-zero on a digest mismatch, so it can gate a deploy.
* The node identity keystore signs metadata, heartbeats and attestations. It is
  not a wallet and should never hold funds.

See `docs/security-model.md` for the full trust boundaries and the limitations
this project states openly rather than hides.
