#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Fresh-machine test: do what docs/LAUNCH-GUIDE.md tells a stranger to do, from nothing,
# using only the release archives, and check every claim the guides make about them.
#
#   bash scripts/fresh-machine-test.sh                 # clone THIS checkout (file://), then follow the guide
#   bash scripts/fresh-machine-test.sh <clone-url>     # e.g. the GitHub URL: test what a user would download
#
# What it does: clones the branch, verifies SHA256SUMS, unpacks the operator and self-host
# archives into one directory, installs the node's runtime packages, then starts ALL FOUR
# networks on their default ports with the helper script and checks that each is itself
# (network id, chain id, genesis id, params hash), that the interfaces serve the right network
# and all nine sites, that the Genesis Invitation works exactly once, that a second node
# joins, that nodes and interfaces of different networks refuse each other (and say so), and
# that everything stops cleanly. About four minutes; prints a pass/fail line per claim.
#
# It binds the default ports of all four networks (8630/8631/8788, 18630/18631/18788,
# 28630/28631/28788, 38630/38631/38788) and 38640/38641, 38660/38661 and 28999, so stop
# any Obsidian node or interface first; it refuses to start if one answers.
#
# Optional: OBSIDIAN_DEVNET_INVITE_CODE_FILE=<file holding the devnet invitation CODE> also
# checks that the shipped devnet invitation opens the devnet interface exactly once. The code
# is never in this repository; keep the file outside it.
#
# Environment: OBSIDIAN_TEST_DIR (default $TMPDIR/obsidian-fresh-test; the name must end in
# obsidian-fresh-test, because the directory is deleted first), OBSIDIAN_TEST_BRANCH, and
# SRC_DIR (use a working tree's releases/ and scripts/ directly, before they are committed).
# ─────────────────────────────────────────────────────────────────────────────
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${OBSIDIAN_TEST_BRANCH:-$(git -C "$ROOT" branch --show-current 2>/dev/null || true)}"
BRANCH="${BRANCH:-arena/414b663a-obsidian-network}"
URL="${1:-file://$ROOT}"
VERSION="$(node -p "require('$ROOT/obsidian-core/package.json').version")"
FM="${OBSIDIAN_TEST_DIR:-${TMPDIR:-/tmp}/obsidian-fresh-test}"
DEVNET_CODE_FILE="${OBSIDIAN_DEVNET_INVITE_CODE_FILE:-}"
FAILS=0
PASSES=0
ok()   { PASSES=$((PASSES+1)); echo "  ok    $*"; }
bad()  { FAILS=$((FAILS+1));  echo "  FAIL  $*"; }
check() { # check <description> <command...>
  local d="$1"; shift
  if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
log()  { printf '\n== %s\n' "$*"; }
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],j);console.log(typeof v==='object'?JSON.stringify(v):v)}catch(e){console.log('')}})" "$1"; }
get()  { curl -s -m 8 "$1"; }
code() { curl -s -m 8 -o /dev/null -w '%{http_code}' "$@"; }

case "$FM" in
  *obsidian-fresh-test) rm -rf "$FM" ;;
  *) echo "refusing to delete $FM: OBSIDIAN_TEST_DIR must end in obsidian-fresh-test" >&2; exit 2 ;;
esac
mkdir -p "$FM/data"
for command in node git curl sha256sum tar setsid; do command -v "$command" >/dev/null 2>&1 || { echo "needs $command (Termux: pkg install util-linux)" >&2; exit 2; }; done
for port in 8630 18630 28630 38630 8788 18788 28788 38788; do
  if curl -s -m 1 -o /dev/null "http://127.0.0.1:$port/"; then echo "port $port already answers: stop the Obsidian node or interface that is using it, then run this again" >&2; exit 2; fi
done

log "1. download the delivered branch (guide step 4)"
if [ -n "${SRC_DIR:-}" ]; then
  # dry run: use the built archives straight from a working tree, before they are committed
  mkdir -p "$FM/src" && cp -r "$SRC_DIR/releases" "$SRC_DIR/scripts" "$FM/src/" && ok "using the working tree's releases/ ($SRC_DIR)"
else
  git clone -q --depth 1 --branch "$BRANCH" "$URL" "$FM/src" && ok "cloned $BRANCH" || { bad "clone"; exit 1; }
  ( cd "$FM/src" && git log -1 --format='   HEAD %h  %s' )
