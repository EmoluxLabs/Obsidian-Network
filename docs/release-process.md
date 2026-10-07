# Release process

How an Obsidian Network release is versioned, built, verified and published —
and, honestly, which part of publishing is still missing (a signing key, not
the tooling). The archive-by-archive verification procedure a stranger should
follow is in [release-verification.md](release-verification.md); this document is
about producing the release in the first place.

Every official release publishes the same identity set. Each field has exactly
one source, so nothing has to be taken on trust:

| Field | Source |
| --- | --- |
| Version (software) | `obsidian-core` and `obsidian-interface` `package.json`, and `CORE_VERSION` in `src/version.ts` |
| Protocol version | `CONSENSUS_PARAMS.protocolVersion` — must equal `PROTOCOL_VERSION` in `src/version.ts` |
| Wire protocol version | `WIRE_PROTOCOL_VERSION` in `src/version.ts` |
| Build ID | `BUILD_ID` — first 16 hex characters of `sha256("obsidian-core:<version>:<protocol>:<wire>")` |
| Minimum core version | `MIN_CORE_VERSION` — peers below it are refused during the handshake |
| SHA-256 | `releases/SHA256SUMS`, checked by `sha256sum -c` |
| Supported networks | `MANIFEST.json` (chain id, address prefix, ports for all four) |
| Release signature | `releases/SHA256SUMS.asc` — **not present for any release yet; see §5** |

Ask a running node for the identity it believes it has:

```bash
node dist/index.js version        # core version, protocol version, build id, min core version
curl -s localhost:8630/version | jq .
```

---

## 1. Versioning rules

There are two numbers, and they move for different reasons:

- **Software version** (`1.6.0`) increments for any shipped change — code,
  interface, tooling, documentation. Most releases do not change consensus.
- **Protocol version** (`1.6.0`) increments only when a rule changes: block
  validity, state transitions, encoding, hashing, or an economic parameter.
  That is a hard fork. It changes the params hash, so **every node must upgrade
  together**; a node running a different protocol version is refused at the
  handshake rather than allowed to fork quietly.

`MIN_CORE_VERSION` is raised in the same change that makes an old binary
incompatible, so the refusal happens at the first message instead of at the
first divergence. A wire-protocol change bumps `WIRE_PROTOCOL_VERSION` and
likewise raises the minimum.

`CHANGELOG.md` records every release and states, for each one, whether
consensus changed and whether `PROTOCOL_VERSION` moved. A change that silently
edits an invariant in `scripts/check-invariants.mjs` to keep a test green is the
one thing [CONTRIBUTING.md](../CONTRIBUTING.md) says will close a pull request
without discussion.

---

## 2. What a release contains

`scripts/package-releases.sh` emits, in `releases/`:

| Asset | What it is |
| --- | --- |
| `obsidian-core-<version>.zip` / `.tar.gz` | the node: source, tests, built `dist/`, config, deployment recipes |
| `obsidian-interface-<version>.zip` / `.tar.gz` | the reader: server, tests, browser bundles, every site directory |
| `obsidian-cloudflare-<version>.zip` / `.tar.gz` | edge worker, tests, Terraform |
| `obsidian-node-operator-<version>.zip` / `.tar.gz` | what an operator installs: the built node, the one-command-per-network helper (`obsidian-network.sh`), the Genesis Invitation generator, systemd (template units)/nginx/Docker recipes, docs |
| `obsidian-interface-selfhost-<version>.zip` / `.tar.gz` | a ready-to-serve interface: built bundles, the nine site directories, recipes. Extract it into the same directory as the operator archive: the helper script expects `obsidian-core/` and `obsidian-interface/` side by side |
| `obsidian-network-source-<version>.tar.gz` | the entire repository at the release commit (`git archive`) |
| `SHA256SUMS` | SHA-256 of every archive |
| `MANIFEST.json` | product, version, commit, build time, protocol version, networks, supply constants, asset sizes |
| `RELEASE-NOTES-<version>.md` | what is in this release, and what is not |

The archives are built with `git archive` (or from a staging copy when the tree
is dirty under `--allow-dirty`), so the bytes you download correspond to a real
commit rather than a directory that happened to look right that afternoon.

Docker images built from a release are tagged with the software version
(`obsidian/core:<version>`, `obsidian/interface:<version>`) and are built,
started and probed by the `docker` CI job on every push.

---

## 3. Cutting a release

```bash
git status                                  # must be clean; the script refuses a dirty tree
git tag -a v1.6.0 -m "Obsidian Network 1.6.0 - protocol 1.6.0"
git push origin v1.6.0
./scripts/package-releases.sh               # the release gate; takes several minutes
cd releases && sha256sum -c SHA256SUMS      # every line must print OK
```

The packaging script is a gate, not a zip command. It:

