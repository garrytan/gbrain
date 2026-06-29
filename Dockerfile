# ── GBrain Railway Dockerfile ─────────────────────────────────────────
# Runs the GBrain HTTP MCP server on Bun.
# Railway injects PORT; PUBLIC_URL must be set to your Railway domain.
# ──────────────────────────────────────────────────────────────────────

FROM oven/bun:1 AS base

WORKDIR /app

# Create a non-root user with a writable home (gbrain writes to ~/.gbrain)
RUN groupadd --gid 1001 gbrain \
 && useradd  --uid 1001 --gid gbrain --create-home gbrain

# ── Install dependencies ─────────────────────────────────────────────
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# ── Copy application source ──────────────────────────────────────────
COPY src/    src/
COPY admin/  admin/
COPY scripts/ scripts/

# Own everything by the app user
RUN chown -R gbrain:gbrain /app

USER gbrain

# Railway injects $PORT; default to 3131 for local testing
EXPOSE ${PORT:-3131}

CMD bun run src/cli.ts serve --http \
    --bind 0.0.0.0 \
    --port ${PORT:-3131} \
    --public-url ${PUBLIC_URL} \
    --enable-dcr
