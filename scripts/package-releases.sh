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
SIGNING_TESTS=0
SOAK_TESTS=0
CLUSTER_TESTS=0
NETWORK_TESTS=0
INVITE_TESTS=0
CONSISTENCY_TESTS=0

# RELEASE_LOG_DIR keeps every gate's output: a failed release packaging run is
# exactly when you want the node logs, not a cleaned-up temp directory.
if [ -n "${RELEASE_LOG_DIR:-}" ]; then
  LOGS="$RELEASE_LOG_DIR"
  mkdir -p "$LOGS"
else
  LOGS="$(mktemp -d)"
  trap 'rm -rf "$LOGS"' EXIT
fi
echo "gate logs: $LOGS"

# Run one gate, keep its full output for diagnosis, and never let a failure
# disappear into a command substitution: a release gate that fails silently is
# worse than no gate at all.
gate() {
  local label="$1" log="$2"; shift 2
  echo "→ $label"
  if ! "$@" >"$log" 2>&1; then
    echo "" >&2
    echo "── $label FAILED (full output: $log) ──" >&2
    tail -60 "$log" >&2
    echo "─────────────────────────────────────" >&2
    exit 1
  fi
}

# Pull a count out of a suite's output, forgiving ANSI colour.
count_vitest() { sed -e 's/\x1b\[[0-9;]*m//g' "$1" | sed -n 's/^ *Tests *\([0-9][0-9]*\) passed.*/\1/p' | tail -1; }
count_node_test() { sed -n 's/^# pass \([0-9][0-9]*\)$/\1/p' "$1" | tail -1; }

