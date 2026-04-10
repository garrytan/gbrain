# Changelog

All notable changes to GBrain will be documented in this file.

## [0.5.0] - 2026-04-10

### Added

- **Your brain never falls behind.** Live sync keeps the vector DB current with your brain repo automatically. Set up a cron, use `--watch`, hook into GitHub webhooks, or use git hooks. Your agent picks whatever fits its environment. Edit a markdown file, push, and within minutes it's searchable. No more stale embeddings serving wrong answers.
- **Know your install actually works.** New verification runbook (`docs/GBRAIN_VERIFY.md`) catches the silent failures that used to go unnoticed: the pooler bug that skips pages, missing embeddings, stale sync. The real test: push a correction, wait, search for it. If the old text comes back, sync is broken and the runbook tells you exactly why.
- **New installs set up live sync automatically.** The setup skill now includes live sync (Phase H) and full verification (Phase I) as mandatory steps. Agents that install GBrain will configure automatic sync and verify it works before declaring setup complete.
- **Fixes the silent page-skip bug.** If your Supabase connection uses the Transaction mode pooler, sync silently skips most pages. The new docs call this out as a hard prerequisite with a clear fix (switch to Session mode). The verification runbook catches it by comparing page count against file count.

## [0.4.2] - 2026-04-10

### Changed

- All GitHub Actions pinned to commit SHAs across test, e2e, and release workflows. Prevents supply chain attacks via mutable version tags.
- Workflow permissions hardened: `contents: read` on test and e2e workflows limits GITHUB_TOKEN blast radius.
- OpenClaw CI install pinned to v2026.4.9 instead of pulling latest.

### Added

- Gitleaks secret scanning CI job runs on every push and PR. Catches accidentally committed API keys, tokens, and credentials.
- `.gitleaks.toml` config with allowlists for test fixtures and example files.
- GitHub Actions SHA maintenance rule in CLAUDE.md so pins stay fresh on every `/ship` and `/review`.
- S3 Sig V4 TODO for future implementation when S3 storage becomes a deployment path.

## [0.4.1] - 2026-04-09

### Added

- `gbrain check-update` command with `--json` output. Checks GitHub Releases for new versions, compares semver (minor+ only, skips patches), fetches and parses changelog diffs. Fail-silent on network errors.
- SKILLPACK Section 17: Auto-Update Notifications. Full agent playbook for the update lifecycle: check, notify, consent, upgrade, skills refresh, schema sync, report. Never auto-upgrades without user permission.
- Standalone SKILLPACK self-update for users who load the skillpack directly without the gbrain CLI. Version markers in SKILLPACK and RECOMMENDED_SCHEMA headers, with raw GitHub URL fetching.
- Step 7 in the OpenClaw install paste: daily update checks, default-on. User opts into being notified about updates, not into automatic installs.
- Setup skill Phase G: conditional auto-update offer for manual install users.
- Schema state tracking via `~/.gbrain/update-state.json`. Tracks which recommended schema directories the user adopted, declined, or added custom. Future upgrades suggest new additions without re-suggesting declined items.
- `skills/migrations/` directory convention for version-specific post-upgrade agent directives.
- 20 unit tests and 5 E2E tests for the check-update command, covering version comparison, changelog extraction, CLI wiring, and real GitHub API interaction.
- E2E test DB lifecycle documentation in CLAUDE.md: spin up, run tests, tear down. No orphaned containers.

### Changed

- `detectInstallMethod()` exported from `upgrade.ts` for reuse by `check-update`.

### Fixed

- Semver comparison in changelog extraction was missing major-version guard, causing incorrect changelog entries to appear when crossing major version boundaries.

## [0.4.0] - 2026-04-09

### Added

- `gbrain doctor` command with `--json` output. Checks pgvector extension, RLS policies, schema version, embedding coverage, and connection health. Agents can self-diagnose issues.
- Pluggable storage backends: S3, Supabase Storage, and local filesystem. Choose where binary files live independently of the database. Configured via `gbrain init` or environment variables.
- Parallel import with per-worker engine instances. Large brain imports now use multiple database connections concurrently instead of a single serial pipeline.
- Import resume checkpoints. If `gbrain import` is interrupted, it picks up where it left off instead of re-importing everything.
- Automatic schema migration runner. On connect, gbrain detects the current schema version and applies any pending migrations without manual intervention.
- Row-Level Security (RLS) enabled on all tables with `BYPASSRLS` safety check. Every query goes through RLS policies.
- `--json` flag on `gbrain init` and `gbrain import` for machine-readable output. Agents can parse structured results instead of scraping CLI text.
- File migration CLI (`gbrain files migrate`) for moving files between storage backends. Two-way-door: test with `--dry-run`, migrate incrementally.
- Bulk chunk INSERT for faster page writes. Chunks are inserted in a single statement instead of one-at-a-time.
- Supabase smart URL parsing: automatically detects and converts IPv6-only pooler URLs to the correct connection format.
- 56 new unit tests covering doctor, storage backends, file migration, import resume, slug validation, setup branching, Supabase admin, and YAML parsing. Test suite grew from 9 to 19 test files.
- E2E tests for parallel import concurrency and all new features.

