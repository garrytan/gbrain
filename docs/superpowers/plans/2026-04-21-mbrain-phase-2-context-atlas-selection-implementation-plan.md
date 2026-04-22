# MBrain Phase 2 Context Atlas Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one deterministic atlas selection primitive over persisted atlas registry entries and expose it through a shared operation.

**Architecture:** Keep selection additive and stateless. Reuse the stale-aware atlas read path as the only source of truth, then apply a compact deterministic selector over scope, kind, freshness, and optional budget constraints. No schema work, no report artifacts, and no routing policy engine.

**Tech Stack:** Bun, TypeScript, shared operation framework, sqlite/pglite/postgres engine layer for existing atlas reads

---

## Task 1: Add deterministic atlas selection service behavior

**Files:**
- Modify: `src/core/services/context-atlas-service.ts`
- Test: `test/context-atlas-service.test.ts`

- [ ] Add failing service tests for fresh preference, stale gating, and budget filtering.
- [ ] Implement a minimal selector that reads atlas entries through the existing stale-aware service and returns `{ entry, reason, candidate_count }`.
- [ ] Re-run the targeted service test until it passes.

## Task 2: Expose atlas selection through the shared operation layer

**Files:**
- Modify: `src/core/operations.ts`
- Test: `test/context-atlas-operations.test.ts`
- Test: `test/cli.test.ts`

- [ ] Add failing operation tests for `atlas-select`.
- [ ] Implement `select_context_atlas_entry` with CLI name `atlas-select`.
- [ ] Cover `--help` output and deterministic no-match behavior.
- [ ] Re-run the targeted operation and CLI tests until they pass.

## Task 3: Add the Phase 2 atlas-selection benchmark

**Files:**
- Create: `scripts/bench/phase2-context-atlas-select.ts`
- Modify: `package.json`
- Modify: `docs/MBRAIN_VERIFY.md`
- Test: `test/phase2-context-atlas-select.test.ts`

- [ ] Add a failing benchmark-shape test for the new script.
- [ ] Implement a sqlite benchmark that measures select latency and correctness.
- [ ] Add a package script and verification notes.
- [ ] Re-run the benchmark test until it passes.

## Verification

Run:

```bash
bun test test/context-atlas-service.test.ts test/context-atlas-operations.test.ts test/phase2-context-atlas-select.test.ts
bun test test/cli.test.ts -t "atlas-select --help"
bun run bench:phase2-context-atlas-select --json
```

Expected:

- targeted atlas selection tests pass
- CLI help for `atlas-select` passes without a DB connection
- benchmark reports `readiness_status: "pass"` and `phase2_status: "pass"`
