# Thin-client routing (remote MCP)

On-demand reference (see CLAUDE.md Reference map). Current behavior + invariants
only; release history lives in `CHANGELOG.md` + git.

`gbrain init --mcp-only` (v0.29.2) sets up a thin-client install: no local
brain content, just an OAuth client pointing at a remote `gbrain serve --http`.
v0.29.2/v0.30.0 only refused 9 obvious local-only commands; the other ~25
silently fell through to `connectEngine()` and opened the empty local PGLite,
returning "No results." against a populated remote brain. v0.31.1 fixes the
silent-empty-results bug class for every operation surface.

Key files:

- `src/cli.ts` — Routing seam INSIDE the existing op-dispatch path (CDX-1: no
  parallel `src/core/thin-client/` module; routing is a ~80-line conditional
  in `runThinClientRouted`). Detects `isThinClient(cfg)` BEFORE `connectEngine`
  so thin-client installs never open the empty PGLite. localOnly ops on
  thin-client refuse via `refuseThinClient` (with pinpoint hint table
  `THIN_CLIENT_REFUSE_HINTS`). Banner via `printIdentityBannerBestEffort`
  before each routed call (suppressed by `--quiet`, `GBRAIN_NO_BANNER=1`,
  non-TTY default). Exhaustive TS `never` switch on `RemoteMcpError.reason`
  for canned, actionable error messages. ENG-2 renderer parity: local-engine
  path runs `JSON.parse(JSON.stringify(result))` so renderers see the same
  shape on both paths (kills Date/bigint/Buffer drift class).
- `src/core/mcp-client.ts` — `callRemoteTool(config, toolName, args, opts)`.
  Hardened in v0.31.1 (CDX-4): all transport errors normalized to
  `RemoteMcpError` via the `toRemoteMcpError` funnel. New `CallRemoteToolOptions
  {timeoutMs, signal}`; `buildAbortController` composes external signal with
  timeout. New `RemoteMcpErrorReason` stable union, `RemoteMcpErrorDetail.kind`
  ('timeout' | 'aborted' | 'unreachable') sub-tag, `RemoteMcpErrorDetail.code`
  field carrying server-supplied error codes (e.g. `missing_scope`).
  `extractToolErrorCode` parses JSON envelopes first, falls back to substring
  detection for legacy server messages. `unpackToolResult<T>(res)` unchanged
  (parses tool-call JSON content). `_clearMcpClientTokenCache()` test escape.
- `src/core/cli-options.ts` — `parseGlobalFlags` adds `--timeout=Ns` (accepts
  `30s`, `2m`, `500ms`, plain ms). Default `null` = per-command default (30s
  for most ops, 180s for `think`). `parseTimeout(s)` exported helper.
- `src/core/doctor-remote.ts` — `gbrain remote doctor` adds the
  `oauth_client_scopes_probe` check (CDX-5). Probes the read tier via
  `get_brain_identity` and admin tier via `get_health`; reports per-tier
  status with pinpoint remediation when admin is missing. `buildScopeCheck`
  + `ScopeProbeResult` exported for test access. Skippable via
  `GBRAIN_DOCTOR_SKIP_SCOPE_PROBE=1` for fixtures that mock /mcp at JSON-RPC
  initialize level only (MCP SDK Client hangs on shape mismatch).
