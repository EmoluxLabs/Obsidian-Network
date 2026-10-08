#!/usr/bin/env bash
# End-to-end test: app -> proxy -> a real running Obsidian platform.
#
# This is the test that proves the wiring, as opposed to the syntax checks that prove
# the files parse. It needs a live obsidian-interface; point OBSIDIAN_PLATFORM_URL at
# one and APP_URL at the running app.
#
# Every assertion is about the app refusing to invent something. A proxy that turned a
# dead platform into an empty 200 would pass a "does it respond" test and fail all of
# these.
set -uo pipefail
APP="${APP_URL:?set APP_URL to the running app, e.g. http://127.0.0.1:8799}"
fail=0

check() { # name, expected-substring, actual
  if printf '%s' "$3" | grep -q "$2"; then echo "  PASS  $1"; else echo "  FAIL  $1"; echo "        got: $3"; fail=1; fi
}

cfg=$(curl -s "$APP/api/auth/config")
check "proxy reaches the platform" '"inviteOnly":true' "$cfg"
check "server publishes its own minimums" '"passwordMinLength"' "$cfg"

me=$(curl -s -w ' [%{http_code}]' "$APP/api/auth/me")
check "no session is a 401, not a fabricated account" '401' "$me"
check "the platform's own reason is passed through" 'ERR_UNAUTHORIZED' "$me"

reg=$(curl -s -X POST "$APP/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email","password":"short","inviteCode":"OBS-FAKE-CODE"}')
check "a bad registration is refused by the server" 'ERR_' "$reg"

health=$(curl -s "$APP/api/health")
check "chain data comes from the platform" '"status"' "$health"

# The one that matters most: a dead platform must be loud, never a plausible empty.
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
