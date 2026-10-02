#!/bin/sh
# Node container entrypoint.
#
# Creates the identity keystore once, then starts the node. The passphrase comes
# from OBSIDIAN_KEYSTORE_PASSPHRASE; if it is missing the keystore is protected
# by a generated file that lives beside it in the (private) data volume, and the
# operator is warned loudly, because an unprotected node key can be impersonated.
set -eu

DATA_DIR="${OBSIDIAN_DATA_DIR:-/data}"
KEYSTORE="${OBSIDIAN_KEYSTORE:-$DATA_DIR/node-key.json}"
mkdir -p "$DATA_DIR"

if [ -z "${OBSIDIAN_KEYSTORE_PASSPHRASE:-}" ]; then
  if [ -f "$DATA_DIR/keystore.pass" ]; then
    OBSIDIAN_KEYSTORE_PASSPHRASE="$(cat "$DATA_DIR/keystore.pass")"
    export OBSIDIAN_KEYSTORE_PASSPHRASE
  else
    echo "obsidian: WARNING — OBSIDIAN_KEYSTORE_PASSPHRASE is not set." >&2
    echo "obsidian: generating a random passphrase in $DATA_DIR/keystore.pass (mode 600)." >&2
    echo "obsidian: set the variable in production so the key can be restored elsewhere." >&2
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$DATA_DIR/keystore.pass"
    chmod 600 "$DATA_DIR/keystore.pass"
    OBSIDIAN_KEYSTORE_PASSPHRASE="$(cat "$DATA_DIR/keystore.pass")"
    export OBSIDIAN_KEYSTORE_PASSPHRASE
  fi
fi

if [ ! -f "$KEYSTORE" ]; then
  echo "obsidian: creating node identity keystore at $KEYSTORE"
  node /app/dist/index.js keygen --keystore "$KEYSTORE"
fi

echo "obsidian: starting node (network=${OBSIDIAN_NETWORK:-mainnet} mine=${OBSIDIAN_MINE:-true})"
exec node /app/dist/index.js "$@"
