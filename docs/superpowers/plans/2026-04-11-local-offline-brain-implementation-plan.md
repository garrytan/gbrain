# Local / Offline GBrain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a fully local/offline GBrain that uses SQLite, local model runtimes, and local MCP integration for Codex and Claude Code with no paid cloud dependencies.

**Architecture:** Replace direct Postgres assumptions with a backend factory, implement a real SQLite `BrainEngine`, move embeddings behind a local provider abstraction, preserve hybrid search via local vector retrieval plus FTS5, and expose the same conceptual CLI/MCP surface through `gbrain serve`.

**Tech Stack:** Bun, TypeScript, bun:sqlite, SQLite FTS5, local model runtime (Ollama-compatible endpoint), MCP stdio, existing operation contract.

---

## File Map

### Core files to create

- `src/core/sqlite-engine.ts` — SQLite implementation of `BrainEngine`
- `src/core/engine-factory.ts` — backend selection factory used by CLI/MCP/commands
- `src/core/embedding/provider.ts` — provider interface + local/none implementations
- `src/core/search/vector-local.ts` — local vector search provider(s)
- `src/core/offline-profile.ts` — offline profile defaults and provider resolution
- `test/engine-factory.test.ts` — backend selection and backward-compat tests
- `test/sqlite-engine.test.ts` — SQLite engine parity-focused tests
- `test/local-offline.test.ts` — offline mode integration/unit tests
- `docs/local-offline.md` — user guide for local mode

### Existing files expected to change

- `src/cli.ts`
- `src/commands/init.ts`
- `src/commands/doctor.ts`
- `src/commands/embed.ts`
- `src/commands/import.ts`
- `src/commands/sync.ts`
- `src/mcp/server.ts`
- `src/core/config.ts`
- `src/core/embedding.ts`
- `src/core/search/hybrid.ts`
- `src/core/index.ts`
- `README.md`
- `CLAUDE.md`

---

### Task 1: Replace direct Postgres bootstrap assumptions

**Files:**
- Create: `src/core/engine-factory.ts`
- Modify: `src/cli.ts`
- Modify: `src/mcp/server.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/commands/import.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/core/config.ts`
- Modify: `src/core/index.ts`
- Test: `test/engine-factory.test.ts`
- Test: `test/cli.test.ts`
- Test: `test/config.test.ts`

- [ ] **Step 1: Write failing config/engine selection tests**

Document tests for:
- loading `engine: "sqlite"` from config
- creating the correct engine from config
- preserving backward compatibility for legacy configs with no `engine`
- defaulting env-only configs to Postgres unless local mode is explicitly configured
- rejecting invalid engine/provider combinations before bootstrap proceeds

- [ ] **Step 2: Implement `engine-factory.ts`**

Responsibilities:
- add a config resolver/validator so engine selection and config compatibility live in one place
- create backend instances from config
- stop importing `PostgresEngine` directly from entrypoints
- centralize default engine selection logic
- provide one place to decide whether worker fan-out is supported for the selected engine

- [ ] **Step 3: Refactor CLI, MCP, doctor, and import worker bootstrap to use the factory**

Refactor:
- `src/cli.ts`
- `src/mcp/server.ts`
- `src/commands/doctor.ts`
- `src/commands/import.ts`
- `src/core/index.ts`

Requirement:
- command dispatch remains unchanged
- backend selection becomes config-driven
- direct `PostgresEngine` construction is removed from user-facing bootstrap paths
- Postgres-only raw DB paths are explicitly gated or deferred when running in local mode

- [ ] **Step 4: Extend config for local profile**

Add config semantics for:
- `engine`
- `database_path`
- `offline`
- `embedding_provider`
- `query_rewrite_provider`

Compatibility requirements:
- existing Postgres users with old config files continue to work unchanged
- env-only `DATABASE_URL` / `GBRAIN_DATABASE_URL` setups still resolve to Postgres
- `init` messaging stops assuming `--supabase` is the only recovery path
- Task 1 only needs backend-neutral init plumbing; full `--local` defaults/UX land in Task 5

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test test/engine-factory.test.ts test/cli.test.ts test/config.test.ts
```

- [ ] **Step 6: Commit**

Commit scope:
- config + factory + entrypoint bootstrap refactor

---

### Task 2: Implement `SQLiteEngine`

**Files:**
- Create: `src/core/sqlite-engine.ts`
- Modify: `src/core/index.ts`
- Modify: `src/core/engine.ts`
- Test: `test/sqlite-engine.test.ts`
- Test: `test/parity.test.ts`

- [ ] **Step 1: Write failing engine tests**

Cover:
- page CRUD
- tags
- links
- timeline
- versions
- stats/health
- FTS keyword search

- [ ] **Step 2: Implement schema bootstrap**

Create SQLite schema initialization covering:
- `pages`
- `pages_fts`
- `content_chunks`
- `links`
- `tags`
- `raw_data`
- `timeline_entries`
- `page_versions`
- `ingest_log`
- `config`

- [ ] **Step 3: Implement CRUD and metadata methods**

Implement all non-search `BrainEngine` methods with slug-based behavior preserved.

- [ ] **Step 4: Implement FTS keyword search**

Implement:
- FTS5 virtual table
- triggers
- BM25 ranking
- normalized `SearchResult[]`

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test test/sqlite-engine.test.ts test/parity.test.ts
```

- [ ] **Step 6: Commit**

Commit scope:
- SQLite engine + schema + engine export wiring

---

### Task 3: Introduce local embedding providers and non-blocking embedding flow

