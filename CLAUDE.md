# CLAUDE.md

GBrain is a personal knowledge brain. Postgres + pgvector + hybrid search in a managed Supabase instance.

## Architecture

Thin CLI + fat skills. The CLI (`src/cli.ts`) dispatches commands to handler files in
`src/commands/`. The core library (`src/core/`) handles database, search, embeddings,
and markdown parsing. Skills (`skills/`) are fat markdown files that tell you HOW to
use the tools — ingest meetings, answer queries, maintain the brain, enrich from APIs.

## Key files

- `src/core/engine.ts` — Pluggable engine interface (BrainEngine)
- `src/core/postgres-engine.ts` — Postgres + pgvector implementation
- `src/core/sqlite-engine.ts` — SQLite + FTS5 + vec0 implementation
- `src/sqlite-schema.sql` — SQLite DDL (FTS5 triggers, vec0 virtual table)
- `src/core/db.ts` — Connection management, schema initialization
- `src/core/import-file.ts` — Shared single-file import (used by import + sync)
- `src/core/sync.ts` — Pure sync functions (manifest parsing, filtering, slug conversion)
- `src/core/chunkers/` — 3-tier chunking (recursive, semantic, LLM-guided)
- `src/core/search/` — Hybrid search: vector + keyword + RRF + multi-query expansion + dedup
- `src/core/embedding.ts` — OpenAI text-embedding-3-large, batch, retry, backoff
- `src/mcp/server.ts` — MCP stdio server exposing all tools
- `src/schema.sql` — Full Postgres + pgvector DDL (includes files table)

## Commands

Run `gbrain --help` or `gbrain --tools-json` for full command reference.

## Testing

`bun test` runs all tests (39 tests across 3 files). Tests: `test/markdown.test.ts`
(frontmatter parsing, round-trip serialization), `test/chunkers/recursive.test.ts`
(delimiter splitting, overlap, chunk sizing), `test/sync.test.ts` (manifest parsing,
isSyncable filtering, pathToSlug conversion).

## Skills

Read the skill files in `skills/` before doing brain operations. They contain the
workflows, heuristics, and quality rules for ingestion, querying, maintenance,
enrichment, and installation. 7 skills: ingest, query, maintain, enrich, briefing,
migrate, install.

## Build

`bun build --compile --outfile bin/gbrain src/cli.ts`

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
