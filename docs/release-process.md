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

- **Software version** (`1.2.17`) increments for any shipped change — code,
  interface, tooling, documentation. Most releases do not change consensus.
- **Protocol version** (`1.2.0`) increments only when a rule changes: block
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
| `obsidian-node-operator-<version>.zip` / `.tar.gz` | what an operator installs: built node, systemd/nginx/Docker recipes, docs |
| `obsidian-interface-selfhost-<version>.zip` / `.tar.gz` | a ready-to-serve interface |
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
git tag -a v1.2.17 -m "Obsidian Network 1.2.17 - protocol 1.2.0"
git push origin v1.2.17
./scripts/package-releases.sh               # the release gate; takes several minutes
cd releases && sha256sum -c SHA256SUMS      # every line must print OK
```

The packaging script is a gate, not a zip command. It:

1. checks that the core and interface versions agree;
2. refuses to run on a dirty tree (unless `--allow-dirty`, for experiments only);
3. builds both packages;
4. runs the core suite, the interface suite, the edge worker suite, the release
   verification and signing behaviour suite, and — unless `--skip-e2e` — the
   three-node cluster end-to-end suite, **reading the test counts back from the
   runs themselves** and refusing to package if any suite reports zero passes;
5. produces the archives, then writes `SHA256SUMS`, `MANIFEST.json` and
   `RELEASE-NOTES-<version>.md`.

Useful flags: `--skip-build` reuses an existing `dist/`; `--skip-e2e` skips the
cluster suite (the notes are then stamped with a warning telling you to run it);
`--allow-dirty` packages an uncommitted tree and must never be used for a real
release.

---

## 4. Verifying a release

```bash
cd releases
sha256sum -c SHA256SUMS                                  # integrity
../scripts/verify-release.sh obsidian-core-1.2.17.tar.gz --with-tests
../scripts/verify-release.sh obsidian-node-operator-1.2.17.tar.gz
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
  1.2.16 and 1.2.17): the rule set is identical.
- A protocol version change **does not** peer across the boundary (1.2.0 nodes
  do not accept earlier protocol nodes, and vice versa). Upgrade every node
  together, and expect the network to halt rather than split if you do not.
- The params hash is the final check: any consensus parameter edited without a
  version bump produces a hash mismatch and a refusal, which is exactly what
  `scripts/check-invariants.mjs` and CI are there to catch before release.

---

## 7. CI

`.github/workflows/ci.yml` runs seven jobs on every push: `core` (build,
typecheck and the core suite), `interface` (build, typecheck and the interface
suite), `edge` (the worker suite), `cluster` (three real nodes end to end),
`invariants` (the 55 economic/protocol checks, mainnet genesis determinism and a
mainnet node boot asserting `invariantOk: true` and every removed feature
absent), `docker` (both images built, started and probed, plus a two-container
stack whose chain height advances), and `releases` (the packaging script runs,
the sums verify, and the archives are uploaded). A green `releases` job is what
says a commit can be packaged; a committed archive is not evidence that the
current tree can be.
