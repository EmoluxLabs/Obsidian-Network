# Security remediation — 1.8.0 → 1.8.1

**Scope.** What was found in the 1.8.0 tree, what was changed in 1.8.1, how each
change was tested, and what is still open. Every claim names a test or an
executed command; anything that could not be done here says so and names the
action that remains. 1.8.1 is a **software** release: the protocol is still 1.8.0,
no genesis changes, and 1.8.0 and 1.8.1 nodes peer with each other
([upgrading-1.8.1.md](upgrading-1.8.1.md)).

**Branch note.** The request asked for a dedicated remediation branch. This
working session is bound to one branch, so the work was committed there; no other
branch was created, nothing was force-pushed, no history was rewritten, and the
`v1.8.0` tag was not moved (the release is a new tag).

## 1. Status at a glance

| ID | Finding | Severity | Status |
| --- | --- | --- | --- |
| F-01 | Interface HA had no election or fencing: two instances could both issue against the same account store | High | **Fixed** (app level; infrastructure requirements stated) |
| F-02 | A lease-lock re-entrancy deadlock in the first HA implementation | Medium | **Fixed** before release, regression test |
| F-03 | The release pipeline had no authentication: checksums only | High | **Pipeline built; publication unauthenticated** until the operator provisions a key |
| F-04 | Release archives were not deterministic | Medium | **Fixed**; two independent builds compared byte for byte |
| F-05 | Mainnet could be initialised with a single mining-gate key, silently | High | **Fixed** (refused unless explicitly overridden; surfaced in health) |
| F-06 | `/readyz` mixed "can serve" with "is advisable" and had no gate, finality or identity dimensions | Medium | **Fixed** |
| F-07 | The wallet vault accepted any envelope shape and KDF cost | Medium | **Fixed** in both vault implementations |
| F-08 | Session fixation: a pre-set session cookie survived sign-in | Medium | **Fixed** |
| F-09 | Operator documents named the previous release and described removed behaviour | Low | **Fixed**, and a test now fails when they drift |
| F-10 | No scanner for committed credentials | Low | **Fixed** (`scripts/scan-secrets.mjs`, CI) |

Severity is the authors' own judgement of impact if exploited or hit in
operation, not a scored rating.

## 2. Findings in detail

### F-01 — Interface HA without election or fencing (High)

- **Root cause.** The account platform keeps accounts, wallet links, invites and
  sessions in one file with a single-writer assumption. Nothing enforced it.
- **Scenario.** Two interface hosts behind one name (or a restarted host while its
  predecessor is still running, or a paused host that wakes up) both write
  accounts and issue mining certificates; the last writer wins and a claim can be
  issued twice.
- **Fix.** `obsidian-interface/server/lease.ts`: a lease file with a monotonically
  increasing fencing token, takeover only after expiry **plus** a clock-skew
  allowance, a leader that stops trusting itself *before* the follower may take
  over, and a store that refuses writes from a host that is not the current
  holder. A host without the lease is a standby and answers 503 `ERR_NOT_LEADER`
  (fails closed). Edges stay read-only. Same-origin, CSRF and cookie rules are
  unchanged. Design and limits: [failover-and-gateways.md](failover-and-gateways.md) §1b.
- **Do sessions survive failover?** Yes, for sessions already flushed to the shared
  store (flush is ≈2 s, so a login in the last two seconds before a crash can be
  lost: R10).
