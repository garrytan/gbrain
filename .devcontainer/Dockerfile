# gbrain dev container — Bun toolchain, isolated from the host.
# Base image floats with `oven/bun:1` to track the version CI runs
# (docker-compose.ci.yml uses the same image for its runner service).
FROM oven/bun:1

# git: needed for /ship and general repo work inside the container.
# ca-certificates + curl: TLS for API calls (OpenAI/Anthropic) and downloads.
# postgresql-client: psql for poking at the pgvector DB when running E2E.
# python3: `bun run verify`'s check:skill-brain-first parses `doctor --json`
#   with `python3 -c` (scripts/check-skill-brain-first.sh); absent → parse_error.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        git \
        curl \
        ca-certificates \
        postgresql-client \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# The repo is bind-mounted from a host user while this container runs as root,
# so git reports "dubious ownership" and refuses to read tracked file modes —
# which fails check:cli-exec. Trust the workspace path so git works in-container.
RUN git config --global --add safe.directory /app

WORKDIR /app

# Deps install at postCreateCommand time (see devcontainer.json) so the
# named node_modules volume is mounted first. Nothing to COPY here — the
# workspace is bind-mounted.
