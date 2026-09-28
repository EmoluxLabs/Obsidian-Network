# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Obsidian Core node image
#
# Two stages: the builder compiles TypeScript and prunes dev dependencies, the
# runtime stage carries only Node, the compiled node and a non-root user. The
# chain data directory is a volume, so replacing the image never touches state.
#
# A Dockerfile is not proof of deployability: `deployment/docker/verify.sh`
# builds this image, starts it, waits for /health and runs a transaction against
# it. If that script has not been run on your machine, treat this file as
# untested on yours.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22.11-bookworm-slim AS builder
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.test.json vitest.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22.11-bookworm-slim AS runtime
ENV NODE_ENV=production \
    OBSIDIAN_DATA_DIR=/data \
    OBSIDIAN_KEYSTORE=/data/node-key.json \
    OBSIDIAN_RPC_HOST=0.0.0.0 \
    OBSIDIAN_P2P_HOST=0.0.0.0

# tini reaps the node process properly so a `docker stop` is a graceful shutdown.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin obsidian \
 && mkdir -p /data && chown obsidian:obsidian /data

WORKDIR /app
COPY --from=builder --chown=root:root /build/node_modules ./node_modules
COPY --from=builder --chown=root:root /build/dist ./dist
COPY --chown=root:root package.json ./
COPY --chown=root:root deployment/docker/entrypoint.sh /usr/local/bin/obsidian-entrypoint

RUN chmod 0755 /usr/local/bin/obsidian-entrypoint

USER obsidian
VOLUME ["/data"]
EXPOSE 8630 8631

# The health check is the node's own /health, not a TCP probe: a node that is
# listening but has lost its chain must be reported as unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OBSIDIAN_RPC_PORT||8630)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/obsidian-entrypoint"]
CMD ["start"]