fi

log "2. verify the archives (guide step 5)"
cd "$FM/src/releases"
SUMS=$(sha256sum -c SHA256SUMS 2>&1)
echo "$SUMS" | sed 's/^/   /'
[ "$(echo "$SUMS" | grep -c ': OK$')" = "11" ] && ok "11 archives, all OK" || bad "expected 11 OK lines"
echo "$SUMS" | grep -q FAILED && bad "a checksum FAILED" || ok "no checksum failed"
grep -q "\"version\": \"$VERSION\"" MANIFEST.json && ok "MANIFEST.json says $VERSION" || bad "MANIFEST version"
MCOMMIT=$(node -p "require('./MANIFEST.json').commit")
echo "   manifest commit: $MCOMMIT"

log "3. unpack both archives into one directory (guide step 6) and install five libraries (step 7)"
mkdir -p "$FM/run"
tar xzf "obsidian-node-operator-$VERSION.tar.gz"      -C "$FM/run" && ok "operator archive unpacked"
tar xzf "obsidian-interface-selfhost-$VERSION.tar.gz" -C "$FM/run" && ok "self-host archive unpacked"
cd "$FM/run"
for f in obsidian-core/dist/index.js obsidian-interface/dist/server/main.js obsidian-network.sh new-genesis-invite.mjs landing/index.html wallet/index.html obsidian-core/deployment/systemd/obsidian-node@.service obsidian-interface/deployment/systemd/obsidian-interface@.service; do
  check "present: $f" test -f "$f"
done
( cd obsidian-core && npm ci --omit=dev --no-audit --no-fund >"$FM/npm.log" 2>&1 ) && ok "npm ci --omit=dev" || { bad "npm ci --omit=dev"; tail -5 "$FM/npm.log"; }
REAL=$(cd obsidian-core && find node_modules -name package.json -not -path "*/node_modules/*/node_modules/*" -not -path "*/esm/*" -not -path "*/lib/*" -not -path "*/src/*" | sed 's#node_modules/##; s#/package.json##' | sort | tr '\n' ' ')
echo "   installed packages: $REAL"
[ "$REAL" = "@noble/curves @noble/hashes @scure/base @scure/bip32 @scure/bip39 ws " ] && ok "exactly the six runtime packages, nothing else" || bad "unexpected packages installed"
check "no native binaries and no build tools (esbuild, rollup, vitest, typescript)" bash -c 'test "$(find obsidian-core/node_modules \( -name "*.node" -o -name esbuild -o -name rollup -o -name vitest -o -name tsc \) | wc -l)" = 0'
echo "   node_modules size: $(du -sh obsidian-core/node_modules | cut -f1)"
node obsidian-core/dist/index.js version | tee "$FM/version.json" | head -12 | sed 's/^/   /'
[ "$(jget core < "$FM/version.json")" = "$VERSION" ] && ok "node reports core $VERSION" || bad "core version"
bash obsidian-network.sh help | head -3 | sed 's/^/   /'

log "4. mainnet refuses a missing passphrase; no network, no command (the 'no default' promise)"
export OBSIDIAN_HOME="$FM/data"
unset OBSIDIAN_KEYSTORE_PASSPHRASE OBSIDIAN_KEYSTORE_PASSPHRASE_FILE OBSIDIAN_GENESIS_INVITE_HASH OBSIDIAN_NETWORK
OUT=$(bash obsidian-network.sh mainnet start 2>&1); echo "$OUT" | tail -2 | cut -c1-200 | sed 's/^/   /'
echo "$OUT" | grep -q "mainnet needs a passphrase YOU chose" && ok "helper: mainnet needs a chosen passphrase" || bad "mainnet passphrase refusal"
ls "$FM/data/mainnet/node/node-key.json" >/dev/null 2>&1 && bad "a mainnet key was created without a passphrase" || ok "no mainnet key was created"
check "node start without --network refuses"   bash -c "node obsidian-core/dist/index.js start 2>&1 | grep -q 'no network selected'"
check "wallet new without --network refuses"   bash -c "node obsidian-core/dist/index.js wallet new 2>&1 | grep -q 'no network selected'"
check "unknown network refused by the helper"  bash -c "bash obsidian-network.sh devnett start 2>&1 | grep -q 'unknown network'"