if [ "$SKIP_BUILD" = 0 ]; then
  echo "→ building core"
  npm --prefix obsidian-core ci --silent
  npm --prefix obsidian-core run build --silent
  gate "core tests (the suite must pass before anything ships)" "$LOGS/core.log" npm --prefix obsidian-core test --silent
  CORE_TESTS="$(count_vitest "$LOGS/core.log")"

  echo "→ building interface (core → browser modules → bundles → sites → typecheck)"
  npm --prefix obsidian-interface ci --silent
  npm --prefix obsidian-interface run build --silent
  gate "interface tests" "$LOGS/interface.log" npm --prefix obsidian-interface test --silent
  INTERFACE_TESTS="$(count_vitest "$LOGS/interface.log")"

  gate "edge worker tests" "$LOGS/edge.log" node --test cloudflare/test/worker.test.mjs
  EDGE_TESTS="$(count_node_test "$LOGS/edge.log")"

  # The verification script is what a stranger runs before trusting this
  # build, so its behaviour is gated like any other shipped code.
  gate "release verification and signing behaviour" "$LOGS/signing.log" node --test tests/scripts/release-signing.test.mjs
  SIGNING_TESTS="$(count_node_test "$LOGS/signing.log")"

  # The soak verdict decides whether an operator's multi-hour run passed. It
  # once decided PASS while measuring nothing, so its rules are gated too.
  gate "soak verdict rules" "$LOGS/soak.log" node --test tests/scripts/soak-verdict.test.mjs
  SOAK_TESTS="$(count_node_test "$LOGS/soak.log")"

  # The code printed by this generator is the only key to a fresh deployment: its hash must belong
  # to its code, checked through the interface's own verifier. Needs the interface built.
  gate "genesis invitation generator" "$LOGS/invite.log" node --test tests/scripts/genesis-invite-script.test.mjs
  INVITE_TESTS="$(count_node_test "$LOGS/invite.log")"

  # Versions, identities, ports, environment variables, links and the per-network sections of
  # the guides must agree with the code that is about to be shipped. Needs the core built.
  gate "repository consistency (versions, identities, ports, variables, links, the four networks never mixed)" "$LOGS/consistency.log" node --test tests/scripts/repo-consistency.test.mjs
  CONSISTENCY_TESTS="$(count_node_test "$LOGS/consistency.log")"

  if [ "$SKIP_E2E" = 0 ]; then
    gate "three-node cluster end-to-end test (this starts real nodes on ports 39630-39635)" "$LOGS/cluster.log" node --test tests/e2e/cluster.test.mjs
    CLUSTER_TESTS="$(count_node_test "$LOGS/cluster.log")"
    # The four networks side by side: the launch guides promise they never mix, so the thing that runs
    # them is gated like everything else. Needs both packages built, which the steps above have just done.
    #
    # One file at a time, on purpose. These suites start real nodes and interfaces on fixed ports, and the
    # operating system hands out the same range for the OUTGOING side of connections. With several files
    # running side by side, a long-lived connection from one (an interface keeps one open to its node) can
    # sit on the very port another is about to listen on, and the node stops with EADDRINUSE. Each file has
    # its own ports; running them in turn means nothing else is holding connections while it starts.
    NETWORK_TESTS=0
    for suite in \
      "four-network isolation test (ports 9130-39289)|tests/e2e/networks.test.mjs|networks" \
      "interface-to-node ecosystem test (ports 49130-49288)|tests/e2e/ecosystem.test.mjs|ecosystem" \
      "per-network helper script (ports 9330-39488)|tests/scripts/network-script.test.mjs|helper" \
      "Termux quick-start page, run as written (ports 9530-39688)|tests/scripts/termux-quickstart.test.mjs|quickstart"; do
      IFS='|' read -r suite_label suite_file suite_name <<<"$suite"
      gate "$suite_label" "$LOGS/$suite_name.log" node --test "$suite_file"
      suite_count="$(count_node_test "$LOGS/$suite_name.log")"
      NETWORK_TESTS=$((NETWORK_TESTS + ${suite_count:-0}))
    done
  else
    echo "→ cluster and four-network end-to-end tests skipped (--skip-e2e)"
  fi

  CORE_TESTS="${CORE_TESTS:-0}"
  INTERFACE_TESTS="${INTERFACE_TESTS:-0}"
  EDGE_TESTS="${EDGE_TESTS:-0}"
  SIGNING_TESTS="${SIGNING_TESTS:-0}"
  SOAK_TESTS="${SOAK_TESTS:-0}"
  CLUSTER_TESTS="${CLUSTER_TESTS:-0}"
  NETWORK_TESTS="${NETWORK_TESTS:-0}"
  INVITE_TESTS="${INVITE_TESTS:-0}"
  CONSISTENCY_TESTS="${CONSISTENCY_TESTS:-0}"
  for pair in "core:$CORE_TESTS" "interface:$INTERFACE_TESTS" "edge:$EDGE_TESTS" "signing:$SIGNING_TESTS" "soak:$SOAK_TESTS" "invitation:$INVITE_TESTS" "consistency:$CONSISTENCY_TESTS"; do
    if [ "${pair#*:}" = "0" ]; then
      echo "no tests ran for ${pair%%:*} — refusing to package" >&2
      exit 1
    fi
  done
  if [ "$SKIP_E2E" = 0 ] && [ "$CLUSTER_TESTS" = "0" ]; then
    echo "the cluster end-to-end test reported no passes — refusing to package" >&2
    exit 1
  fi
  if [ "$SKIP_E2E" = 0 ] && [ "$NETWORK_TESTS" = "0" ]; then
    echo "the four-network isolation test reported no passes — refusing to package" >&2
    exit 1
  fi
  TOTAL_TESTS=$((CORE_TESTS + INTERFACE_TESTS + EDGE_TESTS + SIGNING_TESTS + SOAK_TESTS + INVITE_TESTS + CONSISTENCY_TESTS + CLUSTER_TESTS + NETWORK_TESTS))
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
  obsidian-core/src obsidian-core/tests obsidian-core/dist obsidian-core/config \
  obsidian-core/deployment obsidian-core/README.md .env.example 2>/dev/null || true
cp LICENSE "$STAGING/obsidian-core/" 2>/dev/null || true

# ── 2. obsidian-interface: server, built bundles and the site shells ─────────
stage "$STAGING/obsidian-interface" \
  obsidian-interface/package.json obsidian-interface/package-lock.json \
  obsidian-interface/tsconfig.json obsidian-interface/tsconfig.web.json obsidian-interface/vitest.config.ts \
  obsidian-interface/server obsidian-interface/dist obsidian-interface/scripts \
  obsidian-interface/web obsidian-interface/public obsidian-interface/tests \
  obsidian-interface/deployment obsidian-interface/README.md \
  landing mine wallet explorer ons node developer app audit \
  docs LICENSE

# ── 3. obsidian-cloudflare: gateway only ─────────────────────────────────────
stage "$STAGING/obsidian-cloudflare" \
  cloudflare/src cloudflare/test cloudflare/terraform cloudflare/wrangler.toml \
  cloudflare/README.md cloudflare/cloudflare-config.md docs LICENSE

