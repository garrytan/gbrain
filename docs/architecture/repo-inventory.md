# Repo Inventory — GBrain Memory + Voice Extensions

Branch: `feature/gbrain-memory-voice-stack`
Fork: JakeB-5/gbrain (Ollama-local fork of garrytan/gbrain)
Version: 0.9.2
Updated: 2026-06-17

## Repo Overview

| Property | Value |
|----------|-------|
| Language | TypeScript (Bun runtime) |
| Package manager | Bun (bun.lock) |
| Module system | ESM (`"type": "module"`) |
| Entrypoint | `src/cli.ts` |
| Library entry | `src/core/index.ts` |
| Config | `~/.gbrain/config.json` + env vars |
| Plugins | OpenClaw bundle-plugin (`openclaw.plugin.json`) |

## Build & Test Commands

| Command | Action |
|---------|--------|
| `bun run src/cli.ts` | Run CLI (dev) |
| `bun run build` | Build binary → `bin/gbrain` |
| `bun run build:all` | Cross-compile (darwin-arm64 + linux-x64) |
| `bun run build:schema` | Regenerate `src/core/schema-embedded.ts` from `src/schema.sql` |
| `bun test` | Unit tests (37 files, no DB needed) |
| `bun run test:e2e` | E2E tests (requires real Postgres+pgvector) |
| `bun test test/e2e/skills.test.ts` | Tier 2 (requires API keys + openclaw CLI) |

## Directory Structure

```
src/
  cli.ts                         CLI entry point (bun shebang)
  version.ts                     Reads version from package.json
  schema.sql                     Canonical Postgres+pgvector DDL
  core/
    index.ts                     Library exports
    operations.ts                ~30 contract-first operation definitions
    engine.ts                    BrainEngine interface
    engine-factory.ts            Dynamic import: 'pglite' | 'postgres'
    pglite-engine.ts             PGLite (embedded WASM Postgres) implementation
    pglite-schema.ts             PGLite-specific DDL
    postgres-engine.ts           Postgres+pgvector implementation
    db.ts                        Connection management + schema init
    config.ts                    Config loading with env var precedence
    types.ts                     TypeScript domain types
    markdown.ts                  Frontmatter parsing (gray-matter)
    embedding.ts                 Embedding service (OpenAI-compatible, Ollama default)
    import-file.ts               Import pipeline (chunk + embed + tags)
    sync.ts                      Git sync (manifest parsing, slug conversion)
    storage.ts                   Pluggable storage interface
    storage/                     Storage backends (S3, Supabase, local)
    supabase-admin.ts            Supabase admin API
    file-resolver.ts             MIME detection + content hashing
    migrate.ts                   Migration helpers
    yaml-lite.ts                 Lightweight YAML parser
    schema-embedded.ts           AUTO-GENERATED from schema.sql
    chunkers/                    3-tier chunking (recursive, semantic, LLM)
    search/                      Hybrid search (vector, keyword, RRF, expansion)
  commands/                      20 CLI-only commands (bypass operation layer)
    init.ts, upgrade.ts, check-update.ts, integrations.ts, publish.ts,
    check-backlinks.ts, lint.ts, report.ts, import.ts, export.ts,
    files.ts, embed.ts, serve.ts, call.ts, config.ts, doctor.ts,
    migrate-engine.ts, sync.ts, auth.ts, tools-json.ts
  mcp/
    server.ts                    MCP stdio server (generated from operations)
test/
  33 test files (unit, no DB needed)
  e2e/
    helpers.ts                   DB lifecycle + fixture import
    mechanical.test.ts           All operations against real DB
    mcp.test.ts                  MCP tool generation verification
    sync.test.ts                 Git-to-DB sync pipeline
    upgrade.test.ts              Check-update against GitHub API
    skills.test.ts               Tier 2 (requires openclaw + API keys)
    fixtures/                    16 markdown files
docs/
  architecture/infra-layer.md
  ethos/                         Architecture philosophy essays
  guides/                        Skillpack guides
  integrations/                  Integration docs
  mcp/                           MCP setup guides
  designs/                       Design documents
recipes/                         7 integration recipes (YAML+markdown)
skills/                          Fat markdown skills for agents
  ingest/, query/, maintain/, enrich/, briefing/, migrate/, setup/, publish/
  _brain-filing-rules.md
  migrations/                    Version migration files
```

## Engine Architecture

Two engines via dynamic import (engine-factory.ts):
- **PGLite** — Embedded Postgres via WASM, zero-config default. All 37 BrainEngine methods.
- **Postgres+pgvector** — For Supabase/self-hosted. Full hybrid search (keyword + vector + RRF).

Dynamic imports ensure PGLite WASM (~3MB) never loads for Postgres users.

## Existing Capabilities vs. Plan Requirements

