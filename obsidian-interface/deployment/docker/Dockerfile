# syntax=docker/dockerfile:1.7
# ─────────────────────────────────────────────────────────────────────────────
# Obsidian Interface image — the self-hostable window onto the chain.
#
# Build context is the REPOSITORY ROOT, not this directory, because the browser
# bundle is compiled from the same core modules the node runs:
#
#   docker build -f obsidian-interface/deployment/docker/Dockerfile -t obsidian/interface .
#
# The image contains no key material, no chain data and no database. Its whole
# job is to serve static pages and proxy reads to Obsidian Core nodes.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22.11-bookworm-slim AS builder
WORKDIR /build

# ── core: needed because the interface vendors its browser-safe modules ──────
COPY obsidian-core/package.json obsidian-core/package-lock.json ./obsidian-core/
RUN npm --prefix obsidian-core ci

COPY obsidian-core/tsconfig.json obsidian-core/tsconfig.test.json obsidian-core/vitest.config.ts ./obsidian-core/
COPY obsidian-core/src ./obsidian-core/src
RUN npm --prefix obsidian-core run build

# ── interface ────────────────────────────────────────────────────────────────
COPY obsidian-interface/package.json obsidian-interface/package-lock.json ./obsidian-interface/
RUN npm --prefix obsidian-interface ci

COPY obsidian-interface/tsconfig.json obsidian-interface/tsconfig.web.json obsidian-interface/vitest.config.ts ./obsidian-interface/
COPY obsidian-interface/server ./obsidian-interface/server
COPY obsidian-interface/scripts ./obsidian-interface/scripts
COPY obsidian-interface/web ./obsidian-interface/web
COPY obsidian-interface/public ./obsidian-interface/public
RUN npm --prefix obsidian-interface run build \
 && npm --prefix obsidian-interface prune --omit=dev

FROM node:22.11-bookworm-slim AS runtime
ENV NODE_ENV=production \
    OBSIDIAN_INTERFACE_HOST=0.0.0.0 \
    OBSIDIAN_INTERFACE_PORT=8788 \
    OBSIDIAN_INTERFACE_SITE_ROOT=/app/sites \
    OBSIDIAN_INTERFACE_PUBLIC_DIR=/app/interface/public \
    OBSIDIAN_INTERFACE_CORE_DIR=/app/interface/web/core \
    OBSIDIAN_INTERFACE_DATA_DIR=/data

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10002 --home-dir /data --shell /usr/sbin/nologin obsidian \
 && mkdir -p /data /app/interface /app/sites && chown obsidian:obsidian /data

WORKDIR /app/interface
COPY --from=builder --chown=root:root /build/obsidian-interface/node_modules ./node_modules
COPY --from=builder --chown=root:root /build/obsidian-interface/dist ./dist
COPY --from=builder --chown=root:root /build/obsidian-interface/public ./public
COPY --from=builder --chown=root:root /build/obsidian-interface/web/core ./web/core
COPY --chown=root:root obsidian-interface/package.json ./package.json
COPY --from=builder --chown=root:root /build/landing /build/mine /build/wallet /build/explorer /build/social \
     /build/capsule /build/ons /build/circle /build/developer /build/app /build/audit /app/sites/

USER obsidian
VOLUME ["/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.OBSIDIAN_INTERFACE_PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/server/main.js"]
