# TODOS

## P1

### Batch embedding queue across files
**What:** Shared embedding queue that collects chunks from all parallel import workers and flushes to OpenAI in batches of 100, instead of each worker batching independently.

**Why:** With 4 workers importing files that average 5 chunks each, you get 4 concurrent OpenAI API calls with small batches (5-10 chunks). A shared queue would batch 100 chunks across workers into one API call, cutting embedding cost and latency roughly in half.

**Pros:** Fewer API calls (500 chunks = 5 calls instead of ~100), lower cost, faster embedding.

**Cons:** Adds coordination complexity: backpressure when queue is full, error attribution back to source file, worker pausing. Medium implementation effort.

**Context:** Deferred during eng review because per-worker embedding is simpler and the parallel workers themselves are the bigger speed win (network round-trips). Revisit after profiling real import workloads to confirm embedding is actually the bottleneck. If most imports use `--no-embed`, this matters less.

**Implementation sketch:** `src/core/embedding-queue.ts` with a Promise-based semaphore. Workers `await queue.submit(chunks)` which resolves when the queue has room. Queue flushes to OpenAI in batches of 100 with max 2-3 concurrent API calls. Track source file per chunk for error propagation.

**Depends on:** Part 5 (parallel import with per-worker engines) -- already shipped.

## P0

### Fix `bun build --compile` WASM embedding for PGLite
**What:** Submit PR to oven-sh/bun fixing WASM file embedding in `bun build --compile` (issue oven-sh/bun#15032).

**Why:** PGLite's WASM files (~3MB) can't be embedded in the compiled binary. Users who install via `bun install -g gbrain` are fine (WASM resolves from node_modules), but the compiled binary can't use PGLite. Jarred Sumner (Bun founder, YC W22) would likely be receptive.

**Pros:** Single-binary distribution includes PGLite. No sidecar files needed.

**Cons:** Requires understanding Bun's bundler internals. May be a large PR.

**Context:** Issue has been open since Nov 2024. The root cause is that `bun build --compile` generates virtual filesystem paths (`/$bunfs/root/...`) that PGLite can't resolve. Multiple users have reported this. A fix would benefit any WASM-dependent package, not just PGLite.

**Depends on:** PGLite engine shipping (to have a real use case for the PR).

### ChatGPT MCP support (OAuth 2.1)
**What:** Add OAuth 2.1 with Dynamic Client Registration to the self-hosted MCP server so ChatGPT can connect.

**Why:** ChatGPT requires OAuth 2.1 for MCP connectors. Bearer token auth is NOT supported. This is the only major AI client that can't use GBrain remotely.

**Pros:** Completes the "every AI client" promise. ChatGPT has the largest user base.

**Cons:** OAuth 2.1 is a significant implementation: authorization endpoint, token endpoint, PKCE flow, dynamic client registration. Estimated CC: ~3-4 hours.

**Context:** Discovered during DX review (2026-04-10). All other clients (Claude Desktop/Code/Cowork, Perplexity) work with bearer tokens. The Edge Function deployment was removed in v0.8.0. OAuth needs to be added to the self-hosted HTTP MCP server (or `gbrain serve --http` when implemented).

**Depends on:** `gbrain serve --http` (not yet implemented).

### Runtime MCP access control
**What:** Add sender identity checking to MCP operations. Brain ops return filtered data based on access tier (Full/Work/Family/None).

**Why:** ACCESS_POLICY.md is prompt-layer enforcement (agent reads policy before responding). A direct MCP caller can bypass it. Runtime enforcement in the MCP server is the real security boundary for multi-user and remote deployments.

**Pros:** Real security boundary. ACCESS_POLICY.md becomes enforceable, not advisory.

**Cons:** Requires adding `sender_id` or `access_tier` to `OperationContext`. Each mutating operation needs a permission check. Medium implementation effort.

**Context:** From CEO review + Codex outside voice (2026-04-13). Prompt-layer access control works in practice (same model as Wintermute) but is not sufficient for remote MCP where direct tool calls bypass the agent's prompt.

**Depends on:** v0.10.0 GStackBrain skill layer (shipped).

## P1 (new from v0.7.0)

### ~~Constrained health_check DSL for third-party recipes~~
**Completed:** v0.9.3 (2026-04-12). Typed DSL with 4 check types (`http`, `env_exists`, `command`, `any_of`). All 7 first-party recipes migrated. String health checks accepted with deprecation warning + metachar validation for non-embedded recipes.

## P2

### Community recipe submission (`gbrain integrations submit`)
**What:** Package a user's custom integration recipe as a PR to the GBrain repo. Validates frontmatter, checks constrained DSL health_checks, creates PR with template.

**Why:** Turns GBrain from a single-author integration set into a community ecosystem. The recipe format IS the contribution format.

**Pros:** Community-driven integration library. Users build Slack-to-brain, RSS-to-brain, Discord-to-brain.

**Cons:** Support burden. Need constrained DSL (P1) before accepting third-party recipes. Need review process for recipe quality.

**Context:** From CEO review (2026-04-11). User explicitly deferred due to bandwidth constraints. Target v0.9.0.

**Depends on:** Constrained health_check DSL (P1) — **SHIPPED in v0.9.3.**

### Always-on deployment recipes (Fly.io, Railway)
**What:** Alternative deployment recipes for voice-to-brain and future integrations that run on cloud servers instead of local + ngrok.

**Why:** ngrok free URLs are ephemeral (change on restart). Always-on deployment eliminates the watchdog complexity and gives a stable webhook URL.

**Pros:** Stable URLs, no ngrok dependency, production-grade uptime.

**Cons:** Costs $5-10/mo per integration. Requires cloud account.

**Context:** From DX review (2026-04-11). v0.7.0 ships local+ngrok as v1 deployment path.

**Depends on:** v0.7.0 recipe format (shipped).

### `gbrain serve --http` + Fly.io/Railway deployment
**What:** Add `gbrain serve --http` as a thin HTTP wrapper around the stdio MCP server. Include a Dockerfile/fly.toml for cloud deployment.

**Why:** The Edge Function deployment was removed in v0.8.0. Remote MCP now requires a custom HTTP wrapper around `gbrain serve`. A built-in `--http` flag would make this zero-effort. Bun runs natively, no bundling seam, no 60s timeout, no cold start.

**Pros:** Simpler remote MCP setup. Users run `gbrain serve --http` behind ngrok instead of building a custom server. Supports all 30 operations remotely (including sync_brain and file_upload).

**Cons:** Users need ngrok ($8/mo) or a cloud host (Fly.io $5/mo, Railway $5/mo). Not zero-infra.

**Context:** Production deployments use a custom Hono server wrapping `gbrain serve`. This TODO would formalize that pattern into the CLI. ChatGPT OAuth 2.1 support depends on this.

**Depends on:** v0.8.0 (Edge Function removal shipped).

## Completed

### Implement AWS Signature V4 for S3 storage backend
**Completed:** v0.6.0 (2026-04-10) — replaced with @aws-sdk/client-s3 for proper SigV4 signing.