### Fixed

- `validateSlug` now accepts any filename characters (spaces, unicode, special chars) instead of rejecting non-alphanumeric slugs. Apple Notes and other real-world filenames import cleanly.
- Import resilience: files over 5MB are skipped with a warning instead of crashing the pipeline. Errors in individual files no longer abort the entire import.
- `gbrain init` detects IPv6-only Supabase URLs and adds the required `pgvector` check during setup.
- E2E test fixture counts, CLI argument parsing, and doctor exit codes cleaned up.

### Changed

- Setup skill and README rewritten for agent-first developer experience.
- Maintain skill updated with RLS verification, schema health checks, and `nohup` hints for large embedding jobs.

## [0.3.0] - 2026-04-08

### Added

- Contract-first architecture: single `operations.ts` defines ~30 shared operations. CLI, MCP, and tools-json all generated from the same source. Zero drift.
- `OperationError` type with structured error codes (`page_not_found`, `invalid_params`, `embedding_failed`, etc.). Agents can self-correct.
- `dry_run` parameter on all mutating operations. Agents preview before committing.
- `importFromContent()` split from `importFile()`. Both share the same chunk+embed+tag pipeline, but `importFromContent` works from strings (used by `put_page`). Wrapped in `engine.transaction()`.
- Idempotency hash now includes ALL fields (title, type, frontmatter, tags), not just compiled_truth + timeline. Metadata-only edits no longer silently skipped.
- `get_page` now supports optional `fuzzy: true` for slug resolution. Returns `resolved_slug` so callers know what happened.
- `query` operation now supports `expand` toggle (default true). Both CLI and MCP get the same control.
- 10 new operations wired up: `put_raw_data`, `get_raw_data`, `resolve_slugs`, `get_chunks`, `log_ingest`, `get_ingest_log`, `file_list`, `file_upload`, `file_url`.
- OpenClaw bundle plugin manifest (`openclaw.plugin.json`) with config schema, MCP server config, and skill listing.
- GitHub Actions CI: test on push/PR, multi-platform release builds (macOS arm64 + Linux x64) on version tags.
- `gbrain init --non-interactive` flag for plugin mode (accepts config via flags/env vars, no TTY required).
- Post-upgrade version verification in `gbrain upgrade`.
- Parity test (`test/parity.test.ts`) verifies structural contract between operations, CLI, and MCP.
- New `setup` skill replacing `install`: auto-provision Supabase via CLI, AGENTS.md injection, target TTHW < 2 min.
- E2E test suite against real Postgres+pgvector. 13 realistic fixtures (miniature brain with people, companies, deals, meetings, concepts), 14 test suites covering all operations, search quality benchmarks, idempotency stress tests, schema validation, and full setup journey verification.
- GitHub Actions E2E workflow: Tier 1 (mechanical) on every PR, Tier 2 (LLM skills via OpenClaw) nightly.
- `docker-compose.test.yml` and `.env.testing.example` for local E2E development.

### Fixed

- Schema loader in `db.ts` broke on PL/pgSQL trigger functions containing semicolons inside `$$` blocks. Replaced per-statement execution with single `conn.unsafe()` call.
- `traverseGraph` query failed with "could not identify equality operator for type json" when using `SELECT DISTINCT` with `json_agg`. Changed to `jsonb_agg`.

### Changed

- `src/mcp/server.ts` rewritten from ~233 to ~80 lines. Tool definitions and dispatch generated from operations[].
- `src/cli.ts` rewritten. Shared operations auto-registered from operations[]. CLI-only commands (init, upgrade, import, export, files, embed) kept as manual registrations.
- `tools-json` output now generated FROM operations[]. Third contract surface eliminated.
- All 7 skills rewritten with tool-agnostic language. Works with both CLI and MCP plugin contexts.
- File schema: `storage_url` column dropped, `storage_path` is the only identifier. URLs generated on demand via `file_url` operation.
- Config loading: env vars (`GBRAIN_DATABASE_URL`, `DATABASE_URL`, `OPENAI_API_KEY`) override config file values. Plugin config injected via env vars.

