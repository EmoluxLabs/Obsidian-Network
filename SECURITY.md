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

## The mining sign-up gate is a consensus rule (protocol 1.7.0)

Account sign-up, invitations, MFA and "one wallet per account" are enforced by the platform
(`obsidian-interface`), and since 1.7.0 the chain enforces that **only the platform can open the door**: a
`MINING_CLAIM` is valid only with a short-lived certificate signed by an issuer key committed in genesis. A claim
posted straight to a node's `/tx/submit` is refused in the mempool, in block production, in block validation and in
sync replay (`ERR_MINING_GATE_REQUIRED` / `ERR_MINING_GATE_INVALID`). The certificate names one network, one wallet and
one claim id, expires in 15 minutes and is useless to anyone else. Timing and claim limits stay a pure function of the
wallet's own history.

What you must still do and know:

* **The issuer key is the trust root.** Generate it yourself (`scripts/generate-mining-gate-key.mjs`), keep the private
  half only in the platform's encrypted keystore, and give every node of a network the same
  `OBSIDIAN_MINING_GATE_PUBLIC_KEYS`. No mainnet or testnet key is committed in this repository. A mainnet node without
  keys accepts no claim, which is deliberate.
* Whoever holds the key can certify any wallet, so one-account-one-wallet is exactly as strong as the key's custody.
  The key list is part of the genesis id, so rotating it needs a new genesis.
* Keep the platform's clock NTP-synced (certificates are valid from 60 s before to 15 min after their time).
* The chain does not learn who an account is, and the platform alone decides whom to certify.

See `docs/security-model.md` for the full trust boundaries and the limitations
this project states openly rather than hides.
