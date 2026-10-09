#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Run ONE Obsidian network on this machine: its node and its interface.
#
#   obsidian-network.sh <network> <command>
#
#   network   devnet | testnet | staging | mainnet
#   command   start     start the node, then the interface, and wait until both answer
#             stop      stop them (node and interface of THIS network only)
#             restart   stop, then start
#             status    what is running, on which ports, at what height
#             logs      follow the logs  (logs [node|interface])
#             wallet    create a wallet for THIS network (printed once, stored nowhere)
#             invite    mint a Genesis Invitation for this network's interface
#             reset     delete THIS network's chain and accounts (never mainnet)
#             doctor    check this machine and this network, and say what to fix
#
# Every network has its own ports, its own data directory and its own passphrase
# file, so running devnet next to testnet cannot mix them, and `stop` on one
# never touches another:
#
#   network   node RPC   node P2P   interface    data
#   mainnet   8630       8631       8788         $OBSIDIAN_HOME/mainnet/
#   testnet   18630      18631      18788        $OBSIDIAN_HOME/testnet/
#   staging   28630      28631      28788        $OBSIDIAN_HOME/staging/
#   devnet    38630      38631      38788        $OBSIDIAN_HOME/devnet/
#
# This script only wraps the real commands (printed as it runs them); it adds no
# behaviour of its own that the node or interface does not already have.
#
# Environment (all optional)
#   OBSIDIAN_HOME                  data root                       (default ~/obsidian-data)
#   OBSIDIAN_CORE_DIR              the built obsidian-core         (found next to this script)
#   OBSIDIAN_INTERFACE_DIR         the built obsidian-interface    (found next to this script)
#   OBSIDIAN_KEYSTORE_PASSPHRASE   the node key passphrase (>= 12 characters)
#   OBSIDIAN_KEYSTORE_PASSPHRASE_FILE  …or a file holding it
#   OBSIDIAN_SEED_NODES            host:port,host:port             peers to dial
#   OBSIDIAN_GENESIS_INVITE_HASH   the HASH of the Genesis Invitation (never the code)
#   OBSIDIAN_PORT_OFFSET           add N to every port above (run a second copy)
#   OBSIDIAN_NO_MINE=1             follow and validate only
#   OBSIDIAN_NODE_ONLY=1           do not start the interface
#   OBSIDIAN_MINING_GATE_PUBLIC_KEYS  the mining gate issuer public key(s) of this network (protocol 1.7.0); every
#                                  node of one network needs the same list. Made for you on devnet/staging/testnet.
#   OBSIDIAN_GATE_KEYSTORE (+ _PASSPHRASE_FILE)  the ENCRYPTED issuer key, for the interface (mainnet: yours)
#   OBSIDIAN_NO_GATE_KEY=1         do not make a gate key on a test network (mining stays closed)
#   OBSIDIAN_START_TIMEOUT         seconds to wait for the node (default 180; the interface gets two thirds)
#
# What your shell still remembers must not decide which network you are starting. So:
#   - a variable you `export`ed for one network is never allowed to open another: devnet's invitation
#     hash is ignored on every other network, and OBSIDIAN_NETWORK / OBSIDIAN_INTERFACE_NETWORK are
#     ignored (this script names the network itself);
#   - a network's own files win over the shell: its invitation hash (written by `invite`) and, where
#     this script made one, the passphrase file for its key;
#   - set variables for ONE command instead of exporting them:
#         OBSIDIAN_SEED_NODES='203.0.113.10:8631' bash obsidian-network.sh mainnet start
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "obsidian-network: $*" >&2; exit 1; }
say() { echo "obsidian-network: $*"; }

usage() { sed -n '2,/^# ──/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

NETWORK="${1:-}"
case "$NETWORK" in
  mainnet) RPC=8630;  P2P=8631;  UI=8788  ;;
  testnet) RPC=18630; P2P=18631; UI=18788 ;;
  staging) RPC=28630; P2P=28631; UI=28788 ;;
  devnet)  RPC=38630; P2P=38631; UI=38788 ;;
  ''|-h|--help|help) usage; exit 0 ;;
  *) die "unknown network \"$NETWORK\" — use devnet, testnet, staging or mainnet (there is no default)" ;;
esac
COMMAND="${2:-}"
[ -n "$COMMAND" ] || { usage; exit 1; }
shift 2

OFFSET="${OBSIDIAN_PORT_OFFSET:-0}"
[[ "$OFFSET" =~ ^[0-9]+$ ]] || die "OBSIDIAN_PORT_OFFSET must be a whole number"
RPC=$((RPC + OFFSET)); P2P=$((P2P + OFFSET)); UI=$((UI + OFFSET))

START_TIMEOUT="${OBSIDIAN_START_TIMEOUT:-180}"
{ [[ "$START_TIMEOUT" =~ ^[0-9]+$ ]] && [ "$START_TIMEOUT" -ge 10 ]; } || die "OBSIDIAN_START_TIMEOUT must be a whole number of seconds, at least 10"

