#!/usr/bin/env bash
# Prove the three sites are three sites. Prints PASS/FAIL per check and exits 1 if any failed. It only reads.
#
#   bash verify.sh local     # the three internal listeners, on this machine (default)
#   bash verify.sh public    # the three public HTTPS hostnames (run it on the VPS or anywhere)
#   PUBLIC_IP=203.0.113.7 bash verify.sh public   # also proves the internal ports are closed from outside
#
# Page identity is read from the page's own <title>; nothing is assumed from the port or the hostname.
set -u
MODE="${1:-local}"
PLATFORM_PORT="${PLATFORM_PORT:-8789}"; APP_PORT="${APP_PORT:-8790}"; WALLET_PORT="${WALLET_PORT:-8791}"
DOMAIN_ROOT="${DOMAIN_ROOT:-obsmainnet.us.ci}"
fail=0
pass() { printf 'PASS  %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; fail=1; }
title_of() { grep -o '<title>[^<]*</title>' "$1" | head -n 1 | sed 's/<[^>]*>//g'; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# name | base URL | title must match (ERE) | title must NOT match (ERE)
check_site() {
  local name="$1" base="$2" want="$3" never="$4" code title
  code="$(curl -sS --max-time 10 -o "$TMP/$name.html" -w '%{http_code}' "$base/" 2>"$TMP/err")" || { bad "$name $base/ unreachable: $(head -c 200 "$TMP/err")"; return; }
  [ "$code" = 200 ] && pass "$name $base/ -> 200 (no redirect)" || { bad "$name $base/ -> $code (want 200)"; return; }
  title="$(title_of "$TMP/$name.html")"
  if printf '%s' "$title" | grep -Eq "$want"; then pass "$name serves its own page: \"$title\""; else bad "$name serves the wrong page: \"$title\" (want /$want/)"; fi
  if [ -n "$never" ] && printf '%s' "$title" | grep -Eq "$never"; then bad "$name serves a page it must never serve: \"$title\""; fi
  # Every root-relative asset the page asks for must come from THIS site, not another one.
  local missing=0 n=0 path
  while IFS= read -r path; do
    n=$((n + 1))
    c="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code}' "$base$path" 2>/dev/null)"
    [ "$c" = 200 ] || { bad "$name asset $path -> $c"; missing=1; }
  done < <(grep -oE '(src|href)="/[^"/][^"]*"' "$TMP/$name.html" | sed -E 's/^(src|href)="//; s/"$//' | sort -u)
  [ "$missing" = 0 ] && pass "$name: $n asset(s) referenced by the page all load from the same site"
  printf '%s' "$title" > "$TMP/$name.title"
}

PLATFORM_WANT='^Obsidian Network — a decentralised ledger'
PLATFORM_NEVER='Mine OBS'
APP_WANT='^Obsidian Network$'
WALLET_WANT='^Obsidian Wallet$'

if [ "$MODE" = local ]; then
  check_site platform "http://127.0.0.1:$PLATFORM_PORT" "$PLATFORM_WANT" "$PLATFORM_NEVER"
  check_site app      "http://127.0.0.1:$APP_PORT"      "$APP_WANT"      'Mine OBS|Wallet'
  check_site wallet   "http://127.0.0.1:$WALLET_PORT"   "$WALLET_WANT"   'Mine OBS'
  # The wallet host has no account API; the app host does (it answers 401 when signed out, not 404).
  c="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$WALLET_PORT/api/auth/me")"; [ "$c" = 404 ] && pass "wallet /api/auth/me -> 404 (not exposed)" || bad "wallet /api/auth/me -> $c (want 404)"
  c="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$APP_PORT/api/auth/me")"; [ "$c" = 401 ] && pass "app /api/auth/me -> 401 (platform reached, signed out)" || bad "app /api/auth/me -> $c (want 401)"
  # Loopback only.
  if command -v ss >/dev/null; then
    for p in "$PLATFORM_PORT" "$APP_PORT" "$WALLET_PORT"; do
      l="$(ss -ltnH "sport = :$p" 2>/dev/null)"
      if printf '%s' "$l" | grep -Eq '(0\.0\.0\.0|\*|\[::\]):'"$p"; then bad "port $p listens on all addresses: $l"
      elif printf '%s' "$l" | grep -q "127.0.0.1:$p"; then pass "port $p listens on 127.0.0.1 only"
      else bad "port $p is not listening"; fi
    done
  fi
elif [ "$MODE" = public ]; then
  check_site platform "https://$DOMAIN_ROOT"        "$PLATFORM_WANT" "$PLATFORM_NEVER"
  check_site app      "https://app.$DOMAIN_ROOT"    "$APP_WANT"      'Mine OBS|Wallet'
  check_site wallet   "https://wallet.$DOMAIN_ROOT" "$WALLET_WANT"   'Mine OBS'
  for h in "$DOMAIN_ROOT" "app.$DOMAIN_ROOT" "wallet.$DOMAIN_ROOT"; do
    r="$(curl -sS --max-time 10 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$h/" 2>/dev/null)"
    [ "$r" = "301 https://$h/" ] && pass "http://$h/ -> 301 https://$h/" || bad "http://$h/ -> \"$r\" (want 301 https://$h/)"
    if command -v openssl >/dev/null; then
      end="$(echo | openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null | openssl x509 -noout -enddate -subject 2>/dev/null | tr '\n' ' ')"
      [ -n "$end" ] && pass "$h certificate: $end" || bad "$h no certificate could be read"
    fi
  done
  [ "$(cat "$TMP/platform.title" "$TMP/app.title" "$TMP/wallet.title" 2>/dev/null | sort -u | wc -l)" = 3 ] && pass "the three hostnames serve three different pages" || bad "two hostnames serve the same page"
  if [ -n "${PUBLIC_IP:-}" ]; then
    for p in "$PLATFORM_PORT" "$APP_PORT" "$WALLET_PORT"; do
      if curl -s --max-time 4 -o /dev/null "http://$PUBLIC_IP:$p/"; then bad "internal port $p answers on $PUBLIC_IP (it must be closed)"; else pass "internal port $p is closed on $PUBLIC_IP"; fi
    done
  else
    echo "SKIP  internal-port exposure check (set PUBLIC_IP=<the server's public address> and run it from OUTSIDE the server)"
  fi
else
  echo "usage: verify.sh [local|public]"; exit 2
fi
[ "$fail" = 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$fail"
