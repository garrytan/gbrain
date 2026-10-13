# syntax=docker/dockerfile:1
#
# Builds the `gbrain` CLI from source into a single self-contained binary
# (bun's --compile, no bun/node needed at runtime) and runs it in a minimal
# runtime image. Two stages: `builder` has the full bun toolchain and repo;
# `runtime` ships the compiled binary plus the handful of files that are read
# from disk at runtime. The admin dashboard is also copied as plain static
# files so /admin always serves the exact JS/CSS referenced by index.html;
# the embedded manifest remains a fallback for non-Docker compiled binaries.

# ---- builder ---------------------------------------------------------------
FROM oven/bun:1.4.3 AS builder
WORKDIR /app

# Dependency layer first for Docker layer caching. scripts/postinstall.ts
# must be present before `bun install` because @electric-sql/pglite runs as
# a trustedDependency postinstall hook (see tests/docker/Dockerfile, the
# existing precedent for this pattern in this repo).
COPY package.json bun.lock bunfig.toml ./
COPY patches/ patches/
COPY scripts/postinstall.ts scripts/postinstall.ts
RUN bun install --frozen-lockfile

# Full source tree. admin/dist/ and src/admin-embedded.ts are committed,
# pre-built artifacts (see admin/.gitignore comment + scripts/build-admin-
# embedded.ts) — no `cd admin && bun install && bun run build` step needed
# here. `bun build --compile` needs admin/dist/ present to resolve the
# `with { type: 'file' }` imports in src/admin-embedded.ts, and the runtime
# image also copies admin/dist/ so the dashboard serves static JS/CSS directly.
COPY . .

# Exact build command from package.json's "build" script / CLAUDE.md.
RUN bun build --compile --no-compile-autoload-bunfig --outfile bin/gbrain src/cli.ts

# ---- runtime ----------------------------------------------------------------
FROM debian:bookworm-slim AS runtime

# ca-certificates: outbound HTTPS to Postgres/Supabase and LLM/embedding
# providers. tini: reap the Bun process cleanly on `docker stop`.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --user-group gbrain

WORKDIR /app

COPY --from=builder /app/bin/gbrain /app/bin/gbrain

# findGbrainRoot() (src/core/skillpack/bundle.ts) walks up from the process
# cwd at runtime looking for a directory containing BOTH openclaw.plugin.json
# and src/cli.ts, then reads the real skills/ tree from disk for skillpack
# and resolver features (`gbrain skillpack`, `gbrain doctor`, the dream-cycle
# filing-rules ladder). src/cli.ts here is a root marker only — its content
# is irrelevant since the CLI itself is already compiled into bin/gbrain.
# recipes/ (gbrain integrations) is likewise read from disk via a cwd
# fallback. admin/dist/ is copied so the Docker dashboard serves the same
# built JS/CSS that index.html references; schema SQL and native locks remain
# embedded in the binary.
COPY --from=builder /app/openclaw.plugin.json /app/openclaw.plugin.json
COPY --from=builder /app/src/cli.ts /app/src/cli.ts
COPY --from=builder /app/admin/dist/ /app/admin/dist/
COPY --from=builder /app/skills/ /app/skills/
COPY --from=builder /app/recipes/ /app/recipes/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PATH="/app/bin:${PATH}" \
    GBRAIN_HOME=/data

# GBRAIN_HOME is a PARENT dir; gbrain appends `.gbrain` itself and
# chmod 0700s it on first use (ensureGbrainHome()) — just needs to be
# writable by the `gbrain` user.
RUN mkdir -p /data && chown -R gbrain:gbrain /data /app
VOLUME ["/data"]
USER gbrain

EXPOSE 3131
ENTRYPOINT ["tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["serve", "--http", "--bind", "0.0.0.0","--port","3131"]