# The disposable devnet Genesis Invitation that ships with every release. This is only its HASH, which is
# public (it is printed in the guides); the CODE that opens it is given to the person running devnet
# separately and is not in this repository. Devnet only: another network never uses it.
DEVNET_SHIPPED_INVITE_HASH='scrypt$32768$8$1$952b1429899a01aeb55b6e0a30430bc5$ef36a024ec45a8698b76e9b9678abe84a83f8ace7d8a05b73a1f50251409ca41'

# This script names the network itself, so a network named by the shell is never allowed to compete. (The
# node and the interface refuse to start when the two disagree, which is right for a node started by hand
# and a trap for this script: one OBSIDIAN_NETWORK left over from an earlier session, and every other
# network refuses to start.)
IGNORED_IDENTITY=""
for identity in OBSIDIAN_NETWORK OBSIDIAN_INTERFACE_NETWORK; do
  leftover="${!identity:-}"
  if [ -n "$leftover" ]; then
    if [ "$leftover" != "$NETWORK" ]; then
      echo "obsidian-network: ignoring $identity=$leftover from your shell: this command is for $NETWORK"
      IGNORED_IDENTITY="$IGNORED_IDENTITY$identity=$leftover "
    fi
    unset "$identity"
  fi
done

HOME_DIR="${OBSIDIAN_HOME:-$HOME/obsidian-data}/$NETWORK"
NODE_DATA="$HOME_DIR/node"
KEY_FILE="$NODE_DATA/node-key.json"
UI_DATA="$HOME_DIR/interface"
LOG_DIR="$HOME_DIR/logs"
NODE_PID="$HOME_DIR/node.pid"
UI_PID="$HOME_DIR/interface.pid"
PASS_FILE="$HOME_DIR/keystore.pass"
INVITE_FILE="$HOME_DIR/genesis-invite.hash"
GATE_DIR="$HOME_DIR/gate"
GATE_KEYSTORE_FILE="$GATE_DIR/mining-gate.keystore.json"
GATE_PASS_FILE="$GATE_DIR/gate.pass"

# ── where the built packages are ─────────────────────────────────────────────
locate() {  # locate <marker file> <dir>...
  local marker="$1"; shift
  for candidate in "$@"; do
    if [ -f "$candidate/$marker" ]; then (cd "$candidate" && pwd); return 0; fi
  done
  return 1
}
CORE_DIR="${OBSIDIAN_CORE_DIR:-$(locate dist/index.js "$SCRIPT_DIR/obsidian-core" "$SCRIPT_DIR/../obsidian-core" || true)}"
INTERFACE_DIR="${OBSIDIAN_INTERFACE_DIR:-$(locate dist/server/main.js "$SCRIPT_DIR/obsidian-interface" "$SCRIPT_DIR/../obsidian-interface" || true)}"

need_core() {
  [ -n "$CORE_DIR" ] && [ -f "$CORE_DIR/dist/index.js" ] ||
    die "cannot find a built obsidian-core (dist/index.js). Set OBSIDIAN_CORE_DIR, or build it: npm --prefix obsidian-core ci && npm --prefix obsidian-core run build"
  command -v node >/dev/null 2>&1 || die "node is not installed"
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 20 ] || die "Node.js 20.10 or newer is required (this is $(node -v))"
  [ -d "$CORE_DIR/node_modules/ws" ] ||
    die "obsidian-core has no dependencies installed. Run:  cd \"$CORE_DIR\" && npm ci --omit=dev"
}
need_interface() {
  [ -n "$INTERFACE_DIR" ] && [ -f "$INTERFACE_DIR/dist/server/main.js" ] ||
    die "cannot find a built obsidian-interface (dist/server/main.js). Set OBSIDIAN_INTERFACE_DIR, or build it: npm --prefix obsidian-interface ci && npm --prefix obsidian-interface run build"
}

