#!/bin/sh
# Node container entrypoint.
#
# Creates the identity keystore once, then starts the node. The passphrase must come from
# OBSIDIAN_KEYSTORE_PASSPHRASE or OBSIDIAN_KEYSTORE_PASSPHRASE_FILE (a file YOU made, outside the data volume's key
# directory). On every network, mainnet or not, a container with neither refuses to start: a passphrase generated and
# kept beside the key it protects protects nothing, and this is the key that signs blocks. (A container has no
# terminal to ask on.)
set -eu

DATA_DIR="${OBSIDIAN_DATA_DIR:-/data}"
KEYSTORE="${OBSIDIAN_KEYSTORE_PATH:-${OBSIDIAN_KEYSTORE:-$DATA_DIR/node-key.json}}"
mkdir -p "$DATA_DIR"

if [ -z "${OBSIDIAN_KEYSTORE_PASSPHRASE:-}" ] && [ -z "${OBSIDIAN_KEYSTORE_PASSPHRASE_FILE:-}" ]; then
  echo "obsidian: refusing to start without OBSIDIAN_KEYSTORE_PASSPHRASE (or OBSIDIAN_KEYSTORE_PASSPHRASE_FILE)." >&2
  echo "obsidian: the node never generates a passphrase or stores one beside the key it protects." >&2
  exit 1
fi

if [ ! -f "$KEYSTORE" ]; then
  echo "obsidian: creating node identity keystore at $KEYSTORE"
  node /app/dist/index.js keygen --keystore "$KEYSTORE"
fi

echo "obsidian: starting node (network=${OBSIDIAN_NETWORK:-<none: set OBSIDIAN_NETWORK>} mining=${OBSIDIAN_MINING_ENABLED:-${OBSIDIAN_MINE:-true}})"
exec node /app/dist/index.js "$@"
