# MBrain Phase 2 Context Atlas Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the first persisted Context Atlas registry layer over structural context maps and expose atlas inspection through shared operations.

**Architecture:** Keep atlas behavior additive and derived. Reuse the staleness-aware context-map service as the only source of truth for freshness, then persist one deterministic atlas entry per workspace map with a compact entrypoint list and budget hint.

**Tech Stack:** Bun, TypeScript, existing `BrainEngine` boundary, SQLite/Postgres/PGLite engines, shared `operations.ts`, Bun test, repo-local benchmark scripts.

---

## Scope and sequencing decisions

- This plan adds atlas registry storage but not atlas routing.
- This plan indexes existing context maps; it does not build new map kinds.
- This plan keeps atlas entrypoints structural-only and deterministic.
- This plan does not add summary cards, reports, or semantic ranking.

## File Map

### Core files to create

- `src/core/services/context-atlas-service.ts` — deterministic atlas registry builder over persisted context maps
- `test/context-atlas-schema.test.ts` — atlas registry schema coverage
- `test/context-atlas-service.test.ts` — registry build, freshness, and deterministic entrypoint coverage
- `test/context-atlas-engine.test.ts` — atlas persistence coverage across reopen
- `test/context-atlas-operations.test.ts` — operation registration and stale-freshness surface coverage
- `scripts/bench/phase2-context-atlas.ts` — atlas build/get/list benchmark runner
- `test/phase2-context-atlas.test.ts` — benchmark JSON shape and acceptance coverage

### Existing files expected to change

- `src/core/types.ts`
- `src/core/engine.ts`
- `src/schema.sql`
- `src/core/schema-embedded.ts`
- `src/core/pglite-schema.ts`
- `src/core/migrate.ts`
- `src/core/sqlite-engine.ts`
- `src/core/pglite-engine.ts`
- `src/core/postgres-engine.ts`
- `src/core/operations.ts`
- `test/cli.test.ts`
- `package.json`
- `docs/MBRAIN_VERIFY.md`

## Task 1: Add atlas registry schema and engine support

- Write a failing schema test for `context_atlas_entries`.
- Add atlas types and engine CRUD.
- Add additive schema and migration.
- Implement engine CRUD in sqlite, pglite, and postgres.

## Task 2: Build and inspect deterministic atlas entries

- Write a failing service test for atlas build/freshness behavior.
- Implement the atlas builder over the stale-aware context-map service.
- Write failing operation tests for `atlas-build`, `atlas-get`, and `atlas-list`.
- Add shared operations and CLI help coverage.

## Task 3: Add the Phase 2 atlas benchmark

- Write a failing benchmark test for `phase2-context-atlas`.
- Implement the local benchmark runner.
- Update `package.json` and `docs/MBRAIN_VERIFY.md`.

## Verification

Run:

```bash
bun test test/context-atlas-schema.test.ts test/context-atlas-engine.test.ts test/context-atlas-service.test.ts test/context-atlas-operations.test.ts test/phase2-context-atlas.test.ts
bun test test/cli.test.ts -t "atlas-build --help|atlas-get --help|atlas-list --help"
bun run bench:phase2-context-atlas --json
bun run test:phase1
```
