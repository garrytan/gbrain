# Phase 5 Memory Inbox Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the first bounded governance-state foundation for `mbrain` by adding canonical `Memory Candidate` storage and deterministic early-state transitions.

**Architecture:** Add `memory_candidate_entries` as canonical governance state, mirror the existing engine/schema pattern used by profile memory and personal episodes, and expose only create/read/list/advance-to-review behavior. Do not mix in promotion, contradiction handling, or derived candidate generation yet.

**Tech Stack:** TypeScript, Bun, shared operations contract, SQLite/PGLite/Postgres engine implementations, Phase 5 benchmark and acceptance wiring.

---

## File Map

- Modify: `src/core/types.ts`
- Modify: `src/core/engine.ts`
- Modify: `src/core/sqlite-engine.ts`
- Modify: `src/core/pglite-engine.ts`
- Modify: `src/core/postgres-engine.ts`
- Modify: `src/core/operations.ts`
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
- [ ] Expose `create-memory-candidate`, `get-memory-candidate`,
      `list-memory-candidates`, and `advance-memory-candidate-status`.
- [ ] Keep CLI/MCP behavior thin over the service and engine layer.
- [ ] Verify operation tests go green.

## Task 4: Benchmark And Phase 5 Acceptance Wiring

- [ ] Add failing benchmark tests for `phase5-memory-inbox-foundations` and
      `phase5-acceptance-pack`.
- [ ] Implement the benchmark script with correctness and latency workloads.
- [ ] Add `bench:phase5-memory-inbox-foundations`, `bench:phase5-acceptance`,
      and `test:phase5`.
- [ ] Update `docs/MBRAIN_VERIFY.md`.
- [ ] Verify the benchmark, acceptance pack, and full `test:phase5` run go green.
