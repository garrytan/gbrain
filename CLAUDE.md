# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `gbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. GBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

## Two organizational axes (read this first)

GBrain knowledge is organized along two orthogonal axes. Users AND agents must
understand both, or queries misroute silently.

- **Brain** — WHICH DATABASE. Your personal brain is `host`. You can mount
  additional brains (team-published, each with their own DB and access policy)
  via `gbrain mounts add` (v0.19+). Routing: `--brain`, `GBRAIN_BRAIN_ID`,
  `.gbrain-mount` dotfile.
- **Source** — WHICH REPO INSIDE THE DATABASE. A brain can hold many sources
  (wiki, gstack, openclaw, essays). Slugs scope per source. Routing:
  `--source`, `GBRAIN_SOURCE`, `.gbrain-source` dotfile.

Both axes follow the same 6-tier resolution pattern. Read
`docs/architecture/brains-and-sources.md` for topology diagrams (personal, team
mount, CEO-class with multiple team brains) and
`skills/conventions/brain-routing.md` for the agent-facing decision table.

## Architecture

Contract-first: `src/core/operations.ts` defines ~41 shared operations (adds `find_orphans` in v0.12.3). CLI and MCP
server are both generated from this single source. Engine factory (`src/core/engine-factory.ts`)
dynamically imports the configured engine (`'pglite'` or `'postgres'`). Skills are fat
markdown files (tool-agnostic, work with both CLI and plugin contexts).

**Trust boundary:** `OperationContext.remote` distinguishes trusted local CLI callers
(`remote: false` set by `src/cli.ts`) from untrusted agent-facing callers
(`remote: true` set by `src/mcp/server.ts`). Security-sensitive operations like
`file_upload` tighten filesystem confinement when `remote=true` and default to
strict behavior when unset.

## Key files