- **Tests.** `obsidian-interface/tests/lease.test.ts` (election, skew sweep with
  seeded random clocks and renewal failures, paused leader fenced, failing backend
  cannot extend a lease, damaged lease file never read as "free", crashed lock
  broken, deposed leader's write refused, deferred flush after demotion dropped),
  `ha-config.test.ts`, `server.test.ts` (standby behaviour), and
  `tests/e2e/failover.test.mjs` with **real processes**: SIGKILL of the leader
  under load, restart as standby, duplicate registration, replayed invite, and a
  SIGSTOP/SIGCONT split-brain (the resumed old leader cannot write); also that no
  process log contains a session cookie.
- **Residual.** The lease is a file: safe on one machine or a correct shared POSIX
  file system, **not** on NFS and most network file systems (R2). Real multi-site
  HA needs a coordination service or database with compare-and-set, which is an
  infrastructure decision outside this repository. Every primary-capable host
  needs its own copy of the gate keystore (R3).

### F-02 — Lock re-entrancy deadlock in the first HA implementation (Medium)

- **Root cause.** The promotion hook ran while the lease lock was held, and the
  hook wrote through the guard that needs the same lock.
- **Scenario.** A standby that takes over waits the full lock timeout and then
  fails to promote.
- **Fix.** The hook runs outside the lock; a hook that throws demotes the host.
- **Tests.** `lease.test.ts`: "the promotion hook runs outside the lease lock…" and
  "a promotion hook that throws demotes the host…".
- **Residual.** None known. This was found by the new tests before the code shipped.

### F-03 — Unauthenticated release pipeline (High)

- **Root cause.** Anyone able to replace an archive could replace `SHA256SUMS`;
  the GPG scripts trust whatever key is in the keyring or shipped beside the files.
- **Fix.** `scripts/release-tool.mjs`: an Ed25519 signature over the version, the
  commit and the hashes of `SHA256SUMS` and `MANIFEST.json`; `verify` also checks
  that every version in the release agrees and accepts authorship only from a
  **fingerprint the verifier pinned**. A valid signature from any other key is
  `SIGNED_UNTRUSTED`. Procedures: [release-signing.md](release-signing.md).
- **Tests.** `tests/scripts/release-tool.test.mjs` (12) and an executed rehearsal
  with a throw-away key (§4): unsigned → exit 4, signed with no pin → 3, wrong
  pin → 3, pinned → 0, altered archive / missing archive / unlisted archive /
  wrong tag → 1.
- **Residual — blocking.** **No publisher key exists, so no release is signed and
  no release is authenticated.** An identity was not invented. To close it: the
  operator runs `release-tool keygen` offline, publishes the fingerprint through a
  channel an attacker of this repository cannot edit, runs `sign`, and verifiers pin
  that fingerprint. Until then `releases/` is integrity-checked only, and
  `verify` reports it as such.

### F-04 — Non-deterministic archives (Medium)

- **Root cause.** Archive entry order, timestamps, owners and gzip headers varied
  between builds; the SBOM carried a random id and a build timestamp.
- **Fix.** `package-releases.sh`: sorted entries, a fixed modification time
  (`SOURCE_DATE_EPOCH` = the commit's time), numeric owner 0, `gzip -n`, a
  normalised SBOM, stale notes and signatures of other versions removed.
- **Evidence.** Two clean clones of one commit, in different directories, each with
  `npm ci` and the packaging script, built 44 s apart: every `.zip`, every
  `.tar.gz`, both SBOMs and `SHA256SUMS` were byte-identical (`cmp`). The final
  release is additionally checked with `scripts/reproduce-release.sh`; see
  `releases/REPRODUCTION-1.8.1.txt` for what that run compared.
- **Residual.** Both builds were made by the authors on the same machine and
  toolchain. That shows the build is deterministic here; it is weaker than a
  third party reproducing it on a different machine (R12). The 1.8.0 archives were
  built by the older, non-deterministic script and are not expected to reproduce.

### F-05 — Single mainnet gate key (High)

- **Root cause.** `init` for mainnet accepted one gate key, making one stolen or
  lost key a total compromise (or total loss) of mining admission.
- **Fix.** Mainnet `init` refuses fewer than 3 keys unless
  `--allow-single-gate-key` is given; `--gate-key-count` creates a set; `/readyz`
  and `gate status` report `gate-single-key` and `gate-below-three-keys`.
  Governance (threshold `floor(n/2)+1`, epochs, domain separation, replay refusal,
  permanent revocation) is documented in [gate-authority.md](gate-authority.md);
  recovery in [gate-recovery-runbook.md](gate-recovery-runbook.md).
- **Tests.** `obsidian-core/tests/security/gate-recovery.test.ts` (9: key lost and
  restored, majority lost fails safe, replay, conflicting proposals, partial and
  corrupt storage, rotation while a node is offline, public-state-only sync),
  `tests/unit/network-manifest.test.ts`, `tests/unit/gate-cli.test.ts`.
- **Residual.** A stolen **majority** cannot be told from the owners; a lost
  majority needs a new genesis (R4). Testnet's genesis keeps its existing gate set.

### F-06 — Readiness dimensions (Medium)

- **Root cause.** One `ready` boolean; no way to tell "alive", "RPC ready",
  "identity pinned", "synced", "finalising", "gate open" apart.
- **Fix.** `/readyz` returns `status` (`ready`, `ready-degraded`, `not-ready`) and
  per-dimension `checks`; `degraded[]` explains degradation; `advisories[]` never
  affects the HTTP status, which is decided only by chain, sync and p2p.
- **Tests.** `obsidian-core/tests/integration/readiness.test.ts`.
- **Residual.** None known.

### F-07 — Vault envelope validation (Medium)

- **Root cause.** The browser vault trusted the stored envelope: a hostile or
  corrupt file could demand an absurd PBKDF2 cost (a hang), or present malformed
  fields.
- **Fix.** Both vault implementations (`obsidian-interface/web/src/lib/wallet.ts`,
  `obsidian-app-web/web/vault.mjs`) validate the format string, the iteration range
  (100 000 – 10 000 000; new vaults use 600 000), salt, iv and ciphertext sizes
  before any key derivation, and the cipher is AES-GCM with a 12-byte iv.
- **Tests.** `tests/wallet-vault.test.ts`, `obsidian-app-web/tests/vault-interop.test.mjs`
  (wrong password, corrupt file, unsupported version, hostile KDF cost, the two
  implementations interoperate). Custody model: [wallet-custody.md](wallet-custody.md).
- **Residual.** The vault **header** is not authenticated data, so a locked page can
  be made to *display* a different address; the signing key is never affected (R7).
  A fix needs a new vault version and a migration. This is **not** a browser or
  cryptography audit.

### F-08 — Session fixation (Medium)

- **Root cause.** Sign-in reused whatever session id the browser presented.
- **Fix.** A presented cookie is never a credential on its own; sign-in ends the
  session it arrived with and issues a new id.
- **Test.** `server.test.ts`: "a planted session cookie is no credential, and
  signing in ends the session it was presented with (fixation)".
- **Residual.** None known.

### F-09 — Stale documents (Low)

Operator documents and scripts named 1.7.x behaviour. They were updated, and
`tests/scripts/repo-consistency.test.mjs` now fails when a shipping document names
another protocol, tag or archive version, when a stale artifact sits in
`releases/`, or when the document index and links break.

### F-10 — No secret scanner (Low)

`scripts/scan-secrets.mjs` flags private-key armour, well-known token shapes (AWS,
GitHub, Slack, npm, Google, JWT) and a literal assigned to a secret-like name; it
is a tripwire, not a guarantee (a split or encoded secret passes). It prints the
rule and line, never the matched text; a reviewed fixture can be allowed with an
inline marker. Test:
`tests/scripts/scan-secrets.test.mjs`; also run in CI. Result on this tree: 0
findings (the scan covers tracked files; history was scanned separately, also clean).

## 3. Consensus (workstream C)

No consensus rule was changed. The assumptions the safety argument rests on are
written in [consensus-assumptions.md](consensus-assumptions.md), and
`obsidian-core/tests/security/consensus-properties.test.ts` (8) checks quorum
arithmetic, conflicting checkpoints, determinism across replays, and that an invalid
block leaves state untouched.

**Not claimed.** Consensus has been reviewed by its authors only, with no formal
model and no hostile-network test (R5). It is **not independently verified**.
Testnet's three-validator committee has quorum 3, so one offline validator stops
finality (R6).

## 4. Evidence

| Gate | What ran | Result |
| --- | --- | --- |
| 1 Source integrity | `git status`, tag and branch inspection before and after; `v1.8.0` unmoved | clean |
| 2 Build / static | `npm ci`; core and interface `tsc` typecheck and builds; `scripts/scan-secrets.mjs`; `npm audit` (core, interface, app-web, desktop; wallet-web and extension have no dependencies) | clean; 0 findings; 0 vulnerabilities |
| 3 Tests | core vitest, interface vitest, app-web, wallet-web, extension, desktop, `tests/scripts/*`; counts in the final report | see below |
| 4 Multi-node | `tests/e2e/{failover,cluster,networks,operations,ecosystem}.test.mjs`; peering between a 1.8.0 and 1.8.1 node (p2p integration test) | see below |
| 5 Release | clean-room install of the shipped node archive; upgrade 1.8.0 → 1.8.1 → 1.8.0 on one data directory; backup/restore; signing rehearsal; reproducibility comparison | see below |

**Clean-room install** (executed in a scratch directory): the shipped
`obsidian-node-operator` archive was extracted into an empty directory,
`npm ci --omit=dev` run, a devnet created with three gate keys, the node started and
`/readyz` read (`gateAuthority` open, 3 keys, quorum 2).

**Upgrade and rollback drill** (executed on disposable devnet data): a node from the
1.8.0 archive created the chain and produced blocks; the 1.8.1 build then started on
the same data directory, kept the same genesis id, continued from the same height and
reported the supply invariant intact; the 1.8.0 build started on it again and
continued. A node pointed at an empty directory with `--require-init` refused to
create a chain, and a data directory restored from a backup validated clean.

**Signing rehearsal.** A throw-away key was generated, used and deleted; it is not
the publisher identity and is not in the repository. The exit codes listed under F-03
were observed on a copy of the packaged archives.

## 5. Not fixed, not done, or not possible here

| Item | State | Exact remaining action |
| --- | --- | --- |
| Publisher key and signed release | **Unresolved, external** | Operator: `node scripts/release-tool.mjs keygen --out <offline path>`; publish the fingerprint out of band; `sign`; verifiers pin it (release-signing.md) |
| GitHub Release assets | **Unresolved, external** | The release notes are published; uploading archives from this sandbox failed. Upload `releases/*` from a machine that can, then verify with the tool |
| Independent consensus review | **Unresolved, external** | Commission reviewers (R5) |
| Independent reproduction | **Partial** | A third party runs `scripts/reproduce-release.sh` on another machine |
| HA across machines | **Partial** | Needs a coordination service or database with compare-and-set (R2); the file lease covers one host or a correct shared POSIX file system |
| Disk-full and power-loss behaviour | **Unexecuted** | Needs filesystem fault injection (R11) |
| Desktop installers | **Unexecuted** | Per-platform build and signing identities (R14); the desktop test suite is executed |
| AWS testnet nodes | **Unresolved, external** | Deploy the 1.8.x core to the nodes without resetting data; keep mining off on node 2 (R13) |
| Mainnet | **Not done, by instruction** | No mainnet launch, no real funds, no live key rotation |

The residual-risk register with owners is in [threat-model.md](threat-model.md)
(R1–R14).

## 6. Where things are

| Need | Document |
| --- | --- |
| Upgrade steps and rollback | [upgrading-1.8.1.md](upgrading-1.8.1.md) |
| Verify a release | [release-signing.md](release-signing.md), [release-verification.md](release-verification.md) |
| Run HA or failover | [failover-and-gateways.md](failover-and-gateways.md) |
| Gate keys, rotation, loss | [gate-authority.md](gate-authority.md), [gate-recovery-runbook.md](gate-recovery-runbook.md) |
| Wallet keys | [wallet-custody.md](wallet-custody.md) |
| Consensus assumptions | [consensus-assumptions.md](consensus-assumptions.md) |
| Threats and residual risk | [threat-model.md](threat-model.md) |
