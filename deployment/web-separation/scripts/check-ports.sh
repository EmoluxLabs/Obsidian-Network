#!/usr/bin/env bash
# Are the three internal ports free, or already held by the right Obsidian service? Read-only: it changes nothing.
#
#   bash check-ports.sh                       # 8789 platform, 8790 app, 8791 wallet
#   PLATFORM_PORT=8800 bash check-ports.sh    # check a replacement instead
#
# Exit 0: every port is free or held by the expected service. Exit 1: at least one port is held by something else;
# the output names it and suggests a free replacement. Change a port in exactly TWO places, then run install.sh:
# that service's env file, and (for the platform) OBSIDIAN_PLATFORM_URL in the two other env files.
set -u
PLATFORM_PORT="${PLATFORM_PORT:-8789}"
APP_PORT="${APP_PORT:-8790}"
WALLET_PORT="${WALLET_PORT:-8791}"

command -v ss >/dev/null || { echo "ss not found (install iproute2)"; exit 2; }
# `ss -p` only shows other users' processes as root.
[ "$(id -u)" -eq 0 ] || echo "note: not root, so the owning process of a busy port may not be shown (use sudo)"

listing="$(ss -ltnpH 2>/dev/null)"
owner_of() { printf '%s\n' "$listing" | awk -v p=":$1" '{ n=split($4, a, ":"); if (":" a[n] == p) print }' | head -n 1; }
is_free() { [ -z "$(owner_of "$1")" ]; }

bad=0
reserved=" $PLATFORM_PORT $APP_PORT $WALLET_PORT "
suggest() {
  local p=8792
  while [ "$p" -le 8899 ]; do
    if is_free "$p" && [[ "$reserved" != *" $p "* ]]; then echo "$p"; return; fi
    p=$((p + 1))
  done
  echo "none-in-8792-8899"
}

check() { # name port expected-process-pattern
  local line
  line="$(owner_of "$2")"
  if [ -z "$line" ]; then
    printf '%-9s %-5s FREE\n' "$1" "$2"
  elif printf '%s' "$line" | grep -Eq "$3"; then
    printf '%-9s %-5s IN USE by the expected service: %s\n' "$1" "$2" "$(printf '%s' "$line" | awk '{print $4, $NF}')"
  else
    bad=1
    printf '%-9s %-5s IN USE by something else: %s\n' "$1" "$2" "$(printf '%s' "$line" | awk '{print $4, $NF}')"
    local s; s="$(suggest)"; reserved="$reserved$s "
    printf '          -> suggested replacement for the %s ONLY: %s\n' "$1" "$s"
  fi
  # A port reachable on a public address is a finding even when the owner is right.
  if printf '%s' "$line" | awk '{print $4}' | grep -Eq '^(0\.0\.0\.0|\*|\[::\]):'; then
    printf '          !! bound to all addresses; it must be 127.0.0.1 (set the HOST/APP_HOST setting)\n'
    bad=1
  fi
}

check platform "$PLATFORM_PORT" 'node|obsidian'
check app      "$APP_PORT"      'node|obsidian'
check wallet   "$WALLET_PORT"   'node|obsidian'
exit "$bad"
