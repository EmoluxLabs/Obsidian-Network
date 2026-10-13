#!/usr/bin/env bash
# Undo install.sh, exactly: remove the files it added, put back everything it backed up (nginx config, the vhost
# symlinks it disabled, the /etc/obsidian settings), test, and reload nginx only on request.
#
#   sudo bash rollback.sh /var/backups/obsidian-web/<timestamp> [--reload]
#
# It does not stop or start the app or wallet services and does not touch the node, the platform's data, wallets,
# keystores or genesis. To go back to the old platform port, restore its env file (included in the backup) and
# `systemctl restart obsidian-interface@mainnet`.
set -euo pipefail
ROOT="${OBS_ROOT:-}"; NGINX_BIN="${NGINX_BIN:-nginx}"
BK="${1:-}"; shift || true
RELOAD=0; CHECK=1
for a in "$@"; do case "$a" in --reload) RELOAD=1;; --no-check) CHECK=0;; *) echo "unknown option: $a" >&2; exit 2;; esac; done
[ -n "$BK" ] && [ -f "$BK/nginx.tar" ] || { echo "usage: rollback.sh <backup dir from install.sh> [--reload]" >&2; exit 2; }

# 1. Remove what install.sh created.
if [ -s "$BK/added.list" ]; then
  while IFS= read -r rel; do
    [ -n "$rel" ] || continue
    case "$rel" in etc/nginx/*|etc/systemd/system/obsidian-*) rm -f "$ROOT/$rel"; echo "removed $rel";; *) echo "skipped unexpected path in added.list: $rel" >&2;; esac
  done < "$BK/added.list"
fi
# 2. Put back what it overwrote or disabled (tar -x never deletes; it restores).
tar -C "$ROOT" -xpf "$BK/nginx.tar"
[ -f "$BK/etc-obsidian.tar" ] && tar -C "$ROOT" -xpf "$BK/etc-obsidian.tar"
for p in "$BK"/*.service.previous; do
  [ -e "$p" ] || continue
  b="$(basename "$p" .previous)"; install -m 0644 "$p" "$ROOT/etc/systemd/system/$b"; echo "restored unit $b"
done
echo "restored from $BK"
# 3. The restored config must itself pass.
if [ "$CHECK" = 1 ]; then "$NGINX_BIN" ${ROOT:+-p "$ROOT/etc/nginx/" -c "$ROOT/etc/nginx/nginx.conf"} -t; fi
if [ -z "$ROOT" ]; then
  systemctl daemon-reload
  if [ "$RELOAD" = 1 ]; then systemctl reload nginx; echo "nginx reloaded"; else echo "nginx NOT reloaded: systemctl reload nginx"; fi
fi
