#!/usr/bin/env bash
# Install the three Nginx vhosts and the two systemd unit templates, after backing up what is there.
#
#   sudo bash install.sh                 # install + `nginx -t`; does NOT reload nginx, does NOT touch any service
#   sudo bash install.sh --reload        # ... and reload nginx if (and only if) `nginx -t` passed
#   sudo bash install.sh --disable-conflicts   # also take an OLD vhost out of sites-enabled if it claims one of the
#                                              # three hostnames (reversible: rollback.sh puts it back)
#
# What it never does: start, stop or restart a service; touch chain data, wallets, keystores or genesis; delete a
# file it did not create. Anything it overwrites or disables is in the backup first. If `nginx -t` fails, it
# restores the backup by itself and exits 1.
#
# Ports are read from the services' env files (OBSIDIAN_INTERFACE_PORT in interface.env, APP_PORT in app-web.env and
# wallet-web.env) and written into conf.d/obsidian-web.conf, so a replaced port is changed in ONE place per service.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${OBS_ROOT:-}"                       # a prefix for testing against a scratch tree; empty on a real server
NETWORK="${OBS_NETWORK:-mainnet}"
ROOT_DOMAIN="${DOMAIN_ROOT:-obsmainnet.us.ci}"
NGINX_BIN="${NGINX_BIN:-nginx}"
DOMAINS=("$ROOT_DOMAIN" "app.$ROOT_DOMAIN" "wallet.$ROOT_DOMAIN")
NGINX_DIR="$ROOT/etc/nginx"; UNIT_DIR="$ROOT/etc/systemd/system"; OBS_ETC="$ROOT/etc/obsidian"; LIVE="$ROOT/etc/letsencrypt/live"

RELOAD=0; DISABLE=0
for a in "$@"; do case "$a" in
  --reload) RELOAD=1;; --disable-conflicts) DISABLE=1;;
  -h|--help) sed -n 2,17p "${BASH_SOURCE[0]}"; exit 0;;
  *) echo "unknown option: $a" >&2; exit 2;; esac; done

say() { printf '%s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -z "$ROOT" ] && [ "$(id -u)" -ne 0 ] && die "run as root (sudo)"
command -v "$NGINX_BIN" >/dev/null || die "nginx not found (set NGINX_BIN or install nginx)"
[ -d "$NGINX_DIR" ] || die "$NGINX_DIR not found"

# 1. Certificates must already exist, or the 443 blocks cannot load.
for d in "${DOMAINS[@]}"; do
  for f in fullchain.pem privkey.pem; do
    [ -e "$LIVE/$d/$f" ] || die "no certificate file $LIVE/$d/$f. Issue it first: certbot certonly --webroot -w /var/www/html -d $d"
  done
done

# 2. Ports, from the env files (or the defaults the repo documents).
env_value() { [ -f "$1" ] && sed -nE "s/^[[:space:]]*$2=([0-9]+)[[:space:]]*(#.*)?$/\1/p" "$1" | tail -n 1 || true; }
P_PLATFORM="$(env_value "$OBS_ETC/$NETWORK/interface.env" OBSIDIAN_INTERFACE_PORT)"; P_PLATFORM="${P_PLATFORM:-8789}"
P_APP="$(env_value "$OBS_ETC/$NETWORK/app-web.env" APP_PORT)"; P_APP="${P_APP:-8790}"
P_WALLET="$(env_value "$OBS_ETC/$NETWORK/wallet-web.env" APP_PORT)"; P_WALLET="${P_WALLET:-8791}"
[ "$P_PLATFORM" != "$P_APP" ] && [ "$P_APP" != "$P_WALLET" ] && [ "$P_PLATFORM" != "$P_WALLET" ] || die "the three ports must differ (platform $P_PLATFORM, app $P_APP, wallet $P_WALLET)"
say "ports: platform $P_PLATFORM, app $P_APP, wallet $P_WALLET"

# 3. Does an existing vhost already claim one of our hostnames? nginx honours the FIRST match in load order and
#    silently ignores the later one, so an old vhost can keep answering for a hostname the new one is meant to own.
conflicts=()
pattern="server_name[^;]*[[:space:]](${DOMAINS[0]//./\\.}|${DOMAINS[1]//./\\.}|${DOMAINS[2]//./\\.})[[:space:];]"
while IFS= read -r f; do
  case "$(basename "$f")" in obsidian-web.conf|"${DOMAINS[0]}.conf"|"${DOMAINS[1]}.conf"|"${DOMAINS[2]}.conf") continue;; esac
  if grep -Eq "$pattern" "$f" 2>/dev/null; then conflicts+=("$f"); fi
done < <(find "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" -maxdepth 1 \( -type f -o -type l \) -name '*' ! -name '*.disabled*' 2>/dev/null | sort)
if [ "${#conflicts[@]}" -gt 0 ]; then
  say "These enabled nginx files already claim one of the three hostnames:"; printf '  %s\n' "${conflicts[@]}"
  [ "$DISABLE" = 1 ] || die "refusing to continue: one of them would keep answering for a hostname. Re-run with --disable-conflicts to take them out of sites-enabled (reversible), or edit them yourself."
