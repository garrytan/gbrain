# Phase 5 Memory Inbox Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the first bounded governance-state foundation for `mbrain` by adding canonical `Memory Candidate` storage and deterministic early-state transitions.

**Architecture:** Add `memory_candidate_entries` as canonical governance state, mirror the existing engine/schema pattern used by profile memory and personal episodes, and expose only create/read/list/advance-to-review behavior. Do not mix in promotion, contradiction handling, or derived candidate generation yet.

**Tech Stack:** TypeScript, Bun, shared operations contract, SQLite/PGLite/Postgres engine implementations, Phase 5 benchmark and acceptance wiring.

---

## Review-Driven Constraints

- [ ] Publish Phase 5 from a separate branch/PR only. Freeze PR `#32` at Phase 2-4 scope except for merge-blocking fixes already on that branch.
- [ ] Keep this PR bounded to `memory inbox foundations` only: migration `15`, inbox schema/engine/service/operations, and Phase 5 benchmark/acceptance wiring.
- [ ] Do not grow `src/core/operations.ts` with another large inline block. Extract memory inbox operation definitions into a domain file and re-export from `operations.ts`.
- [ ] Keep benchmark-launch tests explicitly contract-focused. They should verify bench entrypoints and acceptance JSON, not duplicate service behavior tests.
- [ ] Carry one open blocker on PR `#32`: fix the missing `replaceNoteSectionEntries` mock in `test/import-service.test.ts` before that PR is merged.
- [ ] Keep the publicly reachable Phase 5 status surface bounded to `captured`, `candidate`, and `staged_for_review`. Do not expose `promoted`, `rejected`, or `superseded` before a later governance PR actually implements those transitions.
- [ ] Push enum invariants down into migration `15` with DB-level `CHECK` constraints for every enum-like TEXT column in `memory_candidate_entries`.
- [ ] Remove `as any` enum casts from `operations-memory-inbox.ts` by validating/coercing runtime strings against explicit allowed-value lists.
- [ ] Give memory inbox its own default scope constant instead of borrowing the note-manifest default constant, even if both currently resolve to `workspace:default`.
- [ ] Preserve explicit `reviewed_at: null` in the status-advance service. Only auto-stamp review time when the caller leaves `reviewed_at` undefined.
- [ ] Let operation callers pass multiple provenance strings through `source_refs`, while keeping single `source_ref` input as a backward-compatible convenience.
- [ ] Bound list reads with an explicit max cap and document that `next_status` metadata is intentionally narrower than the full transition rule, which still depends on the current stored status.

---

## File Map

- Modify: `src/core/types.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/operations.ts`
- Create: `src/core/operations-memory-inbox.ts`
- Create: `src/core/services/memory-inbox-service.ts`
- Create: `test/memory-inbox-schema.test.ts`
- Create: `test/memory-inbox-engine.test.ts`
- Create: `test/memory-inbox-service.test.ts`
- Create: `test/memory-inbox-operations.test.ts`
- Create: `scripts/bench/phase5-memory-inbox-foundations.ts`
- Create: `test/phase5-memory-inbox-foundations.test.ts`
- Create: `scripts/bench/phase5-acceptance-pack.ts`
- Create: `test/phase5-acceptance-pack.test.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Create: `docs/superpowers/specs/2026-04-22-mbrain-phase-5-memory-inbox-foundations-design.md`

## Task 1: Schema And Engine Contract

- [ ] Add failing schema and engine persistence tests for `memory_candidate_entries`.
- [ ] Add types and engine contract methods for create/get/list/delete candidate entries.
- [ ] Implement the schema and persistence path across SQLite, PGLite, and Postgres.
- [ ] Verify schema and engine tests go green.

## Task 2: Deterministic Status-Advance Service

- [ ] Add failing service tests for `captured -> candidate -> staged_for_review`.
- [ ] Implement `memory-inbox-service.ts` with bounded transition validation.
- [ ] Reject invalid backward or skipped transitions.
- [ ] Verify service tests go green.

## Task 3: Shared Operations

- [ ] Add failing operation tests for create/get/list/advance behavior.
- [ ] Extract memory inbox operation definitions into `src/core/operations-memory-inbox.ts` and re-export them from `src/core/operations.ts`.
- [ ] Expose `create-memory-candidate`, `get-memory-candidate`,
      `list-memory-candidates`, and `advance-memory-candidate-status`.
- [ ] Keep CLI/MCP behavior thin over the service and engine layer.
- [ ] Verify operation tests go green.

## Task 4: Benchmark And Phase 5 Acceptance Wiring

- [ ] Add failing benchmark tests for `phase5-memory-inbox-foundations` and
      `phase5-acceptance-pack`.
- [ ] Implement the benchmark script with correctness and latency workloads.
- [ ] Keep benchmark tests scoped to entrypoint/JSON contract checks and leave detailed behavior coverage to service/engine/operations tests.
- [ ] Add `bench:phase5-memory-inbox-foundations`, `bench:phase5-acceptance`,
      and `test:phase5`.
- [ ] Update `docs/MBRAIN_VERIFY.md`.
- [ ] Verify the benchmark, acceptance pack, and full `test:phase5` run go green.
