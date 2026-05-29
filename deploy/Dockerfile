# confer-gbrain production image — reconstructed 2026-05-29 from the docker
# history of ghcr.io/conferinc/gbrain:sp1a-v10 (the recipe had never been saved
# to the repo — a reproducibility gap). This file makes the prod build
# reviewable + reproducible.
#
# Model: install UPSTREAM gbrain, then overlay Confer's patched source files on
# top. gbrain runs from TS source via Bun at runtime (the `gbrain` bin is a
# symlink to src/cli.ts), so overlaying .ts files is sufficient — no compile step.
#
# ─── IMPORTANT: pin the upstream ref ───────────────────────────────────────
# The original image did `bun install -g github:garrytan/gbrain` (unpinned HEAD —
# non-reproducible: two builds days apart get different upstream code). Pin to a
# specific upstream commit/tag for reproducibility. As of 2026-05-29 upstream
# master includes the 4 reliability fixes we want (lock-renewal #1572, withRetry
# #1608, doctor #1573, conversation-parser #1620), so pinning current master is
# correct. Bump UPSTREAM_REF deliberately.
#
# ─── Build (run on a linux/amd64 host, e.g. S1, or buildx) ──────────────────
#   cd confer-gbrain
#   docker build -f deploy/Dockerfile -t ghcr.io/conferinc/gbrain:sp1a-v11 \
#     --build-arg UPSTREAM_REF=<commit-sha-or-tag> .
#   docker push ghcr.io/conferinc/gbrain:sp1a-v11
# Then point Coolify app 108 at :sp1a-v11 and redeploy (see deploy/DEPLOY.md).

ARG BUN_VERSION=1.3.14
FROM oven/bun:${BUN_VERSION}

ENV BUN_INSTALL_BIN=/usr/local/bin
ENV GBRAIN_HOME=/data/.gbrain

# Pin upstream for reproducible builds. Override with --build-arg UPSTREAM_REF=<sha>.
ARG UPSTREAM_REF=master
RUN bun install -g "github:garrytan/gbrain#${UPSTREAM_REF}"

# Confer schema pack (consumed by the CMD's `gbrain schema use confer-everything-v1`).
# pack.yaml is NOT in this repo — it lives in confer-gstack at
# confer-packs/confer-everything-v1/pack.yaml. Stage it into the build-context
# root before building (see deploy/DEPLOY.md):
#   cp ../confer-gstack/confer-packs/confer-everything-v1/pack.yaml ./pack.yaml
COPY pack.yaml /opt/confer/pack.yaml

# ─── Confer overlay: patched source over the upstream install ───────────────
# These ship Confer-specific behavior on top of upstream:
#   operations.ts     — put_page source selector + resolve_slugs tenant scoping
#   oauth-provider.ts — DCR scope clamp/seal + truthful registration response
#   migrate.ts        — wires Confer migrations v108-110 (epistemology/view/config)
#                       into the runner. WAS MISSING from the prod overlay, so a
#                       redeploy previously could not create the Confer schema on
#                       a fresh DB. Added 2026-05-29.
COPY src/core/operations.ts     /root/.bun/install/global/node_modules/gbrain/src/core/operations.ts
COPY src/core/oauth-provider.ts /root/.bun/install/global/node_modules/gbrain/src/core/oauth-provider.ts
COPY src/core/migrate.ts        /root/.bun/install/global/node_modules/gbrain/src/core/migrate.ts

EXPOSE 3000

# Init schema + serve. Joined with && (not ;) so serve does not start against a
# half-initialized DB, and `exec` so SIGTERM reaches bun for graceful shutdown on
# Coolify redeploy (the original used `;` + no exec — GB-PROD-5/8). DATABASE_URL
# is injected by Coolify. Note: --enable-dcr is intentionally OMITTED (DCR is a
# self-registration surface; the DCR scope-clamp seal in oauth-provider.ts is
# defense-in-depth, but not enabling DCR at all is the primary control).
CMD ["sh","-c","set -e; mkdir -p /data/.gbrain/.gbrain/schema-packs/confer-everything-v1 && cp /opt/confer/pack.yaml /data/.gbrain/.gbrain/schema-packs/confer-everything-v1/pack.yaml && gbrain init --url \"$DATABASE_URL\" --embedding-model openai:text-embedding-3-small --embedding-dimensions 1536 2>&1 | tail -3 && gbrain schema reload >/dev/null 2>&1 && gbrain schema use confer-everything-v1 2>&1 | tail -2 && exec gbrain serve --http --port 3000 --bind 0.0.0.0 --token-ttl 86400 --public-url https://brain-api.confersolutions.ai"]
