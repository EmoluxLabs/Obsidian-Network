#!/usr/bin/env bash
# End-to-end test: app -> proxy -> a real running Obsidian platform.
#
# This is the test that proves the wiring, as opposed to the unit suite that proves
# the pieces. It needs a live obsidian-interface; point OBSIDIAN_PLATFORM_URL at
# one and APP_URL at the running app.
#
# Every assertion is about the app refusing to invent something. A proxy that turned
# a dead platform into an empty 200 would pass a "does it respond" test and fail all
# of these.
set -uo pipefail
APP="${APP_URL:?set APP_URL to the running app, e.g. http://127.0.0.1:8799}"
fail=0

# Pattern matching, not `grep -q` in a pipeline. The shell is a quarter of a
# megabyte and `set -o pipefail` is on: `grep -q` exits the moment it matches,
# which kills the feeding `printf` with SIGPIPE and makes the pipeline return 141
# for a check that actually passed. Whether that happens depends on how fast the
# write drains, so the old version failed intermittently. `case` has no race.
check() { # name, expected-substring, actual
  if case "$3" in *"$2"*) true;; *) false;; esac
  then echo "  PASS  $1"
  else echo "  FAIL  $1"; echo "        wanted: $2"; echo "        got: ${3:0:400}"; fail=1
  fi
}

# Something the operator has to provide before this assertion means anything.
note() { echo "  NOTE  $1"; }

echo "app: $APP"

# ── the app's own surface ────────────────────────────────────────────────────
healthz=$(curl -s "$APP/healthz")
check "the app reports its own health" '"ok":true' "$healthz"
check "the app names the platform it is pointed at" '"platform"' "$healthz"

shell=$(curl -s "$APP/")
check "the shell is served" 'OBSIDIAN NETWORK' "$shell"
check "the real module is loaded, not the demo script alone" 'src="/real.mjs"' "$shell"
check "the design file is served unmodified" '<div id="app">' "$shell"

for module in real.mjs data.mjs screens.mjs wallet.mjs notify.mjs; do
  type=$(curl -s -o /dev/null -w '%{content_type}' "$APP/$module")
  check "$module is served as a module" 'javascript' "$type"
done

bundle=$(curl -s -o /dev/null -w '%{http_code}' "$APP/js/obsidian.js")
if [ "$bundle" = "200" ]; then
  echo "  PASS  the signing bundle is present"
else
  note "public/js/obsidian.js is missing (HTTP $bundle) — run: npm run build:web"
fi

# ── through the proxy, to the platform ───────────────────────────────────────
cfg=$(curl -s "$APP/api/auth/config")
check "proxy reaches the platform" '"inviteOnly":true' "$cfg"
check "server publishes its own minimums" '"passwordMinLength"' "$cfg"
check "the account model is stated" 'GMAIL_PASSWORD_MFA' "$cfg"

me=$(curl -s -w ' [%{http_code}]' "$APP/api/auth/me")
check "no session is a 401, not a fabricated account" '401' "$me"
check "the platform's own reason is passed through" 'ERR_UNAUTHORIZED' "$me"

reg=$(curl -s -X POST "$APP/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email","password":"short","inviteCode":"OBS-FAKE-CODE"}')
check "a bad registration is refused by the server" 'ERR_' "$reg"

# A POST body has to survive the proxy: it is how a signed transaction is
# submitted, and a body that arrived empty still answers 200.
post=$(curl -s -X POST "$APP/api/rpc?path=%2Ftx%2Fsubmit" -H 'Content-Type: application/json' \
  -d '{"tx":"nothex"}')
check "a submission with no real bytes is refused" 'ERR_' "$post"

status=$(curl -s "$APP/api/rpc?path=%2Fstatus")
if case "$status" in *'"height"'*) true;; *) false;; esac; then
  echo "  PASS  chain reads go through the path proxy"
elif case "$status" in *ERR_NO_HEALTHY_NODE*|*ERR_NO_NODES*|*ERR_WRONG_NETWORK*) true;; *) false;; esac; then
  # The wiring is proven: the platform answered, and it answered truthfully about
  # having no node behind it. Point --nodes at a running obsidian-core to exercise
  # the data path.
  note "chain reads reach the platform, which reports no healthy node: $status"
else
  echo "  FAIL  chain reads go through the path proxy"; echo "        got: $status"; fail=1
fi

# ── the one that matters most ────────────────────────────────────────────────
# A dead platform must be loud, never a plausible empty.
DEAD_PORT="${DEAD_PORT:-8798}"
OBSIDIAN_PLATFORM_URL=http://127.0.0.1:1 APP_PORT="$DEAD_PORT" \
  node "$(dirname "$0")/../server/main.mjs" >/dev/null 2>&1 &
dead_pid=$!
sleep 2
dead=$(curl -s -w ' [%{http_code}]' "http://127.0.0.1:$DEAD_PORT/api/health")
kill "$dead_pid" 2>/dev/null
wait "$dead_pid" 2>/dev/null
check "unreachable platform is a 502, never an empty 200" 'ERR_PLATFORM_UNREACHABLE' "$dead"

echo
if [ $fail -eq 0 ]; then echo "integration: all checks passed"; else echo "integration: FAILURES"; fi
exit $fail
