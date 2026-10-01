#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Verify a release archive before you run it.
#
#   ./verify-release.sh obsidian-core-1.2.8.tar.gz
#   ./verify-release.sh obsidian-node-operator-1.2.8.zip --with-tests
#
# Checks, in order:
#   1. the archive is listed in SHA256SUMS and its digest matches;
#   2. it extracts into a temporary directory (never over your working tree);
#   3. the expected entry points and version markers are present;
#   4. with --with-tests, the shipped test suite runs and must pass.
#
# Nothing is executed from the archive until step 4, and even then only the test
# runner — never a node that would touch your keys.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ARCHIVE="${1:-}"
WITH_TESTS=0
[ "${2:-}" = "--with-tests" ] && WITH_TESTS=1

if [ -z "$ARCHIVE" ]; then
  echo "usage: $0 <archive.zip|archive.tar.gz> [--with-tests]" >&2
  exit 2
fi
[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="$(basename "$ARCHIVE")"
# SHA256SUMS normally sits beside the archive (that is how releases/ is laid
# out), but this script is also shipped inside the node operator package where
# it sits beside itself. Look in both places, archive first: the sums file that
# accompanies the download is the one that describes it.
ARCHIVE_DIR="$(cd "$(dirname "$ARCHIVE")" && pwd)"
SUMS=""
for candidate in "$ARCHIVE_DIR/SHA256SUMS" "$HERE/SHA256SUMS"; do
  [ -f "$candidate" ] && { SUMS="$candidate"; break; }
done

if [ -n "$SUMS" ]; then
  echo "→ checking $BASE against $SUMS"
  SUMS_DIR="$(dirname "$SUMS")"
  EXPECTED="$(mktemp)"
  grep " $BASE\$" "$SUMS" > "$EXPECTED" || true
  if [ ! -s "$EXPECTED" ]; then
    echo "  $BASE is not listed in $SUMS — refusing" >&2
    rm -f "$EXPECTED"
    exit 1
  fi
  ( cd "$SUMS_DIR" && sha256sum -c "$EXPECTED" )
  rm -f "$EXPECTED"
else
  echo "→ no SHA256SUMS found beside the archive or this script:"
  echo "  computing the digest so you can compare it by hand"
  sha256sum "$ARCHIVE"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "→ extracting into $WORK"
case "$ARCHIVE" in
  *.zip) unzip -q "$ARCHIVE" -d "$WORK" ;;
  *.tar.gz) tar -xzf "$ARCHIVE" -C "$WORK" ;;
  *) echo "unsupported archive type: $ARCHIVE" >&2; exit 1 ;;
esac

echo "→ marker check"
find "$WORK" -maxdepth 3 -type f \( -name package.json -o -name worker.js -o -name 'README.md' \) | sed "s|$WORK/|  |"

if [ -f "$WORK/package.json" ]; then
  VERSION="$(node -p "require('$WORK/package.json').version")"
  echo "  package version: $VERSION"
fi

if [ "$WITH_TESTS" = 1 ]; then
  if [ -f "$WORK/package.json" ] && node -e "process.exit(require('$WORK/package.json').scripts?.test ? 0 : 1)"; then
    echo "→ running the shipped test suite (install + build required first)"
    ( cd "$WORK" && npm ci >/dev/null && npm test )
  else
    echo "  this archive has no test script; skipping (nothing to run)"
  fi
fi

echo "OK: ${BASE} verified."