# ── 4. node operator package: what an operator actually installs ─────────────
stage "$STAGING/obsidian-node-operator" \
  obsidian-core/dist obsidian-core/package.json obsidian-core/package-lock.json \
  obsidian-core/deployment/docker obsidian-core/deployment/systemd obsidian-core/deployment/nginx \
  obsidian-core/deployment/monitoring \
  obsidian-core/deployment/node.env.example obsidian-core/config \
  docs LICENSE
cp scripts/verify-release.sh "$STAGING/obsidian-node-operator/verify-release.sh"
cp scripts/sign-release.sh "$STAGING/obsidian-node-operator/sign-release.sh"
cp scripts/dearmor.mjs "$STAGING/obsidian-node-operator/dearmor.mjs"
# A soak is the operator's job, not the packager's, so the tool goes with the
# build rather than staying in the source tree — both halves of it: the runner
# and the verdict module it imports.
cp scripts/soak.mjs "$STAGING/obsidian-node-operator/soak.mjs"
cp scripts/soak-verdict.mjs "$STAGING/obsidian-node-operator/soak-verdict.mjs"
# The launch runbook asks operators to check the economic invariants against the
# build they are about to run, so the checker ships with the build.
cp scripts/check-invariants.mjs "$STAGING/obsidian-node-operator/check-invariants.mjs"
# One command per network, and the generator for its Genesis Invitation. They sit
# at the archive root, next to obsidian-core/, which is where the script looks
# (the interface is extracted to obsidian-interface/ beside it; see the guides).
cp scripts/obsidian-network.sh "$STAGING/obsidian-node-operator/obsidian-network.sh"
cp scripts/new-genesis-invite.mjs "$STAGING/obsidian-node-operator/new-genesis-invite.mjs"
chmod +x "$STAGING/obsidian-node-operator/obsidian-network.sh"

