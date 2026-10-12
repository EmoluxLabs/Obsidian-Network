#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Rebuild a release from its source commit in a clean clone and compare the archives byte for byte.
#
#   scripts/reproduce-release.sh              # the commit named in releases/MANIFEST.json
#   scripts/reproduce-release.sh <commit>
#
# Needs: git, node >= 20, npm, tar, gzip, zip, network access to the npm registry (for `npm ci`).
# Uses no credentials and no production key. Exit 0 only when EVERY archive and SBOM is identical to the one in releases/.
# What this does not prove: that the toolchain itself is trustworthy, or that a different OS/Node/npm build would match
# (the manifest records the toolchain of the original build; compare it with `node --version` here).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT="${1:-$(node -p "require('$ROOT/releases/MANIFEST.json').commit")}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ cloning $COMMIT into a clean directory"
git clone -q --no-hardlinks "$ROOT" "$WORK/src"
git -C "$WORK/src" checkout -q --detach "$COMMIT"
[ "$(git -C "$WORK/src" rev-parse HEAD)" = "$(git -C "$ROOT" rev-parse "$COMMIT^{commit}")" ] || { echo "checked-out commit differs from $COMMIT" >&2; exit 1; }

cd "$WORK/src"
echo "→ clean install and build (no tests), toolchain: node $(node --version), npm $(npm --version)"
for pkg in obsidian-core obsidian-interface; do npm --prefix "$pkg" ci --silent; done
./scripts/package-releases.sh --no-tests > "$WORK/package.log" 2>&1 || { tail -40 "$WORK/package.log" >&2; echo "rebuild failed" >&2; exit 1; }

echo "→ comparing with $ROOT/releases"
status=0
compare() {
  local name="$1"
  if [ ! -f "$ROOT/releases/$name" ]; then echo "  MISSING in releases/: $name"; status=1; return; fi
  if cmp -s "$ROOT/releases/$name" "$WORK/src/releases/$name"; then echo "  identical  $name"; else echo "  DIFFERENT  $name"; status=1; fi
}
while read -r _ name; do compare "$name"; done < "$WORK/src/releases/SHA256SUMS"
for sbom in "$WORK/src/releases"/sbom-*.cdx.json; do compare "$(basename "$sbom")"; done
extra=$(cd "$ROOT/releases" && ls *.zip *.tar.gz 2>/dev/null | while read -r f; do grep -q "  $f\$" "$WORK/src/releases/SHA256SUMS" || echo "$f"; done)
[ -z "$extra" ] || { echo "  committed archives the rebuild does not produce: $extra"; status=1; }
[ "$status" = 0 ] && echo "REPRODUCED: every archive and SBOM is byte-identical to the committed release" || echo "NOT REPRODUCED (see above)"
exit "$status"
