# Release signing, publisher fingerprint, verification and reproduction

**State at 1.8.1, stated plainly: no publisher key exists, so no Obsidian release is signed and *authenticated
publication is incomplete*.** The pipeline below is built and tested with throw-away keys; it has never signed a real
release, because creating the publisher's identity is the publisher's act, not something this project or its CI may do.
Until a key exists you can verify **integrity** (the archives match the checksums and each other) but not **authorship**.

An unsigned `SHA256SUMS` is not authentication. Anyone who can replace an archive can replace the checksum file beside it.

## 1. What is signed, and what a signature means

`release-tool.mjs sign` writes `RELEASE-SIGNATURE.json`: an Ed25519 signature over a small statement naming the
**version**, the **source commit**, the SHA-256 of `SHA256SUMS` and the SHA-256 of `MANIFEST.json`. `SHA256SUMS` names every
archive and `MANIFEST.json` names every other artifact (the SBOMs), so one signature covers all of them and the
commit they were built from. Needs only Node 20+; no network, no third-party code.

`verify` answers three separate questions and never merges them:

1. **Integrity**: every listed file exists and matches its digest; nothing unlisted is present; the manifest and checksum list agree.
2. **Consistency**: the version in the manifest, every archive name, the release notes, the core archive's `package.json`,
   the **built node inside the archive** (`dist/version.js`, core and protocol version), the git tag (`--tag`) and the
   CHANGELOG at the built commit (`--repo`) all agree; a tag may differ from the built commit only inside `releases/`.
3. **Trust**: the signing key's fingerprint is one **you** pinned. A valid signature by an unpinned key proves nothing about
   who published: the attacker who replaced the archives can replace the key beside them.

| Exit | Status | Meaning |
|---|---|---|
| 0 | `AUTHENTICATED` | Intact, consistent, signed by a pinned publisher key |
| 1 | `FAILED` | Altered or missing file, bad signature, version/tag/changelog/binary disagreement |
| 2 | usage | |
| 3 | `SIGNED_UNTRUSTED` | Signature valid, but the key is not pinned: authorship **not** established |
| 4 | `INTEGRITY_OK_UNSIGNED` | Intact, no signature: authorship unproven |

## 2. The publisher, once (an offline machine you control)

```bash
node scripts/release-tool.mjs keygen --out ~/obsidian-release-key.pem     # prints the fingerprint; the key file is mode 0600
```

* The **private key never goes in the repository, in CI, in a chat, or on the machine that builds**. Back it up offline
  in two places. If it is lost, publish a new fingerprint through the same independent channels and say so; old
  releases stay verifiable against the old fingerprint.
* **Publish the fingerprint through at least two channels that are not the download host**: for example the project's
  website over HTTPS *and* a signed or otherwise independent social/announcement account, or printed in your own
  documentation. A verifier compares what they computed with what they read there.

## 3. Cutting a signed release

```bash
git status                                  # clean, on the commit you intend to release
./scripts/package-releases.sh               # builds, tests, writes archives, SBOM, MANIFEST.json, SHA256SUMS; self-checks integrity
node scripts/release-tool.mjs sign --key ~/obsidian-release-key.pem --releases releases
node scripts/release-tool.mjs verify --fingerprint '<the fingerprint you published>' --releases releases --repo . --tag v<version> --require-sbom
git add releases && git commit && git tag -a v<version> -m "Obsidian Network <version>"
```

`package-releases.sh` can also sign if `OBSIDIAN_RELEASE_KEY` points at a key file at run time; it does not read a key from
the repository or the environment's contents, and it refuses to sign a tree whose checksums do not match its files.
The signing step refuses to sign a release that fails its own integrity check (a signature over stale digests is worse than none).

**Attaching the assets.** `gh release create v<version> releases/*.zip releases/*.tar.gz releases/SHA256SUMS releases/MANIFEST.json releases/RELEASE-SIGNATURE.json releases/sbom-*.cdx.json releases/RELEASE-NOTES-<version>.md`.
In the build sandbox for 1.8.0 and 1.8.1 uploads to `uploads.github.com` were unreachable, so those releases are
**notes-only** on GitHub; the canonical location of the artifacts is the `releases/` directory at the release tag in
this repository (and the CI artifact `obsidian-release-archives`). Attach them from a machine that can reach GitHub.

## 4. Verifying on a clean machine (a person who does not trust the download host)

```bash
# 1. Get the fingerprint from your two independent channels, and write it down BEFORE downloading anything.
# 2. Get the repository at the tag (this is the source of the verification tool and of the archives):
git clone --branch v<version> https://github.com/EmoluxLabs/Obsidian-Network.git && cd Obsidian-Network
# 3. Verify, pinning the fingerprint you read in step 1:
node scripts/release-tool.mjs verify --fingerprint '<fingerprint from step 1>' --releases releases --repo . --tag v<version> --require-sbom
echo $?        # 0 = authenticated. Anything else: do not install; read the message.
```

A 4 (`INTEGRITY_OK_UNSIGNED`) today means the release is intact and **not authenticated**; that is the honest state until
the publisher signs. A 3 means somebody signed it with a key you did not pin: treat it as hostile until you can explain it.
You can pin several fingerprints (`--fingerprint a --fingerprint b` or `OBSIDIAN_RELEASE_FINGERPRINTS`), e.g. across a key rotation.

The older GPG scripts (`sign-release.sh`, `verify-release.sh`) remain for people who already use GPG. They do **not** enforce
a pinned fingerprint or check version/tag agreement, so prefer `release-tool.mjs`. `gpg` is not required for it.

## 5. Reproducing the build

```bash
./scripts/reproduce-release.sh            # the commit named in releases/MANIFEST.json
./scripts/reproduce-release.sh <commit>
```

It clones the commit into a clean directory, runs `npm ci` and `package-releases.sh --no-tests`, and compares **every**
archive and SBOM byte for byte with the ones in `releases/`. Exit 0 only if all are identical. The packaging script fixes
timestamps, sort order, owner and compression metadata, strips volatile fields from the SBOM, and records the Node version, the npm
user agent and `SOURCE_DATE_EPOCH` (the commit time) in `MANIFEST.json`.

**What a match proves and does not.** It proves the archives are a function of the commit and the toolchain on *that*
machine. It does not prove the toolchain (Node, npm, the registry's packages) is trustworthy, and a different Node/npm/OS may
produce different bytes: compare against the toolchain the manifest records. **A reproduction claim means two independent
builds were compared; the result for this release is in `releases/REPRODUCTION-<version>.txt`**, with what machine and
toolchain it ran on. The authors' own two builds on one machine are weaker evidence than a third party's, and the release
notes say so.

## 6. CI

CI builds the archives (`releases` job, `--allow-dirty --skip-e2e`) and uploads them as a workflow artifact. It holds **no
signing key and must not**. Signing is a human step on the publisher's machine; the pipeline's job is to fail when the
archives do not match the commit and manifest (the packaging self-check does exactly that).