log "5. start all four networks on their default ports (guide sections 2-5)"
DEVNET_HASH='scrypt$32768$8$1$952b1429899a01aeb55b6e0a30430bc5$ef36a024ec45a8698b76e9b9678abe84a83f8ace7d8a05b73a1f50251409ca41'
export OBSIDIAN_GENESIS_INVITE_HASH="$DEVNET_HASH"
setsid bash obsidian-network.sh devnet start </dev/null >"$FM/devnet-start.log" 2>&1 && ok "devnet start" || { bad "devnet start"; tail -5 "$FM/devnet-start.log"; }
unset OBSIDIAN_GENESIS_INVITE_HASH
# testnet: mint its own invitation with the helper, then start
INV=$(bash obsidian-network.sh testnet invite 2>&1); echo "$INV" | grep -q "GENESIS INVITATION for testnet" && ok "testnet invite minted (code shown once)" || bad "testnet invite"
[ -s "$FM/data/testnet/genesis-invite.hash" ] && ok "testnet invitation HASH stored" || bad "testnet hash file"
grep -rq "OBS-GENESIS-" "$FM/data/testnet" 2>/dev/null && bad "a plaintext invitation CODE was stored on disk" || ok "no plaintext invitation code on disk"
setsid bash obsidian-network.sh testnet start </dev/null >"$FM/testnet-start.log" 2>&1 && ok "testnet start" || { bad "testnet start"; tail -5 "$FM/testnet-start.log"; }
setsid bash obsidian-network.sh staging start </dev/null >"$FM/staging-start.log" 2>&1 && ok "staging start" || { bad "staging start"; tail -5 "$FM/staging-start.log"; }
export OBSIDIAN_KEYSTORE_PASSPHRASE='a-fresh-machine-test-passphrase'
setsid bash obsidian-network.sh mainnet start </dev/null >"$FM/mainnet-start.log" 2>&1 && ok "mainnet start (passphrase chosen)" || { bad "mainnet start"; tail -5 "$FM/mainnet-start.log"; }
unset OBSIDIAN_KEYSTORE_PASSPHRASE
sleep 14

log "6. each network is itself, and nothing else"
declare -A CHAIN=( [mainnet]=7777 [testnet]=7778 [staging]=7779 [devnet]=7780 )
declare -A RPC=( [mainnet]=8630 [testnet]=18630 [staging]=28630 [devnet]=38630 )
declare -A UI=( [mainnet]=8788 [testnet]=18788 [staging]=28788 [devnet]=38788 )
declare -A GID=( [mainnet]=681d443596d5c58221c59b2add83882848abe470 [testnet]=31d49f2338b0e4fdc874a53770ea45d49d7b767e [staging]=e0173182e8e82fe08e683467d2e6d4c969de3d00 [devnet]=2b4c905feeb565c2c41f2eaabca248c8281aa845 )
for n in mainnet testnet staging devnet; do
  S=$(get "http://127.0.0.1:${RPC[$n]}/status")
  [ "$(echo "$S" | jget networkId)" = "obsidian-$n-1" ] && ok "$n: networkId obsidian-$n-1" || bad "$n: networkId ($(echo "$S" | jget networkId))"
  [ "$(echo "$S" | jget chainId)" = "${CHAIN[$n]}" ] && ok "$n: chainId ${CHAIN[$n]}" || bad "$n: chainId"
  [ "$(echo "$S" | jget genesisId)" = "${GID[$n]}" ] && ok "$n: genesisId matches the guide" || bad "$n: genesisId"
  [ "$(echo "$S" | jget paramsHash)" = "1f2fba9a918147b084e67bf6e0c76d89" ] && ok "$n: paramsHash 1f2fba9a…" || bad "$n: paramsHash"
  H=$(echo "$S" | jget height); [ "${H:-0}" -ge 1 ] 2>/dev/null && ok "$n: producing blocks (height $H)" || bad "$n: height ${H:-?}"
  D=$(get "http://127.0.0.1:${RPC[$n]}/network" | jget domains)
  if [ "$n" = mainnet ]; then
    echo "$D" | grep -q '"api.obsmainnet.us.ci"' && ! echo "$D" | grep -q "devnet.obsmainnet\|testnet.obsmainnet\|staging.obsmainnet" && ok "mainnet advertises its own domains and no other network's" || bad "mainnet domains ($D)"
  else
    echo "$D" | grep -q "\"$n.obsmainnet.us.ci\"" && ! echo "$D" | grep -q '"obsmainnet.us.ci"\|"api.obsmainnet.us.ci"' && ok "$n advertises $n.obsmainnet.us.ci only" || bad "$n advertises $D"
  fi
  [ "$(get "http://127.0.0.1:${RPC[$n]}/supply" | jget invariantOk)" = "true" ] && ok "$n: supply invariant holds" || bad "$n: supply invariant"
  [ "$(get "http://127.0.0.1:${UI[$n]}/api/health" | jget healthyNodes)" = "1" ] && ok "$n: interface sees its node (port ${UI[$n]})" || bad "$n: interface health"
  [ "$(get "http://127.0.0.1:${UI[$n]}/api/nodes" | jget network)" = "$n" ] && ok "$n: interface serves $n" || bad "$n: interface network"
done
echo "   helper status, devnet:"; bash obsidian-network.sh devnet status | sed 's/^/     /'
A=$(get "http://127.0.0.1:38630/audit/compliance" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);const rows=Object.entries(a).filter(([k,v])=>v&&typeof v==='object'&&'present' in v);console.log(rows.length+' '+rows.filter(([k,v])=>v.present!==false).map(x=>x[0]).join(','))})")
[ "$A" = "17 revenueSplitEnforced" ] && ok "compliance: 17 rows, only revenueSplitEnforced is true" || bad "compliance rows: $A"
Q=$(get "http://127.0.0.1:38630/audit/decentralization" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const a=JSON.parse(s);console.log(a.questions.length+' '+a.questions.every(q=>q.answer==='NO')+' '+JSON.stringify(a.centralisedDependencies).includes('OAuth'))})")
[ "$Q" = "10 true false" ] && ok "decentralization: 10 questions all NO, no OAuth dependency" || bad "decentralization: $Q"