| Plan Req | Status | Location |
|----------|--------|----------|
| REQ-F-001: Markdown pages with frontmatter | ✅ EXISTS | `src/core/markdown.ts`, `import-file.ts` |
| REQ-F-002: Hybrid search (keyword+vector+RRF) | ✅ EXISTS | `src/core/search/hybrid.ts` |
| REQ-F-003: Memory graph entities/relationships | ✅ EXISTS (backlinks + tags + graph traversal) | `operations.ts` addLink/getLinks/traverseGraph |
| REQ-F-004: Freshness metadata | ❌ MISSING | Needs new implementation |
| REQ-F-005: API layer | ✅ EXISTS (MCP) | `src/mcp/server.ts` |
| REQ-F-006: MCP tools | ✅ EXISTS | 30 operations, all exposed as MCP tools |
| REQ-F-007: Voice sessions | ❌ MISSING | Needs new implementation |
| REQ-F-008: TTS (Supertonic adapter) | ❌ MISSING | Needs new adapter |
| REQ-F-009: STT adapter (Deepgram-compatible) | ❌ MISSING | Needs new adapter |
| REQ-F-010: Scheduler jobs | ✅ EXISTS (manual via CLI) | `sync.ts`, `embed.ts`, `backlinks.ts` etc. — but no registry |
| REQ-O-001: Health checks | ✅ EXISTS | `doctor.ts`, `get_health` operation |
| REQ-S-001: No secrets in code | ✅ EXISTS | `.gitleaks.toml`, `.env.*` in gitignore |
| REQ-S-002: Provenance + consent | ❌ MISSING | Needs schema extension |

## Key Config & Env

| Var | Default | Purpose |
|-----|---------|---------|
| `GBRAIN_EMBEDDING_MODEL` | `bge-m3` | Embedding model (Ollama) |
| `GBRAIN_EMBEDDING_DIMENSIONS` | `1024` | Vector dimensions |
| `GBRAIN_EMBEDDING_BASE_URL` | `http://localhost:11434/v1` | Ollama endpoint |
| `GBRAIN_EMBEDDING_API_KEY` | `ollama` | API key |
| `GBRAIN_EMBED_CONCURRENCY` | `20` | Parallel embedding workers |
| `ANTHROPIC_API_KEY` | — | Query expansion |
| `OPENAI_API_KEY` | — | Fallback embedding |
| `DATABASE_URL` | — | Postgres connection (for `postgres` engine) |

## Baseline Test Status

Run: `bun test` on branch `feature/gbrain-memory-voice-stack`

```
442 pass
122 skip
  1 fail
```

**1 pre-existing failure:** `PGLiteEngine: Chunks > getChunksWithEmbeddings returns embedding data`
- Root cause: Bun v1.3.3 segfault in PGLite WASM when querying chunks with embeddings
- Known P0 issue in TODOS.md: `bun build --compile` WASM embedding for PGLite (oven-sh/bun#15032)
- **Unrelated to this feature work.** Does not affect Postgres engine or any other test.

**122 skipped:** All E2E tests — require `DATABASE_URL` (real Postgres+pgvector). Not needed for unit test baseline.

## MISSING Items Resolved

| Plan Marker | Resolution |
|-------------|------------|
| `MISSING_REPO_STRUCTURE` | Documented above |
| `MISSING_TEST_COMMANDS` | `bun test` (unit), `bun run test:e2e` (E2E), `bun run build` (compile) |
| `MISSING_DB_DECISION` | Both: PGLite (default, embedded) + Postgres+pgvector (optional) |
| `MISSING_MCP_RUNTIME` | TypeScript, Bun runtime, stdio MCP via `@modelcontextprotocol/sdk` |
| `MISSING_DEPLOY_TARGET` | CLI binary + OpenClaw plugin. Local-first. |

## Sprint 1-7 Delta (what actually needs building)

| Sprint | What plan says | Actual delta |
|--------|---------------|--------------|
| Sprint 1: Core Schema | Define schemas for Page, Memory, VoiceSession | Page schema EXISTS; Memory/VoiceSession schemas MISSING. Markdown parser EXISTS but may need extension. |
| Sprint 2: Memory Graph | Define interface, adapter, search integration | Graph traversal EXISTS (operations.ts), but no dedicated GraphRepository interface. Adapter layer MISSING. |
| Sprint 3: Freshness | Metadata, digest, reconcile checks | FULLY MISSING — new feature |
| Sprint 4: API + MCP | Service boundary, API endpoints, MCP tools | MCP EXISTS (30 tools). Service layer partly EXISTS in CLI commands. Deduplication needed. |
| Sprint 5: Scheduler | Job registry, automation hooks | CLI commands exist individually. Job REGISTRY MISSING. |
| Sprint 6: Voice MVP | STT adapter, TTS adapter, voice session service | FULLY MISSING — new feature |
| Sprint 7: QA + Docs | Security, health, docs | Health EXISTS partially. Security EXISTS (gitleaks). Docs need update. |
