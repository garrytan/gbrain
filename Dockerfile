FROM oven/bun:1.3

RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates procps zstd \
    && rm -rf /var/lib/apt/lists/*

# Ollama (manual tarball install; the install.sh script expects systemd)
RUN curl -fsSL https://github.com/ollama/ollama/releases/download/v0.32.6/ollama-linux-amd64.tar.zst \
    | tar --zstd -C /usr -x

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile

# Bake the embedding model into the image so first boot needs no download.
# Vectors in Postgres are nomic-embed-text/768; the query-time model must match.
RUN /usr/bin/ollama serve & \
    for i in $(seq 1 30); do curl -sf http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break; sleep 1; done && \
    ollama pull nomic-embed-text && \
    pkill -f "ollama serve" || true

# Claude Code CLI for the claude-cli model provider (chat, cycles, Minions).
# The native installer ships a standalone binary, so no Node dependency in
# this bun image. Auth comes from the CLAUDE_CODE_OAUTH_TOKEN Fly secret.
RUN curl -fsSL https://claude.ai/install.sh | bash \
    && ln -sf /root/.local/bin/claude /usr/local/bin/claude \
    && claude --version

# autopilot resolves its worker child via `which gbrain` (same lesson as the
# laptop's autopilot-run.sh PATH repair): give the container a gbrain shim.
RUN printf '#!/bin/sh\nexec bun /app/src/cli.ts "$@"\n' > /usr/local/bin/gbrain \
    && chmod +x /usr/local/bin/gbrain

RUN chmod +x /app/fly-entrypoint.sh
EXPOSE 8790
CMD ["/app/fly-entrypoint.sh"]
