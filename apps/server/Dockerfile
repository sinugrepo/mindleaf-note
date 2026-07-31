# =============================================================================
# Phase 9 — Production Dockerfile for @mindleaf/server (Hono + Drizzle).
#
# Multi-stage build:
#   1. `builder` : node:22-bookworm-slim + npm ci + tsc → apps/server/dist
#   2. `runtime` : node:22-bookworm-slim, copy dist + prod node_modules + the
#                  workspace symlink target for @mindleaf/shared.
#
# Why `bookworm-slim` and not `alpine`:
#   - @node-rs/argon2 ships native N-API binaries prebuilt for glibc on
#     linux-x64 (and linux-arm64). Alpine uses musl; the prebuilt artifacts
#     won't link and you'd need a Rust toolchain in the image. bookworm-slim
#     is the lowest-friction Debian-based slim variant.
#   - postgres (node-postgres) prefers glibc for pq bindings.
#
# Why non-root `node` user:
#   - Defended in depth: even a code-execution vuln in the app cannot drop
#     root, mutate system files, or read /etc/shadow. Required once we
#     bind-mount /opt/mindleaf/.env into the container (the unit file
#     wants to drop privileges already; this preserves the contract).
# =============================================================================

# ---------- 1. builder ----------
FROM node:22-bookworm-slim AS builder

WORKDIR /build

# npm cache + build deps. Build deps only — runtime image is slimmer.
# `apt-get install python3 make g++` is here ONLY because some transitive
# deps fall back to source compilation if a prebuilt isn't pinned.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install workspace deps. We need package.json from the workspace root,
# apps/server, and packages/shared, otherwise npm workspaces won't be
# able to resolve inter-package links during `tsc`.
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/package-lock.json* ./apps/server/
COPY packages/shared/package.json packages/shared/package-lock.json* ./packages/shared/

# `npm ci` is the canonical reproducible install (locks version + honors
# `optionalDependencies: false` semantics from package-lock).
# We need the optional native build attempt in case a prebuild isn't
# available for the host arch (e.g. ARM VPS); `python3 make g++`
# ensures the fallback compiles.
RUN npm ci --include=optional

# Now copy the actual source we want to build. We DON'T copy apps/web —
# the backend image has no business shipping a Vite-built SPA bundle
# (the Caddy layer serves that from a separate host path).
COPY packages/shared/tsconfig.json packages/shared/src ./packages/shared/
COPY apps/server/tsconfig.json apps/server/src ./apps/server/

# Compile TypeScript. Output: apps/server/dist/index.js (ESM, per
# package.json `"type": "module"`).
RUN npm run build --workspace=@mindleaf/server

# Trim devDependencies out of node_modules to slim the runtime layer.
# `npm prune --omit=dev` removes anything that's only listed under
# devDependencies, but keeps optionalDependencies (for native builds).
RUN npm prune --omit=dev --workspace=@mindleaf/server

# ---------- 2. runtime ----------
FROM node:22-bookworm-slim AS runtime

# Production-only: ca-certificates for outbound HTTPS (R2 + Let's Encrypt).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OCI labels — GCP/Cloudflare/AWS Container Registry all surface these.
LABEL org.opencontainers.image.title="mindleaf-server" \
      org.opencontainers.image.description="Hono backend for Mindleaf note-taking app" \
      org.opencontainers.image.source="https://github.com/sinugrepo/mindleaf-note" \
      org.opencontainers.image.licenses="all-rights-reserved"

ENV NODE_ENV=production \
    PORT=8787 \
    # `npm` outputs progress to stderr; keep stdout/stderr parity for
    # journal/systemd-cat scraping.
    NPM_CONFIG_LOGLEVEL=warn

WORKDIR /app

# Copy compiled bundle + production node_modules + package.json so the
# bin/cli references resolve. We also copy the entire `packages/shared`
# tree because `@mindleaf/shared`'s `main` points to `./src/index.ts`
# directly (workspace mode) — dist of shared is not produced by tsc
# so we ship the .ts source and let node resolve at runtime.
COPY --from=builder --chown=node:node /build/apps/server/dist ./dist
COPY --from=builder --chown=node:node /build/apps/server/node_modules ./node_modules
COPY --from=builder --chown=node:node /build/apps/server/package.json ./package.json
COPY --from=builder --chown=node:node /build/packages ./packages

# Pre-built symlinks in node_modules/@mindleaf/shared already point at
# /build/packages/shared; after the COPY above, /app/packages/shared is
# the resolved target. If you see "MODULE_NOT_FOUND" at runtime, this
# is the layer that needs revisiting.

# Drop privileges. `node:22-bookworm-slim` already ships a `node` user
# at uid:gid 1000:1000. We mirror that in the systemd drop-in for
# consistency between native + container deploys.
USER node:node

EXPOSE 8787

# Backend exposes `/healthz`. Caddy uses this for upstream health checks
# (see Caddyfile `health_path`). Tighter here because container platforms
# typically have smarter health-check retries; we don't need 30s spacing.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    || exit 1

# The dist entry is `index.js` (per tsconfig `outDir: dist` and the
# package.json `"main": "dist/index.js"`).
CMD ["node", "dist/index.js"]
