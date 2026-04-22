# MBrain Phase 2 Context Map Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact deterministic report artifact directly over persisted context maps.

**Architecture:** Keep report generation read-only and derived. Reuse stale-aware context-map reads as the source of truth, add bounded summary lines plus recommended reads from existing graph nodes, and expose one shared `map-report` operation plus a local benchmark. No schema work and no persisted report artifacts.

**Tech Stack:** Bun, TypeScript, shared operation framework, sqlite/pglite/postgres engine layer for existing map reads

---

## Task 1: Add context-map report service behavior

**Files:**
- Create: `src/core/services/context-map-report-service.ts`
- Modify: `src/core/types.ts`
- Test: `test/context-map-report-service.test.ts`

- [ ] Add failing service tests for fresh and stale report output.
- [ ] Add minimal report result types and implement deterministic report rendering over context-map reads.
- [ ] Re-run the targeted service test until it passes.

## Task 2: Expose map-report through shared operations

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Test: `test/context-map-report-operations.test.ts`

- [ ] Add failing operation tests for `map-report`.
- [ ] Implement the shared operation and CLI help surface.
- [ ] Re-run the targeted operation and CLI tests until they pass.

## Task 3: Add the Phase 2 context-map-report benchmark

**Files:**
- Create: `scripts/bench/phase2-context-map-report.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Test: `test/phase2-context-map-report.test.ts`

- [ ] Add a failing benchmark-shape test for the new script.
- [ ] Implement the sqlite benchmark for report latency and correctness.
- [ ] Re-run the benchmark test until it passes.

## Verification

Run:

```bash
bun test test/context-map-report-service.test.ts test/context-map-report-operations.test.ts test/phase2-context-map-report.test.ts
bun test test/cli.test.ts -t "map-report --help"
bun run bench:phase2-context-map-report --json
```

Expected:

- report tests pass
- `map-report --help` works without a DB connection
- benchmark reports `readiness_status: "pass"` and `phase2_status: "pass"`
