#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Sign a release.
#
#   ./scripts/sign-release.sh                      # sign with your default key
#   ./scripts/sign-release.sh ABCD1234EF567890     # sign with a specific key
#
# A SHA256SUMS file proves that the bytes you downloaded are the bytes that
# were published. It does not prove *who* published them: anyone who can
# replace an archive can replace the digest list beside it. A detached
# signature over SHA256SUMS is what turns integrity into authorship.
#
# This script signs; it never generates a key. A release key must be created
# by the person who owns the release, on a machine they control, and its
# fingerprint published somewhere an attacker cannot edit. See
# docs/release-verification.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASES="$ROOT/releases"
KEY="${1:-}"

command -v gpg >/dev/null 2>&1 || {
  echo "gpg is not installed." >&2
  echo "  Debian/Ubuntu: sudo apt install gnupg" >&2
  echo "  Termux:        pkg install gnupg" >&2
  echo "  macOS:         brew install gnupg" >&2
  exit 1
}

[ -f "$RELEASES/SHA256SUMS" ] || {
  echo "no $RELEASES/SHA256SUMS — run scripts/package-releases.sh first" >&2
  exit 1
}

# Refuse to sign a digest list that does not match the archives beside it:
# signing a stale SHA256SUMS would publish an authentic signature over wrong
# digests, which is worse than not signing at all.
echo "→ re-checking every digest before signing"
( cd "$RELEASES" && sha256sum -c SHA256SUMS ) || {
  echo "digests do not match the archives — refusing to sign" >&2
  exit 1
}

SIGN_ARGS=(--armor --detach-sign --yes --output "$RELEASES/SHA256SUMS.asc")
[ -n "$KEY" ] && SIGN_ARGS=(--local-user "$KEY" "${SIGN_ARGS[@]}")

echo "→ signing SHA256SUMS"
gpg "${SIGN_ARGS[@]}" "$RELEASES/SHA256SUMS"

# Ship the public key next to the signature so a downloader has something to
# import, and print the fingerprint so it can be compared against a source the
# attacker does not control.
if [ -n "$KEY" ]; then
  gpg --armor --export "$KEY" > "$RELEASES/SIGNING-KEY.asc"
else
  DEFAULT_KEY="$(gpg --list-secret-keys --with-colons | awk -F: '/^fpr:/ { print $10; exit }')"
  gpg --armor --export "$DEFAULT_KEY" > "$RELEASES/SIGNING-KEY.asc"
  KEY="$DEFAULT_KEY"
fi

echo
echo "signed: $RELEASES/SHA256SUMS.asc"
echo "public key: $RELEASES/SIGNING-KEY.asc"
echo
echo "fingerprint (publish this where the archives are NOT hosted):"
gpg --fingerprint "$KEY" | sed -n '2p' | tr -d ' '
echo
echo "a downloader verifies with:"
echo "  gpg --import SIGNING-KEY.asc        # once, after checking the fingerprint"
echo "  gpg --verify SHA256SUMS.asc SHA256SUMS"
echo "  sha256sum -c SHA256SUMS"
