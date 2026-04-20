# CLAUDE.md

GBrain is a personal knowledge brain and GStack mod for agent platforms. Pluggable
engines: PGLite (embedded Postgres via WASM, zero-config default) or Postgres + pgvector
+ hybrid search in a managed Supabase instance. `gbrain init` defaults to PGLite;
suggests Supabase for 1000+ files. GStack teaches agents how to code. GBrain teaches
agents everything else: brain ops, signal detection, content ingestion, enrichment,
cron scheduling, reports, identity, and access control.

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

- `src/core/operations.ts` — Contract-first operation definitions (the foundation). Also exports upload validators: `validateUploadPath`, `validatePageSlug`, `validateFilename`. `OperationContext.remote` flags untrusted callers.
- `src/core/engine.ts` — Pluggable engine interface (BrainEngine). `clampSearchLimit(limit, default, cap)` takes an explicit cap so per-operation caps can be tighter than `MAX_SEARCH_LIMIT`. Exports `LinkBatchInput` / `TimelineBatchInput` for the v0.12.1 bulk-insert API (`addLinksBatch` / `addTimelineEntriesBatch`).
- `src/core/engine-factory.ts` — Engine factory with dynamic imports (`'pglite'` | `'postgres'`)
- `src/core/pglite-engine.ts` — PGLite (embedded Postgres 17.5 via WASM) implementation, all 40 BrainEngine methods. `addLinksBatch` / `addTimelineEntriesBatch` use multi-row `unnest()` with manual `$N` placeholders.
- `src/core/pglite-schema.ts` — PGLite-specific DDL (pgvector, pg_trgm, triggers)
- `src/core/postgres-engine.ts` — Postgres + pgvector implementation (Supabase / self-hosted). `addLinksBatch` / `addTimelineEntriesBatch` use `INSERT ... SELECT FROM unnest($1::text[], ...) JOIN pages ON CONFLICT DO NOTHING RETURNING 1` — 4-5 array params regardless of batch size, sidesteps the 65535-parameter cap. As of v0.12.3, `searchKeyword` / `searchVector` scope `statement_timeout` via `sql.begin` + `SET LOCAL` so the GUC dies with the transaction instead of leaking across the pooled postgres.js connection (contributed by @garagon). `getEmbeddingsByChunkIds` uses `tryParseEmbedding` so one corrupt row skips+warns instead of killing the query.
- `src/core/utils.ts` — Shared SQL utilities extracted from postgres-engine.ts. Exports `parseEmbedding(value)` (throws on unknown input, used by migration + ingest paths where data integrity matters) and as of v0.12.3 `tryParseEmbedding(value)` (returns `null` + warns once per process, used by search/rescore paths where availability matters more than strictness).
- `src/core/db.ts` — Connection management, schema initialization
- `src/commands/migrate-engine.ts` — Bidirectional engine migration (`gbrain migrate --to supabase/pglite`)
- `src/core/import-file.ts` — importFromFile + importFromContent (chunk + embed + tags)
- `src/core/sync.ts` — Pure sync functions (manifest parsing, filtering, slug conversion)
- `src/core/storage.ts` — Pluggable storage interface (S3, Supabase Storage, local)
- `src/core/supabase-admin.ts` — Supabase admin API (project discovery, pgvector check)
- `src/core/file-resolver.ts` — File resolution with fallback chain (local -> .redirect.yaml -> .redirect -> .supabase)
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided)
- `src/core/search/` — Hybrid search: vector + keyword + RRF + multi-query expansion + dedup
- `src/core/search/intent.ts` — Query intent classifier (entity/temporal/event/general → auto-selects detail level)
- `src/core/search/eval.ts` — Retrieval eval harness: P@k, R@k, MRR, nDCG@k metrics + runEval() orchestrator
- `src/commands/eval.ts` — `gbrain eval` command: single-run table + A/B config comparison
- `src/core/embedding.ts` — OpenAI text-embedding-3-large, batch, retry, backoff
- `src/core/check-resolvable.ts` — Resolver validation: reachability, MECE overlap, DRY checks, structured fix objects. v0.14.1: `CROSS_CUTTING_PATTERNS.conventions` is an array (notability gate accepts both `conventions/quality.md` and `_brain-filing-rules.md`). New `extractDelegationTargets()` parses `> **Convention:**`, `> **Filing rule:**`, and inline backtick references. DRY suppression is proximity-based via `DRY_PROXIMITY_LINES = 40`.
- `src/core/dry-fix.ts` — `gbrain doctor --fix` engine. `autoFixDryViolations(fixes, {dryRun})` rewrites inlined rules to `> **Convention:** see [path](path).` callouts via three shape-aware expanders (bullet / blockquote / paragraph). Five guards: working-tree-dirty (`getWorkingTreeStatus()` returns 3-state `'clean' | 'dirty' | 'not_a_repo'`), no-git-backup, inside-code-fence, already-delegated (40-line proximity, consistent with detector), ambiguous-multi-match, block-is-callout. `execFileSync` array args (no shell — no injection surface). EOF newline preserved.
- `src/core/backoff.ts` — Adaptive load-aware throttling: CPU/memory checks, exponential backoff, active hours multiplier
- `src/core/fail-improve.ts` — Deterministic-first, LLM-fallback loop with JSONL failure logging and auto-test generation
- `src/core/transcription.ts` — Audio transcription: Groq Whisper (default), OpenAI fallback, ffmpeg segmentation for >25MB
- `src/core/enrichment-service.ts` — Global enrichment service: entity slug generation, tier auto-escalation, batch throttling
- `src/core/data-research.ts` — Recipe validation, field extraction (MRR/ARR regex), dedup, tracker parsing, HTML stripping
- `src/commands/extract.ts` — `gbrain extract links|timeline|all [--source fs|db]`: batch link/timeline extraction. fs walks markdown files, db walks pages from the engine (mutation-immune snapshot iteration; use this for live brains with no local checkout). As of v0.12.1 there is no in-memory dedup pre-load — candidates are buffered 100 at a time and flushed via `addLinksBatch` / `addTimelineEntriesBatch`; `ON CONFLICT DO NOTHING` enforces uniqueness at the DB layer, and the `created` counter returns real rows inserted (truthful on re-runs).
- `src/commands/graph-query.ts` — `gbrain graph-query <slug> [--type T] [--depth N] [--direction in|out|both]`: typed-edge relationship traversal (renders indented tree)
- `src/core/link-extraction.ts` — shared library for the v0.12.0 graph layer. extractEntityRefs (canonical, replaces backlinks.ts duplicate) matches both `[Name](people/slug)` markdown links and Obsidian `[[people/slug|Name]]` wikilinks as of v0.12.3. extractPageLinks, inferLinkType heuristics (attended/works_at/invested_in/founded/advises/source/mentions), parseTimelineEntries, isAutoLinkEnabled config helper. `DIR_PATTERN` covers `people`, `companies`, `deals`, `topics`, `concepts`, `projects`, `entities`, `tech`, `finance`, `personal`, `openclaw`. Used by extract.ts, operations.ts auto-link post-hook, and backlinks.ts.
- `src/core/minions/` — Minions job queue: BullMQ-inspired, Postgres-native (queue, worker, backoff, types)
- `src/core/minions/queue.ts` — MinionQueue class (submit, claim, complete, fail, stall detection, parent-child, depth/child-cap, per-job timeouts, cascade-kill, attachments, idempotency keys, child_done inbox, removeOnComplete/Fail). `add()` takes a 4th `trusted` arg (separate from `opts` to prevent spread leakage); protected names in `PROTECTED_JOB_NAMES` require `{allowProtectedSubmit: true}` and the check runs trim-normalized (whitespace-bypass safe).
- `src/core/minions/worker.ts` — MinionWorker class (handler registry, lock renewal, graceful shutdown, timeout safety net). v0.14.0 abort-path fix: aborted jobs now call `failJob` with reason (`timeout`/`cancel`/`lock-lost`/`shutdown`) instead of returning silently. `shutdownAbort` (instance field) fires on process SIGTERM/SIGINT and propagates to `ctx.shutdownSignal` — shell handler listens to it; non-shell handlers don't.
- `src/core/minions/protected-names.ts` — side-effect-free constant module exporting `PROTECTED_JOB_NAMES` + `isProtectedJobName()`. Kept pure so queue core can import without loading handler modules.
- `src/core/minions/handlers/shell.ts` — `shell` job handler. Spawns `/bin/sh -c cmd` (absolute path, PATH-override-safe) or `argv[0] argv[1..]` (no shell). Env allowlist: `PATH, HOME, USER, LANG, TZ, NODE_ENV` + caller `env:` overrides. UTF-8-safe stdout/stderr tail via `string_decoder.StringDecoder`. Abort (either `ctx.signal` or `ctx.shutdownSignal`) fires SIGTERM → 5s grace → SIGKILL on child. Requires `GBRAIN_ALLOW_SHELL_JOBS=1` on worker (gated by `registerBuiltinHandlers`).
- `src/core/minions/handlers/shell-audit.ts` — per-submission JSONL audit trail at `~/.gbrain/audit/shell-jobs-YYYY-Www.jsonl` (ISO-week rotation; override via `GBRAIN_AUDIT_DIR`). Best-effort: `mkdirSync(recursive)` + `appendFileSync`; failures logged to stderr, submission not blocked. Logs cmd (first 80 chars) or argv (JSON array). Never logs env values.
- `src/core/minions/attachments.ts` — Attachment validation (path traversal, null byte, oversize, base64, duplicate detection)
- `src/commands/jobs.ts` — `gbrain jobs` CLI subcommands + `gbrain jobs work` daemon
- `src/commands/features.ts` — `gbrain features --json --auto-fix`: usage scan + feature adoption salesman
- `src/commands/autopilot.ts` — `gbrain autopilot --install`: self-maintaining brain daemon (sync+extract+embed)
- `src/mcp/server.ts` — MCP stdio server (generated from operations)
- `src/commands/auth.ts` — Standalone token management (create/list/revoke/test)
- `src/commands/upgrade.ts` — Self-update CLI. `runPostUpgrade()` enumerates migrations from the TS registry (src/commands/migrations/index.ts) and tail-calls `runApplyMigrations(['--yes', '--non-interactive'])` so the mechanical side of every outstanding migration runs unconditionally.
- `src/commands/migrations/` — TS migration registry (compiled into the binary; no filesystem walk of `skills/migrations/*.md` needed at runtime). `index.ts` lists migrations in semver order. `v0_11_0.ts` = Minions adoption orchestrator (8 phases). `v0_12_0.ts` = Knowledge Graph auto-wire orchestrator (5 phases: schema → config check → backfill links → backfill timeline → verify). `phaseASchema` has a 600s timeout (bumped from 60s in v0.12.1 for duplicate-heavy brains). `v0_12_2.ts` = JSONB double-encode repair orchestrator (4 phases: schema → repair-jsonb → verify → record). `v0_14_0.ts` = shell-jobs + autopilot cooperative (2 phases: schema ALTER minion_jobs.max_stalled SET DEFAULT 3, pending-host-work ping for skills/migrations/v0.14.0.md). All orchestrators are idempotent and resumable from `partial` status. As of v0.14.2 (Bug 3), the RUNNER owns all ledger writes — orchestrators return `OrchestratorResult` and `apply-migrations.ts` persists a canonical `{version, status, phases}` shape after return. Orchestrators no longer call `appendCompletedMigration` directly. `statusForVersion` prefers `complete` over `partial` (never regresses). 3 consecutive partials → wedged → `--force-retry <version>` writes a `'retry'` reset marker.
- `src/commands/repair-jsonb.ts` — `gbrain repair-jsonb [--dry-run] [--json]`: rewrites `jsonb_typeof='string'` rows in place across 5 affected columns (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter). Fixes v0.12.0 double-encode bug on Postgres; PGLite no-ops. Idempotent.
- `src/commands/orphans.ts` — `gbrain orphans [--json] [--count] [--include-pseudo]`: surfaces pages with zero inbound wikilinks, grouped by domain. Auto-generated/raw/pseudo pages filtered by default. Also exposed as `find_orphans` MCP operation. Shipped in v0.12.3 (contributed by @knee5).
- `src/commands/doctor.ts` — `gbrain doctor [--json] [--fast] [--fix] [--dry-run]`: health checks. v0.12.3 adds two reliability detection checks: `jsonb_integrity` (scans pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata for `jsonb_typeof='string'` rows left over from v0.12.0) and `markdown_body_completeness` (flags pages whose compiled_truth is <30% of raw source when raw has multiple H2/H3 boundaries). Fix hints point at `gbrain repair-jsonb` and `gbrain sync --force`. v0.14.1: `--fix` delegates inlined cross-cutting rules to `> **Convention:** see [path](path).` callouts (pipes DRY violations into `src/core/dry-fix.ts`); `--fix --dry-run` previews without writing.
- `src/core/markdown.ts` — Frontmatter parsing + body splitter. `splitBody` requires an explicit timeline sentinel (`<!-- timeline -->`, `--- timeline ---`, or `---` immediately before `## Timeline`/`## History`). Plain `---` in body text is a markdown horizontal rule, not a separator. `inferType` auto-types `/wiki/analysis/` → analysis, `/wiki/guides/` → guide, `/wiki/hardware/` → hardware, `/wiki/architecture/` → architecture, `/writing/` → writing (plus the existing people/companies/deals/etc heuristics).
- `scripts/check-jsonb-pattern.sh` — CI grep guard. Fails the build if anyone reintroduces the `${JSON.stringify(x)}::jsonb` interpolation pattern (which postgres.js v3 double-encodes). Wired into `bun test`.
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
- `docs/benchmarks/` — Search quality benchmark results (reproducible, fictional data)
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
- `skills/minion-orchestrator/SKILL.md` — Background job orchestration: submit, fan out children with depth/cap/timeouts, collect results via child_done inbox
- `templates/` — SOUL.md, USER.md, ACCESS_POLICY.md, HEARTBEAT.md templates
- `skills/migrations/` — Version migration files with feature_pitch YAML frontmatter
- `src/commands/publish.ts` — Deterministic brain page publisher (code+skill pair, zero LLM calls)
- `src/commands/backlinks.ts` — Back-link checker and fixer (enforces Iron Law)
- `src/commands/lint.ts` — Page quality linter (catches LLM artifacts, placeholder dates)
- `src/commands/report.ts` — Structured report saver (audit trail for maintenance/enrichment)
- `openclaw.plugin.json` — ClawHub bundle plugin manifest

