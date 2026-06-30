# gbrain production image — Bun-compiled binary with embedded /admin SPA.
# Build sequence per gbrain: install deps, build+embed admin, then compile.
# Build stage runs on the native build arch and cross-compiles the binary to the
# TARGET arch (Bun supports --target), so multi/cross-arch builds avoid emulating Bun.
FROM --platform=$BUILDPLATFORM oven/bun:1.3-debian AS build
ARG TARGETARCH
WORKDIR /app

# Root deps first (better layer caching)
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile || bun install

# Admin SPA deps
COPY admin/package.json admin/bun.lock* admin/
RUN cd admin && bun install || true

# Source
COPY . .

# Build + embed the admin SPA, then cross-compile the self-contained binary
# for the target architecture.
RUN cd admin && bun run build && cd .. \
 && bun run scripts/build-admin-embedded.ts \
 && case "$TARGETARCH" in \
      amd64) BT=bun-linux-x64 ;; \
      arm64) BT=bun-linux-arm64 ;; \
      *)     BT=bun-linux-x64 ;; \
    esac \
 && bun build --compile --target="$BT" --outfile bin/gbrain src/cli.ts

# ---- runtime ----
FROM oven/bun:1.3-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/bin/gbrain /usr/local/bin/gbrain
# Ship the bundled schema-pack YAMLs alongside the binary. `bun build --compile`
# cannot embed these (load-active.ts resolves them via a dynamic path), so
# without this COPY every file-backed pack (gbrain-recommended, the lens packs,
# gbrain-bravura) is unloadable in the container — only the hardcoded gbrain-base
# behavior works. defaultPackLocator checks /usr/local/share/gbrain/schema-packs/base.
COPY --from=build /app/src/core/schema-pack/base /usr/local/share/gbrain/schema-packs/base
ENV HOME=/home/bun \
    GBRAIN_HOME=/home/bun/.gbrain
RUN mkdir -p /home/bun/.gbrain && chown -R bun:bun /home/bun
USER bun
EXPOSE 3131
ENTRYPOINT ["gbrain"]