# ── small helpers ────────────────────────────────────────────────────────────
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Answers when the URL returns 2xx. Uses node, which is always here, not curl.
http_ok() { node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" "$1"; }

# What the node and the interface say when they stop, as what a person should do about it.
explain_failure() {  # explain_failure <label>
  local log="$LOG_DIR/$1.log"
  [ -f "$log" ] || return 0
  if grep -qi "could not decrypt the node keystore" "$log"; then
    say "→ this node's key was made with a different passphrase than the one it was given. On a test network this script keeps the right one in $PASS_FILE; if you started this network by hand earlier, give the passphrase you used:  OBSIDIAN_KEYSTORE_PASSPHRASE='…' bash $0 $NETWORK start    (if nothing here is worth keeping:  $0 $NETWORK stop; $0 $NETWORK reset --yes)"
  fi
  if grep -qi "EADDRINUSE" "$log"; then
    say "→ another program is already using one of this network's ports ($RPC, $P2P, $UI). If it is a copy of this network started by hand, stop it. Otherwise move every port by 10:  OBSIDIAN_PORT_OFFSET=10 bash $0 $NETWORK start"
  fi
  if grep -qi "conflicting networks" "$log"; then
    say "→ a setting in your shell names a different network. Run  env | grep OBSIDIAN_  and  unset  what is wrong, then start again."
  fi
}

# `-nt` is "newer than": a process that was started before the files it runs were replaced is still running
# the OLD code, which is exactly what an upgrade that forgot to stop the network looks like.
note_if_stale() {  # note_if_stale <label> <pidfile> <installed file>
  if [ -f "$3" ] && [ -f "$2" ] && [ "$3" -nt "$2" ]; then
    say "note: this $1 was started BEFORE the build that is installed now, so it is still running the old code. Run:  $0 $NETWORK restart"
  fi
}

wait_for() {  # wait_for <label> <url> <pidfile> <seconds>
  local label="$1" url="$2" pidfile="$3" seconds="$4" i
  for ((i = 0; i < seconds; i++)); do
    http_ok "$url" && { say "$label is answering ($url)"; return 0; }
    alive "$pidfile" || { tail -n 15 "$LOG_DIR/${label}.log" >&2 2>/dev/null || true; explain_failure "$label"; die "$label stopped while starting — the log is above ($LOG_DIR/${label}.log)"; }
    if [ "$i" -gt 0 ] && [ $((i % 15)) -eq 0 ]; then say "$label is still starting… (${i}s of ${seconds}s) — a phone can take a minute"; fi
    sleep 1
  done
  die "$label did not answer within ${seconds}s, but it is still running (pid $(cat "$pidfile")). It may only be slow: wait a minute, then run  $0 $NETWORK status  or  $0 $NETWORK doctor,  or read $LOG_DIR/${label}.log"
}

# Which passphrase protects this network's key.
#   - A network this script manages has a passphrase file beside its data, made when the key was made. That
#     file wins over whatever is in the shell: a passphrase exported "by hand" for something else would
#     otherwise lock the node out of its own key.
#   - A key that exists without such a file was made by hand: only the passphrase it was made with opens it.
#   - Mainnet never gets a generated passphrase.
resolve_passphrase() {
  local given="${OBSIDIAN_KEYSTORE_PASSPHRASE:-}${OBSIDIAN_KEYSTORE_PASSPHRASE_FILE:-}"
  if [ -f "$PASS_FILE" ]; then
    [ -z "$given" ] || say "ignoring the passphrase in your shell: this $NETWORK node's key uses the one in $PASS_FILE"
    unset OBSIDIAN_KEYSTORE_PASSPHRASE
    export OBSIDIAN_KEYSTORE_PASSPHRASE_FILE="$PASS_FILE"
    return 0
  fi
  if [ -f "$KEY_FILE" ]; then
    # A key that exists without this script's passphrase file was made by hand: only the passphrase it was
    # made with opens it, so the one in the shell is the right thing to use.
    if [ -n "$given" ]; then return 0; fi
    die "this $NETWORK node already has a key ($KEY_FILE) and its passphrase is not stored here, so it was started by hand. Give the passphrase you used:  OBSIDIAN_KEYSTORE_PASSPHRASE='…' bash $0 $NETWORK start   (if nothing here is worth keeping:  $0 $NETWORK reset --yes)"
  fi
  if [ "$NETWORK" = "mainnet" ]; then
    [ -n "$given" ] && return 0
    die "mainnet needs a passphrase YOU chose, kept somewhere else. Set OBSIDIAN_KEYSTORE_PASSPHRASE (12+ characters), or put it in a 0600 file and set OBSIDIAN_KEYSTORE_PASSPHRASE_FILE. (A passphrase stored next to the key it protects protects nothing, so mainnet will not generate one.)"
  fi
  # A NEW key on a test network always gets its own generated passphrase. One left in the shell by another
  # network would otherwise protect this key too, and nobody would remember that it did.
  [ -z "$given" ] || say "ignoring the passphrase in your shell: a new $NETWORK key gets its own generated passphrase (a test network does not need one you chose)"
  unset OBSIDIAN_KEYSTORE_PASSPHRASE OBSIDIAN_KEYSTORE_PASSPHRASE_FILE
  mkdir -p "$HOME_DIR"
  ( umask 077; node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" > "$PASS_FILE" )
  export OBSIDIAN_KEYSTORE_PASSPHRASE_FILE="$PASS_FILE"
  say "generated a passphrase for this $NETWORK node at $PASS_FILE (fine for a test network)"
}

# The mining gate (protocol 1.7.0). The chain accepts a mining claim only with a certificate signed by an issuer key
# whose PUBLIC half is committed in genesis, so every node of one network must be given the same public key(s), and
# the interface holds the PRIVATE half, encrypted.
#   - OBSIDIAN_MINING_GATE_PUBLIC_KEYS in the shell is what a node on another machine is given. It wins on mainnet.
#   - On devnet/staging/testnet, when this script has made a key for the network, that key wins over the shell
#     (a value left over from another network must not decide this one), and a first start makes one.
#   - Mainnet never gets a generated key: the issuer key is the operators' power over who can mine, so they make it
#     (node scripts/generate-mining-gate-key.mjs) on a machine they trust and give it here. Without one a mainnet
#     node still runs, but no claim can be accepted, and the interface says mining is closed.
# Sets GATE_PUBLIC_KEYS (for the node) and GATE_ENV (for the interface).
resolve_gate() {
  GATE_PUBLIC_KEYS=""
  GATE_ENV=()
  if [ -f "$GATE_KEYSTORE_FILE" ]; then
    local mine; mine="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8')).publicKey||'')" "$GATE_KEYSTORE_FILE")"
    [ -n "$mine" ] || die "the mining gate keystore $GATE_KEYSTORE_FILE has no public key; move it aside and start again"
    if [ -n "${OBSIDIAN_MINING_GATE_PUBLIC_KEYS:-}" ] && [ "$OBSIDIAN_MINING_GATE_PUBLIC_KEYS" != "$mine" ]; then
      say "ignoring OBSIDIAN_MINING_GATE_PUBLIC_KEYS from your shell: this $NETWORK uses the gate key made for it ($GATE_KEYSTORE_FILE)"
    fi
    GATE_PUBLIC_KEYS="$mine"
    GATE_ENV=(OBSIDIAN_GATE_KEYSTORE="$GATE_KEYSTORE_FILE" OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE="$GATE_PASS_FILE")
    return 0
  fi
  if [ -n "${OBSIDIAN_MINING_GATE_PUBLIC_KEYS:-}" ]; then
    GATE_PUBLIC_KEYS="$OBSIDIAN_MINING_GATE_PUBLIC_KEYS"
  elif [ "$NETWORK" != "mainnet" ] && [ -z "${OBSIDIAN_NO_GATE_KEY:-}" ] && [ -d "$NODE_DATA/chain" ]; then
    # A chain that already exists was made under some gate list (possibly none). The list is part of the genesis id,
    # so a key made now would make this node refuse its own chain. Never do that behind someone's back.
    say "WARNING: this $NETWORK node already has a chain that was made without a gate key from this script, so none is made now"
    say "   (a different key list is a different chain), and mining stays closed. To use a gate: give the list the chain was"
    say "   made with (OBSIDIAN_MINING_GATE_PUBLIC_KEYS) and its keystore (OBSIDIAN_GATE_KEYSTORE), or start fresh:  $0 $NETWORK reset --yes"
  elif [ "$NETWORK" != "mainnet" ] && [ -z "${OBSIDIAN_NO_GATE_KEY:-}" ]; then
    need_core
    mkdir -p "$GATE_DIR"; chmod 700 "$GATE_DIR" 2>/dev/null || true
    ( umask 077; node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))" > "$GATE_PASS_FILE" )
    GATE_PUBLIC_KEYS="$(cd "$CORE_DIR" && node --input-type=module -e "
      import { generateKeyPair } from './dist/crypto/keys.js';
      import { Keystore } from './dist/crypto/keystore.js';
      import { readFileSync } from 'node:fs';
      const hrp = { testnet: 'tobs', staging: 'sobs', devnet: 'dobs' }[process.argv[1]];
      const pair = generateKeyPair(hrp);
      Keystore.write(process.argv[2], pair.privateKey, readFileSync(process.argv[3], 'utf8').trim());
      process.stdout.write(pair.publicKey);
    " "$NETWORK" "$GATE_KEYSTORE_FILE" "$GATE_PASS_FILE")"
    [ -n "$GATE_PUBLIC_KEYS" ] || die "could not make a mining gate key for $NETWORK"
    GATE_ENV=(OBSIDIAN_GATE_KEYSTORE="$GATE_KEYSTORE_FILE" OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE="$GATE_PASS_FILE")
    say "made a mining gate key for this $NETWORK (fine for a test network): $GATE_KEYSTORE_FILE"
    say "   its public key, which EVERY node of this $NETWORK must be given (OBSIDIAN_MINING_GATE_PUBLIC_KEYS): $GATE_PUBLIC_KEYS"
  else
    say "WARNING: no mining gate key for $NETWORK. The node runs, but NO mining claim can be accepted until the operators make one"
    say "   (node scripts/generate-mining-gate-key.mjs) and give the public key to every node (OBSIDIAN_MINING_GATE_PUBLIC_KEYS)"
    say "   and the encrypted key to the interface (OBSIDIAN_GATE_KEYSTORE + OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE)."
  fi
  # An interface in front of a node whose key was given by hand needs the matching private half from the operator.
  if [ -n "${OBSIDIAN_GATE_KEYSTORE:-}" ]; then
    GATE_ENV=(OBSIDIAN_GATE_KEYSTORE="$OBSIDIAN_GATE_KEYSTORE")
    [ -z "${OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE:-}" ] || GATE_ENV+=(OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE="$OBSIDIAN_GATE_KEYSTORE_PASSPHRASE_FILE")
    [ -z "${OBSIDIAN_GATE_KEYSTORE_PASSPHRASE:-}" ] || GATE_ENV+=(OBSIDIAN_GATE_KEYSTORE_PASSPHRASE="$OBSIDIAN_GATE_KEYSTORE_PASSPHRASE")
  fi
}