## Commands

Run `gbrain --help` or `gbrain --tools-json` for full command reference.

Key commands added in v0.7:
- `gbrain init` — defaults to PGLite (no Supabase needed), scans repo size, suggests Supabase for 1000+ files
- `gbrain migrate --to supabase` / `gbrain migrate --to pglite` — bidirectional engine migration

Key commands added for Minions (job queue):
- `gbrain jobs submit <name> [--params JSON] [--follow] [--dry-run]` — submit a background job
- `gbrain jobs list [--status S] [--queue Q]` — list jobs with filters
- `gbrain jobs get <id>` — job details with attempt history
- `gbrain jobs cancel/retry/delete <id>` — manage job lifecycle
- `gbrain jobs prune [--older-than 30d]` — clean old completed/dead jobs
- `gbrain jobs stats` — job health dashboard
- `gbrain jobs work [--queue Q] [--concurrency N]` — start worker daemon (Postgres only)

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

## Testing

`bun test` runs all tests. After the v0.12.1 release: ~75 unit test files + 8 E2E test files (1412 unit pass, 119 E2E when `DATABASE_URL` is set — skip gracefully otherwise). Unit tests run
without a database. E2E tests skip gracefully when `DATABASE_URL` is not set.

Unit tests: `test/markdown.test.ts` (frontmatter parsing), `test/chunkers/recursive.test.ts`
(chunking), `test/parity.test.ts` (operations contract
parity), `test/cli.test.ts` (CLI structure), `test/config.test.ts` (config redaction),
`test/files.test.ts` (MIME/hash), `test/import-file.test.ts` (import pipeline),
`test/upgrade.test.ts` (schema migrations),
`test/file-migration.test.ts` (file migration), `test/file-resolver.test.ts` (file resolution),
`test/import-resume.test.ts` (import checkpoints), `test/migrate.test.ts` (migration; v8/v9 helper-btree-index SQL structural assertions + 1000-row wall-clock fixtures that guard the O(n²)→O(n log n) fix),
`test/setup-branching.test.ts` (setup flow), `test/slug-validation.test.ts` (slug validation),
`test/storage.test.ts` (storage backends), `test/supabase-admin.test.ts` (Supabase admin),
`test/yaml-lite.test.ts` (YAML parsing), `test/check-update.test.ts` (version check + update CLI),
`test/pglite-engine.test.ts` (PGLite engine, all 40 BrainEngine methods including 11 cases for `addLinksBatch` / `addTimelineEntriesBatch`: empty batch, missing optionals, within-batch dedup via ON CONFLICT, missing-slug rows dropped by JOIN, half-existing batch, batch of 100),
`test/engine-factory.test.ts` (engine factory + dynamic imports),
`test/integrations.test.ts` (recipe parsing, CLI routing, recipe validation),
`test/publish.test.ts` (content stripping, encryption, password generation, HTML output),
`test/backlinks.test.ts` (entity extraction, back-link detection, timeline entry generation),
`test/lint.test.ts` (LLM artifact detection, code fence stripping, frontmatter validation),
`test/report.test.ts` (report format, directory structure),
`test/skills-conformance.test.ts` (skill frontmatter + required sections validation),
`test/resolver.test.ts` (RESOLVER.md coverage, routing validation),
`test/search.test.ts` (RRF normalization, compiled truth boost, cosine similarity, dedup key),
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
`test/minions.test.ts` (Minions job queue v7: CRUD, state machine, backoff, stall detection, dependencies, worker lifecycle, lock management, claim mechanics, depth/child-cap, timeouts, cascade kill, idempotency, child_done inbox, attachments, removeOnComplete/Fail),
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
`test/doctor.test.ts` (doctor command + v0.12.3 assertions that `jsonb_integrity` scans the four v0.12.0 write sites and `markdown_body_completeness` is present),
`test/utils.test.ts` (shared SQL utilities + `tryParseEmbedding` null-return and single-warn semantics),
`test/build-llms.test.ts` (llms.txt/llms-full.txt generator: path resolution, idempotence, spec shape, regen-drift guard, content contract, AGENTS.md install-path mirror, size-budget enforcement — 7 cases).