### Removed

- 12 command files migrated to operations.ts: get.ts, put.ts, delete.ts, list.ts, search.ts, query.ts, health.ts, stats.ts, tags.ts, link.ts, timeline.ts, version.ts.
- `storage_url` column from files table.

## [0.2.0.2] - 2026-04-07

### Changed

- Rewrote recommended brain schema doc with expanded architecture: database layer (entity registry, event ledger, fact store, relationship graph) presented as the core architecture, entity identity and deduplication, enrichment source ordering, epistemic discipline rules, worked examples showing full ingestion chains, concurrency guidance, and browser budget. Smoothed language for open-source readability.

## [0.2.0.1] - 2026-04-07

### Added

- Recommended brain schema doc (`docs/GBRAIN_RECOMMENDED_SCHEMA.md`): full MECE directory structure, compiled truth + timeline pages, enrichment pipeline, resolver decision tree, skill architecture, and cron job recommendations. The OpenClaw paste now links to this as step 5.

### Changed

- First-time experience rewritten. "Try it" section shows your own data, not fictional PG essays. OpenClaw paste references the GitHub repo, includes bun install fallback, and has the agent pick a dynamic query based on what it imported.
- Removed all references to `data/kindling/` (a demo corpus directory that never existed).

## [0.2.0] - 2026-04-05

### Added

- You can now keep your brain current with `gbrain sync`, which uses git's own diff machinery to process only what changed. No more 30-second full directory walks when 3 files changed.
- Watch mode (`gbrain sync --watch`) polls for changes and syncs automatically. Set it and forget it.
- Binary file management with `gbrain files` commands (list, upload, sync, verify). Store images, PDFs, and audio in Supabase Storage instead of clogging your git repo.
- Install skill (`skills/install/SKILL.md`) that walks you through setup from scratch, including Supabase CLI magic path for zero-copy-paste onboarding.
- Import and sync now share a checkpoint. Run `gbrain import`, then `gbrain sync`, and it picks up right where import left off. Zero gap.
- Tag reconciliation on reimport. If you remove a tag from your markdown, it actually gets removed from the database now.
- `gbrain config show` redacts database passwords so you can safely share your config.
- `updateSlug` engine method preserves page identity (page_id, chunks, embeddings) across renames. Zero re-embedding cost.
- `sync_brain` MCP tool returns structured results so agents know exactly what changed.
- 20 new sync tests (39 total across 3 test files)

## [0.1.0] - 2026-04-05

### Added

- Pluggable engine interface (`BrainEngine`) with full Postgres + pgvector implementation
- 25+ CLI commands: init, get, put, delete, list, search, query, import, export, embed, stats, health, link/unlink/backlinks/graph, tag/untag/tags, timeline/timeline-add, history/revert, config, upgrade, serve, call
- MCP stdio server with 20 tools mirroring all CLI operations
- 3-tier chunking: recursive (delimiter-aware), semantic (Savitzky-Golay boundary detection), LLM-guided (Claude Haiku topic shifts)
- Hybrid search with Reciprocal Rank Fusion merging vector + keyword results
- Multi-query expansion via Claude Haiku (2 alternative phrasings per query)
- 4-layer dedup pipeline: by source, cosine similarity, type diversity, per-page cap
- OpenAI embedding service (text-embedding-3-large, 1536 dims) with batch support and exponential backoff
- Postgres schema with pgvector HNSW, tsvector (trigger-based, spans timeline_entries), pg_trgm fuzzy slug matching
- Smart slug resolution for reads (fuzzy match via pg_trgm)
- Page version control with snapshot, history, and revert
- Typed links with recursive CTE graph traversal (max depth configurable)
- Brain health dashboard (embed coverage, stale pages, orphans, dead links)
- Stale alert annotations in search results
- Supabase init wizard with CLI auto-provision fallback
- Slug validation to prevent path traversal on export
- 6 fat markdown skills: ingest, query, maintain, enrich, briefing, migrate
- ClawHub manifest for skill distribution
- Full design docs: GBRAIN_V0 spec, pluggable engine architecture, SQLite engine plan
