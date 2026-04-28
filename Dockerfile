FROM oven/bun:1 AS builder
WORKDIR /app

COPY package.json ./
RUN bun install

COPY . .

# Build a self-contained Linux x64 binary
RUN bun build --compile --target=bun-linux-x64 \
    --outfile /app/bin/gbrain src/cli.ts

# ── runtime image ──────────────────────────────────────────────────────────
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/bin/gbrain /usr/local/bin/gbrain

ENV NODE_ENV=production
EXPOSE 4242

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${PORT:-4242}/health || exit 1

CMD ["sh", "-c", "gbrain http-serve --port=${PORT:-4242}"]
