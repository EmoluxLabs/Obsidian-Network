#!/usr/bin/env bash
# Prove the image actually works: build it, start it against a node, ask its own
# health endpoint, and fail loudly if anything is missing.
#
# A Dockerfile in a repository is not evidence that anything is deployable.
# Run this script in the environment you intend to deploy to.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
IMAGE="${IMAGE:-obsidian/interface:verify}"
PORT="${PORT:-18788}"

command -v docker >/dev/null 2>&1 || { echo "docker is not installed: cannot verify this image here"; exit 2; }

echo "building $IMAGE from $ROOT"
docker build -f "$ROOT/obsidian-interface/deployment/docker/Dockerfile" -t "$IMAGE" "$ROOT"

NAME="obsidian-interface-verify-$$"
echo "starting $NAME on port $PORT"
docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:8788" -e OBSIDIAN_INTERFACE_NETWORK="${OBSIDIAN_INTERFACE_NETWORK:-devnet}" -e OBSIDIAN_NODE_URLS="${OBSIDIAN_NODE_URLS:-}" "$IMAGE" >/dev/null

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

for attempt in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    echo "health endpoint answered after ${attempt}s"
    break
  fi
  sleep 1
  if [ "$attempt" = 30 ]; then
    echo "interface did not become healthy; container logs:" >&2
    docker logs "$NAME" >&2 || true
    exit 1
  fi
done

echo "checking the landing site and a bundle are served"
curl -fsS "http://127.0.0.1:${PORT}/" | grep -q "Obsidian" || { echo "landing page missing" >&2; exit 1; }
curl -fsS "http://127.0.0.1:${PORT}/js/mine.js" >/dev/null || { echo "bundle missing" >&2; exit 1; }
curl -fsSI "http://127.0.0.1:${PORT}/" | grep -qi "content-security-policy" || { echo "security headers missing" >&2; exit 1; }

echo "OK: interface image built, started, answered and served its assets."
