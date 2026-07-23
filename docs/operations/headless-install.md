# Headless install: Docker, CI, postinstall

As of v0.37, `gbrain init --pglite` in a non-TTY context (Docker `RUN`, CI step, postinstall hook) exits 1 when no embedding-provider API key is present in the environment. This is a deliberate fail-loud — the alternative was the v0.36 silent-broken-state class where init succeeded with a default that didn't match any real key.

Two patterns work for headless installs. Pick whichever fits your image lifecycle.

## Pattern 1: Provider key available at image build time

If your CI / Docker pipeline can inject the API key as a build-time env var, set it before `gbrain init`:

```dockerfile
# Multi-stage Dockerfile sketch
FROM oven/bun:1 AS builder

# Inject key at build via --build-arg or `--env` from CI.
ARG OPENAI_API_KEY
ENV OPENAI_API_KEY=$OPENAI_API_KEY

RUN bun install -g github:garrytan/gbrain
RUN gbrain init --pglite  # auto-picks OpenAI, persists config
```

```yaml
# GitHub Actions equivalent
- name: Initialize gbrain
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  run: |
    bun install -g github:garrytan/gbrain
    gbrain init --pglite
```

Init writes `~/.gbrain/config.json` with the resolved `embedding_model` + `embedding_dimensions`. Subsequent runs (in the same image / runner) read from that config and don't re-resolve.

## Pattern 2: Provider key only at runtime (deferred-setup)

If the API key is a runtime secret, install the CLI in the image but initialize
the brain only after the secret is available. Run initialization once against
a persistent `GBRAIN_HOME`; do not put `reinit-pglite` in the steady-state
entrypoint.

```dockerfile
FROM oven/bun:1
RUN bun install -g github:garrytan/gbrain

# The persistent runtime volume owns GBRAIN_HOME.
ENV GBRAIN_HOME=/var/lib/gbrain
CMD ["/bin/sh", "-c", ": \"${GBRAIN_PUBLIC_URL:?set GBRAIN_PUBLIC_URL}\"; exec gbrain serve --http --port 3131 --bind 0.0.0.0 --public-url \"$GBRAIN_PUBLIC_URL\""]
```

The container now exposes HTTP MCP inside its container network. Keep port
3131 private to the workload network and terminate TLS at a trusted ingress,
reverse proxy, or tunnel whose external URL is `GBRAIN_PUBLIC_URL`; do not
publish the cleartext port directly to an untrusted network.

Before starting the steady-state container for the first time, have the
deployment controller run an initialization job with the same persistent
volume and runtime secret:

```bash
gbrain init --pglite --non-interactive \
  --embedding-model openai:text-embedding-3-large \
  --embedding-dimensions 1536
```

Use a one-shot job or explicit deployment step and let the deployment layer
record completion. `gbrain init --pglite` does not itself refuse an existing
brain, and a retry without the original `--schema-pack` can replace its
selected pack with the default. Do not use command success as the one-time
guard. If the deployment must retry, pass the complete original initialization
arguments, including the chosen schema pack. After initialization succeeds,
the HTTP `gbrain serve` command is restart-safe and does not perform
destructive setup.

Do not bake a `--no-embedding` brain into the image and attempt to repair it on
every start. `reinit-pglite` preserves `<path>.bak` and refuses to overwrite an
existing backup; it is an operator migration command, not an idempotent
entrypoint.

## What will not work

```dockerfile
# Don't do this — silent default leaves you with vector(1280) ZE column
# and 1536d OpenAI provider at runtime, mismatched.
RUN gbrain init --pglite
```

If you upgrade an older image that used this pattern, run `gbrain doctor` first.
Repair PGLite with `gbrain reinit-pglite`; use
[`../embedding-migrations.md`](../embedding-migrations.md) for Postgres.

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