fi
if grep -rlE 'listen[^;]*default_server' "$NGINX_DIR/sites-enabled" "$NGINX_DIR/conf.d" 2>/dev/null | grep -v obsidian >/dev/null; then
  say "note: a default_server exists. It only answers hostnames no vhost names; the three vhosts name theirs, so they do not depend on it."
fi

# 4. Backup, BEFORE any change.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BK="$ROOT/var/backups/obsidian-web/$STAMP"; mkdir -p "$BK"; chmod 700 "$BK"
tar -C "$ROOT" -cpf "$BK/nginx.tar" etc/nginx
if [ -d "$OBS_ETC" ]; then tar -C "$ROOT" -cpf "$BK/etc-obsidian.tar" etc/obsidian; chmod 600 "$BK/etc-obsidian.tar"; fi
: > "$BK/added.list"
for u in obsidian-app-web@.service obsidian-wallet-web@.service; do
  if [ -f "$UNIT_DIR/$u" ]; then cp -p "$UNIT_DIR/$u" "$BK/$u.previous"; fi
done
say "backup: $BK"

restore() { say "restoring the backup"; bash "$HERE/scripts/rollback.sh" "$BK" --no-check || true; }
trap 'rc=$?; if [ $rc -ne 0 ]; then restore; fi' ERR

# 5. Install.
install_new() { # src dst
  [ -e "$2" ] || echo "${2#"$ROOT"/}" >> "$BK/added.list"
  mkdir -p "$(dirname "$2")"; install -m 0644 "$1" "$2"
}
install_new "$HERE/nginx/conf.d/obsidian-web.conf" "$NGINX_DIR/conf.d/obsidian-web.conf"
for s in obsidian-proxy.conf obsidian-tls.conf; do install_new "$HERE/nginx/snippets/$s" "$NGINX_DIR/snippets/$s"; done
mkdir -p "$NGINX_DIR/sites-enabled"
for d in "${DOMAINS[@]}"; do
  install_new "$HERE/nginx/sites-available/$d.conf" "$NGINX_DIR/sites-available/$d.conf"
  if [ ! -e "$NGINX_DIR/sites-enabled/$d.conf" ]; then ln -s "../sites-available/$d.conf" "$NGINX_DIR/sites-enabled/$d.conf"; echo "etc/nginx/sites-enabled/$d.conf" >> "$BK/added.list"; fi
done
# The ports, in the one file that names them.
UP="$NGINX_DIR/conf.d/obsidian-web.conf"
sed -i -E "s#^(upstream obsidian_platform \{ server 127\.0\.0\.1:)[0-9]+;#\1$P_PLATFORM;#; s#^(upstream obsidian_app +\{ server 127\.0\.0\.1:)[0-9]+;#\1$P_APP;#; s#^(upstream obsidian_wallet +\{ server 127\.0\.0\.1:)[0-9]+;#\1$P_WALLET;#" "$UP"
grep -q "obsidian_platform { server 127.0.0.1:$P_PLATFORM;" "$UP" && grep -q "obsidian_app      { server 127.0.0.1:$P_APP;" "$UP" && grep -q "obsidian_wallet   { server 127.0.0.1:$P_WALLET;" "$UP" || die "could not write the ports into $UP"
# Take conflicting vhosts out of load order (nothing is deleted).
for f in "${conflicts[@]:-}"; do
  [ -n "$f" ] || continue
  # A symlink is just removed; a real file moves into the backup directory (nginx loads EVERY file in sites-enabled, so
  # a renamed copy left there would still be loaded). rollback.sh restores both from nginx.tar.
  if [ -L "$f" ]; then rm "$f"; else mkdir -p "$BK/disabled"; mv "$f" "$BK/disabled/$(basename "$f")"; fi
  say "disabled (restorable from $BK): $f"
done
for u in obsidian-app-web@.service obsidian-wallet-web@.service; do install_new "$HERE/systemd/$u" "$UNIT_DIR/$u"; done

# 6. nginx must accept it, or nothing is left changed.
"$NGINX_BIN" ${ROOT:+-p "$ROOT/etc/nginx/" -c "$ROOT/etc/nginx/nginx.conf"} -t
trap - ERR
if [ -z "$ROOT" ]; then systemctl daemon-reload; fi
if [ "$RELOAD" = 1 ]; then
  if [ -z "$ROOT" ]; then systemctl reload nginx; say "nginx reloaded"; else say "(test tree: no reload)"; fi
else
  say "nginx NOT reloaded. When the three services answer on their ports (verify.sh local): systemctl reload nginx"
fi
say "installed. Rollback: sudo bash $HERE/scripts/rollback.sh $BK"