# Which Genesis Invitation hash the interface starts with, in this order:
#   1. this network's own file (written by `invite`);
#   2. a hash set for this command, if any;
#   3. devnet only: the disposable invitation that ships with the release.
# Devnet's hash is never accepted for another network, wherever it came from: leaving the devnet block's
# `export` in the shell used to make the testnet interface refuse the code its own `invite` had just printed.
INVITE_HASH=""
resolve_invite() {
  local given="${OBSIDIAN_GENESIS_INVITE_HASH:-}"
  INVITE_HASH=""
  if [ "$given" = "$DEVNET_SHIPPED_INVITE_HASH" ] && [ "$NETWORK" != "devnet" ]; then
    say "ignoring OBSIDIAN_GENESIS_INVITE_HASH from your shell: that is devnet's invitation, and $NETWORK has its own  ($0 $NETWORK invite)"
    given=""
  fi
  if [ -f "$INVITE_FILE" ]; then
    INVITE_HASH="$(cat "$INVITE_FILE")"
    if [ -n "$given" ] && [ "$given" != "$INVITE_HASH" ]; then
      say "ignoring OBSIDIAN_GENESIS_INVITE_HASH from your shell: this $NETWORK interface uses the invitation recorded in $INVITE_FILE"
    fi
  elif [ -n "$given" ]; then
    INVITE_HASH="$given"
  elif [ "$NETWORK" = "devnet" ]; then
    INVITE_HASH="$DEVNET_SHIPPED_INVITE_HASH"
    say "devnet: using the disposable Genesis Invitation that ships with this release (its code was given to you with the guide). To use one of your own instead:  $0 devnet invite  then  $0 devnet restart"
  fi
}

