# MBrain Phase 2 Context Atlas Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact deterministic atlas report artifact over the existing atlas overview layer.

**Architecture:** Keep report generation read-only and derived. Reuse the atlas overview service as the only source of truth, add bounded summary lines plus the existing recommended reads, and expose one shared `atlas-report` operation plus a local benchmark. No schema work and no persisted report artifacts.

**Tech Stack:** Bun, TypeScript, shared operation framework, sqlite/pglite/postgres engine layer for existing atlas reads

---

## Task 1: Add atlas report service behavior

**Files:**
- Create: `src/core/services/context-atlas-report-service.ts`
- Modify: `src/core/types.ts`
- Test: `test/context-atlas-report-service.test.ts`

- [ ] Add failing service tests for fresh and stale report output.
- [ ] Add minimal report result types and implement deterministic summary rendering over atlas overview.
- [ ] Re-run the targeted service test until it passes.

## Task 2: Expose atlas-report through shared operations

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Test: `test/context-atlas-report-operations.test.ts`

- [ ] Add failing operation tests for `atlas-report`.
- [ ] Implement the shared operation and CLI help surface.
- [ ] Re-run the targeted operation and CLI tests until they pass.

## Task 3: Add the Phase 2 atlas-report benchmark

**Files:**
- Create: `scripts/bench/phase2-context-atlas-report.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Test: `test/phase2-context-atlas-report.test.ts`

- [ ] Add a failing benchmark-shape test for the new script.
- [ ] Implement the sqlite benchmark for report latency and correctness.
- [ ] Re-run the benchmark test until it passes.

## Verification

Run:

```bash
bun test test/context-atlas-report-service.test.ts test/context-atlas-report-operations.test.ts test/phase2-context-atlas-report.test.ts
bun test test/cli.test.ts -t "atlas-report --help"
bun run bench:phase2-context-atlas-report --json
```

Expected:

- report tests pass
- `atlas-report --help` works without a DB connection
- benchmark reports `readiness_status: "pass"` and `phase2_status: "pass"`