# ── 5. self-hosted interface package ─────────────────────────────────────────
stage "$STAGING/obsidian-interface-selfhost" \
  obsidian-interface/dist obsidian-interface/public obsidian-interface/web/core \
  obsidian-interface/package.json obsidian-interface/package-lock.json \
  obsidian-interface/deployment \
  landing mine wallet explorer ons node developer app audit \
  docs LICENSE

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
import { blockHash } from './obsidian-core/dist/blockchain/block.js';
import { PARAMS_HASH } from './obsidian-core/dist/blockchain/state-root.js';
import { buildGenesisBlock, genesisDocumentFor, genesisId } from './obsidian-core/dist/genesis/initialize.js';
import { NETWORKS } from './obsidian-core/dist/protocol/networks.js';
import { CONSENSUS_PARAMS } from './obsidian-core/dist/protocol/params.js';
import { PROTOCOL_VERSION } from './obsidian-core/dist/version.js';
const [version, commit, builtAt] = process.argv.slice(2);
const dir = 'releases';
const files = readdirSync(dir).filter((name) => /\.(zip|tar\.gz)$/.test(name)).sort();
const assets = files.map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
const networks = Object.fromEntries(Object.entries(NETWORKS).map(([name, net]) => {
  const document = genesisDocumentFor(net);
  return [name, {
    networkId: net.networkId,
    chainId: net.chainId,
    addressPrefix: net.addressHrp,
    rpcPort: net.defaultRpcPort,
    p2pPort: net.defaultP2pPort,
    genesisId: genesisId(document, net),
    genesisBlockHash: blockHash(buildGenesisBlock(document, net).header),
  }];
}));
const manifest = {
  product: 'Obsidian Network',
  version,
  commit,
  builtAt,
  // Read consensus identity from the build being packaged, never literals: a
  // manifest that disagrees with the binary it describes is worse than none.
  protocolVersion: PROTOCOL_VERSION,
  paramsHash: PARAMS_HASH,
  forkChoice: CONSENSUS_PARAMS.consensus.forkChoice,
  finality: CONSENSUS_PARAMS.consensus.finality,
  networks,
  maximumSupplyObs: '21000000',
  genesisAllocationObs: '100000',
  assets,
  verification: 'sha256sum -c SHA256SUMS, then compare the digests with the published release notes',
};
writeFileSync(join(dir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
NODE

( cd "$RELEASES" && sha256sum $(ls *.zip *.tar.gz | sort) > SHA256SUMS )

if [ "$SKIP_BUILD" = 0 ] && [ "$SKIP_E2E" = 0 ]; then
  TEST_SUMMARY="* ${TOTAL_TESTS} automated tests, all of them run immediately before packaging: core (${CORE_TESTS}), interface (${INTERFACE_TESTS}), edge worker (${EDGE_TESTS}), release verification and signing behaviour (${SIGNING_TESTS}), soak verdict rules (${SOAK_TESTS}), the genesis invitation generator (${INVITE_TESTS}), repository consistency (${CONSISTENCY_TESTS}), the three-node cluster end-to-end suite (${CLUSTER_TESTS}) and the four-network isolation suite, the interface-to-node ecosystem suite, the per-network helper script and the Termux quick-start page run as written (${NETWORK_TESTS})"
elif [ "$SKIP_BUILD" = 0 ]; then
  TEST_SUMMARY="* $((CORE_TESTS + INTERFACE_TESTS + EDGE_TESTS + SIGNING_TESTS + SOAK_TESTS + INVITE_TESTS + CONSISTENCY_TESTS)) automated tests run before packaging: core (${CORE_TESTS}), interface (${INTERFACE_TESTS}), edge worker (${EDGE_TESTS}), release verification and signing behaviour (${SIGNING_TESTS}), the soak verdict rules (${SOAK_TESTS}), the genesis invitation generator (${INVITE_TESTS}) and repository consistency (${CONSISTENCY_TESTS}). The cluster and four-network end-to-end suites were skipped (--skip-e2e): run \`node --test tests/e2e/cluster.test.mjs tests/e2e/networks.test.mjs tests/e2e/ecosystem.test.mjs tests/scripts/network-script.test.mjs tests/scripts/termux-quickstart.test.mjs\` before trusting this build."
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
bash ../scripts/verify-release.sh obsidian-core-$VERSION.tar.gz --with-tests
\`\`\`

This locally produced candidate is **unsigned**. SHA-256 verifies integrity, not
publisher authorship. Do not treat it as an independently reproduced or signed
public release.

## Assets

$(ls releases/*.zip releases/*.tar.gz 2>/dev/null | sed "s|releases/|* |")

| Asset | Contents |
| --- | --- |
| obsidian-core | the node: source, tests, built \`dist/\`, deployment recipes |
| obsidian-interface | the reader: server, tests, browser bundles, every site directory (nine pages, light and mobile-first) |
| obsidian-cloudflare | the edge gateway: worker, tests, Terraform |
| obsidian-node-operator | what an operator installs: built node, systemd/nginx/Docker recipes, docs |
| obsidian-interface-selfhost | a ready-to-serve interface: built bundles, sites, systemd/nginx/Docker recipes |
| obsidian-network-source | the entire repository at this commit |

## What is in this release

* Proof of Time block production plus native sequential checkpoint finality:
  \`floor(2N/3)+1\` equal active-validator memberships, a 64-parent-state
  stable-set bootstrap, finalized-history reorg protection, and signed bounded
  proposer/vote equivocation evidence
* fork choice is finalized anchor → fixed PoT weight → height → the lowest
  block hash, so equal-height ties resolve identically on every node
* protocol 1.6.0 is genesis-bound and rejects 1.5.x peers/data; it does not
  include a live-chain migration
${TEST_SUMMARY}
* the first valid miner still receives 100,000 OBS and becomes treasury; ONS
  registration and renewal are the only revenue source and split exactly 90%
  node runners / 10% treasury, and the validator bond is exactly 20,000 OBS
* no WAC, no \$5 activation, no legacy signup allocation, no admin mint, no
  native exchange — verify with \`curl -s localhost:8630/audit/compliance\`
* no claim of general BFT, universal immutability, production readiness,
  independent cryptographic review, or physical power-loss testing

## Containers

Docker images are built, started and probed by the \`docker\` job in CI on every
push — including a full node + interface compose stack whose chain height is
observed to advance, and a check that stopping the interface does not stop
consensus. To verify on your own machine:

\`\`\`bash
bash obsidian-core/deployment/docker/verify.sh
bash obsidian-interface/deployment/docker/verify.sh
\`\`\`

See \`docs/security-model.md\` (trust boundaries and honest limitations) and
\`docs/DEPLOYMENT-GUIDE.md\` "What I should deploy first" (the remaining risks) for the
verification boundary, and \`.github/workflows/ci.yml\` for what every gate checks.
NOTES

echo "→ release notes and digests"
ls -la "$RELEASES" | sed -n '1,40p'
echo
echo "done: $RELEASES"