**Files:**
- Create: `src/core/embedding/provider.ts`
- Modify: `src/core/embedding.ts`
- Modify: `src/core/import-file.ts`
- Modify: `src/commands/embed.ts`
- Modify: `src/commands/sync.ts`
- Test: `test/import-file.test.ts`
- Test: `test/local-offline.test.ts`

- [ ] **Step 1: Write failing tests for local/no-embed flows**

Cover:
- import succeeds with no embeddings
- stale-only embedding updates only missing chunks
- unchanged content does not trigger re-embedding

- [ ] **Step 2: Split embedding provider from embedding orchestration**

Required provider modes:
- `none`
- `local`

Required orchestrator behaviors:
- batch embedding
- runtime capability detection
- model metadata propagation

- [ ] **Step 3: Refactor import to stop embedding inline on the critical write path**

New behavior:
- write page and chunks first
- leave chunks unembedded when embedding is deferred
- preserve immediate success for import/sync

- [ ] **Step 4: Refactor `embed` command to become the primary backfill/recovery path**

Required outcomes:
- page-level embedding
- stale-only embedding
- model-switch-friendly rebuild path

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test test/import-file.test.ts test/local-offline.test.ts
```

- [ ] **Step 6: Commit**

Commit scope:
- local embedding provider abstraction + deferred embedding flow

---

### Task 4: Implement local vector search and hybrid retrieval

**Files:**
- Create: `src/core/search/vector-local.ts`
- Modify: `src/core/search/hybrid.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/sqlite-engine.ts`
- Test: `test/local-offline.test.ts`
- Test: `test/parity.test.ts`

- [ ] **Step 1: Write failing hybrid-search tests**

Cover:
- keyword-only fallback
- hybrid keyword+vector fusion
- partial embedding coverage behavior

- [ ] **Step 2: Implement exact local cosine search baseline**

Behavior:
- read chunk embeddings from SQLite
- compute cosine similarity locally
- rank top K results

- [ ] **Step 3: Plug vector search into SQLite engine**

Requirement:
- `searchVector()` works without Postgres or pgvector

- [ ] **Step 4: Refine hybrid search for offline provider availability**

Behavior:
- if query embedding provider unavailable, run keyword-only
- if partial embeddings exist, fuse available vector results

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test test/local-offline.test.ts test/parity.test.ts
```

- [ ] **Step 6: Commit**

Commit scope:
- local vector search + offline-safe hybrid retrieval

---

### Task 5: Add local query rewrite policy and offline profile semantics

**Files:**
- Create: `src/core/offline-profile.ts`
- Modify: `src/core/search/expansion.ts`
- Modify: `src/commands/doctor.ts`
- Modify: `src/commands/init.ts`
- Modify: `src/core/config.ts`
- Test: `test/doctor.test.ts`
- Test: `test/local-offline.test.ts`

- [ ] **Step 1: Write failing tests for offline profile reporting**

Cover:
- doctor shows local providers
- offline profile avoids cloud assumptions
- query rewrite can be disabled cleanly

- [ ] **Step 2: Replace Anthropic-only expansion with provider modes**

Modes:
- `none`
- `heuristic`
- `local_llm`

- [ ] **Step 3: Teach init/config about local mode defaults**

Required local defaults:
- sqlite engine
- offline true
- local embedding provider
- heuristic or disabled query rewrite

- [ ] **Step 4: Update doctor output**

Doctor should report:
- engine type
- embedding provider type
- rewrite provider type
- offline profile status

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test test/doctor.test.ts test/local-offline.test.ts
```

- [ ] **Step 6: Commit**

Commit scope:
- offline profile semantics + local rewrite policy

---

### Task 6: Finalize MCP integration, docs, and verification

**Files:**
- Create: `docs/local-offline.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`
- Modify: `docs/rfcs/2026-04-11-local-offline-brain-rfc.md`
- Test: `test/cli.test.ts`
- Test: `test/parity.test.ts`
- Test: `test/local-offline.test.ts`

- [ ] **Step 1: Document local MCP setup for Codex**

Include:

```bash
codex mcp add gbrain -- gbrain serve
```

- [ ] **Step 2: Document local MCP setup for Claude Code**

Include the local stdio MCP JSON configuration shape and offline workflow guidance.

- [ ] **Step 3: Update README and CLAUDE**

Reflect:
- local/offline positioning
- SQLite engine availability
- no-cloud workflow
- local embedding caveats

- [ ] **Step 4: Run the verification suite**

Run:

```bash
bun test
```

If SQLite/local integration tests require dedicated commands, document and run them here too.

- [ ] **Step 5: Commit**

Commit scope:
- docs + verification + user-facing offline guidance

---

## Self-Review Checklist

- [ ] RFC requirements all map to at least one task
- [ ] No task depends on direct `PostgresEngine` imports surviving in entrypoints
- [ ] Local embedding slowness is addressed through deferred + stale-only embedding
- [ ] Codex and Claude Code integration is documented through local MCP, not remote deployment
- [ ] No task assumes paid cloud APIs

---

## Issue Mapping

This plan is intended to map one-to-one onto a GitHub umbrella issue plus workstream issues for:

1. Engine/bootstrap refactor
2. SQLite engine
3. Local embedding provider + queue
4. Local vector search/hybrid retrieval
5. Offline profile + client integration
6. Docs/tests/verification

---

Plan complete and saved to `docs/superpowers/plans/2026-04-11-local-offline-brain-implementation-plan.md`.
