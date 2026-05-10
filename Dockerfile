# ---- Stage 1: Build admin dashboard ----
FROM oven/bun:1.3.10 AS admin-builder

WORKDIR /app/admin
COPY admin/package.json admin/bun.lock* ./
RUN bun install --frozen-lockfile

COPY admin/ ./
RUN bun run build

# ---- Stage 2: Compile GBrain binary ----
FROM oven/bun:1.3.10 AS app-builder

WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY . .

# Build self-contained Linux x64 binary (WASM assets embedded via import { type: 'file' })
RUN bun build --compile \
  --target=bun-linux-x64 \
  --outfile bin/gbrain \
  src/cli.ts

# ---- Stage 3: Runtime image ----
FROM debian:bookworm-slim

# tini for zombie process reaping (Layer 2 of GBrain's 3-layer zombie defense)
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# GBrain binary (self-contained, includes all WASM tree-sitter grammars)
COPY --from=app-builder /app/bin/gbrain /usr/local/bin/gbrain

# Runtime assets GBrain reads from disk at startup
COPY --from=app-builder /app/skills ./skills
COPY --from=app-builder /app/recipes ./recipes
COPY --from=app-builder /app/templates ./templates

# Admin dashboard SPA (served by gbrain serve --http at /admin)
COPY --from=admin-builder /app/admin/dist ./admin/dist

# Persistent data volume mount point
RUN mkdir -p /data/gbrain
VOLUME ["/data/gbrain"]

ENV GBRAIN_HOME=/data/gbrain
ENV GBRAIN_ENGINE=postgres

EXPOSE 3131

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD gbrain serve --http --port 3131 --health-check 2>/dev/null || \
      wget -qO- http://localhost:3131/health | grep -q '"status":"ok"' || exit 1

ENTRYPOINT ["tini", "--"]
CMD ["gbrain", "serve", "--http", "--port", "3131"]