log "7. the interface (guide section 6): nine sites, headers, the proxy, the invitation"
BAD=0; for p in / /app/ /mine/ /wallet/ /explorer/ /ons/ /node/ /audit/ /developer/; do [ "$(code "http://127.0.0.1:38788$p")" = "200" ] || { BAD=$((BAD+1)); echo "   $p not 200"; }; done
[ "$BAD" = 0 ] && ok "all nine sites answer 200" || bad "$BAD site(s) not 200"
HDRS=$(curl -sI -m 8 http://127.0.0.1:38788/wallet/)
echo "$HDRS" | grep -qi "content-security-policy" && ok "CSP present" || bad "CSP missing"
echo "$HDRS" | grep -qi "x-frame-options: *deny" && ok "X-Frame-Options: DENY" || bad "X-Frame-Options"
check "wallet page links a content-hashed bundle" bash -c "curl -s http://127.0.0.1:38788/wallet/ | grep -qE 'src=\"/js/wallet.js\?v=[0-9a-f]{16}\"'"
[ "$(code 'http://127.0.0.1:38788/api/rpc?path=/tx/../metrics')" = "400" ] && ok "path traversal through the proxy refused (400)" || bad "proxy traversal"
[ "$(code -X POST http://127.0.0.1:38788/api/auth/reset)" = "404" ] && ok "no password-reset endpoint (404)" || bad "reset endpoint exists"
C0=$(get http://127.0.0.1:38788/api/auth/config); [ "$(echo "$C0" | jget genesisInvite.configured)" = "true" ] && [ "$(echo "$C0" | jget genesisInvite.redeemed)" = "false" ] && ok "devnet invitation configured, not yet redeemed" || bad "invitation state: $C0"
[ "$(echo "$C0" | jget accountsExist)" = "false" ] && ok "no accounts yet" || bad "accountsExist"
R0=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:38788/api/auth/register -H 'content-type: application/json' -d '{"email":"someone@example.com","password":"a-long-enough-pass-9","inviteCode":"X"}')
[ "$R0" = "400" ] && ok "non-Gmail address refused (400)" || bad "non-Gmail: $R0"
R1=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:38788/api/auth/register -H 'content-type: application/json' -d '{"email":"first.operator@gmail.com","password":"a-long-enough-pass-9","inviteCode":"OBS-GENESIS-AAAA-AAAA-AAAA-AAAA"}')
[ "$R1" = "403" ] && ok "wrong Genesis Invitation refused (403)" || bad "wrong code: $R1"
if [ -n "$DEVNET_CODE_FILE" ] && [ -s "$DEVNET_CODE_FILE" ]; then
  R2=$(curl -s -m 15 -X POST http://127.0.0.1:38788/api/auth/register -H 'content-type: application/json' -d "{\"email\":\"first.operator@gmail.com\",\"password\":\"a-long-enough-pass-9\",\"inviteCode\":\"$(cat "$DEVNET_CODE_FILE")\"}")
  [ "$(echo "$R2" | jget bootstrapped)" = "true" ] && ok "the shipped devnet invitation opens the devnet interface (bootstrapped:true)" || bad "devnet invitation: $(echo "$R2" | cut -c1-150)"
  [ "$(echo "$R2" | jget recoveryCodes | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s||'[]').length))")" = "10" ] && ok "ten recovery codes issued" || bad "recovery codes"
  R3=$(curl -s -m 8 -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:38788/api/auth/register -H 'content-type: application/json' -d "{\"email\":\"second@gmail.com\",\"password\":\"a-long-enough-pass-9\",\"inviteCode\":\"$(cat "$DEVNET_CODE_FILE")\"}")
  [ "$R3" = "403" ] && ok "the same invitation a second time: refused (403)" || bad "invitation reuse: $R3"
  C1=$(get http://127.0.0.1:38788/api/auth/config); [ "$(echo "$C1" | jget genesisInvite.redeemed)" = "true" ] && ok "invitation now reports redeemed:true" || bad "redeemed flag"
else
  echo "   (OBSIDIAN_DEVNET_INVITE_CODE_FILE not set: skipping the redemption steps)"
fi
for n in testnet staging mainnet; do
  [ "$(get "http://127.0.0.1:${UI[$n]}/api/auth/config" | jget genesisInvite.redeemed)" = "false" ] && ok "$n: its own invitation is untouched by the devnet one" || bad "$n invitation state"
done
[ "$(get http://127.0.0.1:18788/api/auth/config | jget genesisInvite.configured)" = "true" ] && ok "testnet: configured from the helper's invite command" || bad "testnet invitation not configured"
[ "$(get http://127.0.0.1:28788/api/auth/config | jget genesisInvite.configured)" = "false" ] && ok "staging: none configured, so nobody can register" || bad "staging invitation"

log "8. a second devnet node, from the guide's own command"
export OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters'
( cd obsidian-core && exec setsid nohup node dist/index.js start --network devnet --data-dir "$FM/data/devnet/node2" --rpc-port 38640 --p2p-port 38641 --seeds 127.0.0.1:38631 </dev/null >"$FM/node2.log" 2>&1 ) &
echo $! > "$FM/node2.pid"
unset OBSIDIAN_KEYSTORE_PASSPHRASE
sleep 24
S1=$(get http://127.0.0.1:38630/status); S2=$(get http://127.0.0.1:38640/status)
echo "   node 1: height $(echo "$S1" | jget height) peers $(echo "$S1" | jget peers) head $(echo "$S1" | jget headHash | cut -c1-12)"
echo "   node 2: height $(echo "$S2" | jget height) peers $(echo "$S2" | jget peers) head $(echo "$S2" | jget headHash | cut -c1-12)"
[ "$(echo "$S1" | jget peers)" = "1" ] && [ "$(echo "$S2" | jget peers)" = "1" ] && ok "each sees one peer" || bad "peers"
D1=$(echo "$S1" | jget height); D2=$(echo "$S2" | jget height); [ $((D1 > D2 ? D1 - D2 : D2 - D1)) -le 2 ] && ok "heights agree (within a block in flight)" || bad "heights diverge"
kill "$(cat "$FM/node2.pid")" 2>/dev/null; sleep 2

log "9. networks refuse each other"
export OBSIDIAN_KEYSTORE_PASSPHRASE='choose-a-passphrase-of-12-or-more-characters'
( cd obsidian-core && exec setsid nohup node dist/index.js start --network devnet --data-dir "$FM/data/devnet/node3" --rpc-port 38660 --p2p-port 38661 --seeds 127.0.0.1:8631 </dev/null >"$FM/node3.log" 2>&1 ) &
echo $! > "$FM/node3.pid"
unset OBSIDIAN_KEYSTORE_PASSPHRASE
sleep 30
[ "$(get http://127.0.0.1:38660/status | jget peers)" = "0" ] && ok "a devnet node told mainnet's P2P port peers with nobody" || bad "cross-network peering?"
WARNS=$(grep -c '"level":"warn".*another network or version' "$FM/node3.log" 2>/dev/null)
[ "${WARNS:-0}" = "1" ] && ok "the dialling node logged ONE warning that the seed is on another network" || bad "expected exactly one 'another network or version' warning, saw ${WARNS:-0}"
grep -q 'ERR_WRONG_NETWORK' "$FM/node3.log" && ok "...carrying the code ERR_WRONG_NETWORK" || bad "warning lacks ERR_WRONG_NETWORK"
grep '"level":"warn".*another network or version' "$FM/node3.log" | head -1 | cut -c1-420 | sed 's/^/     /'
grep -q "another network or version" "$FM/data/mainnet/logs/node.log" 2>/dev/null && bad "the dialled mainnet node warned about an inbound stranger (should be quiet)" || ok "the mainnet node, dialled by a stranger, stayed quiet"
[ "$(get http://127.0.0.1:8630/status | jget peers)" = "0" ] && ok "the mainnet node has no peers (nothing crossed over)" || bad "mainnet got a peer"
kill "$(cat "$FM/node3.pid")" 2>/dev/null
( cd obsidian-interface && exec setsid nohup node dist/server/main.js --network testnet --port 28999 --nodes http://127.0.0.1:38630 --data-dir "$FM/data/wrongui" </dev/null >"$FM/wrongui.log" 2>&1 ) &
echo $! > "$FM/wrongui.pid"
sleep 4
WN=$(get http://127.0.0.1:28999/api/nodes)
echo "$WN" | jget nodes | grep -qi "wrong network" && ok "an interface for testnet marks a devnet node 'wrong network'" || bad "wrong-network node not marked: $(echo "$WN" | cut -c1-200)"
WR=$(curl -s -m 8 -w ' [%{http_code}]' "http://127.0.0.1:28999/api/rpc?path=/status"); echo "$WR" | grep -q "ERR_WRONG_NETWORK" && echo "$WR" | grep -q "\[503\]" && ok "...and answers 503 ERR_WRONG_NETWORK instead of showing the wrong chain" || bad "wrong-network answer: $WR"
kill "$(cat "$FM/wrongui.pid")" 2>/dev/null
check "an interface with conflicting network settings refuses to start" bash -c "cd $FM/run/obsidian-interface && OBSIDIAN_INTERFACE_NETWORK=mainnet timeout 6 node dist/server/main.js --network devnet --port 28998 2>&1 | grep -q 'conflicting networks'"

log "10. resource use (capacity note)"
for n in mainnet testnet staging devnet; do
  NP=$(cat "$FM/data/$n/node.pid" 2>/dev/null); UP=$(cat "$FM/data/$n/interface.pid" 2>/dev/null)
  echo "   $n: node RSS $(ps -o rss= -p "$NP" 2>/dev/null | awk '{printf "%.0f MB", $1/1024}')   interface RSS $(ps -o rss= -p "$UP" 2>/dev/null | awk '{printf "%.0f MB", $1/1024}')"
done
echo "   disk used by all four data directories: $(du -sh "$FM/data" | cut -f1)"

log "11. stop everything with the helper; nothing may be left running"
for n in devnet testnet staging mainnet; do bash obsidian-network.sh "$n" stop 2>&1 | sed 's/^/   /'; done
sleep 2
LEFT=$(ps -eo pid,args | grep -E "node (dist/index.js|dist/server/main.js)" | grep -v grep | grep "$FM" || true)
[ -z "$LEFT" ] && ok "no node or interface left running" || { bad "left running:"; echo "$LEFT"; }

log "12. the verifier, on a real archive"
cd "$FM/src"
VOUT=$(./scripts/verify-release.sh "releases/obsidian-node-operator-$VERSION.tar.gz" 2>&1); echo "$VOUT" | tail -6 | sed 's/^/   /'
echo "$VOUT" | grep -q "verified" && ok "verify-release.sh passes on the operator archive" || bad "verify-release.sh"
echo "$VOUT" | grep -qi "UNSIGNED" && ok "…and says plainly that the release is unsigned" || bad "no UNSIGNED notice"

echo
echo "================ $PASSES checks passed, $FAILS failed ================"
echo "(logs and data: $FM)"
exit $((FAILS > 0))
