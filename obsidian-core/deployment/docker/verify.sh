#!/usr/bin/env bash
# Prove the node image actually works: build it, start it on a throwaway devnet,
# wait for its own /health, then submit a query and stop it.
#
# A Dockerfile in a repository is not evidence that anything is deployable.
# Run this script in the environment you intend to deploy to.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${IMAGE:-obsidian/core:verify}"
PORT="${PORT:-18630}"
PASSPHRASE="${PASSPHRASE:-verify-only-passphrase}"

command -v docker >/dev/null 2>&1 || { echo "docker is not installed: cannot verify this image here"; exit 2; }

echo "building $IMAGE from $ROOT/obsidian-core"
docker build -f "$ROOT/obsidian-core/deployment/docker/Dockerfile" -t "$IMAGE" "$ROOT/obsidian-core"

NAME="obsidian-node-verify-$$"
echo "starting $NAME (devnet) on port $PORT"
docker run -d --name "$NAME" \
  -p "127.0.0.1:${PORT}:8630" \
  -e OBSIDIAN_NETWORK=devnet \
  -e OBSIDIAN_KEYSTORE_PASSPHRASE="$PASSPHRASE" \
  -e OBSIDIAN_MINE=true \
  "$IMAGE" start --mine >/dev/null

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for attempt in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null; then
    echo "node health endpoint answered after ${attempt}s"
    break
  fi
  sleep 1
  if [ "$attempt" = 45 ]; then
    echo "node did not become healthy; container logs:" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
done

echo "checking the node reports a chain"
curl -fsS "http://127.0.0.1:${PORT}/status" | grep -q '"genesisId"' || { echo "status document incomplete" >&2; exit 1; }
curl -fsS "http://127.0.0.1:${PORT}/network" >/dev/null || { echo "network route missing" >&2; exit 1; }
curl -fsS "http://127.0.0.1:${PORT}/audit/compliance" | grep -q '"present":false' || { echo "compliance audit not served" >&2; exit 1; }

echo "OK: node image built, started, opened its RPC and reported a compliant chain."
