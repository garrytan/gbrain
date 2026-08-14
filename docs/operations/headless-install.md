# Headless install: Docker, CI, postinstall

`gbrain init --pglite` in a non-TTY context (Docker `RUN`, CI step, postinstall hook) exits 1 when no embedding-provider API key is present in the environment. This is a deliberate fail-loud — the alternative is a silent-broken state where init succeeds with a default that doesn't match any real key.

Three patterns work for headless installs. Pick whichever fits your image lifecycle.

## Pattern 1: Provider key available at image build time

If your CI / Docker pipeline can inject the API key as a build-time env var, set it before `gbrain init`:

```dockerfile
# Multi-stage Dockerfile sketch
FROM oven/bun:1 AS builder

# Inject key at build via --build-arg or `--env` from CI.
ARG OPENAI_API_KEY
ENV OPENAI_API_KEY=$OPENAI_API_KEY

RUN bun install -g github:garrytan/gbrain#latest-stable
RUN gbrain init --pglite  # auto-picks OpenAI, persists config
```

```yaml
# GitHub Actions equivalent
- name: Initialize gbrain
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    bun install -g github:garrytan/gbrain#latest-stable
    gbrain init --pglite
```

Init writes `~/.gbrain/config.json` with the resolved `embedding_model` + `embedding_dimensions`. Subsequent runs (in the same image / runner) read from that config and don't re-resolve.

## Pattern 2: Provider key only at runtime (deferred-setup)

If the API key is a runtime secret (Kubernetes secret, runtime env injection, end-user-supplied), use `--no-embedding` at build time and configure the provider when the container actually runs:

```dockerfile
FROM oven/bun:1
RUN bun install -g github:garrytan/gbrain#latest-stable

# Build the brain shape without a provider — schema lands at the default
# width, but no embed callsite will actually run until runtime config.
RUN gbrain init --pglite --no-embedding

# At container start (entrypoint), provide the real provider:
ENTRYPOINT ["/bin/sh", "-c", "\
  gbrain config set embedding_model openai:text-embedding-3-large \
  && gbrain init --force --pglite \
  && exec gbrain serve"]
```

The `gbrain init --no-embedding` opt-in writes `embedding_disabled: true` to config. Every embed callsite (`gbrain import`, `gbrain embed`, the `runEmbedCore` library entry point) checks this and refuses cleanly with a `gbrain config set embedding_model <id>` hint rather than proceeding with a silent default.

The runtime `gbrain init --force` re-runs the init flow against the now-populated env, which:

- Removes `embedding_disabled` from config.
- Resolves the provider via env detection.
- Re-templates the PGLite schema if dim differs from the build-time default.

## Pattern 3: No key, ever (keyless mode)

`--no-embedding` isn't only a deferral — it's also the install shape for **keyless mode**, a first-class supported end state (not a broken one). With zero provider keys, gbrain runs keyword-only (BM25) search and takes memory from agent-authored `## Facts` fences and write ops; embedding and extraction paths refuse cleanly instead of failing silently. Concretely: the documented always-current chain (`gbrain sync --repo <path> && gbrain embed --stale`) is safe to schedule on a keyless brain — a bare stale embed exits 0 with a stderr note instead of breaking the chain, while explicit embed requests (a slug, `--slugs`, `--all`) still exit 1.

```dockerfile
FROM oven/bun:1
RUN bun install -g github:garrytan/gbrain#latest-stable
RUN gbrain init --pglite --no-embedding   # keyless install — done; no runtime re-init needed
```

`gbrain bootstrap verify` (and the agent-bootstrap flow generally) prints an honest capability report for this posture — a "keyless mode" banner, per-touchpoint lines, and the one-key upsell (`src/core/capability.ts`). Keyless installs for the agent-bootstrap path are covered in `docs/guides/bootstrap.md`; this doc covers the Docker/CI shape. Adding a single provider key later upgrades in place via Pattern 2's runtime `gbrain init --force`.

Since every embedding cost gate is structurally moot with no key, none of `docs/operations/spend-controls.md` applies until you add one.

## What WON'T work

```dockerfile
# Don't do this — silent default leaves you with vector(1280) ZE column
# and 1536d OpenAI provider at runtime, mismatched.
RUN gbrain init --pglite
```

If an older image used this pattern, `gbrain doctor` will surface the mismatch on first run after upgrade and print a paste-ready repair command — `gbrain init --force --pglite --embedding-model <model> --embedding-dimensions <dims>` for brains with no embeddings yet, `gbrain migrate embeddings --to <model> --dim <dims>` for non-empty brains.

## Verifying a headless install

After init, run `gbrain doctor --json` to verify state:

```bash
gbrain doctor --json | jq '.checks[] | select(.name=="embedding_provider")'
```

The `embedding_provider` check returns `status: 'ok'` when:

- Config has a persisted `embedding_model`.
- Config has a persisted `embedding_dimensions`.
- Live provider probe returns the configured dim.
- DB column width matches.

If you used Pattern 2's deferred-setup path, the check shows `Skipped (no provider credentials)` until the runtime config is populated. That's expected.
