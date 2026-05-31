# TODOS

## Legacy Compatibility

### PGLite compiled-binary compatibility
**What:** Submit PR to oven-sh/bun fixing WASM file embedding in `bun build --compile` (issue oven-sh/bun#15032).

**Why:** PGLite is now an explicit legacy compatibility and migration-test path,
not the target runtime. Its WASM files (~3MB) still cannot be embedded in the
compiled binary. Users who install via `bun install -g mbrain` are fine (WASM
resolves from node_modules), but the compiled binary cannot use the legacy
PGLite escape hatch.

**Pros:** Single-binary distribution includes PGLite. No sidecar files needed.

**Cons:** Requires understanding Bun's bundler internals. May be a large PR.

**Context:** Issue has been open since Nov 2024. The root cause is that `bun build --compile` generates virtual filesystem paths (`/$bunfs/root/...`) that PGLite can't resolve. Multiple users have reported this. A fix would benefit any WASM-dependent package, not just PGLite.

**Depends on:** A decision that the legacy PGLite escape hatch still needs
compiled-binary support after the Postgres target runtime migration.

## P0

### ChatGPT MCP live validation and OAuth hardening
**What:** Validate the opt-in OAuth MCP flow against ChatGPT Developer Mode and harden any client-specific edge cases.

**Why:** MBrain now has a self-hosted OAuth 2.1/DCR foundation on `mbrain serve --http --oauth`, but live ChatGPT validation is still needed before claiming the guide is fully verified.

**Pros:** Completes the "every AI client" promise with real client evidence, not just protocol coverage.

**Cons:** Requires a ChatGPT plan/environment with connector setup access and a public HTTPS endpoint.

**Context:** Discovered during DX review (2026-04-10). All other clients
(Claude Desktop/Code/Cowork, Perplexity) work with bearer tokens. The Edge
Function deployment was removed in v0.8.0. The built-in `mbrain serve --http`
runtime now provides the HTTP MCP foundation, and `--oauth` adds discovery,
DCR, PKCE authorization code exchange, refresh grants, and access-token issuance
through the existing `access_tokens` table.

**Depends on:** Live ChatGPT Developer Mode validation.

## Completed

### ChatGPT OAuth/DCR foundation (`mbrain serve --http --oauth`)
**Completed:** Unreleased — `mbrain serve --http --oauth` now exposes OAuth
metadata, protected-resource metadata, Dynamic Client Registration,
authorization, and token endpoints for ChatGPT-style remote MCP clients. It is
single-user and opt-in: the owner approves with `MBRAIN_OAUTH_APPROVAL_TOKEN`,
PKCE is required, issued MCP access tokens are hashed into the existing
`access_tokens` table, and refresh grants can mint replacement access tokens.

### Built-in HTTP MCP transport (`mbrain serve --http`)
**Completed:** Unreleased — `mbrain serve --http` now starts a self-hosted
Streamable HTTP MCP server with `/mcp`, `/health`, Bearer token authentication,
request logging, and the same operation catalog, response guards, and
foreground limiter used by stdio MCP. It is intentionally only the transport
foundation: first-party Docker/Fly/Railway templates remain separate follow-up
work.

### Batch embedding queue for explicit backfills
**Completed:** Unreleased — `mbrain embed --all` and
`mbrain embed --stale` now share one provider-agnostic embedding queue across
page submissions, flush chunks in batches of 100, cap concurrent provider calls,
and keep errors isolated to affected page submissions. The original TODO
assumed import workers embedded inline, but current import/sync behavior is
intentionally text-first; explicit `mbrain embed` remains the safe backfill path.

### Community recipe submission (`mbrain integrations submit`)
**Completed:** Unreleased — `mbrain integrations submit <recipe.md>` now
validates custom recipes locally, emits a deterministic contribution package,
and keeps the default path free of git, network, file-write, and PR side
effects. When an agent explicitly passes `--create-pr`, submit copies the recipe
to `recipes/<id>.md`, creates a contribution branch, commits, pushes, and opens
a sanitized draft PR through `gh`.

### Always-on deployment recipes (Fly.io, Railway)
**Completed:** Unreleased — added `fly-app-hosting` and
`railway-app-hosting` infra recipes for HTTP webhook and collector services that
need stable public URLs without local ngrok. These recipes intentionally stop at
hosting a user-provided HTTP service; `mbrain serve --http` now supplies the
HTTP service when the target is MBrain's MCP server, while OAuth remains outside
these hosting recipes.

### Constrained health_check DSL for third-party recipes
**Completed:** Unreleased — replaced shell command health checks with typed
`env_exists`, `env_any_exists`, `url_responds`, and `heartbeat_fresh` checks.
`mbrain integrations doctor` now evaluates the bounded DSL instead of executing
recipe-provided shell commands.

### Implement AWS Signature V4 for S3 storage backend
**Completed:** v0.6.0 (2026-04-10) — replaced with @aws-sdk/client-s3 for proper SigV4 signing.