1. checks that the core and interface versions agree;
2. refuses to run on a dirty tree (unless `--allow-dirty`, for experiments only);
3. builds both packages;
4. runs the core suite, the interface suite, the edge worker suite, the release
   verification and signing behaviour suite, the soak verdict rules, the Genesis
   Invitation generator, **the repository consistency suite** (versions, identities,
   ports, environment variables, links, and that each network's section of the guides
   names only its own network) and — unless `--skip-e2e` — the three-node cluster
   end-to-end suite and **the four-network suite with the per-network helper script**
   (a node and an interface for every network at once, and their isolation),
   **reading the test counts back from the runs themselves** and refusing to package
   if any suite reports zero passes;
5. produces the archives, then writes `SHA256SUMS`, `MANIFEST.json` and
   `RELEASE-NOTES-<version>.md`.

Useful flags: `--skip-build` reuses an existing `dist/`; `--skip-e2e` skips the
cluster and four-network suites (the notes are then stamped with a warning telling you to run them);
`--allow-dirty` packages an uncommitted tree and must never be used for a real
release.

---

## 4. Verifying a release

```bash
cd releases
sha256sum -c SHA256SUMS                                  # integrity
../scripts/verify-release.sh obsidian-core-1.6.0.tar.gz --with-tests
../scripts/verify-release.sh obsidian-node-operator-1.6.0.tar.gz
```

`verify-release.sh` refuses any archive not listed in `SHA256SUMS`, extracts into
a temporary directory (never over your working tree), checks entry points and,
with `--with-tests`, runs the shipped suite. It exits non-zero on a digest
mismatch or an unlisted archive, so it can gate a deployment script. The node
operator package ships `dist/` without tests, which is why the core archive is
verified too.

The full independent procedure — including what to do when a signature exists
but cannot be checked — is [release-verification.md](release-verification.md).

---

## 5. Signing

Checksums prove integrity, not authorship: anyone who can replace an archive can
replace the `SHA256SUMS` beside it. `scripts/sign-release.sh` produces a
detached GPG signature over `SHA256SUMS` after **re-checking every digest**, so
an authentic signature can never cover a stale list:

```bash
gpg --full-generate-key          # the publisher, once, on a machine they control
./scripts/sign-release.sh        # or: ./scripts/sign-release.sh <KEYID>
```

It writes `releases/SHA256SUMS.asc` and `releases/SIGNING-KEY.asc` and prints
the fingerprint. No key is generated by this project, by CI or by any
automation, deliberately: a release key that anything other than its owner can
use signs nothing worth checking. The fingerprint must be published somewhere
*other* than the archive host, or an attacker who can replace the download can
also replace the key.

**Current state, stated plainly: no release in this repository is signed.**
`releases/` contains no `SHA256SUMS.asc`. `verify-release.sh` prints
`UNSIGNED RELEASE` rather than letting that pass quietly, and when a signature
exists but `gpg` is unavailable it reports that the check did not happen —
a check that was not performed is never reported as passed.

---

## 6. Compatibility at the handshake

Peers exchange network id, chain id, genesis id, core version, protocol version
and params hash. A mismatch of network, genesis, protocol version or params hash
means the two nodes compute different chains from the same blocks, so they are
refused. A core version below the peer's `MIN_CORE_VERSION` is refused too, with
the message telling the operator which side must upgrade.

Consequences worth being explicit about:

- Two software versions with the same protocol version **do** peer (for example
  1.6.0 and a later 1.6.1), provided the older one is not below
  `MIN_CORE_VERSION`.
- Protocol 1.6.0 nodes reject 1.5.x during the signed handshake. Their changed
  params hash and deterministic genesis identities also prevent data-directory
  sharing. There is no hidden activation height or automatic state migration.
- Protocol 1.6.0 is therefore a **genesis-bound activation**: launch an unstarted
  network from the published 1.6.0 genesis, or deliberately reset disposable
  dev/test/staging. Do not roll validators one at a time. If a value-bearing
  1.5.x chain exists, stop and design and review a separate explicit migration;
  this release does not provide one.
- The params hash is the final check: any consensus parameter edited without a
  version bump produces a hash mismatch and a refusal, which is exactly what
  `scripts/check-invariants.mjs` and CI are there to catch before release.

---

## 7. CI

`.github/workflows/ci.yml` runs nine jobs on every push: `core` (build,
typecheck and the core suite), `interface` (build, typecheck, the interface suite
and the invitation generator), `edge` (the worker suite), `scripts` (release signing
and verification behaviour, the soak verdict rules, and the nginx files parsed against
nginx's own directive grammar), `cluster` (three real nodes end to end), `networks` (a
node and an interface for each of the four networks at once, their isolation, and the
per-network helper script), `invariants` (the economic and protocol checks, the
repository's consistency, mainnet genesis determinism and a mainnet node boot asserting
`invariantOk: true` and every removed feature absent), `docker` (both images built,
started and probed, plus a two-container stack whose chain height advances), and
`releases` (the packaging script runs, the sums verify, and the archives are uploaded).
A green `releases` job is what
says a commit can be packaged; a committed archive is not evidence that the
current tree can be.