E2E tests (`test/e2e/`): Run against real Postgres+pgvector. Require `DATABASE_URL`.
- `bun run test:e2e` runs Tier 1 (mechanical, all operations, no API keys). Includes 9 dedicated cases for the postgres-engine `addLinksBatch` / `addTimelineEntriesBatch` bind path — postgres-js's `unnest()` binding is structurally different from PGLite's and gets its own coverage.
- `test/e2e/search-quality.test.ts` runs search quality E2E against PGLite (no API keys, in-memory)
- `test/e2e/graph-quality.test.ts` runs the v0.10.3 knowledge graph pipeline (auto-link via put_page, reconciliation, traversePaths) against PGLite in-memory
- `test/e2e/postgres-jsonb.test.ts` — v0.12.2 regression test. Round-trips all 5 JSONB write sites (pages.frontmatter, raw_data.data, ingest_log.pages_updated, files.metadata, page_versions.frontmatter) against real Postgres and asserts `jsonb_typeof='object'` plus `->>'key'` returns the expected scalar. The test that should have caught the original double-encode bug.
- `test/e2e/jsonb-roundtrip.test.ts` — v0.12.3 companion regression against the 4 doctor-scanned JSONB sites. Assertion-level overlap with `postgres-jsonb.test.ts` is intentional defense-in-depth: if doctor's scan surface ever drifts from the actual write surface, one of these tests catches it.
- `test/e2e/upgrade.test.ts` runs check-update E2E against real GitHub API (network required)
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

