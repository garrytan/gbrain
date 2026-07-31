# gbrain container image.
#
# Two stages. The builder has Bun; the runtime does NOT — `bun build
# --compile` produces a single self-contained executable with the Bun runtime
# linked in, so shipping Bun again would only add ~90 MB and a second copy of
# the same interpreter.
#
# Everything gbrain needs at runtime is already inside that binary: the
# tree-sitter WASM grammars and the admin SPA are embedded at build time
# (scripts/check-wasm-embedded.sh and scripts/check-admin-embedded.ts are the
# CI gates that keep them in sync), and there are no native node modules. So
# the runtime stage needs a libc, CA certificates, and nothing else.
#
# Build:
#   docker build --platform linux/amd64 -t gbrain:local .
#
# --platform matters. A compiled Bun binary is architecture-specific and the
# runtime stage cannot cross-execute it, so building on an arm64 laptop for
# an amd64 Container App must be an explicit cross-build.

# ---------------------------------------------------------------------------
# Builder
# ---------------------------------------------------------------------------
# Pinned to the same Bun version CI builds and releases with. An unpinned
# tag would let the image drift ahead of what the test suite ran against.
FROM oven/bun:1.3.13-debian AS builder

WORKDIR /build

# Dependencies first, as their own layer: they change far less often than
# source, so an ordinary source edit reuses the cached install.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# Same invocation as `bun run build` and the release workflow. Kept literal
# rather than `bun run build` so the output path is visible here.
RUN bun build --compile --outfile bin/gbrain src/cli.ts

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates is not optional: every outbound call this container makes
# is TLS — Azure Postgres with sslmode=require, Foundry, Azure OpenAI, Key
# Vault. Without it they all fail certificate verification at once, which
# reads like a network problem rather than a missing package.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root. UID 10001 is arbitrary but explicit — a high, fixed, unnamed-in-
# /etc/passwd-elsewhere id avoids colliding with a host user if the
# filesystem is ever bind-mounted.
RUN groupadd --gid 10001 gbrain \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /data gbrain

COPY --from=builder /build/bin/gbrain /usr/local/bin/gbrain

# HOME and GBRAIN_HOME are BOTH set to /data, and that redundancy is
# load-bearing rather than sloppy: gbrain resolves its home three different
# ways that disagree — config.ts appends `.gbrain` to GBRAIN_HOME,
# brain-repo-durability.ts does not, and the minion supervisor ignores
# GBRAIN_HOME entirely in favour of $HOME/.gbrain. Setting only one leaves
# some component writing where nothing reads.
#
# /data is the container's own writable layer, deliberately ephemeral. With
# no git-backed sources nothing on disk must survive a restart — which is
# what removes the need for a persistent file share, and also why Log
# Analytics is the durable audit sink: the JSONL under GBRAIN_AUDIT_DIR is
# destroyed on every restart.
ENV HOME=/data \
    GBRAIN_HOME=/data \
    GBRAIN_AUDIT_DIR=/data/.gbrain/audit

RUN mkdir -p /data/.gbrain/audit && chown -R 10001:10001 /data

USER 10001:10001
WORKDIR /data

EXPOSE 8787

# No CMD. Both container apps and the migration job override the command
# anyway (`serve --http`, `jobs supervisor`, `apply-migrations`), and a
# default that silently starts a server would make a misconfigured job look
# like it worked.
ENTRYPOINT ["gbrain"]
