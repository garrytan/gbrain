# MBrain Phase 2 Context Atlas Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact read-only atlas overview artifact over the existing atlas selection and atlas registry primitives.

**Architecture:** Keep overview generation derived and stateless. Reuse atlas selection and atlas reads as the source of truth, resolve bounded entrypoints through manifests and sections, and expose one shared `atlas-overview` operation plus a local benchmark. No schema changes and no persisted report artifacts.

**Tech Stack:** Bun, TypeScript, shared operation framework, sqlite/pglite/postgres engine layer for existing atlas/manfiest/section reads

---

## Task 1: Add overview service behavior

**Files:**
- Create: `src/core/services/context-atlas-overview-service.ts`
- Modify: `src/core/types.ts`
- Test: `test/context-atlas-overview-service.test.ts`

- [ ] Add failing service tests for selected overview output and stale direct-id reads.
- [ ] Add overview result types and implement the minimal overview resolver.
- [ ] Re-run the targeted service test until it passes.

## Task 2: Expose atlas-overview through shared operations

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `test/cli.test.ts`
- Test: `test/context-atlas-overview-operations.test.ts`

- [ ] Add failing operation tests for `atlas-overview`.
- [ ] Implement the shared operation and CLI help surface.
- [ ] Re-run the targeted operation and CLI tests until they pass.

## Task 3: Add the Phase 2 atlas-overview benchmark

**Files:**
- Create: `scripts/bench/phase2-context-atlas-overview.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Test: `test/phase2-context-atlas-overview.test.ts`

- [ ] Add a failing benchmark-shape test for the new script.
- [ ] Implement the sqlite benchmark for overview latency and correctness.
- [ ] Re-run the benchmark test until it passes.

## Verification

Run:

```bash
bun test test/context-atlas-overview-service.test.ts test/context-atlas-overview-operations.test.ts test/phase2-context-atlas-overview.test.ts
bun test test/cli.test.ts -t "atlas-overview --help"
bun run bench:phase2-context-atlas-overview --json
```

Expected:

- overview tests pass
- `atlas-overview --help` works without a DB connection
- benchmark reports `readiness_status: "pass"` and `phase2_status: "pass"`