# Peers named in the shell apply to the network being started, so say which, and say so when one of them
# uses another network's usual port: the node refuses it, which is harmless but means a leftover export.
announce_seeds() {
  [ -n "${OBSIDIAN_SEED_NODES:-}" ] || return 0
  say "dialling the peers in OBSIDIAN_SEED_NODES: $OBSIDIAN_SEED_NODES"
  local seed port base name
  local -a seeds
  IFS=',' read -r -a seeds <<<"$OBSIDIAN_SEED_NODES"
  for seed in "${seeds[@]}"; do
    seed="${seed// /}"; port="${seed##*:}"
    [[ "$port" =~ ^[0-9]+$ ]] || continue
    # A seed's port is a number on someone else's machine, so it is compared as written; and, for a copy of
    # these networks run with OBSIDIAN_PORT_OFFSET on this machine, also with that offset taken off.
    base="$port"
    for base in "$port" "$((port - OFFSET))"; do
      for name in mainnet:8631 testnet:18631 staging:28631 devnet:38631; do
        if [ "$base" = "${name#*:}" ] && [ "${name%%:*}" != "$NETWORK" ]; then
          say "warning: $seed uses ${name%%:*}'s usual P2P port but this is $NETWORK; a node on another network refuses it. If that is a leftover from another network's commands, start with:  env -u OBSIDIAN_SEED_NODES bash $0 $NETWORK start"
          break 2
        fi
      done
    done
  done
}

# ── commands ─────────────────────────────────────────────────────────────────
cmd_start() {
  need_core
  mkdir -p "$NODE_DATA" "$LOG_DIR"
  chmod 700 "$HOME_DIR" 2>/dev/null || true
  resolve_gate

  if alive "$NODE_PID"; then
    say "$NETWORK node is already running (pid $(cat "$NODE_PID"))"
    note_if_stale node "$NODE_PID" "$CORE_DIR/dist/index.js"
  else
    resolve_passphrase
    export OBSIDIAN_MINING_GATE_PUBLIC_KEYS="$GATE_PUBLIC_KEYS"
    announce_seeds
    local args=(dist/index.js start --network "$NETWORK" --data-dir "$NODE_DATA" --rpc-port "$RPC" --p2p-port "$P2P")
    [ -z "${OBSIDIAN_NO_MINE:-}" ] || args+=(--no-mine)
    [ -z "${OBSIDIAN_SEED_NODES:-}" ] || args+=(--seeds "$OBSIDIAN_SEED_NODES")
    say "starting the $NETWORK node:  (cd $CORE_DIR && node ${args[*]})"
    # exec replaces the subshell, so $! really is node's pid.
    (cd "$CORE_DIR" && exec nohup node "${args[@]}" >>"$LOG_DIR/node.log" 2>&1) &
    echo $! > "$NODE_PID"
    wait_for node "http://127.0.0.1:$RPC/health" "$NODE_PID" "$START_TIMEOUT"
  fi

  [ -z "${OBSIDIAN_NODE_ONLY:-}" ] || { say "node only (OBSIDIAN_NODE_ONLY is set): no interface started"; return 0; }
  need_interface
  mkdir -p "$UI_DATA"
  if alive "$UI_PID"; then
    say "$NETWORK interface is already running (pid $(cat "$UI_PID"))"
    note_if_stale interface "$UI_PID" "$INTERFACE_DIR/dist/server/main.js"
  else
    resolve_invite
    local hash="$INVITE_HASH"
    local args=(dist/server/main.js --network "$NETWORK" --port "$UI" --nodes "http://127.0.0.1:$RPC" --data-dir "$UI_DATA")
    say "starting the $NETWORK interface:  (cd $INTERFACE_DIR && node ${args[*]})"
    (cd "$INTERFACE_DIR" && export OBSIDIAN_GENESIS_INVITE_HASH="$hash" && for kv in ${GATE_ENV[@]+"${GATE_ENV[@]}"}; do export "$kv"; done && exec nohup node "${args[@]}" >>"$LOG_DIR/interface.log" 2>&1) &
    echo $! > "$UI_PID"
    wait_for interface "http://127.0.0.1:$UI/api/health" "$UI_PID" $((START_TIMEOUT * 2 / 3))
    if [ -z "$hash" ]; then
      say "no Genesis Invitation is configured: nobody can create the first account yet. Run:  $0 $NETWORK invite   then   $0 $NETWORK restart"
    fi
  fi
  echo
  say "$NETWORK is up:"
  say "   open the interface:  http://127.0.0.1:$UI   (in a browser on this same device)"
  say "   node RPC (this device only):  http://127.0.0.1:$RPC/status"
  say "   logs:  $LOG_DIR/"
}