Read the skill files in `skills/` before doing brain operations. GBrain ships 26 skills
organized by `skills/RESOLVER.md`:

**Original 8 (conformance-migrated):** ingest (thin router), query, maintain, enrich,
briefing, migrate, setup, publish.

**Brain skills (ported from an upstream agent fork):** signal-detector, brain-ops, idea-ingest, media-ingest,
meeting-ingestion, citation-fixer, repo-architecture, skill-creator, daily-task-manager.

**Operational + identity:** daily-task-prep, cross-modal-review, cron-scheduler, reports,
testing, soul-audit, webhook-transforms, data-research, minion-orchestrator.

**Conventions:** `skills/conventions/` has cross-cutting rules (quality, brain-first,
model-routing, test-before-bulk, cross-modal). `skills/_brain-filing-rules.md` and
`skills/_output-rules.md` are shared references.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite:
- `bun test` — unit tests (no database required)
- Follow the "E2E test DB lifecycle" steps above to spin up the test DB,
  run `bun run test:e2e`, then tear it down.

Both must pass. Do not ship with failing E2E tests. Do not skip E2E tests.

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
- `docs/benchmarks/[latest].md` for the headline numbers
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

**When in doubt, ask yourself:** "Would this query reveal private information
about the user's contacts, investments, or portfolio if it were read by a
stranger?" If yes, replace with generic placeholders.

**Illustrative API examples with household-brand companies** (Stripe, Brex, OpenAI,
GitHub, etc.) are fine — they're public entities, not contacts in anyone's brain.
Do not confuse illustrative API examples with queries that reveal real
relationships.

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
