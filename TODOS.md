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

## Completed

### Phase 14 Postgres runtime confidence smoke
**Completed:** Unreleased — `bun run smoke:postgres-runtime` now validates the
final Postgres runtime cleanup gate against a disposable Postgres target:
`mbrain init`, Markdown import, projection lineage, deterministic Phase 13
replay, and `mbrain doctor --json`. It intentionally clears OpenAI and
Anthropic provider keys for child commands, so it is a no-provider-key release
confidence gate for the runtime migration path.

### ChatGPT MCP live validation and OAuth hardening
**Completed:** Unreleased — live ChatGPT Developer Mode validation connected a
temporary self-hosted `mbrain serve --http --oauth` server through a public HTTPS
tunnel, completed Dynamic Client Registration and PKCE authorization, approved
the owner-gated OAuth request, and called `get_stats` through ChatGPT against
real Postgres. The follow-up hardening exposes full MCP tool descriptors over
HTTP so ChatGPT can discover app actions, keeps stdio tool schemas compact, and
returns an explicit empty `resources/list` result for clients that probe MCP
resources. No OpenAI or Anthropic API keys are required for the MBrain server
runtime path.

### HTTP OAuth runtime confidence smoke
**Completed:** Unreleased — `bun run smoke:http-oauth` starts the real Bun HTTP
MCP server against Postgres, simulates a ChatGPT-style Dynamic Client
Registration and PKCE authorization-code flow, calls MCP tools with the issued
access token, exercises the refresh-token grant, verifies the refreshed access
token, confirms the initial access token is rejected after refresh, and verifies
Postgres `access_tokens` plus `mcp_request_log` evidence. It can also verify a
configured public HTTPS issuer and restart the HTTP server between OAuth setup
steps to prove persisted DCR/client-code state.

### Postgres-backed OAuth setup state
**Completed:** Unreleased — ChatGPT-style OAuth Dynamic Client Registration
clients and one-use authorization codes now persist in Postgres instead of
process-local memory. Authorization-code exchange now consumes a code with one
conditional Postgres update so concurrent attempts cannot mint multiple bearer
tokens. Server restarts during setup no longer force clients to register again,
and the restart-resilient smoke mode proves registration, authorization, token
exchange, and MCP tool calls across fresh HTTP server instances. Unapproved
DCR registrations are pruned after one hour, and pending registrations are
capped so unauthenticated setup requests cannot grow durable state without
bound.

### ChatGPT OAuth/DCR foundation (`mbrain serve --http --oauth`)
**Completed:** Unreleased — `mbrain serve --http --oauth` now exposes OAuth
metadata, protected-resource metadata, Dynamic Client Registration,
authorization, and token endpoints for ChatGPT-style remote MCP clients. It is
single-user and opt-in: the owner approves with `MBRAIN_OAUTH_APPROVAL_TOKEN`,
PKCE is required, DCR clients and authorization codes persist in Postgres,
issued MCP access tokens are hashed into the existing `access_tokens` table,
and refresh grants can mint replacement access tokens.

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