stop_one() {  # stop_one <label> <pidfile>
  local label="$1" pidfile="$2" i
  alive "$pidfile" || { rm -f "$pidfile"; say "$NETWORK $label is not running"; return 0; }
  local pid; pid="$(cat "$pidfile")"
  kill "$pid" 2>/dev/null || true
  for ((i = 0; i < 30; i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; say "$NETWORK $label did not stop in 30s and was killed"; else say "$NETWORK $label stopped"; fi
  rm -f "$pidfile"
}
cmd_stop() { stop_one interface "$UI_PID"; stop_one node "$NODE_PID"; }

cmd_status() {
  need_core
  echo "network   : $NETWORK   (data: $HOME_DIR)"
  for entry in "node:$NODE_PID:$RPC" "interface:$UI_PID:$UI"; do
    IFS=: read -r label pidfile port <<<"$entry"
    if alive "$pidfile"; then echo "$label : running, pid $(cat "$pidfile"), port $port"; else echo "$label : not running"; fi
  done
  note_if_stale node "$NODE_PID" "$CORE_DIR/dist/index.js"
  if [ -n "$INTERFACE_DIR" ]; then note_if_stale interface "$UI_PID" "$INTERFACE_DIR/dist/server/main.js"; fi
  if http_ok "http://127.0.0.1:$RPC/health"; then
    node -e "
      fetch('http://127.0.0.1:$RPC/status').then(r=>r.json()).then(s=>{
        console.log('chain     :', s.networkId, '(chain id', s.chainId + ', protocol', s.protocolVersion + ')');
        console.log('height    :', s.height, '   peers:', s.peers, '   syncing:', s.syncing);
        console.log('supply    :', s.supply === undefined ? '-' : s.supply, 'seals');
      }).catch(()=>{})"
  fi
  if http_ok "http://127.0.0.1:$UI/api/health"; then
    node -e "
      fetch('http://127.0.0.1:$UI/api/auth/config').then(r=>r.json()).then(c=>{
        console.log('interface :', 'http://127.0.0.1:$UI', ' accounts exist:', c.accountsExist, ' genesis invitation:', JSON.stringify(c.genesisInvite));
      }).catch(()=>{})"
  fi
}

cmd_logs() {
  local which="${1:-}"
  case "$which" in
    node) tail -n 60 -f "$LOG_DIR/node.log" ;;
    interface) tail -n 60 -f "$LOG_DIR/interface.log" ;;
    '') tail -n 40 -f "$LOG_DIR/node.log" "$LOG_DIR/interface.log" ;;
    *) die "logs takes node or interface" ;;
  esac
}

cmd_wallet() {
  need_core
  say "creating a $NETWORK wallet. The recovery phrase is printed ONCE and stored nowhere."
  (cd "$CORE_DIR" && node dist/index.js wallet new --network "$NETWORK")
}

cmd_invite() {
  local script="$SCRIPT_DIR/new-genesis-invite.mjs"
  [ -f "$script" ] || script="$SCRIPT_DIR/../scripts/new-genesis-invite.mjs"
  [ -f "$script" ] || die "new-genesis-invite.mjs not found next to this script"
  [ -n "$INTERFACE_DIR" ] || die "cannot find a built obsidian-interface — the invitation is minted by its own module"
  alive "$UI_PID" && say "note: the $NETWORK interface is running; restart it after this so it learns the new hash"
  if [ -f "$INVITE_FILE" ]; then say "replacing the invitation hash recorded for $NETWORK (an invitation that was already used stays used)"; fi
  local minted; minted="$(cd "$(dirname "$INTERFACE_DIR")" && OBSIDIAN_INTERFACE_DIR="$INTERFACE_DIR" node "$script" --json)"
  mkdir -p "$HOME_DIR"
  ( umask 077; node -e "process.stdout.write(JSON.parse(process.argv[1]).hash)" "$minted" > "$INVITE_FILE" )
  echo
  echo "  GENESIS INVITATION for $NETWORK — shown once, write it down:"
  echo
  echo "      $(node -e "process.stdout.write(JSON.parse(process.argv[1]).code)" "$minted")"
  echo
  say "its hash is saved in $INVITE_FILE (the code is not saved anywhere)."
  say "restart the interface so it uses it:  $0 $NETWORK restart"
}

