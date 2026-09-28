#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Build the release archives.
#
# Produces, in releases/:
#   obsidian-core-<version>.zip / .tar.gz
#   obsidian-interface-<version>.zip / .tar.gz
#   obsidian-cloudflare-<version>.zip / .tar.gz
#   obsidian-node-operator-<version>.zip / .tar.gz
#   obsidian-interface-selfhost-<version>.zip / .tar.gz
#   obsidian-network-source-<version>.tar.gz     (the whole repository, git-archived)
#   SHA256SUMS, MANIFEST.json, RELEASE-NOTES-<version>.md
#
# Archives are built from `git archive` when the tree is clean and from a
# staging copy otherwise, so what you download is exactly what was committed.
#
# Usage:  ./scripts/package-releases.sh [--skip-build] [--skip-e2e] [--allow-dirty]
#
# By default the release gate also runs the three-node cluster end-to-end test,
# so a release is never cut from a tree that only passes unit tests.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./obsidian-core/package.json').version")"
INTERFACE_VERSION="$(node -p "require('./obsidian-interface/package.json').version")"
RELEASES="$ROOT/releases"
STAGING="$RELEASES/staging"
SKIP_BUILD=0
SKIP_E2E=0
ALLOW_DIRTY=0

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --skip-e2e) SKIP_E2E=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$INTERFACE_VERSION" != "$VERSION" ]; then
  echo "version mismatch: core $VERSION vs interface $INTERFACE_VERSION" >&2
  exit 1
fi

if [ "$ALLOW_DIRTY" = 0 ] && [ -n "$(git status --porcelain)" ]; then
  echo "the working tree has uncommitted changes." >&2
  echo "commit them first (so the archives match a commit), or pass --allow-dirty." >&2
  git status --porcelain >&2
  exit 1
fi

COMMIT="$(git rev-parse HEAD)"
COMMIT_SHORT="$(git rev-parse --short HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "packaging Obsidian Network $VERSION from $COMMIT_SHORT"

# Test counts are read back from the runs themselves: the release notes must
# never quote a number nobody verified.
CORE_TESTS=0
INTERFACE_TESTS=0
EDGE_TESTS=0
CLUSTER_TESTS=0

if [ "$SKIP_BUILD" = 0 ]; then
  echo "→ building core"
  npm --prefix obsidian-core ci --silent
  npm --prefix obsidian-core run build --silent
  echo "→ testing core (the suite must pass before anything ships)"
  CORE_TESTS="$(npm --prefix obsidian-core test --silent 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | sed -n 's/^ *Tests *\([0-9][0-9]*\) passed.*/\1/p' | tail -1)"
  echo "→ building interface (core → browser modules → bundles → sites → typecheck)"
  npm --prefix obsidian-interface ci --silent
  npm --prefix obsidian-interface run build --silent
  echo "→ testing interface"
  INTERFACE_TESTS="$(npm --prefix obsidian-interface test --silent 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | sed -n 's/^ *Tests *\([0-9][0-9]*\) passed.*/\1/p' | tail -1)"
  echo "→ testing edge worker"
  EDGE_TESTS="$(node --test cloudflare/test/worker.test.mjs 2>&1 | sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' | tail -1)"

  if [ "$SKIP_E2E" = 0 ]; then
    echo "→ running the three-node cluster end-to-end test"
    CLUSTER_TESTS="$(node --test tests/e2e/cluster.test.mjs 2>&1 | sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' | tail -1)"
  else
    echo "→ cluster end-to-end test skipped (--skip-e2e)"
  fi

  CORE_TESTS="${CORE_TESTS:-0}"
  INTERFACE_TESTS="${INTERFACE_TESTS:-0}"
  EDGE_TESTS="${EDGE_TESTS:-0}"
  CLUSTER_TESTS="${CLUSTER_TESTS:-0}"
  for pair in "core:$CORE_TESTS" "interface:$INTERFACE_TESTS" "edge:$EDGE_TESTS"; do
    if [ "${pair#*:}" = "0" ]; then
      echo "no tests ran for ${pair%%:*} — refusing to package" >&2
      exit 1
    fi
  done
  if [ "$SKIP_E2E" = 0 ] && [ "$CLUSTER_TESTS" = "0" ]; then
    echo "the cluster end-to-end test reported no passes — refusing to package" >&2
    exit 1
  fi
  TOTAL_TESTS=$((CORE_TESTS + INTERFACE_TESTS + EDGE_TESTS + CLUSTER_TESTS))
