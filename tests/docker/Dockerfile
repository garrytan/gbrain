# tests/docker/Dockerfile — image for the offline agent-bootstrap e2e [A7].
#
# Built WITH network (base image pull + `bun install`); the resulting
# container is RUN networkless/read-only by tests/docker/bootstrap-e2e.sh:
#   --network none --read-only --cap-drop ALL --tmpfs /tmp
#
# BUN_IMAGE is overridable so the harness can track CI's pinned bun version
# (see .github/workflows/heavy-tests.yml setup-bun) without editing this file.
ARG BUN_IMAGE=oven/bun:1.4.3
FROM ${BUN_IMAGE}

# git drives the interview/render/repo phases; ca-certificates is build-time
# only (bun install). No gh — the fake shim inside the inner script covers it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependency layer first for build caching. Lifecycle scripts stay on
# (@electric-sql/pglite is a trustedDependency), so postinstall.ts must be
# present before `bun install`; it loads every repo module dynamically and
# exits 0 on every path, so it needs nothing else from src/. patches/ is
# copied so a future `patchedDependencies` entry cannot break this layer.
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY scripts/postinstall.ts scripts/postinstall.ts
RUN bun install --frozen-lockfile

# The repo itself. node_modules/.git/bin are excluded via
# Dockerfile.dockerignore (BuildKit per-Dockerfile ignore).
COPY . .

# Build-time smoke: the CLI must at least parse + print usage under this bun.
RUN bun run src/cli.ts bootstrap --help > /dev/null

# The actual test flow runs at `docker run` time (networkless):
#   bash /app/tests/docker/bootstrap-e2e-inner.sh