cmd_reset() {
  [ "$NETWORK" != "mainnet" ] || die "reset is refused for mainnet: that is real data. Delete it by hand if you are certain."
  [ "${1:-}" = "--yes" ] || die "this deletes the $NETWORK chain, its node key and its interface accounts ($HOME_DIR). Run again with --yes to confirm."
  alive "$NODE_PID" || alive "$UI_PID" && die "stop the $NETWORK node and interface first:  $0 $NETWORK stop"
  rm -rf "$NODE_DATA" "$UI_DATA" "$LOG_DIR" "$HOME_DIR/node.pid" "$HOME_DIR/interface.pid"
  say "$NETWORK has been reset (its passphrase file and invitation hash were kept)"
}

# Answers "why is it not working?" in one command, from facts rather than guesses. Uses only Node, df, grep,
# tail and the shell, so it runs on a phone with nothing installed beyond the guide's packages.
port_free() {  # port_free <host> <port>
  node -e "const s=require('node:net').createServer();s.once('error',()=>process.exit(1));s.listen(Number(process.argv[2]),process.argv[1],()=>s.close(()=>process.exit(0)))" "$1" "$2"
}

cmd_doctor() {
  local problems=0 entry label host port pidfile
  ok()   { echo "  ok       $*"; }
  info() { echo "           $*"; }
  bad()  { echo "  PROBLEM  $*"; problems=$((problems + 1)); }
  fix()  { echo "           → $*"; }

  echo "obsidian-network doctor: $NETWORK   (node $RPC, peers $P2P, interface $UI)"

  echo; echo "this machine"
  if command -v node >/dev/null 2>&1; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    if [ "$major" -ge 20 ]; then ok "Node.js $(node -v) on $(node -p 'process.platform + "/" + process.arch')"; else bad "Node.js $(node -v) is too old: 20.10 or newer is needed"; fix "Termux:  pkg upgrade nodejs-lts"; fi
  else
    bad "node is not installed"; fix "Termux:  pkg install nodejs-lts"
  fi
  if [ -n "${TERMUX_VERSION:-}" ] || [[ "${PREFIX:-}" == *com.termux* ]]; then
    ok "running on Termux ${TERMUX_VERSION:-}"
    info "keep it alive while the network runs:  termux-wake-lock   and   Settings → Apps → Termux → Battery → Unrestricted"
  fi

  echo; echo "the installed build"
  if [ -n "$CORE_DIR" ] && [ -f "$CORE_DIR/dist/index.js" ]; then
    ok "obsidian-core $(node -p 'require(process.argv[1]).version' "$CORE_DIR/package.json" 2>/dev/null || echo '?') at $CORE_DIR"
    if [ -d "$CORE_DIR/node_modules/ws" ]; then ok "its libraries are installed"; else bad "its libraries are not installed"; fix "cd \"$CORE_DIR\" && npm ci --omit=dev --fetch-retries=10"; fi
  else
    bad "no built obsidian-core was found next to this script"; fix "unpack BOTH release archives into one directory (guide, Step 6) and run this script from there"
  fi
  if [ -n "$INTERFACE_DIR" ] && [ -f "$INTERFACE_DIR/dist/server/main.js" ]; then
    ok "obsidian-interface $(node -p 'require(process.argv[1]).version' "$INTERFACE_DIR/package.json" 2>/dev/null || echo '?') at $INTERFACE_DIR"
  else
    bad "no built obsidian-interface was found next to this script"; fix "unpack the self-host archive into the same directory as the operator archive (guide, Step 6)"
  fi

  echo; echo "this network's data and ports"
  if mkdir -p "$HOME_DIR" 2>/dev/null && touch "$HOME_DIR/.doctor-write-test" 2>/dev/null && rm -f "$HOME_DIR/.doctor-write-test"; then
    ok "data directory is writable: $HOME_DIR"
  else
    bad "cannot write to $HOME_DIR"; fix "choose another place:  OBSIDIAN_HOME=\$HOME/obsidian-data bash $0 $NETWORK start"
  fi
  local free_kb; free_kb="$(df -Pk "$HOME_DIR" 2>/dev/null | awk 'NR==2 {print $4}')" || free_kb=""
  if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
    if [ "$free_kb" -ge 204800 ]; then ok "$((free_kb / 1024)) MB free"; else bad "only $((free_kb / 1024)) MB free"; fix "free some space; a network needs about 200 MB to run comfortably"; fi
  fi
  for entry in "node RPC:127.0.0.1:$RPC:$NODE_PID" "interface:127.0.0.1:$UI:$UI_PID" "peer port:0.0.0.0:$P2P:$NODE_PID"; do
    IFS=: read -r label host port pidfile <<<"$entry"
    if alive "$pidfile"; then
      ok "$label $port is held by this network's own process (pid $(cat "$pidfile"))"
    elif port_free "$host" "$port"; then
      ok "$label $port is free"
    else
      bad "$label $port is in use by something else"; fix "if a copy of $NETWORK started by hand is running, stop it; or move every port by 10:  OBSIDIAN_PORT_OFFSET=10 bash $0 $NETWORK start"
    fi
  done

  echo; echo "what is running"
  for entry in "node:$NODE_PID:${CORE_DIR:+$CORE_DIR/dist/index.js}" "interface:$UI_PID:${INTERFACE_DIR:+$INTERFACE_DIR/dist/server/main.js}"; do
    IFS=: read -r label pidfile port <<<"$entry"
    if alive "$pidfile"; then
      ok "$label is running (pid $(cat "$pidfile"))"
      [ -z "$port" ] || note_if_stale "$label" "$pidfile" "$port"
    else
      info "$label is not running"
    fi
  done

  echo; echo "keys, passphrases and the invitation"
  local given="${OBSIDIAN_KEYSTORE_PASSPHRASE:-}${OBSIDIAN_KEYSTORE_PASSPHRASE_FILE:-}"
  if [ -f "$PASS_FILE" ]; then
    ok "passphrase: this network's own file ($PASS_FILE) is used"
    [ -z "$given" ] || info "the passphrase in your shell is ignored: the file above belongs to this network's key"
  elif [ -f "$KEY_FILE" ]; then
    if [ -n "$given" ]; then
      ok "passphrase: the one in your shell is used (this key has no stored passphrase)"
    elif alive "$NODE_PID"; then
      ok "passphrase: not needed while the node runs; the next start needs the one this key was made with"
    elif [ "$NETWORK" = "mainnet" ]; then
      info "passphrase: mainnet keeps none. Give it to the command that starts the node:  OBSIDIAN_KEYSTORE_PASSPHRASE='…' bash $0 mainnet start"
    else
      bad "this network has a key ($KEY_FILE) but no stored passphrase, and none in your shell, so the next start will fail"
      fix "give the one you used:  OBSIDIAN_KEYSTORE_PASSPHRASE='…' bash $0 $NETWORK start     (nothing worth keeping here?  $0 $NETWORK reset --yes)"
    fi
  elif [ "$NETWORK" = "mainnet" ]; then
    if [ -n "$given" ]; then ok "passphrase: taken from your shell for this command"; else info "passphrase: mainnet makes none for you. Set one for the command:  OBSIDIAN_KEYSTORE_PASSPHRASE='…' bash $0 mainnet start"; fi
  else
    ok "passphrase: none yet; one will be generated on the first start (a test network does not need one you chose)"
    [ -z "$given" ] || info "the passphrase in your shell is ignored: a new $NETWORK key gets its own"
  fi
  if [ -f "$INVITE_FILE" ]; then
    ok "invitation: this network's own ($INVITE_FILE)"
  elif [ "$NETWORK" = "devnet" ]; then
    ok "invitation: the disposable devnet one that ships with the release (use the code you were given)"
  else
    info "invitation: none yet, so nobody can create the first account on $NETWORK"
    fix "$0 $NETWORK invite     (it prints the code once; then start, or restart)"
  fi

  echo; echo "your shell (variables that could point this command at the wrong place)"
  local noted=0
  if [ -n "$IGNORED_IDENTITY" ]; then info "ignored for this network: $IGNORED_IDENTITY"; noted=1; fi
  if [ -n "${OBSIDIAN_GENESIS_INVITE_HASH:-}" ]; then
    if [ "$OBSIDIAN_GENESIS_INVITE_HASH" = "$DEVNET_SHIPPED_INVITE_HASH" ]; then info "OBSIDIAN_GENESIS_INVITE_HASH is devnet's: used on devnet, never on another network"; else info "OBSIDIAN_GENESIS_INVITE_HASH is set: used only when this network has no invitation file of its own"; fi
    noted=1
  fi
  if [ -n "${OBSIDIAN_SEED_NODES:-}" ]; then info "OBSIDIAN_SEED_NODES=$OBSIDIAN_SEED_NODES  (dialled by whichever network you start next; clear it with  unset OBSIDIAN_SEED_NODES)"; noted=1; fi
  for var in OBSIDIAN_PORT_OFFSET OBSIDIAN_HOME OBSIDIAN_CORE_DIR OBSIDIAN_INTERFACE_DIR OBSIDIAN_NODE_ONLY OBSIDIAN_NO_MINE; do
    if [ -n "${!var:-}" ]; then info "$var=${!var}"; noted=1; fi
  done
  [ "$noted" = 1 ] || ok "nothing leftover"

  echo; echo "recent errors"
  local seen=0 log
  for log in node interface; do
    if [ -f "$LOG_DIR/$log.log" ]; then
      local recent; recent="$(tail -n 30 "$LOG_DIR/$log.log" | grep -E 'fatal|"level":"error"' | tail -n 2 | cut -c1-240 || true)"
      if [ -n "$recent" ]; then
        bad "the $log log shows:"; echo "$recent" | sed 's/^/             /'; explain_failure "$log"; seen=1
      fi
    fi
  done
  [ "$seen" = 1 ] || ok "none in the last lines of the logs"

  echo
  if [ "$problems" -eq 0 ]; then
    echo "no problems found. To start:  bash $0 $NETWORK start"
  else
    echo "$problems problem(s) above. Fix the first one, then run  bash $0 $NETWORK doctor  again."
    exit 1
  fi
}

case "$COMMAND" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  wallet) cmd_wallet ;;
  invite) cmd_invite ;;
  reset) cmd_reset "$@" ;;
  doctor) cmd_doctor ;;
  *) die "unknown command \"$COMMAND\" — start, stop, restart, status, logs, wallet, invite, reset or doctor" ;;
esac