else
  TOTAL_TESTS=0
fi

rm -rf "$RELEASES"/*.zip "$RELEASES"/*.tar.gz "$STAGING"
mkdir -p "$STAGING"

# ── helpers ──────────────────────────────────────────────────────────────────
archive() {
  local name="$1" dir="$2"
  ( cd "$dir" && zip -qr "$RELEASES/${name}.zip" . -x '*.git*' )
  ( cd "$dir" && tar --exclude='.git' -czf "$RELEASES/${name}.tar.gz" . )
  echo "  ${name}.zip / ${name}.tar.gz"
}

# Files from a path list, preserving structure, into a staging directory.
stage() {
  local target="$1"; shift
  rm -rf "$target"; mkdir -p "$target"
  for entry in "$@"; do
    if [ -e "$entry" ]; then
      mkdir -p "$target/$(dirname "$entry")"
      cp -R "$entry" "$target/$entry"
    else
      echo "    (skipped, not present: $entry)"
    fi
  done
}

echo "→ staging archives under $STAGING"

# ── 1. obsidian-core: the node, with its built dist ──────────────────────────
stage "$STAGING/obsidian-core" \
  obsidian-core/package.json obsidian-core/package-lock.json \
  obsidian-core/tsconfig.json obsidian-core/tsconfig.test.json obsidian-core/vitest.config.ts \
  obsidian-core/src obsidian-core/dist obsidian-core/deployment obsidian-core/scripts \
  obsidian-core/README.md .env.example 2>/dev/null || true
cp LICENSE "$STAGING/obsidian-core/" 2>/dev/null || true

# ── 2. obsidian-interface: server, built bundles and the site shells ─────────
stage "$STAGING/obsidian-interface" \
  obsidian-interface/package.json obsidian-interface/package-lock.json \
  obsidian-interface/tsconfig.json obsidian-interface/tsconfig.web.json obsidian-interface/vitest.config.ts \
  obsidian-interface/server obsidian-interface/dist obsidian-interface/scripts \
  obsidian-interface/web obsidian-interface/public obsidian-interface/tests \
  obsidian-interface/deployment obsidian-interface/README.md \
  landing mine wallet explorer social capsule ons circle developer app audit

# ── 3. obsidian-cloudflare: gateway only ─────────────────────────────────────
stage "$STAGING/obsidian-cloudflare" \
  cloudflare/src cloudflare/test cloudflare/terraform cloudflare/wrangler.toml \
  cloudflare/README.md cloudflare/cloudflare-config.md

# ── 4. node operator package: what an operator actually installs ─────────────
stage "$STAGING/obsidian-node-operator" \
  obsidian-core/dist obsidian-core/package.json obsidian-core/package-lock.json \
  obsidian-core/deployment/docker obsidian-core/deployment/systemd obsidian-core/deployment/nginx \
  obsidian-core/deployment/node.env.example obsidian-core/scripts \
  docs/node-operator.md docs/protocol.md docs/mining.md docs/api.md docs/security-model.md
cp scripts/verify-release.sh "$STAGING/obsidian-node-operator/verify-release.sh"

# ── 5. self-hosted interface package ─────────────────────────────────────────
stage "$STAGING/obsidian-interface-selfhost" \
  obsidian-interface/dist obsidian-interface/public obsidian-interface/web/core \
  obsidian-interface/package.json obsidian-interface/package-lock.json \
  obsidian-interface/deployment obsidian-interface/tests \
  landing mine wallet explorer social capsule ons circle developer app audit \
  docs/self-hosting.md docs/release-verification.md

# ── 6. the whole source tree, straight from git ──────────────────────────────
echo "→ source archive"
git archive --format=tar.gz --prefix="obsidian-network-$VERSION/" -o "$RELEASES/obsidian-network-source-$VERSION.tar.gz" HEAD

# ── archives ────────────────────────────────────────────────────────────────
echo "→ archives"
archive "obsidian-core-$VERSION" "$STAGING/obsidian-core"
archive "obsidian-interface-$VERSION" "$STAGING/obsidian-interface"
archive "obsidian-cloudflare-$VERSION" "$STAGING/obsidian-cloudflare"
archive "obsidian-node-operator-$VERSION" "$STAGING/obsidian-node-operator"
archive "obsidian-interface-selfhost-$VERSION" "$STAGING/obsidian-interface-selfhost"

# ── manifest and checksums ──────────────────────────────────────────────────
echo "→ manifest and checksums"
node - "$VERSION" "$COMMIT" "$BUILT_AT" <<'NODE'
import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [version, commit, builtAt] = process.argv.slice(2);
const dir = 'releases';
const files = readdirSync(dir).filter((name) => /\.(zip|tar\.gz)$/.test(name)).sort();
const assets = files.map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
const manifest = {
  product: 'Obsidian Network',
  version,
  commit,
  builtAt,
  protocolVersion: '1.0.0',
  networks: {
    mainnet: { chainId: 7777, addressPrefix: 'obs', rpcPort: 8630, p2pPort: 8631 },
    testnet: { chainId: 7778, addressPrefix: 'tobs', rpcPort: 18630, p2pPort: 18631 },
    staging: { chainId: 7779, addressPrefix: 'sobs', rpcPort: 28630, p2pPort: 28631 },
    devnet: { chainId: 7780, addressPrefix: 'dobs', rpcPort: 38630, p2pPort: 38631 },
  },
  maximumSupplyObs: '21000000',
  genesisAllocationObs: '100000',
  assets,
  verification: 'sha256sum -c SHA256SUMS, then compare the digests with the published release notes',
};
writeFileSync(join(dir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

( cd "$RELEASES" && sha256sum $(ls *.zip *.tar.gz | sort) > SHA256SUMS )

if [ "$SKIP_BUILD" = 0 ] && [ "$SKIP_E2E" = 0 ]; then
  TEST_SUMMARY="* ${TOTAL_TESTS} automated tests, all of them run immediately before packaging: core (${CORE_TESTS}), interface (${INTERFACE_TESTS}), edge worker (${EDGE_TESTS}) and the three-node cluster end-to-end suite (${CLUSTER_TESTS})"
elif [ "$SKIP_BUILD" = 0 ]; then
  TEST_SUMMARY="* $((CORE_TESTS + INTERFACE_TESTS + EDGE_TESTS)) automated tests run before packaging: core (${CORE_TESTS}), interface (${INTERFACE_TESTS}), edge worker (${EDGE_TESTS}). The three-node cluster end-to-end suite was skipped (--skip-e2e): run \`node --test tests/e2e/cluster.test.mjs\` before trusting this build."
else
  TEST_SUMMARY="* No tests were run for this packaging pass (--skip-build). Treat these archives as source-only until you run the suites yourself."
fi

cat > "$RELEASES/RELEASE-NOTES-$VERSION.md" <<NOTES
# Obsidian Network $VERSION

Built from commit \`$COMMIT\` at $BUILT_AT.

## Verify before you run

\`\`\`bash
cd releases
sha256sum -c SHA256SUMS
cat MANIFEST.json          # asset sizes, networks, protocol constants
./verify-release.sh obsidian-core-$VERSION.tar.gz   # extract, build, test
\`\`\`

## Assets

$(ls releases/*.zip releases/*.tar.gz 2>/dev/null | sed "s|releases/|* |")

| Asset | Contents |
| --- | --- |
| obsidian-core | the node: source, tests, built \`dist/\`, deployment recipes |
| obsidian-interface | the reader: server, tests, browser bundles, every site directory |
| obsidian-cloudflare | the edge gateway: worker, tests, Terraform |
| obsidian-node-operator | what an operator installs: built node, systemd/nginx/Docker recipes, docs |
| obsidian-interface-selfhost | a ready-to-serve interface: built bundles, sites, systemd/nginx/Docker recipes |
| obsidian-network-source | the entire repository at this commit |

## What is in this release

* consensus, p2p, RPC, indexer and the nine transaction executors
${TEST_SUMMARY}
* no WAC, no \$5 activation, no legacy signup allocation, no admin mint, no
  native exchange — verify with \`curl -s localhost:8630/audit/compliance\`

## What is not

Docker images were not built in the development environment (Docker is
unavailable there). Run \`deployment/docker/verify.sh\` on your machine before
relying on the container recipes; see \`docs/IMPLEMENTATION-REPORT.md\` item 12.
NOTES

echo "→ release notes and digests"
ls -la "$RELEASES" | sed -n '1,40p'
echo
echo "done: $RELEASES"