- `src/core/ssrf-validate.ts` (v0.36 Commit 0) — DNS-rebinding-defended URL validation. `validateAndResolveUrl(url)` resolves the hostname via `dns.lookup({all: true, family: 0})`, checks EVERY A AND AAAA record against the internal-IP deny list, returns the resolved IP so callers fetch by IP (defeats DNS rebinding: validation IP === fetch IP). `fetchWithSSRFGuard(url, opts)` does redirect-aware fetching with per-hop re-validation, max 3 hops by default. Reusable across all URL-fetching features. Test seam `__setDnsLookupForTests` for hermetic tests.
- `src/core/search/query-intent.ts` extension (v0.36 cross-modal wave) — new `suggestedModality: 'text' | 'image' | 'both'` axis on `QuerySuggestions`. Module-scope `CROSS_MODAL_PATTERNS` regex array (compiles once at module load). `isAmbiguousModalityQuery(query)` heuristic gate fires when a visual noun + reference marker combination indicates genuinely ambiguous routing — used by the Commit 4 LLM tie-break to bound LLM calls to <1% of queries.
- `src/core/search/mode.ts` extension (v0.36 cross-modal wave) — `ModeBundle` extended with 7 cross-modal knobs: `cross_modal_both_text_weight` / `cross_modal_both_image_weight` (D6 weighted RRF for `'both'` mode, defaults 0.6/0.4), `image_query_text_refinement_weight` / `image_query_image_refinement_weight` (D13 hybrid intersect for `searchByImage` query refinement, defaults 0.4/0.6), `unified_multimodal` + `unified_multimodal_only` (Phase 3 unified column routing flags), `cross_modal_llm_intent` (Commit 4 opt-in escalation). `SEARCH_MODE_CONFIG_KEYS` extended with 7 corresponding config keys. `KNOBS_HASH_VERSION` bumped 2→3 (D2 — closes the silent cache-hit class where a cached text-mode result could leak to an image-mode caller).
- `src/core/search/hybrid.ts` extension (v0.36 cross-modal wave) — cross-modal routing branch at the embed step. Resolves `effectiveModality` from per-call `opts.crossModal` (normalized: literal `'auto'` → undefined per D22-1) → `suggestions.suggestedModality` → `'text'` default. Image route: `embedQueryMultimodal` + `searchVector({embeddingColumn: 'embedding_image'})`, skip expansion + keyword (D9 mode-bundle override). 'both' route: parallel text + image vector searches merged via `rrfFusionWeighted` with `effectiveRrfK(baseRrfK, weight)` from the configured cross-modal weights. Phase 3 unified routing fires when `cfg.search.unified_multimodal === true` — bypasses dual-column branching, runs `embedQueryMultimodal` + `searchVector({embeddingColumn: 'embedding_multimodal'})`, D8 fail-open on zero rows + not strict-mode falls through to dual-column. Commit 4 LLM escalation fires only when (no explicit per-call opt) AND (regex returned 'text') AND (`cfg.search.cross_modal.llm_intent` is true) AND (`isAmbiguousModalityQuery` returns true). Fail-open on every error.
- `src/core/search/image-loader.ts` (v0.36 Phase 2) — `loadImageInput(input, opts)` accepts local path, `data:` URI, or `http(s)://` URL. Magic-byte sniff for PNG/JPEG/WebP. Hard size cap (default 10 MB, configurable via `search.image_query.max_bytes`). For URLs: routes through `fetchWithSSRFGuard` so DNS rebinding + redirect chains are defeated. Pre-flight Content-Length check + post-fetch size guard for lying servers. `ImageLoadError` with discriminated `code` (INVALID_FORMAT / OVERSIZED / INVALID_URL / FETCH_FAILED / TIMEOUT / SSRF_BLOCKED / NOT_FOUND).
- `src/core/search/by-image.ts` (v0.36 Phase 2) — `searchByImage(engine, input, opts)`. Always runs image branch (`embedQueryMultimodalImage` + `searchVector(embedding_image)`). D13 hybrid intersect: when caller provides optional `query`, runs parallel text branch via `embedQueryMultimodal(query)` and merges via `rrfFusionWeighted` with weights from resolved mode. Phase 3 widens to unified column once `search.unified_multimodal=true` (transparently upgrades the retrieval quality post-reindex).
- `src/core/spend-log.ts` (v0.36 Phase 2 D23-#6) — per-OAuth-client paid-API spend tracking against the `mcp_spend_log` table (migration v74). `checkBudget(engine, clientId, capCents)` is the pre-flight gate; throws `BudgetExceededError` when today's spend has hit the cap. `recordSpend(engine, entry)` is best-effort post-call. UTC day-aligned aggregation so caps roll over deterministically regardless of server timezone. Local CLI callers (no clientId) bypass the gate. Pre-v0.36 brains without the table fail open to spend=0. `VOYAGE_MULTIMODAL_3_PER_IMAGE_CENTS` = 0.12 cents per image embed.
- `src/core/search/llm-intent.ts` (v0.36 Commit 4) — opt-in LLM tie-break. `classifyModalityWithLLM(query, fallback)` routes through `gateway.chat()` with a fixed single-word-output system prompt. 1s timeout via AbortController. `parseModality(raw, fallback)` is the pure parser — tolerates trailing punctuation + casing. Fail-open on every error (gateway unavailable, timeout, parse failure, unrecognized output) — returns fallback so a misbehaving LLM can never break search. Cost-bounded by the ambiguity heuristic in `query-intent.ts` (fires <1% of queries when on).
- `src/commands/reindex-multimodal.ts` (v0.36 Phase 3) — `gbrain reindex --multimodal [--limit N] [--dry-run] [--cost-estimate] [--no-embed] [--yes] [--json]`. Walks `content_chunks WHERE embedding_multimodal IS NULL`, batches via `embedMultimodalSafe` (Commit 0 partial-failure-aware), persists. D7 lock acquisition via `tryAcquireDbLock('gbrain-reindex-multimodal', 360min)`. Cost prompt + 10s Ctrl-C grace window in TTY. `GBRAIN_NO_REEMBED=1` bypass. Checkpoint at `~/.gbrain/reindex-multimodal-checkpoint.json` for resume. D23-#2 auto-flip prompt at coverage=100% completion (TTY: interactive; non-TTY: stderr hint with paste-ready command).
- `src/core/backfill-registry.ts` extension (v0.36) — new `modality` backfill kind. SQL filter requires `chunk_source='image_asset'` AND `embedding_image IS NOT NULL` AND `(modality IS NULL OR modality != 'image')`. D22-7 defensive guard: never flag a non-image chunk that happens to have `embedding_image` populated. Idempotent — second run finds zero rows.
- `src/core/migrate.ts` v74 (`mcp_spend_log`) + v75 (`embedding_multimodal_column`) — Phase 2 spend-log table + Phase 3 unified column ALTER. v75 is column-only (no HNSW index — deferred to post-reindex per pgvector best practice). v74 uses BTREE on `(client_id, created_at)` + `(token_name, created_at)` — `date_trunc('day', TIMESTAMPTZ)` is NOT IMMUTABLE so can't appear in index expressions; range scan on created_at covers the per-day rollup query.
- `src/core/operations.ts` — `get_brain_identity` op (read scope, no params,
  banner-only): cheap counter packet `{version, engine, page_count,
  chunk_count, last_sync_iso}` for the thin-client identity banner. Reuses
  `engine.getStats()`; banner's 60s client-side TTL bounds frequency to
  ≤1/60s per CLI process (well below the Fly.io health-check cadence that
  motivated the original `getStats` cost warning).
- `src/commands/{salience,anomalies,graph-query,think}.ts` — Per-command
  thin-client routing branches. These commands bypass the operation-layer
  dispatch in cli.ts (call `engine.foo()` directly), so each gets its own
  `if (isThinClient(cfg)) { callRemoteTool(...) }` branch that maps CLI flags
  to op params. `think` is a special case: the server's `think` op
  intentionally disables `--save`/`--take` for remote callers
  (operations.ts:1103-1135 trust-boundary gate); thin-client `think` warns
  loudly when those flags are set.