- `src/core/operations.ts` — Contract-first operation definitions (the foundation). Also exports upload validators: `validateUploadPath`, `validatePageSlug`, `validateFilename`, plus `matchesSlugAllowList(slug, prefixes)` (v0.23 glob matcher: `<prefix>/*` matches recursive children; bare `<prefix>` matches exact only). `OperationContext.remote` flags untrusted callers; `OperationContext.allowedSlugPrefixes` (v0.23) is the trusted-workspace allow-list set by the dream cycle. `put_page` enforces: when `viaSubagent` and `allowedSlugPrefixes` is set, slug must match the allow-list; else the legacy `wiki/agents/<id>/...` namespace check applies. Auto-link enabled for trusted-workspace writes (skipped only when `remote=true && !trustedWorkspace`). As of v0.26.0, every `Operation` also carries `scope?: 'read' | 'write' | 'admin'` + `localOnly?: boolean`. All ops are annotated; `sync_brain`, `file_upload`, `file_list`, and `file_url` are `admin + localOnly` (rejected over HTTP). `OperationContext.auth?: AuthInfo` is threaded through HTTP dispatch for scope enforcement in `serve-http.ts` before the op runs.
- `src/core/engine.ts` — Pluggable engine interface (BrainEngine). `clampSearchLimit(limit, default, cap)` takes an explicit cap so per-operation caps can be tighter than `MAX_SEARCH_LIMIT`. Exports `LinkBatchInput` / `TimelineBatchInput` for the v0.12.1 bulk-insert API (`addLinksBatch` / `addTimelineEntriesBatch`). As of v0.13.1, `BrainEngine` has a `readonly kind: 'postgres' | 'pglite'` discriminator so migrations (`src/core/migrate.ts`) and other consumers can branch on engine without `instanceof` + dynamic imports.
- `src/core/engine-factory.ts` — Engine factory with dynamic imports (`'pglite'` | `'postgres'`)
- `src/core/pglite-engine.ts` — PGLite (embedded Postgres 17.5 via WASM) implementation, all 40 BrainEngine methods. `addLinksBatch` / `addTimelineEntriesBatch` use multi-row `unnest()` with manual `$N` placeholders. As of v0.13.1, `connect()` wraps `PGlite.create()` in a try/catch that emits an actionable error naming the macOS 26.3 WASM bug (#223) and pointing at `gbrain doctor`; the lock is released on failure so the next process can retry cleanly. v0.22.0: `searchKeyword` and `searchKeywordChunks` multiply `ts_rank` by the source-factor CASE expression at the chunk-grain level; `searchVector` becomes a two-stage CTE — inner CTE keeps `ORDER BY cc.embedding <=> vec` so HNSW stays usable, outer SELECT re-ranks by `raw_score * source_factor`. Inner LIMIT scales with offset to preserve pagination contract. As of v0.22.6.1, `initSchema()` calls `applyForwardReferenceBootstrap()` BEFORE replaying SCHEMA_SQL — probes for the specific forward-referenced state the embedded schema blob needs (`pages.source_id`, `links.link_source`, `links.origin_page_id`, `content_chunks.symbol_name`, `content_chunks.language`, `sources` FK target table) and adds only what's missing. Closes the upgrade-wedge bug class that bit users 10+ times across 6 schema versions over 2 years (#239/#243/#266/#357/#366/#374/#375/#378/#395/#396). No-op on fresh installs and modern brains.
- `src/core/pglite-schema.ts` — PGLite-specific DDL (pgvector, pg_trgm, triggers)
- `src/core/postgres-engine.ts` — Postgres + pgvector implementation (Supabase / self-hosted). `addLinksBatch` / `addTimelineEntriesBatch` use `INSERT ... SELECT FROM unnest($1::text[], ...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` — 4-5 array params regardless of batch size, sidesteps the 65535-parameter cap. As of v0.12.3, `searchKeyword` / `searchVector` scope `statement_timeout` via `sql.begin` + `SET LOCAL` so the GUC dies with the transaction instead of leaking across the pooled postgres.js connection (contributed by @garagon). `getEmbeddingsByChunkIds` uses `tryParseEmbedding` so one corrupt row skips+warns instead of killing the query. v0.22.0: `searchKeyword`, `searchKeywordChunks`, and `searchVector` apply source-aware ranking by inlining the source-factor CASE and `NOT (col LIKE …)` hard-exclude clause from `src/core/search/sql-ranking.ts`. `searchVector` switches to a two-stage CTE (HNSW-safe inner ORDER BY, source-boost re-rank in the outer SELECT) and carries `p.source_id` through inner→outer for v0.18 multi-source callers. v0.22.1 (#406): `_savedConfig` retains the connect config; `reconnect()` tears down + recreates the pool from saved config (called by supervisor watchdog after 3 consecutive health-check failures). `executeRaw` is a single-statement passthrough — no per-call retry (D3 dropped that as unsound for non-idempotent statements; recovery is supervisor-driven). v0.22.1 (#363, contributed by @orendi84): `connect()` applies `resolveSessionTimeouts()` from `db.ts` as connection-time startup parameters (`statement_timeout`, `idle_in_transaction_session_timeout`) so orphan pgbouncer backends can't hold locks for hours. v0.22.1 (#409, contributed by @atrevino47): `countStaleChunks()` + `listStaleChunks()` server-side-filter on `embedding IS NULL` for `embed --stale`, eliminating ~76 MB/call client-side pull on a fully-embedded brain; `upsertChunks()` resets both `embedding` AND `embedded_at` to NULL when chunk_text changes without a new embedding (consistency). As of v0.22.6.1, `initSchema()` calls `applyForwardReferenceBootstrap()` BEFORE replaying SCHEMA_SQL on the same forward-reference probe set as the PGLite engine, so old Postgres brains pinned at v0.13/v0.18/v0.19 walk forward cleanly instead of wedging on `column "..." does not exist`.
- `src/core/utils.ts` — Shared SQL utilities extracted from postgres-engine.ts. Exports `parseEmbedding(value)` (throws on unknown input, used by migration + ingest paths where data integrity matters) and as of v0.12.3 `tryParseEmbedding(value)` (returns `null` + warns once per process, used by search/rescore paths where availability matters more than strictness).
- `src/core/db.ts` — Connection management, schema initialization. v0.22.1 (#363, contributed by @orendi84): `resolveSessionTimeouts()` returns `statement_timeout` + `idle_in_transaction_session_timeout` (defaults: 5min each, env-overridable via `GBRAIN_STATEMENT_TIMEOUT` / `GBRAIN_IDLE_TX_TIMEOUT` / `GBRAIN_CLIENT_CHECK_INTERVAL`). Both `connect()` (module singleton) and `PostgresEngine.connect()` (worker pool) consume the result via postgres.js's `connection` option, sending GUCs as startup parameters that survive PgBouncer transaction mode (unlike the prior `setSessionDefaults` post-pool SET, kept as a back-compat no-op shim).
- `src/commands/migrate-engine.ts` — Bidirectional engine migration (`gbrain migrate --to supabase/pglite`)
- `src/core/import-file.ts` — importFromFile + importFromContent (chunk + embed + tags)
- `src/core/sync.ts` — Pure sync functions (manifest parsing, filtering, slug conversion). v0.22.12 (#500, foundation by @wintermute via #501): `classifyErrorCode(errorMsg)` regex-based classifier with 12 codes (`SLUG_MISMATCH`, `YAML_PARSE`, `YAML_DUPLICATE_KEY`, `MISSING_OPEN`, `MISSING_CLOSE`, `NESTED_QUOTES`, `EMPTY_FRONTMATTER`, `NULL_BYTES`, `INVALID_UTF8`, `STATEMENT_TIMEOUT`, `FILE_TOO_LARGE`, `SYMLINK_NOT_ALLOWED`) plus `UNKNOWN` fallback. `summarizeFailuresByCode(failures)` returns sorted `[{code, count}]`. `code?` optional field on `SyncFailure`; backfilled at ack time on pre-v0.22.12 entries. `acknowledgeSyncFailures()` returns `AcknowledgeResult { count, summary }`. Three regexes (`MISSING_OPEN`, `MISSING_CLOSE`, `EMPTY_FRONTMATTER`) broadened to match actual `markdown.ts:159-244` validator message strings, not just the literal code-name prefix. `FILE_TOO_LARGE` covers all three production size sites in `import-file.ts:199, 352, 401`; `SYMLINK_NOT_ALLOWED` covers the rejection at `:347`. Closes the silent-skip pattern that motivated #500.
- `src/core/storage.ts` — Pluggable storage interface (S3, Supabase Storage, local)
- `src/core/storage-config.ts` (v0.22.11) — Storage tiering: `loadStorageConfig` reads `gbrain.yml`, normalizes deprecated keys (`git_tracked` / `supabase_only`) to canonical (`db_tracked` / `db_only`) with once-per-process deprecation warning, and runs `normalizeAndValidateStorageConfig` (auto-fixes missing trailing `/`, throws `StorageConfigError` on tier overlap). Path-segment matcher: `media/x/` does NOT match `media/xerox/foo`. Replaces gray-matter (broken on delimiter-less YAML) with a dedicated parser for the `gbrain.yml` shape.
- `src/core/disk-walk.ts` (v0.22.11) — `walkBrainRepo(repoPath)` returns `Map<slug, {size, mtimeMs}>` from one recursive `readdirSync`. Skips dot-dirs, `node_modules`, non-`.md` files. Used by `gbrain storage status` to replace per-page `existsSync + statSync` (~400K syscalls on 200K-page brains → tens).
- `src/commands/storage.ts` (v0.22.11) — `gbrain storage status [--repo P] [--json]`. Split into pure data (`getStorageStatus`) + JSON formatter + human formatter (ASCII-only per D10) matching the `orphans.ts` pattern. `PageCountsByTier` and `DiskUsageByTier` are distinct nominal types so swaps fail at compile time.
- `gbrain.yml` (brain repo root, v0.22.11) — Optional storage tiering config. Top-level `storage:` section with `db_tracked:` and `db_only:` array-valued keys. `gbrain sync` auto-manages `.gitignore` for `db_only` paths on successful sync (skips on dry-run, blocked-by-failures, submodule context, or `GBRAIN_NO_GITIGNORE=1`). `gbrain export --restore-only [--repo P] [--type T] [--slug-prefix S]` repopulates missing `db_only` files from the database.
- `src/core/supabase-admin.ts` — Supabase admin API (project discovery, pgvector check)
- `src/core/file-resolver.ts` — File resolution with fallback chain (local -> .redirect.yaml -> .redirect -> .supabase)
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided). v0.19.0 adds `code.ts` — tree-sitter-based semantic chunker for 29 languages with embedded-asset WASMs (`src/assets/wasm/`), `@dqbd/tiktoken` cl100k_base tokenizer, small-sibling merging. `CHUNKER_VERSION` constant folded into `importCodeFile`'s `content_hash` so chunker shape changes force clean re-chunks across releases.
- `src/core/errors.ts` (v0.19.0) — `StructuredAgentError` + `buildError` + `serializeError`. Every new v0.19.0 agent-facing surface (code-def, code-refs, usage errors) uses this envelope; matches v0.17.0 `CycleReport.PhaseResult.error` shape.
- `src/assets/wasm/` (v0.19.0) — 36 tree-sitter grammar WASMs + tree-sitter runtime. Committed to the repo so `bun --compile` embeds them deterministically via `import path from ... with { type: 'file' }`. The CI guard `scripts/check-wasm-embedded.sh` fails the build if the compiled binary ever silently falls through to recursive chunks.
- `src/commands/code-def.ts` + `src/commands/code-refs.ts` (v0.19.0) — symbol definition + references lookup. Query `content_chunks.symbol_name` or chunk_text ILIKE with `page_kind='code'` filter. Auto-JSON when stdout is not a TTY (gh-CLI convention). Bypass the standard `searchKeyword` `DISTINCT ON (slug)` collapse so multiple call-sites from the same file surface.
- `src/core/search/` — Hybrid search: vector + keyword + RRF + multi-query expansion + dedup. As of v0.22.0, `searchKeyword` / `searchKeywordChunks` / `searchVector` apply source-aware ranking at the SQL layer (curated content like `originals/`, `concepts/`, `writing/` outranks bulk content like `wintermute/chat/`, `daily/`, `media/x/`). `searchVector` uses a two-stage CTE so source-boost re-ranking doesn't kill the HNSW index. Hard-exclude prefixes (`test/`, `archive/`, `attachments/`, `.raw/` by default) filter at retrieval, not post-rank. Both gates honor `detail !== 'high'` so temporal queries surface chat pages normally.
- `src/core/search/intent.ts` — Query intent classifier (entity/temporal/event/general → auto-selects detail level)
- `src/core/search/eval.ts` — Retrieval eval harness: P@k, R@k, MRR, nDCG@k metrics + runEval() orchestrator
- `src/core/search/source-boost.ts` (v0.22.0) — Source-type boost map keyed by slug prefix. `DEFAULT_SOURCE_BOOSTS` (originals/ 1.5, concepts/ 1.3, writing/ 1.4, people/companies/deals/ 1.2, daily/ 0.8, media/x/ 0.7, wintermute/chat/ 0.5) and `DEFAULT_HARD_EXCLUDES` (test/, archive/, attachments/, .raw/). `parseSourceBoostEnv` / `parseHardExcludesEnv` parse comma-separated `prefix:factor` pairs from `GBRAIN_SOURCE_BOOST` / `GBRAIN_SEARCH_EXCLUDE` env vars. `resolveBoostMap` and `resolveHardExcludes` merge defaults + env + caller `SearchOpts.exclude_slug_prefixes`/`include_slug_prefixes`.
- `src/core/search/sql-ranking.ts` (v0.22.0) — Pure SQL string builders. `buildSourceFactorCase(slugColumn, boostMap, detail)` emits a CASE expression with longest-prefix-match wins (returns literal `'1.0'` when `detail === 'high'` for temporal-bypass parity with COMPILED_TRUTH_BOOST). `buildHardExcludeClause(slugColumn, prefixes)` emits `NOT (col LIKE 'p1%' OR col LIKE 'p2%')` — OR-chain wrapped in NOT, NOT `NOT LIKE ALL/ANY` (those quantifiers don't express set-exclusion). LIKE meta-character escape covers all three of `%`, `_`, AND `\` (backslash matters because it's Postgres LIKE's default escape char). Single-quote doubling on SQL string literals so injection-style inputs are inert text.
- `src/commands/eval.ts` — `gbrain eval` command: single-run table + A/B config comparison. v0.25.0 adds sub-subcommand dispatch on `args[0]` so `gbrain eval export` + `gbrain eval prune` + `gbrain eval replay` route into session-capture handlers; bare `gbrain eval --qrels …` fall-through preserves the legacy IR-metrics flow.
- `src/commands/eval-export.ts` (v0.25.0) — streams `eval_candidates` rows as NDJSON to stdout with `schema_version: 1` prefix on every line. EPIPE-safe, progress heartbeats on stderr, stable id-desc tiebreaker so `--since` windows never dupe/miss rows.
- `src/commands/eval-prune.ts` (v0.25.0) — explicit retention cleanup. Requires `--older-than DUR`. `--dry-run` reports would-delete count.
- `src/commands/eval-replay.ts` (v0.25.0) — contributor-facing replay tool. Reads NDJSON from `gbrain eval export`, re-runs each captured `query` / `search` op against the current brain, computes set-Jaccard@k between captured + current `retrieved_slugs`, top-1 stability rate, and latency Δ. Stable JSON shape (`schema_version: 1`) for CI gating; human mode prints a regression table. Pure Bun, zero new deps. The dev-loop half of BrainBench-Real that closes the gap between "data captured" and "data used to gate a PR." See `docs/eval-bench.md` for the workflow.
- `docs/eval-bench.md` (v0.25.0) — contributor guide for using captured data to benchmark retrieval changes before merging. Linked from CONTRIBUTING.md under "Running real-world eval benchmarks (touching retrieval code)".
- `src/core/eval-capture.ts` (v0.25.0) — op-layer capture wrapper called from `src/core/operations.ts` `query` + `search` handlers. Catches MCP + CLI + subagent tool-bridge from one site. Fire-and-forget; failures route to `engine.logEvalCaptureFailure` so `gbrain doctor` sees drops cross-process. **Capture is off by default** — `isEvalCaptureEnabled` resolution: explicit `config.eval.capture` (true/false) wins, else `process.env.GBRAIN_CONTRIBUTOR_MODE === '1'`, else off. Production users get a quiet brain; contributors set `export GBRAIN_CONTRIBUTOR_MODE=1` in `.zshrc` to enable the dev loop. PII scrubber gate is independent and defaults to true regardless of CONTRIBUTOR_MODE.
- `src/core/eval-capture-scrub.ts` (v0.25.0) — zero-deps PII scrubber: emails, phones, SSN, Luhn-verified credit cards, JWT-shaped tokens, bearer tokens.
- `src/core/search/hybrid.ts` — Cathedral II `Promise<SearchResult[]>` return shape unchanged in v0.25.0. Adds `onMeta?: (m: HybridSearchMeta) => void` callback so op-layer capture can record what hybridSearch actually did. Existing callers leave it undefined.
- `docs/eval-capture.md` (v0.25.0) — stable NDJSON schema reference for gbrain-evals consumers.
- `test/public-exports.test.ts` (v0.25.0 / R2) — runtime contract test. Imports each of the 17 public subpaths via package name and pins a canary symbol per module. Paired with `scripts/check-exports-count.sh`.
- `src/core/embedding.ts` — OpenAI text-embedding-3-large, batch, retry, backoff
- `src/core/check-resolvable.ts` — Resolver validation: reachability, MECE overlap, DRY checks, structured fix objects. v0.14.1: `CROSS_CUTTING_PATTERNS.conventions` is an array (notability gate accepts both `conventions/quality.md` and `_brain-filing-rules.md`). New `extractDelegationTargets()` parses `> **Convention:**`, `> **Filing rule:**`, and inline backtick references. DRY suppression is proximity-based via `DRY_PROXIMITY_LINES = 40`.
- `src/core/repo-root.ts` — Shared `findRepoRoot(startDir?)` (v0.16.4): walks up from `startDir` (default `process.cwd()`) looking for `skills/RESOLVER.md`. Zero-dependency module imported by both `doctor.ts` and `check-resolvable.ts`. Parameterized `startDir` makes tests hermetic.
- `src/commands/check-resolvable.ts` — Standalone CLI wrapper (v0.16.4) over `checkResolvable()`. Exports `parseFlags`, `resolveSkillsDir`, `DEFERRED`, `runCheckResolvable`. Exit rule: **1 on any issue (warnings OR errors)**, stricter than doctor's `ok` flag — honors README:259. Stable JSON envelope `{ok, skillsDir, report, autoFix, deferred, error, message}` — same shape on success and error paths. `--fix` path runs `autoFixDryViolations` BEFORE `checkResolvable` (same ordering as doctor). `scripts/skillify-check.ts` subprocess-calls `gbrain check-resolvable --json` (cached per process) and fails loud on binary-missing — no silent false-pass. **v0.19:** AGENTS.md workspaces now resolve natively (see `src/core/resolver-filenames.ts`) — gbrain inspects the 107-skill OpenClaw deployment whether the routing file is `RESOLVER.md` or `AGENTS.md`. `DEFERRED[]` is empty — Checks 5 + 6 shipped as real code, not issue URLs.
- `src/core/resolver-filenames.ts` (v0.19) — central list of accepted routing filenames (`RESOLVER.md`, `AGENTS.md`). Shared by `findRepoRoot`, `check-resolvable`, and skillpack install so every code path walks the same fallback chain.
- `src/commands/skillify.ts` + `src/core/skillify/{generator,templates}.ts` (v0.19) — `gbrain skillify scaffold <name>` creates all stubs for a new skill in one command: SKILL.md, script, tests, routing-eval.jsonl, resolver entry, filing-rules pointer. `gbrain skillify check <script>` runs the 10-step checklist (LLM evals, routing evals, check-resolvable gate, filing audit) against a candidate skill before it lands.
- `src/commands/skillify-check.ts` (v0.19) — `gbrain skillpack-check` agent-readable health report. Exit 0/1/2 for CI pipeline gating; JSON for debugging. Wraps `check-resolvable --json`, `doctor --json`, and migration ledger into one payload so agents can decide whether a human action is required.
- `src/commands/book-mirror.ts` (v0.25.1) — `gbrain book-mirror --chapters-dir <path> --slug <slug> [flags]`. Flagship of the v0.25.1 skills wave. Submits N read-only subagent jobs (one per chapter; `allowed_tools: ['get_page', 'search']`), waits for all via `waitForCompletion`, reads each child's `job.result`, assembles two-column markdown CLI-side, writes a single operator-trust `put_page` to `media/books/<slug>-personalized.md`. Codex HIGH-1 fix applied: trust narrowing happens at the tool-allowlist layer (subagents can't call put_page) instead of allowedSlugPrefixes — untrusted EPUB content cannot prompt-inject any people page. Cost-estimate prompt before launching; refuses to spend in non-TTY without `--yes`. Per-chapter idempotency keys (`book-mirror:<slug>:ch-<N>`) for retry-friendly re-runs. Partial-failure handling: assembles with completed chapters and a `## Failed chapters` section listing retries. Test surface: `test/book-mirror.test.ts` (9 cases — CLI registration + source invariants).
- `src/commands/skillpack.ts` + `src/core/skillpack/{bundle,installer}.ts` (v0.19) — `gbrain skillpack install` drops gbrain's curated 25-skill bundle into a host workspace, managed-block style. Never clobbers local edits; tracks a skill manifest so subsequent `install --update` diffs cleanly. Bundle builder (`skillpack/bundle.ts`) packages the set from `skills/` into a versioned payload. **v0.24.0:** managed block embeds a `<!-- gbrain:skillpack:manifest cumulative-slugs="..." version="..." -->` receipt inside the fence. Per-skill installs accumulate via `union(prior_receipt, this_call)`; `install --all` is the only path that prunes (drops slugs no longer in the bundle). Rows inside the fence whose slug is in neither the new cumulative set nor the bundle survive as user-added with a stderr `[skillpack] unknown row in managed block: "<slug>" — Investigate: ...` warning. Pre-v0.24 fences upgrade silently on first install (extracted slugs become the prior cumulative set). **v0.25.1:** `gbrain skillpack uninstall <name>` lands as a real CLI subcommand. Inverse of install with symmetric data-loss posture: D8 refuses if the slug isn't in the cumulative-slugs receipt (won't nuke a hand-added row); D11 content-hash guard refuses if any installed file diverges from the bundle (you've edited it locally) unless `--overwrite-local` is passed. `applyUninstall` enforces an atomic-refusal contract: pre-scans ALL files for divergence; refuses BEFORE any unlink fires if anything is blocked. The bug fix landed via `test/skillpack-uninstall.test.ts`'s D11 case — the test was written with the contract in mind, the original implementation interleaved hash-check + unlink, and the lie surfaced immediately.
- `src/core/archive-crawler-config.ts` (v0.25.1) — D12 + codex HIGH-4 safety gate for the `archive-crawler` skill. Refuses to run unless `archive-crawler.scan_paths:` is explicitly set in the brain repo's `gbrain.yml`. Mirrors the storage-config.ts parsing pattern (sibling file; separate concern from storage tiering). `loadArchiveCrawlerConfig(repoPath)` throws `ArchiveCrawlerConfigError(missing_section | empty_scan_paths | invalid_path | parse_error)`. `normalizeAndValidateArchiveCrawlerConfig` rejects relative paths and `..` traversal; `~` is expanded; trailing-slash normalized for unambiguous prefix matching. `isPathAllowed(candidate, config)` is the runtime per-file gate (scan_paths prefix-match with directory-boundary correctness; deny_paths overrides). Tests in `test/archive-crawler-config.test.ts` (19 cases).
- `test/helpers/cli-pty-runner.ts` (v0.25.1) — generic real-PTY harness ported from gstack and trimmed to ~470 lines. Uses pure `Bun.spawn({terminal:})` (Bun 1.3.10+; engines.bun pin in package.json). Generic primitives only — no plan-mode orchestrators. Exports: `launchPty`, `resolveBinary`, `stripAnsi`, `parseNumberedOptions`, `optionsSignature`, `isNumberedOptionListVisible`, `isTrustDialogVisible`. Self-tests in `test/cli-pty-runner.test.ts` (24 cases).
- `src/core/skill-manifest.ts` (v0.19) — parser for `skill-manifest.json` records. Used by skillpack installer to detect drift between the shipped bundle and the user's local edits, so updates merge instead of overwriting.
- `src/commands/routing-eval.ts` + `src/core/routing-eval.ts` (v0.19) — `gbrain routing-eval` catches user phrasings that route to the wrong skill. Reads `skills/<name>/routing-eval.jsonl` fixtures (`{intent, expected_skill, ambiguous_with?}`). Structural layer runs in `check-resolvable` by default (zero API cost). The `--llm` flag is accepted as a placeholder for a future LLM tie-break layer; in v0.24.0 it emits a stderr notice and runs structural only. False positives surface before users hit them.
- `src/core/filing-audit.ts` + `skills/_brain-filing-rules.json` (v0.19) — Check 6 of `check-resolvable`. Parses new `writes_pages:` / `writes_to:` frontmatter on skills and audits their filing claims against the filing-rules JSON. Warning-only in v0.19, upgrades to error in v0.20.
- `src/core/dry-fix.ts` — `gbrain doctor --fix` engine. `autoFixDryViolations(fixes, {dryRun})` rewrites inlined rules to `> **Convention:** see [path](path).` callouts via three shape-aware expanders (bullet / blockquote / paragraph). Five guards: working-tree-dirty (`getWorkingTreeStatus()` returns 3-state `'clean' | 'dirty' | 'not_a_repo'`), no-git-backup, inside-code-fence, already-delegated (40-line proximity, consistent with detector), ambiguous-multi-match, block-is-callout. `execFileSync` array args (no shell — no injection surface). EOF newline preserved.
- `src/core/backoff.ts` — Adaptive load-aware throttling: CPU/memory checks, exponential backoff, active hours multiplier
- `src/core/fail-improve.ts` — Deterministic-first, LLM-fallback loop with JSONL failure logging and auto-test generation
- `src/core/transcription.ts` — Audio transcription: Groq Whisper (default), OpenAI fallback, ffmpeg segmentation for >25MB
- `src/core/enrichment-service.ts` — Global enrichment service: entity slug generation, tier auto-escalation, batch throttling
- `src/core/data-research.ts` — Recipe validation, field extraction (MRR/ARR regex), dedup, tracker parsing, HTML stripping
- `src/commands/embed.ts` — `gbrain embed [--stale|--all] [--slugs ...]`. v0.22.1 (#409, contributed by @atrevino47): `--stale` path now starts with `engine.countStaleChunks()` (single SELECT count(*) WHERE embedding IS NULL, ~50 bytes wire). On a fully-embedded brain that's a 1-line short-circuit — no further reads. When stale chunks exist, `engine.listStaleChunks()` returns just the chunks needing embeddings (slug + chunk_index + chunk_text + metadata, no `vector(1536)` payload). Caller groups by slug, embeds via OpenAI, re-upserts via `upsertChunks`. Replaces the prior page-walk that pulled every chunk's embedding column over the wire and discarded most.
- `src/commands/extract.ts` — `gbrain extract links|timeline|all [--source fs|db]`: batch link/timeline extraction. fs walks markdown files, db walks pages from the engine (mutation-immune snapshot iteration; use this for live brains with no local checkout). As of v0.12.1 there is no in-memory dedup pre-load — candidates are buffered 100 at a time and flushed via `addLinksBatch` / `addTimelineEntriesBatch`; `ON CONFLICT DO NOTHING` enforces uniqueness at the DB layer, and the `created` counter returns real rows inserted (truthful on re-runs). v0.22.1 (#417): `ExtractOpts.slugs?: string[]` enables incremental extract — when set, `extractForSlugs()` reads ONLY those slugs' files (single combined links+timeline pass) instead of the full directory walk. CLI `gbrain extract` keeps full-walk behavior; the cycle path threads sync's `pagesAffected` through. `walkMarkdownFiles(brainDir)` still runs at line 455 to build `allSlugs` for link resolution — see `TODOS.md` for replacing it with `engine.getAllSlugs()`.
- `src/commands/graph-query.ts` — `gbrain graph-query <slug> [--type T] [--depth N] [--direction in|out|both]`: typed-edge relationship traversal (renders indented tree)
- `src/core/link-extraction.ts` — shared library for the v0.12.0 graph layer. extractEntityRefs (canonical, replaces backlinks.ts duplicate) matches both `[Name](people/slug)` markdown links and Obsidian `[[people/slug|Name]]` wikilinks as of v0.12.3. extractPageLinks, inferLinkType heuristics (attended/works_at/invested_in/founded/advises/source/mentions), parseTimelineEntries, isAutoLinkEnabled config helper. `DIR_PATTERN` covers `people`, `companies`, `deals`, `topics`, `concepts`, `projects`, `entities`, `tech`, `finance`, `personal`, `openclaw`. Used by extract.ts, operations.ts auto-link post-hook, and backlinks.ts.
- `src/core/minions/` — Minions job queue: BullMQ-inspired, Postgres-native (queue, worker, backoff, types, protected-names, quiet-hours, stagger, handlers/shell).
- `src/core/minions/queue.ts` — MinionQueue class (submit, claim, complete, fail, stall detection, parent-child, depth/child-cap, per-job timeouts, cascade-kill, attachments, idempotency keys, child_done inbox, removeOnComplete/Fail). `add()` takes a 4th `trusted` arg (separate from `opts` to prevent spread leakage); protected names in `PROTECTED_JOB_NAMES` require `{allowProtectedSubmit: true}` and the check runs trim-normalized (whitespace-bypass safe). v0.14.1 #219: `add()` plumbs `max_stalled` through with a `[1, 100]` clamp; omitted values let the schema DEFAULT (5) kick in. v0.19.0: `handleWallClockTimeouts(lockDurationMs)` is Layer 3 kill shot for jobs where `FOR UPDATE SKIP LOCKED` stall detection and the timeout sweep both fail to evict (wedged worker holding a row lock via a pending transaction). v0.19.1: `maxWaiting` coalesce path now uses `pg_advisory_xact_lock` keyed on `(name, queue)` to serialize concurrent submits for the same key, and filters on `queue` in addition to `name` so cross-queue same-name jobs don't suppress each other.
- `src/core/minions/worker.ts` — MinionWorker class (handler registry, lock renewal, graceful shutdown, timeout safety net). v0.14.0 abort-path fix: aborted jobs now call `failJob` with reason (`timeout`/`cancel`/`lock-lost`/`shutdown`) instead of returning silently. `shutdownAbort` (instance field) fires on process SIGTERM/SIGINT and propagates to `ctx.shutdownSignal` — shell handler listens to it; non-shell handlers don't. v0.22.1 (#403): per-job timeout fires `abort.abort(new Error('timeout'))` then a 30-second grace-then-evict safety net force-evicts the job from `inFlight` and marks it dead in DB if the handler ignores the abort signal — frees the slot even when a handler wedges (the 98-waiting-0-active prod incident driver).
- `src/core/minions/supervisor.ts` — MinionSupervisor process manager. Spawns `gbrain jobs work` as a child, restarts on crash with exponential backoff, periodic health check. v0.22.1 (#406): `consecutiveHealthFailures` counter; on 3 consecutive failures emits `health_warn` with `reason: 'db_connection_degraded'` and calls `engine.reconnect()` to swap in a fresh pool, then resets the counter. Worker exit classifier emits `likely_cause` field on `worker_exited` events: `oom_or_external_kill` (SIGKILL), `graceful_shutdown` (SIGTERM), `runtime_error` (code 1), `clean_exit` (code 0), `unknown`.
- `src/core/minions/types.ts` — `MinionJobInput` + `MinionJobStatus` + handler context types. `MinionJobInput.max_stalled` (new in v0.14.1) is optional; omitted values let the schema DEFAULT (5) kick in, provided values are clamped to `[1, 100]`.
- `src/core/minions/protected-names.ts` — side-effect-free constant module exporting `PROTECTED_JOB_NAMES` + `isProtectedJobName()`. Kept pure so queue core can import without loading handler modules.
- `src/core/minions/handlers/shell.ts` — `shell` job handler. Spawns `/bin/sh -c cmd` (absolute path, PATH-override-safe) or `argv[0] argv[1..]` (no shell). Env allowlist: `PATH, HOME, USER, LANG, TZ, NODE_ENV` + caller `env:` overrides. UTF-8-safe stdout/stderr tail via `string_decoder.StringDecoder`. Abort (either `ctx.signal` or `ctx.shutdownSignal`) fires SIGTERM → 5s grace → SIGKILL on child. Requires `GBRAIN_ALLOW_SHELL_JOBS=1` on worker (gated by `registerBuiltinHandlers`).
- `src/core/minions/handlers/shell-audit.ts` — per-submission JSONL audit trail at `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl` (ISO-week rotation; override via `GBRAIN_AUDIT_DIR`). Best-effort: `mkdirSync(recursive)` + `appendFileSync`; failures logged to stderr, submission not blocked. Logs cmd (first 80 chars) or argv (JSON array). Never logs env values.
- `src/core/minions/backpressure-audit.ts` (v0.19.1) — sibling of shell-audit.ts for `maxWaiting` coalesce events. JSONL at `~/.gbrain/audit/backpressure-YYYY-Www.jsonl`. Fires one line per coalesce with `(queue, name, waiting_count, max_waiting, returned_job_id, ts)`. Closes the silent-drop vector the v0.19.0 maxWaiting guard introduced.
- `src/core/minions/handlers/subagent.ts` (v0.15) — LLM-loop handler. Two-phase tool persistence (pending → complete/failed), replay reconciliation for mid-dispatch crashes, dual-signal abort (`ctx.signal` + `ctx.shutdownSignal`), Anthropic prompt caching on system + tool defs. `makeSubagentHandler({engine, client?, ...})` factory; `MessagesClient` is an injectable interface the real SDK implements structurally. Throws `RateLeaseUnavailableError` (renewable) when rate-lease capacity is full.
- `src/core/minions/handlers/subagent-aggregator.ts` (v0.15) — `subagent_aggregator` handler. Claims AFTER all children resolve (queue changes guarantee every terminal child posts a `child_done` inbox message with outcome). Reads inbox via `ctx.readInbox()`, builds deterministic mixed-outcome markdown summary. No LLM call in v0.15.
- `src/core/minions/handlers/subagent-audit.ts` (v0.15) — JSONL audit + heartbeat writer at `~/.gbrain/audit/subagent-jobs-YYYY-Www.jsonl`. Events: `submission` (one line per submit) + `heartbeat` (per turn boundary: `llm_call_started | llm_call_completed | tool_called | tool_result | tool_failed`). Never logs prompts or tool inputs. `readSubagentAuditForJob(jobId, {sinceIso})` is the readback path for `gbrain agent logs`.
- `src/core/minions/rate-leases.ts` (v0.15) — lease-based concurrency cap for outbound providers (default key `anthropic:messages`, max via `GBRAIN_ANTHROPIC_MAX_INFLIGHT`). Owner-tagged rows with `expires_at` auto-prune on acquire; `pg_advisory_xact_lock` guards check-then-insert; CASCADE on owning job deletion. `renewLeaseWithBackoff` retries 3x (250/500/1000ms).
- `src/core/minions/wait-for-completion.ts` (v0.15) — poll-until-terminal helper for CLI callers. `TimeoutError` does NOT cancel the job; `AbortSignal` exits without throwing. Default `pollMs`: 1000 on Postgres, 250 on PGLite inline.
- `src/core/minions/transcript.ts` (v0.15) — renders `subagent_messages` + `subagent_tool_executions` to markdown. Tool rows splice under their owning assistant `tool_use` by `tool_use_id`. UTF-8-safe truncation; unknown block types fall through to fenced JSON.
- `src/core/minions/plugin-loader.ts` (v0.15) — `GBRAIN_PLUGIN_PATH` discovery. Absolute paths only, left-wins collision, `gbrain.plugin.json` with `plugin_version: "gbrain-plugin-v1"`, plugins ship DEFS only (no new tools), `allowed_tools:` validated at load time against the derived registry.
- `src/core/minions/tools/brain-allowlist.ts` (v0.15, extended v0.23) — derives subagent tool registry from `src/core/operations.ts`. 11-name allow-list. By default `put_page` schema is namespace-wrapped per subagent (`^wiki/agents/<subagentId>/.+`). **v0.23 trusted-workspace path:** when `BuildBrainToolsOpts.allowedSlugPrefixes` is set, the put_page schema instead describes the prefix list to the model and the OperationContext is threaded with `allowedSlugPrefixes`. Trust comes from `PROTECTED_JOB_NAMES` gating subagent submission — MCP cannot reach this field. Only cycle.ts (synthesize/patterns) and direct CLI submitters set it.
- `src/mcp/tool-defs.ts` (v0.15) — extracted `buildToolDefs(ops)` helper. MCP server + subagent tool registry both call it; byte-for-byte equivalence pinned by `test/mcp-tool-defs.test.ts`.
- `src/core/minions/attachments.ts` — Attachment validation (path traversal, null byte, oversize, base64, duplicate detection)
- `src/commands/agent.ts` (v0.16) — `gbrain agent run <prompt> [flags]` CLI. Submits `subagent` (or N children + 1 aggregator) under `{allowProtectedSubmit: true}`. Single-entry `--fanout-manifest` short-circuits. Children get `on_child_fail: 'continue'` + `max_stalled: 3`. `--follow` is the default on TTY; streams logs + polls `waitForCompletion` in parallel. Ctrl-C detaches, does not cancel.
- `src/commands/agent-logs.ts` (v0.16) — `gbrain agent logs <job> [--follow] [--since]`. Merges JSONL heartbeat audit + `subagent_messages` into a chronological timeline. `parseSince` accepts ISO-8601 or relative (`5m`, `1h`, `2d`). Transcript tail renders only for terminal jobs.
- `src/commands/jobs.ts` — `gbrain jobs` CLI subcommands + `gbrain jobs work` daemon. v0.13.1 surfaces the full `MinionJobInput` retry/backoff/timeout/idempotency surface as first-class CLI flags on `jobs submit`: `--max-stalled`, `--backoff-type fixed|exponential`, `--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key`. `jobs smoke --sigkill-rescue` is the opt-in regression guard for #219. v0.16 wires `registerBuiltinHandlers` to always register `subagent` + `subagent_aggregator` (no env flag — `ANTHROPIC_API_KEY` is the natural cost gate, trust is via `PROTECTED_JOB_NAMES`) and loads `GBRAIN_PLUGIN_PATH` plugins at worker startup with a loud startup-line per plugin. `shell` handler still gated by `GBRAIN_ALLOW_SHELL_JOBS=1` (RCE surface, separate concern). v0.22.10 (#521): the `autopilot-cycle` handler now forwards `job.data.phases` to `runCycle` (was previously discarded — caller-supplied phase selection silently became a full cycle). Phases are validated against `ALL_PHASES` from `src/core/cycle.ts`; invalid names are filtered out and an empty/missing array falls back to the default 6-phase cycle. v0.22.13 (PR #490 CODEX-1+CODEX-4): `sync` handler now resolves `sourceId` at entry by looking up `sources.local_path` (mirrors `cycle.ts:480`'s autopilot fix from PR #475) so multi-source brains read the per-source `last_commit` anchor instead of the global config key. Concurrency routed through the shared `autoConcurrency()` policy in `src/core/sync-concurrency.ts` instead of the prior hardcoded `4`; PGLite stays serial. `noEmbed` default is `true` (embed is a separate job — submit `gbrain embed --stale` after sync, or rely on the autopilot cycle's embed phase).
- `src/commands/features.ts` — `gbrain features --json --auto-fix`: usage scan + feature adoption salesman
- `src/commands/autopilot.ts` — `gbrain autopilot --install`: self-maintaining brain daemon (sync+extract+embed)
- `src/mcp/server.ts` — MCP stdio server (generated from operations). v0.22.7: tool-call handler delegates to `dispatchToolCall` from `src/mcp/dispatch.ts` so stdio + HTTP transports share one validation, context-build, and error-format path.
- `src/mcp/dispatch.ts` (v0.22.7) — Shared tool-call dispatch consumed by both stdio (`server.ts`) and HTTP transports. Exports `dispatchToolCall(engine, name, params, opts)`, `buildOperationContext(engine, params, opts)`, and `validateParams(op, params)`. Single source of truth for `(ctx, params)` handler arg order and the 5-field `OperationContext` shape (engine + config + logger + dryRun + remote). Defaults to `remote: true` (untrusted); local CLI callers pass `remote: false`. Closed F1/F2/F3 drift bugs in the original v0.22.5 HTTP transport.
- `src/mcp/rate-limit.ts` (v0.22.7) — Bounded-LRU token-bucket limiter. `buildDefaultLimiters()` returns the two-bucket pipeline: pre-auth IP (30/60s, fires BEFORE the DB lookup so brute-force load against `access_tokens` is actually capped) + post-auth token-id (60/60s). Tracks `lastTouchedMs` separately from `lastRefillMs` so an exhausted key can't be reset by hammering past the TTL. LRU cap bounds memory under attacker-controlled key growth.
- `src/commands/serve-http.ts` (v0.26.0) — Express 5 HTTP MCP server with OAuth 2.1, admin dashboard, and SSE live activity feed. Started via `gbrain serve --http [--port N] [--token-ttl N] [--enable-dcr] [--public-url URL]`. Supersedes the v0.22.7 `src/mcp/http-transport.ts` simple bearer-auth path. Combines MCP SDK's `mcpAuthRouter` (authorize / token / register / revoke endpoints), a custom `client_credentials` handler (SDK's token endpoint throws `UnsupportedGrantTypeError` for CC; the custom handler runs BEFORE the router and falls through for `auth_code` / `refresh_token`), `requireBearerAuth` middleware for `/mcp` with scope enforcement before op dispatch, `localOnly` rejection, and `express-rate-limit` at 50 req / 15 min on `/token`. Serves the built admin SPA from `admin/dist/` with SPA fallback. `/admin/events` SSE endpoint broadcasts every MCP request to connected admin browsers. `cookie-parser` middleware wired (Express 5 has no built-in). Startup logging prints port, engine, configured issuer URL (honors `--public-url`), registered-client count, DCR status, and admin bootstrap token.
- `src/core/oauth-provider.ts` (v0.26.0) — `GBrainOAuthProvider` implementing the MCP SDK's `OAuthServerProvider` + `OAuthRegisteredClientsStore` interfaces. Backed by raw SQL (works on both PGLite and Postgres — OAuth is infrastructure, not a BrainEngine concern). Full OAuth 2.1 spec: `authorize` + `exchangeAuthorizationCode` with PKCE (for ChatGPT), `client_credentials` (for Perplexity / Claude), `refresh_token` with rotation, `revokeToken`, `registerClient` (DCR path validates redirect_uri must be `https://` or loopback per RFC 6749 §3.1.2.1). All tokens + client secrets SHA-256 hashed before storage. Auth codes single-use with 10-minute TTL via atomic `DELETE...RETURNING` (closes RFC 6749 §10.5 TOCTOU race). Refresh rotation also `DELETE...RETURNING` (closes §10.4 stolen-token detection bypass). `pgArray()` escapes commas/quotes/braces in elements so a comma-bearing redirect_uri can't smuggle a second array element. Legacy `access_tokens` fallback in `verifyAccessToken` grandfathers pre-v0.26 bearer tokens as `read+write+admin`. `sweepExpiredTokens()` runs on startup wrapped in try/catch. **v0.26.2:** module-private `coerceTimestamp()` boundary helper at the top of the file normalizes postgres-driver-as-string BIGINT columns to JS numbers at every read site (5 call sites: `getClient` L112+L113 for DCR `/register` RFC 7591 §3.2.1 numeric timestamps, `exchangeRefreshToken` L274 + `verifyAccessToken` L296+L303 for the SDK's `typeof === 'number'` bearerAuth check). Throws on non-finite input (NaN/Infinity) so corrupt rows fail loud at the boundary instead of riding through as `expiresAt: NaN`; returns undefined for SQL NULL so callers decide NULL semantics explicitly (refresh + access token paths treat NULL as expired). Helper intentionally NOT promoted to `src/core/utils.ts` — codex review flagged repo-wide BIGINT precision-loss risk for a generic helper.
- `admin/` (v0.26.0) — React 19 + Vite + TypeScript admin SPA embedded in the binary via `admin/dist/` served by `serve-http.ts`. 7 screens: Login (bootstrap token → session cookie), Dashboard (metrics + SSE feed + token health), Agents (sortable table + sparklines + Register button), Register (modal with scope checkboxes + grant type selector), Credentials reveal (full-screen modal with Copy + Download JSON + yellow one-time-only warning), Request Log (filterable paginated), Agent Detail drawer (Details / Activity / Config Export tabs + Revoke). Design tokens: `#0a0a0f` bg, Inter for UI, JetBrains Mono for data, 4-32px spacing scale, rounded pill badges. HTTP-only SameSite=Strict cookie auth. 65KB gzip. Build: `cd admin && bun install && bun run build`; output at `admin/dist/` is committed for self-contained binaries.
- `src/commands/auth.ts` — Token management. `gbrain auth create/list/revoke/test` for legacy bearer tokens (v0.22.7 wired as a first-class CLI subcommand) plus `gbrain auth register-client` (v0.26.0) and `gbrain auth revoke-client <client_id>` (v0.26.2) for OAuth 2.1 client lifecycle. `revoke-client` runs an atomic `DELETE...RETURNING` on `oauth_clients`; FK `ON DELETE CASCADE` on `oauth_tokens.client_id` and `oauth_codes.client_id` purges every active token + authorization code in a single transaction. `process.exit(1)` on no-such-client (idempotent — re-running on the same id produces the same exit-1 message). Legacy tokens stored as SHA-256 hashes in `access_tokens`; OAuth clients in `oauth_clients`. As of v0.26.0, legacy tokens grandfather to `read+write+admin` scopes on the OAuth HTTP server, so pre-v0.26 deployments keep working with no migration.
- `src/commands/upgrade.ts` — Self-update CLI. `runPostUpgrade()` enumerates migrations from the TS registry (src/commands/migrations/index.ts) and tail-calls `runApplyMigrations(['--yes', '--non-interactive'])` so the mechanical side of every outstanding migration runs unconditionally.
- `src/commands/migrations/` — TS migration registry (compiled into the binary; no filesystem walk of `skills/migrations/*.md` needed at runtime). `index.ts` lists migrations in semver order. `v0_11_0.ts` = Minions adoption orchestrator (8 phases). `v0_12_0.ts` = Knowledge Graph auto-wire orchestrator (5 phases: schema → config check → backfill links → backfill timeline → verify). `phaseASchema` has a 600s timeout (bumped from 60s in v0.12.1 for duplicate-heavy brains). `v0_12_2.ts` = JSONB double-encode repair orchestrator (4 phases: schema → repair-jsonb → verify → record). `v0_14_0.ts` = shell-jobs + autopilot cooperative (2 phases: schema ALTER minion_jobs.max_stalled SET DEFAULT 3 — superseded by v0.14.3's schema-level DEFAULT 5 + UPDATE backfill; pending-host-work ping for skills/migrations/v0.14.0.md). All orchestrators are idempotent and resumable from `partial` status. As of v0.14.2 (Bug 3), the RUNNER owns all ledger writes — orchestrators return `OrchestratorResult` and `apply-migrations.ts` persists a canonical `{version, status, phases}` shape after return. Orchestrators no longer call `appendCompletedMigration` directly. `statusForVersion` prefers `complete` over `partial` (never regresses). 3 consecutive partials → wedged → `--force-retry <version>` writes a `'retry'` reset marker. v0.14.3 (fix wave) ships schema-only migrations v14 (`pages_updated_at_index`) + v15 (`minion_jobs_max_stalled_default_5` with UPDATE backfill) via the `MIGRATIONS` array in `src/core/migrate.ts` — no orchestrator phases needed.
- `src/commands/repair-jsonb.ts` — `gbrain repair-jsonb [--dry-run] [--json]`: rewrites `jsonb_typeof='string'` rows in place across 5 affected columns (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter). Fixes v0.12.0 double-encode bug on Postgres; PGLite no-ops. Idempotent.
- `src/commands/orphans.ts` — `gbrain orphans [--json] [--count] [--include-pseudo]`: surfaces pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. Shipped in v0.12.3 (contributed by @knee5).
- `src/commands/integrity.ts` — `gbrain integrity check|auto|review|extract`: bare-tweet detection, dead-link detection, three-bucket repair (auto-repair / review-queue / skip). `scanIntegrity()` is the shared library function called from `gbrain doctor` (sampled at limit=500) and `cmdCheck` (full scan). v0.22.8: batch-load fast path on Postgres uses `SELECT DISTINCT ON (slug)` in a single SQL query to fix the PgBouncer round-trip timeout (60s → ~6s) while preserving `engine.getAllSlugs()`'s `Set<string>` semantics on multi-source brains. Gated by `engine.kind === 'postgres'` at the call site so PGLite never enters batch; fallback `catch` logs at `GBRAIN_DEBUG=1` so real Postgres errors are diagnosable.
- `src/commands/doctor.ts` — `gbrain doctor [--json] [--fast] [--fix] [--dry-run] [--index-audit]`: health checks. v0.12.3 added `jsonb_integrity` + `markdown_body_completeness` reliability checks. v0.14.1: `--fix` delegates inlined cross-cutting rules to `> **Convention:** see [path](path).` callouts (pipes DRY violations into `src/core/dry-fix.ts`); `--fix --dry-run` previews without writing. v0.14.2: `schema_version` check fails loudly when `version=0` (migrations never ran — the #218 `bun install -g` signature) and routes users to `gbrain apply-migrations --yes`; new opt-in `--index-audit` flag (Postgres-only) reports zero-scan indexes from `pg_stat_user_indexes` (informational only, no auto-drop). v0.15.2: every DB check is wrapped in a progress phase; `markdown_body_completeness` runs under a 1s heartbeat timer so 10+ min scans are observable on 50K-page brains. v0.19.1 added `queue_health` (Postgres-only) with two subchecks: stalled-forever active jobs (started_at > 1h) and waiting-depth-per-name > threshold (default 10, override via `GBRAIN_QUEUE_WAITING_THRESHOLD`). Worker-heartbeat subcheck intentionally deferred to follow-up B7 because it needs a `minion_workers` table to produce ground-truth signal. Fix hints point at `gbrain repair-jsonb`, `gbrain sync --force`, `gbrain apply-migrations`, and `gbrain jobs get/cancel <id>`. v0.22.12 (#500): `sync_failures` check shows `[CODE=N, ...]` breakdown for both unacked entries (warn) and acked-historical entries (ok), surfacing systemic failure modes (`SLUG_MISMATCH=2685`) instead of a bare count. v0.26.7 (#612): `rls_event_trigger` check (post-install drift detector for migration v35's auto-RLS event trigger). Lives outside the `// 5. RLS` slice that the structural doctor.test.ts guards anchor on, so the existing test guards stay intact. Healthy `evtenabled` set is `('O','A')` only — `R` is replica-only and would not fire in normal sessions; `D` is disabled. Fix hint is `gbrain apply-migrations --force-retry 35`.
- `src/core/migrate.ts` — schema-migration runner. Owns the `MIGRATIONS` array (source of truth for schema DDL). v0.14.2 extended the `Migration` interface with `sqlFor?: { postgres?, pglite? }` (engine-specific SQL overrides `sql`) and `transaction?: boolean` (set to false for `CREATE INDEX CONCURRENTLY`, which Postgres refuses inside a transaction; ignored on PGLite since it has no concurrent writers). Migration v14 (fix wave) uses a handler branching on `engine.kind` to run CONCURRENTLY on Postgres (with a pre-drop of any invalid remnant via `pg_index.indisvalid`) and plain `CREATE INDEX` on PGLite. v15 bumps `minion_jobs.max_stalled` default 1→5 and backfills existing non-terminal rows. v0.22.6.1: migration v24 (`rls_backfill_missing_tables`) uses `sqlFor: { pglite: '' }` to no-op on PGLite — PGLite has no RLS engine and is single-tenant by definition, and the v24 ALTERs target subagent tables that don't exist in pglite-schema.ts. Closes #395 (contributed by @jdcastro2). **v30 (v0.23):** creates `dream_verdicts (file_path TEXT, content_hash TEXT, worth_processing BOOL, reasons JSONB, judged_at TIMESTAMPTZ, PK(file_path, content_hash))`. RLS-enabled when running as a BYPASSRLS role. The synthesize phase reads/writes this table to avoid re-judging on backfill re-runs. **v35 (v0.26.7):** auto-RLS event trigger + one-time backfill. `auto_rls_on_create_table` fires on `ddl_command_end` for `WHEN TAG IN ('CREATE TABLE','CREATE TABLE AS','SELECT INTO')` and runs `ALTER TABLE … ENABLE ROW LEVEL SECURITY` on every new `public.*` table — no FORCE (matches v24/v29/schema.sql posture so non-BYPASSRLS apps can still read their own tables). The same migration backfills RLS on every existing `public.*` base table whose comment doesn't match the doctor regex (`^GBRAIN:RLS_EXEMPT\s+reason=\S.{3,}`). Per-table failure aborts the offending CREATE TABLE (event triggers fire inside the DDL transaction); no EXCEPTION wrap — that would convert loud rollback into silent permissive default. PGLite no-op via `sqlFor.pglite: ''`. Breaking change: operators with intentionally-RLS-off public tables must add the GBRAIN:RLS_EXEMPT comment BEFORE upgrade or the backfill will flip them on.
- `src/core/progress.ts` — Shared bulk-action progress reporter. Writes to stderr. Modes: `auto` (TTY: `\r`-rewriting; non-TTY: plain lines), `human`, `json` (JSONL), `quiet`. Rate-gated by `minIntervalMs` and `minItems`. `startHeartbeat(reporter, note)` helper for single long queries. `child()` composes phase paths. Singleton SIGINT/SIGTERM coordinator emits `abort` events for every live phase. EPIPE defense on both sync throws and stream `'error'` events. Zero dependencies. Introduced in v0.15.2.
- `src/core/cli-options.ts` — Global CLI flag parser. `parseGlobalFlags(argv)` returns `{cliOpts, rest}` with `--quiet` / `--progress-json` / `--progress-interval=<ms>` stripped. `getCliOptions()` / `setCliOptions()` expose a module-level singleton so commands reach the resolved flags without parameter threading. `cliOptsToProgressOptions()` maps to reporter options. `childGlobalFlags()` returns the flag suffix to append to `execSync('gbrain ...')` calls in migration orchestrators. `OperationContext.cliOpts` extends shared-op dispatch for MCP callers.
- `src/core/db-lock.ts` (v0.22.13) — generic `tryAcquireDbLock(engine, lockId, ttlMinutes)` over the existing `gbrain_cycle_locks` table. Parameterized lock id so different scopes can nest cleanly: `gbrain-cycle` for the broad cycle (held by `cycle.ts`) and `gbrain-sync` (`SYNC_LOCK_ID` constant) for `performSync`'s narrower writer window. Same UPSERT-with-TTL semantics as the prior cycle-only helper, just generalized. Survives PgBouncer transaction pooling (unlike session-scoped `pg_try_advisory_lock`); crashed holders auto-release once their TTL expires.
- `src/core/sync-concurrency.ts` (v0.22.13) — single source of truth for the parallel-sync policy. Exports `autoConcurrency(engine, fileCount, override?)` (PGLite always serial; explicit override clamped to >=1; auto path returns `DEFAULT_PARALLEL_WORKERS=4` when `fileCount > AUTO_CONCURRENCY_FILE_THRESHOLD=100`), `shouldRunParallel(workers, fileCount, explicit)` (Q1: explicit `--workers` bypasses the >50-file floor), and `parseWorkers(s)` (rejects `'0'`, `'-3'`, `'foo'`, `'1.5'`, trailing chars — replaces the prior parseInt-with-no-validation in both `sync.ts` and `import.ts`). Used by `performSync`, `performFullSync`, `runImport`, and the Minion `sync` handler so the three sites can no longer drift.
- `src/commands/sync.ts` — `gbrain sync` CLI + the `performSync` / `performFullSync` library entrypoints (consumed by the autopilot cycle and the Minion sync handler). v0.22.13 (PR #490): `performSync` wraps its body in a `gbrain-sync` writer lock so two concurrent syncs (manual + autopilot, two terminals, two Conductor workspaces) cannot both write `last_commit` and let the last writer win. Head-drift gate after the import phase re-checks `git rev-parse HEAD`; if HEAD moved (someone ran `git checkout` / `git pull` mid-sync), the bookmark refuses to advance. Vanished files now record a failedFiles entry instead of silent-skip — the silent-skip-then-advance pathology that survived prior hardening passes is dead. Worker engines wrap in try/finally so disconnect always fires (panic-path leak fix). Both PGLite-detection sites use `engine.kind === 'pglite'`. CLI accepts `--workers N` (alias `--concurrency N`), validated via `parseWorkers`. Explicit `--workers` bypasses the auto-path file-count floor; auto path defers to `autoConcurrency()`. Banner moved to stderr.
- `src/core/cycle.ts` — v0.17 brain maintenance cycle primitive (extended to **8 phases in v0.23**). `runCycle(engine: BrainEngine | null, opts: CycleOpts): Promise<CycleReport>` composes phases in semantically-driven order: **lint → backlinks → sync → synthesize → extract → patterns → embed → orphans**. v0.23's `synthesize` phase runs after sync (cross-references see fresh brain) and before extract (auto-link materializes its writes); `patterns` runs after extract so it reads a fresh graph (codex finding #7 — subagent put_page sets `ctx.remote=true` and skips auto-link/timeline by default; extract is the canonical materialization). Three callers: `gbrain dream` CLI, `gbrain autopilot` daemon's inline path, and the Minions `autopilot-cycle` handler. Coordination via `gbrain_cycle_locks` DB table + `~/.gbrain/cycle.lock` file lock with PID-liveness for PGLite. `CycleReport.schema_version: "1"` is stable; totals additively grew in v0.23 (`transcripts_processed`, `synth_pages_written`, `patterns_written`). `yieldBetweenPhases` runs between phases. **v0.23 added `yieldDuringPhase`** for in-phase keepalive — synthesize/patterns call it during long waits to renew the cycle-lock TTL. Engine nullable; lock-skip on read-only phase selections. v0.22.1 (#403): `CycleOpts.signal?: AbortSignal` propagates the worker's abort signal; `checkAborted()` fires between every phase. v0.22.1 (#417): `runPhaseSync` returns `pagesAffected` via `SyncPhaseResult`; `runCycle` captures it and threads to `runPhaseExtract` as the 4th arg. v0.22.1 (Codex F2): `runPhaseSync` takes `willRunExtractPhase: boolean` and sets `noExtract: phases.includes('extract')` so `gbrain dream --phase sync` doesn't silently lose extraction. v0.22.5 (#475): `resolveSourceForDir(engine, brainDir)` threads `sourceId` to `performSync()` so sync reads the per-source `sources.last_commit` anchor instead of the drift-prone global `config.sync.last_commit` key.
- `src/core/cycle/synthesize.ts` (v0.23) — Synthesize phase: conversation-transcript-to-brain pipeline. Reads from `dream.synthesize.session_corpus_dir`, runs cheap Haiku verdict (cached in `dream_verdicts`), then fans out one Sonnet subagent per worth-processing transcript with `allowed_slug_prefixes` (sourced from `skills/_brain-filing-rules.json` `dream_synthesize_paths.globs`). Orchestrator collects slugs from `subagent_tool_executions` (NOT `pages.updated_at` — codex finding #2) and reverse-renders DB → markdown via `serializeMarkdown`. Cooldown via `dream.synthesize.last_completion_ts`, written ONLY on success. Idempotency key `dream:synth:<file_path>:<content_hash>`. Auto-commit deferred to v1.1 (codex #5). `--dry-run` runs Haiku, skips Sonnet (codex #8). Subagent never gets fs-write access. **v0.23.2:** `renderPageToMarkdown` (now exported) stamps `dream_generated: true` and `dream_cycle_date` into every reverse-write's frontmatter; `writeSummaryPage` does the same on the dream-cycle summary index. The marker is the explicit identity surface checked by `isDreamOutput` in `transcript-discovery.ts` — replaces the v0.23.1 content-prefix heuristic that could miss real output (`serializeMarkdown` doesn't embed slugs in body) and false-positive on user transcripts citing brain pages. `judgeSignificance` and `JudgeClient` are exported; `judgeSignificance` accepts a `verdictModel` parameter (default `claude-haiku-4-5-20251001`) loaded from `dream.synthesize.verdict_model` via `loadSynthConfig`.
- `src/core/cycle/patterns.ts` (v0.23) — Patterns phase: cross-session theme detection over reflections within `dream.patterns.lookback_days` (default 30). Names a pattern only when ≥`dream.patterns.min_evidence` (default 3) reflections support it. Single Sonnet subagent; same allow-list path as synthesize. Runs AFTER `extract` so the graph is fresh.
- `src/core/cycle/transcript-discovery.ts` (v0.23) — Pure filesystem walk for synthesize. `discoverTranscripts(opts)` filters `.txt` files by date range, min_chars, and word-boundary regex `excludePatterns` (Q-3: `medical` matches "medical advice" but NOT "comedical"; power users may pass full regex). `readSingleTranscript(path)` is the `gbrain dream --input <file>` ad-hoc path. **v0.23.2 self-consumption guard:** `DREAM_OUTPUT_MARKER_RE` (anchored at frontmatter open `---\n`, optional BOM + CRLF tolerance, scans first 2000 chars for `dream_generated: true` with case-insensitive value and word boundary on `true`) drives `isDreamOutput(content, bypass=false)`. Both `discoverTranscripts` and `readSingleTranscript` skip matching files and emit a `[dream] skipped <basename>: dream_generated marker` stderr log (no more silent skips). `bypassGuard?: boolean` on `DiscoverOpts` and `readSingleTranscript`'s opts disables the guard for the explicit `--unsafe-bypass-dream-guard` escape hatch only — never auto-applied for `--input`. Replaces v0.23.1's `DREAM_OUTPUT_SLUGS` content-prefix list.
- `src/commands/dream.ts` — v0.17 `gbrain dream` CLI; ~80-line thin alias over `runCycle`. brainDir resolution requires explicit `--dir` OR `sync.repo_path` config. Flags: `--dry-run`, `--json`, `--phase <name>`, `--pull`, `--dir <path>`. **v0.23 added** `--input <file>` (ad-hoc transcript, implies `--phase synthesize`), `--date YYYY-MM-DD`, `--from <d> --to <d>` (backfill range). Conflict detection: `--input` + `--date` exits 2. ISO date validation. `--dry-run` runs Haiku significance verdict but skips Sonnet synthesis (codex finding #8 — NOT zero LLM calls). Exit code 1 on status=failed. **v0.23.2 added** `--unsafe-bypass-dream-guard` (long-form intentional, plumbed through `runCycle.synthBypassDreamGuard` → `SynthesizePhaseOpts.bypassDreamGuard` → `discoverTranscripts({bypassGuard})` and `readSingleTranscript({bypassGuard})`). Loud stderr warning fires at synthesize-phase entry when set. Never auto-applied for `--input` so any caller can't silently re-trigger the loop bug.
- `src/commands/friction.ts` + `src/core/friction.ts` (v0.23) — `gbrain friction {log,render,list,summary}` reporter. Append-only JSONL under `$GBRAIN_HOME/friction/<run-id>.jsonl`. Schema is a flat extension of `StructuredAgentError` (D20). Render groups by severity → phase, defaults to `--redact` for md output (strips `$HOME`/`$CWD` to placeholders so reports paste safely in PRs). Run-id resolves from `--run-id` > `$GBRAIN_FRICTION_RUN_ID` > `standalone.jsonl`. Skills the claw-test exercises gain a `_friction-protocol.md` callout so agents know when to log friction.
- `src/commands/claw-test.ts` + `src/core/claw-test/` (v0.23) — `gbrain claw-test [--scenario <name>] [--live --agent openclaw]`. End-to-end "fresh user" friction harness. Two modes: scripted (CI gate, agent-free) and live (real openclaw subprocess, $1–2 in tokens). Sets `GBRAIN_HOME=<tempdir>` for hermeticity and captures gbrain's `--progress-json` events from each child's stderr to verify expected phases ran (`import.files`, `extract.links_fs`, `doctor.db_checks`). Phases for scripted mode: setup → install_brain (`gbrain init --pglite`) → import (`--no-embed`) → query → extract → verify (`gbrain doctor --json`, asserts `status: 'ok'`) → render. Live mode hands `BRIEF.md` from `test/fixtures/claw-test-scenarios/<name>/` to the agent runner. v1 ships with the OpenClaw runner only (`src/core/claw-test/runners/openclaw.ts`, invokes `openclaw agent --local --agent <name> --message <brief>`); hermes runner deferred to v1.1. Transcript capture (`transcript-capture.ts`) uses `fs.createWriteStream` with `'drain'`-event backpressure — D17 fix for the 256KB-burst child-stall scenario. v0.18 upgrade scenario seeded via `seed-pglite.ts` SQL replay.
- `skills/_friction-protocol.md` (v0.23) — shared cross-cutting convention skill (like `_brain-filing-rules.md`). Tells agents when to call `gbrain friction log` and how to choose a severity. Routes to friction CLI from any skill the claw-test exercises.
- `scripts/check-progress-to-stdout.sh` — CI guard against regressing to `\r`-on-stdout progress. Wired into `bun run test` via `scripts/check-progress-to-stdout.sh && bun test` in package.json.
- `docs/progress-events.md` — Canonical JSON event schema reference. Stable from v0.15.2, additive only.
- `src/core/markdown.ts` — Frontmatter parsing + body splitter. `splitBody` requires an explicit timeline sentinel (`<!-- timeline -->`, `--- timeline ---`, or `---` immediately before `## Timeline`/`## History`). Plain `---` in body text is a markdown horizontal rule, not a separator. `inferType` auto-types `/wiki/analysis/` → analysis, `/wiki/guides/` → guide, `/wiki/hardware/` → hardware, `/wiki/architecture/` → architecture, `/writing/` → writing (plus the existing people/companies/deals/etc heuristics).
- `scripts/check-jsonb-pattern.sh` — CI grep guard. Fails the build if anyone reintroduces (a) the `${JSON.stringify(x)}::jsonb` interpolation pattern (postgres.js v3 double-encodes it), or (b) `max_stalled INTEGER NOT NULL DEFAULT 1` in any schema source file (v0.15.1 #219 regression guard — must be DEFAULT 5 to preserve SIGKILL-rescue). Wired into `bun test`.
- `docker-compose.ci.yml` + `scripts/ci-local.sh` (v0.23.1) — Local CI gate. `bun run ci:local` spins up `pgvector/pgvector:pg16` + `oven/bun:1` with named volumes (`gbrain-ci-pg-data`, `gbrain-ci-node-modules`, `gbrain-ci-bun-cache`), runs gitleaks on host, smoke-tests `scripts/run-e2e.sh` argv handling, runs unit tests with `DATABASE_URL` unset (matches GH Actions structure), then runs all 29 E2E files sequentially. `--diff` swaps in the diff-aware selector; `--no-pull` skips upstream pulls; `--clean` nukes named volumes. Postgres host port defaults to 5434 (avoids 5432 manual `gbrain-test-pg` and 5433 sibling-project conflict); override with `GBRAIN_CI_PG_PORT=NNNN`. Stronger gate than current PR CI's 2-file Tier 1 set — closes the "push-and-wait" feedback loop pre-push.
- `scripts/select-e2e.ts` + `scripts/e2e-test-map.ts` (v0.23.1) — Diff-aware E2E test selector. Reads three git sources (committed `origin/master...HEAD`, working-tree `HEAD`, and `git ls-files --others --exclude-standard` for untracked, NOT-gitignored files), classifies as EMPTY / DOC_ONLY / SRC. Fail-closed by design: EMPTY → all 29 files (clean branch shouldn't run nothing), DOC_ONLY (every path matches the README/CLAUDE/AGENTS/CHANGELOG/TODOS allowlist) → empty stdout, SRC → escape-hatch paths (schema, package.json, skills/) trigger all; otherwise the hand-tuned `E2E_TEST_MAP` glob → tests narrows; an unmapped src/ change still emits ALL files, never silently nothing. Pure-function exports (`selectTests`, `classify`, `matchGlob`) so it's trivial to test and fork. `bun run ci:select-e2e` prints the current selection on stdout, pipe-friendly. `test/select-e2e.test.ts` covers all 4 branches plus 3 codex regression guards (skills/, untracked files, unmapped src/) — 24 cases.
- `scripts/run-e2e.sh` (v0.23.1 update) — Sequential E2E runner. Now accepts an optional argv-driven file list (used by `ci:local:diff` to pipe in selector output) and a `--dry-run-list` flag that prints the resolved file list and exits (used by `ci-local.sh`'s startup smoke-test). Falls back to `test/e2e/*.test.ts` when invoked with no args.
- `scripts/llms-config.ts` + `scripts/build-llms.ts` — Generator for `llms.txt` (llmstxt.org-spec web index) + `llms-full.txt` (inlined single-fetch bundle). Curated config drives both. Run `bun run build:llms` after adding a new doc. `LLMS_REPO_BASE` env var lets forks regenerate with their own URL base. `FULL_SIZE_BUDGET` (600KB) caps the inline bundle; generator WARNs if exceeded. Committed output is not analogous to `schema-embedded.ts` (no runtime consumer); we commit for GitHub browsing and fork-safe fetching.
- `AGENTS.md` — Local-clone entry point for non-Claude agents (Codex, Cursor, OpenClaw, Aider). Mirrors `CLAUDE.md` intent via relative links. Claude Code keeps using `CLAUDE.md`.
- `docs/UPGRADING_DOWNSTREAM_AGENTS.md` — Patches for downstream agent skill forks to apply when upgrading. Each release appends a new section. v0.10.3 includes diffs for brain-ops, meeting-ingestion, signal-detector, enrich.
- `src/core/schema-embedded.ts` — AUTO-GENERATED from schema.sql (run `bun run build:schema`)
- `src/schema.sql` — Full Postgres + pgvector DDL (source of truth, generates schema-embedded.ts)
- `src/commands/integrations.ts` — Standalone integration recipe management (no DB needed). Exports `getRecipeDirs()` (trust-tagged recipe sources), SSRF helpers (`isInternalUrl`, `parseOctet`, `hostnameToOctets`, `isPrivateIpv4`). Only package-bundled recipes are `embedded=true`; `$GBRAIN_RECIPES_DIR` and cwd `./recipes/` are untrusted and cannot run `command`/`http`/string health checks.
- `src/core/search/expansion.ts` — Multi-query expansion via Haiku. Exports `sanitizeQueryForPrompt` + `sanitizeExpansionOutput` (prompt-injection defense-in-depth). Sanitized query is only used for the LLM channel; original query still drives search.
- `recipes/` — Integration recipe files (YAML frontmatter + markdown setup instructions)
- `docs/guides/` — Individual SKILLPACK guides (broken out from monolith)
- `docs/integrations/` — "Getting Data In" guides and integration docs
- `docs/architecture/infra-layer.md` — Shared infrastructure documentation
- `docs/ethos/THIN_HARNESS_FAT_SKILLS.md` — Architecture philosophy essay
- `docs/ethos/MARKDOWN_SKILLS_AS_RECIPES.md` — "Homebrew for Personal AI" essay
- `docs/guides/repo-architecture.md` — Two-repo pattern (agent vs brain)
- `docs/guides/sub-agent-routing.md` — Model routing table for sub-agents
- `docs/guides/skill-development.md` — 5-step skill development cycle + MECE
- `docs/guides/idea-capture.md` — Originality distribution, depth test, cross-linking
- `docs/guides/quiet-hours.md` — Notification hold + timezone-aware delivery
- `docs/guides/diligence-ingestion.md` — Data room to brain pages pipeline
- `docs/designs/HOMEBREW_FOR_PERSONAL_AI.md` — 10-star vision for integration system
- `docs/mcp/` — Per-client setup guides (Claude Desktop, Code, Cowork, Perplexity)
- BrainBench (benchmark suite + corpus): lives in the separate [gbrain-evals](https://github.com/garrytan/gbrain-evals) repo. Not installed alongside gbrain.
- `skills/_brain-filing-rules.md` — Cross-cutting brain filing rules (referenced by all brain-writing skills)
- `skills/RESOLVER.md` — Skill routing table (based on the agent-fork AGENTS.md pattern)
- `skills/conventions/` — Cross-cutting rules (quality, brain-first, model-routing, test-before-bulk, cross-modal)
- `skills/_output-rules.md` — Output quality standards (deterministic links, no slop, exact phrasing)
- `skills/signal-detector/SKILL.md` — Always-on idea+entity capture on every message
- `skills/brain-ops/SKILL.md` — Brain-first lookup, read-enrich-write loop, source attribution
- `skills/idea-ingest/SKILL.md` — Links/articles/tweets with author people page mandatory
- `skills/media-ingest/SKILL.md` — Video/audio/PDF/book with entity extraction
- `skills/meeting-ingestion/SKILL.md` — Transcripts with attendee enrichment chaining
- `skills/citation-fixer/SKILL.md` — Citation format auditing and fixing
- `skills/repo-architecture/SKILL.md` — Filing rules by primary subject
- `skills/skill-creator/SKILL.md` — Create conforming skills with MECE check
- `skills/daily-task-manager/SKILL.md` — Task lifecycle with priority levels
- `skills/daily-task-prep/SKILL.md` — Morning prep with calendar context
- `skills/cross-modal-review/SKILL.md` — Quality gate via second model
- `skills/cron-scheduler/SKILL.md` — Schedule staggering, quiet hours, idempotency
- `skills/reports/SKILL.md` — Timestamped reports with keyword routing
- `skills/testing/SKILL.md` — Skill validation framework
- `skills/soul-audit/SKILL.md` — 6-phase interview for SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md
- `skills/webhook-transforms/SKILL.md` — External events to brain signals
- `skills/data-research/SKILL.md` — Structured data research: email-to-tracker pipeline with parameterized YAML recipes
- `skills/minion-orchestrator/SKILL.md` — Unified background-work skill (v0.20.4 consolidation of the former `minion-orchestrator` + `gbrain-jobs` split). Two lanes: shell jobs via `gbrain jobs submit shell --params '{"cmd":"..."}'` (operator/CLI only; MCP throws `permission_denied` for protected names) and LLM subagents via `gbrain agent run` (user-facing entrypoint). Shared Preconditions block, parent-child DAGs with depth/cap/timeouts, `child_done` inbox for fan-in, PGLite `--follow` inline path for dev. Triggers narrowed from bare `"gbrain jobs"` to `"gbrain jobs submit"` + `"submit a gbrain job"` so `stats`/`prune`/`retry` questions fall through to `gbrain --help`.
- `templates/` — SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md templates
- `skills/migrations/` — Version migration files with feature_pitch YAML frontmatter
- `src/commands/publish.ts` — Deterministic brain page publisher (code+skill pair, zero LLM calls)
- `src/commands/backlinks.ts` — Back-link checker and fixer (enforces Iron Law)
- `src/commands/lint.ts` — Page quality linter (catches LLM artifacts, placeholder dates)
- `src/commands/report.ts` — Structured report saver (audit trail for maintenance/enrichment)
- `src/core/destructive-guard.ts` (v0.26.5) — three-layer protection against accidental data loss in gbrain. `assessDestructiveImpact(engine, sourceId)` counts pages/chunks/embeddings/files for a source. `checkDestructiveConfirmation(impact, opts)` is the fail-closed gate (`--confirm-destructive` required when data is present; `--yes` alone is rejected). `softDeleteSource` / `restoreSource` / `listArchivedSources` / `purgeExpiredSources` drive the source-level archive lifecycle via the column shape introduced in migration v34 (`sources.archived BOOLEAN`, `archived_at TIMESTAMPTZ`, `archive_expires_at TIMESTAMPTZ`). v0.26.5 added the page-level analog through `BrainEngine.softDeletePage` / `restorePage` / `purgeDeletedPages` plus `pages.deleted_at TIMESTAMPTZ` and a partial purge index. The MCP `delete_page` op rewires to `softDeletePage`; new ops `restore_page` (`scope: write`) and `purge_deleted_pages` (`scope: admin`, `localOnly: true`) round out the surface. Search visibility (`buildVisibilityClause` in `src/core/search/sql-ranking.ts`) hides soft-deleted pages and archived sources from `searchKeyword` / `searchKeywordChunks` / `searchVector` in both engines. The autopilot cycle's new 9th `purge` phase calls `purgeExpiredSources` + `engine.purgeDeletedPages(72)` so the 72h TTL is real, not honor-system.
- `src/commands/pages.ts` (v0.26.5) — `gbrain pages purge-deleted [--older-than HOURS|Nd] [--dry-run] [--json]` operator escape hatch. Mirror of `gbrain sources purge` for the page-level lifecycle. Hard-deletes pages whose `deleted_at` is older than the cutoff; cascades to content_chunks/page_links/chunk_relations.
- `openclaw.plugin.json` — ClawHub bundle plugin manifest

### BrainBench — in a sibling repo (v0.20+)

BrainBench — the public benchmark for personal-knowledge agent stacks — lives in
[github.com/garrytan/gbrain-evals](https://github.com/garrytan/gbrain-evals). It
depends on gbrain as a consumer; gbrain never pulls in the ~5MB eval corpus or
the pdf-parse dev dep at install time.

gbrain's public API surface (the exports map in `package.json`) is what
gbrain-evals consumes: `gbrain/engine`, `gbrain/types`, `gbrain/operations`,
`gbrain/pglite-engine`, `gbrain/link-extraction`, `gbrain/import-file`,
`gbrain/transcription`, `gbrain/embedding`, `gbrain/config`, `gbrain/markdown`,
`gbrain/backoff`, `gbrain/search/hybrid`, `gbrain/search/expansion`,
`gbrain/extract`. Removing any of these is a breaking change for the
gbrain-evals consumer.

## Commands

Run `gbrain --help` or `gbrain --tools-json` for full command reference.

Key commands added in v0.7:
- `gbrain init` — defaults to PGLite (no Supabase needed), scans repo size, suggests Supabase for 1000+ files
- `gbrain migrate --to supabase` / `gbrain migrate --to pglite` — bidirectional engine migration

Key commands added for Minions (job queue):
- `gbrain jobs submit <name> [--params JSON] [--follow] [--dry-run]` — submit a background job. v0.13.1 adds first-class flags for every `MinionJobInput` tuning knob: `--max-stalled N`, `--backoff-type fixed|exponential`, `--backoff-delay Nms`, `--backoff-jitter 0..1`, `--timeout-ms N`, `--idempotency-key K`.
- `gbrain jobs list [--status S] [--queue Q]` — list jobs with filters
- `gbrain jobs get <id>` — job details with attempt history
- `gbrain jobs cancel/retry/delete <id>` — manage job lifecycle
- `gbrain jobs prune [--older-than 30d]` — clean old completed/dead jobs
- `gbrain jobs stats` — job health dashboard
- `gbrain jobs smoke [--sigkill-rescue]` — health smoke test. `--sigkill-rescue` is the v0.13.1 regression guard for #219: simulates a killed worker and asserts the stalled job is requeued instead of dead-lettered on first stall.
- `gbrain jobs work [--queue Q] [--concurrency N]` — start worker daemon (Postgres only)

Key commands added in v0.26.5 (destructive-guard, end-to-end):
- `gbrain sources archive <id>` — soft-delete a source. Hides from search via the new `sources.archived` column + cascading visibility filter. Preserves data for 72h. (PR #595 cherry-pick.)
- `gbrain sources restore <id> [--no-federate]` — un-archive a soft-deleted source. Re-federates by default.
- `gbrain sources archived [--json]` — list soft-deleted sources with their TTL.
- `gbrain sources purge [<id>] [--confirm-destructive]` — permanent delete; with no id, purges all sources whose TTL expired.
- `gbrain sources remove <id> [--confirm-destructive] [--dry-run]` — `--yes` alone no longer enough on populated sources. Boxed impact preview before destruction.
- `gbrain pages purge-deleted [--older-than HOURS|Nd] [--dry-run] [--json]` — operator escape hatch for page-level soft-delete cleanup. Mirror of `gbrain sources purge`. The autopilot cycle's new `purge` phase calls the same library function automatically every run.
- MCP `delete_page` op semantically shifts from hard-delete to soft-delete. New ops: `restore_page` (`scope: write`), `purge_deleted_pages` (`scope: admin`, `localOnly: true`).
- `get_page` and `list_pages` extended with `include_deleted: boolean` (default false).
- New autopilot cycle phase `purge` (9th, runs after `orphans`). `gbrain dream --phase purge` runs only the purge sweep.
- Index strategy note: the partial index `pages_deleted_at_purge_idx ON pages (deleted_at) WHERE deleted_at IS NOT NULL` supports the autopilot purge query. Search filters (`WHERE deleted_at IS NULL`) do NOT need their own index — soft-deleted cardinality stays low and Postgres won't use the partial index for the negative predicate. Don't add a regular `(deleted_at)` index without measuring.
- Schema migration v34 (`destructive_guard_columns`) adds `pages.deleted_at` + the partial purge index; promotes `archived` from `sources.config` JSONB to real columns; backfills any pre-v0.26.5 JSONB shape.

Key commands added in v0.25.0:
- `gbrain eval export [--since DUR] [--limit N] [--tool query|search]` — stream captured `eval_candidates` rows as NDJSON to stdout. Every line starts with `"schema_version": 1` per the stable contract in `docs/eval-capture.md`. EPIPE-safe, progress heartbeats on stderr, deterministic ordering. Primary consumer is the sibling `gbrain-evals` repo for BrainBench-Real replay.
- `gbrain eval prune --older-than DUR [--dry-run]` — explicit retention cleanup for `eval_candidates`. Requires `--older-than` (never deletes without a window). Duration strings: 30d, 7d, 1h, 90m, 3600s.
- `gbrain eval replay --against FILE.ndjson [--limit N] [--top-regressions K] [--json] [--verbose]` — contributor-facing dev loop. Reads a captured NDJSON snapshot, re-runs each `query` / `search` op against the current brain, computes mean set-Jaccard@k between captured + current `retrieved_slugs`, top-1 stability rate, and latency Δ. JSON mode (`schema_version: 1`) for CI gating; human mode prints a regression table sorted worst-first. Closes the gap between "data captured" and "data used to gate a PR." See `docs/eval-bench.md` for the workflow.
- `gbrain doctor` gains an `eval_capture` check: reads `eval_capture_failures` for the last 24h, groups by reason, warns when non-zero. Cross-process visibility (doctor runs in a separate process from MCP). Pre-v31 brains get `Skipped (table unavailable)` — non-fatal.
- Config addition: `eval: { capture?: boolean, scrub_pii?: boolean }` in `~/.gbrain/config.json`. **File-plane only** — `gbrain config set` writes the DB plane and does NOT control capture.
- **`GBRAIN_CONTRIBUTOR_MODE=1` env var** is the contributor-facing toggle. Capture is **off by default** as of v0.25.0; production users get a quiet brain. Resolution order: explicit `eval.capture` config wins both directions, then env var, then off. Documented in README.md, CONTRIBUTING.md, and `docs/eval-bench.md`.

Key commands added in v0.12.2:
- `gbrain repair-jsonb [--dry-run] [--json]` — repair double-encoded JSONB rows left over from v0.12.0-and-earlier Postgres writes. Idempotent; PGLite no-ops. The `v0_12_2` migration runs this automatically on `gbrain upgrade`.

Key commands added in v0.12.3:
- `gbrain orphans [--json] [--count] [--include-pseudo]` — surface pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. The natural consumer of the v0.12.0 knowledge graph layer: once edges are captured, find the gaps.
- `gbrain doctor` gains two new reliability detection checks: `jsonb_integrity` (v0.12.0 Postgres double-encode damage) and `markdown_body_completeness` (pages truncated by the old splitBody bug). Detection only; fix hints point at `gbrain repair-jsonb` and `gbrain sync --force`.

Key commands added in v0.14.2:
- `gbrain sync --skip-failed` — acknowledge the current set of failed-parse files recorded in `~/.gbrain/sync-failures.jsonl` so the sync bookmark advances past them. Doctor's `sync_failures` check shows previously-skipped as "all acknowledged" instead of warning.
- `gbrain sync --retry-failed` — re-walk the unacknowledged failures and re-attempt parsing. If the files now succeed, they clear from the set and the bookmark advances naturally.
- `gbrain apply-migrations --force-retry <version>` — reset a wedged migration (3 consecutive partials with no completion) by appending a `'retry'` marker. Next `apply-migrations --yes` treats the version as fresh. `complete` status never regresses to `partial` either before or after a retry marker.
- `GBRAIN_POOL_SIZE` env var — honored by both the singleton pool (`src/core/db.ts`) and the parallel-import worker pool (`src/commands/import.ts`). Default is 10; lower to 2 for Supabase transaction pooler to avoid MaxClients crashes during `gbrain upgrade` subprocess spawns. Read at call time via `resolvePoolSize()`.
- `gbrain doctor` gains two new checks: `sync_failures` (surfaces unacknowledged parse failures with exact paths + fix hints) and `brain_score` (renders the 5-component breakdown when score < 100: embed coverage / 35, link density / 25, timeline coverage / 15, orphans / 15, dead links / 10 — sum equals total).

Key commands added in v0.26.0 (OAuth 2.1 + HTTP server + admin dashboard):
- `gbrain serve --http [--port 3131] [--token-ttl 3600] [--enable-dcr]` — HTTP MCP server with OAuth 2.1, admin dashboard at `/admin`, SSE activity feed at `/admin/events`, health check at `/health`. Prints admin bootstrap token on first start. Alongside (not replacing) stdio `gbrain serve`.
- **OAuth client registration** — three paths:
  1. CLI: `gbrain auth register-client <name> --grant-types <types> --scopes <scopes>` (wired into `src/commands/auth.ts` as a thin wrapper over `GBrainOAuthProvider.registerClientManual`). Default grant types: `client_credentials`. Default scopes: `read`.
  2. Admin dashboard: Register client modal → credential reveal with Copy + Download JSON.
  3. SDK: `oauthProvider.registerClientManual(name, grantTypes, scopes, redirectUris)` for programmatic wrappers.
  `--enable-dcr` on `serve --http` opens the `/register` endpoint for RFC 7591 self-service registration (off by default).
- `gbrain auth create|list|revoke|test` — legacy bearer tokens still work and grandfather to `read+write+admin` scopes on the OAuth server. `auth` is wired as a first-class `gbrain` subcommand in v0.26.0 (previously only invokable via `bun run src/commands/auth.ts`). No migration required to keep pre-v0.26 clients working.

Key commands added in v0.14.3 (fix wave):
- `gbrain doctor --index-audit` — opt-in Postgres-only check reporting zero-scan indexes from `pg_stat_user_indexes`. Informational only; never auto-drops.
- `gbrain doctor` schema_version check fails loudly when `version=0` — catches `bun install -g github:...` postinstall failures (#218) and routes users to `gbrain apply-migrations --yes`.
- `gbrain jobs submit` gains `--max-stalled`, `--backoff-type`, `--backoff-delay`, `--backoff-jitter`, `--timeout-ms`, `--idempotency-key` — exposing existing `MinionJobInput` fields as first-class CLI flags.
- `gbrain jobs smoke --sigkill-rescue` — opt-in regression smoke case simulating a killed worker; asserts the v0.14.3 schema default (`max_stalled=5`) actually rescues on first stall.

Key commands added in v0.22.13 (PR #490):
- `gbrain sync --workers N` (alias `--concurrency N`) — parallelize the import phase using per-worker Postgres engines (small pool of 2 each) with an atomic queue index. Auto-concurrency: defaults to 4 workers when the diff exceeds 100 files. Smaller diffs stay serial. Explicit `--workers` always wins (even on a 30-file diff). PGLite forces serial regardless. Validation rejects `0`, negatives, non-integers loud (replaces the prior silent fall-through to auto-concurrency).
- `gbrain import --workers N` — same `parseWorkers()` validation as sync; same try/finally worker-engine cleanup. Behavior surface unchanged.

Key commands added in v0.22.16 (claw-test friction loop):
- `gbrain claw-test [--scenario fresh-install|upgrade-from-v0.18] [--keep-tempdir]` — scripted-mode CI gate that runs the full canonical first-day flow against a fresh tempdir. Asserts every expected `--progress-json` phase fired and doctor's `status === 'ok'`. ~30s, no API keys.
- `gbrain claw-test --live --agent openclaw` — friction-discovery mode. Spawns real openclaw, hands it `BRIEF.md`, captures stdin/stdout/stderr to `<run>/transcript.jsonl`, lets the agent log friction via the friction CLI. Run on demand; ~5–10 min and ~$1–2 in tokens.
- `gbrain claw-test --list-agents` — reports which agent runners are registered + their detection state (binary path or unavailable reason).
- `gbrain friction log --severity {confused|error|blocker|nit} --phase <name> --message <text> [--hint ...] [--kind {friction|delight}] [--run-id ...]` — append a friction or delight entry to the active run JSONL.
- `gbrain friction render --run-id <id> [--json] [--transcripts] [--no-redact]` — markdown report grouped by severity + phase; `--redact` is the default for md output (strips `$HOME`/`$CWD` placeholders so reports paste safely in PRs/issues).
- `gbrain friction list [--json]` — recent run-ids with friction/delight counts; interrupted runs marked `(interrupted)`.
- `gbrain friction summary --run-id <id> [--json]` — two-column friction + delight summary.
- `GBRAIN_HOME` env override is now honored uniformly across every gbrain write site (config, audit, friction, sync-failures, import checkpoint, integrity log, integrations heartbeat, migration rollback, etc.) — `gbrainPath(...)` from `src/core/config.ts` is the canonical helper. Read-side host-fingerprint detection (`~/.claude`/`~/.openclaw` etc.) intentionally NOT confined in v1; that's a v1.1 follow-up.

## Testing

### Test command tiers (v0.26.4 — parallel fast loop)

Five tiers of test commands, each with a clear scope:

| Command | What it runs | Wallclock | When to use |
|---|---|---|---|
| `bun run test` | Parallel unit-test fast loop. 8-shard fan-out via `scripts/run-unit-parallel.sh`, then a serial pass over `*.serial.test.ts`. Excludes `*.slow.test.ts` and `test/e2e/*`. No pre-checks, no typecheck. | ~85s on a Mac dev box (3650+ tests) | Inner edit loop. Default. |
| `bun run verify` | CI's authoritative pre-test gate set: `check:privacy && check:jsonb && check:progress && check:wasm && bun run typecheck`. The 4 checks `.github/workflows/test.yml` runs on shard 1 + typecheck. Single source of truth — CI literally calls `bun run verify`. | ~12s (wasm-compile dominates) | Before pushing; before `/ship`. |
| `bun run test:full` | `verify && bun run test && bun run test:slow && [smart e2e]`. The local equivalent of "everything CI runs." Smart e2e: runs e2e only when `DATABASE_URL` is set; else loud skip notice to stderr. | ~3-5min depending on slow + e2e | Pre-merge sanity, before opening a PR. |
| `bun run test:slow` | Just the `*.slow.test.ts` set (intentional cold-path correctness checks). | seconds-to-minutes | When touching slow-path code. |
| `bun run test:serial` | Just the `*.serial.test.ts` set (cross-file-contention quarantine; runs at `--max-concurrency=1`). | ~1s per quarantined file | Debugging a specific quarantined file. |
| `bun run test:e2e` | Real Postgres E2E. Requires Docker + `DATABASE_URL`. Sequential (template-DB parallelization is a v0.27+ TODO). | ~5-10min | Pre-ship; nightly. |
| `bun run check:all` | All 7 historical pre-checks (privacy + jsonb + progress + no-legacy-getconnection + trailing-newline + wasm + exports-count). Superset of `verify`. | ~10s | Local-only sweep. The 4 not in `verify` are nice-to-haves. |

### CI vs local: intentionally divergent file sets

- **CI matrix** (`.github/workflows/test.yml`) runs `scripts/test-shard.sh` 4-way, which uses FNV-1a hash bucketing and INCLUDES `*.slow.test.ts`. CI is the ground truth for "did everything pass."
- **Local fast loop** (`scripts/run-unit-shard.sh` via the parallel wrapper) uses round-robin-by-index sharding and EXCLUDES `*.slow.test.ts` AND `*.serial.test.ts`. Local trades coverage for inner-loop speed; CI catches what local skips.

This divergence is intentional. Don't try to make them equal — the two scripts deliberately solve different problems. The regression test at `test/scripts/run-unit-shard.test.ts` pins what the local fast loop should and shouldn't include.

### Failure-first logging

When `bun run test` finds any failure, the wrapper:

1. Writes failure blocks (each prefixed with `--- shard N: <test name> ---`) to `.context/test-failures.log` (workspace-local, gitignored). On systems without a writable `.context/`, falls back to `/tmp/gbrain-test-failures.log`.
2. Prints a loud stderr banner with the absolute log path, plus the last 30 lines of the failure log inlined. Banner survives `| head` / `| tail` / agent-side log truncation.
3. Writes a one-line-per-shard summary to `.context/test-summary.txt` (`shard N/M: pass=X fail=Y skip=Z rc=W`).
4. Exits non-zero. Empty failure log + non-zero exit = infrastructure problem (wedged shard, killed child); the banner says so.

If a shard wedges (per-shard `GBRAIN_TEST_SHARD_TIMEOUT` cap, default 600s), the wrapper writes `--- shard N: WEDGED after ${SHARD_TIMEOUT}s ---` to the failure log, includes the last 50 lines of the shard log, and proceeds with other shards' results.

### File taxonomy

- `*.test.ts` → fast loop (parallel 8-shard fan-out).
- `*.slow.test.ts` → run via `bun run test:slow` only (intentional cold-path tests; would dominate the fast loop's wallclock).
- `*.serial.test.ts` → run via `bun run test:serial` after the parallel pass completes; uses `--max-concurrency=1`. Quarantine for tests that share file-wide state and race when run alongside other files in the same `bun test` process. Currently: `test/brain-registry.serial.test.ts`, `test/reconcile-links.serial.test.ts`, `test/core/cycle.serial.test.ts`, `test/embed.serial.test.ts` (the latter two added in v0.26.7 — they use `mock.module(...)` which leaks across files in the shard process). **Do not put the parallelism back on a serial file unless you've fixed the contention root cause** (it just re-introduces the flake).
- `test/e2e/*.test.ts` → real-Postgres E2E. Skipped when `DATABASE_URL` is unset.

The intra-file parallelism project (turn `bun test` into `bun test --concurrent` after sweeping shared-state contention sites) is sliced across v0.26.7 (foundation), v0.26.8 (env-mutation sweep), and v0.26.9 (PGLite sweep + codemod + measurement). v0.26.4 ships file-level parallelism only.

### Test-isolation lint and helpers (v0.26.7)

The cross-file flake class is enforced statically by `scripts/check-test-isolation.sh`, wired into `bun run verify` and `bun run check:all`. Rules (non-serial unit files only; `*.serial.test.ts` and `test/e2e/*` are skipped):

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | `process.env.X = ...`, bracket assignment, `delete process.env.X`, `Object.assign(process.env, ...)`, `Reflect.set(process.env, ...)` | Use `withEnv()` from `test/helpers/with-env.ts`, OR rename file to `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | Rename file to `*.serial.test.ts` (no DI on production code for testability) |
| **R3** | `new PGLiteEngine(` outside ~50 lines after a `beforeAll(` line | Use the canonical block (below) inside `beforeAll(` |
| **R4** | Files creating `new PGLiteEngine(` without `engine.disconnect(` inside an `afterAll(` block | Add `afterAll(() => engine.disconnect())` |

Files that violated these rules at the v0.26.7 baseline are listed in `scripts/check-test-isolation.allowlist`. **The allow-list MUST shrink over time** — never add new entries. v0.26.8 (env sweep) and v0.26.9 (PGLite sweep) remove entries as files get fixed.

#### Canonical PGLite block (R3 + R4 compliant)

Every test file that needs a PGLite engine should use this exact pattern:

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});
```

Why this exact shape: `beforeAll` creates a single engine per file (PGLite WASM cold-start + initSchema is ~20s); `beforeEach` truncates user data via `resetPgliteState` ("two orders of magnitude faster" than fresh-engine-per-test); `afterAll` disconnects so the engine doesn't leak across file boundaries within a shard process.

#### `withEnv` pattern (R1 fix)

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});

// Delete a var (override is undefined):
await withEnv({ GBRAIN_HOME: undefined }, fn);

// Multiple keys:
await withEnv({ A: '1', B: '2', C: undefined }, fn);
```

`withEnv` saves the prior value of every key it touches and restores via try/finally — including when the callback throws. **It is cross-test safe but NOT intra-file concurrent-safe.** `process.env` is process-global; two `test.concurrent()` calls in the same file both touching the same key will race. Files using `withEnv` stay outside the future `test.concurrent()` codemod's eligibility filter.

#### When to quarantine instead of fix

Rename to `*.serial.test.ts` when:
- The file uses `mock.module(...)` (R2 — there's no clean fix without changing production code).
- The file is genuinely env-coupled (e.g. `gbrain-home-isolation.test.ts`, `claw-test-cli.test.ts`) — module-load env readers + ESM caching defeat dynamic-import-after-env tricks.
- The file's tests intentionally share state across `it()` boundaries.

Quarantine count cap: 10 (informational). Beyond that, push back on the design.

### Inventory (legacy)

`bun test` runs all tests. After the v0.12.1 release: ~75 unit test files + 8 E2E test files (1412 unit pass, 119 E2E when `DATABASE_URL` is set — skip gracefully otherwise). Unit tests run
without a database. E2E tests skip gracefully when `DATABASE_URL` is not set.

Unit tests: `test/markdown.test.ts` (frontmatter parsing), `test/chunkers/recursive.test.ts`
(chunking), `test/parity.test.ts` (operations contract
parity), `test/cli.test.ts` (CLI structure), `test/config.test.ts` (config redaction),
`test/files.test.ts` (MIME/hash), `test/import-file.test.ts` (import pipeline),
`test/upgrade.test.ts` (schema migrations),
`test/file-migration.test.ts` (file migration), `test/file-resolver.test.ts` (file resolution),
`test/import-resume.test.ts` (import checkpoints), `test/migrate.test.ts` (migration; v8/v9 helper-btree-index SQL structural assertions + 1000-row wall-clock fixtures that guard the O(n²)→O(n log n) fix + v0.13.1 assertions on v12/v13 SQL shape, `sqlFor` + `transaction:false` runner semantics, the `max_stalled DEFAULT 1` regression guard, and v0.22.6.1 v24 `sqlFor.pglite: ''` no-op assertion),
`test/bootstrap.test.ts` (v0.22.6.1 — bootstrap contract: no-op on fresh install, idempotent across two `initSchema()` calls, no-op on modern brain that already has every probed column, full bootstrap path on simulated pre-v0.18 brain, fresh-install regression guard, pre-v0.13 `links` shape coverage),
`test/schema-bootstrap-coverage.test.ts` (v0.22.6.1 CI guard — `REQUIRED_BOOTSTRAP_COVERAGE` lists every forward reference in PGLITE_SCHEMA_SQL; the test fails loudly if `applyForwardReferenceBootstrap` skips one. When you add a column-with-index to the embedded schema blob, you extend both arrays or this guard fails. The pattern that broke gbrain ten times in two years is now structurally prevented.),
`test/helpers/schema-diff.ts` + `test/helpers/schema-diff.test.ts` + `test/e2e/schema-drift.test.ts` (v0.26.6 #588 — cross-engine schema parity gate. Helper exports pure `snapshotSchema(query)` / `diffSnapshots(pg, pglite, opts)` / `formatDiffForFailure(diff)` / `isCleanDiff(diff)` over a four-tuple per column (`data_type`, `udt_name`, `is_nullable`, `column_default`). E2E test spins up fresh PGLite + Postgres, runs `engine.initSchema()` on each (bootstrap + schema replay + migrations), snapshots `information_schema.columns`, then diffs. 2-table allowlist (`files`, `file_migration_ledger`) — every other Postgres table must reach PGLite via PGLITE_SCHEMA_SQL or a migration's `sqlFor.pglite` branch. Sentinels for `oauth_clients`, `mcp_request_log`, `access_tokens`, `eval_candidates` give tighter blame messages. Skip-gracefully without `DATABASE_URL`. Wired into `scripts/e2e-test-map.ts` so changes to `src/schema.sql`, `src/core/pglite-schema.ts`, or `src/core/migrate.ts` trigger it. The failure message names every drift with a paste-ready hint pointing at `src/core/pglite-schema.ts`.),
`test/setup-branching.test.ts` (setup flow), `test/slug-validation.test.ts` (slug validation),
`test/storage.test.ts` (storage backends), `test/supabase-admin.test.ts` (Supabase admin),
`test/yaml-lite.test.ts` (YAML parsing), `test/check-update.test.ts` (version check + update CLI),
`test/pglite-engine.test.ts` (PGLite engine, all 40 BrainEngine methods including 11 cases for `addLinksBatch` / `addTimelineEntriesBatch`: empty batch, missing optionals, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch, batch of 100 + v0.13.1 `connect()` error-wrap assertion (original error nested, #223 link in message, lock released)),
`test/engine-factory.test.ts` (engine factory + dynamic imports),
`test/integrations.test.ts` (recipe parsing, CLI routing, recipe validation),
`test/publish.test.ts` (content stripping, encryption, password generation, HTML output),
`test/backlinks.test.ts` (entity extraction, back-link detection, timeline entry generation),
`test/lint.test.ts` (LLM artifact detection, code fence stripping, frontmatter validation),
`test/report.test.ts` (report format, directory structure),
`test/skills-conformance.test.ts` (skill frontmatter + required sections validation),
`test/resolver.test.ts` (RESOLVER.md coverage, routing validation + v0.20.4 round-trip: every quoted RESOLVER.md trigger must match a frontmatter `triggers:` entry in the target skill, and every `name="<word>"` reference in any SKILL.md must resolve to a declared op in `src/core/operations.ts` or a Minions handler in `PROTECTED_JOB_NAMES`),
`test/search.test.ts` (RRF normalization, compiled truth boost, cosine similarity, dedup key),
`test/sql-ranking.test.ts` (v0.22.0 source-boost helpers: 39 cases covering longest-prefix-match in SQL CASE, detail=high temporal-bypass, three-meta-char LIKE escape (%, _, \\), single-quote SQL-literal doubling, env override parsing for GBRAIN_SOURCE_BOOST + GBRAIN_SEARCH_EXCLUDE, resolveBoostMap / resolveHardExcludes merge semantics),
`test/dedup.test.ts` (source-aware dedup, compiled truth guarantee, layer interactions),
`test/intent.test.ts` (query intent classification: entity/temporal/event/general),
`test/eval.test.ts` (retrieval metrics: precisionAtK, recallAtK, mrr, ndcgAtK, parseQrels),
`test/check-resolvable.test.ts` (resolver reachability, MECE overlap, gap detection, DRY checks + v0.14.1 proximity-based DRY detection + `extractDelegationTargets` coverage — 13 DRY cases),
`test/dry-fix.test.ts` (v0.14.1 auto-fix: three shape-aware expander pure-function tests, five guards — working-tree-dirty, no-git-backup, inside-code-fence, already-delegated within 40 lines, ambiguous-multi-match, block-is-callout — 28 cases),
`test/doctor-fix.test.ts` (v0.14.1 `gbrain doctor --fix` CLI integration: dry-run preview, apply path, JSON output shape — 3 cases),
`test/backoff.test.ts` (load-aware throttling, concurrency limits, active hours),
`test/fail-improve.test.ts` (deterministic/LLM cascade, JSONL logging, test generation, rotation),
`test/transcription.test.ts` (provider detection, format validation, API key errors),
`test/enrichment-service.test.ts` (entity slugification, extraction, tier escalation),
`test/data-research.test.ts` (recipe validation, MRR/ARR extraction, dedup, tracker parsing, HTML stripping),
`test/minions.test.ts` (Minions job queue v7: CRUD, state machine, backoff, stall detection, dependencies, worker lifecycle, lock management, claim mechanics, depth/child-cap, timeouts, cascade kill, idempotency, child_done inbox, attachments, removeOnComplete/Fail + v0.13.1 `max_stalled` clamp/default/plumbing coverage),
`test/extract.test.ts` (link extraction, timeline extraction, frontmatter parsing, directory type inference),
`test/extract-db.test.ts` (gbrain extract --source db: typed link inference, idempotency, --type filter, --dry-run JSON output),
`test/extract-fs.test.ts` (gbrain extract --source fs: first-run inserts + second-run reports zero, dry-run dedups candidates across files, second-run perf regression guard — the v0.12.1 N+1 dedup bug),
`test/link-extraction.test.ts` (canonical extractEntityRefs both formats, extractPageLinks dedup, inferLinkType heuristics, parseTimelineEntries date variants, isAutoLinkEnabled config),
`test/graph-query.test.ts` (direction in/out/both, type filter, indented tree output),
`test/features.test.ts` (feature scanning, brain_score calculation, CLI routing, persistence),
`test/file-upload-security.test.ts` (symlink traversal, cwd confinement, slug + filename allowlists, remote vs local trust),
`test/query-sanitization.test.ts` (prompt-injection stripping, output sanitization, structural boundary),
`test/search-limit.test.ts` (clampSearchLimit default/cap behavior across list_pages and get_ingest_log),
`test/repair-jsonb.test.ts` (v0.12.2 JSONB repair: TARGETS list, idempotency, engine-awareness),
`test/migrations-v0_12_2.test.ts` (v0.12.2 orchestrator phases: schema → repair → verify → record),
`test/markdown.test.ts` (splitBody sentinel precedence, horizontal-rule preservation, inferType wiki subtypes),
`test/orphans.test.ts` (v0.12.3 orphans command: detection, pseudo filtering, text/json/count outputs, MCP op),
`test/postgres-engine.test.ts` (v0.12.3 statement_timeout scoping: `sql.begin` + `SET LOCAL` shape, source-level grep guardrail against reintroduced bare `SET statement_timeout`),
`test/sync.test.ts` (sync logic + v0.12.3 regression guard asserting top-level `engine.transaction` is not called),
`test/sync-concurrency.test.ts` (v0.22.13 PR #490: 17 cases covering `autoConcurrency()` thresholds + PGLite-forces-serial + explicit-override clamping, `shouldRunParallel()` Q1 explicit-bypasses-floor contract, and `parseWorkers()` validation that rejects `'0'`/`'-3'`/`'foo'`/`'1.5'`/trailing chars),
`test/sync-parallel.test.ts` (v0.22.13 PR #490: PGLite-routed coverage of the bookmark gate under concurrency request, head-drift gate, vanished-file failure capture, PGLite-stays-serial, and the `gbrain-sync` writer-lock contract — 7 cases),
`test/sync-failures.test.ts` (v0.22.12: 28 cases pinning `classifyErrorCode` regex coverage for all 12 codes against literal production message strings from `markdown.ts:159-244` and `import-file.ts:199, 347, 352, 401`; `summarizeFailuresByCode` sort + pre-classified-honor; `recordSyncFailures` code-field persistence; `acknowledgeSyncFailures` AcknowledgeResult shape + backfill on pre-v0.22.12 entries),
`test/doctor.test.ts` (doctor command + v0.12.3 assertions that `jsonb_integrity` scans the four v0.12.0 write sites and `markdown_body_completeness` is present),
`test/utils.test.ts` (shared SQL utilities + `tryParseEmbedding` null-return and single-warn semantics),
`test/build-llms.test.ts` (llms.txt/llms-full.txt generator: path resolution, idempotence, spec shape, regen-drift guard, content contract, AGENTS.md install-path mirror, size-budget enforcement — 7 cases),
`test/oauth.test.ts` (v0.26.0 OAuth 2.1 provider — 27 cases: register, getClient, `client_credentials` grant exchange, `authorization_code` flow with PKCE challenge / verifier, refresh token rotation, `verifyAccessToken` with both OAuth + legacy `access_tokens` fallback, `revokeToken`, `sweepExpiredTokens`, and a contract test asserting `scope` + `localOnly` annotations are set correctly on all 30 operations; **v0.26.2** adds 5 `coerceTimestamp` unit cases (null/undefined/string/number/throw-on-NaN), NULL-`expires_at`-as-expired contract tests for both refresh + access token paths, and a cascade-delete contract test asserting `revoke-client` purges `oauth_tokens` + `oauth_codes` rows via FK CASCADE),
`test/check-resolvable-cli.test.ts` (v0.19 CLI wrapper: exit codes, JSON envelope shape, AGENTS.md fallback chain),
`test/regression-v0_16_4.test.ts` (findRepoRoot regression guard — hermetic startDir parameterization),
`test/filing-audit.test.ts` (v0.19 Check 6: `writes_pages` / `writes_to` frontmatter, filing-rules JSON validation),
`test/routing-eval.test.ts` (v0.19 Check 5: fixture parsing, structural routing, ambiguous_with, Haiku tie-break layer),
`test/skill-manifest.test.ts` (v0.19 skill manifest parser: drift detection, managed-block markers),
`test/skillify-scaffold.test.ts` (v0.19 `gbrain skillify scaffold` stubs: SKILL.md, script, tests, routing-eval fixtures),
`test/skillpack-install.test.ts` (v0.19 `gbrain skillpack install` managed-block install / update / no-clobber semantics),
`test/skillpack-sync-guard.test.ts` (v0.19 sync-guard: bundled skills stay byte-identical to `skills/` source),
`test/http-transport.test.ts` (v0.22.7 HTTP transport: 23 unit cases covering bearer auth + missing/no-Bearer/unknown/revoked + `/health` bypass, F1+F2 round-trip via dispatch.ts, F3 invalid_params, application/json response shape (not SSE), CORS default-deny + allowlist, body cap on Content-Length AND chunked, two-bucket rate limit (refill, exhaust+Retry-After, LRU eviction, TTL prune, pre-auth IP fires before DB), and `mcp_request_log` audit on success + auth_failed).

E2E tests (`test/e2e/`): Run against real Postgres+pgvector. Require `DATABASE_URL`.
- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys). Includes 9 dedicated cases for the postgres-engine `addLinksBatch` / `addTimelineEntriesBatch` bind path — postgres-js's `unnest()` binding is structurally different from PGLite's and gets its own coverage.
- `test/e2e/search-quality.test.ts` runs search quality E2E against PGLite (no API keys, in-memory)
- `test/e2e/graph-quality.test.ts` runs the v0.10.3 knowledge graph pipeline (auto-link via put_page, reconciliation, traversePaths) against PGLite in-memory
- `test/e2e/postgres-jsonb.test.ts` — v0.12.2 regression test. Round-trips all 5 JSONB write sites (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter) against real Postgres and asserts `jsonb_typeof='object'` plus `->>'key'` returns the expected scalar. The test that should have caught the original double-encode bug.
- `test/e2e/integrity-batch.test.ts` (v0.22.8) — parity tests for `scanIntegrity`'s batch-load fast path vs sequential. Four cases (dedup, hits, validate, topPages) seed a fixture and assert both paths return identical results. Dedup case uses raw SQL via `getConn().unsafe()` to seed a `(test-source-2, people/alice)` row alongside the default-source row, since `engine.putPage` doesn't take a `source_id`. Pins the codex-caught multi-source overcounting regression.
- `test/e2e/jsonb-roundtrip.test.ts` — v0.12.3 companion regression against the 4 doctor-scanned JSONB sites. Assertion-level overlap with `postgres-jsonb.test.ts` is intentional defense-in-depth: if doctor's scan surface ever drifts from the actual write surface, one of these tests catches it.
- `test/e2e/sync.test.ts` (v0.22.12 — `--skip-failed` failure-loop test, alongside the existing 13 happy-path tests): exercises the full chain — broken file → `performSync` returns `blocked_by_failures` with grouped breakdown → `performSync({skipFailed: true})` advances bookmark and returns `AcknowledgeResult` with code summary → second broken file → second cycle. Saves and restores the user's real `~/.gbrain/sync-failures.jsonl` so the test is hermetic on a developer machine. Asserts bookmark gating, JSONL state, dedup across paths, summary aggregation, and the literal doctor-rendering string format. This is the integration test that proves the v0.22.12 chain holds together — unit tests cover the pure functions in isolation, this covers the integration.
- `test/e2e/upgrade.test.ts` runs check-update E2E against real GitHub API (network required)
- `test/e2e/minions-shell-pglite.test.ts` (v0.20.4) exercises the PGLite `--follow` inline shell-job path (in-memory, no `DATABASE_URL` required) — the path the consolidated minion-orchestrator skill documents for dev use
- `test/e2e/openclaw-reference-compat.test.ts` (v0.19) — exercises `check-resolvable` + `skillpack install` against a minimal AGENTS.md workspace fixture (`test/fixtures/openclaw-reference-minimal/`), regression guard for the 107-skill OpenClaw deployment shape
- `test/e2e/search-swamp.test.ts` (v0.22.0) — reproduces the headline source-swamp case. Seeds a curated `originals/talks/article-outline-fat-code` page against two `wintermute/chat/` pages stuffed with the same multi-word phrase. Asserts the article wins keyword AND vector ranking, that `detail=high` lets the chat swamp re-surface (temporal-query workflow preserved), and that `source_id` passes through the two-stage CTE intact. PGLite in-memory.
- `test/e2e/search-exclude.test.ts` (v0.22.0) — verifies `test/` + `archive/` pages are hidden by default, that `include_slug_prefixes` opts back in, and that caller-supplied `exclude_slug_prefixes` adds to defaults. Both keyword and vector search paths covered.
- `test/e2e/engine-parity.test.ts` (v0.22.0) — Postgres ↔ PGLite top-result and result-set parity for `searchKeyword` + `searchVector`. Codex flagged that Postgres ranks pages then picks best chunk while PGLite returns chunks directly — without parity coverage the source-boost fix could pass on PGLite and fail on Postgres. Skips gracefully when `DATABASE_URL` is unset.
- `test/e2e/postgres-bootstrap.test.ts` (v0.22.6.1) — exercises `PostgresEngine.initSchema()` directly against a fresh real Postgres database. Asserts the bootstrap path is no-op on fresh installs and that SCHEMA_SQL replays cleanly through the engine path (not via the standalone `db.initSchema` from `src/core/db.ts`, which would have produced false-positive coverage). Codex caught the E2E-shape gap during plan review.
- `test/e2e/http-transport.test.ts` (v0.22.7) — 8 cases against real Postgres covering `gbrain serve --http` end-to-end: bearer auth round-trip, `last_used_at` SQL-level debounce semantics, `mcp_request_log` row insertion on success and auth_failed paths, `/health` DB-down → 503 (DB-probing health check), and the F1+F2+F3 dispatch round-trip with a real operation. Skips gracefully when `DATABASE_URL` is unset.
- `test/e2e/serve-http-oauth.test.ts` (v0.26.0, expanded v0.26.2) — real-Postgres E2E against `gbrain serve --http` with full OAuth 2.1. Spawns a subprocess server, registers a client via the CLI, mints `client_credentials` tokens, exercises the `/mcp` JSON-RPC pipeline. **v0.26.2 adds:** real DCR `/register` HTTP-level response-shape test (asserts `typeof body.client_id_issued_at === 'number'` over the wire — RFC 7591 §3.2.1 spec compliance, not just internal-store shape); real CLI subprocess test for `revoke-client` (registers → mints token → revokes via `execSync` → asserts token rejected at `/mcp` → asserts re-run exits 1); server fixture flips on `--enable-dcr` so `/register` is reachable. **bun execSync env-inheritance fix:** bun's `execSync` does NOT inherit env mutations done via `process.env.X = ...`, only OS-level env from before bun started. helpers.ts loads `.env.testing` and sets `DATABASE_URL` via `process.env` mutation, which is invisible to subprocesses unless `env: { ...process.env }` is passed explicitly — every subprocess call in this file passes `env: { ...process.env }` for that reason. Reference fix for the next maintainer hitting the same failure mode in sibling sync/cycle/dream/claw-test E2Es. `afterAll` cleanup is guarded on `clientId` (won't throw if `beforeAll` failed before registration); cleanup errors surface to stderr without throwing so real test failures aren't masked. Tracks DCR-registered clients alongside the manual one. Skips gracefully when `DATABASE_URL` is unset.
- `test/e2e/sync-parallel.test.ts` (v0.22.13 PR #490) — DATABASE_URL-gated. T2: 60-file Postgres sync at concurrency=4 imports all + no connection leak (probes `pg_stat_activity` before/after to confirm worker engines disconnected). P4: 120-file serial-vs-parallel benchmark prints `SYNC_PARALLEL_BENCH N files | serial=Xms | parallel(4)=Yms | speedup=Zx` for CHANGELOG quoting. Asserts parallel ≤ serial × 1.5 (CI-noise tolerant; not a strict speedup gate).
- Tier 2 (`skills.test.ts`) requires OpenClaw + API keys, runs nightly in CI
- If `.env.testing` doesn't exist in this directory, check sibling worktrees for one:
  `find ../  -maxdepth 2 -name .env.testing -print -quit` and copy it here if found.
- Always run E2E tests when they exist. Do not skip them just because DATABASE_URL
  is not set. Start the test DB, run the tests, then tear it down.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

### E2E test DB lifecycle (ALWAYS follow this)

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Do not skip E2E tests.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name gbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=gbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec gbrain-test-pg pg_isready -U postgres`
4. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test bun run test:e2e`
5. **Tear down immediately after tests finish (pass or fail):**
   `docker stop gbrain-test-pg && docker rm gbrain-test-pg`

Never leave `gbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one.

## Skills

Read the skill files in `skills/` before doing brain operations. GBrain ships 29 skills
organized by `skills/RESOLVER.md` (`AGENTS.md` is also accepted as of v0.19):

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (ported from an upstream agent fork):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator. As of
v0.20.4, `minion-orchestrator` is the single unified skill for both lanes of background
work (shell jobs via `gbrain jobs submit shell`, LLM subagents via `gbrain agent run`) ...
the prior `gbrain-jobs` skill was merged in, Preconditions are shared, and trigger
routing is narrowed to what the skill actually covers.

**Skillify loop (v0.19):** skillify (the markdown orchestration), skillpack-check
(agent-readable health report).

**Operational health (v0.19.1):** smoke-test (8 post-restart health checks with auto-fix
for Bun, CLI, DB, worker, Zod CJS, gateway, API key, brain repo; user-extensible via
`~/.gbrain/smoke-tests.d/*.sh`).

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Bulk-action progress reporting

All bulk commands (doctor, embed, import, export, sync, extract, migrate,
repair-jsonb, orphans, check-backlinks, lint, integrity auto, eval, files
sync, and apply-migrations) stream progress through the shared reporter
at `src/core/progress.ts`. Agents get heartbeats within 1 second of every
iteration regardless of how slow the underlying work is.

Rules:
- Progress always writes to **stderr**. Stdout stays clean for data output
  (`--json` payloads, final summaries, JSON action events from `extract`).
- Non-TTY default: plain one-line-per-event human text. JSON requires the
  explicit `--progress-json` flag.
- Global flags (`--quiet`, `--progress-json`, `--progress-interval=<ms>`)
  are parsed by `src/core/cli-options.ts` BEFORE command dispatch.
- Phase names are machine-stable `snake_case.dot.path` (e.g.
  `doctor.db_checks`, `sync.imports`). Documented in
  `docs/progress-events.md`; additive changes only.
- `scripts/check-progress-to-stdout.sh` is a CI guard that fails the build
  if any new code writes `\r` progress to stdout. Wired into `bun run test`.
- Minion handlers pass `job.updateProgress` as the `onProgress` callback
  to core functions (DB-backed primary progress channel); stderr from
  `jobs work` stays coarse for daemon liveness only.

When wiring a new bulk command: `import { createProgress } from '../core/progress.ts'`
and `import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts'`.
Create a reporter with `createProgress(cliOptsToProgressOptions(getCliOptions()))`,
`start(phase, total?)` before the loop, `tick()` inside it, `finish()` after.
For single long-running queries, use `startHeartbeat(reporter, note)` with a
try/finally to guarantee cleanup. Never call `process.stdout.write('\r...')`
in bulk paths, the CI guard will fail the build.

## Capturing test output (NEVER pipe through `tail` / `head`)

**Iron rule:** when running `bun test`, `bun run test:e2e`, `bun run typecheck`,
or any other test/check command, redirect to a file FIRST, then `tail` the file
separately:

```bash
# RIGHT — full output preserved, real exit code visible
bun test > /tmp/ship_units.txt 2>&1
echo "EXIT=$?"
tail -50 /tmp/ship_units.txt
grep -E '(fail\)|✗|error:' /tmp/ship_units.txt | head -30
```

```bash
# WRONG — exit code is `tail`'s (always 0), failures truncated, ship gates fail open
bun test 2>&1 | tail -10
```

The pipe form silently breaks /ship Step T1 (test failure ownership triage) and
the test verification gate (Step 16) because:
- `$?` after a pipe is the LAST command's exit code (`tail` → 0), not bun's
- bun prints failure details before the summary line, so `tail -N` drops them
- Step T1 needs the full failure list to classify in-branch vs pre-existing

This bit us during v0.26.2 ship: `bun test 2>&1 | tail -10` reported "3911 pass / 23 fail"
but no failure details survived, forcing a 23-minute re-run to triage.

Apply the same pattern to any long-running command whose exit code matters:
`bun run typecheck`, `bun run ci:local`, migration runs, eval suites, etc.
For background tasks (`run_in_background: true`), the harness captures the exit
file separately — use it via the bg task's `<id>.exit` file, not the streamed
output.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Version locations (single source of truth: `VERSION` file)

Every release advances the version in **five files at once**. Keep these in
sync. `/ship` enforces this via Step 12's idempotency check (VERSION vs
package.json drift), but the canonical list lives here so future runs and
the auto-update agent know where to look.

**Required (every release must update all five):**

| File | What lives there | Format |
|---|---|---|
| `VERSION` | The single source of truth. Read first by `/ship`, the binary, and CI version-gate. | Bare 4-digit string `MAJOR.MINOR.PATCH.MICRO` (e.g. `0.22.1`), no leading `v`, no trailing newline-sensitivity issues. |
| `package.json` | Bun/npm package version. `gbrain --version` reads it via the compiled binary's bundled package metadata. CI version-gate cross-checks this against `VERSION` and fails if they drift. | `"version": "0.22.1"` |
| `CHANGELOG.md` | Top entry header `## [0.22.1] - YYYY-MM-DD` plus the "To take advantage of v0.22.1" block. | Standard Keep-a-Changelog header. |
| `TODOS.md` | Any TODO entries that mention "follow-up from vX.Y.Z" use the version of the release that filed them. Update only when filing NEW follow-up TODOs. | Inline `vX.Y.Z` references in TODO bodies. |
| `CLAUDE.md` | The Key Files section's per-file annotations carry `vX.Y.Z (#NNN)` tags noting which release introduced a behavior. Update whenever a wave's annotations get folded in. | Inline `vX.Y.Z (#NNN, contributed by @user)` references. |

**Auto-derived (no manual edit; refreshed by their own commands):**

- `bun.lock` — root-package version is auto-pinned from `package.json`. After
  bumping `package.json`, run `bun install` to refresh the lockfile.
- `llms-full.txt` / `llms.txt` — auto-generated documentation bundles. After
  any release ship that touches the Key Files annotations in `CLAUDE.md`,
  run `bun run build:llms` to regenerate. The bundles do not contain a
  version pin per se; they reflect the current state of the docs they index.

**Historical (DO NOT bump on release):**

- `skills/migrations/v0.21.0.md` — migration files use the version they
  shipped FROM as their filename. v0.21.0's migration always says v0.21.0.
- `src/commands/migrations/v0_21_0.ts` — same: migration code references
  the schema version it migrates to.
- `test/migrations-v0_21_0.test.ts`, `test/migration-orchestrator-v0_21_0.test.ts`,
  `test/migrate.test.ts` — migration tests reference historical migration
  versions; these are correct as-is and should not move.
- `src/core/db.ts`, `src/core/migrate.ts`, `src/core/import-file.ts`,
  `src/commands/reindex-code.ts` — code comments cite the release that
  introduced a feature. Once written, these are historical record.
- `README.md` — references the latest published feature names by version
  (e.g. "v0.21.0 Code Cathedral"); update only when the README's marketing
  copy is intentionally being refreshed, NOT on every micro/patch bump.

**The /ship workflow's version idempotency check:** Step 12 reads
`VERSION` and `package.json`, classifies as FRESH / ALREADY_BUMPED /
DRIFT_STALE_PKG / DRIFT_UNEXPECTED, and refuses to proceed on
DRIFT_UNEXPECTED. This is why the two must move together.

**The CI version-gate** rejects pushes where `VERSION` and
`package.json` disagree, OR where `VERSION` is not strictly greater
than master's VERSION. If a queue collision claims your version on
master before yours lands, /ship's queue-aware allocator (Step 12)
will detect drift and re-bump on the next run.

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite.
Two equivalent paths:

**Path A — local CI gate (recommended, v0.23.1+):**
- `bun run ci:local` runs the entire stack inside Docker: gitleaks (host), unit
  tests with `DATABASE_URL` unset, and all 29 E2E files sequentially against a
  fresh pgvector container. Stronger than PR CI's 2-file Tier 1 set; closer to
  what nightly Tier 1 catches. Spins up + tears down postgres automatically via
  `docker-compose.ci.yml`. Override the host port with
  `GBRAIN_CI_PG_PORT=5435 bun run ci:local` if 5434 collides.
- `bun run ci:local:diff` runs only the E2E files matched by the diff selector
  (`scripts/select-e2e.ts`), falling back to all 29 on unmapped src/ paths or
  schema/skills/package.json changes. Fast iteration during a focused branch.

**Path B — manual lifecycle (still supported):**
- `bun test` — unit tests (no database required)
- Follow the "E2E test DB lifecycle" steps above to spin up the test DB,
  run `bun run test:e2e`, then tear it down.

Both must pass. Do not ship with failing E2E tests. Do not skip E2E tests.

**Always run typecheck before pushing.** `bun test` (the bun runner)
skips TypeScript type checking — it only enforces runtime behavior.
Three ways to actually gate on types:

1. `bun run test` (npm script in `package.json`) — includes `bun run typecheck`
   plus the four shell pre-checks (`check-jsonb-pattern.sh`,
   `check-progress-to-stdout.sh`, `check-trailing-newline.sh`,
   `check-wasm-embedded.sh`) before the runner. Use this mid-branch.
2. `bun run typecheck` — `tsc --noEmit` standalone. Fast (~5s on this repo).
3. `bun run ci:local` — the full local CI gate from Path A.

The trap is: writing a new test, running `bun test test/foo.test.ts`,
seeing it pass, pushing — and CI's separate typecheck stage rejects an
invalid type literal that the runner accepted. Caught one of these
shipping the v0.23.2 round-trip E2E (`type: 'reflection'` is not a
member of `PageType`). Run `bun run typecheck` once before push, even
when only test files changed.

## Post-ship requirements (MANDATORY)

After EVERY /ship, you MUST run /document-release. This is NOT optional. Do NOT
skip it. Do NOT say "docs look fine" without running it. The skill reads every .md
file in the project, cross-references the diff, and updates anything that drifted.

If /ship's Step 8.5 triggers document-release automatically, that counts. But if
it gets skipped for ANY reason (timeout, error, oversight), you MUST run it manually
before considering the ship complete.

Files that MUST be checked on every ship:
- README.md — does it reflect new features, commands, or setup steps?
- CLAUDE.md — does it reflect new files, test files, or architecture changes?
- CHANGELOG.md — does it cover every commit?
- TODOS.md — are completed items marked done?
- docs/ — do any guides need updating?

A ship without updated docs is an incomplete ship. Period.

## CHANGELOG + VERSION are branch-scoped

**VERSION and CHANGELOG describe what THIS branch adds vs master, not how we got
here.** Every feature branch that ships gets its own version bump and CHANGELOG
entry. The entry is product release notes for users; it is not a log of internal
decisions, review rounds, or codex findings.

**Write the CHANGELOG entry at /ship time, not during development.** Mid-branch
iterations, review rounds (CEO/Eng/Codex/DX), and implementation detours belong
in the plan file at `~/.claude/plans/`, not in the CHANGELOG. One unified entry
per branch, covering what the branch added vs the base branch.

**Never edit a CHANGELOG entry that already landed on master.** If master has
v0.18.2 and your branch adds features, bump to the next version (v0.19.0, not
editing master's v0.18.2). When merging master into your branch, master may
bring new CHANGELOG entries above yours — push your entry above master's
latest and verify:

- Does CHANGELOG have your branch's own entry separate from master's entries?
- Is VERSION higher than master's VERSION?
- Is your entry the topmost `## [X.Y.Z]` entry?
- `grep "^## \[" CHANGELOG.md` shows a contiguous version sequence?

If any answer is no, fix it before continuing.

**CHANGELOG is for users, not contributors.** Write like product release notes:

- Lead with what the user can now **do** that they couldn't before. Sell the capability.
- Plain language, not implementation details. "You can now..." not "Refactored the..."
- **Never mention internal artifacts**: plan file IDs, decision tags (D-CX-#, F-ENG-#),
  review rounds, codex findings, subcontractor credits. These are invisible to users.
- Put contributor-facing changes in a separate `### For contributors` section at the bottom.
- Every entry should make someone think "oh nice, I want to try that."

**What to omit:**
- "Codex caught X that the CEO review missed" — private process detail.
- "D-CX-3 split errors/warnings" — tag is meaningless to users; name the feature instead.
- "Fix-wave PR #N supersedes #M" — supersede chains belong in PR bodies, not release notes.
- "215 new cases, 3 decisions applied, 7 reviews cleared" — these are planning-mode metrics.

**What to keep:**
- The user-facing change: what commands exist now, what flag was added, what behavior fixed.
- Numbers that mean something to the user: TTHW, commands that timed out before, detection counts.
- Upgrade instructions: `gbrain upgrade` + any manual step if needed.
- Credit to external contributors when a community PR was incorporated.

## CHANGELOG voice + release-summary format

Every version entry in `CHANGELOG.md` MUST start with a release-summary section in
the GStack/Garry voice — one viewport's worth of prose + tables that lands like a
verdict, not marketing. The itemized changelog (subsections, bullets, files) goes
BELOW that summary, separated by a `### Itemized changes` header.

The release-summary section gets read by humans, by the auto-update agent, and by
anyone deciding whether to upgrade. The itemized list is for agents that need to
know exactly what changed.

### Release-summary template

Use this structure for the top of every `## [X.Y.Z]` entry:

1. **Two-line bold headline** (10-14 words total) ... should land like a verdict, not
   marketing. Sound like someone who shipped today and cares whether it works.
2. **Lead paragraph** (3-5 sentences) ... what shipped, what changed for the user.
   Specific, concrete, no AI vocabulary, no em dashes, no hype.
3. **A "The X numbers that matter" section** with:
   - One short setup paragraph naming the source of the numbers (real production
     deployment OR a reproducible benchmark ... name the file/command to run).
   - A table of 3-6 key metrics with BEFORE / AFTER / Δ columns.
   - A second optional table for per-category breakdown if relevant.
   - 1-2 sentences interpreting the most striking number in concrete user terms.
4. **A "What this means for [audience]" closing paragraph** (2-4 sentences) tying
   the metrics to a real workflow shift. End with what to do.

Voice rules:
- No em dashes (use commas, periods, "...").
- No AI vocabulary (delve, robust, comprehensive, nuanced, fundamental, etc.) or
  banned phrases ("here's the kicker", "the bottom line", etc.).
- Real numbers, real file names, real commands. Not "fast" but "~30s on 30K pages."
- Short paragraphs, mix one-sentence punches with 2-3 sentence runs.
- Connect to user outcomes: "the agent does ~3x less reading" beats "improved
  precision."
- Be direct about quality. "Well-designed" or "this is a mess." No dancing.

Source material to pull from:
- CHANGELOG.md previous entry for prior context
- Latest `gbrain-evals/docs/benchmarks/[latest].md` for headline numbers (sibling repo)
- Recent commits (`git log <prev-version>..HEAD --oneline`) for what shipped
- Don't make up numbers. If a metric isn't in a benchmark or production data, don't
  include it. Say "no measurement yet" if asked.

Target length: ~250-350 words for the summary. Should render as one viewport.

### "To take advantage of v[version]" block (required, v0.13+)

After the release-summary and BEFORE `### Itemized changes`, every `## [X.Y.Z]`
entry MUST include a human-readable self-repair block under the heading
`## To take advantage of v[version]`.

Why: `gbrain upgrade` runs `gbrain post-upgrade` which runs `gbrain apply-migrations`.
This chain has a known weak link — `upgrade.ts` catches post-upgrade failures as
best-effort (so the binary still works). When that chain silently fails, users end
up with half-upgraded brains. The self-repair block gives them a paste-ready
recovery path; the v0.13+ `~/.gbrain/upgrade-errors.jsonl` trail + `gbrain doctor`
integration close the loop.

Template (adapt the verify commands per release):

```markdown
## To take advantage of v[version]

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor`
warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v[version].md` the next time you interact with it.**
   [One sentence on whether headless agents need manual action, or whether the
   orchestrator already handled the mechanical side.]
3. **Verify the outcome:**
   ```bash
   [release-specific verify commands, e.g. `gbrain graph ... --depth 2`]
   gbrain stats
   ```
4. **If any step fails or the numbers look wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.
```

**Skip this block** for patches that are pure bug fixes with zero user-facing action
(rare). If the release has a schema migration, data backfill, or new feature the
user needs to verify, the block is required.

The v0.13.0 entry in CHANGELOG.md is the canonical example.

### Itemized changes (the existing rules)

Below the release summary, write `### Itemized changes` and continue with the
detailed subsections (Knowledge Graph Layer, Schema migrations, Security hardening,
Tests, etc.). Same rules as before:

- Lead with what the user can now DO that they couldn't before
- Frame as benefits and capabilities, not files changed or code written
- Make the user think "hell yeah, I want that"
- Bad: "Added GBRAIN_VERIFY.md installation verification runbook"
- Good: "Your agent now verifies the entire GBrain installation end-to-end, catching
  silent sync failures and stale embeddings before they bite you"
- Bad: "Setup skill Phase H and Phase I added"
- Good: "New installs automatically set up live sync so your brain never falls behind"
- **Always credit community contributions.** When a CHANGELOG entry includes work from
  a community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.

### Reference: v0.12.0 entry as canonical example

The v0.12.0 entry in CHANGELOG.md is the canonical example of the format. Match its
structure for every future version: bold headline, lead paragraph, "numbers that
matter" with BrainBench-style before/after table, "what this means" closer, then
`### Itemized changes` with the detailed sections below.

## Version migrations

Create a migration file at `skills/migrations/v[version].md` when a release
includes changes that existing users need to act on. The auto-update agent
reads these files post-upgrade (Section 17, Step 4) and executes them.

**You need a migration file when:**
- New setup step that existing installs don't have (e.g., v0.5.0 added live sync,
  existing users need to set it up, not just new installs)
- New SKILLPACK section with a MUST ADD setup requirement
- Schema changes that require `gbrain init` or manual SQL
- Changed defaults that affect existing behavior
- Deprecated commands or flags that need replacement
- New verification steps that should run on existing installs
- New cron jobs or background processes that should be registered

**You do NOT need a migration file when:**
- Bug fixes with no behavior changes
- Documentation-only improvements (the agent re-reads docs automatically)
- New optional features that don't affect existing setups
- Performance improvements that are transparent

**The key test:** if an existing user upgrades and does nothing else, will their
brain work worse than before? If yes, migration file. If no, skip it.

Write migration files as agent instructions, not technical notes. Tell the agent
what to do, step by step, with exact commands. See `skills/migrations/v0.5.0.md`
for the pattern.

## Migration is canonical, not advisory

GBrain's job is to deliver a canonical, working setup to every user on upgrade.
Anything that looks like a "host-repo change" — AGENTS.md, cron manifests,
launchctl units, config files outside `~/.gbrain/` — is a GBrain migration
step, not a nudge we leave for the host-repo maintainer. Migrations edit host
files (with backups) to make the canonical setup real. Exceptions: changes
that require human judgment (content edits, renames that break semantics,
host-specific handler registration where shell-exec would be an RCE surface).
Everything mechanical ships in the migration.

**Test:** if shipping a feature requires a sentence that starts with "in
your AGENTS.md, add…" or "in your cron/jobs.json, rewrite…", the migration
orchestrator should be doing that edit, not the user.

**The exception is host-specific code.** For custom Minion handlers
(host-specific integrations like inbox sweeps or third-party API scanners), shipping them as a
data file the worker would exec is an RCE surface. Those get registered in
the host's own repo via the plugin contract (`docs/guides/plugin-handlers.md`);
the migration orchestrator emits a structured TODO to
`~/.gbrain/migrations/pending-host-work.jsonl` + the host agent walks the
TODOs using `skills/migrations/v0.11.0.md` — stays host-agnostic, still
canonical.

## Privacy rule: scrub real names from public docs

**Never reference real people, companies, funds, or private agent names in any
public-facing artifact.** Public artifacts include: `CHANGELOG.md`, `README.md`,
`docs/`, `skills/`, PR titles + bodies, commit messages, and comments in checked-in
code. Query examples, benchmark stories, and migration guides MUST use generic
placeholders.

Why: gbrain runs a personal knowledge brain containing notes on real people and
real companies (YC founders, portfolio companies, funds, investors, meeting
attendees). When a doc copies a query like `gbrain graph diana-hu --depth 2` or
names a specific agent fork like `Wintermute`, that real name gets indexed by
search engines, surfaced in cross-references, and distributed with every release.

**Name mapping** to use in examples:
- Agent forks → `your agent fork`, `a downstream agent`, or `agent-fork`
- Example person → `alice-example`, `charlie-example`, or `a-founder`
- Example company → `acme-example`, `widget-co`, or `a-company`
- Example fund → `fund-a`, `fund-b`, `fund-c`
- Example deal → `acme-seed`, `widget-series-a`
- Example meeting → `meetings/2026-04-03` (generic date is fine)
- Example user → `you` or `the user`, never a proper name

**Specific rule: never say `Wintermute` in any CHANGELOG, README, doc, PR, or
commit message.** When the temptation is to illustrate with the real fork name:
- Reader-facing copy → `your OpenClaw` (covers Wintermute, Hermes, AlphaClaw,
  and any other downstream OpenClaw deployment in one term the reader already
  recognizes).
- First-person / origin-story copy → `Garry's OpenClaw` (honest that this is
  the production deployment driving the feature, without exposing the private
  agent's name).

`Wintermute` may appear in private artifacts (scratch plans under
`~/.gstack/projects/…`, memory files, conversation transcripts, CEO-review
plans) — those aren't distributed. Anything checked into this repo or shipped
in a release must use the OpenClaw phrasing above. Sweeping a stale reference
is a small clean-up PR, not a debate.

**When in doubt, ask yourself:** "Would this query reveal private information
about the user's contacts, investments, or portfolio if it were read by a
stranger?" If yes, replace with generic placeholders.

**Illustrative API examples with household-brand companies** (Stripe, Brex, OpenAI,
GitHub, etc.) are fine — they're public entities, not contacts in anyone's brain.
Do not confuse illustrative API examples with queries that reveal real
relationships.

## Responsible-disclosure rule: don't broadcast attack surface in release notes

**When a release fixes a security gap or a user-impacting bug, describe the fix
functionally. Do not enumerate the attack surface, quantify the exposure window,
or highlight the most sensitive records by name in public-facing artifacts.**

Public-facing artifacts include: `CHANGELOG.md`, `README.md`, `docs/`, PR titles
and bodies, commit messages, GitHub issue titles and comments, release pages,
tweets, blog posts.

**Don't write:**
- "10 tables were publicly readable by the anon key for months, including X, Y, Z"
- "X and Y are the most sensitive ones"
- "N tables exposed. Fix: enable RLS on these specific tables: ..."

**Do write:**
- "Security hardening pass. Fresh installs secure by default. Existing brains
  brought to the same bar automatically on upgrade."
- "If `gbrain doctor` still flags anything after upgrade, the message names each
  table and gives the exact fix."

Why: anyone reading the release page before they've upgraded now has a directed
probe list for unpatched installs. The source code ships the specifics anyway
(`src/schema.sql`, `src/core/migrate.ts`, test fixtures) — reverse engineers can
get them. But the release page is a broadcast channel. Don't hand attackers a
curated list with a banner.

**The test:** if a reader with no prior context could read the release note and
walk away knowing "gbrain at version X has table Y readable by anon key until
they patch," the note is too specific. Rewrite until that's no longer possible.

**What IS fine in public artifacts:**
- The mechanism of the fix ("the check now scans every public table instead of
  a hardcoded allowlist").
- User-facing operator ergonomics (the escape-hatch SQL template, the upgrade
  commands, the breaking-change flag).
- Credit to contributors.
- Generic framing of severity ("security posture tightening pass") without
  quantification.

**What stays in private artifacts (plan files, private memories, internal docs):**
- Specific table names, record counts, exposure duration.
- Which records stand out as highest-risk.
- Detailed before/after tables in the "numbers that matter" format.

If the CEO/Eng review of a plan produces a detailed exposure table, keep it in
the plan file under `~/.claude/plans/` or `~/.gstack/projects/`. Don't copy it
into the CHANGELOG or PR body.

Applies retroactively: if you see a prior CHANGELOG entry naming attack-surface
specifics, scrub it as a small cleanup commit, the same way a stale Wintermute
reference gets swept.

## Schema state tracking

`~/.gbrain/update-state.json` tracks which recommended schema directories the user
adopted, declined, or added custom. The auto-update agent (SKILLPACK Section 17)
reads this during upgrades to suggest new schema additions without re-suggesting
things the user already declined. The setup skill writes the initial state during
Phase C/E. Never modify a user's custom directories or re-suggest declined ones.

## GitHub Actions SHA maintenance

All GitHub Actions in `.github/workflows/` are pinned to commit SHAs. Before shipping
(`/ship`) or reviewing (`/review`), check for stale pins and update them:

```bash
for action in actions/checkout oven-sh/setup-bun actions/upload-artifact actions/download-artifact softprops/action-gh-release gitleaks/gitleaks-action; do
  tag=$(grep -r "$action@" .github/workflows/ | head -1 | grep -o '#.*' | tr -d '# ')
  [ -n "$tag" ] && echo "$action@$tag: $(gh api repos/$action/git/ref/tags/$tag --jq .object.sha 2>/dev/null)"
done
```

If any SHA differs from what's in the workflow files, update the pin and version comment.

## PR descriptions cover the whole branch

Pull request titles and bodies must describe **everything in the PR diff against the
base branch**, not just the most recent commit you made. When you open or update a
PR, walk the full commit range with `git log --oneline <base>..<head>` and write the
body to cover all of it. Group by feature area (schema, code, tests, docs) — not
chronologically by commit.

This matters because reviewers read the PR body to understand what's shipping. If
the body only covers your last commit, they miss everything else and can't review
properly. A 7-commit PR with a body that describes commit 7 is worse than no body
at all — it actively misleads.

When in doubt, run `gh pr view <N> --json commits --jq '[.commits[].messageHeadline]'`
to see what's actually in the PR before writing the body.

## Community PR wave process

Never merge external PRs directly into master. Instead, use the "fix wave" workflow:

1. **Categorize** — group PRs by theme (bug fixes, features, infra, docs)
2. **Deduplicate** — if two PRs fix the same thing, pick the one that changes fewer
   lines. Close the other with a note pointing to the winner.
3. **Collector branch** — create a feature branch (e.g. `garrytan/fix-wave-N`), cherry-pick
   or manually re-implement the best fixes from each PR. Do NOT merge PR branches directly —
   read the diff, understand the fix, and write it yourself if needed.
4. **Test the wave** — verify with `bun test && bun run test:e2e` (full E2E lifecycle).
   Every fix in the wave must have test coverage.
5. **Close with context** — every closed PR gets a comment explaining why and what (if
   anything) supersedes it. Contributors did real work; respect that with clear communication
   and thank them.
6. **Ship as one PR** — single PR to master with all attributions preserved via
   `Co-Authored-By:` trailers. Include a summary of what merged and what closed.

**Community PR guardrails:**
- Always AskUserQuestion before accepting commits that touch voice, tone, or
  promotional material (README intro, CHANGELOG voice, skill templates).
- Never auto-merge PRs that remove YC references or "neutralize" the founder perspective.
- Preserve contributor attribution in commit messages.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

**NEVER hand-roll ship operations.** Do not manually run git commit + push + gh pr
create when /ship is available. /ship handles VERSION bump, CHANGELOG, document-release,
pre-landing review, test coverage audit, and adversarial review. Manually creating a PR
skips all of these. If the user says "commit and ship", "push and ship", "bisect and
ship", or any combination that ends with shipping — invoke /ship and let it handle
everything including the commits. If the branch name contains a version (e.g.
`v0.5-live-sync`), /ship should use that version for the bump.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR, "commit and ship", "push and ship" → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
